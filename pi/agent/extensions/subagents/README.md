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

## Usage

The `subagent` tool is available to the main agent at all times, with three modes:

| Field           | Type              | Description                                                                                                                                                                                                                                                |
| --------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task`          | string            | Task text (single mode)                                                                                                                                                                                                                                    |
| `tasks`         | array             | Independent tasks, run sequentially by default (parallel mode; `parallelLimit` opt-in)                                                                                                                                                                     |
| `chain`         | array             | Ordered tasks; `{previous}` in a task text is replaced with the previous result (chain mode)                                                                                                                                                               |
| `model`         | string            | Arbitrary model: `"provider/id"`, `"provider/*"`, or bare id — validated against the model registry before running. Overridden by your choice for this subagent type unless that choice is `auto`. Native OpenAI models whose id/name contains `luna` always use priority fast mode.                                                                                                                                         |
| `agent`         | string            | Agent definition name (from agent files)                                                                                                                                                                                                                   |
| `systemPrompt`  | string            | Inline system prompt (overrides agent prompt)                                                                                                                                                                                                              |
| `tools`         | array             | Tool allowlist (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`)                                                                                                                                                                                     |
| `thinking`      | string            | Reasoning level for the subagent model: `off` (default — cheap & fast), `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (model-dependent). Overridden by your choice for this subagent type unless that choice is `auto`. |
| `timeoutSec`    | number            | Hard deadline in seconds (default 600; increase for longer tasks)                                                                                                                                                                                                                         |
| `maxTurns`      | number            | Assistant-turn budget; the runner reserves one finalization turn at the boundary                                                                                                                                                                           |
| `cwd`           | string            | Working directory for the subagent                                                                                                                                                                                                                         |
| `parallelLimit` | number            | Maximum concurrent tasks in parallel mode (1–8)                                                                                                                                                                                                            |
| `onFailure`     | `stop`/`continue` | Chain policy; default `stop`, use `continue` only for recoverable best-effort pipelines                                                                                                                                                                    |
| `keepSession`   | bool              | Return a `sessionId` to continue this context window later                                                                                                                                                                                                 |
| `sessionId`     | string            | Continue an existing context window (from a prior `keepSession`)                                                                                                                                                                                           |

### Non-blocking execution

Every single, parallel, and chain request returns immediately while the group continues in-process. The result includes a group id. Continue independent work in the main session, or return control to the user when there is nothing useful to do.

When every run in a group finishes, the extension automatically interjects a capped completion message into the parent session with `pi.sendMessage()` using steering delivery. It queues like a user steering message while the parent is working and triggers a continuation when the parent is idle. The message includes the group summary and is visible in the transcript. `subagent_status` provides a non-blocking live snapshot and run ids; the main agent can use `subagent_history` to inspect persisted transcripts or, with `includeTranscript: true`, the completed messages and retained live events/current streamed text of a running subagent. Live activity is a bounded recent tail; `subagent_cancel` stops one run (`runId`) or a whole group (`groupId`). There is intentionally no wait tool.

Groups are canceled when the session shuts down. Stale completions from a shutdown or session switch are not interjected into the replacement session. This behavior is enforced by the extension rather than being an opt-in flag.

### Multi-turn sessions

Subagents are stateless by default. To make one remember across calls:

1. Call with `keepSession: true`; the result includes a line like
   `[Session: <uuid> — pass as sessionId to continue this context window]`.
2. Later, call again with that `sessionId` — the same in-process agent
   continues its transcript, so it remembers everything from the earlier run.

### Budgets and recovery

- Luna fast mode is enforced at the provider-payload boundary for in-process subagents, so it cannot be bypassed by a caller or by the main-session fast-mode toggle.
- `timeoutSec`: aborts the subagent after N seconds (honored even mid-stream); absent an override, every run has a 600-second hard deadline. After requesting abort, the runner gives the provider/tool up to one second to settle, then returns partial results and discards an unresponsive cached context.
- `maxTurns`: bounds tool loops per invocation. At the boundary the runner allows one explicit finalization turn; if the model still requests tools, the result includes the partial transcript and remains resumable when `keepSession` was enabled.
- The parent turn never owns an active subagent run: canceling the current turn does not interrupt a launched group. Use `subagent_cancel` to stop one run or all work in a group; queued parallel and chain work is skipped after group cancellation. Groups are also canceled at session shutdown.
- Prefer a larger budget for implementation/review work than for scouting. Do not set an artificially low budget just to make a task look bounded.

## Agent files

- User agents: `<agentDir>/agents/*.md`
- Project agents (opt-in, trusted repos only): `.pi/agents/*.md`

Frontmatter keys: `name`, `description`, `model`, `tools`, `thinking`,
`timeoutSec`, `maxTurns`. See the bundled samples (`scout`, `planner`,
`worker`, `reviewer`) in `agent/agents/`. The reusable orchestration playbook is
`agent/skills/subagent-orchestration/SKILL.md`.

## Model choice

Subagents use the model and thinking level **you** choose, not one the launching
agent picks:

- The first launch of each subagent type asks for a model and a thinking level.
- Choices are keyed by the agent definition name (`planner`, `reviewer`,
  `scout`, `worker`). Unnamed tasks use separate `default` or `inline` buckets;
  a choice never leaks from one type to another.
- The model list is restricted to the session's **scoped models** (the
  `--models` / `enabledModels` set that `/scoped-models` shows); when no scoping
  is configured it falls back to every authenticated model. Models without
  configured auth are never offered.
- Each answer is remembered for that type for the rest of the session. At the
  end of the prompt you can opt to save it globally
  (`<agentDir>/subagent-model.json`) so future sessions skip that type's prompt.
- `/subagent-model` opens a full settings menu for choosing, inspecting, or
  resetting typed choices. The argument form
  `/subagent-model [select|status|reset] [subagent-type]` remains available;
  `/subagent-model worker` is shorthand for selecting `worker`.
- The thinking dialog is filtered to the selected model's supported levels;
  models without reasoning expose only `off` (plus `auto`). Both dialogs offer
  `auto`, which defers to the agent file or the caller's per-task request
  instead of overriding it.
- A choice applies only to the selected subagent type. Each bundled
  `planner`/`reviewer`/`scout`/`worker` agent retains its own frontmatter
  fallback model, thinking, tool allowlist, and budgets when that type's choice
  is `auto`.
- Launch requests are serial (`executionMode: "sequential"`) so the model-choice
  prompt cannot overlap another tool call, and a cancelled prompt stops the launch
  instead of guessing a model. The subagent work itself is always non-blocking.

## Orchestrator pattern (strong planner + cheap workers)

Run the main pi session on your strongest model and delegate heavy or parallelizable
work to subagents:

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
- Every session's system prompt includes a delegation reminder so the agent uses
  subagents whenever focused research, implementation, or review would help. There
  is no mode gating: subagents are available at all times.
- `/subagents` opens a live browser showing per-run cost, activity, and transcripts.

## Monitoring & inspection

### Live visibility while runs happen

- Every run is persisted with `pi.appendEntry("subagent-run", …)` plus a
  `"subagent-run-detail"` entry carrying the exact task prompt, resolved launch
  controls, raw per-run transcript, and a bounded live activity tail for later
  inspection. Older records may be marked partial when they predate raw storage.
- `index.ts` keeps an in-memory registry of live runs merged with persisted
  entries, so `/subagents` shows active work and completed runs without keeping
  the launching tool call open (even across extension reloads within the
  session).

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
  with a predictable three-line layout: status/name, metadata (group/model/
  usage when there is room), and an indented prompt preview. Selected runs are
  highlighted as a block, so status and prompt stay visually associated. The
  list adapts to terminal height and keeps the selected run stable as live
  entries update. Navigate with `↑/↓` (`j`/`k`), page with `PgUp/PgDn`; `Enter`
  (or `l`) opens a run.
- **Detail view** — uses labeled `Prompt`, `System prompt`, `Config`, `Live
  activity`/`Activity`, and `Transcript` sections. It shows the exact task
  prompt sent by the main agent, resolved launch controls, streamed thinking,
  tool calls, tool results (with errors highlighted), and final output. By
  default, tool calls show names and tool results show bounded, sanitized
  output previews; arguments remain hidden. Expand with `o` (or `Ctrl+o`) to view
  more of the result and transcript. Only the final agent response is rendered
  as Markdown; intermediate transcript text remains literal. Display formatting
  never changes stored transcript content or model context. Prose wraps to the panel
  width; code rows (tool arguments, tool output) keep full width and scroll
  horizontally with `←/→` (`h`/`l`). Expansion increases display caps; the footer
  shows the current mode. Scroll vertically with `↑/↓`; `g`/`G` jump to
  top/bottom; `Backspace` returns to the list; Esc closes. Live runs refresh
  automatically. Display and storage truncation notices are called out
  visibly; older records without the optional metadata remain readable.
- An optional filter argument (`/subagents <terms>`) narrows the list. Matching
  is trimmed, case-insensitive, and treats whitespace-separated terms as an
  AND query across name, model, task, kind, status, stop reason, group id, and
  session id. The same filter is used by the plain-text fallback.
- The browser honors configured `tui.select.*` selection/cancel bindings while
  retaining the legacy arrow, `j`/`k`, Enter, Escape, and Ctrl+C keys.
- In non-TUI modes (print/RPC), `/subagents` falls back to a plain-text
  widget listing the most recent runs.

The launch tool renders only its immediate acknowledgement. Completed groups also interject their capped result into the parent session automatically; `/subagents` remains available for interactive history, while the main agent uses `subagent_status`, `subagent_history` (including live activity with `includeTranscript: true`), and `subagent_cancel` for run control and transcript inspection.

## Development

- `runner.ts` — `runSubagent()`: resolves model/provider/auth, builds the
  in-process agent with a minimal mock extension context for the built-in
  tools, watchdogs, session cache, usage accumulation, and live events
  (`RunnerEvent`: `message`, `tool`, `toolResult`, `thinking`, `status`) consumed
  by the browser.
- `ui.ts` — TUI building blocks: run/result formatting and the interactive
  `SubagentsBrowser` overlay used by `/subagents`.
- `agents.ts` — agent discovery + frontmatter parsing.
- `preference.ts` — the user-owned per-subagent-type model/thinking choices:
  session state, the typed `subagent-model.json` global file, the per-type
  ask-once prompt, and the override applied to matching task specs.
- `index.ts` — tool registration, live-run registry, `/subagents` and
  `/subagent-model` commands, the delegation reminder, TUI renderers.
- Deterministic tests (no network, no TUI): `bun test pi/agent/tests/` covers
  `preference.test.ts` (choice parsing, prompting, resolution) and
  `subagent-wiring.test.ts` (registration, restore, prompt injection) in
  addition to the runner and UI tests. `runner-inproc.test.ts` lives outside the
  repo and compiles `runner.ts` first via `tsconfig.subagents.emit.json`, since
  Bun resolves bare specifiers from the test file's directory.
