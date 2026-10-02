/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildSessionContext, estimateTokens } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import { createOnlineContextCompactExtension } from "../src/sol-pi/extensions/online-context-compact/extension.ts";
import type { RequestLedgerRecorder } from "../src/sol-pi/request-ledger.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";

const USER: AgentMessage = { role: "user", content: "source request ".repeat(800), timestamp: 1 };
const TOOL: AgentMessage = { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "raw result ".repeat(2_000) }], isError: false, timestamp: 2 };
const MODEL = fauxProvider({ models: [{ id: "projection", contextWindow: 200_000, cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 2.5 } }] }).getModel();

async function estimate(project: (messages: AgentMessage[]) => AgentMessage[], options: { duplicateTool?: boolean; previousCompaction?: boolean; observe?: boolean } = {}) {
	const manager = new FakeSessionManager();
	for (const message of [USER, TOOL, ...(options.duplicateTool ? [TOOL] : []), fauxAssistantMessage("done"), { role: "user" as const, content: "recent work", timestamp: 3 }, fauxAssistantMessage("tail")]) manager.appendMessage(message);
	if (options.previousCompaction) manager.entries.push({ type: "compaction", id: "prior", parentId: manager.getLeafId(), timestamp: new Date(0).toISOString(), summary: "previous summary ".repeat(300), firstKeptEntryId: manager.entries[1]!.id, tokensBefore: 30_000 });
	const pi = new FakePi(manager);
	const recordDiagnostic = vi.fn<RequestLedgerRecorder>();
	createOnlineContextCompactExtension({ keepRecentTokens: 1, cacheWriteReadRatio: 12.5, recordDiagnostic })(pi.asExtensionApi());
	const context = fakeContext(manager, { model: MODEL, getContextUsage: () => ({ tokens: 195_000, contextWindow: 200_000, percent: 97.5 }) });
	await pi.emit("session_start", {}, context);
	if (options.observe !== false) await pi.emitContext(project(buildSessionContext(manager.entries).messages), context);
	const steps = [{ id: "work", goal: "work", status: "in_progress" }, { id: "next", goal: "next", status: "pending" }];
	await pi.tool("update_plan").execute("open", { steps }, undefined, undefined, context);
	await pi.emit("before_provider_request", {}, context);
	await pi.tool("update_plan").execute("done", { steps: [{ ...steps[0], status: "completed" }, steps[1]] }, undefined, undefined, context);
	await pi.emit("turn_end", { message: fauxAssistantMessage("boundary"), toolResults: [{ toolCallId: "done", toolName: "update_plan", isError: false }] }, context);
	const decision = recordDiagnostic.mock.calls.map(([, entry]) => entry).find((entry) => entry.event === "occ_boundary");
	expect(decision).toBeDefined();
	return decision!;
}

const identity = (messages: AgentMessage[]) => messages;

describe("OCC provider-visible savings", () => {
	it("prices raw summarization separately from a shortened tool projection", async () => {
		const raw = await estimate(identity);
		const short: AgentMessage = { ...TOOL, content: [{ type: "text", text: "receipt" }] };
		const projected = await estimate((messages) => messages.map((message) => message.role === "toolResult" ? short : message));
		expect(projected.archiveTokens).toBe(Number(raw.archiveTokens) - estimateTokens(TOOL) + estimateTokens(short));
		expect(projected.summaryCostTokens).toBe(raw.summaryCostTokens);
	});

	it.each(["dropped", "rewritten", "different tool", "duplicated"])("does not claim raw savings for a %s projection", async (shape) => {
		const raw = await estimate(identity);
		const projected = await estimate((messages) => {
			if (shape === "dropped") return messages.filter((message) => message.role !== "toolResult");
			if (shape === "rewritten") return messages.map((message) => message === USER ? { ...USER, content: "rewritten" } : message);
			if (shape === "different tool") return messages.map((message) => message.role === "toolResult" ? { ...message, toolName: "bash" } : message);
			return messages;
		}, { duplicateTool: shape === "duplicated" });
		expect(projected.archiveTokens).toBe(Number(raw.archiveTokens) - estimateTokens(shape === "rewritten" ? USER : TOOL));
	});

	it("includes only the active previous summary and retained history", async () => {
		const full = await estimate(identity, { previousCompaction: true });
		const dropped = await estimate((messages) => messages.filter((message) => message.role !== "compactionSummary"), { previousCompaction: true });
		expect(Number(full.archiveTokens)).toBeGreaterThan(Number(dropped.archiveTokens));
		expect(dropped.summaryCostTokens).toBe(full.summaryCostTokens);
	});

	it("cannot establish savings from restored raw history before observing context", async () => {
		const decision = await estimate(identity, { observe: false });
		expect(decision).toMatchObject({ archiveTokens: 0, outcome: "defer", reason: "non_positive_saving" });
	});
});
