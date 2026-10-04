# Hyprland Keybinds

Configured in `hyprland.lua` (native Lua, Hyprland 0.55+).
Validate with `Hyprland --verify-config -c ~/.config/hypr/hyprland.lua`.
After migrating from `hyprland.conf`, restart your Hyprland session to use the new entry point.

## Spawn / Apps
| Key | Action |
|---|---|
| `Alt+K` | Open terminal (ghostty) |
| `Alt+R` | Open app launcher (rofi) |
| `Alt+A` | Keyboard-driven pointer (wl-kbptr) |

## Window Management
| Key | Action |
|---|---|
| `Alt+Q` | Close the active window |
| `Alt+W` | Send Ctrl+W to window (close tab) |
| `Alt+V` | Toggle floating |
| `Alt+F` | Fullscreen (fake) |
| `Alt+Shift+F` | Fullscreen (real) |

## Focus
| Key | Action |
|---|---|
| `Alt+←/↓/↑/→` | Focus window in direction |

## Workspaces
| Key | Action |
|---|---|
| `Alt+1-9,0` | Switch to workspace 1-10 |
| `Alt+Shift+1-9,0` | Move window to workspace 1-10 |
| `Alt+S` | Toggle special workspace (scratchpad) |
| `Alt+Shift+S` | Move window to special workspace |
| `Alt+scroll` | Cycle workspaces |

## System
| Key | Action |
|---|---|
| `Alt+M` | Exit Hyprland |
| `Alt+O` | Shutdown |
| `Alt+L` | Lock (hyprlock) |

## Media Keys
| Key | Action |
|---|---|
| `XF86AudioRaise/LowerVolume` | Volume ±5% |
| `XF86AudioMute` | Toggle mute |
| `XF86AudioMicMute` | Toggle mic mute |
| `XF86MonBrightnessUp/Down` | Brightness ±5% |
| `XF86AudioPlay/Pause/Next/Prev` | Media controls |

## Screenshot
| Key | Action |
|---|---|
| `Super+Shift+S` | Region screenshot → clipboard |

## Mouse
| Key | Action |
|---|---|
| `Alt+LMB drag` | Move window |
| `Alt+RMB drag` | Resize window |
