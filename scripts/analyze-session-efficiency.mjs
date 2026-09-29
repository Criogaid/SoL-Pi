#!/usr/bin/env node
/**
 * Read-only audit of persisted Pi sessions. Emits numeric aggregates and hashed
 * session identifiers, never prompts, tool arguments, output, paths, or errors.
 * Scans project-level JSONL files only (no nested worker sessions or artifacts).
 * Counts persisted events, including abandoned branches; it is not a task scorer
 * or a reconstruction of provider payloads. Missing usage is explicitly counted.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { REDUCER_EVENT_TYPE } from "../src/sol-pi/extensions/evidence-preserving-reducer/config.ts";
import { ONLINE_STATE_ENTRY } from "../src/sol-pi/extensions/online-context-compact/state.ts";
import { THRESHOLD_BYTES } from "../src/sol-pi/extensions/observation-pack/observation.ts";

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 10_000;
const SHORT_COMPACTION_REQUEST_GAP = 2;
const TOOL_NAMES = new Set(["bash", "read", "grep", "edit", "write", "replace", "obs_recall", "update_plan", "todo"]);
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];

function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function increment(target, key) {
	target[key] = (target[key] ?? 0) + 1;
}

function textBytes(content) {
	if (typeof content === "string") return Buffer.byteLength(content, "utf8");
	if (!Array.isArray(content)) return 0;
	return content.reduce((sum, block) => sum + (block?.type === "text" && typeof block.text === "string"
		? Buffer.byteLength(block.text, "utf8") : 0), 0);
}

function validSteps(steps) {
	return Array.isArray(steps) && steps.every((step) => record(step) && typeof step.id === "string" &&
		typeof step.goal === "string" && ["pending", "in_progress", "completed"].includes(step.status));
}

function newMetrics() {
	return {
		assistantMessages: 0, assistantErrors: 0, assistantAborts: 0,
		usageMessages: 0, missingOrZeroUsageMessages: 0,
		usage: Object.fromEntries(USAGE_FIELDS.map((name) => [name, 0])),
		extraUsage: Object.fromEntries(USAGE_FIELDS.map((name) => [name, 0])),
		extraUsageEntries: 0, compactionsWithoutUsage: 0, occContinuations: 0,
		toolCalls: {}, toolResults: 0, toolErrors: 0, toolResultBytes: 0, largeToolResults: 0,
		fusionCalls: 0, planCalls: 0, planCallsWithCompletedSteps: 0,
		compactions: 0, compactionSummaryChars: 0, maxCompactionSummaryChars: 0,
		shortCompactionGaps: 0, postCompactionPlans: 0, postCompactionPlansWithCompletedSteps: 0,
		identicalPostCompactionPlans: 0, postCompactionNewCompletedIds: 0,
		occSnapshots: 0, occEmptyPlansAfterCompaction: 0, occMaxHistoricalInterval: 0,
		eprEvents: {}, eprSourceBytes: 0, eprReceiptBytes: 0, eprRecordedTokens: 0, eprRepeatedCandidates: 0,
	};
}

async function scan(path, root, before) {
	const initial = await lstat(path);
	if (!initial.isFile() || initial.isSymbolicLink()) return { skipped: "not-regular" };
	if (initial.size > MAX_FILE_BYTES) return { skipped: "size-limit" };
	const metrics = newMetrics();
	let malformedLines = 0;
	let excludedEntries = 0;
	let schemaVersion = null;
	let firstTimestamp = null;
	let lastTimestamp = null;
	let plan = [];
	let awaitingPlan = false;
	let priorCompactionRequest = null;
	let priorOccCount = 0;
	let hasHeader = false;
	const reducerCandidates = new Set();
	// Pin the byte range so concurrent append cannot extend this audit forever.
	const stream = createReadStream(path, { encoding: "utf8", end: Math.max(0, initial.size - 1) });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			if (!line.trim()) continue;
			let entry;
			try { entry = JSON.parse(line); } catch { malformedLines++; continue; }
			if (!record(entry)) { malformedLines++; continue; }
			if (entry.type === "session") {
				hasHeader = true;
				schemaVersion = Number.isSafeInteger(entry.version) ? entry.version : null;
			}
			const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
			if (!Number.isFinite(timestamp) || timestamp >= before) { excludedEntries++; continue; }
			firstTimestamp ??= new Date(timestamp).toISOString();
			lastTimestamp = new Date(timestamp).toISOString();
			if (record(entry.usage) && USAGE_FIELDS.every((field) => finite(entry.usage[field])) && entry.usage.totalTokens > 0) {
				metrics.extraUsageEntries++;
				for (const field of USAGE_FIELDS) metrics.extraUsage[field] += entry.usage[field];
			} else if (entry.type === "compaction") metrics.compactionsWithoutUsage++;
			if (entry.type === "custom_message" && entry.customType === "sol-pi-online-context-compact") metrics.occContinuations++;
			if (entry.type === "compaction") {
				metrics.compactions++;
				const chars = typeof entry.summary === "string" ? entry.summary.length : 0;
				metrics.compactionSummaryChars += chars;
				metrics.maxCompactionSummaryChars = Math.max(metrics.maxCompactionSummaryChars, chars);
				if (priorCompactionRequest !== null && metrics.assistantMessages - priorCompactionRequest <= SHORT_COMPACTION_REQUEST_GAP) {
					metrics.shortCompactionGaps++;
				}
				priorCompactionRequest = metrics.assistantMessages;
				awaitingPlan = true;
			}
			if (entry.type === "custom" && entry.customType === ONLINE_STATE_ENTRY && record(entry.data)) {
				const data = entry.data;
				metrics.occSnapshots++;
				if (finite(data.nativeCompactionCount) && data.nativeCompactionCount > priorOccCount) {
					if (Array.isArray(data.plan) && data.plan.length === 0) metrics.occEmptyPlansAfterCompaction++;
				}
				if (finite(data.nativeCompactionCount)) priorOccCount = data.nativeCompactionCount;
				if (Array.isArray(data.completedBoundaryRequestCounts)) {
					for (const count of data.completedBoundaryRequestCounts) {
						if (finite(count)) metrics.occMaxHistoricalInterval = Math.max(metrics.occMaxHistoricalInterval, count);
					}
				}
			}
			if (entry.type === "custom" && entry.customType === REDUCER_EVENT_TYPE && record(entry.data)) {
				const data = entry.data;
				const kind = ["candidate", "provider_response", "fallback", "applied"].includes(data.kind) ? data.kind : "other";
				increment(metrics.eprEvents, kind);
				if (kind === "candidate" && typeof data.sourceSha256 === "string" && typeof data.commandSha256 === "string") {
					const key = JSON.stringify([data.sourceSha256, data.commandSha256, data.isError]);
					if (reducerCandidates.has(key)) metrics.eprRepeatedCandidates++;
					reducerCandidates.add(key);
				}
				if (kind === "provider_response" && finite(data.usage?.totalTokens)) metrics.eprRecordedTokens += data.usage.totalTokens;
				if (kind === "applied") {
					if (finite(data.sourceBytes)) metrics.eprSourceBytes += data.sourceBytes;
					if (finite(data.receiptBytes)) metrics.eprReceiptBytes += data.receiptBytes;
				}
			}
			if (entry.type !== "message" || !record(entry.message)) continue;
			const message = entry.message;
			if (message.role === "toolResult") {
				metrics.toolResults++;
				if (message.isError === true) metrics.toolErrors++;
				const bytes = textBytes(message.content);
				metrics.toolResultBytes += bytes;
				if (bytes > THRESHOLD_BYTES) metrics.largeToolResults++;
			}
			if (message.role !== "assistant") continue;
			metrics.assistantMessages++;
			if (message.stopReason === "error") metrics.assistantErrors++;
			if (message.stopReason === "aborted") metrics.assistantAborts++;
			const usage = message.usage;
			if (record(usage) && USAGE_FIELDS.every((field) => finite(usage[field])) && usage.totalTokens > 0) {
				metrics.usageMessages++;
				for (const field of USAGE_FIELDS) metrics.usage[field] += usage[field];
			} else metrics.missingOrZeroUsageMessages++;
			if (!Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (!record(block) || block.type !== "toolCall") continue;
				const tool = TOOL_NAMES.has(block.name) ? block.name : "other";
				increment(metrics.toolCalls, tool);
				const args = block.arguments;
				if (["edit", "write", "replace"].includes(tool) && record(args?.then_run)) metrics.fusionCalls++;
				if (tool !== "update_plan" || !validSteps(args?.steps)) continue;
				metrics.planCalls++;
				const completed = args.steps.filter((step) => step.status === "completed");
				if (completed.length > 0) metrics.planCallsWithCompletedSteps++;
				if (awaitingPlan) {
					metrics.postCompactionPlans++;
					if (completed.length > 0) metrics.postCompactionPlansWithCompletedSteps++;
					if (JSON.stringify(args.steps.map(({ id, goal, status }) => ({ id, goal, status }))) === JSON.stringify(plan)) metrics.identicalPostCompactionPlans++;
					const oldIds = new Set(plan.filter((step) => step.status === "completed").map((step) => step.id));
					if (oldIds.size > 0 && completed.some((step) => !oldIds.has(step.id))) metrics.postCompactionNewCompletedIds++;
					awaitingPlan = false;
				}
				plan = args.steps.map(({ id, goal, status }) => ({ id, goal, status }));
			}
		}
	} finally {
		lines.close();
		stream.destroy();
	}
	const final = await lstat(path);
	if (!hasHeader) return { skipped: "no-session-header" };
	if (firstTimestamp === null) return { skipped: "outside-cutoff" };
	return {
		id: createHash("sha256").update(relative(root, path).replaceAll("\\", "/")).digest("hex").slice(0, 16),
		schemaVersion, firstTimestamp, lastTimestamp, malformedLines, excludedEntries,
		changedDuringRead: final.size !== initial.size || final.mtimeMs !== initial.mtimeMs,
		...metrics,
	};
}

function addMetrics(total, item) {
	for (const key of Object.keys(total)) {
		if (record(total[key])) {
			for (const [name, value] of Object.entries(item[key])) total[key][name] = (total[key][name] ?? 0) + value;
		} else if (key.startsWith("max") || key === "occMaxHistoricalInterval") total[key] = Math.max(total[key], item[key]);
		else total[key] += item[key];
	}
}

const { values } = parseArgs({ options: {
	root: { type: "string" }, before: { type: "string" }, out: { type: "string" }, "summary-only": { type: "boolean" },
}, strict: true, allowPositionals: false });
if (!values.root || !values.before || !Number.isFinite(Date.parse(values.before))) {
	throw new Error("Usage: node scripts/analyze-session-efficiency.mjs --root <sessions-directory> --before <ISO-time> [--out <new-json-file>] [--summary-only]");
}
const root = resolve(values.root);
const rootStat = await lstat(root);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Session root must be a regular directory");
const files = [];
for (const project of await readdir(root, { withFileTypes: true })) {
	if (!project.isDirectory() || project.isSymbolicLink()) continue;
	for (const file of await readdir(join(root, project.name), { withFileTypes: true })) {
		if (file.isFile() && file.name.endsWith(".jsonl")) files.push(join(root, project.name, file.name));
	}
}
if (files.length > MAX_FILES) throw new Error("Session file count exceeds the audit limit");
files.sort();
const sessions = [];
const skipped = {};
const totals = newMetrics();
const occCohort = newMetrics();
for (const path of files) {
	const item = await scan(path, root, Date.parse(values.before));
	if (item.skipped) { increment(skipped, item.skipped); continue; }
	sessions.push(item);
	addMetrics(totals, item);
	if (item.occSnapshots > 0) addMetrics(occCohort, item);
}
const output = {
	version: 1, before: new Date(Date.parse(values.before)).toISOString(),
	scope: "Persisted project-level session events, all branches; nested workers excluded; wrapper tool arguments not expanded. Observational counts, not causal savings or task scores.",
	limits: { maxFileBytes: MAX_FILE_BYTES, maxFiles: MAX_FILES, largeResultBytes: THRESHOLD_BYTES, shortCompactionRequestGap: SHORT_COMPACTION_REQUEST_GAP },
	filesDiscovered: files.length, sessionsScanned: sessions.length, skipped,
	malformedLines: sessions.reduce((sum, item) => sum + item.malformedLines, 0),
	changedDuringRead: sessions.filter((item) => item.changedDuringRead).length,
	sessionsWithOccState: sessions.filter((item) => item.occSnapshots > 0).length,
	sessionsWithCompactions: sessions.filter((item) => item.compactions > 0).length,
	totals, occCohort, ...(values["summary-only"] ? {} : { sessions }),
};
if (values.out) await writeFile(resolve(values.out), `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ ...output, sessions: values["summary-only"] ? undefined : sessions.filter((item) => item.occContinuations > 0 || item.shortCompactionGaps > 0).slice(0, 10).map((item) => ({
	id: item.id, compactions: item.compactions, shortCompactionGaps: item.shortCompactionGaps,
	postCompactionPlansWithCompletedSteps: item.postCompactionPlansWithCompletedSteps,
	identicalPostCompactionPlans: item.identicalPostCompactionPlans,
	postCompactionNewCompletedIds: item.postCompactionNewCompletedIds,
	occEmptyPlansAfterCompaction: item.occEmptyPlansAfterCompaction,
	occMaxHistoricalInterval: item.occMaxHistoricalInterval,
})) }, null, 2));
