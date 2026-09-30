#!/usr/bin/env node
/**
 * Opt-in real-provider verification through Pi's public SDK. Synthetic tasks only.
 * Reuses Pi-managed authentication, isolates all settings/session files in a temp
 * directory, restricts agent tools to fixtures, and publishes only aggregate checks.
 * --start detaches the bounded run; --out is claimed exclusively before any call.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createSolPiExtension } from "../src/sol-pi/index.ts";
import { loadSolPiConfig } from "../src/sol-pi/config.ts";
import { REDUCER_EVENT_TYPE } from "../src/sol-pi/extensions/evidence-preserving-reducer/config.ts";
import { ONLINE_STATE_ENTRY } from "../src/sol-pi/extensions/online-context-compact/state.ts";

const { values } = parseArgs({ options: {
	provider: { type: "string", default: process.env.PI_PROVIDER ?? "openai" },
	model: { type: "string", default: process.env.PI_MODEL ?? "gpt-6-astra" },
	run: { type: "boolean", default: false }, start: { type: "boolean", default: false },
	out: { type: "string" }, scenario: { type: "string", default: "all" },
} });
const REASONING = "medium";
const RUN_TIMEOUT_MS = 360_000;
const REQUEST_LIMIT = 32;
const PRESSURE_WINDOW_TOKENS = 32_768;
const FIXTURE_COMMAND = "npm test";
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const filename = fileURLToPath(import.meta.url);
const report = { schema: "sol-pi-live-verification/1", startedAt: new Date().toISOString(),
	provider: values.provider, model: values.model, reasoning: REASONING,
	piVersion: JSON.parse(await readFile(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8")).version,
	harnessSha256: createHash("sha256").update(await readFile(filename)).digest("hex"),
	selectedScenario: values.scenario,
	status: "preflight", checks: {}, scenarios: [], limitations: [
		"Synthetic development fixtures, not a held-out quality or savings experiment.",
		"Repair scenario lowers the advertised context window to exercise real native compaction with bounded input.",
		"Token categories are reported separately; missing or zero cost metadata is not a billing result.",
	],
};
let output;
let directory;
let activeSession;
let timedOut = false;
let deadline;
async function publish() {
	if (!output) return;
	const temporary = `${output}.pending`;
	await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, output);
}
function classify(error) {
	if (timedOut) return "run-timeout";
	if (error?.code === "EEXIST") return "output-already-exists";
	if (error?.name === "AssertionError") return "acceptance-check-failed";
	const text = String(error?.message ?? "").toLowerCase();
	if (/auth|credential|api.key|401|403/.test(text)) return "provider-auth-unavailable";
	if (/timeout|abort/.test(text)) return "request-timeout";
	if (/model/.test(text)) return "model-unavailable-or-request-failed";
	return "verification-runtime-error";
}
function textOf(message) {
	return typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}
function aggregateUsage(usages) {
	return usages.reduce((sum, usage) => ({ calls: sum.calls + 1,
		input: sum.input + usage.input, output: sum.output + usage.output,
		cacheRead: sum.cacheRead + usage.cacheRead, cacheWrite: sum.cacheWrite + usage.cacheWrite,
		totalTokens: sum.totalTokens + usage.totalTokens,
	}), { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
}
async function runScenario(name, runtime, model, exercise) {
	const cwd = join(directory, name);
	const agentDir = join(cwd, "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "sol-pi.json"), JSON.stringify({ version: 1, actionFusion: true, observationPack: true,
		evidencePreservingReducer: true, evidencePreservingReducerProvider: model.provider,
		evidencePreservingReducerModel: model.id, onlineContextCompact: true, cacheWriteReadRatio: 12.5 }));
	const config = loadSolPiConfig(cwd, agentDir, false);
	const manager = SessionManager.create(cwd, join(cwd, "sessions"));
	const result = { name, status: "running", providerRequests: 0, extensionErrors: 0, blockedTools: 0,
		projections: [], compactions: 0, checks: {}, allMechanismsEnabled: false };
	report.scenarios.push(result);
	await publish();
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	let phase = "initial";
	let observationCallId;
	let observationBody;
	const allowedFiles = new Set(["reference.txt", "arithmetic.mjs", "test.mjs", "package.json"].map((path) => join(cwd, path)));
	const observer = (pi) => {
		pi.on("tool_call", (event) => {
			const input = event.input;
			const permitted = event.toolName === "bash" ? input.command === FIXTURE_COMMAND
				: ["read", "write", "edit"].includes(event.toolName)
					? typeof input.path === "string" && allowedFiles.has(resolve(cwd, input.path))
						&& (!input.then_run || input.then_run.command === FIXTURE_COMMAND)
						&& (event.toolName === "read" || resolve(cwd, input.path) === join(cwd, "arithmetic.mjs"))
					: ["obs_recall", "update_plan"].includes(event.toolName);
			if (!permitted) { result.blockedTools++; return { block: true, reason: "Verification tools are restricted to the synthetic fixtures." }; }
		});
		pi.on("session_start", () => {
			pi.on("context", (event) => {
				const observation = event.messages.find((message) => message.role === "toolResult" && message.toolCallId === observationCallId);
				if (observation) result.projections.push({ phase, full: textOf(observation) === observationBody, placeholder: textOf(observation).startsWith("[large tool result replaced") });
			});
			pi.on("before_provider_request", (_event, context) => {
				result.providerRequests++;
				if (result.providerRequests > REQUEST_LIMIT) context.abort();
			});
			pi.on("session_compact", () => result.compactions++);
		});
	};
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
		extensionFactories: [
			{ name: "sol-pi", factory: createSolPiExtension(() => config) },
			{ name: "verification-observer", factory: observer },
		], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		systemPrompt: "You are a coding assistant verifying a synthetic local task. Follow the requested tool sequence, work only on supplied files, and keep replies short. Never read credentials or external files." });
	await loader.reload();
	assert.equal(loader.getExtensions().errors.length, 0);
	const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model,
		thinkingLevel: REASONING, sessionManager: manager, settingsManager, resourceLoader: loader,
		tools: ["read", "bash", "edit", "write", "obs_recall", "update_plan"] });
	activeSession = session;
	try {
		await session.bindExtensions({ mode: "json", onError: () => result.extensionErrors++ });
		result.allMechanismsEnabled = config.actionFusion && config.observationPack && config.evidencePreservingReducer && config.onlineContextCompact
			&& ["edit", "write", "obs_recall", "update_plan"].every((name) => session.getActiveToolNames().includes(name));
		assert.ok(result.allMechanismsEnabled);
		assert.equal(result.extensionErrors, 0);
		await exercise({ cwd, session, manager, result,
			async prompt(label, text) {
				if (timedOut) throw new Error("run timeout");
				phase = label;
				report.phase = `${name}/${label}`;
				await publish();
				await session.prompt(text, { expandPromptTemplates: false });
				if (timedOut) throw new Error("run timeout");
				const last = manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "assistant").at(-1);
				assert.ok(last && !["error", "aborted"].includes(last.message.stopReason));
				await publish();
			},
			observe(id, body) { observationCallId = id; observationBody = body; },
		});
		assert.equal(result.extensionErrors, 0);
		assert.equal(result.blockedTools, 0);
	} finally {
		session.dispose();
		activeSession = undefined;
		const entries = manager.getEntries();
		result.usage = {
			main: aggregateUsage(entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.usage.totalTokens > 0).map((entry) => entry.message.usage)),
			summary: aggregateUsage(entries.filter((entry) => entry.type === "compaction" && entry.usage).map((entry) => entry.usage)),
			reducer: aggregateUsage(entries.filter((entry) => entry.type === "custom" && entry.customType === REDUCER_EVENT_TYPE && entry.data.kind === "provider_response").map((entry) => entry.data.usage)),
		};
		const interrupted = entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant" && ["error", "aborted"].includes(entry.message.stopReason));
		result.emptyCancelledResponses = interrupted.filter((entry) => entry.message.content.length === 0 && (entry.message.stopReason === "aborted" || /abort|cancel/i.test(entry.message.errorMessage ?? ""))).length;
		result.unexpectedAssistantFailures = interrupted.length - result.emptyCancelledResponses;
		await publish();
	}
	assert.equal(result.unexpectedAssistantFailures, 0);
	result.status = "passed";
	await publish();
}

try {
	assert.ok(["all", "observation-branches", "repair-and-compaction"].includes(values.scenario));
	if (values.start) {
		assert.ok(values.out && !values.run, "start requires out");
		const child = spawn(process.execPath, [filename, "--run", "--out", resolve(values.out), "--provider", values.provider, "--model", values.model, "--scenario", values.scenario], { detached: true, stdio: "ignore" });
		child.unref();
		console.log(JSON.stringify({ started: true, pid: child.pid, report: resolve(values.out) }));
	} else {
		if (values.run) {
			assert.ok(values.out, "run requires out");
			const destination = resolve(values.out);
			await mkdir(dirname(destination), { recursive: true });
			await writeFile(destination, `${JSON.stringify(report)}\n`, { flag: "wx", mode: 0o600 });
			output = destination;
			deadline = setTimeout(() => { timedOut = true; activeSession?.abortCompaction(); void activeSession?.abort(); }, RUN_TIMEOUT_MS);
		}
		const runtime = await ModelRuntime.create({ allowModelNetwork: false, signal: AbortSignal.timeout(30_000) });
		const model = runtime.getModel(values.provider, values.model);
		report.checks.modelFound = Boolean(model);
		report.checks.authenticationAvailable = (await runtime.getAvailable(values.provider, { signal: AbortSignal.timeout(30_000) })).some((entry) => entry.id === values.model);
		assert.ok(report.checks.modelFound && report.checks.authenticationAvailable);
		if (!values.run) console.log(JSON.stringify(report, null, 2));
		else {
			directory = await mkdtemp(join(tmpdir(), "sol-pi-live-"));
			report.status = "running";
			if (values.scenario !== "repair-and-compaction") await runScenario("observation-branches", runtime, model, async ({ cwd, session, manager, result, prompt, observe }) => {
				await writeFile(join(cwd, "reference.txt"), `SENTINEL=violet-42\n${"reference row for synthetic branch validation\n".repeat(420)}`);
				await prompt("read", "Read reference.txt completely with the read tool. Reply only READ_DONE. Do not call update_plan.");
				const observation = manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "read");
				assert.ok(observation);
				observe(observation.message.toolCallId, textOf(observation.message));
				await prompt("A-second", "Reply only ACK_TWO. Do not call tools.");
				await prompt("A-third", "Reply only ACK_THREE. Do not call tools.");
				const branchA = manager.getLeafId();
				await session.navigateTree(observation.id, { summarize: false });
				await prompt("B-first", "On this new branch, report the SENTINEL value from the read result. Do not call tools.");
				await session.navigateTree(branchA, { summarize: false });
				await prompt("A-return", "Reply only RETURNED. Do not call tools.");
				result.checks.branchAThirdMasked = result.projections.some((item) => item.phase === "A-third" && item.placeholder);
				result.checks.branchBFirstFull = result.projections.some((item) => item.phase === "B-first" && item.full && !item.placeholder);
				result.checks.branchAReturnMasked = result.projections.some((item) => item.phase === "A-return" && item.placeholder);
				assert.ok(Object.values(result.checks).every(Boolean));
			});
			if (values.scenario !== "observation-branches") await runScenario("repair-and-compaction", runtime, { ...model, contextWindow: PRESSURE_WINDOW_TOKENS }, async ({ cwd, manager, result, prompt }) => {
				result.advertisedContextWindow = PRESSURE_WINDOW_TOKENS;
				await writeFile(join(cwd, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node test.mjs" } }));
				await writeFile(join(cwd, "arithmetic.mjs"), "export const add = (a, b) => a - b;\nexport const multiply = (a, b) => a + b;\n");
				await writeFile(join(cwd, "test.mjs"), "import { add, multiply } from './arithmetic.mjs';\nconsole.log('synthetic diagnostic context\\n'.repeat(320));\nlet failures = 0;\nif(add(2, 3) !== 5) { console.log('Error: addition target expected 5'); failures++; }\nif(multiply(2, 3) !== 6) { console.log('Error: multiplication target expected 6'); failures++; }\nconsole.log(failures ? 'diagnostic run ended' : 'ALL_CHECKS_PASSED');\nprocess.exitCode = failures ? 1 : 0;\n");
				// History is an explicit fixture, not attributed to the real provider.
				const initialLeaf = manager.getLeafId();
				for (let index = 0; index < 6; index++) {
					manager.appendMessage({ role: "user", content: `Completed synthetic historical phase ${index}. ${"Archived resolved background detail. ".repeat(350)}`, timestamp: index });
					manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Resolved synthetic background; no pending action. ".repeat(270) }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage: ZERO_USAGE, timestamp: index });
				}
				// Reload the real session's context after constructing the synthetic ancestry.
				const leaf = manager.getLeafId();
				if (initialLeaf) manager.branch(initialLeaf);
				else manager.resetLeaf();
				await activeSession.navigateTree(leaf, { summarize: false });
				await prompt("repair", "Fix both arithmetic functions in arithmetic.mjs. Required sequence: (1) update_plan with id repair, goal 'repair arithmetic', status in_progress; id review, goal 'external review', status pending. (2) Run npm test BEFORE editing. (3) Read arithmetic.mjs and fix it with write; include then_run command 'npm test'. (4) Mark repair completed and review in_progress, supplying verification. After any compaction, rebuild that same completed repair plus in_progress review plan twice, then reply REPAIR_DONE. Do not complete review; an external checker handles it. Do not modify package.json or test.mjs.");
				const arithmetic = await import(`${pathToFileURL(join(cwd, "arithmetic.mjs")).href}?verify=${Date.now()}`);
				result.checks.arithmeticCorrect = arithmetic.add(2, 3) === 5 && arithmetic.multiply(2, 3) === 6 && arithmetic.add(-7, 4) === -3 && arithmetic.multiply(-7, 4) === -28;
				const entries = manager.getBranch();
				const receipts = entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult").map((entry) => textOf(entry.message));
				result.checks.bothErrorsPreserved = receipts.some((text) => text.includes("sol_pi_evidence_receipt_v1") && text.includes("Error: addition target expected 5") && text.includes("Error: multiplication target expected 6"));
				result.checks.realSummary = entries.some((entry) => entry.type === "compaction" && entry.usage?.totalTokens > 0);
				result.completedPlanSubmissions = entries.flatMap((entry) => entry.type === "message" && entry.message.role === "assistant" ? entry.message.content : [])
					.filter((part) => part.type === "toolCall" && part.name === "update_plan" && part.arguments.steps?.some((step) => step.id === "repair" && step.goal === "repair arithmetic" && step.status === "completed")).length;
				result.checks.oneCompactionDespitePlanReplay = result.compactions === 1 && result.completedPlanSubmissions >= 3;
				result.reportedSummaryCost = entries.filter((entry) => entry.type === "compaction").reduce((total, entry) => total + (entry.usage?.cost.total ?? 0), 0);
				result.checks.continuationFinished = entries.some((entry) => entry.type === "message" && entry.message.role === "assistant" && textOf(entry.message).includes("REPAIR_DONE"));
				const snapshots = entries.filter((entry) => entry.type === "custom" && entry.customType === ONLINE_STATE_ENTRY);
				result.recordedDebtTokens = snapshots.at(-1)?.data.cacheDebtTokens ?? null;
				result.reducerFallbacks = entries.filter((entry) => entry.type === "custom" && entry.customType === REDUCER_EVENT_TYPE && entry.data.kind === "fallback").map((entry) => entry.data.reason);
				assert.ok(Object.values(result.checks).every(Boolean));
			});
			report.status = "passed";
		}
	}
} catch (error) {
	report.status = "failed";
	report.failure = classify(error);
	for (const scenario of report.scenarios) if (scenario.status === "running") scenario.status = "failed";
	process.exitCode = 1;
	if (!output) console.log(JSON.stringify(report, null, 2));
} finally {
	if (deadline) clearTimeout(deadline);
	if (directory) await rm(directory, { recursive: true, force: true });
	if (output) { report.finishedAt = new Date().toISOString(); report.temporaryArtifactsRemoved = true; await publish(); }
}
