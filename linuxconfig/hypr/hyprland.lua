---@diagnostic disable: undefined-global -- `hl` is provided by Hyprland.
-- Native Lua configuration for Hyprland 0.55+.
-- See keybinds.md for the shortcut reference.

-- Monitor
hl.monitor({ output = "", mode = "preferred", position = "auto", scale = 1 })

-- Programs
local terminal = "ghostty"
local menu = "rofi -show drun"
local mainMod = "ALT"

-- Autostart (only on compositor startup, not on reload)
hl.on("hyprland.start", function()
    hl.exec_cmd("awww-daemon & sleep 0.1 && awww img /home/ronak/Pictures/CatppuccinMocha-Kurzgesagt-BlackHole3.png")
    hl.exec_cmd("waybar")
end)

-- Environment
hl.env("XCURSOR_THEME", "MacOS-Tahoe")
hl.env("HYPRCURSOR_THEME", "MacOS-Tahoe")
hl.env("XCURSOR_SIZE", "24")
hl.env("HYPRCURSOR_SIZE", "24")
hl.env("LIBVA_DRIVER_NAME", "nvidia")
hl.env("__GLX_VENDOR_LIBRARY_NAME", "nvidia")

-- Appearance, layouts, and input
hl.config({
    general = {
        gaps_in = 5,
        gaps_out = 20,
        border_size = 2,
        col = {
            active_border = "rgba(fab387ff)",
            inactive_border = "rgba(575c7aff)",
        },
        resize_on_border = false,
        allow_tearing = false,
        layout = "dwindle",
    },
    decoration = {
        rounding = 10,
        rounding_power = 2,
        active_opacity = 1.0,
        inactive_opacity = 1.0,
        blur = { enabled = true, size = 10, passes = 1, vibrancy = 0.1696 },
    },
    animations = { enabled = true },
    dwindle = { preserve_split = true },
    master = { new_status = "master" },
    misc = { force_default_wallpaper = -1, disable_hyprland_logo = false },
    input = {
        kb_layout = "us",
        kb_options = "caps:escape",
        follow_mouse = 1,
        sensitivity = 0,
        touchpad = { natural_scroll = true, clickfinger_behavior = 1 },
    },
})

-- Animation curves and timing
hl.curve("easeOutQuint", { type = "bezier", points = { { 0.23, 1 }, { 0.32, 1 } } })
hl.curve("easeInOutCubic", { type = "bezier", points = { { 0.65, 0.05 }, { 0.36, 1 } } })
hl.curve("linear", { type = "bezier", points = { { 0, 0 }, { 1, 1 } } })
hl.curve("almostLinear", { type = "bezier", points = { { 0.5, 0.5 }, { 0.75, 1 } } })
hl.curve("quick", { type = "bezier", points = { { 0.15, 0 }, { 0.1, 1 } } })

local animations = {
    { "global", 10, "default" },
    { "border", 5.39, "easeOutQuint" },
    { "windows", 4.79, "easeOutQuint" },
    { "windowsIn", 4.1, "easeOutQuint", "popin 87%" },
    { "windowsOut", 1.49, "linear", "popin 87%" },
    { "fadeIn", 1.73, "almostLinear" },
    { "fadeOut", 1.46, "almostLinear" },
    { "fade", 3.03, "quick" },
    { "layers", 3.81, "easeOutQuint" },
    { "layersIn", 4, "easeOutQuint", "fade" },
    { "layersOut", 1.5, "linear", "fade" },
    { "fadeLayersIn", 1.79, "almostLinear" },
    { "fadeLayersOut", 1.39, "almostLinear" },
    { "workspaces", 1.94, "almostLinear", "fade" },
    { "workspacesIn", 1.21, "almostLinear", "fade" },
    { "workspacesOut", 1.94, "almostLinear", "fade" },
    { "zoomFactor", 7, "quick" },
}
for _, animation in ipairs(animations) do
    hl.animation({
        leaf = animation[1], enabled = true, speed = animation[2],
        bezier = animation[3], style = animation[4],
    })
end

hl.gesture({ fingers = 3, direction = "horizontal", action = "workspace" })
hl.device({ name = "epic-mouse-v1", sensitivity = -0.5 })

-- Spawn / apps
hl.bind(mainMod .. " + K", hl.dsp.exec_cmd(terminal))
hl.bind(mainMod .. " + R", hl.dsp.exec_cmd(menu))
hl.bind(mainMod .. " + A", hl.dsp.exec_cmd("wl-kbptr -o modes=floating,click -o mode_floating.source=detect"))

-- Window management
hl.bind(mainMod .. " + Q", hl.dsp.window.close())
hl.bind(mainMod .. " + W", hl.dsp.send_shortcut({ mods = "CONTROL", key = "W" }))
hl.bind(mainMod .. " + V", hl.dsp.window.float({ action = "toggle" }))
hl.bind(mainMod .. " + F", hl.dsp.window.fullscreen({ mode = "maximized" }))
hl.bind(mainMod .. " + SHIFT + F", hl.dsp.window.fullscreen({ mode = "fullscreen" }))

-- Focus
for _, direction in ipairs({ "left", "right", "up", "down" }) do
    hl.bind(mainMod .. " + " .. direction, hl.dsp.focus({ direction = direction }))
end

-- Workspaces: workspace 10 uses key 0.
for workspace = 1, 10 do
    local key = workspace % 10
    hl.bind(mainMod .. " + " .. key, hl.dsp.focus({ workspace = workspace }))
    hl.bind(mainMod .. " + SHIFT + " .. key, hl.dsp.window.move({ workspace = workspace }))
end
hl.bind(mainMod .. " + S", hl.dsp.workspace.toggle_special("magic"))
hl.bind(mainMod .. " + SHIFT + S", hl.dsp.window.move({ workspace = "special:magic" }))
hl.bind(mainMod .. " + mouse_down", hl.dsp.focus({ workspace = "e+1" }))
hl.bind(mainMod .. " + mouse_up", hl.dsp.focus({ workspace = "e-1" }))

-- Lock and mouse dragging
hl.bind(mainMod .. " + L", hl.dsp.exec_cmd("hyprlock"))
hl.bind(mainMod .. " + mouse:272", hl.dsp.window.drag(), { mouse = true })
hl.bind(mainMod .. " + mouse:273", hl.dsp.window.resize(), { mouse = true })

-- System
hl.bind(mainMod .. " + M", hl.dsp.exit())
hl.bind(mainMod .. " + O", hl.dsp.exec_cmd("shutdown now"))

-- Media keys (available while locked; volume and brightness repeat)
local repeatingMedia = {
    { "XF86AudioRaiseVolume", "wpctl set-volume -l 1 @DEFAULT_AUDIO_SINK@ 5%+" },
    { "XF86AudioLowerVolume", "wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-" },
    { "XF86AudioMute", "wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle" },
    { "XF86AudioMicMute", "wpctl set-mute @DEFAULT_AUDIO_SOURCE@ toggle" },
    { "XF86MonBrightnessUp", "brightnessctl -e4 -n2 set 5%+" },
    { "XF86MonBrightnessDown", "brightnessctl -e4 -n2 set 5%-" },
}
for _, binding in ipairs(repeatingMedia) do
    hl.bind(binding[1], hl.dsp.exec_cmd(binding[2]), { locked = true, repeating = true })
end
local media = {
    { "XF86AudioNext", "playerctl next" },
    { "XF86AudioPause", "playerctl play-pause" },
    { "XF86AudioPlay", "playerctl play-pause" },
    { "XF86AudioPrev", "playerctl previous" },
}
for _, binding in ipairs(media) do
    hl.bind(binding[1], hl.dsp.exec_cmd(binding[2]), { locked = true })
end

-- Screenshot
hl.bind("SUPER + SHIFT + S", hl.dsp.exec_cmd('grim -g "$(slurp -w 0)" - | wl-copy'))

-- Window rules
hl.window_rule({
    name = "suppress-maximize-events",
    match = { class = ".*" },
    suppress_event = "maximize",
})
hl.window_rule({
    name = "fix-xwayland-drags",
    match = {
        class = "^$", title = "^$", xwayland = true,
        float = true, fullscreen = false, pin = false,
    },
    no_focus = true,
})
