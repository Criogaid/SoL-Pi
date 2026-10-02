/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/check-pi-dependencies.mjs", import.meta.url));
const piPath = "node_modules/@earendil-works/pi-coding-agent";
const expectedVersion = "5.0.12";
const directories: string[] = [];

function writeJson(root: string, path: string, value: unknown): void {
	const target = join(root, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, JSON.stringify(value));
}

function fixture(hasShrinkwrap = false): string {
	const root = mkdtempSync(join(tmpdir(), "sol-pi-dependencies-"));
	directories.push(root);
	writeJson(root, "package.json", { overrides: { "brace-expansion": expectedVersion } });
	writeJson(root, "package-lock.json", { packages: { [piPath]: { hasShrinkwrap } } });
	writeJson(root, `${piPath}/package.json`, { name: "@earendil-works/pi-coding-agent" });
	writeJson(root, `${piPath}/node_modules/minimatch/package.json`, { name: "minimatch" });
	writeJson(root, "node_modules/brace-expansion/package.json", { version: expectedVersion });
	return root;
}

function run(root: string) {
	return spawnSync(process.execPath, [script], {
		cwd: root,
		encoding: "utf8",
		timeout: 10_000,
		maxBuffer: 64 * 1024,
	});
}

afterEach(() => {
	for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Pi dependency installation check", () => {
	it("accepts the root override resolved through Pi's minimatch dependency", () => {
		const result = run(fixture());
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
	});

	it("rejects a vulnerable nested package even when the root package is patched", () => {
		const root = fixture();
		writeJson(root, `${piPath}/node_modules/brace-expansion/package.json`, { version: "5.0.9" });
		const result = run(root);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("brace-expansion");
		expect(result.stderr).toContain("5.0.9");
	});

	it("rejects a lockfile that lets the published shrinkwrap bypass the root override", () => {
		const result = run(fixture(true));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("hasShrinkwrap");
	});
});
