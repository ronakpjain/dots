# Dynamic Ghostty title integration. The native helper is optional so the
# shell remains usable before it is built/installed.

(( ${+_GHOSTTY_TITLE_HOOKS_INSTALLED} )) && return 0
typeset -g _GHOSTTY_TITLE_HOOKS_INSTALLED=1

autoload -Uz add-zsh-hook

typeset -g _GHOSTTY_TITLE_HELPER="${GHOSTTY_TITLE_HELPER:-$HOME/.local/bin/ghostty-title-monitor}"
typeset -g _GHOSTTY_TITLE_MONITOR_PID=''

_ghostty_title_emit_fallback() {
  local title="${1//[[:cntrl:]]/ }"
  print -rn -- $'\e]2;'"$title"$'\a'
}

_ghostty_title_stop_monitor() {
  local pid="$_GHOSTTY_TITLE_MONITOR_PID"
  [[ -n "$pid" ]] || return 0

  local monitor_was_enabled="$options[monitor]"
  unsetopt monitor
  kill -TERM "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  _GHOSTTY_TITLE_MONITOR_PID=''
  [[ "$monitor_was_enabled" == on ]] && setopt monitor
  return 0
}

_ghostty_title_preexec() {
  local command_text="${1-}"
  _ghostty_title_stop_monitor || return

  if [[ "${(L)TERM_PROGRAM}" == ghostty && -x "$_GHOSTTY_TITLE_HELPER" &&
        "$options[monitor]" == on ]]; then
    # Spawn with job control briefly disabled to avoid an interactive '[1] PID'
    # notification, then restore it before zsh launches the foreground command.
    local monitor_was_enabled="$options[monitor]"
    unsetopt monitor
    command "$_GHOSTTY_TITLE_HELPER" --watch "$$" "$command_text" \
      3>/dev/tty >/dev/null 2>&1 &
    _GHOSTTY_TITLE_MONITOR_PID=$!
    [[ "$monitor_was_enabled" == on ]] && setopt monitor
  else
    _ghostty_title_emit_fallback "${USER:-$(id -un)} — $command_text — ${COLUMNS:-0}×${LINES:-0}"
  fi
}

_ghostty_title_precmd() {
  local -i saved_status=$?
  _ghostty_title_stop_monitor || return saved_status

  if [[ -x "$_GHOSTTY_TITLE_HELPER" ]]; then
    command "$_GHOSTTY_TITLE_HELPER" --prompt "$PWD" \
      3>/dev/tty >/dev/null 2>&1 || \
      _ghostty_title_emit_fallback "${USER:-$(id -un)} — $PWD — ${COLUMNS:-0}×${LINES:-0}"
  else
    _ghostty_title_emit_fallback "${USER:-$(id -un)} — $PWD — ${COLUMNS:-0}×${LINES:-0}"
  fi
  return saved_status
}

_ghostty_title_zshexit() {
  _ghostty_title_stop_monitor
}

add-zsh-hook preexec _ghostty_title_preexec
add-zsh-hook precmd _ghostty_title_precmd
add-zsh-hook zshexit _ghostty_title_zshexit
