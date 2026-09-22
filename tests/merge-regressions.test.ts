/*
 * SPDX-License-Identifier: MIT
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { estimateTokens, SessionManager, type ExtensionContext, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/sol-pi/config.ts";
import { registerConfiguredFeatures } from "../src/sol-pi/index.ts";
import { createEvidencePreservingReducerExtension, REDUCER_RECEIPT_SCHEMA } from "../src/sol-pi/extensions/evidence-preserving-reducer/index.ts";
import { createObservationPackExtension } from "../src/sol-pi/extensions/observation-pack/index.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";

// This exact file is copied into historical snapshots by compare-merge-regressions.mjs.
// Record observable work, not synthetic dollar savings or provider billing estimates.
const measurements: Record<string, unknown> = {};
const roots: string[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "sol-pi-merge-regression-"));
	roots.push(root);
	return root;
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
afterAll(async () => {
	if (process.env.MERGE_REPLAY_REPORT) {
		await writeFile(process.env.MERGE_REPLAY_REPORT, `${JSON.stringify(measurements, null, 2)}\n`);
	}
});

it.each([false, true])("replays a persisted session with observationPack=%s before pricing compaction", async (packed) => {
	const root = await temporaryRoot();
	const session = SessionManager.create(root, root);
	const assistant = (text: string) => fauxAssistantMessage(text, { timestamp: 1 });
	const messages = [
		{ role: "user", content: "Inspect the build log", timestamp: 1 },
		fauxAssistantMessage(fauxToolCall("bash", { command: "cat build.log" }, { id: "large-log" }), { stopReason: "toolUse", timestamp: 1 }),
		{ role: "toolResult", toolName: "bash", toolCallId: "large-log", isError: false,
			content: [{ type: "text", text: "log line\n".repeat(25_000) }], timestamp: 1 },
		assistant("The old output has been inspected"),
		{ role: "user", content: "Continue the remaining work", timestamp: 1 },
		assistant("recent reasoning ".repeat(5_500)),
	] as AgentMessage[];
	for (const message of messages) session.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
	const reopened = SessionManager.open(session.getSessionFile()!, root);
	const replay = reopened.buildSessionContext().messages;
	expect(replay).toEqual(messages);
	const pi = new FakePi(reopened as unknown as FakeSessionManager);
	registerConfiguredFeatures(pi.asExtensionApi(), { ...DEFAULT_CONFIG, observationPack: packed, onlineContextCompact: true });
	let aborts = 0;
	let visibleTokens = messages.reduce((total, message) => total + estimateTokens(message), 0);
	const context = fakeContext(reopened as unknown as FakeSessionManager, {
		getContextUsage: () => ({ tokens: visibleTokens, contextWindow: 200_000, percent: visibleTokens / 2_000 }),
		abort: () => { aborts += 1; },
	});
	await pi.emit("session_start", { type: "session_start" }, context);
	const projected = await pi.emitContext(replay, context);
	visibleTokens = projected.reduce((total, message) => total + estimateTokens(message), 0);
	for (let index = 0; index < 20; index++) await pi.emit("before_provider_request", {}, context);
	const plan = { steps: [
		{ id: "inspect", goal: "Inspect output", status: "completed" },
		{ id: "finish", goal: "Finish implementation", status: "pending" },
	] };
	const boundary = fauxAssistantMessage(fauxToolCall("update_plan", plan, { id: "boundary" }), { stopReason: "toolUse", timestamp: 2 });
	reopened.appendMessage(boundary);
	const result = await pi.tool("update_plan").execute("boundary", plan, undefined, undefined, context);
	const toolResult = { role: "toolResult" as const, toolName: "update_plan", toolCallId: "boundary", isError: false, content: result.content, timestamp: 2 };
	reopened.appendMessage(toolResult);
	await pi.emit("turn_end", { message: boundary, toolResults: [toolResult] }, context);
	measurements[packed ? "packedSession" : "rawSession"] = {
		transcriptSha256: hash(JSON.stringify(messages)), rawTokens: messages.reduce((total, message) => total + estimateTokens(message), 0),
		visibleTokens, compactionTriggers: aborts, replayedMessages: replay.length,
	};
	// The packed history is smaller than a summary; raw history remains worth compacting.
	expect(aborts).toBe(packed ? 0 : 1);
});

it.for([false, true])("rejects redirected observation directories with search=%s", async (search, test) => {
	const root = await temporaryRoot();
	const manager = new FakeSessionManager([], "replay", root);
	const pi = new FakePi(manager);
	createObservationPackExtension()(pi.asExtensionApi());
	const tool = pi.tool("obs_recall");
	const supportsSearch = "query" in ((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {});
	if (search && !supportsSearch) {
		measurements.searchDirectory = { available: false };
		test.skip("This revision predates search recall");
		return;
	}
	const directory = join(root, "sol-pi", "replay", "observation-pack");
	const external = join(root, "external");
	await mkdir(directory, { recursive: true });
	await mkdir(external);
	await symlink(external, join(directory, "objects"), process.platform === "win32" ? "junction" : "dir");
	const id = "obs_aaaaaaaaaaaaaaaaaaaaaaaa";
	await writeFile(join(external, `${id}.txt`), "external sentinel evidence");
	let error: unknown;
	let returnedExternalBytes = false;
	try {
		const result = await tool.execute("recall", { id, ...(search ? { query: "sentinel" } : {}) }, undefined, undefined, fakeContext(manager));
		returnedExternalBytes = JSON.stringify(result.content).includes("external sentinel evidence");
	} catch (caught) { error = caught; }
	measurements[search ? "searchDirectory" : "pagedDirectory"] = { available: true, rejected: error instanceof Error, returnedExternalBytes };
	expect(error).toBeInstanceOf(Error);
	expect(returnedExternalBytes).toBe(false);
});

it.each(["long-line", "total-capacity", "boundary-line", "repeated-lines"])("avoids impossible reducer calls while preserving %s evidence", async (scenario) => {
	const root = await temporaryRoot();
	const manager = new FakeSessionManager([], "reducer-replay", root);
	const pi = new FakePi(manager);
	createEvidencePreservingReducerExtension()(pi.asExtensionApi());
	const lines = scenario === "long-line" ? ["ERROR " + "x".repeat(644), "repeated diagnostic"]
		: scenario === "total-capacity" ? Array.from({ length: 20 }, (_, index) => `ERROR ${index} ${"x".repeat(390)}`)
		: scenario === "boundary-line" ? ["ERROR " + "x".repeat(594)] : ["ERROR test target failed"];
	const body = scenario === "long-line" ? `${lines[0]}\n${`${lines[1]}\n`.repeat(300)}`
		: `${lines.join("\n")}\n`.repeat(scenario === "total-capacity" ? 1 : 300);
	let calls = 0;
	let reducerInputBytes = 0;
	const complete = async (_model: unknown, request: Context) => {
		calls += 1;
		reducerInputBytes += Buffer.byteLength(JSON.stringify(request));
		return fauxAssistantMessage(JSON.stringify({ schema: REDUCER_RECEIPT_SCHEMA, source_sha256: hash(body), status: "failure", uncertain: false,
			evidence: lines.slice(0, 12).map((line) => ({ kind: "failure", quote: line.slice(0, 600) })),
		}), { timestamp: 1 });
	};
	const context = fakeContext(manager, { modelRegistry: {
		find: () => ({ maxTokens: 2_048 }), complete,
	} as unknown as ExtensionContext["modelRegistry"] });
	let reductions = 0;
	for (let index = 0; index < 2; index++) {
		const event = { type: "tool_result", toolName: "bash", toolCallId: `failure-${index}`, input: { command: "npm test" },
			isError: true, content: [{ type: "text", text: body }], details: undefined } as ToolResultEvent;
		if (await pi.emit("tool_result", event, context)) reductions += 1;
	}
	measurements[scenario] = { sourceSha256: hash(body), sourceBytes: Buffer.byteLength(body), providerCalls: calls, reducerInputBytes, reductions };
	if (scenario === "repeated-lines" || scenario === "boundary-line") {
		expect(reductions).toBe(2);
		expect(calls).toBe(1);
	} else {
		expect(reductions).toBe(0);
		expect(calls).toBe(0);
	}
});

it("runs the documented search comparison and preserves source fidelity", async (test) => {
	const script = resolve("scripts/compare-observation-search.mjs");
	if (!existsSync(script)) {
		measurements.searchBenchmark = { available: false };
		test.skip("This revision predates the search benchmark");
		return;
	}
	const root = await temporaryRoot();
	const output = join(root, "search.json");
	const result = spawnSync(process.execPath, ["--experimental-strip-types", script, "--out", output], { encoding: "utf8", timeout: 30_000 });
	measurements.searchBenchmark = { available: true, status: result.status, error: result.error?.message, stderr: result.stderr };
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	const report = JSON.parse(await readFile(output, "utf8"));
	expect(report.paging.sourceFidelity).toBe(true);
	measurements.searchBenchmark = {
		available: true, status: result.status, byteTotals: report.byteTotals, paging: report.paging,
		searches: Object.fromEntries(Object.keys(report.searches).map((query) => {
			const search = report.searches[query];
			return [query, { calls: search.calls, requestBytes: search.requestBytes, resultBytes: search.resultBytes,
				scannedBytes: search.scannedBytes, matchCount: search.matches.length, sourceFidelity: true }];
		})),
	};
}, 35_000);
