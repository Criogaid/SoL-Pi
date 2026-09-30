# SoL-Pi installation and configuration instructions

For any request that installs, builds, configures, or validates SoL-Pi:

1. Read `agents-install.md` completely before taking action.
2. Follow its phases, stop conditions, evidence requirements, and install-scope rules unless an explicit user instruction conflicts.
3. Never expose a credential or silently ignore a failed validation command.
4. Keep upstream Pi unmodified; SoL-Pi must remain a standalone extension.

For ordinary repository changes, preserve the same compatibility and secret-handling constraints.

Online Context Compact plan validation and progress detection belong to `src/sol-pi/extensions/online-context-compact/plan.ts`. Only observed completion transitions for the same step id and goal are boundaries; imported completed steps establish a baseline.

OCC's Pi cut-point and projection adapter lives in `online-context-compact/extension.ts`; `economics.ts` consumes estimates in cache-read token equivalents and `state.ts` accumulates unpaid debt. Keep raw summarizer input separate from provider-visible tool results. Hosts without the public cut-point helpers skip optional boundary compaction.

Research findings and script contracts are indexed in `docs/research/2026-09-29-efficiency-review.md`. `scripts/analyze-session-efficiency.mjs` audits local sessions without exporting their content; `scripts/probe-compaction-policy.mjs` runs synthetic, offline diagnostics. Neither is part of the runtime package.

ObservationPack derives full exposure from successful assistant responses in the active lineage, including ancestors hidden by compaction. Its archive is session-scoped; exposure has no independent mutable counter. Retry failures and aborts do not consume exposure.
