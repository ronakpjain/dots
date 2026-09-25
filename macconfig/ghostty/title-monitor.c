#define __APPLE_API_UNSTABLE 1

#include <sys/ioctl.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <libproc.h>

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pwd.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>
#include <unistd.h>

#define TITLE_FD 3
#define MAX_GROUP_PIDS 65536
#define MAX_CANDIDATES 256
#define MAX_PROCESS_ARGS (256 * 1024)
#define MAX_TITLE 4096
#define POLL_MILLISECONDS 150
#define MAX_ANCESTRY 128

typedef struct {
    pid_t pid;
    struct proc_bsdinfo info;
    unsigned depth;
    bool in_foreground_group;
} Candidate;

static volatile sig_atomic_t should_stop = 0;

static void stop_handler(int signal_number) {
    (void)signal_number;
    should_stop = 1;
}

static void install_signal_handlers(void) {
    struct sigaction action = {0};
    action.sa_handler = stop_handler;
    sigemptyset(&action.sa_mask);
    sigaction(SIGTERM, &action, NULL);
    sigaction(SIGINT, &action, NULL);
    sigaction(SIGHUP, &action, NULL);
    signal(SIGPIPE, SIG_IGN);
    signal(SIGTTOU, SIG_IGN);
    signal(SIGTTIN, SIG_IGN);
}

static const char *user_name(void) {
    struct passwd *user = getpwuid(getuid());
    if (user != NULL && user->pw_name != NULL && user->pw_name[0] != '\0') {
        return user->pw_name;
    }
    const char *environment_user = getenv("USER");
    return (environment_user != NULL && environment_user[0] != '\0')
        ? environment_user
        : "user";
}

static void terminal_dimensions(unsigned *columns, unsigned *rows) {
    struct winsize size = {0};
    *columns = 0;
    *rows = 0;
    if (ioctl(TITLE_FD, TIOCGWINSZ, &size) == 0) {
        *columns = size.ws_col;
        *rows = size.ws_row;
    }
}

/* Turn control characters into spaces so command text cannot inject OSC. */
static void append_clean(char *destination, size_t capacity, size_t *length,
                         const char *source, size_t source_length) {
    for (size_t index = 0; index < source_length && *length + 1 < capacity; ++index) {
        unsigned char character = (unsigned char)source[index];
        if (character < 0x20 || character == 0x7f) {
            character = ' ';
        }
        destination[(*length)++] = (char)character;
    }
    if (capacity > 0) {
        destination[*length] = '\0';
    }
}

static void clean_copy(char *destination, size_t capacity, const char *source) {
    size_t length = 0;
    if (capacity == 0) {
        return;
    }
    destination[0] = '\0';
    if (source != NULL) {
        append_clean(destination, capacity, &length, source, strlen(source));
    }
}

static const char *basename_of(const char *path) {
    if (path == NULL) {
        return "";
    }
    const char *slash = strrchr(path, '/');
    return (slash == NULL) ? path : slash + 1;
}

static void process_name(pid_t pid, const struct proc_bsdinfo *info,
                         char *destination, size_t capacity) {
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    int path_length = proc_pidpath(pid, path, sizeof(path));
    if (path_length > 0) {
        clean_copy(destination, capacity, basename_of(path));
        return;
    }
    if (info->pbi_name[0] != '\0') {
        clean_copy(destination, capacity, basename_of(info->pbi_name));
        return;
    }
    clean_copy(destination, capacity, info->pbi_comm);
}

static bool fetch_process_info(pid_t pid, struct proc_bsdinfo *info) {
    memset(info, 0, sizeof(*info));
    int result = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info));
    return result == (int)sizeof(*info) && info->pbi_pid == (uint32_t)pid;
}

static bool append_argument(char *destination, size_t capacity, size_t *length,
                            const char *argument, size_t argument_length,
                            bool first_argument) {
    if (*length + 1 >= capacity) {
        return false;
    }
    if (!first_argument) {
        destination[(*length)++] = ' ';
    }

    if (first_argument) {
        const char *basename = basename_of(argument);
        size_t basename_length = strlen(basename);
        append_clean(destination, capacity, length, basename, basename_length);
    } else {
        append_clean(destination, capacity, length, argument, argument_length);
    }
    return *length + 1 < capacity;
}

/* KERN_PROCARGS2 gives argv without spawning ps. It may be denied for
   protected/setuid processes; callers then fall back to proc_pidpath/pbi_comm. */
static bool process_arguments(pid_t pid, char *destination, size_t capacity) {
    int mib[] = {CTL_KERN, KERN_PROCARGS2, pid};
    size_t buffer_capacity = 4096;
    unsigned char *buffer = NULL;
    size_t result_length = 0;

    while (buffer_capacity <= MAX_PROCESS_ARGS) {
        unsigned char *new_buffer = realloc(buffer, buffer_capacity);
        if (new_buffer == NULL) {
            free(buffer);
            return false;
        }
        buffer = new_buffer;
        result_length = buffer_capacity;
        if (sysctl(mib, 3, buffer, &result_length, NULL, 0) == 0) {
            break;
        }
        if (errno != ENOMEM || buffer_capacity == MAX_PROCESS_ARGS) {
            free(buffer);
            return false;
        }
        buffer_capacity *= 2;
        if (buffer_capacity > MAX_PROCESS_ARGS) {
            buffer_capacity = MAX_PROCESS_ARGS;
        }
    }

    if (buffer == NULL || result_length < sizeof(int)) {
        free(buffer);
        return false;
    }

    int argc = 0;
    memcpy(&argc, buffer, sizeof(argc));
    if (argc <= 0 || argc > 65536) {
        free(buffer);
        return false;
    }

    unsigned char *cursor = buffer + sizeof(argc);
    unsigned char *end = buffer + result_length;
    /* Skip the executable path, then any kernel padding before argv[0]. */
    while (cursor < end && *cursor != '\0') {
        ++cursor;
    }
    if (cursor < end) {
        ++cursor;
    }
    while (cursor < end && *cursor == '\0') {
        ++cursor;
    }

    destination[0] = '\0';
    size_t length = 0;
    int parsed_arguments = 0;
    for (int index = 0; index < argc && cursor < end; ++index) {
        unsigned char *argument = cursor;
        size_t argument_length = strnlen((const char *)cursor, (size_t)(end - cursor));
        if (argument_length == (size_t)(end - cursor)) {
            break;
        }
        if (!append_argument(destination, capacity, &length,
                             (const char *)argument, argument_length,
                             index == 0)) {
            break;
        }
        ++parsed_arguments;
        cursor += argument_length + 1;
    }

    free(buffer);
    return parsed_arguments == argc && destination[0] != '\0';
}

static bool names_equal(const char *candidate, const char *owner) {
    if (candidate == NULL || owner == NULL || owner[0] == '\0') {
        return false;
    }
    const char *base = basename_of(candidate);
    size_t owner_length = strlen(owner);
    if (strncasecmp(base, owner, owner_length) != 0) {
        return false;
    }
    return base[owner_length] == '\0' || base[owner_length] == ':' ||
           base[owner_length] == ' ';
}

static bool is_configured_owner(const char *name) {
    static const char *const built_in_owners[] = {
        "nvim", "vim", "vi", "view", "tmux", "screen"
    };
    for (size_t index = 0;
         index < sizeof(built_in_owners) / sizeof(built_in_owners[0]);
         ++index) {
        if (names_equal(name, built_in_owners[index])) {
            return true;
        }
    }

    /* Optional comma/space-separated process names supplied in the shell env. */
    const char *configured_owners = getenv("GHOSTTY_TITLE_OWNERS");
    if (configured_owners == NULL) {
        return false;
    }
    const char *cursor = configured_owners;
    while (*cursor != '\0') {
        while (*cursor == ',' || *cursor == ':' || *cursor == ';' ||
               *cursor == ' ' || *cursor == '\t') {
            ++cursor;
        }
        const char *start = cursor;
        while (*cursor != '\0' && *cursor != ',' && *cursor != ':' &&
               *cursor != ';' && *cursor != ' ' && *cursor != '\t') {
            ++cursor;
        }
        size_t length = (size_t)(cursor - start);
        if (length > 0 && length < 128) {
            char owner[128];
            memcpy(owner, start, length);
            owner[length] = '\0';
            if (names_equal(name, owner)) {
                return true;
            }
        }
    }
    return false;
}

static bool zsh_is_interactive(pid_t pid) {
    char arguments[2048] = {0};
    /* A very long -c body can truncate the display buffer; its leading flags
       are still useful. Empty output means argv access itself was unavailable. */
    (void)process_arguments(pid, arguments, sizeof(arguments));
    if (arguments[0] == '\0') {
        return true; /* Be conservative when zsh's arguments are protected. */
    }

    const char *cursor = arguments;
    while (*cursor != '\0' && *cursor != ' ') ++cursor; /* argv[0] */
    bool explicit_interactive = false;
    while (*cursor != '\0') {
        while (*cursor == ' ') ++cursor;
        if (*cursor == '\0') break;
        const char *start = cursor;
        while (*cursor != '\0' && *cursor != ' ') ++cursor;
        size_t length = (size_t)(cursor - start);

        if (length == 2 && start[0] == '-' && start[1] == '-') {
            return explicit_interactive;
        }
        if (length == 13 && strncasecmp(start, "--interactive", length) == 0) {
            return true;
        }
        if (length == 9 && strncasecmp(start, "--command", length) == 0) {
            return explicit_interactive;
        }
        if (length == 2 && start[0] == '-' && start[1] == 'o') {
            while (*cursor == ' ') ++cursor;
            const char *option = cursor;
            while (*cursor != '\0' && *cursor != ' ') ++cursor;
            size_t option_length = (size_t)(cursor - option);
            if (option_length == 11 && strncasecmp(option, "interactive", option_length) == 0) {
                return true;
            }
            if (option_length == 13 && strncasecmp(option, "nointeractive", option_length) == 0) {
                return false;
            }
            continue;
        }
        if (start[0] != '-') {
            return explicit_interactive; /* A script name means non-interactive. */
        }

        bool has_interactive = false;
        bool has_command = false;
        for (size_t index = 1; index < length; ++index) {
            has_interactive |= start[index] == 'i';
            has_command |= start[index] == 'c';
        }
        explicit_interactive |= has_interactive;
        if (has_command) {
            return explicit_interactive;
        }
    }
    return true; /* No -c or script argument: a tty-launched zsh is interactive. */
}

static bool process_owns_title(const struct proc_bsdinfo *info) {
    bool is_zsh = names_equal(info->pbi_comm, "zsh") ||
                  names_equal(info->pbi_name, "zsh");
    if (is_zsh && zsh_is_interactive((pid_t)info->pbi_pid)) {
        return true;
    }
    return is_configured_owner(info->pbi_comm) ||
           is_configured_owner(info->pbi_name);
}

/* proc_listpgrppids limits inspection to the foreground group, unlike a
   system-wide ps/process-table scan. It returns the number of PIDs. */
static pid_t *foreground_group_pids(pid_t process_group, size_t *count_out) {
    size_t capacity = 64;
    while (capacity <= MAX_GROUP_PIDS) {
        pid_t *pids = calloc(capacity, sizeof(*pids));
        if (pids == NULL) {
            return NULL;
        }
        int buffer_size = (int)(capacity * sizeof(*pids));
        int count = proc_listpgrppids(process_group, pids, buffer_size);
        if (count < 0) {
            free(pids);
            return NULL;
        }
        if ((size_t)count < capacity) {
            *count_out = (size_t)count;
            return pids;
        }
        free(pids);
        capacity *= 2;
    }
    return NULL;
}

static int compare_start_time(const struct proc_bsdinfo *left,
                              const struct proc_bsdinfo *right) {
    if (left->pbi_start_tvsec < right->pbi_start_tvsec) return -1;
    if (left->pbi_start_tvsec > right->pbi_start_tvsec) return 1;
    if (left->pbi_start_tvusec < right->pbi_start_tvusec) return -1;
    if (left->pbi_start_tvusec > right->pbi_start_tvusec) return 1;
    return 0;
}

static void add_candidate(Candidate *candidates, size_t capacity,
                          size_t *candidate_count, const Candidate *candidate) {
    for (size_t index = 0; index < *candidate_count; ++index) {
        if (candidates[index].pid == candidate->pid) {
            candidates[index].in_foreground_group |= candidate->in_foreground_group;
            return;
        }
    }
    if (*candidate_count < capacity) {
        candidates[(*candidate_count)++] = *candidate;
    }
}

/* Include each foreground process's ancestors, even when a nested shell or
   interactive child has moved into a new foreground process group. */
static void collect_ancestry(pid_t shell_pid, pid_t process_pid,
                             pid_t foreground_group, Candidate *candidates,
                             size_t capacity, size_t *candidate_count,
                             bool *title_owner_found) {
    Candidate ancestry[MAX_ANCESTRY];
    size_t ancestry_count = 0;
    pid_t current = process_pid;
    bool reaches_shell = false;

    for (unsigned step = 0; step < MAX_ANCESTRY; ++step) {
        struct proc_bsdinfo info;
        if (!fetch_process_info(current, &info) || info.pbi_status == SZOMB) {
            return;
        }
        ancestry[ancestry_count++] = (Candidate){
            .pid = current,
            .info = info,
            .depth = 0,
            .in_foreground_group = info.pbi_pgid == (uint32_t)foreground_group,
        };

        pid_t parent = (pid_t)info.pbi_ppid;
        if (parent == shell_pid) {
            reaches_shell = true;
            break;
        }
        if (parent <= 1 || parent == current) {
            break;
        }
        current = parent;
    }

    /* Do not treat same-group outsiders as title owners or shell descendants. */
    if (!reaches_shell) {
        return;
    }
    for (size_t index = 0; index < ancestry_count; ++index) {
        ancestry[index].depth = (unsigned)(ancestry_count - index);
        if (process_owns_title(&ancestry[index].info)) {
            *title_owner_found = true;
        }
        add_candidate(candidates, capacity, candidate_count, &ancestry[index]);
    }
}

static size_t collect_candidates(pid_t shell_pid, pid_t process_group,
                                 Candidate *candidates, size_t capacity,
                                 bool *title_owner_found,
                                 bool *inspection_succeeded) {
    *title_owner_found = false;
    *inspection_succeeded = false;
    size_t group_count = 0;
    pid_t *pids = foreground_group_pids(process_group, &group_count);
    if (pids == NULL) {
        return 0;
    }
    *inspection_succeeded = true;

    size_t candidate_count = 0;
    for (size_t index = 0; index < group_count && candidate_count < capacity; ++index) {
        pid_t pid = pids[index];
        if (pid <= 1 || pid == shell_pid || pid == getpid()) {
            continue;
        }

        struct proc_bsdinfo info;
        if (!fetch_process_info(pid, &info) || info.pbi_status == SZOMB ||
            info.pbi_pgid != (uint32_t)process_group) {
            continue;
        }
        collect_ancestry(shell_pid, pid, process_group, candidates, capacity,
                         &candidate_count, title_owner_found);
    }
    free(pids);
    return candidate_count;
}

static void make_title(char *destination, size_t capacity, const char *user,
                       const char *main_command, const char *child,
                       unsigned columns, unsigned rows) {
    char safe_user[128];
    char safe_command[2048];
    char safe_child[256];
    clean_copy(safe_user, sizeof(safe_user), user);
    clean_copy(safe_command, sizeof(safe_command), main_command);
    clean_copy(safe_child, sizeof(safe_child), child);

    if (safe_child[0] != '\0') {
        (void)snprintf(destination, capacity, "%s — %s ▸ %s — %u×%u",
                       safe_user, safe_command, safe_child, columns, rows);
    } else {
        (void)snprintf(destination, capacity, "%s — %s — %u×%u",
                       safe_user, safe_command, columns, rows);
    }
}

static bool emit_title(const char *title) {
    char sequence[MAX_TITLE + 16];
    int length = snprintf(sequence, sizeof(sequence), "\033]2;%s\007", title);
    if (length < 0 || (size_t)length >= sizeof(sequence)) {
        return false;
    }

    size_t offset = 0;
    while (offset < (size_t)length) {
        ssize_t written = write(TITLE_FD, sequence + offset, (size_t)length - offset);
        if (written < 0) {
            if (errno == EINTR && !should_stop) {
                continue;
            }
            return false;
        }
        if (written == 0) {
            return false;
        }
        offset += (size_t)written;
    }
    return true;
}

static void sleep_between_polls(void) {
    struct timespec remaining = {
        .tv_sec = POLL_MILLISECONDS / 1000,
        .tv_nsec = (POLL_MILLISECONDS % 1000) * 1000000L,
    };
    while (!should_stop && nanosleep(&remaining, &remaining) == -1 && errno == EINTR) {
    }
}

static bool parse_pid(const char *text, pid_t *pid_out) {
    char *end = NULL;
    long value = strtol(text, &end, 10);
    if (text[0] == '\0' || end == text || *end != '\0' ||
        value <= 1 || value > INT_MAX) {
        return false;
    }
    *pid_out = (pid_t)value;
    return true;
}

static int set_prompt_title(const char *cwd) {
    unsigned columns = 0;
    unsigned rows = 0;
    terminal_dimensions(&columns, &rows);

    char prompt[MAX_TITLE];
    make_title(prompt, sizeof(prompt), user_name(), cwd, NULL, columns, rows);
    return emit_title(prompt) ? 0 : 1;
}

static int watch_command(pid_t shell_pid, const char *captured_command) {
    if (!isatty(TITLE_FD) || getppid() != shell_pid) {
        return 1;
    }
    pid_t shell_process_group = getpgid(shell_pid);
    if (shell_process_group < 0) {
        return 1;
    }

    install_signal_handlers();
    char last_title[MAX_TITLE] = {0};
    bool have_last_title = false;

    while (!should_stop) {
        if (getppid() != shell_pid) {
            break;
        }

        pid_t foreground_group = tcgetpgrp(TITLE_FD);
        if (foreground_group > 0 && foreground_group != shell_process_group) {
            Candidate candidates[MAX_CANDIDATES];
            bool title_owner_found = false;
            bool inspection_succeeded = false;
            size_t count = collect_candidates(shell_pid, foreground_group,
                                              candidates,
                                              sizeof(candidates) / sizeof(candidates[0]),
                                              &title_owner_found,
                                              &inspection_succeeded);

            if (title_owner_found) {
                /* Let the application's OSC title pass through. */
                have_last_title = false;
            } else if (count > 0) {
                unsigned shallowest = UINT_MAX;
                size_t shallowest_count = 0;
                Candidate *main_process = NULL;
                Candidate *active_process = NULL;
                for (size_t index = 0; index < count; ++index) {
                    Candidate *candidate = &candidates[index];
                    if (candidate->depth < shallowest) {
                        shallowest = candidate->depth;
                        shallowest_count = 1;
                        main_process = candidate;
                    } else if (candidate->depth == shallowest) {
                        ++shallowest_count;
                        if (main_process == NULL ||
                            compare_start_time(&candidate->info, &main_process->info) < 0) {
                            main_process = candidate;
                        }
                    }

                    if (candidate->in_foreground_group &&
                        (active_process == NULL ||
                         candidate->depth > active_process->depth ||
                         (candidate->depth == active_process->depth &&
                          compare_start_time(&candidate->info, &active_process->info) > 0))) {
                        active_process = candidate;
                    }
                }

                char main_command[2048];
                bool have_process_arguments = shallowest_count == 1 &&
                    main_process != NULL &&
                    process_arguments(main_process->pid, main_command, sizeof(main_command));
                bool process_arguments_are_informative = have_process_arguments &&
                    (strpbrk(main_command, " \t") != NULL ||
                     strpbrk(captured_command, " \t") == NULL);
                if (process_arguments_are_informative) {
                    /* argv reflects the actual command after aliases/shebangs/exec. */
                } else {
                    clean_copy(main_command, sizeof(main_command), captured_command);
                    if (main_command[0] == '\0' && main_process != NULL) {
                        process_name(main_process->pid, &main_process->info,
                                     main_command, sizeof(main_command));
                    }
                }

                char child[256] = {0};
                if (active_process != NULL && active_process != main_process &&
                    active_process->depth > shallowest) {
                    process_name(active_process->pid, &active_process->info,
                                 child, sizeof(child));
                }

                unsigned columns = 0;
                unsigned rows = 0;
                terminal_dimensions(&columns, &rows);
                char title[MAX_TITLE];
                make_title(title, sizeof(title), user_name(), main_command,
                           child, columns, rows);
                if (!have_last_title || strcmp(title, last_title) != 0) {
                    (void)emit_title(title);
                    (void)snprintf(last_title, sizeof(last_title), "%s", title);
                    have_last_title = true;
                }
            } else if (inspection_succeeded) {
                /* Process data can be unavailable briefly (e.g. exec races). */
                unsigned columns = 0;
                unsigned rows = 0;
                terminal_dimensions(&columns, &rows);
                char title[MAX_TITLE];
                make_title(title, sizeof(title), user_name(), captured_command,
                           NULL, columns, rows);
                if (!have_last_title || strcmp(title, last_title) != 0) {
                    (void)emit_title(title);
                    (void)snprintf(last_title, sizeof(last_title), "%s", title);
                    have_last_title = true;
                }
            }
        } else {
            /* The shell regained the terminal; precmd owns prompt restoration. */
            have_last_title = false;
        }

        sleep_between_polls();
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc == 3 && strcmp(argv[1], "--prompt") == 0) {
        return set_prompt_title(argv[2]);
    }
    if (argc == 4 && strcmp(argv[1], "--watch") == 0) {
        pid_t shell_pid = 0;
        if (!parse_pid(argv[2], &shell_pid)) {
            return 2;
        }
        return watch_command(shell_pid, argv[3]);
    }
    return 2;
}
