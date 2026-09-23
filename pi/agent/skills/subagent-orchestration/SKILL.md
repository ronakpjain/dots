---
name: subagent-orchestration
description: Plan and coordinate reliable, context-rich subagent workflows with parallel, chain, continuation, and failure controls.
---

# Subagent orchestration

Use this skill when a task benefits from delegated research, implementation, or review. The orchestrator owns decomposition, sequencing, recovery, and synthesis; subagents own focused work.

Every subagent has an isolated context window. It cannot see the main session's transcript, tool calls, discoveries, decisions, current diff, or sibling results unless the orchestrator includes them in the prompt or preserves them in the same `sessionId`. Treat every launch as a knowledge-transfer boundary.

## Core rule: hand off context, not just a task

Before launching a subagent, extract the relevant knowledge already present in the orchestrator's context and give it to the subagent. Do not make a subagent rediscover facts the orchestrator already established. Optimize total time and tokens, not the length of the task string: a slightly longer, high-signal handoff is preferable when it prevents several reads, searches, or a wrong implementation.

A complete handoff normally includes:

- **Objective and user intent:** the requested outcome, why it matters, and the observable definition of done;
- **Repository state:** exact `cwd`, branch/commit when relevant, relevant files and symbols, existing edits, and ownership boundaries;
- **Known evidence:** findings from prior reads, commands, tests, other agents, and tool output, with paths/line ranges or short critical excerpts where useful;
- **Decisions and constraints:** chosen approach, compatibility requirements, non-goals, APIs or conventions to preserve, and safety restrictions;
- **Open gaps:** facts that are genuinely unknown or may have changed and are the only things the subagent should investigate;
- **Validation:** checks already run, checks still required, and the expected deliverable/report format.

Label the handoff when useful: `[known]` for verified facts, `[inference]` for conclusions, and `[verify]` for facts the subagent must confirm. Include enough literal detail—error text, relevant code excerpts, interfaces, expected values, and test expectations—for the subagent to act without reconstructing the main conversation. Do not dump unrelated transcript or whole files merely because they are available.

Use this template in the task text and adapt it to the work:

```text
## Handoff from orchestrator
Snapshot: <commit/time or other state boundary, if relevant>

Objective:
<user outcome and definition of done>

Repository and scope:
- cwd: <absolute path>
- relevant files/symbols: <paths, line ranges, functions/types>
- existing edits/ownership: <what is already changed and what this subagent may touch>

Known context and evidence:
- [known] <fact, with source or short excerpt>
- [known] <test/error/output that matters>
- [inference] <decision and rationale>

Constraints and non-goals:
- <requirements, compatibility or safety constraints>
- do not re-derive: <facts already established>

Only investigate if needed:
- [verify] <specific unresolved question>

Assignment:
<one focused question or change>

Validation and return format:
- run/check: <command or evidence required>
- return: <findings, diff summary, test results, risks, etc.>
```

The handoff is a context snapshot, not permission to trust stale facts blindly. Ask the subagent to verify only mutable or explicitly marked critical facts, and tell it exactly what changed if the main session continues working in the meantime.

## Passing context by mode

- **Single task:** send one complete handoff with the scoped assignment. Avoid vague requests such as “look into this” when the main session already knows the symptom, files, or likely cause.
- **Parallel `tasks`:** every task gets the shared context package plus its own task-specific delta. Siblings do not see one another, so never assume one sibling's discovery is available to another. Keep the shared package compact but complete.
- **Chain:** repeat the stable handoff for each step and use `{previous}` for the immediately preceding result. Tell each step which parts of that result are verified, what remains, and not to restart discovery already covered by the handoff. A later step receives output, not the prior agent's full context, unless it uses the same session.
- **Continuation with `sessionId`:** the subagent already has its prior transcript. Send a narrow continuation request containing new main-session facts, changed files, the remaining objective, and any new validation failure; do not repeat unchanged context or the original broad task.
- **Background work:** include a state snapshot, exact file ownership, and coordination assumptions. Do not edit the same files in the main thread while the background worker may be relying on the snapshot unless the worker is explicitly told how to reconcile the change.
- **Recovery/retry:** include the partial output, failure reason, verified versus unverified work, and the smallest remaining task. A fresh worker must receive the useful context again; a resumed worker needs only the delta.

Put stable role, tool, mutation, and reporting rules in `systemPrompt`; put dynamic repository facts, evidence, decisions, and the assignment in `task`. When using an inline `systemPrompt`, preserve the role's required behavior instead of accidentally replacing it with context alone.

## When to delegate

Use `subagent` whenever one or more focused delegated tasks would materially improve the work. Choose delegation based on task complexity, independence, context isolation, and expected efficiency—not on a minimum number of subagent runs. Do not add redundant subagents merely to justify delegation. Subagents are available at all times; there is no mode that blocks them, and the user chooses the model separately for each subagent type.

## Default workflow

1. **Decide whether delegation is beneficial** for the whole request; stay in the main thread when delegation would add unnecessary overhead.
2. **Consolidate the orchestrator's current context** into a handoff before launching. Include discoveries already made instead of asking the subagent to repeat them.
3. **Identify only the remaining unknowns.** If discovery is needed, give the scout the known map and ask targeted questions; do not commission a second broad reconnaissance pass.
4. **Decompose** the request into narrow tasks with an explicit expected output, context package, scope, and validation.
5. **Fan out independent work** with `tasks` and `parallelLimit: 2-4`. Keep parallel tasks read-only or ensure their mutation targets do not overlap.
6. **Never block on delegated work**: every subagent launch is non-blocking. Continue independent discovery, implementation, or validation; if no useful work remains, return control to the user. Use `subagent_status` for live snapshots/run ids, `subagent_history` to inspect prior transcripts or a running agent's retained live activity (`includeTranscript: true`), and `subagent_cancel` to stop one run or an entire group—there is intentionally no wait tool.
7. **Chain dependent work** with `chain` and `{previous}`. A reliable implementation flow is scout/planner → focused worker → reviewer, with each phase receiving the relevant accumulated context.
8. **Synthesize and verify** the results in the orchestrator. A worker's partial or failed result is evidence, not completion; reconcile it with the handoff and run the final checks yourself.

## Controls

- `agent`: use a named role when its tools and instructions fit the task.
- `model`: the user owns this per subagent type. Pi asks on the first launch of each type and reuses that choice only for matching tasks, so leave `model` unset unless the user chose `auto` and the task genuinely needs a specific model.
- `tools`: restrict the worker to the smallest useful allowlist; use read-only tools for scouts/planners/reviewers.
- `cwd`: set the repository or project directory explicitly when it differs from the parent, and state it in the handoff.
- `thinking`: also user-owned per subagent type (same type-specific prompt); the selector only offers levels supported by the selected model, and `auto` defers to the agent file/task when capabilities are unknown. Set it only when that type's choice is `auto` and the task calls for a different level.
- `maxTurns`: choose a real budget for the work. Rough defaults: scout 18, planner 18, reviewer 22, worker 40. Do not use a tiny budget merely to prevent loops.
- `timeoutSec`: set a wall-clock limit appropriate to the task; runs default to a 600-second hard deadline, so increase this for longer work.
- `parallelLimit`: control concurrency for independent tasks; leave it at 1 for dependent or resource-sensitive work.
- `onFailure: "stop"` (default): stop a dependent chain when a step fails. Use `onFailure: "continue"` only when later steps can recover from partial evidence.
- `keepSession: true`: request a continuation handle for work likely to need follow-up.
- `sessionId`: resume the exact in-process context from a prior result. Give resumed workers a narrower continuation task instead of repeating the original request.

## Turn-budget recovery

The runner reserves one finalization turn at the max-turn boundary and asks the worker to stop using tools and summarize verified versus unverified findings. If it still fails:

1. Inspect the returned partial output and failure reason.
2. If a session handle is present, continue it with `sessionId` and a focused task that includes only the new facts and remaining work, such as “finish the implementation and run the remaining validation; do not re-explore unrelated files.”
3. Otherwise, split the unfinished work into a smaller task or retry it with a larger `maxTurns`, a tighter system prompt, and the prior worker's useful partial output in the handoff.
4. Never silently treat a max-turn result as success.

## Task contracts

Every task should state:

- the exact question or change;
- the context the orchestrator already knows;
- files, symbols, and scope to inspect or modify;
- tools and mutation permissions;
- the facts that are already established and the few facts still needing verification;
- the expected final format;
- the validation command or evidence required.

Ask workers to batch independent reads, honor the supplied context, avoid rereading unchanged material, and stop exploring once the stated gaps are closed. The orchestrator should spend its own context on making the handoff precise, then spend its remaining work on coordination, validation, and synthesis rather than forcing each subagent to repeat the same orientation pass.
