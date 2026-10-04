vim.pack.add({ "https://github.com/3rd/image.nvim" }, { confirm = false, load = true })

require("image").setup({
	backend = "kitty",
	kitty_method = "normal",
	integrations = {},
})
