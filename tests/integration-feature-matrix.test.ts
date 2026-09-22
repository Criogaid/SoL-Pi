/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type SolPiConfig } from "../src/sol-pi/config.ts";
import { registerConfiguredFeatures } from "../src/sol-pi/index.ts";
import { FakePi } from "./helpers.ts";

const keys = ["actionFusion", "observationPack", "evidencePreservingReducer", "onlineContextCompact"] as const;

type Signature = { handlers: Record<string, number>; tools: string[] };

function signature(enabled: readonly (typeof keys)[number][]): Signature {
	const pi = new FakePi();
	const config: SolPiConfig = {
		...DEFAULT_CONFIG,
		actionFusion: enabled.includes("actionFusion"),
		observationPack: enabled.includes("observationPack"),
		evidencePreservingReducer: enabled.includes("evidencePreservingReducer"),
		onlineContextCompact: enabled.includes("onlineContextCompact"),
	};
	registerConfiguredFeatures(pi.asExtensionApi(), config);
	return {
		handlers: Object.fromEntries([...pi.handlers].map(([event, handlers]) => [event, handlers.length]).sort()),
		tools: pi.registeredTools.map((tool) => tool.name).sort(),
	};
}

function combinedSignature(enabled: readonly (typeof keys)[number][], singles: Map<string, Signature>): Signature {
	const handlers: Record<string, number> = {};
	const tools: string[] = [];
	for (const key of enabled) {
		const single = singles.get(key)!;
		for (const [event, count] of Object.entries(single.handlers)) handlers[event] = (handlers[event] ?? 0) + count;
		tools.push(...single.tools);
	}
	return { handlers: Object.fromEntries(Object.entries(handlers).sort()), tools: tools.sort() };
}

describe("all 16 feature combinations", () => {
	const singles = new Map(keys.map((key) => [key, signature([key])]));
	for (let mask = 0; mask < 16; mask++) {
		const enabled = keys.filter((_, index) => (mask & (1 << index)) !== 0);
		it(`registers only enabled mechanisms for mask ${mask.toString(2).padStart(4, "0")}`, () => {
			expect(signature(enabled)).toEqual(combinedSignature(enabled, singles));
		});
	}
});
