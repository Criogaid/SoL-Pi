/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createObservationPackExtension } from "../src/sol-pi/extensions/observation-pack/index.ts";
import { THRESHOLD_BYTES } from "../src/sol-pi/extensions/observation-pack/observation.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";

const cleanup: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function observationPi(manager: FakeSessionManager): FakePi {
	const pi = new FakePi(manager) as FakePi & { getActiveTools: () => string[] };
	pi.getActiveTools = () => ["obs_recall"];
	createObservationPackExtension()(pi.asExtensionApi());
	return pi;
}

const message = {
	role: "toolResult" as const,
	toolCallId: "integration-observation",
	toolName: "bash",
	content: [{ type: "text" as const, text: "x".repeat(THRESHOLD_BYTES + 1) }],
	isError: false,
	timestamp: Date.now(),
};

describe("integrated ephemeral ObservationPack behavior", () => {
	it("preserves context and reports once when persistent storage is unavailable", async () => {
		const manager = new FakeSessionManager([], "ephemeral", "");
		const pi = observationPi(manager);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const context = fakeContext(manager);
		expect(await pi.emitContext([message], context)).toEqual([message]);
		expect(await pi.emitContext([message], context)).toEqual([message]);
		expect(error).toHaveBeenCalledTimes(1);
	});

	it("does not downgrade an unsafe session id to the ephemeral fallback", async () => {
		const directory = await mkdtemp(join(tmpdir(), "observation-integration-"));
		cleanup.push(directory);
		const manager = new FakeSessionManager([], "../unsafe", directory);
		const pi = observationPi(manager);
		await expect(pi.emitContext([message], fakeContext(manager))).rejects.toThrow("safe Pi session id");
	});
});
