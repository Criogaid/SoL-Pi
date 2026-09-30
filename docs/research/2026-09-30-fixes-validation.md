# Four reliability fixes and real-provider verification

The four requested fixes are implemented on `research/efficiency-20260929`. They have not been merged into `main` or installed into the user's active Pi environment. This report extends the [initial investigation](2026-09-29-efficiency-review.md).

## Delivered behavior

| Concern | Implementation | Commit |
|---|---|---|
| Repeated compaction after plan reconstruction | Only an observed incomplete-to-completed transition for the same step id and goal creates a boundary. Imported completed plans establish a baseline. | `2747327` |
| OCC accounting | Pi chooses the cut point. Savings use the latest tool-result projection; summary input separately uses Pi's raw-history serializer. Cache rebuilding uses retained context plus the memo. Summary estimates and outstanding debt enter the same economic calculation. Successful boundary compactions reconcile memo size and reported positive summary cost. | `3b38b24` |
| ObservationPack branch exposure | Successful assistant responses on the active lineage determine exposure. Failed or aborted responses do not consume it. Forks, returned branches, compaction, and resume derive state from that lineage. The independent mutable send counter is removed. | `8e908c1` |
| EPR failure coverage | Every distinct line recognized by `FAILURE_SIGNAL` must survive in an exact quote. Missing coverage, an oversized failure line, or uncertain/unrecognized failing output leaves the original tool result intact. | `9af4045` |

The changes retain the existing owners: Pi integration in `extension.ts`, pure policy in `economics.ts`, debt transitions in `state.ts`, observation projection in ObservationPack, and receipt validation in `receipt.ts`. No upstream Pi source, production credentials, global installation, or effective user configuration was changed.

OCC's prices and token sizes are estimates, not a billing ledger. Missing summary prices defer economic compaction while retaining window protection. The configured cache ratio is fixed; use a new session when changing the model/pricing policy. Hosts missing Pi's public cut-point or message conversion helpers skip optional boundary compaction and keep their native policy. This compatibility behavior is deliberate; there is no local imitation of the host's cut-point algorithm.

ObservationPack's threshold remains `FULL_SENDS`; its meaning is now successful responses on the current branch. Retries may therefore send an observation in full more times than before. EPR coverage is limited to recognizable failure lines and the reducer's uncertainty signal; arbitrary diagnostic formats are not semantically proven complete. Conservative fallback may reduce compression frequency.

The aggregate execution record is [2026-09-30-live-verification.json](2026-09-30-live-verification.json). It includes the invalid initial harness attempt as well as both accepted runs.

## Regression evidence

- OCC economics/state: four new cases failed before implementation and passed afterward. They cover retained-context rebuilding, summary cost, unavailable prices, and accumulated debt/repayment.
- OCC integration: giant retained turns and already masked observations do not fabricate removable context. Existing real `AgentSession` tests continue to cover cancellation, failures, settlement, repeated imported plans, renamed ids, and genuine later progress. Their provider responses are simulated.
- ObservationPack: a regression using a real Pi `SessionManager` first reproduced branch B receiving a placeholder after branch A consumed the shared observation. It now passes fork, return, failed/aborted retry, compaction, and resume checks.
- EPR: five new checks failed before implementation and passed afterward. Coverage includes two independent failures, shared prefixes with different locations, CRLF, repeated signatures, quote-budget overflow, successful wrapper exits, and uncertain output. A tool-result integration check verifies that rejecting a partial receipt leaves the original event unchanged.

An existing OCC lifecycle fixture previously supplied a large reported context count with very little actually removable history. The corrected estimator properly refused that fixture. Its archived user message was enlarged to make compaction feasible, and separate regression cases now assert refusal when the real cut removes too little.

## Real Pi agent execution

`scripts/verify-live-agent.mjs` uses Pi 0.85.1's public SDK, an actual `AgentSession`, actual tool execution, and real calls to `openai/gpt-6-astra`. The main agent runs at `medium` reasoning. EPR uses the same provider/model and its production request options. Native summaries use Pi's own implementation; the harness supplies no replacement summary or simulated provider.

Each scenario loads all four mechanisms from one temporary `sol-pi.json`. Authentication is resolved through the existing Pi model runtime. Tools are restricted to synthetic fixture files and the fixed `npm test` command. Raw conversations, model errors, tool arguments, and credential content are not exported. Temporary projects, archives, and session logs are removed after each run; only bounded aggregate reports remain.

The real branch scenario passed all three checks: branch A's third request used a placeholder, branch B's first request received full source, and returning to A used a placeholder. It made six main-model requests with no extension errors or blocked tools.

The repair scenario used two deliberately incorrect arithmetic functions and a noisy diagnostic command. The real agent ran the failing command, received a receipt containing both error lines, changed the source with Action Fusion, reran the test, completed its plan step, passed through a real native summary call, and finished the automatic continuation. Independent arithmetic checks passed. The first complete run made eight main-model requests, one native compaction, and two EPR model calls; no EPR fallback occurred.

A second repair run added explicit checks for plan replay and cancellation classification. The real model submitted the completed repair plan **three times**; Pi compacted **once**, completed the automatic continuation, and had **zero unexpected assistant failures**. One empty cancelled response is the intentional boundary interruption. Both source defects were corrected again and both error lines survived the real EPR receipt.

| Accepted scenario | Main requests | Main reported tokens | Native summary usage entries / tokens | EPR calls / tokens |
|---|---:|---:|---:|---:|
| Branch navigation | 6 | 40,239 | 0 / 0 | 0 / 0 |
| First repair run | 8 | 213,489 | 1 / 17,145 | 2 / 12,470 |
| Repair with explicit replay counter | 8 | 213,490 | 1 / 17,155 | 2 / 12,470 |

Summary usage is counted once per compaction entry; Pi may aggregate more than one internal summary request there. The repeated fixture can reuse provider caches and is not an independent performance sample. EPR's production request options do not inherit the main agent's explicit reasoning setting.

To exercise window protection with bounded input, the repair scenario advertises a smaller context window (`PRESSURE_WINDOW_TOKENS`) and seeds explicitly synthetic resolved history. Automatic threshold compaction is disabled so the observed compaction must come from the completed-plan boundary. This is a behavior test under intentional window pressure, not evidence that the economic gate chose an optimal production action.

The first harness attempt called the real model but omitted the SDK's `bindExtensions()` initialization. Its acceptance checks failed; its six main-model calls are excluded from plugin-validation evidence. The corrected harness initializes extensions and verifies active tools before sending a prompt. This failed attempt is retained in the aggregate report and counts toward experiment usage.

## Source checks and remaining limit

`npm run check` passed: TypeScript, 24 test files with **239 passed / 3 skipped**, and package dry-run. The skipped cases are existing Windows/POSIX path or symlink conditions. `node scripts/check-pi-compat.mjs` and the offline policy probe exited zero. No formatter task or configuration is present; `git diff --check` is the whitespace check.

The current `npm audit --audit-level=high --registry=https://registry.npmjs.org` check **failed** with 3 moderate and 1 high finding. The high finding is in Pi 0.85.1's transitive `undici`; npm proposes upgrading Pi outside the declared/tested range. No forced dependency update was applied. Consequently the managed installation protocol's dependency gate is not satisfied. This work does not claim installation readiness or compatibility with the active interactive host's newer Pi release.

## Reproduce

From this worktree, run the provider/auth presence check without a model request:

```bash
node scripts/verify-live-agent.mjs --provider openai --model gpt-6-astra
```

The following command makes real model calls and writes to a new output path:

```bash
node scripts/verify-live-agent.mjs --run --provider openai --model gpt-6-astra --out .pi/live-verification-new.json
```

Use `--start` instead of `--run` for a detached run, then inspect the report. `--scenario observation-branches` or `--scenario repair-and-compaction` selects a scenario. `RUN_TIMEOUT_MS` and `REQUEST_LIMIT` bound the harness. Output paths are claimed exclusively; an existing report is not overwritten. Runtime dependencies remain unchanged, and the research harness is excluded from the npm package.

These development fixtures demonstrate the specified behavior. They do not establish population-level task quality, cost reduction, cache savings, or a pass rate on unseen tasks. The original held-out evaluation and full-cost-accounting recommendations remain applicable to any subsequent performance study.
