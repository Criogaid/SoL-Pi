/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

// Run from the source checkout after npm ci. Resolve from the consumer so a
// patched hoisted copy cannot hide a vulnerable dependency nested under Pi.
const piPath = "node_modules/@earendil-works/pi-coding-agent";
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

try {
	const manifest = readJson("package.json");
	const expectedVersion = manifest.overrides?.["brace-expansion"];
	if (typeof expectedVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
		throw new Error("package.json overrides.brace-expansion must specify an exact version");
	}

	const lock = readJson("package-lock.json");
	const pi = lock.packages?.[piPath];
	if (!pi) throw new Error(`package-lock.json must contain ${piPath}`);
	if (pi.hasShrinkwrap) {
		throw new Error("package-lock.json Pi hasShrinkwrap bypasses the root override; remove the marker and reinstall with npm ci --ignore-scripts");
	}

	const piRequire = createRequire(resolve(piPath, "package.json"));
	const minimatchRequire = createRequire(piRequire.resolve("minimatch/package.json"));
	const installedPath = minimatchRequire.resolve("brace-expansion/package.json");
	const installed = readJson(installedPath);
	if (installed.version !== expectedVersion) {
		throw new Error(`Pi resolves brace-expansion ${installed.version} at ${installedPath}; expected override ${expectedVersion}. Reinstall with npm ci --ignore-scripts and recheck the lockfile`);
	}
	console.log(`Pi dependency check passed: brace-expansion ${installed.version}`);
} catch (error) {
	console.error(`Pi dependency check failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
