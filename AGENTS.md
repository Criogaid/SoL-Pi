# SoL-Pi installation and configuration instructions

For any request that installs, builds, configures, or validates SoL-Pi:

1. Read `agents-install.md` completely before taking action.
2. Follow its phases, stop conditions, evidence requirements, and install-scope rules unless an explicit user instruction conflicts.
3. Never expose a credential or silently ignore a failed validation command.
4. Keep upstream Pi unmodified; SoL-Pi must remain a standalone extension.

For ordinary repository changes, preserve the same compatibility and secret-handling constraints.

Online Context Compact plan validation and progress detection belong to `src/sol-pi/extensions/online-context-compact/plan.ts`. Only observed completion transitions for the same step id and goal are boundaries; imported completed steps establish a baseline.

The opt-in request ledger lives in `src/sol-pi/request-ledger.ts`; it is a diagnostic, not a mechanism, and records only sizes, counts, hashes, usage, and OCC decision outcomes. Mechanisms report decisions through an injected recorder rather than writing their own diagnostic files.

OCC's Pi cut-point and projection adapter lives in `online-context-compact/extension.ts`; `economics.ts` consumes estimates in cache-read token equivalents and `state.ts` accumulates unpaid debt. Keep raw summarizer input separate from provider-visible tool results. Hosts without the public cut-point helpers skip optional boundary compaction.

Research findings and script contracts are indexed in `docs/research/2026-09-29-efficiency-review.md`. `scripts/analyze-session-efficiency.mjs` audits local sessions without exporting their content; `scripts/probe-compaction-policy.mjs` runs synthetic, offline diagnostics. Neither is part of the runtime package.

ObservationPack derives full exposure from successful assistant responses in the active lineage, including ancestors hidden by compaction. Its archive is session-scoped; exposure has no independent mutable counter. Retry failures and aborts do not consume exposure.

EPR receipt coverage belongs to `evidence-preserving-reducer/receipt.ts`. Every distinct line matching the shared `FAILURE_SIGNAL` must survive in an exact quote; missing coverage or uncertain/unrecognized failures return the original output. `failureCoverageFits` skips the reducer call only when the quote budget provably cannot cover those lines; unproven cases still reach the reducer. Keep prompt instructions, the pre-check, and validation together.

Real-provider verification is documented in `docs/research/2026-09-30-fixes-validation.md`. `scripts/verify-live-agent.mjs` uses the public Pi SDK and synthetic temporary projects; model calls require `--run` or `--start`, and output paths must be new. It initializes SDK extensions before checking active tools. Reports contain only aggregate checks and usage, and temporary sessions are removed. The lockfile's Pi 0.85.1 transitive dependency audit currently fails at high severity; do not describe the managed installation gate as satisfied.
