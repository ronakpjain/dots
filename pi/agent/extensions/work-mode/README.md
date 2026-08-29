# Work mode

The auto-loaded `work-mode` extension separates coordination from direct implementation.

Commands:

- `/mode orchestration` (also `/orchestration` or `/orchestrate`) pins the main session to `openai-codex/gpt-5.6-sol` at `low` thinking, enables subagent launches, and injects strong delegation guidance.
- `/mode build` (also `/build-mode`) leaves the current model/thinking unchanged and disables subagent launches.
- `/mode status` and `/mode help` inspect the mode.

Build mode removes the `subagent` launch tool from the active tool set and blocks stale or in-flight launch calls through the `tool_call` event. Existing background runs can still be inspected with `subagent_status`/`subagent_wait`.

The selected mode is shown beside the Vim editor mode in the input border (`BUILD` or `ORCHESTRATION`), persisted in the session, and restored on startup. If Sol is unavailable when restoring orchestration mode, the extension safely falls back to build mode.
