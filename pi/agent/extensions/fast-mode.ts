import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const FAST_MODE_SHORTCUT = "ctrl+alt+f" as const;
export const FAST_MODE_COMMAND = "fast-mode" as const;
export const FAST_MODE_ALIAS = "fast" as const;
export const FAST_MODE_SERVICE_TIER = "priority" as const;

const FAST_MODE_STATUS = "fast-mode";

type ModelLike = {
	provider?: unknown;
	api?: unknown;
};

type RequestPayload = Record<string, unknown>;

function isRecord(value: unknown): value is RequestPayload {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Native OpenAI endpoints support the priority service tier. */
export function isOpenAIModel(model: ModelLike | undefined): boolean {
	return model?.provider === "openai" || model?.provider === "openai-codex";
}

/** Apply or remove only this extension's priority service-tier override. */
export function applyFastMode(payload: unknown, enabled: boolean): unknown {
	if (!isRecord(payload)) return payload;

	if (enabled) {
		return { ...payload, service_tier: FAST_MODE_SERVICE_TIER };
	}

	if (payload.service_tier !== FAST_MODE_SERVICE_TIER) return payload;
	const normalPayload = { ...payload };
	delete normalPayload.service_tier;
	return normalPayload;
}

export default function fastModeExtension(pi: ExtensionAPI): void {
	let enabled = false;

	function updateStatus(ctx: ExtensionContext): void {
		if (!enabled) {
			ctx.ui.setStatus(FAST_MODE_STATUS, undefined);
			return;
		}

		ctx.ui.setStatus(FAST_MODE_STATUS, isOpenAIModel(ctx.model) ? "⚡ fast" : "⚡ fast (OpenAI only)");
	}

	function toggle(ctx: ExtensionContext): void {
		enabled = !enabled;
		updateStatus(ctx);

		const scope = isOpenAIModel(ctx.model) ? "" : " (applies when an OpenAI model is selected)";
		ctx.ui.notify(`OpenAI fast mode ${enabled ? "enabled" : "disabled"}${scope}.`, "info");
	}

	const handleCommand = async (args: string, ctx: ExtensionContext): Promise<void> => {
		switch (args.trim().toLowerCase()) {
			case "on":
			case "enable":
				enabled = true;
				updateStatus(ctx);
				ctx.ui.notify("OpenAI fast mode enabled.", "info");
				return;
			case "off":
			case "disable":
				enabled = false;
				updateStatus(ctx);
				ctx.ui.notify("OpenAI fast mode disabled.", "info");
				return;
			case "status":
				ctx.ui.notify(`OpenAI fast mode is ${enabled ? "enabled" : "disabled"}.`, "info");
				return;
			default:
				toggle(ctx);
		}
	};

	pi.registerCommand(FAST_MODE_COMMAND, {
		description: "Toggle OpenAI priority (fast) mode",
		handler: handleCommand,
	});
	pi.registerCommand(FAST_MODE_ALIAS, {
		description: "Alias for /fast-mode",
		handler: handleCommand,
	});
	pi.registerShortcut(FAST_MODE_SHORTCUT, {
		description: "Toggle OpenAI priority (fast) mode",
		handler: toggle,
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!isOpenAIModel(ctx.model)) return;
		return applyFastMode(event.payload, enabled);
	});

	pi.on("model_select", (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_start", (_event, ctx) => {
		enabled = false;
		updateStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		enabled = false;
		ctx.ui.setStatus(FAST_MODE_STATUS, undefined);
	});
}
