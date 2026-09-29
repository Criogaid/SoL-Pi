import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { REDUCER_EVENT_TYPE } from "../src/sol-pi/extensions/evidence-preserving-reducer/config.ts";
import { ONLINE_STATE_ENTRY } from "../src/sol-pi/extensions/online-context-compact/state.ts";

const script = fileURLToPath(new URL("../scripts/analyze-session-efficiency.mjs", import.meta.url));
const directories = [];
const timestamp = "2026-09-20T00:00:00Z";
const before = "2026-09-29T00:00:00Z";
const secret = "PRIVATE_SENTINEL_MUST_NOT_APPEAR";
const usage = { input: 10, output: 2, cacheRead: 8, cacheWrite: 0, totalTokens: 20 };
const steps = [{ id: secret, goal: secret, status: "completed" }];
const message = (value) => ({ type: "message", timestamp, message: value });
const assistant = (content, extra = {}) => message({ role: "assistant", content, usage, ...extra });
const plan = () => assistant([{ type: "toolCall", name: "update_plan", arguments: { steps } }]);

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "sol-pi-session-audit-"));
	directories.push(directory);
	const root = join(directory, "sessions");
	const project = join(root, secret);
	await mkdir(project, { recursive: true });
	return { directory, root, project };
}

function run(root, output, ...options) {
	return execFileSync(process.execPath, [script, "--root", root, "--before", before, "--out", output, ...options], {
		encoding: "utf8", timeout: 15_000, stdio: "pipe",
	});
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("session efficiency research audit", () => {
	it("separates recorded costs, bounds the cohort, and never exports session content", async () => {
		const { directory, root, project } = await fixture();
		const entries = [
			{ type: "session", version: 3, id: secret, cwd: secret, timestamp },
			plan(),
			{ type: "compaction", summary: secret, usage, timestamp },
			{ type: "custom_message", customType: "sol-pi-online-context-compact", content: secret, timestamp },
			plan(),
			assistant([{ type: "toolCall", name: secret, arguments: { path: secret } }]),
			assistant([], { usage: undefined, stopReason: "error", errorMessage: secret }),
			message({ role: "toolResult", content: [{ type: "text", text: secret }], isError: true }),
			{ type: "custom", customType: ONLINE_STATE_ENTRY, timestamp,
				data: { nativeCompactionCount: 1, plan: [], completedBoundaryRequestCounts: [9] } },
			{ type: "custom", customType: REDUCER_EVENT_TYPE, timestamp,
				data: { kind: "candidate", sourceSha256: secret, commandSha256: secret, isError: true } },
			{ type: "custom", customType: REDUCER_EVENT_TYPE, timestamp,
				data: { kind: "candidate", sourceSha256: secret, commandSha256: secret, isError: true } },
			{ type: "custom", customType: REDUCER_EVENT_TYPE, timestamp,
				data: { kind: "provider_response", usage } },
			{ type: "custom", customType: REDUCER_EVENT_TYPE, timestamp,
				data: { kind: "applied", sourceBytes: 1000, receiptBytes: 100, usage } },
			{ ...assistant([]), timestamp: before },
		];
		const body = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\nmalformed\n`;
		const path = join(project, `${secret}.jsonl`);
		await writeFile(path, body);
		await mkdir(join(project, "worker"));
		await writeFile(join(project, "worker", "session.jsonl"), body);
		const output = join(directory, "audit.json");
		const stdout = run(root, output);
		const saved = await readFile(output, "utf8");
		expect(stdout).not.toContain(secret);
		expect(saved).not.toContain(secret);
		expect(await readFile(path, "utf8")).toBe(body);
		const result = JSON.parse(saved);
		expect(result).toMatchObject({ filesDiscovered: 1, sessionsScanned: 1, malformedLines: 1, changedDuringRead: 0 });
		expect(result.totals).toMatchObject({
			assistantMessages: 4, usageMessages: 3, missingOrZeroUsageMessages: 1, assistantErrors: 1,
			usage: { totalTokens: 60 }, extraUsage: { totalTokens: 20 }, extraUsageEntries: 1,
			compactions: 1, compactionsWithoutUsage: 0, occContinuations: 1,
			postCompactionPlansWithCompletedSteps: 1, identicalPostCompactionPlans: 1,
			toolCalls: { update_plan: 2, other: 1 }, toolErrors: 1,
			eprRecordedTokens: 20, eprRepeatedCandidates: 1, eprSourceBytes: 1000, eprReceiptBytes: 100,
		});
		expect(result.occCohort).toEqual(result.totals);
		expect(result.sessions[0].id).toMatch(/^[a-f0-9]{16}$/u);
	});

	it("reports incomplete usage and excluded inputs and refuses to overwrite output", async () => {
		const { directory, root, project } = await fixture();
		await writeFile(join(project, "old.jsonl"), [
			{ type: "session", timestamp }, { type: "compaction", summary: "", timestamp },
		].map((entry) => JSON.stringify(entry)).join("\n"));
		await writeFile(join(project, "new.jsonl"), JSON.stringify({ type: "session", timestamp: before }));
		await writeFile(join(project, "not-session.jsonl"), JSON.stringify({ type: "message", timestamp }));
		const output = join(directory, "audit.json");
		run(root, output, "--summary-only");
		const result = JSON.parse(await readFile(output, "utf8"));
		expect(result.sessions).toBeUndefined();
		expect(result.skipped).toEqual({ "outside-cutoff": 1, "no-session-header": 1 });
		expect(result.totals.compactionsWithoutUsage).toBe(1);
		await writeFile(output, secret);
		expect(() => run(root, output)).toThrow();
		expect(await readFile(output, "utf8")).toBe(secret);
	});
});
