/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import {
	estimateTokens,
	type ExtensionContext,
	type ExtensionFactory,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { formatSavingsCount, showSolPiSavings } from "../../tui.ts";
import {
	DEFAULT_COMPACTION_ECONOMICS,
	decideCompaction,
	type CompactionDecision,
} from "./economics.ts";
import { analyzePlanTransition, formatPlanSnapshot, parsePlanSteps } from "./plan.ts";
import {
	appendOnlineState,
	initialOnlineState,
	recordBoundary,
	recordCompaction,
	recordCompletedPlanHandoff,
	recordCorrection,
	recordProviderRequest,
	restoreOnlineState,
	type OnlineState,
	type ProgressSummary,
} from "./state.ts";
import { registerOnlineTools, type PlanUpdateInput } from "./tools.ts";

/*
 * The host owns cut-point semantics. Hosts without the public preparation
 * helpers skip optional boundary compaction and retain their native policy.
 */
const hostModule: Partial<Pick<typeof piCodingAgent, "findCutPoint" | "sessionEntryToContextMessages" | "convertToLlm" | "serializeConversation">> = piCodingAgent;

type NativeEstimate = Pick<CompactionDecision, "writeTokens" | "archiveTokens" | "memoTokens" | "summaryCostTokens">;
const SUMMARY_PROMPT_TOKEN_ESTIMATE = 1_000;
const TOKENS_PER_MILLION = 1_000_000;

function messageTokens(messages: readonly AgentMessage[]): number {
	return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

/** Attribute only observed provider-visible tokens to their active source entries. */
function projectedEntryTokens(
	entries: readonly SessionEntry[],
	observed: readonly AgentMessage[],
	toMessages: (entry: SessionEntry) => AgentMessage[],
): ReadonlyMap<string, number> {
	const lastCompaction = entries.findLastIndex((entry) => entry.type === "compaction");
	let active = entries;
	const compaction = entries[lastCompaction];
	if (compaction?.type === "compaction") {
		const firstKept = entries.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
		active = [compaction, ...(firstKept >= 0 ? entries.slice(firstKept, lastCompaction) : []), ...entries.slice(lastCompaction + 1)];
	}
	const keyOf = (message: AgentMessage): string => message.role === "toolResult"
		? `tool:${JSON.stringify([message.toolCallId, message.toolName, message.timestamp])}`
		: JSON.stringify(message);
	const sources = new Map<string, string[]>();
	for (const entry of active) {
		if (entry.type === "compaction" && entry !== compaction) continue;
		for (const message of toMessages(entry)) {
			const key = keyOf(message);
			const ids = sources.get(key) ?? [];
			ids.push(entry.id);
			sources.set(key, ids);
		}
	}
	const visible = new Map<string, number[]>();
	for (const message of observed) {
		const key = keyOf(message);
		const sizes = visible.get(key) ?? [];
		sizes.push(estimateTokens(message));
		visible.set(key, sizes);
	}
	const tokens = new Map<string, number>();
	for (const [key, ids] of sources) {
		const sizes = visible.get(key);
		// Unknown or ambiguous projections cannot establish removable tokens.
		if (!sizes || sizes.length !== ids.length || (key.startsWith("tool:") && ids.length > 1)) continue;
		for (const [index, id] of ids.entries()) {
			tokens.set(id, (tokens.get(id) ?? 0) + sizes[index]!);
		}
	}
	return tokens;
}

export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
export const DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE = 1_000;
export const BOUNDARY_COMPACTION_INSTRUCTIONS =
	"Preserve completed work, verification results, important decisions, and remaining work.";
export const POST_COMPACTION_PLAN_REMINDER =
	"Online context compaction finished. The parent task is still active. " +
	"Continue the remaining work from the current plan. Preserve existing step IDs when updating progress.";

const SKIPPED_COMPACTION_REMINDER =
	"Online context compaction was skipped. The existing context is still available. " +
	"Continue the remaining work from the current plan.";
// These host errors occur before a replacement summary is committed.
const RECOVERABLE_COMPACTION_ERRORS = new Map([
	["Nothing to compact (session too small)", "nothing_to_compact"],
	["Already compacted", "already_compacted"],
	["Summarization failed: generation hit the token cap and the summary is incomplete", "incomplete_summary"],
]);

export type OnlineContextCompactOptions = {
	readonly cacheWriteReadRatio?: number | null;
	readonly keepRecentTokens?: number;
	/** Receives boundary and compaction outcomes for an opt-in diagnostic ledger. */
	readonly recordDiagnostic?: (context: ExtensionContext, entry: Readonly<Record<string, unknown>>) => void;
};

type PendingBoundary = { readonly toolCallId: string };
type SelectedCompaction = { readonly decision: CompactionDecision };
type PendingContinuation = { readonly promise: Promise<void>; readonly resolve: () => void };

export function resolveKeepRecentTokens(value: number | undefined): number {
	const resolved = value ?? DEFAULT_KEEP_RECENT_TOKENS;
	if (!Number.isSafeInteger(resolved) || resolved < 1) {
		throw new Error("Online Context Compact keepRecentTokens must be a positive safe integer");
	}
	return resolved;
}

function resolveCacheWriteReadRatio(value: number | null | undefined): number | null {
	if (value === undefined || value === null) return null;
	if (!Number.isFinite(value) || value < 0) {
		throw new Error("Online Context Compact cacheWriteReadRatio must be finite and non-negative");
	}
	return value;
}

function tokenEstimate(text: string | string[]): number {
	const joined = Array.isArray(text) ? text.join("\n") : text;
	return Math.ceil(Buffer.byteLength(joined) / 4);
}

function result(text: string, details: Readonly<Record<string, unknown>>): AgentToolResult<Readonly<Record<string, unknown>>> {
	return { content: [{ type: "text", text }], details };
}

function progressSummary(input: PlanUpdateInput, completedStepId: string): ProgressSummary | undefined {
	const step = input.steps.find((item) => item.id === completedStepId);
	if (!step || !input.progress) return;
	return {
		stepId: step.id,
		goal: step.goal,
		filesChanged: [...input.progress.files_changed],
		verification: [...input.progress.verification],
		decisions: [...input.progress.decisions],
		nextWork: input.steps.filter((item) => item.status !== "completed").map((item) => item.goal),
	};
}

function branchAfterAbort(entries: readonly SessionEntry[]): SessionEntry[] {
	const last = entries.at(-1);
	const markerProvider = ["sol", "pi"].join("-");
	return [
		...entries,
		{
			type: "message",
			id: "sol-pi-online-context-compact-abort-marker",
			parentId: last?.id ?? null,
			timestamp: new Date(0).toISOString(),
			message: {
				role: "assistant",
				content: [],
				api: markerProvider,
				provider: markerProvider,
				model: "aborted",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "aborted",
				timestamp: 0,
			},
		} as SessionEntry,
	];
}

function estimateNativeCompaction(context: ExtensionContext, observed: readonly AgentMessage[], keepRecentTokens: number): NativeEstimate | undefined {
	const { findCutPoint, sessionEntryToContextMessages, convertToLlm, serializeConversation } = hostModule;
	if (!findCutPoint || !sessionEntryToContextMessages || !convertToLlm || !serializeConversation) return;
	const path = branchAfterAbort(context.sessionManager.getBranch());
	let startIndex = 0;
	let previousSummary = "";
	for (let index = path.length - 1; index >= 0; index--) {
		const entry = path[index];
		if (entry?.type !== "compaction") continue;
		const keptIndex = path.findIndex((item) => item.id === entry.firstKeptEntryId);
		startIndex = keptIndex >= 0 ? keptIndex : index + 1;
		previousSummary = entry.summary;
		break;
	}
	const cut = findCutPoint(path, startIndex, path.length, keepRecentTokens);
	const messages = (start: number, end: number): AgentMessage[] => path.slice(start, end)
		.flatMap((entry) => entry.type === "compaction" ? [] : sessionEntryToContextMessages(entry));
	const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
	const history = messages(startIndex, historyEnd);
	const prefix = cut.isSplitTurn ? messages(cut.turnStartIndex, cut.firstKeptEntryIndex) : [];
	if (history.length === 0 && prefix.length === 0) return;
	const summaryCalls = Number(history.length > 0) + Number(prefix.length > 0);
	const memoTokens = DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE * summaryCalls;
	const summaryInputTokens = tokenEstimate(serializeConversation(convertToLlm([...history, ...prefix])))
		+ tokenEstimate(previousSummary) + SUMMARY_PROMPT_TOKEN_ESTIMATE * summaryCalls;
	const cost = context.model?.cost;
	const summaryCostTokens = cost && cost.cacheRead > 0 && cost.input >= 0 && cost.output >= 0
		? (summaryInputTokens * cost.input + memoTokens * cost.output) / cost.cacheRead
		: null;
	const projected = projectedEntryTokens(path, observed, sessionEntryToContextMessages);
	const lastCompaction = path.findLastIndex((entry) => entry.type === "compaction");
	const archiveTokens = path.filter((entry, index) => entry.type === "compaction"
		? index === lastCompaction
		: index >= startIndex && index < cut.firstKeptEntryIndex)
		.reduce((total, entry) => total + (projected.get(entry.id) ?? 0), 0);
	return {
		writeTokens: messageTokens(observed) + tokenEstimate(context.getSystemPrompt()),
		archiveTokens,
		memoTokens,
		summaryCostTokens,
	};
}

function validPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isCompactionCancellation(error: Error): boolean {
	return error.name === "AbortError" || error.message === "Compaction cancelled";
}

// Host and provider error text can carry paths or URLs; the ledger keeps only the stop point.
function compactionFailureKind(error: Error): string {
	return RECOVERABLE_COMPACTION_ERRORS.get(error.message) ?? "other";
}

type SelectionClearCause = "correction" | "restore" | "shutdown" | "compaction";

export function createOnlineContextCompactExtension(options: OnlineContextCompactOptions = {}): ExtensionFactory {
	const keepRecentTokens = resolveKeepRecentTokens(options.keepRecentTokens);
	const cacheWriteReadRatio = resolveCacheWriteReadRatio(options.cacheWriteReadRatio);

	return (pi) => {
		let state: OnlineState = initialOnlineState();
		let restored = false;
		let observedMessages: readonly AgentMessage[] = [];
		let pendingBoundary: PendingBoundary | undefined;
		let selected: SelectedCompaction | undefined;
		let activeDebt: SelectedCompaction | undefined;
		let nextContinuation: PendingContinuation | undefined;
		let compactionInFlight = false;
		let compactionRefused = false;

		const releaseContinuation = (): void => {
			const continuation = nextContinuation;
			nextContinuation = undefined;
			continuation?.resolve();
		};
		const releaseParentContinuation = (continuation: PendingContinuation | undefined): void => {
			if (continuation) setTimeout(continuation.resolve, 0);
		};
		// Each selected boundary reports where it stopped: compacted and continued,
		// cancelled, failed, or cleared before compaction started.
		const reportSettlement = (
			context: ExtensionContext,
			outcome: string,
			fields: Readonly<Record<string, unknown>> = {},
		): void => options.recordDiagnostic?.(context, { event: "occ_settlement", outcome, ...fields });
		const reportClearedSelection = (context: ExtensionContext, cause: SelectionClearCause): void => {
			if (selected || activeDebt) reportSettlement(context, "cleared", { cause, started: activeDebt !== undefined });
		};

		const restore = (context: ExtensionContext): void => {
			reportClearedSelection(context, "restore");
			releaseContinuation();
			compactionRefused = false;
			state = restoreOnlineState(context.sessionManager.getBranch());
			restored = true;
			observedMessages = [];
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			compactionInFlight = false;
		};
		const ensureRestored = (context: ExtensionContext): void => {
			if (!restored) restore(context);
		};
		const save = (): void => appendOnlineState(pi, state);
		const contextTokens = (context: ExtensionContext): number => {
			const visible = observedMessages.reduce((total, message) => total + estimateTokens(message), 0);
			const estimated = visible + tokenEstimate(context.getSystemPrompt());
			const reported = context.getContextUsage()?.tokens;
			return validPositiveInteger(reported) ? Math.max(reported, estimated) : estimated;
		};

		registerOnlineTools(pi, {
			updatePlan: async (input) => {
				ensureRestored(input.context);
				if (input.signal?.aborted) throw new Error("Plan update was aborted");
				const steps = parsePlanSteps(input.steps);
				if (!steps || steps.length === 0) throw new Error("Plan must contain at least one valid step");

				const transition = analyzePlanTransition(state.plan, steps);
				const completedIds = transition.completedSteps.map((step) => step.id);
				if (completedIds.length > 0) {
					state = recordBoundary(state, steps, progressSummary(input, completedIds[0] ?? ""));
					if (!pendingBoundary) pendingBoundary = { toolCallId: input.toolCallId };
				} else if (JSON.stringify(state.plan) !== JSON.stringify(steps)) {
					state = { ...state, plan: [...steps] };
				}
				save();

				return result(
					[formatPlanSnapshot(steps), ...transition.advice].join("\n"),
					{
						boundary: completedIds.length > 0,
						completed_step_ids: completedIds,
						progress_recorded: completedIds.length > 0 && input.progress !== undefined,
						task_status: "active",
						plan: steps,
					},
				);
			},
		});

		pi.on("session_start", (_event, context) => restore(context));
		pi.on("session_before_tree", () => (compactionInFlight ? { cancel: true } : undefined));
		pi.on("session_tree", (_event, context) => restore(context));

		pi.on("context", (event, context) => {
			ensureRestored(context);
			observedMessages = [...event.messages];
		});

		pi.on("before_provider_request", (_event, context) => {
			ensureRestored(context);
			state = recordProviderRequest(state, contextTokens(context));
			save();
		});

		pi.on("input", (event, context) => {
			compactionRefused = false;
			ensureRestored(context);
			if (event.streamingBehavior !== "steer" && !event.text.startsWith("CORRECTION:")) {
				const next = recordCompletedPlanHandoff(state);
				if (next !== state) {
					state = next;
					save();
				}
				return { action: "continue" as const };
			}
			reportClearedSelection(context, "correction");
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			state = recordCorrection(state);
			save();
			return { action: "continue" as const };
		});

		pi.on("turn_end", (event, context) => {
			// A restated plan cannot make a rejected compaction feasible.
			if (event.toolResults.some((item) => item.toolName !== "update_plan" && !item.isError)) compactionRefused = false;
			const boundary = pendingBoundary;
			pendingBoundary = undefined;
			if (!boundary || selected || compactionRefused) return;
			const report = (entry: Readonly<Record<string, unknown>>): void =>
				options.recordDiagnostic?.(context, { event: "occ_boundary", ...entry });
			const toolResult = event.toolResults.find((item) => item.toolCallId === boundary.toolCallId);
			if (
				event.message.role !== "assistant" ||
				event.message.stopReason === "error" ||
				event.message.stopReason === "aborted" ||
				context.signal?.aborted ||
				!toolResult ||
				toolResult.isError
			) {
				report({ outcome: "turn_failed" });
				return;
			}

			const usage = context.getContextUsage();
			const estimate = estimateNativeCompaction(context, observedMessages, keepRecentTokens);
			if (!estimate) {
				report({ outcome: "estimate_unavailable" });
				return;
			}
			const contextWindowTokens = validPositiveInteger(usage?.contextWindow)
				? usage.contextWindow
				: validPositiveInteger(context.model?.contextWindow)
					? context.model.contextWindow
					: null;
			const averageContextTokenIncrement =
				state.positiveContextDeltaCount === 0
					? null
					: state.positiveContextDeltaTotal / state.positiveContextDeltaCount;
			const decision = decideCompaction({
				...estimate,
				contextTokens: contextTokens(context),
				completedBoundaryRequestCounts: state.completedBoundaryRequestCounts,
				remainingBoundaries: state.plan.filter((step) => step.status !== "completed").length,
				averageContextTokenIncrement,
				contextWindowTokens,
				priorCompactionCount: state.nativeCompactionCount,
				requestsSinceLastCompaction: state.lastCompactionRequestCount === null
					? null : state.requestCount - state.lastCompactionRequestCount,
				carriedDebtTokens: state.cacheDebtTokens,
				cacheDebtRepaymentTokens: state.cacheDebtRepaymentTokens,
				cacheWriteReadRatio,
				economics: DEFAULT_COMPACTION_ECONOMICS,
			});
			report({
				outcome: decision.compact ? "compact" : "defer",
				reason: decision.reason,
				planSteps: state.plan.length,
				completedIntervals: state.completedBoundaryRequestCounts.length,
				expectedRemainingRequests: decision.expectedRemainingRequests,
				breakevenRequests: decision.breakevenRequests,
				combinedBreakevenRequests: decision.combinedBreakevenRequests,
				writeTokens: decision.writeTokens,
				archiveTokens: decision.archiveTokens,
				memoTokens: decision.memoTokens,
				summaryCostTokens: decision.summaryCostTokens,
				contextTokens: decision.contextTokens,
				contextWindowTokens,
				carriedDebtTokens: decision.carriedDebtTokens,
			});
			if (!decision.compact) return;

			selected = { decision };
			context.abort();
		});

		pi.on("agent_settled", async (_event, context) => {
			// sendMessage() starts a turn without returning its promise. Capture the
			// child settlement so print/JSON mode cannot dispose while it is running.
			const parentContinuation = nextContinuation;
			nextContinuation = undefined;
			const pending = selected;
			selected = undefined;
			if (!context.isIdle()) {
				if (pending) reportSettlement(context, "busy");
				selected = pending;
				nextContinuation = parentContinuation;
				return;
			}
			if (!pending) {
				releaseParentContinuation(parentContinuation);
				return;
			}

			activeDebt = { decision: pending.decision };
			let compacted = false;
			let compactionError: Error | undefined;
			let stage: "compact" | "continuation" = "compact";
			try {
				compactionInFlight = true;
				reportSettlement(context, "compacting");
				await new Promise<void>((resolve) => {
					let finished = false;
					const finish = (): void => {
						if (finished) return;
						finished = true;
						resolve();
					};
					context.compact({
						customInstructions: BOUNDARY_COMPACTION_INSTRUCTIONS,
						onComplete: (compaction) => {
							try {
								compacted = true;
								const removed = Math.max(
									0,
									pending.decision.archiveTokens - tokenEstimate(compaction.summary),
								);
								if (removed > 0) {
									showSolPiSavings(
										context,
										"Online Context Compact",
										formatSavingsCount(removed, "context tokens removed"),
									);
								}
							} finally {
								finish();
							}
						},
						onError: (error) => {
							activeDebt = undefined;
							compactionError = error;
							finish();
						},
					});
				});
				compactionInFlight = false;
				const recoverableError = compactionError !== undefined && RECOVERABLE_COMPACTION_ERRORS.has(compactionError.message);
				if (compactionError && !recoverableError) {
					if (!isCompactionCancellation(compactionError)) throw compactionError;
					reportSettlement(context, "cancelled", { stage });
				}
				if (recoverableError) {
					compactionRefused = true;
					if (context.mode === "tui") context.ui.notify(SKIPPED_COMPACTION_REMINDER, "warning");
				}

				if (compacted || recoverableError) {
					stage = "continuation";
					let resolveContinuation!: () => void;
					const continuation: PendingContinuation = {
						promise: new Promise<void>((resolve) => {
							resolveContinuation = resolve;
						}),
						resolve: () => resolveContinuation(),
					};
					nextContinuation = continuation;
					try {
						pi.sendMessage(
							{
								customType: "sol-pi-online-context-compact",
								content: compacted ? POST_COMPACTION_PLAN_REMINDER : SKIPPED_COMPACTION_REMINDER,
								display: false,
							},
							{ triggerTurn: true },
						);
					} catch (error) {
						if (nextContinuation === continuation) nextContinuation = undefined;
						continuation.resolve();
						throw error;
					}
					if (context.isIdle() && nextContinuation === continuation) {
						// Pi defers turns queued from agent_settled until every handler returns.
						nextContinuation = undefined;
						continuation.resolve();
						reportSettlement(context, "continuation_queued", compacted ? {} : { compaction: "skipped" });
					} else {
						await continuation.promise;
						reportSettlement(context, "continued", compacted ? {} : { compaction: "skipped" });
					}
				}
			} catch (error) {
				const failure = error instanceof Error ? error : new Error(String(error));
				reportSettlement(context, "failed", { stage, failure: compactionFailureKind(failure) });
				throw error;
			} finally {
				compactionInFlight = false;
				activeDebt = undefined;
				releaseParentContinuation(parentContinuation);
			}
		});

		pi.on("session_compact", (event, context) => {
			ensureRestored(context);
			compactionRefused = false;
			const decision = activeDebt?.decision;
			const summaryTokens = tokenEstimate(event.compactionEntry.summary);
			const savedTokens = decision ? Math.max(0, decision.archiveTokens - summaryTokens) : 0;
			const summaryCost = event.compactionEntry.usage?.cost.total;
			const cacheReadPrice = context.model?.cost.cacheRead;
			const summaryDebt = summaryCost !== undefined && summaryCost > 0 && cacheReadPrice && cacheReadPrice > 0
				? summaryCost * TOKENS_PER_MILLION / cacheReadPrice
				: event.fromExtension ? 0 : decision?.summaryCostTokens ?? 0;
			const debtTokens = decision ? Math.max(0, decision.writeTokens - decision.archiveTokens + summaryTokens)
				* (decision.incrementalCacheCostRatio ?? 0) + summaryDebt : 0;
			state = recordCompaction(state, { debtTokens, repaymentTokens: savedTokens });
			save();
			options.recordDiagnostic?.(context, {
				event: "occ_compaction",
				boundary: decision !== undefined,
				trigger: event.reason,
				fromExtension: event.fromExtension,
				summaryTokens,
				debtTokens,
				repaymentTokens: savedTokens,
				summaryCostReported: summaryCost ?? null,
			});
			if (!decision) reportClearedSelection(context, "compaction");
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			observedMessages = [];
		});

		pi.on("session_shutdown", (_event, context) => {
			reportClearedSelection(context, "shutdown");
			releaseContinuation();
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			compactionInFlight = false;
		});
	};
}
