-- diffs.nvim: treesitter diff highlighting + `:Diff` unified/stacked/split views.
-- `vim.g.diffs` must be set before the plugin loads; the plugin lazy-loads itself.
vim.g.diffs = {
	view = { default_layout = "split" },
	integrations = { neogit = true },
}

vim.pack.add({
	"https://github.com/barrettruth/diffs.nvim",
}, { confirm = false, load = true })
