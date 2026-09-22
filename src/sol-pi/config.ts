/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, parseSolPiConfig, type SolPiConfig } from "./config-values.mjs";

export { DEFAULT_CONFIG, DEFAULT_CACHE_WRITE_READ_RATIO, type SolPiConfig } from "./config-values.mjs";

export function findConfigPath(
	cwd = process.cwd(),
	agentDir = getAgentDir(),
	allowProjectConfig = false,
): string | undefined {
	if (allowProjectConfig) {
		const projectPath = join(cwd, CONFIG_DIR_NAME, "sol-pi.json");
		if (existsSync(projectPath)) return projectPath;
	}

	const globalPath = join(agentDir, "sol-pi.json");
	return existsSync(globalPath) ? globalPath : undefined;
}

export function loadSolPiConfig(
	cwd = process.cwd(),
	agentDir = getAgentDir(),
	allowProjectConfig = false,
): SolPiConfig {
	const path = findConfigPath(cwd, agentDir, allowProjectConfig);
	if (!path) return DEFAULT_CONFIG;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read SoL-Pi config ${path}: ${reason}`);
	}

	try {
		return parseSolPiConfig(parsed);
	} catch (error) {
		// Keep the runtime's path-aware diagnostics while the CLI uses the parser's messages.
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith("unknown key: ")) {
			throw new Error(`Unknown SoL-Pi config ${message.slice("unknown ".length)}`);
		}
		const prefix = message.startsWith("config ") ? "SoL-Pi" : "SoL-Pi config";
		throw new Error(`${prefix} ${message}: ${path}`);
	}
}
