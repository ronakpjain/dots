vim.pack.add({
	{ src = "https://github.com/nvim-treesitter/nvim-treesitter", version = "main" },
	"https://github.com/nvim-tree/nvim-web-devicons",
	"https://github.com/MeanderingProgrammer/render-markdown.nvim",
	"https://github.com/ronakpjain/mdmath.nvim",
	"https://github.com/yousefhadder/markdown-plus.nvim",
}, { confirm = false, load = true })

require("render-markdown").setup({
	file_types = { "markdown", "pi" },
})
require("mdmath").setup({})

local ok, markdown_plus = pcall(require, "markdown-plus")
if ok and type(markdown_plus.setup) == "function" then
	markdown_plus.setup({})
end
