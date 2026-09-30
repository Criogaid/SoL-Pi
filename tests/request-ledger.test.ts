/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/** Exercise real ledger files through public extension hooks, including failures and session isolation. */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRequestLedger, REQUEST_LEDGER_FILE } from "../src/sol-pi/request-ledger.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";
import { waitForLedger } from "./request-ledger-fixtures.ts";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "sol-pi-request-ledger-")); });
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

function fixture(sessionId = "session-a", sessionDir = directory) {
	const manager = new FakeSessionManager([], sessionId, sessionDir);
	const pi = new FakePi(manager);
	const record = registerRequestLedger(pi.asExtensionApi());
	const model = fauxProvider().getModel();
	const context = fakeContext(manager, { model });
	const path = join(sessionDir, "sol-pi", sessionId, "request-ledger.jsonl");
	return { manager, pi, record, model, context, path };
}

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

const TOOLS = [{ name: "read", description: "Read a synthetic fixture", parameters: { type: "object" } }];
const INSTRUCTIONS = "Synthetic system instructions";
const INPUT = [
	{ role: "user", content: "first question" },
	{ role: "assistant", content: "first answer" },
	{ role: "user", content: "second question" },
];
const PAYLOAD = { model: "synthetic", tools: TOOLS, instructions: INSTRUCTIONS, input: INPUT, stream: true };

function request(payload: unknown = PAYLOAD) {
	return { type: "before_provider_request", payload };
}

describe("request ledger lifecycle", () => {
	it("registers only the two diagnostic hooks and writes the request envelope without content", async () => {
		const { pi, model, context, path } = fixture();
		expect(REQUEST_LEDGER_FILE).toBe("request-ledger.jsonl");
		expect([...pi.handlers.keys()].sort()).toEqual(["before_provider_request", "message_end"]);
		expect(pi.registeredTools).toEqual([]);
		await expect(pi.emit("before_provider_request", request(), context)).resolves.toBeUndefined();
		const { rows } = await waitForLedger(path, 1);
		expect(rows).toEqual([{
			timestamp: expect.any(String), run: expect.any(String), event: "request", request: 1,
			provider: model.provider, model: model.id, api: model.api,
			bytes: jsonBytes(PAYLOAD), optionBytes: jsonBytes(PAYLOAD.model) + jsonBytes(true), units: 5,
			sharedUnits: null, sharedBytes: null,
			toolsHash: expect.stringMatching(/^[a-f0-9]{12}$/u), systemHash: expect.stringMatching(/^[a-f0-9]{12}$/u),
			categories: {
				tools: { items: 1, bytes: jsonBytes(TOOLS) },
				system: { items: 1, bytes: jsonBytes(INSTRUCTIONS) },
				user: { items: 2, bytes: jsonBytes(INPUT[0]) + jsonBytes(INPUT[2]) },
				assistant_text: { items: 1, bytes: jsonBytes(INPUT[1]) },
			},
		}]);
		for (const row of rows) {
			expect(row.run.length).toBeGreaterThan(0);
			expect(new Date(row.timestamp).toISOString()).toBe(row.timestamp);
		}
	});

	it("tracks identical, appended, shortened, and middle-changed prefixes independently of options", async () => {
		const { pi, context, path } = fixture();
		const payloads = [
			PAYLOAD,
			structuredClone(PAYLOAD),
			{ ...PAYLOAD, model: "other-synthetic", stream: false },
			{ ...PAYLOAD, input: [...INPUT, { role: "assistant", content: "second answer" }] },
			{ ...PAYLOAD, input: [INPUT[0]] },
			{ ...PAYLOAD, input: [INPUT[0], { role: "assistant", content: "changed" }, INPUT[2]] },
			PAYLOAD,
		];
		for (const payload of payloads) await pi.emit("before_provider_request", request(payload), context);
		const { rows } = await waitForLedger(path, payloads.length);
		const prefixBytes = jsonBytes(TOOLS) + jsonBytes(INSTRUCTIONS) + jsonBytes(INPUT[0]);
		const allBytes = prefixBytes + jsonBytes(INPUT[1]) + jsonBytes(INPUT[2]);
		expect(rows.map((row) => [row.request, row.sharedUnits, row.sharedBytes])).toEqual([
			[1, null, null], [2, 5, allBytes], [3, 5, allBytes], [4, 5, allBytes],
			[5, 3, prefixBytes], [6, 3, prefixBytes], [7, 3, prefixBytes],
		]);
		expect(new Set(rows.map((row) => row.toolsHash)).size).toBe(1);
		expect(new Set(rows.map((row) => row.systemHash)).size).toBe(1);
		expect(new Set(rows.map((row) => row.run)).size).toBe(1);
	});

	it("changes tool and system hashes at their respective prefix positions", async () => {
		const { pi, context, path } = fixture();
		const changedTools = [{ ...TOOLS[0], description: "Changed definition" }];
		for (const payload of [PAYLOAD, { ...PAYLOAD, tools: changedTools }, { ...PAYLOAD, tools: changedTools, instructions: "Changed system" }]) {
			await pi.emit("before_provider_request", request(payload), context);
		}
		const { rows } = await waitForLedger(path, 3);
		expect(rows[1]).toMatchObject({ sharedUnits: 0, sharedBytes: 0, systemHash: rows[0]?.systemHash });
		expect(rows[1]?.toolsHash).not.toBe(rows[0]?.toolsHash);
		expect(rows[2]).toMatchObject({ sharedUnits: 1, sharedBytes: jsonBytes(changedTools), toolsHash: rows[1]?.toolsHash });
		expect(rows[2]?.systemHash).not.toBe(rows[1]?.systemHash);
	});

	it("hashes developer and system messages while leaving absent model and tool metadata null", async () => {
		const { pi, manager, path } = fixture();
		const context = fakeContext(manager);
		const input = [{ role: "developer", content: "one" }, { role: "system", content: "two" }];
		for (const payload of [{ input }, { input: [input[0], { role: "system", content: "three" }] }, { input: [] }, { input: [] }]) {
			await pi.emit("before_provider_request", request(payload), context);
		}
		const { rows } = await waitForLedger(path, 4);
		expect(rows[0]).toMatchObject({ provider: null, model: null, api: null, toolsHash: null, systemHash: expect.stringMatching(/^[a-f0-9]{12}$/u) });
		expect(rows[1]?.systemHash).not.toBe(rows[0]?.systemHash);
		expect(rows[1]).toMatchObject({ sharedUnits: 1, sharedBytes: jsonBytes(input[0]) });
		expect(rows[3]).toMatchObject({ units: 0, categories: {}, toolsHash: null, systemHash: null, sharedUnits: 0, sharedBytes: 0 });
	});

	it("counts repeated categories once per unit while retaining all block bytes", async () => {
		const { pi, context, path } = fixture();
		const thinking = [{ type: "thinking", thinking: "one" }, { type: "redacted_thinking", data: "two" }];
		const calls = [1, 2].map((id) => ({ type: "tool_use", id: `read-${id}`, name: "read", input: { path: "fixture.ts" } }));
		const user = { role: "user", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] };
		const assistant = { role: "assistant", content: [...thinking, ...calls] };
		await pi.emit("before_provider_request", request({ messages: [user, assistant] }), context);
		const { rows } = await waitForLedger(path, 1);
		const reasoningBytes = thinking.reduce((sum, block) => sum + jsonBytes(block), 0);
		const callBytes = calls.reduce((sum, block) => sum + jsonBytes(block), 0);
		expect(rows[0]?.categories).toEqual({
			user: { items: 1, bytes: jsonBytes(user) },
			assistant_text: { items: 1, bytes: jsonBytes(assistant) - reasoningBytes - callBytes },
			reasoning: { items: 1, bytes: reasoningBytes },
			"tool_call:read": { items: 1, bytes: callBytes },
		});
	});

	it("isolates counters and prefixes by runtime root and resumes them after switching sessions", async () => {
		const { pi, context, record, path } = fixture();
		const otherId = fakeContext(new FakeSessionManager([], "session-b", directory));
		const otherDirectory = join(directory, "other-sessions");
		const otherRoot = fakeContext(new FakeSessionManager([], "session-a", otherDirectory));
		for (const ctx of [context, otherId, context, otherRoot, otherId]) {
			await pi.emit("before_provider_request", request(), ctx);
			record(ctx, { event: "checkpoint" });
		}
		const first = await waitForLedger(path, 4);
		const second = await waitForLedger(join(directory, "sol-pi", "session-b", REQUEST_LEDGER_FILE), 4);
		const third = await waitForLedger(join(otherDirectory, "sol-pi", "session-a", REQUEST_LEDGER_FILE), 2);
		for (const { rows } of [first, second]) {
			expect(rows.map((row) => [row.event, row.request])).toEqual([["request", 1], ["checkpoint", 1], ["request", 2], ["checkpoint", 2]]);
			expect(rows[0]).toMatchObject({ sharedUnits: null, sharedBytes: null });
			expect(rows[2]?.sharedUnits).toBe(5);
		}
		expect(third.rows[0]).toMatchObject({ request: 1, sharedUnits: null, sharedBytes: null });
		expect(new Set([...first.rows, ...second.rows, ...third.rows].map((row) => row.run)).size).toBe(1);
	});

	it("starts a new run and counter when the extension is registered again for an existing file", async () => {
		const first = fixture();
		await first.pi.emit("before_provider_request", request(), first.context);
		await waitForLedger(first.path, 1);
		const second = fixture();
		await second.pi.emit("before_provider_request", request(), second.context);
		const { rows } = await waitForLedger(first.path, 2);
		expect(rows.map((row) => [row.request, row.sharedUnits, row.sharedBytes])).toEqual([[1, null, null], [1, null, null]]);
		expect(rows[0]?.run).not.toBe(rows[1]?.run);
	});

	it("records only assistant responses, with optional reasoning and the most recent request number", async () => {
		const { pi, record, context, path } = fixture();
		const usage = { input: 11, output: 7, cacheRead: 101, cacheWrite: 13, totalTokens: 132, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
		const message = { ...fauxAssistantMessage("response body"), usage };
		record(context, { event: "before_request", outcome: "ready" });
		await pi.emit("message_end", { message }, context);
		await pi.emit("message_end", { message: { role: "user", content: "ignored", timestamp: 0 } }, context);
		await pi.emit("message_end", { message: { role: "toolResult", toolCallId: "call", toolName: "read", content: [], isError: false, timestamp: 0 } }, context);
		await pi.emit("before_provider_request", request(), context);
		await pi.emit("message_end", { message: { ...message, stopReason: "toolUse", usage: { ...usage, reasoning: 0 } } }, context);
		await pi.emit("before_provider_request", request(), context);
		await pi.emit("message_end", { message: { ...message, stopReason: "error", usage: { ...usage, reasoning: 5 }, errorMessage: "private failure detail" } }, context);
		await pi.emit("before_provider_request", request(), context);
		await pi.emit("message_end", { message: { ...message, stopReason: "aborted" } }, context);
		const entry = { event: "occ_boundary", outcome: "defer" };
		record(context, entry);
		const { rows, text } = await waitForLedger(path, 9);
		expect(entry).toEqual({ event: "occ_boundary", outcome: "defer" });
		expect(rows.map((row) => [row.event, row.request])).toEqual([
			["before_request", null], ["response", null], ["request", 1], ["response", 1],
			["request", 2], ["response", 2], ["request", 3], ["response", 3], ["occ_boundary", 3],
		]);
		const { cost: _cost, ...reportedUsage } = usage;
		expect(rows.filter((row) => row.event === "response").map((row) => [row.stopReason, row.usage])).toEqual([
			["stop", reportedUsage], ["toolUse", { ...reportedUsage, reasoning: 0 }], ["error", { ...reportedUsage, reasoning: 5 }], ["aborted", reportedUsage],
		]);
		expect(text).not.toContain("private failure detail");
		expect(new Set(rows.map((row) => row.run)).size).toBe(1);
	});

	it("preserves rapid request, response, and diagnostic order without awaiting each hook", async () => {
		const { pi, record, context, path } = fixture();
		const count = 30;
		const pending: Promise<unknown>[] = [];
		for (let requestNumber = 1; requestNumber <= count; requestNumber++) {
			pending.push(pi.emit("before_provider_request", request(), context));
			pending.push(pi.emit("message_end", { message: fauxAssistantMessage("result") }, context));
			record(context, { event: "checkpoint", ordinal: requestNumber });
		}
		await Promise.all(pending);
		const { rows } = await waitForLedger(path, count * 3);
		expect(rows.map((row) => [row.event, row.request, row.ordinal ?? null])).toEqual(
			Array.from({ length: count }, (_, index) => [["request", index + 1, null], ["response", index + 1, null], ["checkpoint", index + 1, index + 1]]).flat(),
		);
	});

	it.each(["in-memory session", "missing directory", "unsafe id", "session lookup throws"] as const)("does not write when runtimeRoot fails: %s", async (failure) => {
		const { pi, manager, record, path } = fixture();
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		if (failure === "missing directory") vi.spyOn(manager, "getSessionDir").mockReturnValue("");
		if (failure === "unsafe id") manager.sessionId = "../unsafe";
		if (failure === "session lookup throws") vi.spyOn(manager, "getSessionDir").mockImplementation(() => { throw new Error("no session"); });
		const context = fakeContext(manager, failure === "in-memory session" ? { sessionManager: SessionManager.inMemory(directory) } : {});
		await expect(pi.emit("before_provider_request", request(), context)).resolves.toBeUndefined();
		await expect(pi.emit("message_end", { message: fauxAssistantMessage("ignored") }, context)).resolves.toBeUndefined();
		expect(() => record(context, { event: "ignored" })).not.toThrow();
		// A valid write drains the same queue and proves the failed lookup did not enqueue anything.
		const valid = fakeContext(new FakeSessionManager([], "valid", directory));
		record(valid, { event: "drained" });
		await waitForLedger(join(directory, "sol-pi", "valid", REQUEST_LEDGER_FILE), 1);
		expect(existsSync(path)).toBe(false);
		expect(readdirSync(directory, { recursive: true }).sort()).toEqual([
			"sol-pi", join("sol-pi", "valid"), join("sol-pi", "valid", REQUEST_LEDGER_FILE),
		].sort());
		expect(error).not.toHaveBeenCalled();
	});

	it("reports a filesystem failure without rejecting hooks and recovers for the next request", async () => {
		const { pi, record, context, path } = fixture();
		const blocker = join(directory, "sol-pi");
		writeFileSync(blocker, "This file prevents creating the runtime directory");
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await expect(pi.emit("before_provider_request", request(), context)).resolves.toBeUndefined();
		record(context, { event: "checkpoint" });
		await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2));
		for (const call of error.mock.calls) expect(call).toEqual([expect.stringContaining("[sol-pi] request ledger write failed:")]);
		expect(existsSync(path)).toBe(false);
		rmSync(blocker);
		await pi.emit("before_provider_request", request(), context);
		await pi.emit("message_end", { message: fauxAssistantMessage("recovered") }, context);
		const { rows } = await waitForLedger(path, 2);
		expect(rows.map((row) => [row.event, row.request])).toEqual([["request", 2], ["response", 2]]);
		expect(error).toHaveBeenCalledTimes(2);
	});

	it("never persists body, arguments, option secrets, reasoning, or response error text", async () => {
		const { pi, context, path } = fixture();
		const sentinels = ["SYSTEM_SENTINEL", "SCHEMA_SENTINEL", "USER_SENTINEL", "PATH_SENTINEL", "ARGS_SENTINEL", "RESULT_SENTINEL", "REASONING_SENTINEL", "AUTH_SENTINEL", "RESPONSE_SENTINEL", "ERROR_SENTINEL"];
		const payload = {
			tools: [{ name: "write", description: sentinels[1] }], instructions: sentinels[0],
			input: [
				{ role: "user", content: sentinels[2] },
				{ type: "function_call", call_id: "write-call", name: "write", arguments: JSON.stringify({ path: sentinels[3], content: sentinels[4] }) },
				{ type: "function_call_output", call_id: "write-call", output: sentinels[5] },
				{ type: "reasoning", encrypted_content: sentinels[6] },
			],
			headers: { authorization: sentinels[7] },
		};
		await pi.emit("before_provider_request", request(payload), context);
		await pi.emit("message_end", { message: fauxAssistantMessage("RESPONSE_SENTINEL", { stopReason: "error", errorMessage: "ERROR_SENTINEL" }) }, context);
		const { text, rows } = await waitForLedger(path, 2);
		for (const sentinel of sentinels) expect(text).not.toContain(sentinel);
		expect(rows[0]?.categories).toHaveProperty("tool_call:write");
		expect(rows[0]?.categories).toHaveProperty("tool_result:write:lt4k");
		expect(Object.keys(rows[1] ?? {}).sort()).toEqual(["event", "request", "run", "stopReason", "timestamp", "usage"]);
	});
});
