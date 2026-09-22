/*
 * SPDX-License-Identifier: MIT
 */
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readRecallChunk } from "../src/sol-pi/extensions/observation-pack/observation.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	return { ...fs, lstat: vi.fn(fs.lstat) };
});

let root: string | undefined;
afterEach(async () => {
	vi.restoreAllMocks();
	vi.mocked(lstat).mockClear();
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

async function observationFile() {
	root = await mkdtemp(join(tmpdir(), "sol-pi-file-guard-"));
	await mkdir(join(root, "objects"));
	const path = join(root, "objects", "observation.txt");
	await writeFile(path, "original evidence\n");
	return path;
}

it("rejects a link before opening it even without native O_NOFOLLOW", async () => {
	const path = await observationFile();
	const stats = await lstat(path, { bigint: true });
	vi.spyOn(stats, "isSymbolicLink").mockReturnValue(true);
	vi.mocked(lstat).mockResolvedValueOnce(await lstat(join(root!, "objects"))).mockResolvedValueOnce(stats);
	await expect(readRecallChunk(path, 0, { maxBytes: 100, maxLines: 10 }, root!)).rejects.toMatchObject({ code: "ELOOP" });
});

it("rejects a file replaced between the path check and open", async () => {
	const path = await observationFile();
	const stats = await lstat(path, { bigint: true });
	stats.ino += 1n;
	vi.mocked(lstat).mockResolvedValueOnce(await lstat(join(root!, "objects"))).mockResolvedValueOnce(stats);
	await expect(readRecallChunk(path, 0, { maxBytes: 100, maxLines: 10 }, root!)).rejects.toThrow("changed while opening");
});
