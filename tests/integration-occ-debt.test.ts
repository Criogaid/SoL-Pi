/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_ECONOMICS, decideCompaction } from "../src/sol-pi/extensions/online-context-compact/economics.ts";
import { initialOnlineState, recordCompaction } from "../src/sol-pi/extensions/online-context-compact/state.ts";

describe("integrated cumulative compaction debt", () => {
	it("accumulates debt while retaining the latest memo and request horizon", () => {
		const before = { ...initialOnlineState(), requestCount: 7, cacheDebtTokens: 900, cacheDebtRepaymentTokens: 300 };
		const first = recordCompaction(before, { debtTokens: 400, repaymentTokens: 100, memoTokens: 80 });
		expect(first).toMatchObject({
			cacheDebtTokens: 1_300,
			cacheDebtRepaymentTokens: 400,
			lastMemoTokens: 80,
			lastCompactionRequestCount: 7,
		});
		const second = recordCompaction(first, { debtTokens: 200, repaymentTokens: 50, memoTokens: 60 });
		expect(second).toMatchObject({
			cacheDebtTokens: 1_500,
			cacheDebtRepaymentTokens: 450,
			lastMemoTokens: 60,
			lastCompactionRequestCount: 7,
		});
	});

	it("prices the accumulated unpaid debt in later decisions", () => {
		const result = decideCompaction({
			writeTokens: 500,
			archiveTokens: 200,
			memoTokens: 100,
			contextTokens: 80_000,
			completedBoundaryRequestCounts: [4, 6, 5],
			remainingBoundaries: 4,
			averageContextTokenIncrement: 2_000,
			contextWindowTokens: 200_000,
			priorCompactionCount: 1,
			carriedDebtTokens: 1_000,
			cacheDebtRepaymentTokens: 200,
			cacheWriteReadRatio: 2,
			economics: DEFAULT_COMPACTION_ECONOMICS,
		});
		expect(result.postCompactionTokens).toBe(400);
		expect(result.breakevenRequests).toBe(4);
		expect(result.combinedBreakevenRequests).toBeCloseTo(14 / 3);
	});
});
