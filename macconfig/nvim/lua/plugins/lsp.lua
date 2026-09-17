vim.pack.add({
	"https://github.com/neovim/nvim-lspconfig",
	"https://github.com/folke/lazydev.nvim",
	"https://git.sr.ht/~whynothugo/lsp_lines.nvim",
	"https://github.com/Bilal2453/luvit-meta",
	"https://github.com/hrsh7th/cmp-nvim-lsp",
	"https://github.com/hrsh7th/cmp-buffer",
	"https://github.com/hrsh7th/cmp-path",
	"https://github.com/hrsh7th/cmp-cmdline",
	"https://github.com/saadparwaiz1/cmp_luasnip",
	"https://github.com/L3MON4D3/LuaSnip",
	"https://github.com/rafamadriz/friendly-snippets",
	"https://github.com/iurimateus/luasnip-latex-snippets.nvim",
	"https://github.com/hrsh7th/nvim-cmp",
	"https://github.com/stevearc/conform.nvim",
}, { confirm = false, load = true })

local servers = {
	"pylsp",
	"gopls",
	"texlab",
	"clangd",
	"svelte",
	"lua_ls",
	"rust_analyzer",
	"ty",
	"tsgo",
	"neocmake",
	"marksman",
	"verible",
}

local on_attach = function(client)
	local orig_floating_preview = vim.lsp.util.open_floating_preview

	---@diagnostic disable-next-line: duplicate-set-field
	vim.lsp.util.open_floating_preview = function(contents, syntax, opts, ...)
		opts = opts or {}
		opts.max_width = 80
		opts.max_height = 20
		return orig_floating_preview(contents, syntax, opts, ...)
	end

	vim.lsp.inlay_hint.enable(true)

	if client and client.name == "ty" then
		client.server_capabilities.completionProvider = nil
		client.server_capabilities.hoverProvider = false
		client.server_capabilities.signatureHelpProvider = false
		client.server_capabilities.definitionProvider = false
		client.server_capabilities.declarationProvider = false
		client.server_capabilities.referencesProvider = false
		client.server_capabilities.renameProvider = false
		client.server_capabilities.codeActionProvider = false
		client.server_capabilities.documentSymbolProvider = false
		client.server_capabilities.workspaceSymbolProvider = false
		client.server_capabilities.documentFormattingProvider = false
		client.server_capabilities.documentRangeFormattingProvider = false
	end
end

vim.diagnostic.config({
	virtual_text = false,
	virtual_lines = true,
})

if vim.g.ronak_lsp_user_commands_loaded ~= 1 then
	vim.g.ronak_lsp_user_commands_loaded = 1

	local lsp_subcommands = {
		"info",
		"clients",
		"restart",
		"stop",
		"hover",
		"definition",
		"references",
		"rename",
		"code_action",
		"format",
		"diag",
		"next",
		"prev",
		"log",
	}

	local function attached_clients(bufnr)
		return vim.lsp.get_clients({ bufnr = bufnr })
	end

	local function create_user_command(name, fn, opts)
		if vim.fn.exists(":" .. name) == 0 then
			vim.api.nvim_create_user_command(name, fn, opts)
		end
	end

	local function show_clients(bufnr)
		local clients = attached_clients(bufnr)
		if #clients == 0 then
			vim.notify("No LSP clients attached to this buffer", vim.log.levels.WARN)
			return
		end

		local lines = { "Attached LSP clients:" }
		for _, client in ipairs(clients) do
			lines[#lines + 1] = string.format("- %s (id=%d)", client.name, client.id)
		end
		vim.notify(table.concat(lines, "\n"), vim.log.levels.INFO)
	end

	local function restart_clients(bufnr)
		local clients = attached_clients(bufnr)
		if #clients == 0 then
			vim.notify("No LSP clients attached to restart", vim.log.levels.WARN)
			return
		end

		local names = {}
		for _, client in ipairs(clients) do
			names[client.name] = true
			client:stop(true)
		end

		vim.defer_fn(function()
			vim.cmd("edit")
			local restarted = vim.tbl_keys(names)
			table.sort(restarted)
			for _, name in ipairs(restarted) do
				pcall(vim.lsp.enable, name)
			end
			vim.notify("Restarted LSP: " .. table.concat(restarted, ", "), vim.log.levels.INFO)
		end, 100)
	end

	local actions = {
		info = function()
			if vim.fn.exists(":LspInfo") == 2 then
				vim.cmd("LspInfo")
			else
				show_clients(vim.api.nvim_get_current_buf())
			end
		end,
		clients = function()
			show_clients(vim.api.nvim_get_current_buf())
		end,
		restart = function()
			restart_clients(vim.api.nvim_get_current_buf())
		end,
		stop = function()
			local clients = attached_clients(vim.api.nvim_get_current_buf())
			for _, client in ipairs(clients) do
				client:stop(true)
			end
			vim.notify("Stopped " .. #clients .. " LSP client(s)", vim.log.levels.INFO)
		end,
		hover = function()
			vim.lsp.buf.hover()
		end,
		definition = function()
			vim.lsp.buf.definition()
		end,
		references = function()
			vim.lsp.buf.references()
		end,
		rename = function()
			vim.lsp.buf.rename()
		end,
		code_action = function()
			vim.lsp.buf.code_action()
		end,
		format = function()
			vim.lsp.buf.format({ async = true })
		end,
		diag = function()
			vim.diagnostic.open_float(nil, { focusable = false })
		end,
		next = function()
			vim.diagnostic.jump({ count = 1, float = true })
		end,
		prev = function()
			vim.diagnostic.jump({ count = -1, float = true })
		end,
		log = function()
			vim.cmd("edit " .. vim.lsp.log.get_filename())
		end,
	}

	create_user_command("Lsp", function(opts)
		local sub = opts.fargs[1] or "info"
		local action = actions[sub]
		if not action then
			vim.notify("Unknown Lsp subcommand: " .. sub, vim.log.levels.ERROR)
			vim.notify("Try: " .. table.concat(lsp_subcommands, ", "), vim.log.levels.INFO)
			return
		end
		action()
	end, {
		nargs = "*",
		desc = "LSP helper commands",
		complete = function(arglead)
			local matches = {}
			for _, cmd in ipairs(lsp_subcommands) do
				if cmd:sub(1, #arglead) == arglead then
					matches[#matches + 1] = cmd
				end
			end
			return matches
		end,
	})

	create_user_command("LspRestart", function()
		restart_clients(vim.api.nvim_get_current_buf())
	end, { desc = "Restart LSP clients for current buffer" })

	create_user_command("LspClients", function()
		show_clients(vim.api.nvim_get_current_buf())
	end, { desc = "Show LSP clients attached to current buffer" })
end

for _, server in ipairs(servers) do
	if server == "pylsp" then
		vim.lsp.config.pylsp = {
			on_attach = on_attach,
			settings = {
				pylsp = {
					plugins = {
						pyflakes = { enabled = false },
						pycodestyle = { enabled = false },
						mccabe = { enabled = false },
						pylint = { enabled = false },
						flake8 = { enabled = false },
						ruff = { enabled = false },
						autopep8 = { enabled = false },
						yapf = { enabled = false },
					},
				},
			},
		}
		vim.lsp.enable("pylsp")
	elseif server == "ty" then
		vim.lsp.config.ty = {
			on_attach = on_attach,
		}
		vim.lsp.enable("ty")
	elseif server == "lua_ls" then
		vim.lsp.config.lua_ls = {
			on_attach = on_attach,
			settings = {
				Lua = {
					hint = {
						enable = true,
						setType = true,
						paramType = true,
						paramName = "All",
						semicolon = "Disable",
						arrayIndex = "Enable",
					},
				},
			},
		}
		vim.lsp.enable("lua_ls")
	elseif server == "texlab" then
		vim.lsp.config.texlab = {
			on_attach = on_attach,
			settings = {
				texlab = {
					build = {
						executable = "latexmk",
						args = {
							"-synctex=1",
							"-interaction=nonstopmode",
							"-pdf",
							"%f",
						},
						onSave = true,
						forwardSearchAfter = true,
					},
					forwardSearch = {
						executable = "/usr/bin/open",
						args = {
							"-a",
							"Preview",
							"%p",
						},
					},
				},
			},
		}
		vim.lsp.enable("texlab")
	elseif server == "verible" then
		vim.lsp.config.verible = {
			on_attach = on_attach,
			cmd = {
				"verible-verilog-ls",
				"--flagfile=/Users/ronak/.verible-format.flags",
			},
		}
		vim.lsp.enable(server)
	else
		vim.lsp.config[server] = {
			on_attach = on_attach,
		}
		vim.lsp.enable(server)
	end
end

require("lazydev").setup({
	library = {
		{ path = "luvit-meta/library", words = { "vim%.uv" } },
	},
})

require("lsp_lines").setup({})

local cmp_autopairs = require("nvim-autopairs.completion.cmp")
local cmp = require("cmp")
cmp.event:on("confirm_done", cmp_autopairs.on_confirm_done())
cmp.setup({
	preselect = cmp.PreselectMode.None,
	snippet = {
		expand = function(args)
			require("luasnip").lsp_expand(args.body)
		end,
	},
	mapping = {
		["<C-b>"] = cmp.mapping(cmp.mapping.scroll_docs(-4), { "i", "c" }),
		["<C-f>"] = cmp.mapping(cmp.mapping.scroll_docs(4), { "i", "c" }),
		["<C-Space>"] = cmp.mapping(cmp.mapping.complete(), { "i", "c" }),
		["<C-e>"] = cmp.mapping({
			i = cmp.mapping.abort(),
			c = cmp.mapping.close(),
		}),
		["<CR>"] = cmp.mapping.confirm({ select = false }),
		["<Tab>"] = cmp.mapping(function(fallback)
			if cmp.visible() then
				cmp.select_next_item()
			elseif require("luasnip").expand_or_jumpable() then
				require("luasnip").expand_or_jump()
			else
				fallback()
			end
		end, { "i", "s" }),
		["<S-Tab>"] = cmp.mapping(function(fallback)
			if cmp.visible() then
				cmp.select_prev_item()
			elseif require("luasnip").jumpable(-1) then
				require("luasnip").jump(-1)
			else
				fallback()
			end
		end, { "i", "s" }),
	},
	window = {
		completion = cmp.config.window.bordered({
			border = "rounded",
		}),
		documentation = cmp.config.window.bordered({
			border = "rounded",
		}),
	},
	sources = cmp.config.sources({
		{ name = "copilot" },
		{ name = "nvim_lsp" },
		{ name = "luasnip" },
		{ name = "lazydev", group_index = 0 },
		{ name = "path" },
	}, {
		{ name = "buffer" },
	}),
})

require("luasnip.loaders.from_vscode").lazy_load()
require("luasnip-latex-snippets").setup({ use_treesitter = true })
require("luasnip").config.setup({ enable_autosnippets = true })

require("conform").setup({
	formatters_by_ft = {
		html = { "prettier" },
		lua = { "stylua" },
		css = { "prettier" },
		tex = { "latexindent" },
		htmldjango = { "prettier" },
		c = { "clang-format" },
		cpp = { "clang-format" },
		rust = { "rustfmt" },
		json = { "fixjson" },
	},
})

vim.api.nvim_create_user_command("Format", function(args)
	local range = nil
	if args.count ~= -1 then
		local end_line = vim.api.nvim_buf_get_lines(0, args.line2 - 1, args.line2, true)[1]
		range = {
			start = { args.line1, 0 },
			["end"] = { args.line2, end_line:len() },
		}
	end
	require("conform").format({ async = true, lsp_fallback = true, range = range })
end, { range = true })

vim.api.nvim_create_autocmd("BufWritePre", {
	pattern = "*",
	callback = function(args)
		require("conform").format({ bufnr = args.buf })
	end,
})
