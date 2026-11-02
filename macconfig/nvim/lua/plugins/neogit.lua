vim.pack.add({
	"https://github.com/nvim-lua/plenary.nvim",
	"https://github.com/nvim-telescope/telescope.nvim",
	"https://github.com/NeogitOrg/neogit",
}, { confirm = false, load = true })

require("neogit").setup({ graph_style = "kitty" })
