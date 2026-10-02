/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import {
	BOUNDARY_COMPACTION_INSTRUCTIONS,
	createOnlineContextCompactExtension,
	POST_COMPACTION_PLAN_REMINDER,
} from "../src/sol-pi/extensions/online-context-compact/extension.ts";

const OPEN = [{ id: "build", goal: "build it", status: "in_progress" }] as const;
const DONE = [{ id: "build", goal: "build it", status: "completed" }] as const;
const PROGRESS = {
	files_changed: ["src/a.ts"],
	verification: ["tests passed"],
	decisions: ["kept the implementation small"],
};

const PLAN_REPLAY_COUNT = 3;

type CompactionRequest = { customInstructions?: string; reason: string };

async function runCompactionScenario(
	requestedCompactions: 1 | 2,
	{ mixedBatch = false, cancelAtBoundary = false, failCompaction = false, replayPlan }: {
		mixedBatch?: boolean;
		cancelAtBoundary?: boolean;
		failCompaction?: boolean;
		replayPlan?: "same-ids" | "new-ids";
	} = {},
): Promise<void> {
	const cwd = await mkdtemp(join(tmpdir(), "sol-pi-occ-session-"));
	const agentDir = join(cwd, "agent");
	await mkdir(agentDir);

	let session: AgentSession | undefined;
	// Keep the second compaction profitable when Pi retains the entire latest turn.
	const historySegmentCharacters = 12_000;
	try {
		const finalReply = `final reply after ${requestedCompactions} online compaction${requestedCompactions === 1 ? "" : "s"}`;
		const faux = fauxProvider({
			provider: `sol-pi-occ-session-${requestedCompactions}`,
			api: `sol-pi-occ-session-api-${requestedCompactions}`,
			models: [{ id: `sol-pi-occ-session-model-${requestedCompactions}`, contextWindow: 4_096, maxTokens: 1_024 }],
		});
		const responses: FauxResponseStep[] = [];
		for (let ordinal = 1; ordinal <= requestedCompactions; ordinal++) {
			const openPlan = fauxToolCall("update_plan", { steps: OPEN }, { id: `plan-open-${ordinal}` });
			const donePlan = fauxToolCall(
				"update_plan",
				{ steps: DONE, progress: PROGRESS },
				{ id: `plan-done-${ordinal}` },
			);
			if (mixedBatch) {
				responses.push(fauxAssistantMessage([openPlan, donePlan], { stopReason: "toolUse" }));
			} else {
				responses.push(
					fauxAssistantMessage(
						ordinal === 1 ? openPlan : [fauxText(`second phase work ${"z".repeat(historySegmentCharacters)}`), openPlan],
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage(donePlan, { stopReason: "toolUse" }),
				);
			}
			if (replayPlan) {
				const restored = [
					{ ...DONE[0], id: replayPlan === "new-ids" ? `restored-${ordinal}` : DONE[0].id },
					{ id: "verify", goal: "verify the result", status: "in_progress" },
				];
				for (let replay = 0; replay < PLAN_REPLAY_COUNT; replay++) {
					responses.push(fauxAssistantMessage(
						fauxToolCall("update_plan", { steps: restored }, { id: `replay-${ordinal}-${replay}` }),
						{ stopReason: "toolUse" },
					));
				}
			}
		}
		responses.push(async () => {
			if (failCompaction) throw new Error("simulated compaction failure");
			await new Promise((resolve) => setTimeout(resolve, 80));
			return fauxAssistantMessage(finalReply);
		});
		faux.setResponses(responses);

		let cancelledTurnObserved = false;
		const compactionRequests: CompactionRequest[] = [];
		const extension: ExtensionFactory = (pi) => {
			pi.registerProvider(faux.provider);
			createOnlineContextCompactExtension({ cacheWriteReadRatio: 0, keepRecentTokens: 150 })(pi);
			if (cancelAtBoundary) {
				pi.on("tool_result", (event, context) => {
					if (event.toolCallId === "plan-done-1") context.abort();
				});
				pi.on("turn_end", (_event, context) => {
					cancelledTurnObserved = context.signal?.aborted === true;
				});
			}
			pi.on("session_before_compact", (event) => {
				compactionRequests.push({ customInstructions: event.customInstructions, reason: event.reason });
				if (failCompaction) return;
				return {
					compaction: {
						summary: `deterministic compacted history ${"s".repeat(historySegmentCharacters)}`,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				};
			});
		};

		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false, keepRecentTokens: 150, reserveTokens: 1_024 },
			retry: { enabled: false },
		});
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `historical request ${"x".repeat(historySegmentCharacters)}` }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage(fauxAssistantMessage(`historical response ${"y".repeat(historySegmentCharacters)}`));
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [{ name: `online-context-compact-session-test-${requestedCompactions}`, factory: extension }],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "You are a deterministic lifecycle test assistant.",
		});
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);

		const created = await createAgentSession({
			cwd,
			agentDir,
			model: faux.getModel(),
			thinkingLevel: "off",
			tools: ["update_plan"],
			resourceLoader,
			sessionManager,
			settingsManager,
		});
		session = created.session;
		const extensionErrors: string[] = [];
		session.extensionRunner.onError(({ error }) => extensionErrors.push(error));
		let settledCount = 0;
		session.subscribe((event) => {
			if (event.type === "agent_settled") settledCount++;
		});

		await session.prompt("finish the current plan step", {
			expandPromptTemplates: false,
			source: "interactive",
		});
		if (failCompaction) {
			expect(extensionErrors.some((error) => error.includes("simulated compaction failure"))).toBe(true);
			expect(compactionRequests).toHaveLength(1);
			const branch = sessionManager.getBranch();
			expect(branch.some((entry) => entry.type === "compaction")).toBe(false);
			expect(
				branch.some((entry) => entry.type === "custom_message" && entry.customType === "sol-pi-online-context-compact"),
			).toBe(false);
			expect(faux.state.callCount).toBe(3);
			expect(settledCount).toBe(1);
			expect(session.isIdle).toBe(true);
			return;
		}
		expect(extensionErrors).toEqual([]);
		if (cancelAtBoundary) {
			expect(compactionRequests).toEqual([]);
			const branch = sessionManager.getBranch();
			expect(cancelledTurnObserved).toBe(true);
			expect(
				branch.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === "plan-done-1" &&
						!entry.message.isError,
				),
			).toBe(true);
			expect(branch.some((entry) => entry.type === "compaction")).toBe(false);
			expect(
				branch.some((entry) => entry.type === "custom_message" && entry.customType === "sol-pi-online-context-compact"),
			).toBe(false);
			expect(faux.state.callCount).toBe(2);
			expect(settledCount).toBe(1);
			expect(session.isIdle).toBe(true);
			return;
		}

		expect(compactionRequests).toEqual(
			Array.from({ length: requestedCompactions }, () => ({
				customInstructions: BOUNDARY_COMPACTION_INSTRUCTIONS,
				reason: "manual",
			})),
		);
		const branch = sessionManager.getBranch();
		expect(branch.filter((entry) => entry.type === "compaction")).toHaveLength(requestedCompactions);
		const assistantFailures = branch.flatMap((entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			(entry.message.stopReason === "error" || entry.message.stopReason === "aborted")
				? [{
						stopReason: entry.message.stopReason,
						errorMessage: entry.message.errorMessage,
						content: entry.message.content,
					}]
				: [],
		);
		expect(assistantFailures).toEqual(
			Array.from({ length: requestedCompactions }, () => ({
				stopReason: "error",
				errorMessage: "This operation was aborted",
				content: [],
			})),
		);
		expect(
			branch.filter(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "sol-pi-online-context-compact" &&
					entry.content === POST_COMPACTION_PLAN_REMINDER &&
					entry.display === false,
			),
		).toHaveLength(requestedCompactions);
		expect(faux.state.callCount).toBe(requestedCompactions * ((mixedBatch ? 1 : 2) + (replayPlan ? PLAN_REPLAY_COUNT : 0)) + 1);
		expect(session.getLastAssistantText()).toBe(finalReply);
		expect(settledCount).toBe(requestedCompactions + 1);
		expect(session.isStreaming).toBe(false);
		expect(session.isIdle).toBe(true);
	} finally {
		session?.dispose();
		await rm(cwd, { recursive: true, force: true });
	}
}

describe("Online Context Compact with a real AgentSession", () => {
	it("settles the automatic continuation before the original prompt returns", async () => {
		await runCompactionScenario(1);
	}, 10_000);

	it("compacts before another provider request when plan calls share a tool batch", async () => {
		await runCompactionScenario(1, { mixedBatch: true });
	}, 10_000);

	it("leaves an externally cancelled boundary without compaction or continuation", async () => {
		await runCompactionScenario(1, { cancelAtBoundary: true });
	}, 10_000);

	it("reports a native compaction failure without scheduling a continuation", async () => {
		await runCompactionScenario(1, { failCompaction: true });
	}, 10_000);

	it.each(["same-ids", "new-ids"] as const)("does not recompact a restored plan with %s", async (replayPlan) => {
		await runCompactionScenario(1, { replayPlan });
	}, 10_000);

	it("accepts real progress after plan restoration without counting the restoration", async () => {
		await runCompactionScenario(2, { replayPlan: "same-ids" });
	}, 10_000);

	it("settles two consecutive automatic compactions before the original prompt returns", async () => {
		await runCompactionScenario(2);
	}, 10_000);
});
