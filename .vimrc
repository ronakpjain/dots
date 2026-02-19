set number
set relativenumber
set numberwidth=2

set cursorline

set ignorecase
set smartcase

set wrap
set breakindent

set tabstop=4
set shiftwidth=4
set expandtab

syntax on

call plug#begin()
  
Plug 'vhda/verilog_systemverilog.vim'

Plug '907th/vim-auto-save'
Plug 'jiangmiao/auto-pairs'
 
call plug#end()

set termguicolors
colorscheme catppuccin_mocha

let g:auto_save = 1  " enable AutoSave on Vim startup
