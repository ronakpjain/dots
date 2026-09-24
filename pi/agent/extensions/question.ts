import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderToolResult } from "./tool-results/render.ts";

interface QuestionOption {
	label: string;
	description?: string;
}

interface QuestionSpec {
	id?: string;
	question: string;
	options?: QuestionOption[];
	allowOther?: boolean;
	placeholder?: string;
}

interface Answer {
	id: string;
	question: string;
	answer: string;
	selectedOption?: string;
}

interface QuestionDetails {
	answers: Answer[];
	cancelled: boolean;
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "The option label shown to the user" }),
	description: Type.Optional(Type.String({ description: "Brief explanation shown alongside the option" })),
});

const QuestionSpecSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable short id for the answer, such as database" })),
	question: Type.String({ description: "The complete question to show the user" }),
	options: Type.Optional(
		Type.Array(OptionSchema, { maxItems: 20, description: "Optional choices; omit for free-form text" }),
	),
	allowOther: Type.Optional(
		Type.Boolean({ description: "Add a free-form Other response when options are present; defaults to true" }),
	),
	placeholder: Type.Optional(Type.String({ description: "Placeholder for a free-form response" })),
});

const QuestionParams = Type.Object({
	questions: Type.Array(QuestionSpecSchema, {
		minItems: 1,
		maxItems: 10,
		description: "Questions to ask in order; group related questions into one call",
	}),
});

function questionId(question: QuestionSpec, index: number): string {
	return question.id?.trim() || `question_${index + 1}`;
}

function cancelledResult(answers: Answer[]): { content: { type: "text"; text: string }[]; details: QuestionDetails } {
	const prefix =
		answers.length > 0
			? `Collected ${answers.length} answer${answers.length === 1 ? "" : "s"} before cancellation.\n`
			: "";
	return {
		content: [{ type: "text", text: `${prefix}The user cancelled the question flow.` }],
		details: { answers, cancelled: true },
	};
}

export default function questionExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n[QUESTION CAPABILITY] The question tool can ask the user concise choice or free-form questions. Use it only when necessary information or a decision cannot be obtained from the current context or available tools.`,
	}));

	pi.registerTool({
		name: "question",
		label: "Question",
		description:
			"Ask the user one or more necessary questions and return their answers. Supports choice lists, free-form text, and an optional Other response.",
		promptSnippet: "Ask the user for missing information or a decision",
		promptGuidelines: [
			"Use question when the task is blocked by information the user must provide; do not ask questions that can be answered from context or tools.",
			"Group related questions into one question call, and prefer concise options with descriptions when a decision has a small set of choices.",
			"Treat a cancelled question as missing information and do not pretend that an answer was received.",
		],
		parameters: QuestionParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				throw new Error("The question tool requires an interactive TUI or RPC session.");
			}

			const answers: Answer[] = [];
			for (let index = 0; index < params.questions.length; index++) {
				const question = params.questions[index] as QuestionSpec;
				const id = questionId(question, index);
				const prompt = `${index + 1}/${params.questions.length} · ${question.question}`;

				if (question.options && question.options.length > 0) {
					const otherLabel = "Other (type a response)";
					const choices = question.options.map((option) => {
						const description = option.description?.trim();
						return description ? `${option.label} — ${description}` : option.label;
					});
					if (question.allowOther !== false) choices.push(otherLabel);

					const selected = await ctx.ui.select(prompt, choices);
					if (selected === undefined) return cancelledResult(answers);

					const selectedIndex = choices.indexOf(selected);
					const selectedOption = question.options[selectedIndex];
					if (selected === otherLabel) {
						const custom = await ctx.ui.input(
							`${prompt} · your response`,
							question.placeholder ?? "Type your answer",
						);
						if (custom === undefined) return cancelledResult(answers);
						answers.push({ id, question: question.question, answer: custom, selectedOption: otherLabel });
					} else {
						answers.push({
							id,
							question: question.question,
							answer: selectedOption?.label ?? selected,
							selectedOption: selectedOption?.label ?? selected,
						});
					}
					continue;
				}

				const answer = await ctx.ui.input(prompt, question.placeholder ?? "Type your answer");
				if (answer === undefined) return cancelledResult(answers);
				answers.push({ id, question: question.question, answer });
			}

			const lines = answers.map((item) => `${item.id}: ${item.answer}`);
			return {
				content: [{ type: "text", text: `User answered:\n${lines.join("\n")}` }],
				details: { answers, cancelled: false },
			};
		},
		renderCall(args, theme) {
			const count = args.questions.length;
			return new Text(
				theme.fg("toolTitle", theme.bold("question ")) +
					theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`),
				0,
				0,
			);
		},
		renderResult(result, options, theme, context) {
			return renderToolResult("question", result, options, theme, context, {
				collapsedSummary: (toolResult) => {
					const details = toolResult.details as QuestionDetails | undefined;
					if (!details) return "Question flow finished";
					if (details.cancelled) return `Cancelled · ${details.answers.length} answers retained`;
					return `${details.answers.length} answer${details.answers.length === 1 ? "" : "s"} received`;
				},
			});
		},
	});
}
