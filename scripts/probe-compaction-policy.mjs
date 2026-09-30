#!/usr/bin/env node
/**
 * Offline diagnostic fixtures for OCC accounting and ObservationPack branching.
 * Calls the pinned Pi preparation engine directly to measure retained history;
 * this private import belongs only to this source-checkout research probe.
 * No model calls or real sessions. Temporary observation archives are removed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, buildSessionContext, estimateTokens } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import { createObservationPackExtension } from "../src/sol-pi/extensions/observation-pack/index.ts";
import { DEFAULT_COMPACTION_ECONOMICS, decideCompaction } from "../src/sol-pi/extensions/online-context-compact/economics.ts";
import { initialOnlineState, recordCompaction } from "../src/sol-pi/extensions/online-context-compact/state.ts";
import { DIAGNOSTIC_COMMAND, REDUCER_RECEIPT_SCHEMA, sha256 } from "../src/sol-pi/extensions/evidence-preserving-reducer/config.ts";
import { validateReceipt } from "../src/sol-pi/extensions/evidence-preserving-reducer/receipt.ts";

import {
	DEFAULT_KEEP_RECENT_TOKENS as KEEP_RECENT_TOKENS,
	DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE as MEMO_TOKENS,
} from "../src/sol-pi/extensions/online-context-compact/extension.ts";
const CACHE_RATIO = 12.5;
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function assistant(text) {
	return { role: "assistant", content: [{ type: "text", text }], api: "probe", provider: "probe", model: "probe",
		usage: ZERO_USAGE, stopReason: "stop", timestamp: 0 };
}
function estimate(messages) {
	return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}
function cutFixture(oldChars, latestChars) {
	const manager = SessionManager.inMemory(process.cwd());
	manager.appendMessage({ role: "user", content: "old task", timestamp: 0 });
	manager.appendMessage(assistant("a".repeat(oldChars)));
	manager.appendMessage({ role: "user", content: "b".repeat(latestChars), timestamp: 0 });
	manager.appendMessage(assistant("tail response"));
	const branch = manager.getBranch();
	const before = estimate(buildSessionContext(branch).messages);
	const preparation = prepareCompaction(branch, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: KEEP_RECENT_TOKENS });
	if (!preparation) throw new Error("Fixture did not produce a native cut point");
	const actualRemovable = estimate([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]);
	return { contextTokens: before, fixedTailEstimate: Math.max(0, before - KEEP_RECENT_TOKENS),
		nativeRemovableTokens: actualRemovable, retainedTokens: before - actualRemovable };
}

const decision = decideCompaction({
	writeTokens: 100_000, archiveTokens: 80_000, memoTokens: MEMO_TOKENS, contextTokens: 100_000,
	summaryCostTokens: 0, // This isolated formula fixture excludes summary cost; runtime policy includes it.
	completedBoundaryRequestCounts: [5], remainingBoundaries: 1, averageContextTokenIncrement: null,
	contextWindowTokens: 400_000, priorCompactionCount: 0, carriedDebtTokens: 0, cacheDebtRepaymentTokens: 0,
	cacheWriteReadRatio: CACHE_RATIO, economics: DEFAULT_COMPACTION_ECONOMICS,
});
const priorDebt = { ...initialOnlineState(), cacheDebtTokens: 1_000, cacheDebtRepaymentTokens: 100 };
const newDebt = { debtTokens: 600, repaymentTokens: 200 };
const after = recordCompaction(priorDebt, newDebt);
const failureLog = "Error: first failure\nError: independent second failure\n";
const source = { hash: sha256(failureLog), bytes: Buffer.byteLength(failureLog), lines: 2, path: "synthetic.log" };
const partialReceipt = validateReceipt(JSON.stringify({
	schema: REDUCER_RECEIPT_SCHEMA, source_sha256: source.hash, status: "failure", uncertain: false,
	evidence: [{ kind: "failure", quote: "Error: first failure" }],
}), source, failureLog, true);
const directory = await mkdtemp(join(tmpdir(), "sol-pi-policy-probe-"));
try {
	const manager = SessionManager.create(directory, directory);
	const observation = { role: "toolResult", toolCallId: "shared-result", toolName: "read",
		content: [{ type: "text", text: "archived source row\n".repeat(1_000) }], isError: false, timestamp: 0 };
	manager.appendMessage({ role: "user", content: "read the synthetic log", timestamp: 0 });
	manager.appendMessage({ ...assistant(""), stopReason: "toolUse", content: [
		{ type: "toolCall", id: observation.toolCallId, name: observation.toolName, arguments: { path: "synthetic.log" } },
	] });
	const fork = manager.appendMessage(observation);
	const handlers = new Map();
	const tools = [];
	createObservationPackExtension()({
		registerTool: (tool) => tools.push(tool),
		getActiveTools: () => tools.map((tool) => tool.name),
		on: (name, handler) => handlers.set(name, handler),
	});
	const context = { sessionManager: manager, hasUI: false };
	const project = () => handlers.get("context")({ messages: buildSessionContext(manager.getBranch()).messages }, context);
	await project();
	manager.appendMessage(assistant("branch A first response"));
	await project();
	manager.appendMessage(assistant("branch A second response"));
	const branchA = await project();
	const rawBranchATokens = estimate(buildSessionContext(manager.getBranch()).messages);
	manager.branch(fork);
	manager.appendMessage({ role: "user", content: "begin branch B", timestamp: 0 });
	const branchB = await project();
	const branchBEntries = manager.getBranch();
	const forkIndex = branchBEntries.findIndex((entry) => entry.id === fork);
	const isFull = (projection) => projection.messages.find((message) => message.role === "toolResult" && message.toolCallId === observation.toolCallId)
		.content[0].text === observation.content[0].text;
	console.log(JSON.stringify({
		reducerCoverage: { distinctFailuresInSource: source.lines, quotedFailures: 1, partialReceiptAccepted: partialReceipt.ok },
		diagnosticCommands: Object.fromEntries(["npm run check", "npx vitest run", "npm test", "cargo fmt", "cargo test"]
			.map((command) => [command, DIAGNOSTIC_COMMAND.test(command)])),
		fixedTailFixtures: {
			largeRetainedTurn: cutFixture(4_000, 160_000),
			oversizedRetainedAssistant: cutFixture(120_000, 2_000),
		},
		cacheRebuild: {
			preCompactionTokens: decision.writeTokens,
			predictedPostCompactionTokens: decision.writeTokens - decision.archiveTokens + decision.memoTokens,
			currentBreakevenRequests: decision.breakevenRequests,
			postCompactionRebuildBreakevenRequests:
				((decision.writeTokens - decision.archiveTokens + decision.memoTokens) * (CACHE_RATIO - 1)) /
				(decision.archiveTokens - decision.memoTokens),
			summaryCallCostIncluded: false,
		},
		debtTransition: { previousDebt: priorDebt.cacheDebtTokens, newDebt: newDebt.debtTokens, observedDebt: after.cacheDebtTokens,
			previousRepayment: priorDebt.cacheDebtRepaymentTokens, newRepayment: newDebt.repaymentTokens, observedRepayment: after.cacheDebtRepaymentTokens },
		observationProjection: { storedSessionTokens: rawBranchATokens, providerContextTokens: estimate(branchA.messages) },
		observationBranches: { branchAThirdRequestIsFull: isFull(branchA), branchBFirstRequestIsFull: isFull(branchB),
			branchBAssistantResponsesAfterObservation: branchBEntries.slice(forkIndex + 1)
				.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length },
	}, null, 2));
} finally {
	await rm(directory, { recursive: true, force: true });
}
