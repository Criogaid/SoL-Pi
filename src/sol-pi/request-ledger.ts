/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

/**
 * Request ledger - an opt-in diagnostic record of what each provider request carries.
 *
 * Every provider request appends one JSONL line with the byte size and item
 * count of each payload category, how much of the payload it shares with the
 * previous request, and short hashes of the fixed parts. The usage reported by
 * the matching response follows when the assistant message ends. Other
 * mechanisms may add their own decision lines through the returned recorder.
 *
 * No text, arguments, tool output, or paths are written; categories carry only
 * tool names. The file lives under the session-derived SoL-Pi root. Payloads
 * are provider-specific: OpenAI Responses, Chat Completions, and Anthropic
 * Messages shapes are classified, and any other shape is recorded per
 * top-level field.
 */

import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord, REDUCER_RECEIPT_PREFIX } from "./extensions/evidence-preserving-reducer/config.ts";
import { createLedger, type Ledger } from "./extensions/observation-pack/ledger.ts";
import { PLACEHOLDER_PREFIX, THRESHOLD_BYTES } from "./extensions/observation-pack/observation.ts";
import { runtimeRoot } from "./runtime-paths.ts";

export type RequestLedgerRecorder = (context: ExtensionContext, entry: Readonly<Record<string, unknown>>) => void;

export const REQUEST_LEDGER_FILE = "request-ledger.jsonl";
const SMALL_RESULT_BYTES = 4 * 1024;
const HASH_CHARS = 12;
/** Payload fields that hold the cached prompt; everything else is request options. */
const PROMPT_FIELDS = new Set(["tools", "instructions", "system", "input", "messages"]);

type Part = readonly [category: string, bytes: number];
type Unit = { readonly hash: string; readonly bytes: number; readonly parts: readonly Part[] };
type SessionTrack = { readonly request: number; readonly units: readonly Unit[] };

function json(value: unknown): string {
	return JSON.stringify(value) ?? "";
}

function byteLength(value: unknown): number {
	return Buffer.byteLength(json(value), "utf8");
}

function shortHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, HASH_CHARS);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.map((item) => (isRecord(item) ? (stringField(item, "text") ?? "") : "")).join("\n");
}

function resultCategory(name: string, output: unknown): string {
	const text = textOf(output);
	if (text.startsWith(PLACEHOLDER_PREFIX)) return `tool_result:${name}:placeholder`;
	if (text.includes(REDUCER_RECEIPT_PREFIX)) return `tool_result:${name}:receipt`;
	const bytes = Buffer.byteLength(text, "utf8");
	const size = bytes < SMALL_RESULT_BYTES ? "lt4k" : bytes <= THRESHOLD_BYTES ? "4to10k" : "gt10k";
	return `tool_result:${name}:${size}`;
}

function roleCategory(role: string | undefined): string {
	if (role === "system" || role === "developer") return "system";
	if (role === "assistant") return "assistant_text";
	return role === "user" ? "user" : `role:${role ?? "unknown"}`;
}

/** Classify one content block of a Responses message or an Anthropic message. */
function blockPart(block: unknown, role: string | undefined, names: Map<string, string>): Part {
	const bytes = byteLength(block);
	if (!isRecord(block)) return [roleCategory(role), bytes];
	const type = stringField(block, "type");
	if (type === "thinking" || type === "redacted_thinking") return ["reasoning", bytes];
	if (type === "image" || type === "input_image") return ["image", bytes];
	if (type === "tool_use") {
		const name = stringField(block, "name") ?? "unknown";
		const id = stringField(block, "id");
		if (id) names.set(id, name);
		return [`tool_call:${name}`, bytes];
	}
	if (type === "tool_result") {
		const id = stringField(block, "tool_use_id");
		return [resultCategory((id && names.get(id)) || "unknown", block.content), bytes];
	}
	return [roleCategory(role), bytes];
}

/** Split an item into categories; bytes outside the listed parts go to the first category. */
function itemParts(item: unknown, names: Map<string, string>): Part[] {
	const bytes = byteLength(item);
	if (!isRecord(item)) return [["other", bytes]];
	const type = stringField(item, "type");
	const role = stringField(item, "role");
	let parts: Part[];
	if (type === "reasoning") {
		parts = [["reasoning", bytes]];
	} else if (type === "function_call" || type === "custom_tool_call") {
		const name = stringField(item, "name") ?? "unknown";
		const id = stringField(item, "call_id");
		if (id) names.set(id, name);
		parts = [[`tool_call:${name}`, bytes]];
	} else if (type === "function_call_output" || type === "custom_tool_call_output") {
		const id = stringField(item, "call_id");
		parts = [[resultCategory((id && names.get(id)) || "unknown", item.output), bytes]];
	} else if (role === "tool") {
		const id = stringField(item, "tool_call_id");
		parts = [[resultCategory((id && names.get(id)) || "unknown", item.content), bytes]];
	} else if (role !== undefined) {
		parts = Array.isArray(item.content) ? item.content.map((block) => blockPart(block, role, names)) : [];
		if (Array.isArray(item.tool_calls)) {
			for (const call of item.tool_calls) {
				const fn = isRecord(call) && isRecord(call.function) ? call.function : undefined;
				const name = (fn && stringField(fn, "name")) ?? "unknown";
				const id = isRecord(call) ? stringField(call, "id") : undefined;
				if (id) names.set(id, name);
				parts.push([`tool_call:${name}`, byteLength(call)]);
			}
		}
		parts.unshift([roleCategory(role), 0]);
	} else {
		parts = [[`item:${type ?? "unknown"}`, bytes]];
	}
	const listed = parts.reduce((total, [, size]) => total + size, 0);
	const [first, ...rest] = parts;
	return first ? [[first[0], first[1] + Math.max(0, bytes - listed)], ...rest] : [["other", bytes]];
}

function unit(value: unknown, parts: readonly Part[]): Unit {
	const text = json(value);
	return { hash: shortHash(text), bytes: Buffer.byteLength(text, "utf8"), parts };
}

/** Prompt units in cache-prefix order: tool definitions, system text, then conversation items. */
export function payloadUnits(payload: unknown): { readonly units: Unit[]; readonly optionBytes: number } {
	if (!isRecord(payload)) return { units: [unit(payload, [["other", byteLength(payload)]])], optionBytes: 0 };
	const units: Unit[] = [];
	const names = new Map<string, string>();
	if (payload.tools !== undefined) units.push(unit(payload.tools, [["tools", byteLength(payload.tools)]]));
	for (const key of ["instructions", "system"] as const) {
		if (payload[key] !== undefined) units.push(unit(payload[key], [["system", byteLength(payload[key])]]));
	}
	const items = Array.isArray(payload.input) ? payload.input : Array.isArray(payload.messages) ? payload.messages : undefined;
	for (const item of items ?? []) units.push(unit(item, itemParts(item, names)));
	let optionBytes = 0;
	for (const [key, value] of Object.entries(payload)) {
		if (PROMPT_FIELDS.has(key)) continue;
		// Unknown shapes carry the prompt elsewhere; keep their structured fields visible.
		if (!items && typeof value === "object" && value !== null) units.push(unit(value, [[`field:${key}`, byteLength(value)]]));
		else optionBytes += byteLength(value);
	}
	return { units, optionBytes };
}

function sharedPrefix(previous: readonly Unit[], current: readonly Unit[]): { units: number; bytes: number } {
	let units = 0;
	let bytes = 0;
	while (units < previous.length && units < current.length && previous[units]?.hash === current[units]?.hash) {
		bytes += current[units]?.bytes ?? 0;
		units++;
	}
	return { units, bytes };
}

function categoryTotals(units: readonly Unit[]): Record<string, { items: number; bytes: number }> {
	const totals: Record<string, { items: number; bytes: number }> = {};
	for (const { parts } of units) {
		const counted = new Set<string>();
		for (const [category, bytes] of parts) {
			const total = (totals[category] ??= { items: 0, bytes: 0 });
			// A message split into blocks of one category is still one item.
			if (!counted.has(category)) total.items++;
			counted.add(category);
			total.bytes += bytes;
		}
	}
	return totals;
}

function combinedHash(units: readonly Unit[], category: string): string | null {
	const hashes = units.filter((item) => item.parts[0]?.[0] === category).map((item) => item.hash);
	return hashes.length === 0 ? null : shortHash(hashes.join(","));
}

export function registerRequestLedger(pi: ExtensionAPI): RequestLedgerRecorder {
	const run = randomUUID().slice(0, 8);
	const ledgers = new Map<string, Ledger>();
	const sessions = new Map<string, SessionTrack>();
	let queue: Promise<void> = Promise.resolve();

	const rootOf = (context: ExtensionContext): string | undefined => {
		try {
			return runtimeRoot(context);
		} catch {
			// Invalid session ids or unavailable storage disable diagnostics.
			return undefined;
		}
	};
	const write = (root: string, entry: Readonly<Record<string, unknown>>): void => {
		let ledger = ledgers.get(root);
		if (!ledger) {
			ledger = createLedger(join(root, REQUEST_LEDGER_FILE));
			ledgers.set(root, ledger);
		}
		const append = ledger;
		// Serialize appends so lines keep request order; a diagnostic failure never blocks the request.
		queue = queue
			.then(() => append({ run, ...entry }))
			.catch((error: unknown) => {
				const reason = error instanceof Error ? error.message : String(error);
				console.error(`[sol-pi] request ledger write failed: ${reason}`);
			});
	};
	const record: RequestLedgerRecorder = (context, entry) => {
		const root = rootOf(context);
		if (!root) return;
		write(root, { request: sessions.get(root)?.request ?? null, ...entry });
	};

	pi.on("before_provider_request", (event, context) => {
		const root = rootOf(context);
		if (!root) return;
		const { units, optionBytes } = payloadUnits(event.payload);
		const previous = sessions.get(root);
		const request = (previous?.request ?? 0) + 1;
		const shared = previous ? sharedPrefix(previous.units, units) : undefined;
		sessions.set(root, { request, units });
		write(root, {
			event: "request",
			request,
			provider: context.model?.provider ?? null,
			model: context.model?.id ?? null,
			api: context.model?.api ?? null,
			bytes: byteLength(event.payload),
			optionBytes,
			units: units.length,
			sharedUnits: shared?.units ?? null,
			sharedBytes: shared?.bytes ?? null,
			toolsHash: combinedHash(units, "tools"),
			systemHash: combinedHash(units, "system"),
			categories: categoryTotals(units),
		});
	});

	pi.on("message_end", (event, context) => {
		if (event.message.role !== "assistant") return;
		const { usage, stopReason } = event.message;
		record(context, {
			event: "response",
			stopReason,
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				totalTokens: usage.totalTokens,
				...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
			},
		});
	});

	return record;
}
