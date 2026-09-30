/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/** Read the append-only diagnostic file through its public row envelope and wait for queued writes. */
import { readFile } from "node:fs/promises";
import { expect, vi } from "vitest";

export interface LedgerRow {
	readonly event: string;
	readonly run: string;
	readonly request: number | null;
	readonly timestamp: string;
	readonly [key: string]: unknown;
}

function ledgerRow(value: unknown): LedgerRow {
	if (typeof value !== "object" || value === null ||
		!("event" in value) || typeof value.event !== "string" ||
		!("run" in value) || typeof value.run !== "string" ||
		!("request" in value) || !(value.request === null || Number.isSafeInteger(value.request)) ||
		!("timestamp" in value) || typeof value.timestamp !== "string") {
		throw new Error("Ledger row omitted its event, run, request, or timestamp");
	}
	// The envelope is checked above; event-specific fields are asserted by each test.
	return value as LedgerRow;
}

export async function waitForLedger(path: string, count: number): Promise<{ text: string; rows: LedgerRow[] }> {
	let result: { text: string; rows: LedgerRow[] } | undefined;
	await vi.waitFor(async () => {
		const text = await readFile(path, "utf8");
		expect(text.endsWith("\n")).toBe(true);
		const rows = text.trimEnd().split("\n").map((line) => ledgerRow(JSON.parse(line)));
		expect(rows).toHaveLength(count);
		result = { text, rows };
	}, { timeout: 2_000, interval: 10 });
	if (!result) throw new Error("Ledger read did not complete");
	return result;
}
