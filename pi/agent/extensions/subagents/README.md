# Subagents extension

Robust subagent orchestration for pi: an orchestrator (the main agent) can spin
up, monitor, and prompt subagents of **arbitrary models**, each with **its own
isolated context window** — all **in-process** (no extra `pi` processes are
spawned).

## Why in-process?

Each subagent is a separate `Agent` instance from `@earendil-works/pi-agent-core`
with its own transcript. The parent session keeps running as usual. Because no
child processes are spawned:

- Subagents cost almost no extra CPU/memory overhead.
- There are no orphaned processes to clean up on abort or crash.
- `parallelLimit > 1` just interleaves in-process agents on the event loop;
  the default is still sequential (`parallelLimit: 1`) to keep behavior
  predictable.

## Work modes

The separate `work-mode` extension controls when this tool is available:

- `/mode orchestration` pins the main session to Sol/low and strongly directs it
  to delegate through subagents.
- `/mode build` leaves the current model alone and blocks subagent launches.

The subagent extension remains responsible only for subagent execution and
monitoring; mode enforcement lives in `agent/extensions/work-mode/`.

## Usage

The `subagent` tool is available to the main agent with three modes:

| Field           | Type              | Description                                                                                                                                                                                                                                                |
| --------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task`          | string            | Task text (single mode)                                                                                                                                                                                                                                    |
| `tasks`         | array             | Independent tasks, run sequentially by default (parallel mode; `parallelLimit` opt-in)                                                                                                                                                                     |
| `chain`         | array             | Ordered tasks; `{previous}` in a task text is replaced with the previous result (chain mode)                                                                                                                                                               |
| `model`         | string            | Arbitrary model: `"provider/id"`, `"provider/*"`, or bare id — validated against the model registry before running                                                                                                                                         |
| `agent`         | string            | Agent definition name (from agent files)                                                                                                                                                                                                                   |
| `systemPrompt`  | string            | Inline system prompt (overrides agent prompt)                                                                                                                                                                                                              |
| `tools`         | array             | Tool allowlist (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`)                                                                                                                                                                                     |
| `thinking`      | string            | Reasoning level for the subagent model: `off` (default — cheap & fast), `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (model-dependent). Raise it for harder tasks that benefit from reasoning; the level is passed straight through to the provider. |
| `timeoutSec`    | number            | Abort the subagent after N seconds                                                                                                                                                                                                                         |
| `maxTurns`      | number            | Assistant-turn budget; the runner reserves one finalization turn at the boundary                                                                                                                                                                           |
| `cwd`           | string            | Working directory for the subagent                                                                                                                                                                                                                         |
| `parallelLimit` | number            | Maximum concurrent tasks in parallel mode (1–8)                                                                                                                                                                                                            |
| `onFailure`     | `stop`/`continue` | Chain policy; default `stop`, use `continue` only for recoverable best-effort pipelines                                                                                                                                                                    |
| `keepSession`   | bool              | Return a `sessionId` to continue this context window later                                                                                                                                                                                                 |
| `sessionId`     | string            | Continue an existing context window (from a prior `keepSession`)                                                                                                                                                                                           |
| `background`    | bool              | Return immediately while the group runs; use `subagent_status` and `subagent_wait` to monitor and collect results                                                                                                                                          |

### Background execution

Set `background: true` on a single, parallel, or chain request to return immediately while the group continues in-process. The result includes a group id. Continue independent work in the main session, then use:

- `subagent_status` — inspect active or completed groups;
- `subagent_wait` — wait for one group and collect its final output (a timeout does not cancel it).

Background groups are canceled when the session shuts down. The default remains synchronous when `background` is omitted.

### Multi-turn sessions

Subagents are stateless by default. To make one remember across calls:

1. Call with `keepSession: true`; the result includes a line like
   `[Session: <uuid> — pass as sessionId to continue this context window]`.
2. Later, call again with that `sessionId` — the same in-process agent
   continues its transcript, so it remembers everything from the earlier run.

### Budgets and recovery

- `timeoutSec`: aborts the subagent after N seconds (honored even mid-stream).
- `maxTurns`: bounds tool loops per invocation. At the boundary the runner allows one explicit finalization turn; if the model still requests tools, the result includes the partial transcript and remains resumable when `keepSession` was enabled.
- Parent abort (Ctrl+C / goal-mode interrupt) propagates to synchronous subagent calls; background groups continue until completion or session shutdown.
- Prefer a larger budget for implementation/review work than for scouting. Do not set an artificially low budget just to make a task look bounded.

## Agent files

- User agents: `<agentDir>/agents/*.md`
- Project agents (opt-in, trusted repos only): `.pi/agents/*.md`

Frontmatter keys: `name`, `description`, `model`, `tools`, `thinking`,
`timeoutSec`, `maxTurns`. See the bundled samples (`scout`, `planner`,
`worker`, `reviewer`) in `agent/agents/`. The reusable orchestration playbook is
`agent/skills/subagent-orchestration/SKILL.md`.

### Bundled profile policy

The named bundled agents have runtime-enforced controls:

| Agent      | Model                       | Thinking | Tools                                   | Timeout / turns |
| ---------- | --------------------------- | -------: | --------------------------------------- | --------------: |
| `planner`  | `openai-codex/gpt-5.6-sol`  | `medium` | read, grep, find, ls                    |       240s / 18 |
| `reviewer` | `openai-codex/gpt-5.6-sol`  |    `low` | read, grep, find, ls, bash              |       240s / 22 |
| `scout`    | `openai-codex/gpt-5.6-luna` | `medium` | read, grep, find, ls, bash              |       180s / 18 |
| `worker`   | `openai-codex/gpt-5.6-luna` |  `xhigh` | read, bash, edit, write, grep, find, ls |       600s / 40 |

Their model, thinking level, tool allowlist, and budgets cannot be overridden
by request fields. Inline and other custom agents remain configurable.

## Orchestrator pattern (strong planner + cheap workers)

Run the main pi session on your strongest model and delegate heavy or parallelizable
work to cheap worker models via `subagent`:

- Decompose broad work into focused tasks with explicit expected outputs. A reliable
  default is scout/planner → focused worker → reviewer.
- Use `tasks` plus `parallelLimit: 2-4` for independent research. Use `chain` and
  `{previous}` for dependent phases. Avoid overlapping mutations in parallel tasks.
- Set `onFailure: "continue"` only when a later chain step can recover from partial
  evidence; otherwise let the default stop policy surface the failure.
- Use `keepSession: true` for work that may need follow-up. If a result includes a
  `[Session: ...]` handle, resume that context with `sessionId` and a narrower task.
- Choose `maxTurns`/`timeoutSec` from task complexity and inspect every result status;
  a partial result is not completion.
- Every session's system prompt includes these orchestration controls and the live
  cheapest configured model catalog, so the planner can choose workers deliberately.
  In orchestration mode, the full `subagent-orchestration` skill is also loaded
  before each task so context-rich handoff rules are available before delegation.
- `/subagents` opens a live browser showing per-run cost, activity, and transcripts.

## Monitoring & inspection

### Live visibility while runs happen

- Every run is persisted with `pi.appendEntry("subagent-run", …)` plus a
  `"subagent-run-detail"` entry carrying the full per-run transcript
  (truncated) for later inspection.
- While a `subagent` tool call is executing, the tool result is **streamed**:
  a throttled live dashboard (running status, thinking previews, tool calls and
  their results, usage) is pushed via `onUpdate`, so the TUI shows subagents
  working in real time instead of a frozen spinner.
- `index.ts` keeps an in-memory registry of live runs merged with persisted
  entries, so the browser works during and after runs (even across extension
  reloads within the session).

### Persistent token accounting

Each completed in-process subagent publishes its aggregate token usage to the
`token-tracker` extension. The `/tokens` command combines those records with
main-session, tool, and compaction usage in a global append-only log, so reports
can span sessions and arbitrary date ranges. Subagent turns are retained as
individual API-call counts even though `/subagents` displays one run.

### `/subagents` browser

In the TUI, `/subagents` opens a full-screen overlay (Esc to close) drawn as a
real box: `╭─╮`/`╰─╯` corners and `│` side rails in the theme border color, on
a darker-than-session panel fill (mantle), so it stays clearly separated from
the session output behind it. The selected run row is highlighted with
`selectedBg`:

- **List view** — every run in the session (live first, then newest first),
  with status (running/ok/error), model, elapsed time, and usage. Navigate
  with `↑/↓` (`j`/`k`), page with `PgUp/PgDn`; `Enter` (or `l`) opens a run.
- **Detail view** — per-run transcript: streamed thinking, tool calls with
  their arguments, tool results (with errors highlighted), the final output,
  and usage. Prose (thinking/text) wraps to the panel width; code rows (tool
  arguments, tool output) keep full width and scroll horizontally with
  `←/→` (`h`/`l`) — the footer shows the column offset. Scroll vertically
  with `↑/↓`; `g`/`G` jump to top/bottom; `Backspace` returns to the list;
  Esc closes. Live runs refresh automatically.
- An optional filter argument (`/subagents <agent-or-model>` ) narrows the
  list.
- In non-TUI modes (print/RPC), `/subagents` falls back to a plain-text
  widget listing the most recent runs.

When the tool finishes, `renderResult` renders the final per-run results
(expanded view shows the full transcript inline; collapsed shows the final
output with a `Ctrl+O` hint).

## Development

- `runner.ts` — `runSubagent()`: resolves model/provider/auth, builds the
  in-process agent with a minimal mock extension context for the built-in
  tools, watchdogs, session cache, usage accumulation, and a throttled live
  event stream (`RunnerEvent`: `message`, `tool`, `toolResult`, `thinking`,
  `status`) consumed by `index.ts` for the dashboard/browser.
- `ui.ts` — TUI building blocks: `renderLiveDashboard` (streamed while
  running), `renderRunResults` (final view), and the interactive
  `SubagentsBrowser` overlay used by `/subagents`.
- `agents.ts` — agent discovery + frontmatter parsing.
- `index.ts` — tool registration, live-run registry, `/subagents` command,
  TUI renderers.
- Deterministic tests (stub provider, no network): `bun test
/tmp/subagent-tests/runner-inproc.test.ts` (compile `runner.ts` into
  `/tmp/subagent-tests/dist` first via `tsconfig.subagents.emit.json`, since
  Bun resolves bare specifiers from the test file's directory).
