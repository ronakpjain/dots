-- diffs.nvim: treesitter diff highlighting + `:Diff` unified/stacked/split views.
-- `vim.g.diffs` must be set before the plugin loads; the plugin lazy-loads itself.
vim.g.diffs = {
	view = { default_layout = "unified" },
	integrations = { neogit = true },
}

vim.pack.add({
	"https://github.com/barrettruth/diffs.nvim",
}, { confirm = false, load = true })

-- Like `:Diff`, but open the generated diff in its own tab as a single window
-- (e.g. `:DiffTab`, `:DiffTab ++layout=stacked`, `:DiffTab ++layout=split`).
vim.api.nvim_create_user_command("DiffTab", function(args)
	vim.cmd("tab split")
	vim.cmd(args.args ~= "" and ("Diff " .. args.args) or "Diff")
	local cur = vim.api.nvim_get_current_win()
	local name = vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(cur))
	if not name:match("^diffs://") then
		vim.cmd("tabclose") -- nothing changed; drop the throwaway tab
		return
	end
	if name:match("^diffs://split:") then
		return -- paired layout keeps its two windows in the new tab
	end
	for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
		if win ~= cur then
			vim.api.nvim_win_close(win, true) -- generated layout: single window in the tab
		end
	end
end, { nargs = "*", bar = true, desc = "Open a diff in a new tab (unified by default)" })
