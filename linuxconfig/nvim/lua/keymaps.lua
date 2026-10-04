-- Leader defines
vim.g.mapleader = " "
vim.g.maplocalleader = " "

-- Telescope keymaps
vim.keymap.set("n", "<leader>ff", function()
	require("telescope.builtin").find_files()
end, { desc = "Telescope find files" })
vim.keymap.set("n", "<leader>fg", function()
	require("telescope.builtin").live_grep()
end, { desc = "Telescope live grep" })
vim.keymap.set("n", "<leader>fb", function()
	require("telescope.builtin").buffers()
end, { desc = "Telescope buffers" })
vim.keymap.set("n", "<leader>fh", function()
	require("telescope.builtin").help_tags()
end, { desc = "Telescope help tags" })

-- Oil keymap
vim.keymap.set("n", "<leader>fo", vim.cmd.Oil, { desc = "Open Oil file manager" })

-- Alpha keymap
vim.keymap.set("n", "<leader>fa", vim.cmd.Alpha, { desc = "Open Alpha dashboard" })

-- Go back to previous file
vim.keymap.set("n", "<leader>gb", "<Cmd>e#<CR>", { desc = "Go to previous buffer" })

-- DAP: Basic controls
vim.keymap.set("n", "<leader>bp", function()
	require("dap").toggle_breakpoint()
end, { desc = "Debug: Toggle breakpoint" })
vim.keymap.set("n", "<leader>bc", function()
	require("cortex").debug_start()
end, { desc = "Debug: Start/continue selected target" })
vim.keymap.set("n", "<leader>bd", function()
	require("cortex").debug_select()
end, { desc = "Debug: Select and remember target" })
vim.keymap.set("n", "<leader>ba", function()
	require("dap").pause()
end, { desc = "Debug: Pause" })
vim.keymap.set("n", "<leader>br", function()
	require("dap").restart()
end, { desc = "Debug: Restart" })
vim.keymap.set("n", "<leader>bt", function()
	require("dap").terminate()
end, { desc = "Debug: Terminate" })
vim.keymap.set("n", "<leader>bb", function()
	require("dap").set_breakpoint(vim.fn.input("Breakpoint condition: "))
end, { desc = "Debug: Set conditional breakpoint" })

-- DAP: Stepping
vim.keymap.set("n", "<leader>bs", function()
	require("dap").step_over()
end, { desc = "Debug: Step over" })
vim.keymap.set("n", "<leader>bi", function()
	require("dap").step_into()
end, { desc = "Debug: Step into" })
vim.keymap.set("n", "<leader>bo", function()
	require("dap").step_out()
end, { desc = "Debug: Step out" })
vim.keymap.set("n", "<leader>bx", function()
	require("dap").run_to_cursor()
end, { desc = "Debug: Run to cursor" })

-- DAP: REPL
vim.keymap.set("n", "<leader>brl", "<Cmd>CortexDebugBottomREPL<CR>", { desc = "Debug: Show REPL" })
vim.keymap.set("n", "<leader>brq", function()
	require("dap").repl.close()
end, { desc = "Debug: Close REPL" })

-- DAP: UI toggle
vim.keymap.set("n", "<leader>bu", function()
	require("dapui").toggle()
end, { desc = "Debug: Toggle UI" })

-- Cortex auxiliary views
vim.keymap.set("n", "<leader>cw", "<Cmd>CortexDebugWatch<CR>", { desc = "Cortex: Toggle live watch" })
vim.keymap.set("n", "<leader>cr", "<Cmd>CortexDebugBottomRTOS<CR>", { desc = "Cortex: Show FreeRTOS tasks" })
vim.keymap.set("n", "<leader>cs", "<Cmd>CortexDebugCallStack<CR>", { desc = "Cortex: Toggle call stack" })
vim.keymap.set("n", "<leader>cp", "<Cmd>CortexDebugPeripheral<CR>", { desc = "Cortex: Toggle peripherals" })

-- Dropbar
vim.keymap.set("n", "<leader>;", function()
	require("dropbar.api").pick()
end, { desc = "Dropbar: Pick symbols in winbar" })
vim.keymap.set("n", "[;", function()
	require("dropbar.api").goto_context_start()
end, { desc = "Dropbar: Go to start of current context" })
vim.keymap.set("n", "];", function()
	require("dropbar.api").select_next_context()
end, { desc = "Dropbar: Select next context" })

-- LSP
vim.keymap.set("n", "gd", function()
	vim.lsp.buf.definition()
end, { desc = "LSP: Go to definition" })

-- markdown-plus.nvim installs a buffer-local `gd` mapping for following links.
-- Marksman provides the same functionality, so remove only markdown-plus's
-- conflicting default and let the global LSP mapping above apply.
vim.api.nvim_create_autocmd("FileType", {
	pattern = { "markdown", "markdown.mdx" },
	callback = function(args)
		vim.api.nvim_buf_call(args.buf, function()
			local mapping = vim.fn.maparg("gd", "n", false, true)
			if mapping.buffer == 1 and mapping.rhs == "<Plug>(MarkdownPlusFollowLink)" then
				vim.keymap.del("n", "gd", { buffer = args.buf })
			end
		end)
	end,
})

vim.keymap.set("n", "gi", function()
	vim.lsp.buf.implementation()
end, { desc = "LSP: Go to implementation" })
vim.keymap.set("n", "gh", function()
	vim.lsp.buf.hover()
end, { desc = "LSP: Hover documentation" })
vim.keymap.set("n", "gD", function()
	vim.diagnostic.open_float()
end, { desc = "LSP: Open diagnostic float" })
vim.keymap.set("n", "gr", function()
	vim.lsp.buf.references()
end, { desc = "LSP: List references" })
vim.keymap.set("n", "ga", function()
	vim.lsp.buf.code_action()
end, { desc = "LSP: Code actions" })
vim.keymap.set("n", "<leader>l", function()
	vim.lsp.inlay_hint.enable(not vim.lsp.inlay_hint.is_enabled())
end, { desc = "LSP: Toggle inlay hints" })

-- Jump
vim.keymap.set({ "n", "x", "o" }, "<leader>s", require("jump").start, {})

-- pi-nvim
vim.keymap.set("n", "<leader>ai", ":Pi<CR>", { silent = true, desc = "Send to pi" })
vim.keymap.set("v", "<leader>ai", ":Pi<CR>", { silent = true, desc = "Send selection to pi" })
