vim.opt.number = true
vim.opt.relativenumber = true
vim.opt.numberwidth = 2
vim.opt.mouse = "a"
vim.opt.cursorline = true
vim.opt.cursorlineopt = "number"
vim.opt.ignorecase = true
vim.opt.smartcase = true
vim.opt.wrap = false
vim.opt.breakindent = true
vim.opt.tabstop = 4
vim.opt.shiftwidth = 4
vim.opt.showmode = false
vim.opt.laststatus = 3
vim.opt.expandtab = true
vim.opt.foldenable = false
vim.loader.enable()
vim.opt.clipboard:append("unnamedplus")
vim.opt.winborder = "rounded"

vim.g.have_nerd_font = true

-- Prefer the virtual environment created by setup-linux.sh when available.
local venv_python = vim.fn.expand("~/.venv/bin/python3")
if vim.fn.executable(venv_python) == 1 then
	vim.g.python3_host_prog = venv_python
end

vim.g.loaded_perl_provider = 0
