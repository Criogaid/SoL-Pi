/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import {
	buildSessionContext,
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

function projectedMessages(messages: readonly AgentMessage[], observed: readonly AgentMessage[]): AgentMessage[] {
	const results = new Map(observed.flatMap((message) => message.role === "toolResult" ? [[message.toolCallId, message] as const] : []));
	return messages.map((message) => message.role === "toolResult" ? results.get(message.toolCallId) ?? message : message);
}

export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
export const DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE = 1_000;
export const BOUNDARY_COMPACTION_INSTRUCTIONS =
	"Preserve completed work, verification results, important decisions, and remaining work.";
export const POST_COMPACTION_PLAN_REMINDER =
	"Online context compaction finished. The parent task is still active. " +
	"Before continuing work, call update_plan with a fresh plan for the remaining work.";

export type OnlineContextCompactOptions = {
	readonly cacheWriteReadRatio?: number | null;
	readonly keepRecentTokens?: number;
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
	const beforeTokens = messageTokens(projectedMessages(buildSessionContext(path).messages, observed));
	const retainedTokens = messageTokens(projectedMessages(messages(cut.firstKeptEntryIndex, path.length), observed));
	return {
		writeTokens: beforeTokens + tokenEstimate(context.getSystemPrompt()),
		archiveTokens: Math.max(0, beforeTokens - retainedTokens),
		memoTokens,
		summaryCostTokens,
	};
}

function validPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

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

		const releaseContinuation = (): void => {
			const continuation = nextContinuation;
			nextContinuation = undefined;
			continuation?.resolve();
		};
		const releaseParentContinuation = (continuation: PendingContinuation | undefined): void => {
			if (continuation) setTimeout(continuation.resolve, 0);
		};

		const restore = (context: ExtensionContext): void => {
			releaseContinuation();
			state = restoreOnlineState(context.sessionManager.getBranch());
			restored = true;
			observedMessages = buildSessionContext(
				context.sessionManager.getEntries(),
				context.sessionManager.getLeafId(),
			).messages;
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
			if (event.streamingBehavior !== "steer" && !event.text.startsWith("CORRECTION:")) {
				return { action: "continue" as const };
			}
			ensureRestored(context);
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			state = recordCorrection(state);
			save();
			return { action: "continue" as const };
		});

		pi.on("turn_end", (event, context) => {
			const boundary = pendingBoundary;
			pendingBoundary = undefined;
			if (!boundary || selected) return;
			const toolResult = event.toolResults.find((item) => item.toolCallId === boundary.toolCallId);
			if (
				event.message.role !== "assistant" ||
				event.message.stopReason === "error" ||
				event.message.stopReason === "aborted" ||
				context.signal?.aborted ||
				!toolResult ||
				toolResult.isError
			) {
				return;
			}

			const usage = context.getContextUsage();
			const estimate = estimateNativeCompaction(context, observedMessages, keepRecentTokens);
			if (!estimate) return;
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
				carriedDebtTokens: state.cacheDebtTokens,
				cacheDebtRepaymentTokens: state.cacheDebtRepaymentTokens,
				cacheWriteReadRatio,
				economics: DEFAULT_COMPACTION_ECONOMICS,
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
			try {
				compactionInFlight = true;
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
							compactionError = error;
							finish();
						},
					});
				});
				compactionInFlight = false;
				if (
					compactionError &&
					compactionError.name !== "AbortError" &&
					compactionError.message !== "Compaction cancelled"
				) {
					throw compactionError;
				}

				if (compacted) {
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
								content: POST_COMPACTION_PLAN_REMINDER,
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
						// Pi 0.87 defers turns queued from agent_settled until every handler returns.
						nextContinuation = undefined;
						continuation.resolve();
					} else {
						await continuation.promise;
					}
				}
			} finally {
				compactionInFlight = false;
				activeDebt = undefined;
				releaseParentContinuation(parentContinuation);
			}
		});

		pi.on("session_compact", (event, context) => {
			ensureRestored(context);
			const decision = activeDebt?.decision;
			const summaryTokens = tokenEstimate(event.compactionEntry.summary);
			const savedTokens = decision ? Math.max(0, decision.archiveTokens - summaryTokens) : 0;
			const summaryCost = event.compactionEntry.usage?.cost.total;
			const cacheReadPrice = context.model?.cost.cacheRead;
			const summaryDebt = summaryCost !== undefined && summaryCost > 0 && cacheReadPrice && cacheReadPrice > 0
				? summaryCost * TOKENS_PER_MILLION / cacheReadPrice
				: event.fromExtension ? 0 : decision?.summaryCostTokens ?? 0;
			state = recordCompaction(state, {
				debtTokens: decision ? Math.max(0, decision.writeTokens - decision.archiveTokens + summaryTokens)
					* (decision.incrementalCacheCostRatio ?? 0) + summaryDebt : 0,
				repaymentTokens: savedTokens,
			});
			save();
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			observedMessages = buildSessionContext(
				context.sessionManager.getEntries(),
				context.sessionManager.getLeafId(),
			).messages;
		});

		pi.on("session_shutdown", () => {
			releaseContinuation();
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			compactionInFlight = false;
		});
	};
}
