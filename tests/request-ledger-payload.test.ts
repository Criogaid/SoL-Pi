/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/** Provider payload fixtures assert category attribution and serialized UTF-8 byte accounting. */
import { describe, expect, it } from "vitest";
import { PLACEHOLDER_PREFIX } from "../src/sol-pi/extensions/observation-pack/observation.ts";
import { payloadUnits } from "../src/sol-pi/request-ledger.ts";

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function categories(payload: unknown): string[][] {
	return payloadUnits(payload).units.map((unit) => [...new Set(unit.parts.map(([category]) => category))]);
}

const PROVIDERS = ["responses", "chat", "anthropic"] as const;
type ProviderShape = (typeof PROVIDERS)[number];

function resultPayload(provider: ProviderShape, output: string, withId = true): unknown {
	if (provider === "responses") {
		return { input: [
			{ type: "function_call", name: "read", call_id: "read-call", arguments: "{}" },
			{ type: "function_call_output", ...(withId ? { call_id: "read-call" } : {}), output },
		] };
	}
	if (provider === "chat") {
		return { messages: [
			{ role: "assistant", tool_calls: [{ id: "read-call", type: "function", function: { name: "read", arguments: "{}" } }] },
			{ role: "tool", ...(withId ? { tool_call_id: "read-call" } : {}), content: output },
		] };
	}
	return { messages: [
		{ role: "assistant", content: [{ type: "tool_use", id: "read-call", name: "read", input: {} }] },
		{ role: "user", content: [{ type: "tool_result", ...(withId ? { tool_use_id: "read-call" } : {}), content: output }] },
	] };
}

const RESPONSE_TOOLS = [{ type: "function", name: "write", parameters: { type: "object" } }];
const RESPONSE_INPUT = [
	{ role: "developer", content: "Developer instructions" },
	{ role: "system", content: [{ type: "input_text", text: "System instructions" }] },
	{ role: "user", content: [{ type: "input_text", text: "Question" }, { type: "input_image", image_url: "data:image/png;base64,c3ludGhldGlj" }] },
	{ type: "reasoning", encrypted_content: "synthetic-encrypted-reasoning", summary: [] },
	{ type: "function_call", call_id: "write-call", name: "write", arguments: JSON.stringify({ path: "sample.ts", content: "const value = 1;" }) },
	{ type: "function_call_output", call_id: "write-call", output: "Written" },
	{ type: "custom_tool_call", call_id: "custom-call", name: "edit", input: "synthetic grammar input" },
	{ type: "custom_tool_call_output", call_id: "custom-call", output: "Edited" },
];
const CHAT_MESSAGES = [
	{ role: "system", content: "System instructions" },
	{ role: "developer", content: "Developer instructions" },
	{ role: "user", content: "Question" },
	{ role: "assistant", content: "Running tools", tool_calls: [
		{ id: "write-call", type: "function", function: { name: "write", arguments: "{}" } },
		{ id: "bash-call", type: "function", function: { name: "bash", arguments: "{}" } },
	] },
	{ role: "tool", tool_call_id: "bash-call", content: "Tests passed" },
	{ role: "tool", tool_call_id: "write-call", content: "Written" },
];
const ANTHROPIC_MESSAGES = [
	{ role: "assistant", content: [
		{ type: "thinking", thinking: "Synthetic thought", signature: "synthetic-signature" },
		{ type: "redacted_thinking", data: "synthetic-redacted-data" },
		{ type: "text", text: "Reading" },
		{ type: "tool_use", id: "read-call", name: "read", input: { path: "sample.ts" } },
	] },
	{ role: "user", content: [
		{ type: "tool_result", tool_use_id: "read-call", content: [{ type: "text", text: "file body" }] },
		{ type: "image", source: { type: "base64", media_type: "image/png", data: "c3ludGhldGlj" } },
	] },
];

const FIXTURES = [
	{
		name: "Responses",
		payload: { tools: RESPONSE_TOOLS, instructions: "Top-level instructions", input: RESPONSE_INPUT, model: "synthetic", stream: true, reasoning: { effort: "high" } },
		units: [RESPONSE_TOOLS, "Top-level instructions", ...RESPONSE_INPUT],
		options: ["synthetic", true, { effort: "high" }],
		categories: [["tools"], ["system"], ["system"], ["system"], ["user", "image"], ["reasoning"], ["tool_call:write"], ["tool_result:write:lt4k"], ["tool_call:edit"], ["tool_result:edit:lt4k"]],
	},
	{
		name: "Chat Completions",
		payload: { messages: CHAT_MESSAGES, model: "synthetic", temperature: 0 },
		units: CHAT_MESSAGES,
		options: ["synthetic", 0],
		categories: [["system"], ["system"], ["user"], ["assistant_text", "tool_call:write", "tool_call:bash"], ["tool_result:bash:lt4k"], ["tool_result:write:lt4k"]],
	},
	{
		name: "Anthropic",
		payload: { system: [{ type: "text", text: "System instructions", cache_control: { type: "ephemeral" } }], messages: ANTHROPIC_MESSAGES, max_tokens: 100 },
		units: [[{ type: "text", text: "System instructions", cache_control: { type: "ephemeral" } }], ...ANTHROPIC_MESSAGES],
		options: [100],
		categories: [["system"], ["assistant_text", "reasoning", "tool_call:read"], ["user", "tool_result:read:lt4k", "image"]],
	},
	{
		name: "unknown provider",
		payload: { contents: [{ text: "Synthetic prompt" }], generationConfig: { maxOutputTokens: 100 }, model: "synthetic", stream: false, temperature: null },
		units: [[{ text: "Synthetic prompt" }], { maxOutputTokens: 100 }],
		options: ["synthetic", false, null],
		categories: [["field:contents"], ["field:generationConfig"]],
	},
];

describe("request ledger payload classification", () => {
	it.each(FIXTURES)("classifies $name without changing the payload and conserves every unit's bytes", (fixture) => {
		const original = structuredClone(fixture.payload);
		const result = payloadUnits(fixture.payload);
		expect(categories(fixture.payload)).toEqual(fixture.categories);
		expect(result.units).toHaveLength(fixture.units.length);
		for (const [index, unit] of result.units.entries()) {
			expect(unit.bytes).toBe(jsonBytes(fixture.units[index]));
			expect(unit.parts.reduce((total, [, bytes]) => total + bytes, 0)).toBe(unit.bytes);
			expect(unit.parts.every(([, bytes]) => Number.isSafeInteger(bytes) && bytes >= 0)).toBe(true);
			expect(unit.hash).toMatch(/^[a-f0-9]{12}$/u);
		}
		expect(result.optionBytes).toBe(fixture.options.reduce<number>((total, option) => total + jsonBytes(option), 0));
		expect(fixture.payload).toEqual(original);
		expect(payloadUnits(fixture.payload)).toEqual(result);
	});

	describe.each(PROVIDERS)("%s tool results", (provider) => {
		it.each([
			[4095, "lt4k"],
			[4096, "4to10k"],
			[10240, "4to10k"],
			[10241, "gt10k"],
		] as const)("classifies %i text bytes as %s", (bytes, band) => {
			expect(categories(resultPayload(provider, "x".repeat(bytes))).at(-1)).toContain(`tool_result:read:${band}`);
		});

		it.each([
			["界".repeat(1365), "lt4k"],
			[`${"界".repeat(1365)}a`, "4to10k"],
			["😀".repeat(1024), "4to10k"],
			[`${"界".repeat(3413)}a`, "4to10k"],
			[`${"界".repeat(3413)}ab`, "gt10k"],
		] as const)("uses UTF-8 bytes for multibyte result case %#", (body, band) => {
			expect(categories(resultPayload(provider, body)).at(-1)).toContain(`tool_result:read:${band}`);
		});

		it("uses raw result text for its band and serialized JSON for byte accounting", () => {
			const payload = resultPayload(provider, "\n".repeat(4095));
			const unit = payloadUnits(payload).units.at(-1);
			expect(categories(payload).at(-1)).toContain("tool_result:read:lt4k");
			expect(unit?.bytes).toBeGreaterThan(8190);
			expect(unit?.parts.reduce((total, [, bytes]) => total + bytes, 0)).toBe(unit?.bytes);
		});

		it.each([
			[`${PLACEHOLDER_PREFIX} after 2 successful responses on this branch]\narchived`, "placeholder"],
			["prefix\nsol_pi_evidence_receipt_v1\nverified evidence", "receipt"],
			[`${PLACEHOLDER_PREFIX}]\nsol_pi_evidence_receipt_v1`, "placeholder"],
			[`prefix ${PLACEHOLDER_PREFIX}]`, "lt4k"],
		] as const)("recognizes result marker case %# before applying size bands", (body, band) => {
			expect(categories(resultPayload(provider, body)).at(-1)).toContain(`tool_result:read:${band}`);
		});

		it("does not guess the tool name when the result omits its call id", () => {
			expect(categories(resultPayload(provider, "result", false)).at(-1)).toContain("tool_result:unknown:lt4k");
		});
	});

	it("does not retain call-id mappings between payloads", () => {
		payloadUnits(resultPayload("responses", "first"));
		expect(categories({ input: [{ type: "function_call_output", call_id: "read-call", output: "orphan" }] })).toEqual([
			["tool_result:unknown:lt4k"],
		]);
	});

	it.each([null, "scalar prompt", ["non-object", "payload"]])("accounts for a non-object payload: %j", (payload) => {
		const { units, optionBytes } = payloadUnits(payload);
		expect(optionBytes).toBe(0);
		expect(units).toEqual([{ hash: expect.stringMatching(/^[a-f0-9]{12}$/u), bytes: jsonBytes(payload), parts: [["other", jsonBytes(payload)]] }]);
	});
});
