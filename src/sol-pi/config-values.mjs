/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
// @ts-check

/** @typedef {Readonly<{
 * version: 1,
 * actionFusion: boolean,
 * observationPack: boolean,
 * evidencePreservingReducer: boolean,
 * evidencePreservingReducerModel: string,
 * evidencePreservingReducerProvider: string,
 * onlineContextCompact: boolean,
 * cacheWriteReadRatio: number,
 * }>} SolPiConfig
 */

export const DEFAULT_CACHE_WRITE_READ_RATIO = 12.5;
export const DEFAULT_REDUCER_PROVIDER = ["openai", "codex"].join("-");
export const DEFAULT_REDUCER_MODEL = ["gpt-5.6", "luna"].join("-");

/** @type {SolPiConfig} */
export const DEFAULT_CONFIG = Object.freeze({
	version: 1,
	actionFusion: false,
	observationPack: false,
	evidencePreservingReducer: false,
	evidencePreservingReducerModel: DEFAULT_REDUCER_MODEL,
	evidencePreservingReducerProvider: DEFAULT_REDUCER_PROVIDER,
	onlineContextCompact: false,
	cacheWriteReadRatio: DEFAULT_CACHE_WRITE_READ_RATIO,
});

export const FEATURE_KEYS = /** @type {const} */ ([
	"actionFusion",
	"observationPack",
	"evidencePreservingReducer",
	"onlineContextCompact",
]);
const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG));

/**
 * Validate parsed JSON and return frozen, normalized configuration with defaults.
 * Throws on the first invalid field. checkFeature may reject a feature immediately
 * after its type check, preserving the CLI's all-enabled error order.
 * @param {unknown} value
 * @param {(key: (typeof FEATURE_KEYS)[number], enabled: boolean) => void} [checkFeature]
 * @returns {SolPiConfig}
 */
export function parseSolPiConfig(value, checkFeature) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("config must be a JSON object");
	}
	const record = /** @type {Record<string, unknown>} */ (value);
	for (const key of Object.keys(record)) {
		if (!CONFIG_KEYS.has(key)) throw new Error(`unknown key: ${key}`);
	}
	if (record.version !== 1) throw new Error("version must be 1");
	for (const key of FEATURE_KEYS) {
		const enabled = record[key];
		if (enabled !== undefined && typeof enabled !== "boolean") throw new Error(`${key} must be boolean`);
		checkFeature?.(key, enabled ?? false);
	}
	const cacheWriteReadRatio = Object.hasOwn(record, "cacheWriteReadRatio")
		? record.cacheWriteReadRatio
		: DEFAULT_CACHE_WRITE_READ_RATIO;
	if (typeof cacheWriteReadRatio !== "number" || !Number.isFinite(cacheWriteReadRatio) || cacheWriteReadRatio < 0) {
		throw new Error("cacheWriteReadRatio must be a finite non-negative number");
	}
	return Object.freeze({
		...DEFAULT_CONFIG,
		...record,
		cacheWriteReadRatio,
		evidencePreservingReducerModel: stringConfigValue(record, "evidencePreservingReducerModel", DEFAULT_REDUCER_MODEL),
		evidencePreservingReducerProvider: stringConfigValue(record, "evidencePreservingReducerProvider", DEFAULT_REDUCER_PROVIDER),
	});
}

/** @param {Record<string, unknown>} record @param {string} key @param {string} fallback */
function stringConfigValue(record, key, fallback) {
	const value = Object.hasOwn(record, key) ? record[key] : fallback;
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${key} must be a non-empty string`);
	return value.trim();
}
