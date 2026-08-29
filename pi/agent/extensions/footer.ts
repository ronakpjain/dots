import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function collectUsage(ctx: ExtensionContext): UsageTotals {
	const totals: UsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;

		const message = entry.message as {
			role?: string;
			usage?: {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
				cost?: { total?: number };
			};
		};
		const usage = message.usage;
		if (!usage) continue;

		totals.input += numberOrZero(usage.input);
		totals.output += numberOrZero(usage.output);
		totals.cacheRead += numberOrZero(usage.cacheRead);
		totals.cacheWrite += numberOrZero(usage.cacheWrite);
		totals.cost += numberOrZero(usage.cost?.total);
	}

	return totals;
}

function formatCount(value: number): string {
	if (value < 1_000) return String(Math.round(value));
	if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatCost(value: number): string {
	if (value === 0) return "$0";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(3)}`;
}

function formatPath(path: string): string {
	const home = homedir();
	if (path === home) return "~";
	if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
	return path;
}

function contextLabel(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null) return "ctx —";
	const percent = usage.percent === null ? "—" : `${usage.percent.toFixed(0)}%`;
	return `ctx ${formatCount(usage.tokens)}/${formatCount(usage.contextWindow)} ${percent}`;
}

function compactContextLabel(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null) return "ctx —";
	const percent = usage.percent === null ? "—" : `${usage.percent.toFixed(0)}%`;
	return `ctx ${percent}`;
}

function compactCount(value: number): string {
	if (value < 1_000) return String(Math.round(value));
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	return `${Math.round(value / 1_000_000)}m`;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

export type FooterPart = {
	text: string;
	priority: number;
};

export type FooterLayout = "wide" | "medium" | "narrow";

const FRAME_WIDTH = 4;
const WIDE_CONTENT_WIDTH = 88;
const MEDIUM_CONTENT_WIDTH = 48;

function footerContentWidth(width: number): number {
	const renderWidth = Math.max(1, width);
	return renderWidth < 8 ? renderWidth : Math.max(1, renderWidth - FRAME_WIDTH);
}

export function footerLayoutForWidth(width: number): FooterLayout {
	const contentWidth = footerContentWidth(width);
	if (contentWidth >= WIDE_CONTENT_WIDTH) return "wide";
	if (contentWidth >= MEDIUM_CONTENT_WIDTH) return "medium";
	return "narrow";
}

function joinFooterParts(parts: readonly FooterPart[]): string {
	return parts
		.filter((part) => visibleWidth(part.text) > 0)
		.map((part) => part.text)
		.join("  ");
}

/** Keep important segments visible by dropping lower-priority segments before truncating. */
export function fitFooterParts(parts: readonly FooterPart[], width: number): string {
	const available = Math.max(1, Math.floor(width));
	const selected = parts.filter((part) => visibleWidth(part.text) > 0);

	while (selected.length > 1 && visibleWidth(joinFooterParts(selected)) > available) {
		let removeIndex = 0;
		for (let index = 1; index < selected.length; index++) {
			const candidate = selected[index]!;
			const current = selected[removeIndex]!;
			if (
				candidate.priority < current.priority ||
				(candidate.priority === current.priority && index > removeIndex)
			) {
				removeIndex = index;
			}
		}
		selected.splice(removeIndex, 1);
	}

	return truncateToWidth(joinFooterParts(selected), available, "…");
}

function footerParts(...entries: Array<FooterPart | undefined>): FooterPart[] {
	return entries.filter((entry): entry is FooterPart => entry !== undefined);
}

function renderFrame(width: number, content: string, theme: ExtensionContext["ui"]["theme"]): string {
	const renderWidth = Math.max(1, width);
	if (renderWidth < 8) return truncateToWidth(content, renderWidth, "");

	const left = theme.fg("borderMuted", "│ ");
	const right = theme.fg("borderMuted", " │");
	const available = Math.max(1, renderWidth - visibleWidth(left) - visibleWidth(right));
	const body = truncateToWidth(content, available, "…");
	const padding = " ".repeat(Math.max(0, available - visibleWidth(body)));
	return truncateToWidth(`${left}${body}${padding}${right}`, renderWidth, "");
}

function renderFooterLine(width: number, parts: readonly FooterPart[], theme: ExtensionContext["ui"]["theme"]): string {
	return renderFrame(width, fitFooterParts(parts, footerContentWidth(width)), theme);
}

export default function footerExtension(pi: ExtensionAPI): void {
	let requestRender = (): void => {};

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n[FOOTER CAPABILITY] A compact UI footer is active and displays model, context, usage, cost, branch, tool, and extension-status information. It requires no model action.`,
	}));

	function refresh(): void {
		requestRender();
	}

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(requestRender);

			return {
				render(width: number): string[] {
					const usage = collectUsage(ctx);
					const branch = footerData.getGitBranch();
					const sessionName = pi.getSessionName();
					const activeTools = pi.getActiveTools().length;
					const allTools = pi.getAllTools().length;
					const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
					const modelId = ctx.model?.id ?? "no model";
					const thinking = ctx.thinkingLevel ?? pi.getThinkingLevel();
					const statuses = [...footerData.getExtensionStatuses().entries()]
						.sort(([left], [right]) => left.localeCompare(right))
						.map(([, text]) => sanitizeStatusText(text))
						.filter(Boolean)
						.slice(0, 2);
					const working = !ctx.isIdle();

					const project = formatPath(ctx.cwd);
					const brandPart: FooterPart = {
						text: theme.fg("accent", theme.bold("✦ pi")),
						priority: 100,
					};
					const sessionPart: FooterPart | undefined = sessionName
						? { text: theme.fg("text", `◦ ${sessionName}`), priority: 35 }
						: undefined;
					const projectPart: FooterPart = { text: theme.fg("muted", project), priority: 70 };
					const branchPart: FooterPart | undefined = branch
						? { text: theme.fg("accent", `⎇ ${branch}`), priority: 85 }
						: undefined;
					const workingPart: FooterPart | undefined = working
						? { text: theme.fg("warning", "● working"), priority: 90 }
						: undefined;
					const narrowBranchPart: FooterPart | undefined = branch
						? {
								text: theme.fg(
									"accent",
									truncateToWidth(
										`⎇ ${branch}`,
										Math.max(1, footerContentWidth(width) - visibleWidth(brandPart.text) - 2),
										"…",
									),
								),
								priority: 95,
							}
						: undefined;
					const statusParts = statuses.map((text, index): FooterPart => ({
						text,
						priority: 10 - index,
					}));

					const usagePart: FooterPart = {
						text: theme.fg("muted", `↑${formatCount(usage.input)} ↓${formatCount(usage.output)}`),
						priority: 100,
					};
					const compactUsagePart: FooterPart = {
						text: theme.fg("muted", `↑${compactCount(usage.input)} ↓${compactCount(usage.output)}`),
						priority: 100,
					};
					const cachePart: FooterPart = {
						text: theme.fg("dim", `cache ${formatCount(usage.cacheRead)}/${formatCount(usage.cacheWrite)}`),
						priority: 20,
					};
					const compactCachePart: FooterPart = {
						text: theme.fg("dim", `R${compactCount(usage.cacheRead)} W${compactCount(usage.cacheWrite)}`),
						priority: 15,
					};
					const costPart: FooterPart = {
						text: theme.fg("success", formatCost(usage.cost)),
						priority: 70,
					};
					const contextPart: FooterPart = {
						text: theme.fg("dim", contextLabel(ctx)),
						priority: 95,
					};
					const compactContextPart: FooterPart = {
						text: theme.fg("dim", compactContextLabel(ctx)),
						priority: 95,
					};
					const toolsPart: FooterPart = {
						text: theme.fg("dim", `tools ${activeTools}/${allTools}`),
						priority: 30,
					};
					const modelPart: FooterPart = {
						text: theme.fg("text", model),
						priority: 90,
					};
					const compactModelPart: FooterPart = {
						text: theme.fg("text", modelId),
						priority: 100,
					};
					const thinkingPart: FooterPart = {
						text: theme.fg("accent", thinking),
						priority: 65,
					};

					const layout = footerLayoutForWidth(width);
					if (layout === "wide") {
						return [
							renderFooterLine(
								width,
								footerParts(
									brandPart,
									sessionPart,
									projectPart,
									branchPart,
									workingPart,
									...statusParts,
								),
								theme,
							),
							renderFooterLine(
								width,
								footerParts(
									usagePart,
									cachePart,
									costPart,
									contextPart,
									toolsPart,
									modelPart,
									thinkingPart,
								),
								theme,
							),
						];
					}

					if (layout === "medium") {
						return [
							renderFooterLine(
								width,
								footerParts(
									brandPart,
									sessionPart,
									projectPart,
									branchPart,
									workingPart,
									...statusParts,
								),
								theme,
							),
							renderFooterLine(
								width,
								footerParts(
									compactUsagePart,
									costPart,
									compactContextPart,
									compactModelPart,
									thinkingPart,
									toolsPart,
									compactCachePart,
								),
								theme,
							),
						];
					}

					const narrowIdentity =
						footerContentWidth(width) < 28
							? footerParts(brandPart, workingPart ?? narrowBranchPart)
							: footerParts(brandPart, narrowBranchPart, workingPart, projectPart);

					return [
						renderFooterLine(width, narrowIdentity, theme),
						renderFooterLine(width, footerParts(compactUsagePart, costPart, compactContextPart), theme),
						renderFooterLine(
							width,
							footerParts(compactModelPart, thinkingPart, toolsPart, ...statusParts),
							theme,
						),
					];
				},
				invalidate() {},
				dispose: unsubscribe,
			};
		});

		refresh();
	});

	pi.on("session_info_changed", refresh);
	pi.on("model_select", refresh);
	pi.on("thinking_level_select", refresh);
	pi.on("agent_start", refresh);
	pi.on("agent_end", refresh);
	pi.on("turn_end", refresh);
	pi.on("tool_execution_start", refresh);
	pi.on("tool_execution_end", refresh);

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setFooter(undefined);
		requestRender = () => {};
	});
}
