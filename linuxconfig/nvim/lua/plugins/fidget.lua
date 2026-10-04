vim.pack.add({ "https://github.com/j-hui/fidget.nvim" }, { confirm = false, load = true })
require("fidget").setup({
	notification = {
		override_vim_notify = true,
	},
})
