vim.pack.add(
	{ { src = "https://github.com/nvim-treesitter/nvim-treesitter", version = "main" } },
	{ confirm = false, load = true }
)

require("nvim-treesitter").setup({})

local ts_group = vim.api.nvim_create_augroup("DotfilesTreesitter", { clear = true })

-- Parsers the rest of this config relies on. Anything missing is installed.
local parsers = {
	"c",
	"cpp",
	"css",
	"diff",
	"gitcommit",
	"html",
	"javascript",
	"latex",
	"lua",
	"markdown",
	"markdown_inline",
	"python",
	"query",
	"scss",
	"svelte",
	"tsx",
	"typescript",
	"typst",
	"vim",
	"vimdoc",
	"yaml",
}

-- `:TSUpdate` skips a parser whose revision matches, even when its queries
-- link points at a removed plugin directory (this happened when the config
-- moved off lazy.nvim). A stale markdown query link silently disables the
-- html_block injection, so repair links before anything parses.
local function repair_queries()
	local uv = vim.uv or vim.loop
	local ok, install = pcall(require, "nvim-treesitter.install")
	if not (ok and install.get_package_path) then
		return
	end
	local queries_dir = vim.fs.joinpath(vim.fn.stdpath("data"), "site", "queries")
	local repaired = {}
	for _, lang in ipairs(require("nvim-treesitter.config").get_installed("parsers")) do
		local target = install.get_package_path("runtime", "queries", lang)
		if target and uv.fs_stat(target) then
			local link = vim.fs.joinpath(queries_dir, lang)
			local stat = uv.fs_lstat(link)
			-- Never touch real directories: those are copied queries, not links.
			if (not stat or stat.type == "link") and uv.fs_realpath(link) ~= uv.fs_realpath(target) then
				if stat then
					pcall(uv.fs_unlink, link)
				end
				if pcall(uv.fs_symlink, target, link, { dir = true }) then
					repaired[#repaired + 1] = lang
				end
			end
		end
	end
	if #repaired > 0 then
		vim.notify("treesitter: repaired stale query links: " .. table.concat(repaired, ", "), vim.log.levels.WARN)
	end
end

repair_queries()

local function install_missing()
	local installed = require("nvim-treesitter.config").get_installed("parsers")
	local missing = vim.tbl_filter(function(lang)
		return not vim.tbl_contains(installed, lang)
	end, parsers)
	if #missing > 0 then
		require("nvim-treesitter").install(missing, { summary = true })
	end
end

install_missing()

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