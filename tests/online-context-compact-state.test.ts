/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from "vitest";
import {
	appendOnlineState,
	initialOnlineState,
	ONLINE_STATE_ENTRY,
	recordBoundary,
	recordCompaction,
	recordCompletedPlanHandoff,
	recordCorrection,
	recordProviderRequest,
	restoreOnlineState,
} from "../src/sol-pi/extensions/online-context-compact/state.ts";
import { FakePi, FakeSessionManager } from "./helpers.ts";

const PLAN = [
	{ id: "inspect", goal: "inspect the implementation", status: "completed" as const },
	{ id: "verify", goal: "verify the change", status: "in_progress" as const },
];

const PROGRESS = {
	stepId: "inspect",
	goal: "inspect the implementation",
	filesChanged: ["src/a.ts"],
	verification: ["targeted test passed"],
	decisions: ["keep the change small"],
	nextWork: ["verify the change"],
};

describe("Online Context Compact state snapshots", () => {
	it("starts with a disabled-by-default empty state", () => {
		expect(initialOnlineState()).toEqual({
			version: 1,
			epoch: 0,
			plan: [],
			pendingProgress: [],
			requestCount: 0,
			lastBoundaryRequestCount: 0,
			completedBoundaryRequestCounts: [],
			lastContextTokens: null,
			positiveContextDeltaTotal: 0,
			positiveContextDeltaCount: 0,
			nativeCompactionCount: 0,
			lastCompactionRequestCount: null,
			cacheDebtTokens: 0,
			cacheDebtRepaymentTokens: 0,
		});
	});

	it("restores the latest valid snapshot and ignores a malformed tail", () => {
		const manager = new FakeSessionManager();
		const pi = new FakePi(manager);
		const state = recordBoundary(recordProviderRequest(initialOnlineState(), 100), PLAN, PROGRESS);
		appendOnlineState(pi.asExtensionApi(), state);
		manager.appendCustomEntry(ONLINE_STATE_ENTRY, { version: 1, plan: "broken" });

		expect(restoreOnlineState(manager.entries)).toEqual(state);
	});

	it("counts requests, positive context growth, and cache-debt repayment", () => {
		const charged = {
			...initialOnlineState(),
			cacheDebtTokens: 300,
			cacheDebtRepaymentTokens: 100,
		};
		const first = recordProviderRequest(charged, 1_000);
		const second = recordProviderRequest(first, 1_250);
		const third = recordProviderRequest(second, 900);

		expect(third).toMatchObject({
			requestCount: 3,
			lastContextTokens: 900,
			positiveContextDeltaTotal: 250,
			positiveContextDeltaCount: 1,
			cacheDebtTokens: 0,
			cacheDebtRepaymentTokens: 0,
		});
	});

	it("records one request interval and one progress summary per boundary", () => {
		let state = initialOnlineState();
		state = recordProviderRequest(state, 100);
		state = recordProviderRequest(state, 200);
		state = recordBoundary(state, PLAN, PROGRESS);
		state = recordProviderRequest(state, 300);
		state = recordBoundary(state, PLAN, undefined);

		expect(state.completedBoundaryRequestCounts).toEqual([2, 1]);
		expect(state.lastBoundaryRequestCount).toBe(3);
		expect(state.pendingProgress).toEqual([PROGRESS]);
	});

	it("preserves the active plan and growth samples across native compaction", () => {
		const before = recordBoundary(recordProviderRequest(recordProviderRequest(initialOnlineState(), 4_000), 5_000), PLAN, PROGRESS);
		const after = recordCompaction(before, { debtTokens: 1_200, repaymentTokens: 300 });

		expect(after).toMatchObject({
			epoch: 1,
			plan: PLAN,
			lastContextTokens: null,
			positiveContextDeltaTotal: 1_000,
			positiveContextDeltaCount: 1,
			lastCompactionRequestCount: 2,
			pendingProgress: [],
			nativeCompactionCount: 1,
			cacheDebtTokens: 1_200,
			cacheDebtRepaymentTokens: 300,
		});
	});

	it("retains prior debt and repayment across another compaction", () => {
		const prior = { ...initialOnlineState(), cacheDebtTokens: 1_000, cacheDebtRepaymentTokens: 100 };
		expect(recordCompaction(prior, { debtTokens: 600, repaymentTokens: 200 })).toMatchObject({
			cacheDebtTokens: 1_600, cacheDebtRepaymentTokens: 300,
		});
		expect(recordCompaction(prior, { debtTokens: 0, repaymentTokens: 0 })).toMatchObject({
			cacheDebtTokens: 1_000, cacheDebtRepaymentTokens: 100,
		});
	});

	it("restores older v1 snapshots without a compaction request baseline", () => {
		const manager = new FakeSessionManager();
		const { lastCompactionRequestCount: _baseline, ...legacy } = recordProviderRequest(initialOnlineState(), 500);
		manager.appendCustomEntry(ONLINE_STATE_ENTRY, legacy);
		expect(restoreOnlineState(manager.entries)).toMatchObject({ requestCount: 1, lastCompactionRequestCount: null });
	});

	it("starts a new task only after a completed plan and retains session debt", () => {
		const active = recordBoundary(recordProviderRequest(initialOnlineState(), 500), PLAN, PROGRESS);
		expect(recordCompletedPlanHandoff(active)).toBe(active);
		const completed = recordCompaction({ ...active, plan: PLAN.map((step) => ({ ...step, status: "completed" as const })) }, { debtTokens: 900, repaymentTokens: 100 });
		const next = recordCompletedPlanHandoff(completed);
		expect(next).toMatchObject({
			plan: [], pendingProgress: [], completedBoundaryRequestCounts: [],
			lastBoundaryRequestCount: 1, positiveContextDeltaTotal: 0, positiveContextDeltaCount: 0,
			cacheDebtTokens: 900, cacheDebtRepaymentTokens: 100, lastCompactionRequestCount: 1,
		});
		expect(recordCompletedPlanHandoff(next)).toBe(next);
	});

	it("drops stale plan history when the user corrects an active run", () => {
		const before = recordBoundary(recordProviderRequest(initialOnlineState(), 5_000), PLAN, PROGRESS);
		expect(recordCorrection(before)).toMatchObject({
			epoch: 1,
			plan: [],
			pendingProgress: [],
			completedBoundaryRequestCounts: [],
			lastContextTokens: null,
		});
	});
});
