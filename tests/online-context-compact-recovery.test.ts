/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { CompactOptions } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import { createOnlineContextCompactExtension } from "../src/sol-pi/extensions/online-context-compact/extension.ts";
import { restoreOnlineState } from "../src/sol-pi/extensions/online-context-compact/state.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";

async function scenario(error: Error, unrelatedCompactionAfterError = false) {
	const manager = new FakeSessionManager();
	const messages = [{ role: "user" as const, content: "old ".repeat(4_000), timestamp: 1 }, fauxAssistantMessage("tail ".repeat(400))];
	for (const message of messages) manager.appendMessage(message);
	const pi = new FakePi(manager);
	createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5, keepRecentTokens: 1 })(pi.asExtensionApi());
	const abort = vi.fn();
	const compact = vi.fn((options: CompactOptions = {}) => {
		options.onError?.(error);
		if (unrelatedCompactionAfterError) {
			const entry = { type: "compaction", id: "unrelated", parentId: manager.getLeafId(), timestamp: new Date().toISOString(), summary: "memo", firstKeptEntryId: manager.entries[1]!.id, tokensBefore: 195_000 };
			void pi.emit("session_compact", { compactionEntry: entry, fromExtension: false }, ctx);
		}
	});
	// Deferred hosts stay idle until every agent_settled handler returns.
	const ctx = fakeContext(manager, { abort, compact, isIdle: () => true,
		getContextUsage: () => ({ tokens: 195_000, contextWindow: 200_000, percent: 97.5 }) });
	await pi.emit("session_start", {}, ctx);
	await pi.emitContext(messages, ctx);
	async function boundary(id: string) {
		await pi.emit("before_provider_request", {}, ctx);
		const steps = [{ id, goal: "do work", status: "completed" }, { id: "remaining", goal: "remaining work", status: "pending" }];
		await pi.tool("update_plan").execute(`${id}-open`, { steps: steps.map((step) => step.id === id ? { ...step, status: "in_progress" } : step) }, undefined, undefined, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		await pi.tool("update_plan").execute(id, { steps }, undefined, undefined, ctx);
		await pi.emit("turn_end", { message: fauxAssistantMessage("boundary"), toolResults: [{ toolCallId: id, toolName: "update_plan", isError: false }] }, ctx);
	}
	return { pi, manager, ctx, abort, compact, boundary };
}

describe("Online Context Compact recovery", () => {
	it.each([
		"Nothing to compact (session too small)",
		"Already compacted",
		"Summarization failed: generation hit the token cap and the summary is incomplete",
	])("continues with existing context after %s without retrying plan chatter", async (message) => {
		const { pi, manager, ctx, boundary, compact, abort } = await scenario(new Error(message));
		await boundary("first");
		await expect(pi.emit("agent_settled", {}, ctx)).resolves.toBeUndefined();
		expect(pi.sentMessages).toHaveLength(1);
		expect(pi.sentMessages[0]?.options?.triggerTurn).toBe(true);
		expect(restoreOnlineState(manager.entries)).toMatchObject({ nativeCompactionCount: 0, cacheDebtTokens: 0, cacheDebtRepaymentTokens: 0 });
		for (const id of ["restated", "rekeyed-again"]) {
			await boundary(id);
			await pi.emit("agent_settled", {}, ctx);
		}
		expect(abort).toHaveBeenCalledOnce();
		expect(compact).toHaveBeenCalledOnce();
		expect(pi.sentMessages).toHaveLength(1);
		await pi.emit("turn_end", { message: fauxAssistantMessage("new work"), toolResults: [{ toolName: "bash", isError: false }] }, ctx);
		await boundary("genuine-progress");
		await pi.emit("agent_settled", {}, ctx);
		expect(compact).toHaveBeenCalledTimes(2);
	});

	it.each([new Error("Compaction cancelled"), Object.assign(new Error("cancelled"), { name: "AbortError" })])("does not resume cancelled work: $name / $message", async (error) => {
		const { pi, ctx, boundary } = await scenario(error);
		await boundary("first");
		await expect(pi.emit("agent_settled", {}, ctx)).resolves.toBeUndefined();
		expect(pi.sentMessages).toHaveLength(0);
	});

	it("reports unknown compaction failures without continuing", async () => {
		const { pi, ctx, boundary } = await scenario(new Error("summarizer unavailable"));
		await boundary("first");
		await expect(pi.emit("agent_settled", {}, ctx)).rejects.toThrow("summarizer unavailable");
		expect(pi.sentMessages).toHaveLength(0);
	});

	it("does not charge a failed attempt to another compaction during recovery", async () => {
		const { pi, ctx, manager, boundary } = await scenario(new Error("Already compacted"), true);
		await boundary("first");
		await pi.emit("agent_settled", {}, ctx);
		expect(restoreOnlineState(manager.entries)).toMatchObject({ nativeCompactionCount: 1, cacheDebtTokens: 0, cacheDebtRepaymentTokens: 0 });
	});
});
