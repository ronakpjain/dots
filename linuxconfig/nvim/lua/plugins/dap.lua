local dap_plugins = {
	"https://github.com/nvim-neotest/nvim-nio",
	"https://github.com/rcarriga/nvim-dap-ui",
	"https://github.com/mfussenegger/nvim-dap",
	"https://github.com/ronakpjain/cortex.nvim",
}

vim.pack.add(dap_plugins, { confirm = false, load = true })

local dap = require("dap")
local cortex = require("cortex")
cortex.setup({
	rtos = {
		enabled = true,
		auto_open = true,
		auto_refresh_on_stop = true,
	},
	callstack = {
		auto_open = true,
		auto_refresh_on_stop = true,
	},
})

dap.adapters["lldb-dap"] = {
	type = "executable",
	command = vim.fn.exepath("lldb-dap"),
}

dap.configurations.cpp = {
	{
		name = "Launch File",
		type = "lldb-dap",
		request = "launch",
		program = function()
			return vim.fn.input("Path to executable: ", vim.fn.getcwd() .. "/", "file")
		end,
		cwd = "${workspaceFolder}",
		args = function()
			local input = vim.fn.input("Arguments: ")
			return vim.fn.split(input, " ", true)
		end,
		stopOnEntry = false,
	},
}

dap.configurations.c = dap.configurations.cpp

dap.adapters.python = {
	type = "executable",
	command = vim.fn.getenv("VIRTUAL_ENV") and (vim.fn.getenv("VIRTUAL_ENV") .. "/bin/python")
		or vim.fn.exepath("python3"),
	args = { "-m", "debugpy.adapter" },
}

dap.configurations.python = {
	{
		type = "python",
		request = "launch",
		name = "Launch Python File",
		program = "${file}",
		pythonPath = function()
			local venv = os.getenv("VIRTUAL_ENV")
			if venv then
				return venv .. "/bin/python"
			end

			return vim.fn.exepath("python3") or "python3"
		end,
	},
}

-- Keep DAP breakpoints visually distinct from ordinary signs.
vim.api.nvim_set_hl(0, "DapBreakpoint", { fg = "#f7768e" })
vim.api.nvim_set_hl(0, "DapBreakpointCondition", { fg = "#f7768e" })
vim.api.nvim_set_hl(0, "DapBreakpointRejected", { fg = "#f7768e" })
for _, name in ipairs({ "DapBreakpoint", "DapBreakpointCondition", "DapBreakpointRejected" }) do
	vim.fn.sign_define(name, { text = "●", texthl = name, linehl = "", numhl = "" })
end

local dapui = require("dapui")
-- Replace the generic stacks pane (which is mostly the GDB "Remote target")
-- with Cortex's current-thread stack. The bottom tray is a single slot; its
-- RTOS, REPL, and Console buffers are switched instead of being squeezed into
-- three narrow splits.
dapui.register_element("cortex_callstack", cortex.callstack_element())
dapui.register_element("cortex_rtos", cortex.rtos_element())
dapui.register_element("cortex_peripherals", cortex.peripheral_element())

local bottom_tabs = {
	items = {
		{ id = "cortex_rtos", label = "RTOS" },
		{ id = "repl", label = "REPL" },
		{ id = "console", label = "Console" },
	},
	index = 1,
	mapped = {},
	fallback_buf = nil,
}

local function bottom_fallback_buffer()
	if bottom_tabs.fallback_buf and vim.api.nvim_buf_is_valid(bottom_tabs.fallback_buf) then
		return bottom_tabs.fallback_buf
	end
	bottom_tabs.fallback_buf = vim.api.nvim_create_buf(false, true)
	vim.bo[bottom_tabs.fallback_buf].buftype = "nofile"
	vim.bo[bottom_tabs.fallback_buf].bufhidden = "hide"
	vim.bo[bottom_tabs.fallback_buf].swapfile = false
	return bottom_tabs.fallback_buf
end

local function bottom_current()
	return bottom_tabs.items[bottom_tabs.index]
end

local function bottom_window()
	local ok, windows = pcall(require, "dapui.windows")
	local layout = ok and windows.layouts[2]
	if not layout or not layout.opened_wins then
		return nil
	end
	for _, winid in ipairs(layout.opened_wins) do
		if vim.api.nvim_win_is_valid(winid) then
			return winid
		end
	end
	return nil
end

local function bottom_winbar()
	local labels = {}
	for index, item in ipairs(bottom_tabs.items) do
		labels[#labels + 1] = index == bottom_tabs.index and ("[ " .. item.label .. " ]")
			or ("  " .. item.label .. "  ")
	end
	local text = table.concat(labels, "   ")
	local winid = bottom_window()
	local width = winid and vim.api.nvim_win_get_width(winid) or 80
	if vim.fn.strdisplaywidth(text) > width then
		text = vim.fn.strcharpart(text, 0, math.max(1, width - 1)) .. "…"
	end
	return text
end

local function map_bottom_buffer(bufnr)
	if bottom_tabs.mapped[bufnr] or not vim.api.nvim_buf_is_valid(bufnr) then
		return
	end
	bottom_tabs.mapped[bufnr] = true
	vim.keymap.set("n", "<Tab>", function()
		bottom_tabs.select(bottom_tabs.index + 1)
	end, { buffer = bufnr, nowait = true, silent = true, desc = "Debug: Next bottom pane" })
	vim.keymap.set("n", "<S-Tab>", function()
		bottom_tabs.select(bottom_tabs.index - 1)
	end, { buffer = bufnr, nowait = true, silent = true, desc = "Debug: Previous bottom pane" })
end

function bottom_tabs.buffer()
	local item = bottom_current()
	local element = dapui.elements[item.id]
	if element and element.buffer then
		local bufnr = element.buffer()
		map_bottom_buffer(bufnr)
		return bufnr
	end
	return bottom_fallback_buffer()
end

function bottom_tabs.render()
	local item = bottom_current()
	local element = dapui.elements[item.id]
	if element and element.render then
		element.render()
	end
end

function bottom_tabs.select(index)
	if index < 1 then
		index = #bottom_tabs.items
	elseif index > #bottom_tabs.items then
		index = 1
	end
	bottom_tabs.index = index
	local bufnr = bottom_tabs.buffer()
	bottom_tabs.render()
	local winid = bottom_window()
	if winid and vim.api.nvim_buf_is_valid(bufnr) then
		vim.api.nvim_win_set_buf(winid, bufnr)
		-- Re-render after the buffer is in the real window so responsive Cortex
		-- columns use the actual bottom-pane width, not the setup fallback.
		bottom_tabs.render()
		vim.api.nvim_win_set_option(winid, "winbar", bottom_winbar())
	end
end

function bottom_tabs.next()
	bottom_tabs.select(bottom_tabs.index + 1)
end

function bottom_tabs.previous()
	bottom_tabs.select(bottom_tabs.index - 1)
end

dapui.register_element("cortex_bottom", {
	buffer = bottom_tabs.buffer,
	render = bottom_tabs.render,
	allow_without_session = true,
})

dapui.setup({
	layouts = {
		{
			elements = {
				{ id = "scopes", size = 0.24 },
				{ id = "breakpoints", size = 0.16 },
				{ id = "cortex_callstack", size = 0.30 },
				{ id = "cortex_peripherals", size = 0.30 },
			},
			size = 42,
			position = "left",
		},
		{
			elements = {
				{ id = "cortex_bottom", size = 1.0 },
			},
			size = 14,
			position = "bottom",
		},
	},
})

vim.keymap.set("n", "<leader>bn", bottom_tabs.next, { desc = "Debug: Next bottom pane" })
vim.keymap.set("n", "<leader>bN", bottom_tabs.previous, { desc = "Debug: Previous bottom pane" })
for index, item in ipairs(bottom_tabs.items) do
	vim.keymap.set("n", "<leader>b" .. index, function()
		bottom_tabs.select(index)
	end, { desc = "Debug: Show " .. item.label })
end
vim.api.nvim_create_user_command("CortexDebugBottomNext", bottom_tabs.next, {})
vim.api.nvim_create_user_command("CortexDebugBottomPrevious", bottom_tabs.previous, {})
for index, item in ipairs(bottom_tabs.items) do
	vim.api.nvim_create_user_command("CortexDebugBottom" .. item.label, function()
		bottom_tabs.select(index)
	end, {})
end

-- Explicitly focus DAP-UI panes on a mouse click. This complements the
-- element-specific click actions supplied by cortex.nvim.
local dapui_mouse_group = vim.api.nvim_create_augroup("CortexDapUiMouse", { clear = true })
vim.api.nvim_create_autocmd("FileType", {
	group = dapui_mouse_group,
	pattern = { "dapui_*", "dap-repl" },
	callback = function(args)
		vim.keymap.set("n", "<LeftMouse>", function()
			local position = vim.fn.getmousepos()
			local winid = tonumber(position.winid)
			if winid and winid > 0 and vim.api.nvim_win_is_valid(winid) then
				vim.api.nvim_set_current_win(winid)
				local line = tonumber(position.line)
				if line and line > 0 then
					pcall(
						vim.api.nvim_win_set_cursor,
						winid,
						{ line, math.max(0, (tonumber(position.column) or 1) - 1) }
					)
				end
			end
		end, { buffer = args.buf, nowait = true, silent = true })
	end,
})

-- nvim-dap-ui has no close event. Wrap its public lifecycle functions so
-- Cortex windows follow the UI when it is closed manually as well as when a
-- session terminates. No dap-ui fork is required.
local dapui_open = false
local dapui_open_raw = dapui.open
local dapui_close_raw = dapui.close
local dapui_toggle_raw = dapui.toggle

dapui.open = function(args)
	dapui_open = true
	local result = dapui_open_raw(args)
	bottom_tabs.select(bottom_tabs.index)
	return result
end

dapui.close = function(args)
	local result = dapui_close_raw(args)
	dapui_open = false
	cortex.close_views()
	return result
end

dapui.toggle = function(args)
	local was_open = dapui_open
	local result = dapui_toggle_raw(args)
	if was_open then
		dapui_open = false
		cortex.close_views()
	else
		dapui_open = true
		bottom_tabs.select(bottom_tabs.index)
	end
	return result
end

dap.listeners.after.event_initialized["dapui_config"] = function()
	dapui.open()
end
dap.listeners.before.event_terminated["dapui_config"] = function()
	dapui.close()
end
dap.listeners.before.event_exited["dapui_config"] = function()
	dapui.close()
end
