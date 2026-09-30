/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/** Drive OCC's real plan transitions and public lifecycle hooks; no model or summarizer is called. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactOptions, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/sol-pi/config.ts";
import { createOnlineContextCompactExtension, type PlanUpdateInput } from "../src/sol-pi/extensions/online-context-compact/index.ts";
import { registerConfiguredFeatures } from "../src/sol-pi/index.ts";
import type { RequestLedgerRecorder } from "../src/sol-pi/request-ledger.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";
import { waitForLedger } from "./request-ledger-fixtures.ts";

const MODEL = fauxProvider({ models: [{
	id: "ledger-test-model", contextWindow: 200_000,
	cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 2.5 },
}] }).getModel();
const OPEN = [
	{ id: "build", goal: "Build the synthetic project", status: "in_progress" },
	{ id: "verify", goal: "Verify the synthetic project", status: "pending" },
] as const;
const DONE = [{ ...OPEN[0], status: "completed" }, OPEN[1]] as const;
const PRESSURE_TOKENS = 195_000;
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "sol-pi-ledger-occ-")); });
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

async function plan(pi: FakePi, context: ExtensionContext, id: string, steps: PlanUpdateInput["steps"]) {
	return pi.tool("update_plan").execute(id, { steps }, undefined, undefined, context);
}

function turn(message: AgentMessage = fauxAssistantMessage("boundary")) {
	return {
		type: "turn_end", turnIndex: 1, message,
		toolResults: [{ role: "toolResult", toolCallId: "plan-done", toolName: "update_plan", content: [], isError: false, timestamp: 0 }],
	};
}

function compaction(summary = "摘要🙂", cost?: number) {
	return {
		type: "session_compact", reason: "manual", fromExtension: false, willRetry: false,
		compactionEntry: {
			type: "compaction", id: "compaction-1", parentId: null, timestamp: new Date(0).toISOString(),
			summary, firstKeptEntryId: "message-1", tokensBefore: PRESSURE_TOKENS,
			...(cost === undefined ? {} : { usage: {
				input: 100, output: 10, cacheRead: 50, cacheWrite: 0, totalTokens: 160,
				cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
			} }),
		},
	};
}

async function fixture(overrides: Partial<ExtensionContext> = {}, history = true) {
	const manager = new FakeSessionManager([], "session-a", directory);
	if (history) {
		manager.appendMessage({ role: "user", content: `old ${"x".repeat(12_000)}`, timestamp: 0 });
		manager.appendMessage(fauxAssistantMessage(`work ${"y".repeat(2_000)}`));
	}
	const pi = new FakePi(manager);
	const recordDiagnostic = vi.fn<RequestLedgerRecorder>();
	createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5, keepRecentTokens: 1, recordDiagnostic })(pi.asExtensionApi());
	const abort = vi.fn();
	const context = fakeContext(manager, {
		model: MODEL, abort, isIdle: () => true, getSystemPrompt: () => "Synthetic system instructions",
		getContextUsage: () => ({ tokens: 7_000, contextWindow: MODEL.contextWindow, percent: 3.5 }),
		...overrides,
	});
	await pi.emit("session_start", { type: "session_start" }, context);
	return { pi, context, abort, recordDiagnostic };
}

async function completeBoundary(pi: FakePi, context: ExtensionContext) {
	await plan(pi, context, "plan-open", OPEN);
	// Faux streams do not invoke onPayload; dispatch the provider hook explicitly.
	await pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, context);
	const result = await plan(pi, context, "plan-done", DONE);
	expect(result.details).toMatchObject({ boundary: true });
}

function decisionFields(outcome: "defer" | "compact", reason: string, contextTokens: number) {
	return {
		event: "occ_boundary", outcome, reason, planSteps: 2, completedIntervals: 1,
		// One sampled request for the remaining step, plus the final response.
		expectedRemainingRequests: 2,
		breakevenRequests: expect.any(Number), combinedBreakevenRequests: expect.any(Number),
		writeTokens: expect.any(Number), archiveTokens: expect.any(Number), memoTokens: expect.any(Number),
		summaryCostTokens: expect.any(Number), contextTokens, contextWindowTokens: MODEL.contextWindow,
		carriedDebtTokens: 0,
	};
}

describe("OCC request ledger diagnostics", () => {
	it("emits nothing without a newly completed boundary, including imported completed steps", async () => {
		const { pi, context, recordDiagnostic } = await fixture();
		await pi.emit("turn_end", turn(), context);
		await plan(pi, context, "imported-done", DONE);
		await pi.emit("turn_end", turn(), context);
		expect(recordDiagnostic).not.toHaveBeenCalled();
	});

	it.each(["assistant error", "assistant aborted", "user message", "cancelled context", "missing result", "mismatched result", "failed result"])(
		"records one turn_failed outcome for %s and consumes the pending boundary", async (failure) => {
			const controller = new AbortController();
			const { pi, context, abort, recordDiagnostic } = await fixture({ signal: controller.signal });
			await completeBoundary(pi, context);
			const event = turn();
			if (failure === "assistant error") event.message = fauxAssistantMessage("failed", { stopReason: "error" });
			if (failure === "assistant aborted") event.message = fauxAssistantMessage("aborted", { stopReason: "aborted" });
			if (failure === "user message") event.message = { role: "user", content: "unexpected", timestamp: 0 };
			if (failure === "cancelled context") controller.abort();
			if (failure === "missing result") event.toolResults = [];
			if (failure === "mismatched result") event.toolResults = event.toolResults.map((result) => ({ ...result, toolCallId: "other-call" }));
			if (failure === "failed result") event.toolResults = event.toolResults.map((result) => ({ ...result, isError: true }));
			await pi.emit("turn_end", event, context);
			await pi.emit("turn_end", event, context);
			expect(recordDiagnostic).toHaveBeenCalledExactlyOnceWith(context, { event: "occ_boundary", outcome: "turn_failed" });
			expect(abort).not.toHaveBeenCalled();
		},
	);

	it("records estimate_unavailable when no conversation can be summarized", async () => {
		const { pi, context, abort, recordDiagnostic } = await fixture({}, false);
		await completeBoundary(pi, context);
		await pi.emit("turn_end", turn(), context);
		expect(recordDiagnostic).toHaveBeenCalledExactlyOnceWith(context, { event: "occ_boundary", outcome: "estimate_unavailable" });
		expect(abort).not.toHaveBeenCalled();
	});

	it("reports a deferred decision with horizon and token cost fields", async () => {
		const { pi, context, abort, recordDiagnostic } = await fixture();
		await completeBoundary(pi, context);
		await pi.emit("turn_end", turn(), context);
		expect(recordDiagnostic).toHaveBeenCalledExactlyOnceWith(context, decisionFields("defer", "deferred_economic", 7_000));
		expect(abort).not.toHaveBeenCalled();
	});

	it("preserves unavailable summary prices and break-even estimates as null", async () => {
		const { pi, context, recordDiagnostic } = await fixture({ model: undefined });
		await completeBoundary(pi, context);
		await pi.emit("turn_end", turn(), context);
		expect(recordDiagnostic).toHaveBeenCalledExactlyOnceWith(context, {
			...decisionFields("defer", "summary_cost_unavailable", 7_000),
			summaryCostTokens: null, breakevenRequests: null, combinedBreakevenRequests: null,
		});
	});

	it("reports compact before aborting and suppresses another decision while compaction is selected", async () => {
		const { pi, context, abort, recordDiagnostic } = await fixture({
			getContextUsage: () => ({ tokens: PRESSURE_TOKENS, contextWindow: MODEL.contextWindow, percent: 97.5 }),
		});
		await completeBoundary(pi, context);
		await pi.emit("turn_end", turn(), context);
		expect(recordDiagnostic).toHaveBeenCalledExactlyOnceWith(context, decisionFields("compact", "window_protection", PRESSURE_TOKENS));
		expect(abort).toHaveBeenCalledOnce();
		expect(recordDiagnostic.mock.invocationCallOrder[0]).toBeLessThan(abort.mock.invocationCallOrder[0] ?? 0);
		await plan(pi, context, "second-done", DONE.map((step) => ({ ...step, status: "completed" })));
		const secondTurn = turn();
		secondTurn.toolResults = secondTurn.toolResults.map((result) => ({ ...result, toolCallId: "second-done" }));
		await pi.emit("turn_end", secondTurn, context);
		expect(recordDiagnostic).toHaveBeenCalledTimes(1);
	});

	it.each([undefined, 0, 0.003])("records external compaction usage without inventing boundary debt: %j", async (cost) => {
		const { pi, context, recordDiagnostic } = await fixture();
		const event = compaction("摘要🙂", cost);
		event.fromExtension = true;
		await pi.emit("session_compact", event, context);
		expect(recordDiagnostic).toHaveBeenCalledExactlyOnceWith(context, {
			event: "occ_compaction", boundary: false, trigger: "manual", fromExtension: true,
			summaryTokens: 3, debtTokens: 0, repaymentTokens: 0, summaryCostReported: cost ?? null,
		});
	});

	it("reports measured summary cost and boundary debt after selected compaction finishes", async () => {
		const { pi, context, recordDiagnostic } = await fixture({
			getContextUsage: () => ({ tokens: PRESSURE_TOKENS, contextWindow: MODEL.contextWindow, percent: 97.5 }),
		});
		await completeBoundary(pi, context);
		await pi.emit("turn_end", turn(), context);
		const event = compaction("summary", 0.002);
		const compact = vi.fn((options: CompactOptions = {}) => {
			void pi.emit("session_compact", event, context).then(() => options.onComplete?.(event.compactionEntry));
		});
		await pi.emit("agent_settled", {}, { ...context, compact });
		expect(compact).toHaveBeenCalledOnce();
		const boundary = recordDiagnostic.mock.calls[0]?.[1];
		const writeTokens = boundary?.writeTokens;
		const archiveTokens = boundary?.archiveTokens;
		if (typeof writeTokens !== "number" || typeof archiveTokens !== "number") throw new Error("Missing boundary cost metrics");
		expect(recordDiagnostic.mock.calls[1]?.[1]).toEqual({
			event: "occ_compaction", boundary: true, trigger: "manual", fromExtension: false,
			summaryTokens: 2,
			debtTokens: (writeTokens - archiveTokens + 2) * 11.5 + 2_000,
			repaymentTokens: archiveTokens - 2,
			summaryCostReported: 0.002,
		});
		expect(recordDiagnostic).toHaveBeenCalledTimes(2);
	});
});

describe("request ledger entrypoint wiring", () => {
	it.each([false, true])("keeps a disabled ledger absent when OCC is %j", async (onlineContextCompact) => {
		const manager = new FakeSessionManager([], "session-a", directory);
		const pi = new FakePi(manager);
		registerConfiguredFeatures(pi.asExtensionApi(), { ...DEFAULT_CONFIG, onlineContextCompact });
		expect(pi.handlers.has("message_end")).toBe(false);
		expect(pi.handlers.get("before_provider_request")?.length ?? 0).toBe(onlineContextCompact ? 1 : 0);
		if (!onlineContextCompact) expect(pi.handlers.size).toBe(0);
		const context = fakeContext(manager);
		await pi.emit("before_provider_request", { payload: {} }, context);
		await pi.emit("message_end", { message: fauxAssistantMessage("ignored") }, context);
		if (onlineContextCompact) {
			await completeBoundary(pi, context);
			await pi.emit("turn_end", turn(), context);
			await pi.emit("session_compact", compaction(), context);
		}
		expect(existsSync(join(directory, "sol-pi"))).toBe(false);
	});

	it("can enable the ledger without enabling any mechanism", async () => {
		const manager = new FakeSessionManager([], "session-a", directory);
		const pi = new FakePi(manager);
		registerConfiguredFeatures(pi.asExtensionApi(), { ...DEFAULT_CONFIG, requestLedger: true });
		expect(pi.registeredTools).toEqual([]);
		expect([...pi.handlers.keys()].sort()).toEqual(["before_provider_request", "message_end"]);
		await pi.emit("before_provider_request", { payload: { input: [] } }, fakeContext(manager));
		await waitForLedger(join(directory, "sol-pi", "session-a", "request-ledger.jsonl"), 1);
	});

	it("registers the ledger first and routes both OCC diagnostic events into its request run", async () => {
		const manager = new FakeSessionManager([], "session-a", directory);
		const pi = new FakePi(manager);
		const registration = vi.spyOn(pi, "on");
		registerConfiguredFeatures(pi.asExtensionApi(), { ...DEFAULT_CONFIG, requestLedger: true, onlineContextCompact: true });
		expect(registration.mock.calls.slice(0, 2).map(([name]) => name)).toEqual(["before_provider_request", "message_end"]);
		expect(pi.handlers.get("before_provider_request")).toHaveLength(2);
		expect(pi.handlers.get("message_end")).toHaveLength(1);
		const context = fakeContext(manager);
		await pi.emit("session_start", { type: "session_start" }, context);
		await completeBoundary(pi, context);
		await pi.emit("message_end", { message: fauxAssistantMessage("completed") }, context);
		await pi.emit("turn_end", turn(), context);
		await pi.emit("session_compact", compaction(), context);
		const { rows } = await waitForLedger(join(directory, "sol-pi", "session-a", "request-ledger.jsonl"), 4);
		expect(rows.map((row) => [row.event, row.request])).toEqual([["request", 1], ["response", 1], ["occ_boundary", 1], ["occ_compaction", 1]]);
		expect(rows[2]).toMatchObject({ outcome: "estimate_unavailable" });
		expect(rows[3]).toMatchObject({ boundary: false, trigger: "manual", fromExtension: false, summaryTokens: 3, debtTokens: 0, repaymentTokens: 0, summaryCostReported: null });
		expect(new Set(rows.map((row) => row.run)).size).toBe(1);
	});
});
