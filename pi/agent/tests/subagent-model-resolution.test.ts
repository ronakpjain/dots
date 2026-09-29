import { describe, expect, test } from "bun:test";
import { resolveModel } from "../extensions/subagents/index.ts";

const openRouterModel = {
	provider: "openrouter",
	id: "deepseek/deepseek-v4.1-flash",
	name: "DeepSeek V4.1 Flash",
	contextWindow: 128_000,
	maxTokens: 8_192,
};

function resolve(requested: string) {
	return resolveModel(requested, {
		model: undefined,
		modelRegistry: { getAvailable: () => [openRouterModel] },
	});
}

describe("subagent model resolution", () => {
	test("resolves provider-qualified OpenRouter IDs containing slashes", () => {
		expect(resolve("openrouter/deepseek/deepseek-v4.1-flash")).toMatchObject({
			ok: true,
			model: {
				modelId: "openrouter/deepseek/deepseek-v4.1-flash",
				provider: "openrouter",
				id: "deepseek/deepseek-v4.1-flash",
			},
		});
	});

	test("keeps provider wildcards working for providers with nested model IDs", () => {
		expect(resolve("openrouter/*")).toMatchObject({
			ok: true,
			model: { modelId: "openrouter/deepseek/deepseek-v4.1-flash" },
		});
	});
});
