/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@earendil-works/pi-ai";

/** Only tool results larger than this participate. */
export const THRESHOLD_BYTES = 10 * 1024;
/** Provider requests that still carry the full payload before the placeholder takes over. */
export const FULL_SENDS = 2;
/** Placeholder excerpt budget, split evenly between head and tail, whole lines only. */
export const PLACEHOLDER_EXCERPT_BYTES = 1024;

const CHARS_PER_TOKEN = 4;
const OBSERVATION_ID_PATTERN = /^obs_[a-f0-9]{24}$/u;
const HAS_ATOMIC_NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" && constants.O_NOFOLLOW !== 0;
const NO_FOLLOW_FLAG = HAS_ATOMIC_NO_FOLLOW ? constants.O_NOFOLLOW : 0;
const READ_OBJECT_FLAGS = constants.O_RDONLY | NO_FOLLOW_FLAG;
const CREATE_OBJECT_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW_FLAG;

async function verifyStorageDirectories(path: string, sessionDirectory: string, id: string, create = false): Promise<void> {
	const subpath = relative(sessionDirectory, dirname(path));
	if (!subpath || isAbsolute(subpath) || subpath.split(sep).includes("..")) {
		throw new Error(`Observation directory is outside the trusted session directory for ${id}`);
	}
	let directory = resolve(sessionDirectory);
	for (const component of subpath.split(sep)) {
		directory = join(directory, component);
		if (create) {
			try {
				await mkdir(directory, { mode: 0o700 });
			} catch (error) {
				if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
			}
		}
		const stats = await lstat(directory);
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			throw new Error(`Observation directory is not a regular directory for ${id}`);
		}
	}
}

async function verifyOpenedObject(handle: FileHandle, path: string, id: string, sessionDirectory: string): Promise<Stats> {
	await verifyStorageDirectories(path, sessionDirectory, id);
	const [pathStats, handleStats] = await Promise.all([
		lstat(path),
		handle.stat(),
	]);
	if (!pathStats.isFile() || pathStats.isSymbolicLink() || !handleStats.isFile()) {
		throw new Error(`Content-addressed observation is not a regular file for ${id}`);
	}
	if (pathStats.dev !== handleStats.dev || pathStats.ino !== handleStats.ino) {
		throw new Error(`Observation path changed while open for ${id}`);
	}
	return handleStats;
}
export const SEARCH_MAX_MATCHES = 20;
const SEARCH_READ_BYTES = 4096;
const SEARCH_CONTEXT_BYTES = 256;

/**
 * Receipts from the evidence-preserving reducer are already a reduction of a
 * long log. Packing them again would replace verified evidence with an excerpt.
 */
const EVIDENCE_REDUCER_RECEIPT_PREFIX = "sol_pi_evidence_receipt_v1";

export interface Observation {
	readonly id: string;
	readonly contentHash: string;
	readonly filePath: string;
	readonly toolName: string;
	readonly text: string;
	readonly bytes: number;
	readonly lines: number;
	readonly tokens: number;
}

export function hash(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function countLines(text: string): number {
	if (text.length === 0) return 0;
	let lines = text.endsWith("\n") ? 0 : 1;
	// Indexed, not `for..of`: this walks whole payloads on every projection, and
	// the code-point iterator costs several times more for the same answer.
	for (let index = 0; index < text.length; index += 1) {
		if (text.charCodeAt(index) === 10) lines += 1;
	}
	return lines;
}

function countBufferLines(buffer: Buffer): number {
	if (buffer.length === 0) return 0;
	let lines = buffer[buffer.length - 1] === 0x0a ? 0 : 1;
	for (const byte of buffer) {
		if (byte === 0x0a) lines += 1;
	}
	return lines;
}

export function isPureTextResult(message: AgentMessage): message is ToolResultMessage {
	return (
		message.role === "toolResult" &&
		!message.isError &&
		message.content.length > 0 &&
		message.content.every((block) => block.type === "text")
	);
}

function textFromResult(message: ToolResultMessage): string {
	return (message.content as TextContent[]).map((block) => block.text).join("\n");
}

/** True when a whole line equals the receipt prefix, without splitting the payload. */
function containsReducerReceipt(text: string): boolean {
	for (let index = text.indexOf(EVIDENCE_REDUCER_RECEIPT_PREFIX); index >= 0; ) {
		const end = index + EVIDENCE_REDUCER_RECEIPT_PREFIX.length;
		const startsLine = index === 0 || text.charCodeAt(index - 1) === 10;
		const endsLine = end === text.length || text.charCodeAt(end) === 10;
		if (startsLine && endsLine) return true;
		index = text.indexOf(EVIDENCE_REDUCER_RECEIPT_PREFIX, index + 1);
	}
	return false;
}

/**
 * Archived payloads live under SoL-Pi's session-derived runtime root.
 *
 * They are content addressed inside one session. A resume reuses the same
 * directory; a fork rebuilds its own object from the unmodified session history.
 */
export function observationPath(runtimeRoot: string, id: string): string {
	return join(runtimeRoot, "observation-pack", "objects", `${id}.txt`);
}

export function isObservationId(id: string): boolean {
	return OBSERVATION_ID_PATTERN.test(id);
}

export function createObservation(message: ToolResultMessage, runtimeRoot: string): Observation | undefined {
	const text = textFromResult(message);
	if (containsReducerReceipt(text)) return undefined;
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= THRESHOLD_BYTES) return undefined;
	if (!runtimeRoot) throw new Error("Persistent SoL-Pi runtime directory is unavailable");

	const contentHash = hash(text);
	const id = `obs_${hash(`${message.toolName}\0${message.toolCallId}\0${contentHash}`).slice(0, 24)}`;
	return {
		id,
		contentHash,
		filePath: observationPath(runtimeRoot, id),
		toolName: message.toolName,
		text,
		bytes,
		lines: countLines(text),
		tokens: estimateTokens(text),
	};
}

/**
 * Write the payload to its content-addressed path, refusing symlinks and
 * verifying an existing object byte for byte before reusing it.
 */
export async function ensureStored(observation: Observation, sessionDirectory: string): Promise<void> {
	await verifyStorageDirectories(observation.filePath, sessionDirectory, observation.id, true);

	let handle: FileHandle | undefined;
	try {
		handle = await open(observation.filePath, CREATE_OBJECT_FLAGS, 0o600);
		await verifyOpenedObject(handle, observation.filePath, observation.id, sessionDirectory);
		await handle.writeFile(observation.text, { encoding: "utf8" });
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
		const existingHandle = await open(observation.filePath, READ_OBJECT_FLAGS);
		try {
			const existing = await verifyOpenedObject(existingHandle, observation.filePath, observation.id, sessionDirectory);
			if (existing.size !== observation.bytes) {
				throw new Error(`Content-addressed observation size mismatch for ${observation.id}`);
			}
			const existingContent = await existingHandle.readFile();
			if (hash(existingContent) !== observation.contentHash) {
				throw new Error(`Content-addressed observation hash mismatch for ${observation.id}`);
			}
		} finally {
			await existingHandle.close();
		}
	} finally {
		await handle?.close();
	}
}

/**
 * Whole lines from one end of the payload, within a byte budget.
 *
 * Walks line breaks from the chosen end instead of splitting the payload:
 * splitting allocates one string per line of a multi-megabyte observation on
 * every projection, to keep at most a few hundred bytes of it.
 */
function completeLineExcerpt(text: string, budgetBytes: number, fromEnd: boolean): string {
	let selectedBytes = 0;

	if (fromEnd) {
		let start = text.length;
		while (start > 0) {
			const previousBreak = start >= 2 ? text.lastIndexOf("\n", start - 2) : -1;
			const lineStart = previousBreak + 1;
			const lineBytes = Buffer.byteLength(text.slice(lineStart, start), "utf8");
			if (selectedBytes + lineBytes > budgetBytes) break;
			selectedBytes += lineBytes;
			start = lineStart;
		}
		return text.slice(start);
	}

	let end = 0;
	while (end < text.length) {
		const nextBreak = text.indexOf("\n", end);
		const lineEnd = nextBreak < 0 ? text.length : nextBreak + 1;
		const lineBytes = Buffer.byteLength(text.slice(end, lineEnd), "utf8");
		if (selectedBytes + lineBytes > budgetBytes) break;
		selectedBytes += lineBytes;
		end = lineEnd;
	}
	return text.slice(0, end);
}

/**
 * Take whole code points up to a byte budget, from either end.
 *
 * Used when the payload has no line short enough to excerpt: one long line of
 * minified JSON, a `jq -c` result, a `curl` body. Cutting on a UTF-8 boundary
 * keeps the excerpt from ending in a replacement character.
 */
function byteBoundedExcerpt(text: string, budgetBytes: number, fromEnd: boolean): string {
	// One code point is at least one byte, so this window is a superset of the
	// characters that can fit the budget.
	const characters = [...(fromEnd ? text.slice(-budgetBytes) : text.slice(0, budgetBytes))];
	const selected: string[] = [];
	let selectedBytes = 0;

	for (let index = 0; index < characters.length; index += 1) {
		const character = characters[fromEnd ? characters.length - 1 - index : index];
		if (character === undefined) break;
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (selectedBytes + characterBytes > budgetBytes) break;
		if (fromEnd) selected.unshift(character);
		else selected.push(character);
		selectedBytes += characterBytes;
	}

	return selected.join("");
}

interface PlaceholderExcerpt {
	readonly text: string;
	readonly wholeLines: boolean;
}

function placeholderExcerpt(text: string, budgetBytes: number, fromEnd: boolean): PlaceholderExcerpt {
	const lines = completeLineExcerpt(text, budgetBytes, fromEnd);
	if (lines.length > 0) return { text: lines, wholeLines: true };
	return { text: byteBoundedExcerpt(text, budgetBytes, fromEnd), wholeLines: false };
}

export function placeholderFor(observation: Observation): string {
	const headBudget = Math.floor(PLACEHOLDER_EXCERPT_BYTES / 2);
	const tailBudget = PLACEHOLDER_EXCERPT_BYTES - headBudget;
	const head = placeholderExcerpt(observation.text, headBudget, false);
	const tail = placeholderExcerpt(observation.text, tailBudget, true);
	return [
		`[large tool result replaced after its first ${FULL_SENDS} provider requests]`,
		`id: ${observation.id}`,
		`tool: ${observation.toolName}`,
		`original_bytes: ${observation.bytes}`,
		`original_lines: ${observation.lines}`,
		`estimated_tokens: ${observation.tokens}`,
		`retrieve: call obs_recall with {"id":"${observation.id}","offset":0}; add query for literal search; continue with next_offset`,
		head.wholeLines
			? `[first complete lines, up to ${headBudget} bytes]`
			: `[no complete line fits; first ${headBudget} bytes]`,
		head.text,
		tail.wholeLines
			? `[middle omitted; last complete lines, up to ${tailBudget} bytes]`
			: `[middle omitted; no complete line fits; last ${tailBudget} bytes]`,
		tail.text,
		`[${observation.bytes} original bytes omitted]`,
	].join("\n");
}

export interface RecallChunk {
	readonly text: string;
	readonly bytes: number;
	readonly lines: number;
	/** Byte offset the returned text actually starts at, aligned to a character. */
	readonly offset: number;
	readonly nextOffset: number;
	readonly eof: boolean;
}

export interface SearchMatch {
	readonly byteOffset: number;
	readonly byteEnd: number;
	readonly line: number;
	readonly contextStart: number;
	readonly contextEnd: number;
	readonly context: string;
}

export interface SearchResult {
	readonly matches: readonly SearchMatch[];
	readonly nextOffset: number;
	readonly eof: boolean;
	readonly scannedBytes: number;
}

function trimUtf8End(buffer: Buffer, limit: number): number {
	let end = limit;
	while (end > 0 && end < buffer.length && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
	return end;
}

function trimUtf8Start(buffer: Buffer, start: number): number {
	let result = start;
	while (result < buffer.length && ((buffer[result] ?? 0) & 0xc0) === 0x80) result += 1;
	return result;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Observation search aborted");
}

async function readSnapshot(
	handle: FileHandle,
	buffer: Buffer,
	position: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	let total = 0;
	while (total < buffer.length) {
		throwIfAborted(signal);
		const { bytesRead } = await handle.read(buffer, total, buffer.length - total, position + total);
		if (bytesRead === 0) throw new Error("Stored observation shrank during search");
		total += bytesRead;
	}
}

async function countPrefixLines(
	handle: FileHandle,
	offset: number,
	signal: AbortSignal | undefined,
): Promise<{ lines: number; bytes: number }> {
	let position = 0;
	let lines = 1;
	while (position < offset) {
		const length = Math.min(SEARCH_READ_BYTES, offset - position);
		const buffer = Buffer.alloc(length);
		await readSnapshot(handle, buffer, position, signal);
		for (const byte of buffer) if (byte === 0x0a) lines += 1;
		position += length;
	}
	return { lines, bytes: position };
}

async function contextFor(
	handle: FileHandle,
	size: number,
	byteOffset: number,
	byteEnd: number,
	signal: AbortSignal | undefined,
): Promise<Omit<SearchMatch, "byteOffset" | "byteEnd" | "line">> {
	const windowStart = Math.max(0, byteOffset - SEARCH_CONTEXT_BYTES);
	const windowEnd = Math.min(size, byteEnd + SEARCH_CONTEXT_BYTES);
	// Read enough lookahead to tell whether the fixed window ends in a UTF-8
	// continuation byte. The returned range remains bounded by windowEnd.
	const buffer = Buffer.alloc(Math.min(size, windowEnd + 3) - windowStart);
	await readSnapshot(handle, buffer, windowStart, signal);
	const start = trimUtf8Start(buffer, 0);
	const end = trimUtf8End(buffer, windowEnd - windowStart);
	return {
		contextStart: windowStart + start,
		contextEnd: windowStart + end,
		context: buffer.subarray(start, end).toString("utf8"),
	};
}

/**
 * Search an archived observation as literal UTF-8 bytes. Search offsets are
 * inclusive match starts. Line numbers require a bounded prefix rescan because
 * archives intentionally carry no line index.
 */
export async function searchObservation(
	path: string,
	query: Buffer,
	offset: number,
	maxResultBytes: number,
	signal: AbortSignal | undefined,
): Promise<SearchResult> {
	const handle = await open(path, READ_OBJECT_FLAGS);
	try {
		const fileStats = await handle.stat();
		if (!fileStats.isFile()) throw new Error("Stored observation is not a regular file");
		if (offset > fileStats.size) throw new Error(`Offset ${offset} exceeds observation size ${fileStats.size}`);
		const prefix = await countPrefixLines(handle, offset, signal);
		let position = offset;
		let line = prefix.lines;
		let carry = Buffer.alloc(0);
		let scannedBytes = prefix.bytes;
		const matches: SearchMatch[] = [];
		while (position < fileStats.size) {
			throwIfAborted(signal);
			const length = Math.min(SEARCH_READ_BYTES, fileStats.size - position);
			const chunk = Buffer.alloc(length);
			await readSnapshot(handle, chunk, position, signal);
			scannedBytes += length;
			const combined = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
			const base = position - carry.length;
			let combinedBaseLine = line;
			for (const byte of carry) if (byte === 0x0a) combinedBaseLine -= 1;
			let index = 0;
			for (;;) {
				throwIfAborted(signal);
				const found = combined.indexOf(query, index);
				if (found < 0) break;
				const byteOffset = base + found;
				if (byteOffset >= offset && byteOffset + query.length <= position + length) {
					const beforeMatch = combined.subarray(0, found);
					let matchLine = combinedBaseLine;
					for (const byte of beforeMatch) if (byte === 0x0a) matchLine += 1;
					const byteEnd = byteOffset + query.length;
					const context = await contextFor(handle, fileStats.size, byteOffset, byteEnd, signal);
					const match = { byteOffset, byteEnd, line: matchLine, ...context };
					const serialized = Buffer.byteLength(JSON.stringify(match), "utf8") + 1;
					const used = matches.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry), "utf8") + 1, 0);
					if (matches.length >= SEARCH_MAX_MATCHES || used + serialized > maxResultBytes) {
						return { matches, nextOffset: byteOffset, eof: false, scannedBytes };
					}
					matches.push(match);
					if (matches.length >= SEARCH_MAX_MATCHES) {
						return { matches, nextOffset: byteOffset + 1, eof: false, scannedBytes };
					}
				}
				index = found + 1;
			}
			for (const byte of chunk) if (byte === 0x0a) line += 1;
			carry = combined.subarray(Math.max(0, combined.length - (query.length - 1)));
			position += length;
		}
		return { matches, nextOffset: fileStats.size, eof: true, scannedBytes };
	} finally {
		await handle.close();
	}
}

export async function readRecallChunk(
	path: string,
	offset: number,
	limits: { readonly maxBytes: number; readonly maxLines: number },
	sessionDirectory: string,
): Promise<RecallChunk> {
	await verifyStorageDirectories(path, sessionDirectory, "recall");
	const handle = await open(path, READ_OBJECT_FLAGS);
	try {
		const fileStats = await verifyOpenedObject(handle, path, "recall", sessionDirectory);
		if (offset > fileStats.size) throw new Error(`Offset ${offset} exceeds observation size ${fileStats.size}`);

		const available = Math.max(0, fileStats.size - offset);
		const buffer = Buffer.alloc(Math.min(available, limits.maxBytes + 4));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);

		// A caller-chosen offset can land inside a multi-byte character. Start at
		// the next character rather than decoding a partial one into U+FFFD.
		let start = 0;
		while (start < bytesRead && ((buffer[start] ?? 0) & 0xc0) === 0x80) start += 1;

		let end = Math.min(bytesRead, start + limits.maxBytes);
		let newlineCount = 0;

		for (let index = start; index < end; index += 1) {
			if (buffer[index] !== 0x0a) continue;
			newlineCount += 1;
			if (newlineCount === limits.maxLines) {
				end = index + 1;
				break;
			}
		}

		end = Math.max(start, trimUtf8End(buffer, end));
		const chunk = buffer.subarray(start, end);
		const nextOffset = offset + end;
		return {
			text: chunk.toString("utf8"),
			bytes: chunk.length,
			lines: countBufferLines(chunk),
			offset: offset + start,
			nextOffset,
			eof: nextOffset >= fileStats.size,
		};
	} finally {
		await handle.close();
	}
}
