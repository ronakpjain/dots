-- render-html.nvim: render inline HTML (GitHub bot comments) like render-markdown.
-- While developing locally the worktree is used directly; otherwise install it.
local dev = vim.fn.expand("~/coding/projects/render-html.nvim")
if vim.fn.isdirectory(dev) == 1 then
	vim.opt.rtp:prepend(dev)
else
	vim.pack.add({
		"https://github.com/ronakpjain/render-html.nvim",
	}, { confirm = false, load = true })
end

local ok, render_html = pcall(require, "render-html")
if ok then
	render_html.setup({ keymap = "<CR>" })
end
