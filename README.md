# Dotfiles

This repository stores my personal configuration for macOS and Linux (Arch + Hyprland/Niri).

![Screenshot](background/Screenshot.png)

## Quick Setup

### macOS

```bash
git clone https://github.com/ronak/dots.git ~/dots
cd ~/dots && ./setup-mac.sh
```

The script installs everything: Homebrew, packages, zsh plugins, symlinks, Neovim plugins, services, and macOS defaults.

### Linux (Arch)

```bash
git clone https://github.com/ronak/dots.git ~/dots
cd ~/dots && ./setup-linux.sh
```

The script installs everything: yay packages, zsh plugins, symlinks, Neovim plugins, and Wayland session config.

## Repository layout
- `macconfig/` – macOS services, keybindings, and status bar configs.
- `linuxconfig/` – Linux Hyprland, Niri, Kitty, Waybar, Rofi, and Neovim configs.
- `vim/` – Vim/Neovim configuration, plugins, and runtime files.
- `setup-mac.sh` – Full Mac bootstrap script.
- `setup-linux.sh` – Full Linux (Arch) bootstrap script.
- Top-level files such as `maczshrc`, `linuxzshrc`, `vimrc` are symlinked into `~/`.

## What gets installed

### macOS — Homebrew Formulae

| Category | Packages |
|---|---|
| **Tiling WM** | yabai, skhd, sketchybar, borders |
| **Terminal & Shell** | eza, fzf, fd, ripgrep, zoxide, vivid, tree |
| **Editors** | neovim |
| **Languages** | python@3.13, node, go, rust, bun, lua, luajit |
| **LSP & Formatters** | stylua, prettier, latexindent, gopls, rust-analyzer, lua-language-server, texlab, verible, neocmakelsp, tree-sitter |
| **Build Tools** | cmake, make, gcc, ninja, meson, pkgconf |
| **CLI Utilities** | gh, git, jq, wget, btop, fastfetch, ncdu, pstree, htop |
| **Media** | ffmpeg, yt-dlp, mpv, imagemagick |
| **Misc** | spicetify-cli, mactop, deno, uv |

### macOS — GitHub Releases

| App | Source |
|---|---|
| [Mofi](https://github.com/ronakpjain/mofi) | Latest release — Spotlight replacement with theming |

### macOS — Homebrew Casks

| Category | Packages |
|---|---|
| **Fonts** | font-hack-nerd-font, font-jetbrains-mono-nerd-font |
| **Window Mgmt** | hammerspoon, alt-tab |
| **Browsers** | firefox@nightly, google-chrome |
| **Terminals** | kitty, ghostty, wezterm |
| **Editors** | visual-studio-code@insiders, zed, codex |
| **Media** | iina, spotify, sioyek, skim |
| **Dev Tools** | docker-desktop |
| **Productivity** | tailscale-app, slack@beta, thunderbird, transmission |

### Shell Setup (both macOS & Linux)
- zsh plugins installed directly through the system package manager: zsh-autosuggestions and zsh-syntax-highlighting
- [fzf](https://github.com/junegunn/fzf) fuzzy finder with Catppuccin colors
- [vivid](https://github.com/sharkdp/vivid) LS_COLORS with Catppuccin Mocha
- [eza](https://github.com/eza-community/eza) as `ls` replacement with icons

### Hercules tmux access
On macOS, run `hercules` to SSH to Hercules and create or reattach to the persistent tmux session `main` running there (tmux is not run locally). Pass an optional session name, such as `hercules work`. Install tmux on Hercules with `sudo pacman -S --needed tmux` if it is not already installed.

### macOS — Symlinks

| Source | Target |
|---|---|
| `dots/maczshrc` | `~/.zshrc` |
| `dots/vimrc` | `~/.vimrc` |
| `dots/vim/` | `~/.vim/` |
| `dots/macconfig/nvim/` | `~/.config/nvim/` |
| `dots/macconfig/kitty/` | `~/.config/kitty/` |
| `dots/macconfig/yabai/` | `~/.config/yabai/` |
| `dots/macconfig/skhd/` | `~/.config/skhd/` |
| `dots/macconfig/sketchybar/` | `~/.config/sketchybar/` |
| `dots/macconfig/hammerspoon/` | `~/.hammerspoon/` |
| `dots/macconfig/borders/` | `~/.config/borders/` |
| `dots/macconfig/opencode/` | `~/.config/opencode/` |
| `dots/macconfig/mofi/` | `~/.config/mofi/` |

### macOS — Defaults Applied
- Fast key repeat (KeyRepeat=2, InitialKeyRepeat=15)
- Disable press-and-hold (key repeat instead)
- Show hidden files and extensions in Finder
- Disable .DS_Store on network volumes
- Disable quarantine dialog for downloaded apps
- Expand save/print panels by default

---

### Linux — yay Packages

| Category | Packages |
|---|---|
| **Tiling WM** | hyprland, niri, waybar, rofi, hyprlock, hyprpaper, awww-bin, uwsm |
| **Terminal & Shell** | kitty, ghostty, tmux, zsh, eza, fzf, fd, ripgrep, zoxide, vivid, tree |
| **Editors** | neovim |
| **Languages** | python, nodejs, bun, go, rust, lua, luajit |
| **LSP & Formatters** | stylua, prettier, python-lsp-server, python-debugpy, gopls, rust-analyzer, lua-language-server, clang, lldb, texlab, texlive-binextra, svelte-language-server, typescript-language-server, neocmakelsp, marksman, verible, ty, tree-sitter |
| **Build Tools** | cmake, make, gcc, ninja, meson, pkgconf |
| **CLI Utilities** | gh, git, jq, wget, btop, fastfetch, ncdu, htop |
| **Wayland Utilities** | grim, slurp, wl-clipboard, playerctl, brightnessctl, wireplumber, pipewire, pipewire-alsa, pipewire-pulse, pavucontrol, swaybg, wl-kbptr |
| **Media** | ffmpeg, yt-dlp, mpv, imagemagick |
| **Fonts** | ttf-hack, ttf-jetbrains-mono, noto-fonts, noto-fonts-cjk |

### Linux — AUR Packages

| Package | Description |
|---|---|
| visual-studio-code-bin | VS Code |
| zed | Zed editor |
| spotify | Spotify client |

### Linux — Symlinks

| Source | Target |
|---|---|
| `dots/linuxzshrc` | `~/.zshrc` |
| `dots/vimrc` | `~/.vimrc` |
| `dots/vim/` | `~/.vim/` |
| `dots/linuxconfig/nvim/` | `~/.config/nvim/` |
| `dots/linuxconfig/kitty/` | `~/.config/kitty/` |
| `dots/linuxconfig/ghostty/` | `~/.config/ghostty/` |
| `dots/linuxconfig/hypr/` | `~/.config/hypr/` |
| `dots/linuxconfig/waybar/` | `~/.config/waybar/` |
| `dots/linuxconfig/niri/` | `~/.config/niri/` |
| `dots/linuxconfig/rofi/` | `~/.config/rofi/` |
| `dots/linuxconfig/opencode/` | `~/.config/opencode/` |

## [Neovim](https://neovim.io/)
Text Editor of choice
- Vim motions
- [Catppuccin](https://github.com/catppuccin/nvim) Theme
- [vim.pack](https://neovim.io/doc/user/pack.html#vim.pack) - Built-in plugin manager
- **UI & Appearance**
    - [Alpha](https://github.com/goolord/alpha-nvim) - Startup dashboard
    - [Catppuccin](https://github.com/catppuccin/nvim) - Colorscheme
    - [Highlight-Colors](https://github.com/brenoprata10/nvim-highlight-colors) - Inline color previews
    - [Lualine](https://github.com/nvim-lualine/lualine.nvim) - Status bar
    - [Dropbar](https://github.com/Bekaboo/dropbar.nvim) - Breadcrumb winbar
    - [Fidget](https://github.com/j-hui/fidget.nvim) - LSP progress spinner
    - [image.nvim](https://github.com/3rd/image.nvim) - Image rendering
    - [Rainbow Delimiters](https://gitlab.com/HiPhish/rainbow-delimiters.nvim) - Rainbow brackets
- **Editing**
    - [Autopairs](https://github.com/windwp/nvim-autopairs) - Auto-close brackets/quotes
    - [Autosave](https://github.com/okuuva/auto-save.nvim) - Auto-save on edit
    - [Surround](https://github.com/kylechui/nvim-surround) - Surround text objects
    - [Go-Up](https://github.com/nullromo/go-up.nvim) - Navigate up directories
- **Navigation**
    - [Telescope](https://github.com/nvim-telescope/telescope.nvim) - Fuzzy finder
        - [telescope-ui-select](https://github.com/nvim-telescope/telescope-ui-select.nvim) - Use Telescope for code actions
        - [telescope-fzf-native](https://github.com/nvim-telescope/telescope-fzf-native.nvim) - FZF sorter
    - [Oil](https://github.com/stevearc/oil.nvim) - File manager as a buffer
    - [nvim-jump](https://github.com/yorickpeterse/nvim-jump) - Jump between visible text
- **LSP & Completion**
    - [LSPConfig](https://github.com/neovim/nvim-lspconfig) - LSP server configs
    - [Lazydev](https://github.com/folke/lazydev.nvim) - Lua dev type hints
    - [lsp_lines](https://git.sr.ht/~whynothugo/lsp_lines.nvim) - Virtual line diagnostics
    - [nvim-cmp](https://github.com/hrsh7th/nvim-cmp) - Completion engine
        - [cmp-nvim-lsp](https://github.com/hrsh7th/cmp-nvim-lsp) - LSP completions
        - [cmp-buffer](https://github.com/hrsh7th/cmp-buffer) - Buffer completions
        - [cmp-path](https://github.com/hrsh7th/cmp-path) - Path completions
        - [cmp-cmdline](https://github.com/hrsh7th/cmp-cmdline) - Command-line completions
        - [cmp_luasnip](https://github.com/saadparwaiz1/cmp_luasnip) - Snippet completions
    - [LuaSnip](https://github.com/L3MON4D3/LuaSnip) - Snippet engine
        - [friendly-snippets](https://github.com/rafamadriz/friendly-snippets) - Snippet collection
        - [luasnip-latex-snippets](https://github.com/iurimateus/luasnip-latex-snippets.nvim) - LaTeX snippets
    - [Conform](https://github.com/stevearc/conform.nvim) - Formatting (stylua, prettier, latexindent, rustfmt, clang-format)
- **Git**
    - [Neogit](https://github.com/NeogitOrg/neogit) - Git interface
    - [Diffview](https://github.com/sindrets/diffview.nvim) - Diff viewer
- **Debugging**
    - [DAP](https://github.com/mfussenegger/nvim-dap) - Debug adapter protocol
    - [nvim-dap-ui](https://github.com/rcarriga/nvim-dap-ui) - Debug UI
    - [nvim-nio](https://github.com/nvim-neotest/nvim-nio) - Async IO for DAP
    - [Cortex](https://github.com/ronakpjain/cortex.nvim) - DAP views and embedded debugging
- **Markdown & LaTeX**
    - [render-markdown](https://github.com/MeanderingProgrammer/render-markdown.nvim) - Rendered Markdown previews
    - [mdmath](https://github.com/ronakpjain/mdmath.nvim) - LaTeX math rendering
    - [markdown-plus](https://github.com/yousefhadder/markdown-plus.nvim) - Markdown utilities
    - [pi-nvim](https://github.com/carderne/pi-nvim) - Pi coding-agent integration
- **Treesitter**
    - [nvim-treesitter](https://github.com/nvim-treesitter/nvim-treesitter) - Syntax highlighting & parsing
- **Misc**
    - [Teamtype](https://github.com/teamtype/teamtype-nvim) - Collaborative editing

## [Kitty](https://github.com/kovidgoyal/kitty)
Terminal emulator of choice
- [Catppuccin](https://github.com/catppuccin/kitty) Theme
- [Hack Nerd Font Mono](https://github.com/ryanoasis/nerd-fonts)
## [zsh](https://www.zsh.org/)
Shell of choice
- Syntax highlighting, autosuggestions, and interactive cd plugins.
- alanpeabody prompt
## [Yabai](https://github.com/koekeishiya/yabai)
Tiling window manager for MacOS
- I have disabled SIP which allows for workspaces
- Inactive windows are slightly transparent
## [MacOS](https://www.apple.com/macos/macos-sequoia/)
OS that comes with the best laptops
- Command -> Option (Alt in windowsland)
- Option -> Control (Ctrl in windowsland)
- Control -> Command (Windows key(?) in windowsland)
- Caps Lock -> Esc
## [skhd](https://github.com/koekeishiya/skhd)
Keybindings for yabai — see [keybinds.md](macconfig/yabai/keybinds.md) for full reference.
## [SketchyBar](https://github.com/FelixKratz/SketchyBar)
Status bar to take up awkward notch space
## [JankyBorders](https://github.com/FelixKratz/JankyBorders)
Borders around windows
- Orange - active windows
- Gray - inactive windows
## [Firefox](https://www.mozilla.org/en-US/firefox/)
Browser of choice
- [Catppuccin](https://github.com/catppuccin/firefox) Theme
- [Vimium](https://github.com/philc/vimium) - Vim motions in firefox
- [Dark Reader](https://github.com/darkreader/darkreader) - Turn any website into [catppuccin](https://github.com/catppuccin/dark-reader)
- [Stylus](https://github.com/openstyles/stylus) - Userstyles = [catppuccin](https://github.com/catppuccin/userstyles) for many common websites
- [UBlock Origin](https://github.com/gorhill/uBlock) - Adblocker that works
## ![Mofi](https://github.com/ironic1234/mofi)
- Spotlight replacement with theming
- (it's mine)

## [Hyprland](https://hyprland.org/)
Tiling Wayland compositor for Linux — see [keybinds.md](linuxconfig/hypr/keybinds.md) for full reference.
- [Catppuccin](https://github.com/catppuccin/hyprland) themed borders and styling
- Animated wallpaper via [awww](https://github.com/Sk7Str1d3r/awww)
- [hyprlock](https://github.com/hyprwm/hyprlock) for screen locking
- [hyprpaper](https://github.com/hyprwm/hyprpaper) for wallpaper management

## [Niri](https://github.com/YaLTeR/niri)
Scrollable tiling Wayland compositor — see [keybinds.md](linuxconfig/niri/keybinds.md) for full reference.
- Wallpaper via [swaybg](https://github.com/swaywm/swaybg)

## [Waybar](https://github.com/Alexays/Waybar)
Status bar for Wayland (used with both Hyprland and Niri)
- [Catppuccin](https://github.com/catppuccin/waybar) themed styling

## [Rofi](https://github.com/davatorium/rofi)
Application launcher for Wayland
- [Catppuccin Mocha](https://github.com/catppuccin/rofi) theme
