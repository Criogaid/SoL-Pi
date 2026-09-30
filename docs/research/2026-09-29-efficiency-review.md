# SoL-Pi efficiency and reliability review — 2026-09-29

This document records the investigation at commit `472c2e7`. The OCC accounting, ObservationPack lineage, and EPR coverage findings have since been implemented; see [the implementation and real-provider verification report](2026-09-30-fixes-validation.md) for the current status. Historical measurements below describe the original baseline.

## Decision

Prioritize correct progress boundaries, evidence retention, and complete cost accounting. The strongest immediate result is a reproduced Online Context Compact (OCC) feedback loop and its small, tested correction. A broader reduction in task cost without loss of capability has **not** been established by this investigation.

The accepted change is commit `2747327`: only an observed step with the same id and goal moving from `pending` or `in_progress` to `completed` creates a compaction boundary. A completed plan imported after compaction establishes a baseline. Six new regression cases fail before the change and pass afterward; the real Pi `AgentSession` cases reduce repeated compactions from four to one, and from eight to two when genuine later progress is included. These are deterministic lifecycle results, not measured dollar savings.

The next most valuable work is a coordinated OCC accounting correction and an ObservationPack branch correction. EPR should establish coverage of distinct failures before increasing reduction frequency. Broad architectural rewrites, a larger instruction prompt, and reducer receipt caching have weaker support from this workload.

## Scope and evidence

The investigation combines source review, upstream PR inspection, original papers, a read-only local session audit, and deterministic execution through the installed Pi engine. It does not include a new paid model benchmark or an independent task-quality trial.

| Item | Recorded state |
|---|---|
| Local source baseline | `4a2f06354f8c74025ab9a4028bbf3277a8c6155e` |
| Upstream main at inspection | `1559b5cb12c72da4a485bc50fe326586b216fb19`, committed 2026-09-22 |
| Isolated research branch | `research/efficiency-20260929` |
| Tested runtime | Node 26.10.0, npm 11.19.1, Pi 0.85.1 from the lockfile |
| Declared Pi peer range | `>=0.84.2 <0.86.0` |
| Session audit cutoff | Before `2026-09-29T00:00:00Z` |
| Upstream inventory | 56 PRs listed; selected relevant bodies and diffs examined |
| Implementation scope | OCC progress detection, its tool guidance, regression tests, and documentation |
| Research tools | Two source-checkout scripts; no runtime registration or configuration changes |

The current interactive host uses a later Pi release. Its ability to run this conversation does not establish compatibility for the declared package. No upstream Pi source, global installation, credentials, or effective SoL-Pi configuration was modified.

Existing untracked research notes, paper source, `goal.md`, and the ObservationPack benchmark in the original checkout were preserved. The isolated branch contains the reviewable work. The source-checkout validation procedure in `agents-install.md` applies; installation/configuration phases were not performed because this was research and a repository correction, not a managed installation.

Evidence labels used below:

- **Executed:** observed through a script, test, or the real Pi engine during this investigation.
- **Source-confirmed:** directly present in the inspected implementation; production impact may still be workload-dependent.
- **External:** a PR author's result or a paper's experiment, not a local reproduction.
- **Hypothesis:** a proposed intervention whose quality and cost require a controlled experiment.

## Local workload findings

The committed [aggregate audit](2026-09-29-session-summary.json) contains no session identities, timestamps per session, paths, prompts, tool arguments, logs, or error bodies. The scanner only visits direct project-level JSONL files. It includes persisted abandoned branches, excludes nested worker sessions, and does not expand tool calls embedded in wrapper arguments. A session with an OCC snapshot belongs to the OCC cohort; this does not mean OCC was active for every event in that session.

| Metric | All audited sessions | Sessions containing OCC state |
|---|---:|---:|
| Sessions | 200 | 52 |
| Assistant messages | 48,585 | 11,097 |
| Messages with complete nonzero usage fields | 48,128 | 11,034 |
| Missing or zero usage | 457 | 63 |
| Direct `todo` calls | 6,457 | 1,708 |
| Direct `update_plan` calls | 44 | 44 |
| Structurally readable plan calls | 43 | 43 |
| Native compactions | 269 | 57 |
| Recorded OCC continuation messages | 8 | 8 |
| `obs_recall` calls | 67 | 63 |
| Tool results above `THRESHOLD_BYTES` | 5,681 | 1,264 |
| Mutation calls containing `then_run` | 997 | 997 |
| EPR provider responses | 79 | 78 |
| EPR applied events | 75 | 74 |
| EPR fallback events | 5 | 5 |

There were 206 files at discovery, six wholly outside the cutoff, three malformed lines, and no detected file changes during reading. The main assistant usage sums to 8,092,383,294 reported tokens. A further 26,268,593 tokens appear in 269 session-entry usage records, and EPR responses report another 751,789 tokens. These are distinct recorded usage categories, **not a currency total**. Missing usage, abandoned branches, model and tariff differences, retry visibility, and nested-worker exclusion prevent interpreting the aggregate as a complete bill.

The counts support these priorities:

1. **Boundary adoption deserves attention.** Even within the OCC cohort, `todo` is much more common than `update_plan`. This is consistent with two competing progress interfaces. It is not proof that all `todo` calls should have triggered compaction: tool availability and enablement varied, and a `todo` event may not establish a safe boundary.
2. **Native compaction is not synonymous with OCC intervention.** The audit finds 269 native compactions but only eight explicit OCC continuation messages. Counting every native compaction as an OCC success would misattribute most of this sample.
3. **Omitted model calls can materially distort accounting.** Native summaries and reducer calls have usage outside ordinary assistant messages. Failure/retry costs also need an explicit unknown category.
4. **The repeated-plan loop is reproduced, but not established as a historical local incident.** No pair of persisted compactions was separated by at most two assistant messages under the scanner's chronological definition. That result does not rule out slower chains or branch-specific behavior.
5. **Receipt caching has little support in this sample.** None of the 79 recorded candidates repeats the same source hash, command hash, and error state within a session. Caching may matter in other workloads, but cannot explain a large opportunity here.
6. **Activation counters are not savings.** A call carrying `then_run` may fail, and a recall count says nothing about whether forgotten evidence was successfully recovered. EPR events are events rather than a normalized request-success table; applied and fallback counts should not be converted mechanically into a success rate.

The maximum recorded native summary was 58,138 characters. OCC's `DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE` is a token estimate, so this character count is not a direct token comparison. It nevertheless supports measuring actual summary usage rather than relying on one fixed prediction across tasks.

## Executed diagnostic findings

Run `node scripts/probe-compaction-policy.mjs` from the research checkout. The probe creates synthetic sessions, invokes Pi's own preparation engine, exercises the actual ObservationPack hook, and removes its temporary archives. It makes no model calls. The private Pi import is confined to this research script; the extension continues to use public APIs.

| Finding | Executed result | Consequence and limit |
|---|---|---|
| Fixed retained-tail subtraction can greatly overestimate removal | Context 41,006 estimated tokens; `context - keepRecent` predicts 21,006 removable; native cut removes 1,002 and retains 40,004 | A retained turn can exceed the nominal retained-tail budget. These are Pi token estimates on synthetic ASCII messages. |
| A large retained assistant response produces an even smaller removable prefix | Context 30,506; subtraction predicts 10,506 removable; native cut removes 2 and retains 30,504 | Native feasibility alone does not mean a predicted summary will reduce context. |
| Cache rebuilding uses the pre-compaction size | A 100,000-token context with 80,000 removed and 1,000 summarized gives 14.557 break-even requests in current code; rebuilding the 21,000-token result gives 3.057 under the same simplified ratio | This algebra excludes summary calls and uncertainty; it is not a sufficient replacement policy by itself. |
| Existing cache debt is replaced | Prior debt 1,000 plus newly recorded debt 600 leaves 600; prior repayment 100 plus new repayment 200 leaves 200 | The state transition discards previous obligations and accumulated savings. The correct units and lifetime need a single explicit contract. |
| Raw session history and provider projection differ | The same branch contains 5,025 estimated stored tokens but its ObservationPack projection contains 380 | Raw removable tokens cannot automatically be priced as avoided provider input. |
| ObservationPack sends are shared across branches | Branch A's third projection is masked; after branching from the shared observation, B's first projection is also masked, despite zero assistant responses after the shared observation on B | B can lose the intended initial full exposure because A consumed the count. Recall still exists; this does not prove a task failed. |
| EPR verifies quotation fidelity, not failure coverage | A source with two distinct errors accepts a receipt quoting only the first | An exact quote can still omit a second defect. Source archival makes recovery possible but does not ensure the model knows to recover it. |
| Diagnostic classification is inconsistent with common workflows | `npm test` and `cargo test` match; `npm run check` and `npx vitest run` do not; `cargo fmt` also matches | The gate is both incomplete for this repository and broader than its apparent Cargo subcommand intent. |

The accepted OCC correction addresses the first control-flow failure discovered: completed-plan replay creating fresh boundaries. The other rows remain diagnosed candidates, not implemented fixes in this branch.

## Upstream candidates and disposition

PR states and heads below were observed on the review date. An open PR is not evidence that the local checkout lacks its fix: this checkout already contains several equivalent changes.

| Upstream item | What was checked | Disposition |
|---|---|---|
| [#85](https://github.com/NVlabs/SoL-Pi/pull/85), head `29950c57b3fbbc2bbf7c1d5b55eda4fd60077026` | Replayed completed plans after `recordCompaction` clears the plan; latest diff includes restoration/cooldown logic beyond the original description | **Accepted a smaller local correction:** require an observed same-id, same-goal transition. Covers renaming as well as exact replay without new persisted state. |
| [#90](https://github.com/NVlabs/SoL-Pi/pull/90), head `2245ae6b19332d2e4e27f645260b7f9634494566`; [#6](https://github.com/NVlabs/SoL-Pi/pull/6); [#62](https://github.com/NVlabs/SoL-Pi/pull/62) | Native cut geometry, cache rebuild size, cumulative debt and repayment | **Highest-priority policy candidate.** Local probes confirm the underlying discrepancies. Do not transfer the PR's pilot cost result as causal proof: its ten-task comparison includes runtime/configuration and usage-coverage differences. |
| [#71](https://github.com/NVlabs/SoL-Pi/pull/71), [issue #70](https://github.com/NVlabs/SoL-Pi/issues/70) | Boundary-request history survives compaction epochs and completed-task transitions | **Retain for design.** Estimate horizon per current task/epoch, and measure actual summary size. Validate long research followed by short wrap-up; do not assume a global historical mean predicts remaining work. |
| [#89](https://github.com/NVlabs/SoL-Pi/pull/89), head `f6d73af1487c306782593636f800168f39447c9f` | Configurable full-send count, including immediate masking | **Experimental candidate.** Prefix changes are real; setting the count to zero changes initial evidence exposure. Require same-model quality and cache measurements before changing defaults. |
| [#13](https://github.com/NVlabs/SoL-Pi/pull/13) | Session-wide observation send counts versus branch ancestry | **Confirmed priority correction.** Count exposure from the active lineage while preserving shared archive identity. Test forks, returning to an old branch, retries and compaction. |
| [#32](https://github.com/NVlabs/SoL-Pi/pull/32), [issue #42](https://github.com/NVlabs/SoL-Pi/issues/42) | `pendingProgress` is accumulated and cleared without being included in explicit compaction instructions | **Retain bounded evidence handoff.** Raw tool-call arguments may already reach the summarizer, so this is not proof that all progress is currently invisible. Compare bounded explicit evidence against simply removing redundant state. |
| [#14](https://github.com/NVlabs/SoL-Pi/pull/14) | Literal search over archived observations | **Retain retrieval experiment.** Exact paging is awkward when the required line is in the middle of a large result. Measure correctness and added retrieval turns; preserve bounded output and literal semantics. |
| [#8](https://github.com/NVlabs/SoL-Pi/pull/8) | Reuse of verified reducer receipts | **Deprioritize for this workload.** No same-session repeated candidate key in the sample; cache identity must include reducer route, receipt schema and failure state. |
| [#47](https://github.com/NVlabs/SoL-Pi/pull/47), [#27](https://github.com/NVlabs/SoL-Pi/pull/27), [#30](https://github.com/NVlabs/SoL-Pi/pull/30), [#64](https://github.com/NVlabs/SoL-Pi/pull/64) | Failure evidence, diagnostic gate, classification before file I/O, bounded full-output reads | **Prioritize completeness and resource bounds over greater reduction frequency.** Preserve distinct errors or fail open when the evidence budget cannot cover them. |
| [#84](https://github.com/NVlabs/SoL-Pi/pull/84), [#86](https://github.com/NVlabs/SoL-Pi/pull/86), [#87](https://github.com/NVlabs/SoL-Pi/pull/87), [#88](https://github.com/NVlabs/SoL-Pi/pull/88) | Continuation settlement, benign native refusal, and changed Pi behavior | **Compare against local implementation first.** Local deferred continuation and native feasibility logic already contain relevant work. Pi 0.87+ support is a separate compatibility change, not established by this patch's Pi 0.85.1 tests. |
| [#33](https://github.com/NVlabs/SoL-Pi/pull/33), [#69](https://github.com/NVlabs/SoL-Pi/pull/69) | Repeated hashing/file checks and per-observation ledger appends | **Measure before adopting.** CPU/I/O optimization may reduce latency; it does not by itself reduce model cost or improve evidence retention. |

## What the papers support

| Primary source | Useful result | Bound on the inference |
|---|---|---|
| [SoL-Pi, arXiv:2609.20519](https://arxiv.org/abs/2609.20519), local v1 TeX, overall comparison and ablations | On GPT-5.6 Sol, the efficiency stack changes cost from $1,339 to $894 and average score from 44.833 to 42.003. The Performance configuration reports $1,271 and 47.208. | Lower cost per score does not establish unchanged capability. Mechanisms and operating points must be evaluated separately. |
| Same paper, Terminal-Bench 4 table | On 63 CPU-only tasks, Pi solves 18 and SoL-Pi solves 15; total cost decreases from $286.45 to $211.12. | Three fewer solved tasks cannot be described as capability-preserving merely because cost per solved task improves. These are reported point estimates. |
| [The Complexity Trap, arXiv:2508.21433v2](https://arxiv.org/html/2508.21433v2) | Simple observation masking is a strong competitor to model summarization in the studied coding-agent conditions. | Supports a cheap masking baseline. It does not prove masking retains arbitrary evidence in this Pi workload or that an extra summarizer always loses. |
| [ACON, arXiv:2510.00615v3](https://arxiv.org/html/2510.00615v3) | Compression guidance can be improved using downstream failure analysis and long-horizon evaluation. | Peak context and total billed cost are different objectives. Additional compression calls and training/search cost must remain visible. |
| [Rethinking the Evaluation of Harness Evolution for Agents, arXiv:2607.12227v2](https://arxiv.org/html/2607.12227v2) | Matched-compute baselines and disjoint evaluation substantially change conclusions about harness evolution; the reported disjoint-test average improvement is 0.6 points. | This is not a universal impossibility result. It supports separate development, acceptance and final holdout tasks, and comparison to simpler uses of the same compute. |

The SoL-Pi ablations identify a trade-off worth testing locally: Action Fusion and ObservationPack can preserve or improve the reported score at less aggressive cost reduction, whereas OCC drives a larger token decrease alongside a lower score in that table. This does not causally assign every failure to OCC; it is a reason to evaluate individual mechanisms before enabling the whole stack as a presumed optimum.

[OpenAI prompt-caching documentation](https://platform.openai.com/docs/guides/prompt-caching) and [Anthropic prompt-caching documentation](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) describe reuse tied to matching prefixes, with provider-specific accounting. Replacing an old observation can therefore affect the cached suffix that follows it. Cache hit rate alone is insufficient: a smaller prompt may cost less even with a lower hit rate, while a transition to a smaller prompt may temporarily cost more.

## Concrete design directions

### 1. Give OCC one accounting basis

Current ownership is split across `extension.ts` (projected context and approximate archive size), `economics.ts` (decision), and `state.ts` (debt lifetime). A change to what “saved token” means currently requires these pieces to remain synchronized implicitly.

Two viable approaches are:

- **Correct individual formulas in place.** Lowest immediate effort and easy to revert, but native cut geometry, transformed context, debt and summary cost can still disagree.
- **Produce one internal compaction estimate and consume it everywhere.** A host adapter determines the cut and maps retained/removed entries to the provider-visible projection. A typed value carries before/after size, summary estimate or measured history, and uncertainty into pure economics and state transitions. This is the recommended bounded direction because it makes the accounting invariant explicit.

Keep raw history cost separate from provider projection cost: the native summarizer may read raw history even when the main model sees placeholders. Do not serialize token facts into a status string and parse them back. If the host cannot expose a reliable cut/projection mapping, mark the estimate unavailable and use the documented native window-protection behavior rather than claim an economic gain.

A simplified transition comparison, with equal future task behavior and cache-read-normalized units, is:

```text
removed benefit per request = projected_before - projected_after
transition penalty = projected_after * (write_read_ratio - 1)
net benefit over H requests = H * removed benefit
                              - transition penalty
                              - summary_model_cost
                              - expected_extra_recall_or_recovery_cost
```

This is a model, not a bill. Actual pricing distinguishes ordinary input, cache reads/writes, output and sometimes reasoning. Debt must preserve its units across model changes, successive compactions, and overrides forced by window pressure. Use the current epoch's remaining-work estimate; record realized usage to compare predictions with outcomes.

Acceptance fixtures should include an oversized retained user turn, an oversized assistant response, a split tool turn, previous summaries, masked observations, EPR receipts, model changes, a short final phase after a long investigation, forced compaction while debt remains, and an unknown native outcome. Keep task quality checks independent from token estimates.

### 2. Make ObservationPack exposure follow the branch

Archive identity and exposure history serve different purposes. The content-addressed archive can remain shared within a session; whether a model on a branch has seen it must follow that branch's ancestry.

Resetting all send counts on every branch switch is simple but repeatedly resends observations when revisiting a branch. Deriving exposure from ancestry costs more bookkeeping but preserves the intended full-send policy across forks and returns. Prefer lineage-based exposure with bounded, invalidatable caching. Cover a fork made before the observation's first model exposure, return to a previously visited branch, retry after a failed provider request, and compaction that removes ancestors.

Separately, compare the current delayed replacement with first-send masking and a stable small envelope containing a recall handle. For an observation of size O replaced by S, with suffix R after it, an idealized cached comparison has benefit approximately:

```text
H * cache_read_price * (O - S)
  - (write_price - cache_read_price) * (S + R)
  - recall_cost
```

Here H includes the first replacement request and subsequent requests. A provider cache miss or changed prefix changes the calculation. Immediate masking avoids one later prefix mutation but may force an extra recall before any useful work. Measure both quality and the full request sequence before changing `FULL_SENDS` or exposing a new public setting.

### 3. Preserve enough evidence to detect a second failure

EPR's verifier proves retained quotes occurred in the source. It cannot prove a model selected every relevant failure. The two-error probe demonstrates the distinction directly.

One bounded improvement is deterministic extraction of distinct failure signatures, followed by quote-checked summarization of surrounding context. Another is allowing the model to select everything and evaluating completeness only afterward. Prefer deterministic preservation where the diagnostic format has a reliable parser; for unknown formats or too many distinct failures, retain the original output. Do not hide an overflow behind a truncated “complete” receipt.

Evaluate success logs and multiple simultaneous failures separately. The reference oracle should require finding and repairing every seeded fault, including a middle-of-log error absent from a head/tail excerpt. Include the reducer call, retries, any archive search/recall, and the final repository verification in cost.

### 4. Make the progress interface usable in the actual harness

The `todo`/`update_plan` imbalance is an adoption signal. A longer general prompt is a weak first intervention. Prefer one visible planning interface when OCC is active, or a narrow adapter from successful host planning events into the existing OCC owner. An adapter must not infer completion from a tool call that failed, treat a replay as progress, or maintain a second independent plan.

A bounded explicit handoff of verified files, decisions and checks at compaction may help. It should preserve the current goal and unresolved work and reference source evidence. Compare that with removing write-only `pendingProgress`; do not retain unlimited progress snapshots simply because they might be useful.

The local `sol-behavior` Round 2 protocol and report were also inspected. They compare a general SOL-v2 instruction prompt against existing instructions, not SoL-Pi mechanisms: nine tasks per arm passed, with 296 versus 306 tool calls. That prior report does not justify a larger prompt or a claim about this plugin. Its archived model sessions were not rerun here, and its LSP/shutdown correlation is not attributed to SoL-Pi.

### 5. Preserve the existing module boundaries unless an invariant requires change

The architecture review found the useful boundary already present: pure plan and economics logic, explicit state transitions, a Pi event adapter, and separate archive/reducer/observation owners. The accepted fix changed the plan owner rather than adding another lifecycle flag. Moving directories or introducing a shared “compression framework” would add migration work without resolving the measured failures.

The consistency checks produced the following bounded findings:

| Check | Instances examined | Result |
|---|---|---|
| Declared rules against implementations | Four mechanisms, standalone registration, opt-in configuration, evidence archives | Runtime remains standalone. The diagnostic's private Pi import is an explicit research-only exception and is excluded from the package. |
| Sibling behavior | Action Fusion, ObservationPack, EPR, OCC | Their different failure and persistence behavior follows distinct responsibilities; see the table below. No common lifecycle wrapper is justified. |
| One concept, one representation | Plan identity, reducer receipt marker, token estimates, cache debt, plan/progress tools | Plan identity fixed at its owner. Receipt marker knowledge is duplicated between EPR and ObservationPack; cost units and progress interfaces need follow-up. |
| Dependency direction | Imports in the four mechanism directories and shared registration | Pure OCC computation remains separate from host event wiring. EPR receipt validation uses a provider-result type from the provider module: a type-level ownership coupling to consider if the route contract changes. |
| Documentation and code | README, config/compatibility docs, package file list, module headers | Plan behavior documented with the fix. `package.json` lists absent `scripts/compare-observation-search.mjs`; npm silently omits it. Treat that stale file-list entry as packaging cleanup, not a runtime defect. |

| Mechanism | Entry and validation owner | Effects and lifecycle | Failure/output contract |
|---|---|---|---|
| Action Fusion | Tool schema plus mutation/path handling | Mutate a file, then execute a dependent command through Pi | A failed mutation skips the command; preserve tool error and execution status. |
| ObservationPack | Context hook plus archive/recall boundaries | Store exact text and project placeholders; ledger and objects persist per session | Recall remains bounded; unavailable recall must not hide the source. Branch exposure is the confirmed inconsistency. |
| EPR | Candidate classifier, provider adapter, receipt validator | Archive eligible logs; optional nested model call; record event journal | Invalid or failed reduction keeps the original result; quotation fidelity is enforced, coverage is not. |
| OCC | `update_plan`, plan parser, economics, Pi settlement adapter | Persist state and request native compaction, then continue the active task | Preserve cancellation, native refusal and error semantics; only real observed completion creates a boundary. |

Three sampled change paths explain the ranking: a progress-identity change stays in `plan.ts` plus guidance/tests; a compaction cost change currently spans extension/economics/state and host geometry; a receipt-format change also reaches ObservationPack's recognition logic. The second has the highest measured impact, while the third is a smaller source-of-truth cleanup. Further structural changes reach diminishing returns until those behavioral contracts are settled.

## Evaluation contract for further candidates

The executed work is development research, not a prospectively registered holdout trial. The historical session corpus and deterministic fixtures were used to discover problems and must not be relabeled as independent acceptance data.

A subsequent mechanism comparison should freeze:

1. Exact Pi and SoL-Pi commits, provider/model, reasoning level, tool set, environment, task timeout, cache policy and task seeds.
2. Disjoint development, acceptance and final holdout tasks. Once inspected or used for tuning, a task no longer serves as the final holdout.
3. A task-quality oracle outside the agent: all original requirements, seeded user edits, all independent errors, meaningful tests, and completion without extra user intervention.
4. A non-inferiority criterion chosen before looking at candidate results. Do not trade away failed tasks in a cost-per-score average. A small sample with equal successes is limited evidence, not proof of equality.
5. A complete ledger of main calls, summaries, reducers, retries, recall/search, failed/aborted calls, and final validation. Mark unknown usage explicitly. Report cost per attempt and success, quality, uncertainty, latency and context peaks separately.
6. Equal total search and test-time budgets for the candidate and a simple baseline. Interleave or randomize arms to limit service and cache confounding. Freeze exclusions and retain failed attempts.

Start with the current fixed build, then individual accounting or branch changes, then combinations that pass their independent quality checks. A stable-envelope masking arm and a deterministic failure-extraction arm are useful alternatives to an extra summarizer. No new performance-qualified mechanism is accepted from this investigation; only the reproduced lifecycle correction is accepted.

## Reproduction and validation

From the research branch with lockfile dependencies installed:

```bash
npm ci --ignore-scripts
npm run check
npm audit --audit-level=high --registry=https://registry.npmjs.org
node scripts/check-pi-compat.mjs
npx vitest run tests/all-mechanisms.test.ts
node scripts/probe-compaction-policy.mjs
```

To generate a new local aggregate, substitute the actual Pi session root and an unused output filename. The command refuses to overwrite an existing report:

```bash
node scripts/analyze-session-efficiency.mjs --root /path/to/pi/sessions --before 2026-09-29T00:00:00Z --summary-only --out session-summary-new.json
```

Successful reports omit source content. Without `--summary-only`, the report additionally contains hashed session identifiers and per-session metrics. The scanner bounds file count and file size through `MAX_FILES` and `MAX_FILE_BYTES`, reads only the initially observed byte range, and reports malformed lines, missing usage and observed concurrent changes. It does not reconstruct active branches or hidden provider payloads. An exit failure is not a completed report.

Verified results:

| Check | Result |
|---|---|
| New OCC tests against old behavior | Six failures; real `AgentSession` compacts four times instead of one and eight instead of two |
| Focused plan and real-session tests after correction | 17 passed |
| Complete isolated `npm run check` | Exit 0; TypeScript passed; 22 test files, 225 passed, 3 skipped; package dry-run passed |
| `check-pi-compat.mjs` | Exit 0 |
| Explicit all-mechanisms integration | 4 passed |
| Session audit black-box regression | 2 passed: content privacy, category accounting, cutoff/exclusion behavior, and refusal to overwrite |
| Offline policy probe | Exit 0; values in the executed-findings table reproduced |
| Dependency audit | Official registry: exit 0 at high threshold; 4 moderate vulnerabilities, no high vulnerabilities. The configured mirror's audit endpoint failed earlier and was not treated as a successful audit. |
| Original checkout baseline | `npm run check` was blocked by a pre-existing untracked benchmark passing an array to `Ledger`; its existing Vitest run had 217 passed and 4 skipped. That file was not changed. |

The three isolated-suite skips are the existing platform-dependent POSIX path/symlink cases on Windows. No project formatter or lint task is defined; whitespace is checked with `git diff --check`. A final `npm pack --prefix` invocation inspected the original checkout; packaging and audit were then rerun after explicitly changing into the research checkout. The private diagnostic import is not shipped in the npm package. No Linux/macOS run, live Pi 0.99 compatibility certification, new paid model comparison, production configuration change, or deployment is claimed.

The concrete delivered result is a verified correction to compaction progress detection, together with reproducible evidence and ranked designs for the next improvements. Remaining candidate changes are deliberately identified as research outcomes rather than presented as completed implementations.
