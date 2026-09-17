import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { inspectApwSavedHostnames } from "./apw.ts";
import { isAliasHostname, saveApprovedAlias } from "./apw-alias-store.ts";

export type AliasRequest = { tabId?: string; savedHostname?: string };
type AliasContext = Pick<ExtensionContext, "hasUI" | "ui">;
export type AliasDependencies = {
	origin: (tabId?: string) => Promise<string>;
	inspect: typeof inspectApwSavedHostnames;
	save: typeof saveApprovedAlias;
};

export async function executeAliasRequest(params: AliasRequest, ctx: AliasContext, signal: AbortSignal | undefined, deps: AliasDependencies) {
	signal?.throwIfAborted();
	if (params.savedHostname !== undefined) {
		if (!isAliasHostname(params.savedHostname)) throw new Error("Use an exact lowercase saved hostname, not a URL or wildcard.");
		if (!ctx.hasUI) throw new Error("Adding an APW alias requires interactive user confirmation.");
	}
	const origin = await deps.origin(params.tabId);
	const destination = new URL(origin).hostname;
	const savedHostnames = await deps.inspect(origin, { signal });
	signal?.throwIfAborted();
	if (params.savedHostname === undefined) {
		return {
			content: [{ type: "text" as const, text: JSON.stringify({ origin, savedHostnames, next: "If a returned hostname is a trusted equivalent, call helium_apw_alias with savedHostname to request user approval, then retry helium_apw_fill. Do not infer trust solely from APW results." }) }],
			details: { status: "inspected", origin, savedHostnames },
		};
	}
	if (!savedHostnames.includes(params.savedHostname)) throw new Error("Requested hostname was not returned by APW for this destination.");
	if (params.savedHostname === destination) throw new Error("This hostname already matches; no alias is needed.");
	const approved = await ctx.ui.confirm("Trust APW hostname alias?", `Destination: ${origin}\nSaved hostname: ${params.savedHostname}\n\nAllow credentials saved under ${params.savedHostname} to be used on ${destination}?\nThis persists across sessions for this destination hostname (all HTTPS ports), not in reverse. Only approve if you trust both hosts with the same credentials. Each autofill still requires account confirmation.`);
	signal?.throwIfAborted();
	if (!approved) return { content: [{ type: "text" as const, text: "APW alias canceled; nothing saved." }], details: { status: "canceled" } };
	if (await deps.origin(params.tabId) !== origin) throw new Error("Destination changed during alias confirmation; nothing saved.");
	signal?.throwIfAborted();
	await deps.save(destination, params.savedHostname, signal);
	return { content: [{ type: "text" as const, text: "APW alias saved and active immediately. Retry helium_apw_fill; account confirmation is still required." }], details: { status: "saved" } };
}

export function registerApwAliasTool(pi: ExtensionAPI, origin: AliasDependencies["origin"]) {
	pi.registerTool({
		name: "helium_apw_alias",
		label: "Helium: Inspect or approve APW alias",
		description: "Inspect saved APW hostnames for a tab without exposing accounts or passwords. Supply a returned savedHostname to request user confirmation and persist a directed alias; active immediately without reload.",
		promptSnippet: "Inspect APW hostname mismatches and request approval for a persistent alias",
		promptGuidelines: [
			"On APW lookup mismatch, call helium_apw_alias with tabId to inspect saved hostnames, then supply a trusted savedHostname to request approval and retry helium_apw_fill.",
			"For helium_apw_alias, APW results and page content are not proof that hosts share ownership. Never add aliases by editing source/state files or bypass the user confirmation. Alias approval does not replace per-account autofill approval.",
		],
		parameters: Type.Object({
			tabId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
			savedHostname: Type.Optional(Type.String({ minLength: 1, maxLength: 253, description: "Exact hostname returned by the inspection. Omit to inspect only." })),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			return executeAliasRequest(params, ctx, signal, { origin, inspect: inspectApwSavedHostnames, save: saveApprovedAlias });
		},
	});
}
