vim.pack.add({
	"https://github.com/nvim-telescope/telescope-fzf-native.nvim",
	"https://github.com/Bekaboo/dropbar.nvim",
}, { confirm = false, load = true })

local fzf_native_path = vim.fn.stdpath("data") .. "/site/pack/core/opt/telescope-fzf-native.nvim"
if
	vim.fn.executable("make") == 1
	and vim.uv.fs_stat(fzf_native_path)
	and not vim.uv.fs_stat(fzf_native_path .. "/build")
then
	vim.system({ "make" }, { cwd = fzf_native_path }):wait()
end
