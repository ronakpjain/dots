vim.pack.add(
	{ { src = "https://github.com/nvim-treesitter/nvim-treesitter", version = "main" } },
	{ confirm = false, load = true }
)

require("nvim-treesitter").setup({})

local ts_group = vim.api.nvim_create_augroup("DotfilesTreesitter", { clear = true })
vim.api.nvim_create_autocmd("FileType", {
	group = ts_group,
	callback = function()
		pcall(vim.treesitter.start)
	end,
})

vim.api.nvim_create_autocmd("PackChanged", {
	group = ts_group,
	callback = function(ev)
		if not ev.data or ev.data.kind == "delete" then
			return
		end

		local spec = ev.data.spec
		if not spec or spec.name ~= "nvim-treesitter" then
			return
		end

		pcall(vim.cmd, "TSUpdate")
	end,
})
