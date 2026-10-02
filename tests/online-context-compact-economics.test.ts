/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMPACTION_ECONOMICS,
	decideCompaction,
	estimateRemainingRequests,
} from "../src/sol-pi/extensions/online-context-compact/economics.ts";

function decision(overrides: Partial<Parameters<typeof decideCompaction>[0]> = {}) {
	return decideCompaction({
		writeTokens: 80_000,
		archiveTokens: 60_000,
		memoTokens: 1_000,
		summaryCostTokens: 0,
		contextTokens: 80_000,
		completedBoundaryRequestCounts: [4, 6, 5],
		remainingBoundaries: 4,
		averageContextTokenIncrement: 2_000,
		contextWindowTokens: 200_000,
		priorCompactionCount: 0,
		carriedDebtTokens: 0,
		cacheDebtRepaymentTokens: 0,
		cacheWriteReadRatio: 1,
		economics: DEFAULT_COMPACTION_ECONOMICS,
		...overrides,
	});
}

describe("Online Context Compact economics", () => {
	it("charges the retained context and summary call in cache-read token equivalents", () => {
		const result = decision({ writeTokens: 100_000, archiveTokens: 80_000, summaryCostTokens: 40_000, cacheWriteReadRatio: 12.5 });
		expect(result.breakevenRequests).toBeCloseTo((21_000 * 11.5 + 40_000) / 79_000);
	});

	it("repays outstanding debt with cumulative savings across compactions", () => {
		const result = decision({ priorCompactionCount: 1, carriedDebtTokens: 100_000, cacheDebtRepaymentTokens: 20_000, summaryCostTokens: 1_000 });
		expect(result.combinedBreakevenRequests).toBeCloseTo(101_000 / 79_000);
	});

	it("defers unpriced summaries except under window pressure", () => {
		expect(decision({ summaryCostTokens: null })).toMatchObject({ compact: false, reason: "summary_cost_unavailable" });
		expect(decision({ summaryCostTokens: null, contextTokens: 195_000 })).toMatchObject({ compact: true, reason: "window_protection" });
	});

	it("estimates the remaining request horizon from completed boundaries", () => {
		expect(
			estimateRemainingRequests({
				completedBoundaryRequestCounts: [4, 6, 5],
				remainingBoundaries: 3,
				scale: 1,
				standardDeviationK: 0,
				contextTokens: 100_000,
				contextWindowTokens: 200_000,
				averageContextTokenIncrement: 5_000,
			}),
		).toMatchObject({
			requestsPerBoundaryMean: 5,
			expectedRemainingRequests: 16,
			windowRequestUpperBound: 20,
		});
	});

	it("rejects a compaction that cannot remove more than its summary", () => {
		expect(decision({ archiveTokens: 500, memoTokens: 1_000 })).toMatchObject({
			compact: false,
			reason: "non_positive_saving",
		});
	});

	it("compacts when the economic breakeven fits the remaining horizon", () => {
		expect(decision()).toMatchObject({ compact: true, reason: "economic" });
	});

	it("uses window protection even when the ordinary economic gate defers", () => {
		expect(
			decision({
				contextTokens: 195_000,
				cacheWriteReadRatio: 100,
				economics: { ...DEFAULT_COMPACTION_ECONOMICS, windowReserveTokens: 10_000 },
			}),
		).toMatchObject({ compact: true, reason: "window_protection" });
	});

	it("defers economic compaction when no cache ratio is available", () => {
		expect(decision({ cacheWriteReadRatio: null })).toMatchObject({
			compact: false,
			reason: "cache_ratio_unavailable",
		});
	});

	it("waits for provider requests after compaction unless window protection applies", () => {
		const input = { priorCompactionCount: 1, cacheWriteReadRatio: 2, requestsSinceLastCompaction: 1 };
		expect(decision(input)).toMatchObject({ compact: false, reason: "deferred_post_compaction_cooldown" });
		expect(decision({ ...input, requestsSinceLastCompaction: DEFAULT_COMPACTION_ECONOMICS.minimumRequestsSinceCompaction })).toMatchObject({ compact: true, reason: "economic" });
		expect(decision({ ...input, contextTokens: 199_999 })).toMatchObject({ compact: true, reason: "window_protection" });
	});

	it("charges carried debt only after the first compaction", () => {
		const result = decision({
			priorCompactionCount: 1,
			cacheWriteReadRatio: 2,
			carriedDebtTokens: 2_000_000,
		});
		expect(result.compact).toBe(false);
		expect(result.reason).toBe("deferred_carried_debt");
		expect(result.combinedBreakevenRequests).toBeGreaterThan(result.breakevenRequests ?? 0);
	});
});
