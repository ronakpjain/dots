---
name: tmux
description: Controls isolated tmux sessions to run, observe, debug, and test interactive TUI and CLI programs. Use when an app needs scripted keystrokes, terminal resizing, pane/output capture, exit-status checks, crash or hang diagnosis, or repeatable terminal scenarios.
---

# tmux TUI/CLI harness

Use tmux as a programmable pseudo-terminal (PTY) harness. Work through detached
sessions and inspect them with `capture-pane`; do not attach and do not type into
the user's normal tmux server unless they explicitly ask for that session.

## Operating rules

- Check that tmux is available with `command -v tmux` and `tmux -V`.
- Use a private socket (`-S`) and a unique session for automation. This avoids
  changing the user's existing windows, key bindings, or server options.
- Keep the private socket path short. macOS Unix-domain socket paths have a
  small limit (about 104 bytes); a long `$TMPDIR` plus nested directories can
  make tmux fail before the session starts. Prefer a short `/tmp` run directory
  and socket basename.
- Keep the exact socket path and session name. Every later tmux command must use
  the same socket; a session on the default socket is a different session.
- Use pane IDs (`%0`, `%1`, ...) returned by `-P -F '#{pane_id}'` when panes can
  be created or reordered. Do not assume that a pane index remains stable.
- Start the program with `exec` when possible. That makes the pane PID and
  `pane_dead_status` describe the program rather than an extra shell.
- Wait for a prompt or other observable state before sending input. Prefer
  polling captured output over arbitrary long sleeps.
- Treat command strings, keystrokes, captured output, and log files as data.
  Quote shell arguments and never put secrets into a capture or pipe log.
- On failure, capture output and process metadata before cleanup. Do not kill a
  default tmux server or an unrelated process.

## Create an isolated harness

Run setup and control in one Bash script or one `bash` tool invocation so that
functions and variables are retained. This template uses a private socket,
a deterministic size, a large scrollback buffer, and `remain-on-exit` so that
crashes and short-lived commands can still be inspected:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Keep this path short: macOS Unix-domain sockets are limited to about 104
# bytes, and a long TMPDIR can otherwise make the socket path too long.
RUN_DIR="$(mktemp -d /tmp/pt.XXXXXX)"
SOCKET="$RUN_DIR/s"
SESSION="pi-tmux-$$"
TARGET="$SESSION:0.0"
WORKDIR="$PWD"

# -f /dev/null prevents the user's tmux.conf from changing this harness.
tmuxx() {
  tmux -f /dev/null -S "$SOCKET" "$@"
}

cleanup() {
  # This is safe because SOCKET points at the private server created above.
  tmuxx kill-server >/dev/null 2>&1 || true
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT

tmuxx new-session -d -s "$SESSION" -n app \
  -c "$WORKDIR" -x 100 -y 30 'exec bash --noprofile --norc'
# Do not let the status line consume a row: -y 30 should produce a 30-row
# pane, rather than a 29-row pane.
tmuxx set-option -t "$SESSION" status off
tmuxx set-option -t "$SESSION" remain-on-exit on
tmuxx set-option -t "$SESSION" history-limit 10000
tmuxx set-window-option -t "$SESSION:0" window-size manual
```

`respawn-pane` runs its final argument through a shell. For a trusted command,
this is sufficient:

```bash
COMMAND='exec ./build/my-tui --test-mode'
tmuxx respawn-pane -k -t "$TARGET" "$COMMAND"
```

When arguments contain spaces or come from variables, build a shell-escaped
command instead of concatenating raw input:

```bash
args=(./build/my-tui --test-mode --name 'value with spaces')
printf -v COMMAND '%q ' "${args[@]}"
COMMAND="exec $COMMAND"
tmuxx respawn-pane -k -t "$TARGET" "$COMMAND"
```

Set test-specific environment variables before `respawn-pane` so the program
inherits them:

```bash
tmuxx set-environment -t "$SESSION" APP_ENV test
tmuxx set-environment -t "$SESSION" NO_COLOR 1  # only for a no-color case
tmuxx respawn-pane -k -t "$TARGET" "$COMMAND"
```

Do not force `NO_COLOR` for a normal TUI test. Record the terminal environment
when behavior depends on it. `TERM` is often a global tmux environment value,
not a session variable, so inspect the pane process too:

```bash
tmuxx show-options -gqv default-terminal
tmuxx show-environment -g TERM || true
PID="$(tmuxx display-message -p -t "$TARGET" '#{pane_pid}')"
ps eww -p "$PID" | tr ' ' '\n' | grep -E '^(TERM|LANG|LC_|COLORTERM)=' || true
```

## Inspect state and output

First confirm the target and pane state:

```bash
tmuxx has-session -t "$SESSION"
tmuxx list-panes -t "$SESSION" -F \
  'id=#{pane_id} pid=#{pane_pid} cmd=#{pane_current_command} dead=#{pane_dead} status=#{pane_dead_status} size=#{pane_width}x#{pane_height} path=#{pane_current_path}'
tmuxx display-message -p -t "$TARGET" \
  'pid=#{pane_pid} cmd=#{pane_current_command} dead=#{pane_dead} status=#{pane_dead_status} size=#{pane_width}x#{pane_height} path=#{pane_current_path}'
```

For ordinary assertions, capture the pane as normalized text. `-J` joins lines
that were wrapped by the terminal; omit it for layout-sensitive assertions:

```bash
# Recent scrollback and the visible screen. `-E -` means the end of the
# visible pane; a numeric negative value refers to history lines instead.
tmuxx capture-pane -p -J -t "$TARGET" -S -500 -E -

# Preserve rows and columns exactly for a layout check.
tmuxx capture-pane -p -t "$TARGET" -S -100 -E - > "$RUN_DIR/pane.txt"

# Include escape sequences for rendered text/background attributes (such as
# colors) for terminal-behavior debugging. This is not a raw I/O recording.
tmuxx capture-pane -p -e -t "$TARGET" -S -100 -E - > "$RUN_DIR/pane.ansi"

# A TUI may use the alternate screen. Capture both views when diagnosing it.
# `-a` fails when the pane has no alternate screen, so tolerate that case.
tmuxx capture-pane -a -p -t "$TARGET" -S -100 -E - > "$RUN_DIR/pane.alternate.txt" 2>/dev/null || true
```

Use `grep -Fq -- "$needle"` for literal text assertions. Do not strip ANSI
sequences before checking a color or terminal-protocol test. `capture-pane` can
verify cell geometry, text, and (with `-e`) ANSI attributes, but it cannot
verify actual font rendering, glyph fallback, cursor shape, or pixel-level
appearance. It shows terminal cell contents, not a pixel screenshot; use an
attached/GUI terminal screenshot or image-based test for those properties.

To retain a live log, start a pipe before launching the application:

```bash
LOG="$RUN_DIR/pane.log"
PIPE_COMMAND=$(printf 'cat >> %q' "$LOG")
tmuxx pipe-pane -o -t "$TARGET" "$PIPE_COMMAND"
tmuxx respawn-pane -k -t "$TARGET" "$COMMAND"

# Stop the pipe when the scenario is complete. A naturally dead pane may
# reject this command, so do not hide the test result behind cleanup.
tmuxx pipe-pane -t "$TARGET" 2>/dev/null || true
```

Use captured panes for assertions even when a pipe is enabled. A pipe can
change the timing or volume of I/O and may include terminal control bytes.

## Send input safely

Send printable text literally, then send control keys separately. This avoids
having a string such as `Enter` interpreted as a named tmux key and makes the
scenario readable:

```bash
send_text() {
  tmuxx send-keys -t "$TARGET" -l -- "$1"
}
send_enter() {
  tmuxx send-keys -t "$TARGET" Enter
}

send_text 'hello world'
send_enter
# Common named keys: Escape, Tab, BTab, Up, Down, Left, Right, Home, End,
# PageUp, PageDown, BS, DC, Space, and Enter.
```

Useful input patterns:

- Prefer the application's native quit key or command and wait for it to exit.
  For Neovim/Vim, use `Escape`, type `:qa` (or `:qa!` when discarding test
  changes), and press `Enter` rather than interrupting it.
- `C-c` is an interrupt fallback, not a universally clean quit. In Neovim it
  can leave an interrupt/“Press ENTER” prompt; send it only after the native
  quit action fails to exit.
- `Escape`, arrows, function keys, and `Tab` model TUI navigation.
- `-N 3 Down` repeats a key three times.
- `send-keys -l` models typed characters; it is not the same as bracketed
  paste. Test paste behavior through the app's actual paste path when it
  matters.
- Send one action at a time and wait for the resulting state. Avoid a large
  unverified batch of keys, which hides the first failed transition.
- Never send passwords, tokens, or other secrets when pane capture or logging
  is enabled.

### Test mouse input

Mouse events are terminal-protocol bytes, not ordinary key names. In a detached
harness, inject SGR mouse events literally into the pane after the application
has enabled mouse reporting. Coordinates are 1-based and relative to the pane:

```bash
send_mouse_sgr() {
  local code="$1" col="$2" row="$3" suffix="${4:-M}"
  tmuxx send-keys -t "$TARGET" -l -- \
    $'\e[<'"$code;$col;$row$suffix"
}

mouse_click() {
  local col="$1" row="$2"
  send_mouse_sgr 0 "$col" "$row" M  # left-button press
  send_mouse_sgr 0 "$col" "$row" m  # release
}

mouse_wheel_up() {
  send_mouse_sgr 64 "$1" "$2" M
}
mouse_wheel_down() {
  send_mouse_sgr 65 "$1" "$2" M
}

mouse_click 10 5
mouse_wheel_down 10 5
```

For SGR mouse mode, button codes `0`, `1`, and `2` are left, middle, and
right; add `4` for Shift, `8` for Alt, or `16` for Ctrl. Add `32` to a button
code for motion/drag, and use `64`/`65` for wheel up/down. Use the protocol
that the application requests if it does not support SGR (1006). Assert the
result with `capture-pane` or an application event log. `send-keys -M` forwards
a real mouse event from a client mouse binding; it does not synthesize a
coordinate-bearing event for a detached session.

## Resize and terminal-behavior tests

Set a manual window size so a detached session is reproducible. A single-pane
window is easiest to control with `resize-window`:

```bash
tmuxx resize-window -t "$SESSION:0" -x 80 -y 24
tmuxx display-message -p -t "$TARGET" '#{pane_width}x#{pane_height}'
```

For multiple panes, use `resize-pane` on the pane under test. Run separate
scenarios for boundary sizes such as 80x24, 100x30, and the smallest supported
size. Resize while the TUI is running to test its `SIGWINCH` handling, then
capture without `-J` to verify rows, columns, truncation, and wrapping.

If colors, Unicode, or key decoding differ from a real terminal, record and
compare `tmux -V`, `TERM`, locale, `COLORTERM`, and the app's terminal-mode
configuration. Do not assume that a local attached terminal and a detached
tmux pane have identical capabilities.

## Wait for state instead of sleeping blindly

Define a small polling helper after the setup above:

```bash
wait_for_text() {
  local needle="$1"
  local timeout="${2:-5}"
  local deadline
  local output
  deadline=$((SECONDS + timeout))

  while (( SECONDS < deadline )); do
    if ! tmuxx has-session -t "$SESSION" 2>/dev/null; then
      return 1
    fi
    output="$(tmuxx capture-pane -p -J -t "$TARGET" -S -500 -E - 2>/dev/null || true)"
    if grep -Fq -- "$needle" <<<"$output"; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

if ! wait_for_text 'Ready' 10; then
  tmuxx display-message -p -t "$TARGET" \
    'pid=#{pane_pid} cmd=#{pane_current_command} dead=#{pane_dead} status=#{pane_dead_status}' || true
  tmuxx capture-pane -p -J -t "$TARGET" -S -500 -E - || true
  exit 1
fi
```

Use a file or a protocol marker instead of a prompt when the app's output is
not stable. If a state cannot be observed from output, use an app-provided
health endpoint, test hook, or marker file rather than guessing with sleeps.

## Repeatable smoke-test pattern

For each scenario:

1. Create a fresh private session and choose the working directory.
2. Set the terminal size and only the environment needed by the test.
3. Start output capture or piping before launching the app.
4. Launch the app with `exec` and wait for its ready state.
5. Send one input action, wait for the next observable state, and assert it.
6. Exercise the application's native quit behavior and wait for the pane to
   become dead; use `C-c` only as a fallback if native quit fails.
7. Check `pane_dead_status`, save final output and metadata, then clean up.

A generic interaction looks like this:

```bash
COMMAND='exec ./bin/my-cli --interactive'
tmuxx respawn-pane -k -t "$TARGET" "$COMMAND"

wait_for_text 'Name:' 10
send_text 'Ada'
send_enter
wait_for_text 'Accepted' 5

# Exercise the program's documented/native quit action here; this generic CLI
# has no universal quit key. For Neovim/Vim, send Escape, type :qa, and press
# Enter instead (use :qa! when discarding test changes):
#   tmuxx send-keys -t "$TARGET" Escape
#   send_text ':qa'
#   send_enter

for _ in {1..50}; do
  [[ "$(tmuxx display-message -p -t "$TARGET" '#{pane_dead}' 2>/dev/null || true)" == 1 ]] && break
  sleep 0.1
done

if [[ "$(tmuxx display-message -p -t "$TARGET" '#{pane_dead}' 2>/dev/null || true)" != 1 ]]; then
  # C-c sends an interrupt and is only a fallback after native quit fails.
  tmuxx send-keys -t "$TARGET" C-c
  for _ in {1..50}; do
    [[ "$(tmuxx display-message -p -t "$TARGET" '#{pane_dead}' 2>/dev/null || true)" == 1 ]] && break
    sleep 0.1
  done
fi

status="$(tmuxx display-message -p -t "$TARGET" '#{pane_dead_status}')"
[[ "$status" == 0 ]] || {
  tmuxx capture-pane -p -J -t "$TARGET" -S -500 -E -
  exit 1
}
```

For a TUI, replace text prompts with stable screen labels or an application
state marker, send named navigation keys, and assert each screen transition.
Keep layout tests separate from semantic text tests so wrapping normalization
does not conceal a geometry regression.

## Multipane programs

Use separate panes for a server and its client, and retain the pane IDs printed
by `split-window`:

```bash
SERVER_PANE="$(tmuxx split-window -h -P -F '#{pane_id}' \
  -t "$TARGET" -c "$WORKDIR" 'exec ./bin/server --test-mode')"
CLIENT_PANE="$TARGET"

tmuxx select-layout -t "$SESSION:0" even-horizontal
tmuxx list-panes -t "$SESSION:0" -F \
  'id=#{pane_id} pid=#{pane_pid} cmd=#{pane_current_command} size=#{pane_width}x#{pane_height}'
```

Capture and inspect each pane independently. Wait for a server-ready marker
before launching the client. Avoid `synchronize-panes` in automated tests: one
mistake then broadcasts input to every process.

## Debug crashes, exits, and hangs

When a scenario fails, collect evidence in this order:

```bash
# Pane and exit state.
tmuxx display-message -p -t "$TARGET" \
  'pid=#{pane_pid} cmd=#{pane_current_command} dead=#{pane_dead} status=#{pane_dead_status} size=#{pane_width}x#{pane_height}'

# Rendered output, including the alternate screen if relevant.
tmuxx capture-pane -p -J -t "$TARGET" -S -1000 -E - || true
tmuxx capture-pane -a -p -t "$TARGET" -S -200 -E - || true

# Process information for the pane process.
PID="$(tmuxx display-message -p -t "$TARGET" '#{pane_pid}')"
ps -ww -o pid=,ppid=,stat=,command= -p "$PID" || true
pgrep -P "$PID" || true

# tmux's own recent diagnostics.
tmuxx show-messages -JT || true
```

Interpret the evidence as follows:

- `dead=1` with a nonzero `status` indicates an application exit or crash;
  preserve the pane output, live log, and app-specific log before cleanup.
- An alive pane with no progress is a hang candidate. Check the current
  command, PID/process children, output pipe, and external dependencies before
  interrupting it.
- An empty normal capture does not prove that nothing was drawn; inspect the
  alternate screen and use `-e` when terminal escape sequences matter.
- If the pane PID is a shell, relaunch with an `exec` command or inspect its
  children before assigning the exit status to the app.
- Use application-native debug flags, log levels, tracing, or a debugger when
  tmux evidence identifies the phase but not the cause. Do not kill an
  arbitrary PID; use the application's native quit action first, then `C-c`
  only as a fallback, and only signal a verified child of this harness.

For a timeout, always include the last capture, terminal dimensions, command,
PID, and environment relevant to the failure. This makes a TUI failure
reproducible without requiring an attached terminal.

## Cleanup and handoff

Normally clean up only the private server:

```bash
tmuxx kill-session -t "$SESSION" 2>/dev/null || true
# The EXIT trap can then remove RUN_DIR and its logs.
```

If the user needs to inspect a live session, do not remove it. Report the
absolute socket and session names and give the exact command they can attach
with:

```bash
tmux -S "$SOCKET" attach-session -t "$SESSION"
```

Before cleanup, save any useful artifacts outside `RUN_DIR` or disable the
cleanup trap. Never use `tmux kill-server` without the private `-S`/`-L` option,
and never attach to or modify an existing user session as a side effect.

If invoked as `/skill:tmux <args>`, treat the arguments as the requested app,
scenario, or debugging target; first establish the isolated harness, then run
only the requested interaction and report captured evidence and exit status.
