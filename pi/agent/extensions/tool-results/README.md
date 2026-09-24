# Shared tool-result presentation

`format.ts` and `render.ts` provide display-only helpers for local extension tools and the subagent UI. They never replace or mutate the result content passed to the agent/model.

- `formatToolOutput()` sanitizes terminal control sequences, classifies text/Markdown/code/JSON/lists, applies a UTF-8 byte cap, and exposes only allowlisted tool metadata (for example edit diffs and built-in search/read truncation details).
- `renderToolResult()` creates collapsed and expanded TUI views. Collapsed views show a sanitized preview capped at 1 KB and 8 lines, with an explicit expand hint; expanded views show bounded output. Tool arguments are not included in previews.
- `collapsedToolResultSummary()` gives compact subagent activity and transcript views a one-line, truncated output preview; expanded transcript views show the fuller result.
- Bash output is rendered as literal text (never parsed as Markdown); recognized shell scripts and Bash command calls use Pi's `highlightCode()`, which is Highlight.js-based and includes a Bash grammar. Arbitrary shell stdout is not mislabeled as Bash source.

Use the shared renderer in extension `renderResult` handlers and pass the original `result`, `options`, `theme`, and `context` through unchanged. Keep framework-rendered built-in tools on their existing renderers. When adding a summary, never interpolate tool arguments or unvalidated metadata; the separate output preview is sanitized and capped.

Formatting must remain display-only: do not rewrite tool output before it is stored or returned to the model.
