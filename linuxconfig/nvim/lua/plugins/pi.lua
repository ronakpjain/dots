vim.pack.add({ "https://github.com/carderne/pi-nvim" }, { confirm = false, load = true })

require("pi-nvim").setup({
	-- Keep the existing <leader>ai mappings in keymaps.lua instead.
	set_default_keymaps = false,
})
