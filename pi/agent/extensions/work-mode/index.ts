import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	activeToolsForMode,
	canLaunchSubagents,
	DEFAULT_WORK_MODE,
	getWorkMode,
	modePrompt,
	ORCHESTRATION_MODEL_ID,
	parseWorkMode,
	setWorkMode,
	SUBAGENT_LAUNCH_TOOL,
	WORK_MODE_ENTRY_TYPE,
	type WorkMode,
} from "./state.ts";

type WorkModeEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
};

const ORCHESTRATION_SKILL_NAME = "subagent-orchestration";
const ORCHESTRATION_SKILL_MARKER = "## FULL SUBAGENT-ORCHESTRATION SKILL LOADED";

function restoredWorkMode(ctx: ExtensionContext): WorkMode | undefined {
	const entries = ctx.sessionManager.getBranch() as WorkModeEntry[];
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== WORK_MODE_ENTRY_TYPE) continue;
		if (!entry.data || typeof entry.data !== "object") continue;
		const mode = parseWorkMode((entry.data as { mode?: unknown }).mode);
		if (mode) return mode;
	}
	return undefined;
}

export default function workModeExtension(pi: ExtensionAPI): void {
	let modelUpdateInProgress = false;

	const orchestrationSkillPrompt = (event: {
		systemPromptOptions?: { skills?: readonly { name: string; filePath: string }[] };
	}): string => {
		const skill = event.systemPromptOptions?.skills?.find(
			(candidate) => candidate.name === ORCHESTRATION_SKILL_NAME,
		);
		if (!skill) {
			return [
				`\n\n[${ORCHESTRATION_SKILL_NAME} skill was not found in the loaded skill catalog.]`,
				"Before taking any other action, load the skill from its location in the available-skills prompt with the read tool.",
			].join("\n");
		}

		try {
			const contents = readFileSync(skill.filePath, "utf8").trim();
			if (!contents) throw new Error("skill file is empty");
			return `\n\n${ORCHESTRATION_SKILL_MARKER}\n<skill name=\"${ORCHESTRATION_SKILL_NAME}\">\n${contents}\n</skill>`;
		} catch {
			return [
				`\n\n[${ORCHESTRATION_SKILL_NAME} skill could not be read from ${skill.filePath}.]`,
				"Before taking any other action, use the read tool to load that skill and follow it.",
			].join("\n");
		}
	};

	const updateModeUi = (ctx: ExtensionContext): void => {
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
		const thinking = pi.getThinkingLevel();
		const status =
			getWorkMode() === "orchestration"
				? `orchestration · ${ORCHESTRATION_MODEL_ID} · low`
				: `build · ${model} · ${thinking}`;
		ctx.ui.setStatus("work-mode", status);
	};

	const applyModeTools = (): void => {
		const current = pi.getActiveTools();
		const next = activeToolsForMode(getWorkMode(), current);
		if (current.join("\0") !== next.join("\0")) pi.setActiveTools(next);
	};

	const persistMode = (): void => {
		pi.appendEntry(WORK_MODE_ENTRY_TYPE, { mode: getWorkMode() });
	};

	const workerCatalog = (ctx: ExtensionContext): string => {
		const models = ctx.modelRegistry
			.getAvailable()
			.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model))
			.sort((a, b) => {
				const aCost = (a.cost.input ?? 0) + (a.cost.output ?? 0);
				const bCost = (b.cost.input ?? 0) + (b.cost.output ?? 0);
				return aCost - bCost;
			})
			.slice(0, 6)
			.map((model) => `${model.provider}/${model.id} (${Math.round(model.contextWindow / 1024)}k ctx)`);
		return models.join(", ");
	};

	const modePromptFor = (ctx: ExtensionContext): string => {
		const base = modePrompt(getWorkMode());
		if (!canLaunchSubagents(getWorkMode())) return base;
		const catalog = workerCatalog(ctx);
		return catalog ? `${base}\n\nConfigured worker catalog (choose deliberately): ${catalog}.` : base;
	};

	const ensureOrchestrationModel = async (ctx: ExtensionContext): Promise<boolean> => {
		const target = ctx.modelRegistry
			.getAvailable()
			.find((model) => `${model.provider}/${model.id}` === ORCHESTRATION_MODEL_ID);
		if (!target || !ctx.modelRegistry.hasConfiguredAuth(target)) return false;

		modelUpdateInProgress = true;
		try {
			const current = ctx.model;
			if (!current || `${current.provider}/${current.id}` !== ORCHESTRATION_MODEL_ID) {
				if (!(await pi.setModel(target))) return false;
			}
			pi.setThinkingLevel("low");
			return pi.getThinkingLevel() === "low";
		} catch {
			return false;
		} finally {
			modelUpdateInProgress = false;
		}
	};

	const enterBuildMode = (ctx: ExtensionContext, message = true): void => {
		setWorkMode("build");
		applyModeTools();
		persistMode();
		updateModeUi(ctx);
		if (message) ctx.ui.notify("Build mode active: direct work only; subagent launches are blocked.", "info");
	};

	const enterOrchestrationMode = async (ctx: ExtensionContext): Promise<void> => {
		if (!(await ensureOrchestrationModel(ctx))) {
			ctx.ui.notify(
				`Could not activate orchestration mode: ${ORCHESTRATION_MODEL_ID} is unavailable or unauthenticated.`,
				"error",
			);
			return;
		}
		setWorkMode("orchestration");
		applyModeTools();
		persistMode();
		updateModeUi(ctx);
		ctx.ui.notify("Orchestration mode active: Sol/low pinned; delegate through subagents by default.", "info");
	};

	const modeStatus = (ctx: ExtensionContext): void => {
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
		ctx.ui.notify(
			`Work mode: ${getWorkMode()}\nModel: ${model}\nThinking: ${pi.getThinkingLevel()}\nSubagent launches: ${canLaunchSubagents(getWorkMode()) ? "enabled" : "blocked"}`,
			"info",
		);
	};

	const modeHelp = (ctx: ExtensionContext): void => {
		ctx.ui.notify(
			[
				"Work modes:",
				"  /mode orchestration   pin the main session to openai-codex/gpt-5.6-sol at low thinking and delegate by default",
				"  /mode build           keep the current model/thinking and block subagent launches",
				"  /orchestration        alias for /mode orchestration",
				"  /build-mode           alias for /mode build",
				"  /mode status          show the current mode",
			].join("\n"),
			"info",
		);
	};

	const handleModeCommand = async (args: string, ctx: ExtensionContext): Promise<void> => {
		const requested = args.trim().toLowerCase();
		if (requested === "" || requested === "status") {
			modeStatus(ctx);
			return;
		}
		if (requested === "help") {
			modeHelp(ctx);
			return;
		}
		if (requested === "orchestration" || requested === "orchestrate") {
			await enterOrchestrationMode(ctx);
			return;
		}
		if (requested === "build" || requested === "build-mode") {
			enterBuildMode(ctx);
			return;
		}
		ctx.ui.notify("Unknown work mode. Use /mode orchestration, /mode build, or /mode help.", "warning");
	};

	pi.registerCommand("mode", {
		description: "Switch between orchestration and direct build modes",
		handler: handleModeCommand,
	});
	pi.registerCommand("orchestration", {
		description: "Enter orchestration mode (Sol/low, delegate by default)",
		handler: async (_args, ctx) => enterOrchestrationMode(ctx),
	});
	pi.registerCommand("orchestrate", {
		description: "Alias for /orchestration",
		handler: async (_args, ctx) => enterOrchestrationMode(ctx),
	});
	pi.registerCommand("build-mode", {
		description: "Enter build mode and block subagent launches",
		handler: async (_args, ctx) => enterBuildMode(ctx),
	});

	// This gate covers stale tool lists and tool calls already in flight when
	// build mode is selected; removing the tool from the active set is only the
	// prompt/UI layer of the restriction.
	pi.on("tool_call", (event) => {
		if (!canLaunchSubagents(getWorkMode()) && event.toolName === SUBAGENT_LAUNCH_TOOL) {
			return {
				block: true,
				reason: "Build mode blocks subagent launches. Switch to /mode orchestration first.",
			};
		}
	});

	// Pin both values while orchestration mode is active, including manual
	// /model and thinking-level changes made after entering the mode.
	pi.on("model_select", async (event, ctx) => {
		if (!canLaunchSubagents(getWorkMode()) || modelUpdateInProgress) return;
		if (`${event.model.provider}/${event.model.id}` === ORCHESTRATION_MODEL_ID) {
			if (pi.getThinkingLevel() !== "low") {
				modelUpdateInProgress = true;
				try {
					pi.setThinkingLevel("low");
				} finally {
					modelUpdateInProgress = false;
				}
			}
			updateModeUi(ctx);
			return;
		}

		if (await ensureOrchestrationModel(ctx)) {
			ctx.ui.notify("Orchestration mode pins the main session to Sol/low.", "warning");
			updateModeUi(ctx);
			return;
		}

		enterBuildMode(ctx, false);
		ctx.ui.notify("Sol is unavailable, so orchestration mode was exited; build mode is active.", "error");
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		if (!canLaunchSubagents(getWorkMode()) || modelUpdateInProgress) return;
		if (pi.getThinkingLevel() === "low") return;
		modelUpdateInProgress = true;
		try {
			pi.setThinkingLevel("low");
		} finally {
			modelUpdateInProgress = false;
		}
		updateModeUi(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const mode = getWorkMode();
		const modeInstructions = modePromptFor(ctx);
		const skillInstructions =
			mode === "orchestration" && !event.systemPrompt.includes(ORCHESTRATION_SKILL_MARKER)
				? orchestrationSkillPrompt(event)
				: "";
		return {
			systemPrompt: `${event.systemPrompt}\n\n${modeInstructions}${skillInstructions}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		const restored = restoredWorkMode(ctx) ?? DEFAULT_WORK_MODE;
		setWorkMode(restored);
		if (restored === "orchestration" && !(await ensureOrchestrationModel(ctx))) {
			setWorkMode(DEFAULT_WORK_MODE);
			persistMode();
			ctx.ui.notify("Saved orchestration mode could not restore Sol/low; build mode is active.", "warning");
		}
		applyModeTools();
		updateModeUi(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus("work-mode", undefined);
		setWorkMode(DEFAULT_WORK_MODE);
	});
}
