/* Receipt acceptance must not hide a distinct, recognizable failure line. */
import { describe, expect, it } from "vitest";
import { MAX_QUOTE_CHARS, REDUCER_RECEIPT_SCHEMA, sha256 } from "../src/sol-pi/extensions/evidence-preserving-reducer/config.ts";
import { validateReceipt } from "../src/sol-pi/extensions/evidence-preserving-reducer/receipt.ts";

function validate(body: string, quotes: string[], isError = true, uncertain = false) {
	const archive = { hash: sha256(body), path: "synthetic.log", bytes: Buffer.byteLength(body), chars: body.length, lines: body.split("\n").length };
	return validateReceipt(JSON.stringify({
		schema: REDUCER_RECEIPT_SCHEMA, source_sha256: archive.hash, status: isError ? "failure" : "success", uncertain,
		evidence: quotes.map((quote) => ({ kind: "failure", quote })),
	}), archive, body, isError);
}

describe("failure evidence coverage", () => {
	it("rejects an exact quote that covers only the first independent failure", () => {
		expect(validate("Error: alpha\nError: beta\n", ["Error: alpha"])).toEqual({ ok: false, reason: "incomplete-failure-evidence" });
	});
	it("accepts complete multiline evidence and repeated copies of the same signature", () => {
		expect(validate("Error: alpha\r\nError: beta\r\nError: alpha\r\n", ["Error: alpha\r\nError: beta"]).ok).toBe(true);
	});
	it("rejects a shared prefix that hides distinct failure details", () => {
		expect(validate("Error: alpha at A.ts:1\nError: alpha at B.ts:9", ["Error: alpha"])).toMatchObject({ ok: false });
	});
	it("fails open when a failure line exceeds the quotation budget", () => {
		const line = `Error: ${"x".repeat(MAX_QUOTE_CHARS)}`;
		expect(validate(line, [line.slice(0, MAX_QUOTE_CHARS)])).toMatchObject({ ok: false });
	});
	it("preserves failure signals even when a wrapper exits successfully", () => {
		expect(validate("Error: alpha\nError: beta", ["Error: alpha"], false)).toMatchObject({ ok: false });
	});
	it("fails open for uncertain or unrecognized failing output", () => {
		expect(validate("Error: alpha", ["Error: alpha"], true, true)).toMatchObject({ ok: false });
		expect(validate("worker stopped unexpectedly", ["worker stopped unexpectedly"])).toMatchObject({ ok: false });
	});
});
