/* Observation exposure follows successful responses on the real Pi session lineage. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import { createObservationPackExtension, THRESHOLD_BYTES } from "../src/sol-pi/extensions/observation-pack/index.ts";
import { FakePi, fakeContext } from "./helpers.ts";

it("isolates forks, preserves returned and compacted branches, and ignores failed attempts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "sol-pi-observation-branches-"));
	try {
		const manager = SessionManager.create(directory, directory);
		const pi = new FakePi();
		createObservationPackExtension()(pi.asExtensionApi());
		const context = fakeContext(directory, { sessionManager: manager });
		const body = "source row\n".repeat(THRESHOLD_BYTES);
		manager.appendMessage({ role: "user", content: "read source", timestamp: 0 });
		const call = manager.appendMessage(fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" }, { id: "shared" }), { stopReason: "toolUse" }));
		const fork = manager.appendMessage({ role: "toolResult", toolCallId: "shared", toolName: "read", content: [{ type: "text", text: body }], isError: false, timestamp: 0 });
		const full = async (): Promise<boolean> => {
			const projected = await pi.emitContext(buildSessionContext(manager.getBranch()).messages, context);
			return projected.some((message) => message.role === "toolResult" && message.content.some((part) => part.type === "text" && part.text === body));
		};
		expect(await full()).toBe(true);
		manager.appendMessage(fauxAssistantMessage("first response"));
		expect(await full()).toBe(true);
		const branchA = manager.appendMessage(fauxAssistantMessage("second response"));
		expect(await full()).toBe(false);
		manager.branch(fork);
		manager.appendMessage({ role: "user", content: "branch B", timestamp: 1 });
		expect(await full()).toBe(true);
		manager.appendMessage(fauxAssistantMessage("", { stopReason: "error" }));
		manager.appendMessage(fauxAssistantMessage("", { stopReason: "aborted" }));
		for (let retry = 0; retry < 3; retry++) expect(await full()).toBe(true);
		manager.branch(branchA);
		expect(await full()).toBe(false);
		manager.appendCompaction("summary", call, 30_000);
		expect(await full()).toBe(false);
		const resumed = new FakePi();
		createObservationPackExtension()(resumed.asExtensionApi());
		const restored = await resumed.emitContext(buildSessionContext(manager.getBranch()).messages, context);
		expect(restored.some((message) => message.role === "toolResult" && message.content.some((part) => part.type === "text" && part.text === body))).toBe(false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
