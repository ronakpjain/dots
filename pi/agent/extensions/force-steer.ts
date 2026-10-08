import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FORCE_STEER_SHORTCUT = "alt+shift+enter" as const;

/** Abort the active response and submit the editor contents as a fresh turn. */
export default function forceSteerExtension(pi: ExtensionAPI): void {
	const pendingMessages: string[] = [];

	pi.on("agent_settled", () => {
		for (const text of pendingMessages.splice(0)) {
			pi.sendUserMessage(text, { expandPromptTemplates: true });
		}
	});

	pi.registerShortcut(FORCE_STEER_SHORTCUT, {
		description: "Cancel the current response and send the editor text",
		handler: (ctx) => {
			const text = ctx.ui.getEditorText();
			if (!text.trim()) return;

			ctx.ui.setEditorText("");
			if (ctx.isIdle()) {
				pi.sendUserMessage(text, { expandPromptTemplates: true });
			} else {
				pendingMessages.push(text);
				ctx.abort();
			}
		},
	});
}
