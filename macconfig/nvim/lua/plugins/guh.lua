-- guh.nvim: GitHub PRs/issues/CI inside Neovim (requires the `gh` CLI).
-- Needs Neovim 0.13+ for `vim.async`; on older builds it is registered but not loaded.
vim.pack.add({
	"https://github.com/justinmk/guh.nvim",
}, { confirm = false, load = vim.async ~= nil })

if vim.async == nil then
	vim.notify_once("guh.nvim requires Neovim 0.13+; skipping load.", vim.log.levels.WARN)
end
