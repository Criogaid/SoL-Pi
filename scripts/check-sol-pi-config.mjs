/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { FEATURE_KEYS, parseSolPiConfig } from "../src/sol-pi/config-values.mjs";

function fail(message) {
	throw new Error(message);
}

function parseArguments(argv) {
	const options = { config: undefined, requireAllEnabled: false };
	const seen = new Set();
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (seen.has(argument)) fail(`duplicate option: ${argument}`);
		if (argument === "--require-all-enabled") {
			seen.add(argument);
			options.requireAllEnabled = true;
			continue;
		}
		if (argument !== "--config") fail(`unknown option: ${argument}`);
		seen.add(argument);
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) fail("missing value for --config");
		options.config = value;
		index += 1;
	}
	if (!options.config) fail("--config is required");
	return options;
}

function readConfig(path) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		fail(`unable to read config ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		fail(`invalid JSON in config ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function validateConfig(value, requireAllEnabled) {
	const effective = { version: 1 };
	const config = parseSolPiConfig(value, (key, enabled) => {
		effective[key] = enabled;
		if (requireAllEnabled && !enabled) fail(`${key} must be true`);
	});

	return {
		ok: true,
		all_enabled: FEATURE_KEYS.every((key) => effective[key] === true),
		// Keep the CLI's field order without maintaining a second set of defaults.
		effective_config: { ...effective, cacheWriteReadRatio: config.cacheWriteReadRatio, ...config },
	};
}

try {
	const options = parseArguments(process.argv.slice(2));
	const configPath = resolve(options.config);
	const result = validateConfig(readConfig(configPath), options.requireAllEnabled);
	console.log(JSON.stringify({ ...result, config: configPath }, null, 2));
} catch (error) {
	console.error(`SoL-Pi configuration preflight failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
