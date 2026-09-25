# macOS Ghostty dynamic title

Ghostty 1.3.2's installed zsh integration sets the cwd title in `precmd` and
uses the `preexec` command text for the running title; it does not inspect the
foreground process tree. Because there is no native child-title extension or
safe title-read API to append to, this setup disables that title feature and
lets its zsh hooks plus a small macOS C helper own the complete OSC 2 title.
The rest of Ghostty shell integration remains enabled.

## Build and install

From the dotfiles repository root:

```sh
mkdir -p "$HOME/.local/bin"
clang -std=c11 -O2 -Wall -Wextra -Wpedantic \
  macconfig/ghostty/title-monitor.c \
  -o "$HOME/.local/bin/ghostty-title-monitor"
```

The shell integration is loaded from `~/.config/ghostty/title.zsh`, provided by
the existing `macconfig/ghostty` symlink. The binary is optional: without it,
zsh still sets a safe command title and restores the user/cwd/size title at the
prompt, but there is no child-process suffix. Native tracking requires
interactive zsh job control (`setopt monitor`, enabled by default). Start a
new zsh shell after building, or run:

```zsh
source ~/.config/ghostty/title.zsh
```

The helper path can be overridden before sourcing with
`GHOSTTY_TITLE_HELPER=/path/to/ghostty-title-monitor`.

## Ghostty configuration

Keep this setting in `config.ghostty`:

```ini
shell-integration-features = no-title
```

Do **not** set Ghostty's `title` option: a configured `title` forces a fixed
window title and ignores title escape sequences. `no-title` disables only
Ghostty shell integration's title updates; the OSC 2 titles from this helper
and applications are still accepted.

## What the title shows

At a prompt:

```text
ronak — /current/directory — 201×60
```

While a foreground command runs:

```text
ronak — ruby -W1 --disable-gems,rubyopt /opt/homebrew/Library/Homebrew/brew.rb upgrade --greedy ▸ curl — 201×60
```

For one top-level foreground process, the main label comes from its actual
`argv` (so aliases, shebangs, and `exec` are reflected); the captured zsh
`preexec` command is the fallback and is used for pipelines with multiple
same-level foreground processes. The suffix is the deepest observed live
foreground-group descendant's executable name. Pipeline siblings are not
misrepresented as parent/child processes. Width and height come from
`TIOCGWINSZ` and are rendered as columns×rows.

## Selection and precedence

- The helper asks `tcgetpgrp()` for the terminal's current foreground process
  group, then uses `proc_listpgrppids()` to enumerate only that group. It does
  not scan the machine or launch `ps`.
- For each foreground member it follows `pbi_ppid` via `proc_pidinfo()` until
  it reaches the zsh PID supplied by the hook. It retains those ancestors even
  if a nested shell has moved into a different process group; only current
  foreground-group members can be the active suffix. Unrelated processes,
  zombies, and the helper itself are ignored.
- The shallowest candidate is the main process; the deepest candidate is the
  active suffix. When candidates tie in depth, the oldest process is used as
  the main label and the newest as the active candidate. For a single main
  process, `KERN_PROCARGS2` supplies the real arguments without spawning a
  subprocess. If arguments are unavailable or have been rewritten to only a
  bare executable name, the captured shell command is used; if that is empty,
  the executable name is the last fallback. Pipelines retain their full
  captured command as the main label.
- The watcher polls every 150 ms, sleeps between polls, and emits OSC 2 only
  when its computed title changes. Children shorter-lived than a poll can be
  missed; the polling interval balances responsiveness against overhead.
- `nvim`, `vim`, `vi`, `view`, `tmux`, and `screen` are treated as title owners:
  while one is in the foreground group or its foreground ancestry, the helper
  does not write titles, so their OSC titles take precedence. Nested zsh
  shells are treated as title owners so an interactive child's own hooks/helper
  can take over while the outer watcher stays quiet. macOS may hide or rewrite
  a non-interactive zsh's argv, so that case can also be treated as an owner
  until it exits. Add other title-managing executable names
  with a comma- or space-separated `GHOSTTY_TITLE_OWNERS` environment variable.
  The helper does not repeatedly reassert its title, so an unlisted program's
  own OSC title normally remains visible until the process-derived title changes.
- SSH is necessarily opaque: the local helper sees the `ssh` process, not the
  remote process tree. Remote OSC title updates pass through; any local title
  changes occur only when the locally observable process-derived title changes.
- `precmd` signals and waits for the watcher to exit before writing the
  restored prompt title, so a late watcher update cannot win the race.
  `zshexit` also stops/reaps it on shell exit; the helper exits if its parent
  shell disappears unexpectedly.

## Test

Open a new Ghostty shell and run:

```sh
sleep 30
```

The title should show `sleep 30` and dimensions; press Ctrl-C and confirm the
prompt title returns to username, cwd, and dimensions. To test a descendant,
run:

```sh
ruby -e 'pid = fork { exec "sleep", "20" }; Process.wait(pid)'
```

The title should append `▸ sleep`; Ctrl-C should restore the prompt. To watch
a suffix change without network or package-manager work, run:

```sh
ruby -e '["sleep", "tail"].each { |name| pid = Process.spawn(name, *(name == "sleep" ? ["4"] : ["-f", "/dev/null"]), out: File::NULL); sleep 3; Process.kill("TERM", pid); Process.wait(pid) }'
```

The suffix should change from `sleep` to `tail`. A pipeline like `sleep 5 | cat`
checks that the captured full command is retained when multiple foreground
processes are peers. Try `nvim` and `tmux` if installed to confirm their own
titles are not continually overwritten.

For the Homebrew-specific behavior, run a command that performs child work and
observe the `curl`/`git` suffix change. `brew upgrade --greedy` can install or
upgrade packages, so only use it as a test if those changes are intended.

The displayed main process arguments are visible in the window/tab title. Avoid
putting secrets directly in command-line arguments (environment variables or
interactive prompts are safer).
