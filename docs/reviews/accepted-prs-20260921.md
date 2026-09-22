# Accepted PR integration regression replay

Scope: pre-merge `7fcbd4b`, merged `958e7c0`, and the repaired working tree.
Machine-readable results: [accepted-prs-20260921-regressions.json](accepted-prs-20260921-regressions.json).

## Reproduce

From a source checkout with the locked dependencies installed:

```sh
npx vitest run tests/merge-regressions.test.ts
node scripts/compare-merge-regressions.mjs --out /absolute/path/report.json 7fcbd4b 958e7c0 working-tree
npm run check
```

The comparison requires Node.js, Git, tar, and the existing `node_modules`. It extracts committed snapshots into temporary directories, links the same installed dependencies, and copies the exact same regression test and helper into each snapshot. It leaves the current branch and working files in place and removes temporary snapshots afterward. Reports include revisions, test/helper hashes, the dependency lock hash, and the working-tree tracked patch hash. `MERGE_REPLAY_REPORT` is a test-only output path set by the runner.

Historical assertion failures are expected comparison results and remain visible in the report. Features absent from a revision are explicitly skipped. A failing working-tree test or an infrastructure failure makes the runner exit unsuccessfully.

## Method

The compaction fixture is a deterministic six-message conversation with a tool call, a 225,000-byte tool result, and a retained recent turn. Each test persists it with Pi's `SessionManager`, reopens the session file, and replays it through the registered context and boundary handlers. The plan call and its result are appended before `turn_end`. All versions use the same logical transcript hash. The tests count compaction triggers without making a summarization model call.

Reducer cases use identical log bodies and deterministic offline provider responses. Measurements count provider calls, serialized reducer request bytes, and accepted reductions. These are not actual billed tokens or dollars. Filesystem cases use synthetic files and a directory symlink or Windows junction. No personal sessions, credentials, or external model services are used.

## Results

| Case | Pre-merge | Merged | Repaired |
| --- | --- | --- | --- |
| Packed session compaction triggers | 0 | 1 | 0 |
| Raw session compaction triggers | 1 | 1 | 1 |
| Paged recall through redirected directory | Returns external bytes | Rejects | Rejects |
| Search through redirected directory | Unavailable | Returns external bytes | Rejects |
| Two attempts at a failure log with a 650-character line | 2 calls, 2 incomplete reductions | 2 calls, no reduction | No calls, original retained |
| Two attempts above total evidence capacity | 2 calls, 2 incomplete reductions | 2 calls, no reduction | No calls, original retained |
| Two attempts with complete 600-character-line evidence | 2 calls, 2 reductions | 1 call, 2 reductions | 1 call, 2 reductions |
| Two attempts with repeated short failure evidence | 2 calls, 2 reductions | 1 call, 2 reductions | 1 call, 2 reductions |
| Documented search comparison | Unavailable | Throws on missing session directory | Passes |
| Regression assertions | 2 passed, 5 failed, 2 skipped | 4 passed, 5 failed | 9 passed |

The packed replay contains about 23,768 visible tokens, versus 79,655 before projection. The merged estimator incorrectly priced raw tool output as removable provider context. The repair keeps Pi's raw-history cut but prices archived tool results from the observed provider projection, including omission of filtered results.

The reducer repair performs a necessary capacity check before archiving or calling the provider. It shares the validator's distinct nonblank line rule. A passing capacity check still requires normal receipt validation; it is not a guarantee that a provider can produce a valid receipt.

The search repair applies the existing directory and opened-object checks. A separate regression in `tests/observation-pack-directory-race.test.ts` replaces the directory while retaining the same file identity through a hard link, proving the post-open directory check remains necessary.

## Search measurement

The repaired script validates byte offsets and returned contexts against the source and an available literal shell search. On its 11,329-byte fixture:

| Operation | Tool calls | Returned bytes |
| --- | ---: | ---: |
| Page the complete observation | 3 | 11,771 |
| Search `needle` | 1 | 3,153 |
| Search `Needle` | 1 | 525 |
| Search `☾n` | 1 | 791 |
| Search `missing` | 1 | 150 |

Search still scans the full fixture in these cases. Its schema and description add 104 serialized bytes, and its placeholder adds 21 bytes relative to the script's paging-only baseline. Reduced returned traffic is workload-dependent; this synthetic result is not an end-to-end cost or task-quality benchmark.

## Validation

On Windows with Node.js 26.9.0:

- `npm run check`: typecheck, 324 passing tests, 4 skipped tests, and package inspection passed.
- The identical three-version replay: repaired working tree passed all 9 cases.
- Explicit all-mechanism, real AgentSession continuation, and directory-race checks: 12 passed.
- Pi public API compatibility check passed.
- npm audit against the official registry passed the high-severity threshold; two existing moderate Vitest-related findings remain.

Provider-error test fixtures use repeated short lines so they continue reaching the intended provider failure paths after the capacity preflight. The overlong-line validator case remains covered directly, and the shared replay verifies that impossible reductions make no provider call.
