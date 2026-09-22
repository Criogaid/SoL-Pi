/* SPDX-License-Identifier: MIT */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({ options: { out: { type: "string" } }, allowPositionals: true });
if (!values.out) throw new Error("Usage: node scripts/compare-merge-regressions.mjs --out report.json [git-ref ... working-tree]");
const repository = process.cwd();
const references = positionals.length ? positionals : ["7fcbd4b", "958e7c0", "working-tree"];
const testPath = "tests/merge-regressions.test.ts";
const hash = (text) => createHash("sha256").update(text).digest("hex");
function run(command, args, cwd = repository, env = process.env) {
	const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 45_000, maxBuffer: 4 * 1024 * 1024 });
	if (result.error) throw result.error;
	return result;
}
function checked(command, args, cwd) {
	const result = run(command, args, cwd);
	if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr || result.stdout}`);
	return result.stdout.trim();
}
const temporary = await mkdtemp(join(tmpdir(), "sol-pi-version-replay-"));
const report = {
	node: process.version,
	platform: process.platform,
	testSha256: hash(await readFile(testPath)),
	helperSha256: hash(await readFile("tests/helpers.ts")),
	dependencyLockSha256: hash(await readFile("package-lock.json")),
	method: "Identical tests and installed dependencies; persisted synthetic session replay; offline reducer responses. Historical failures are recorded, unavailable features are skipped. No billing or task-quality claims.",
	versions: [],
};
try {
	for (const [index, reference] of references.entries()) {
		const working = reference === "working-tree";
		const commit = checked("git", ["rev-parse", "--verify", `${working ? "HEAD" : reference}^{commit}`]);
		let cwd = repository;
		if (!working) {
			cwd = join(temporary, `snapshot-${index}`);
			await mkdir(cwd);
			const archive = join(temporary, `snapshot-${index}.tar`);
			checked("git", ["archive", "--format=tar", `--output=${archive}`, commit]);
			checked("tar", ["-xf", `snapshot-${index}.tar`, "-C", `snapshot-${index}`], temporary);
			await symlink(join(repository, "node_modules"), join(cwd, "node_modules"), process.platform === "win32" ? "junction" : "dir");
			await copyFile(join(repository, testPath), join(cwd, testPath));
			await copyFile(join(repository, "tests/helpers.ts"), join(cwd, "tests/helpers.ts"));
		}
		const metricsPath = join(temporary, `metrics-${index}.json`);
		const testsPath = join(temporary, `tests-${index}.json`);
		const result = run(process.execPath, [join(repository, "node_modules/vitest/vitest.mjs"), "run", testPath,
			"--reporter=json", `--outputFile=${testsPath}`], cwd, { ...process.env, MERGE_REPLAY_REPORT: metricsPath });
		// A test failure is comparison evidence; a missing report or suite load failure is an infrastructure error.
		const tests = JSON.parse(await readFile(testsPath, "utf8"));
		const measurements = JSON.parse(await readFile(metricsPath, "utf8"));
		const assertions = tests.testResults.flatMap((suite) => suite.assertionResults);
		if (assertions.length === 0 || ![0, 1].includes(result.status)) throw new Error(`Replay did not execute for ${reference}: ${result.stderr}`);
		const version = {
			reference, commit,
			...(working ? { patchSha256: hash(checked("git", ["diff", "HEAD", "--", "src", "scripts", "tests", "package.json"])) } : {}),
			exitCode: result.status,
			passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests,
			tests: assertions.map(({ title, status, failureMessages }) => ({ title, status,
				...(failureMessages.length ? { failure: failureMessages[0].split("\n")[0] } : {}) })),
			measurements,
		};
		report.versions.push(version);
		console.log(JSON.stringify({ reference, commit, passed: version.passed, failed: version.failed, skipped: version.skipped }));
	}
	const output = resolve(values.out);
	await mkdir(dirname(output), { recursive: true });
	await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
	console.log(`Comparison report: ${output}`);
	if (report.versions.some((version) => version.reference === "working-tree" && version.failed > 0)) process.exitCode = 1;
} finally {
	await rm(temporary, { recursive: true, force: true });
}
