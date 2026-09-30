# Configuration

SoL-Pi reads one effective JSON configuration file at extension startup. It uses Pi's public `CONFIG_DIR_NAME` and `getAgentDir()` APIs rather than assuming fixed directories.

## Search order

1. `<working-directory>/<Pi config directory>/sol-pi.json`, only after Pi marks the project trusted
2. `<Pi agent directory>/sol-pi.json`
3. Built-in defaults when neither file exists

For the official Pi distribution, the first two locations normally resolve to `.pi/sol-pi.json` and `~/.pi/agent/sol-pi.json`.

The project file replaces the global file. SoL-Pi does not merge them.

## Schema

```json
{
  "version": 1,
  "actionFusion": false,
  "observationPack": false,
  "evidencePreservingReducer": false,
  "evidencePreservingReducerProvider": "provider-id",
  "evidencePreservingReducerModel": "model-id",
  "onlineContextCompact": false,
  "cacheWriteReadRatio": 12.5
}
```

Feature keys may be omitted and then default to `false`. `cacheWriteReadRatio` may be omitted and then defaults to `12.5`; when present it must be a finite non-negative number, and `0` explicitly means that a cache write adds no cost relative to a cache read. `evidencePreservingReducerProvider` and `evidencePreservingReducerModel` may be omitted and then use the built-in reducer route; when present each must be a non-empty string. Unknown keys, unsupported versions, malformed JSON, non-boolean feature values, invalid ratios, and invalid reducer model fields stop extension loading with a direct error.

For the managed all-enabled installation described in the [agent installation and configuration protocol](../agents-install.md), validate the effective file before starting Pi:

```bash
node scripts/check-sol-pi-config.mjs \
  --config /absolute/path/to/effective/sol-pi.json \
  --require-all-enabled
```

This preflight does not make every valid SoL-Pi configuration all-enabled. Without `--require-all-enabled`, omitted feature keys retain their normal `false` defaults. The managed workflow uses the flag because its acceptance criterion is that all four mechanisms are active.

## Feature behavior

- `actionFusion`: registers SoL-Pi replacements for Pi's `edit` and `write` tools.
- `observationPack`: registers `obs_recall` and a provider-context projection handler.
  Full observation exposure is derived from successful assistant responses following the result on the active session branch (`FULL_SENDS` in `observation-pack/observation.ts`). Failed or aborted attempts do not advance it. Forks and returned branches use their own histories; retained observations keep their exposure history across compaction and resume.
- `evidencePreservingReducer`: registers a `tool_result` handler and delegates long diagnostic-log reduction to the configured reducer provider/model. Every distinct line matching `FAILURE_SIGNAL` must occur in a verified quote, even if a wrapper exited successfully. Missing coverage, a line exceeding the quotation budget, or uncertain/unrecognized failing output keeps the original tool output. This guard covers recognizable failure lines; it is not a semantic proof that every possible diagnostic format was understood.
- `evidencePreservingReducerProvider`: provider namespace used to resolve the reducer model through Pi's model registry.
- `evidencePreservingReducerModel`: model id used for Evidence-Preserving Reducer.
- `onlineContextCompact`: registers `update_plan` and boundary-driven native compaction after the other SoL-Pi context transformers.
- `cacheWriteReadRatio`: supplies the single economic decision ratio used by Online Context Compact.

## Evidence-Preserving Reducer runtime inputs

The release entry supplies the run label and session-derived storage. It uses one configurable model route:

- **Reducer provider/model** — from `evidencePreservingReducerProvider` and `evidencePreservingReducerModel` in the effective `sol-pi.json`. If omitted, SoL-Pi uses its built-in reducer route. SoL-Pi resolves that model through Pi's model registry and still relies on Pi-managed authentication; do not put credentials in `sol-pi.json`.

## Online Context Compact runtime inputs

The release entry uses the following runtime inputs:

- **Context window** — from `ExtensionContext.getContextUsage()`, used for window-pressure protection.
- **Cache write/read ratio** — from `cacheWriteReadRatio` in the effective `sol-pi.json`, fixed for the loaded extension.
- **Summary prices** — from Pi's active model metadata (`cost.input`, `cost.output`, `cost.cacheRead`). Without a positive cache-read price, economic compaction defers; window protection remains available.

The estimate uses Pi's public cut-point and message-conversion functions. Removable history is measured using the most recent tool-result projection, so an already masked observation is charged at its visible size. Summary input is separately serialized from raw retained session history through Pi's serializer. `DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE` budgets each native summary call and `SUMMARY_PROMPT_TOKEN_ESTIMATE` allows for its prompt. Split turns can require two summary calls. Cache rebuilding uses the predicted retained context plus the memo; previous unpaid debt and repayment accumulate. Successful boundary compactions reconcile memo size and use reported positive summary cost when available. These estimates omit provider-specific tool-schema overhead, uncertain future masking, and unreported retry charges; they are policy inputs, not a billing ledger.

The configured ratio stays fixed for the loaded extension. The mechanism stores its current plan, progress summaries, request horizon, context growth, and compaction debt as versioned custom entries in Pi's session log. After a successful compaction it sends one hidden, generic message with `triggerTurn: true`, which starts a new turn and instructs the assistant to rebuild its plan. A settlement barrier keeps print and JSON modes in the same Pi invocation until that continuation settles, so callers do not need to resume the session or inject `Continue working`. Cancelling or exiting does not schedule an automatic continuation. The mechanism creates no separate Online Context Compact files. The programmatic factory exposes only a matching retained-tail value for installations whose Pi compaction setting differs from the default.

A boundary requires a previously observed `pending` or `in_progress` step to become `completed` with the same id and goal. When no previous plan exists, as in a fresh session or after correction or compaction, the first plan establishes a baseline; completed steps first seen there do not imply new progress. Resuming an existing session still compares against its restored plan. Replaying or renaming completed steps does not create a boundary. Real completion transitions after that baseline remain eligible for compaction.

## Pi integration

SoL-Pi reads no dedicated environment variables. Evidence-Preserving Reducer resolves its configured reducer provider/model through `ExtensionContext.modelRegistry` and uses Pi-managed authentication. If the configured reducer model is unavailable or the nested model call fails, the original tool result continues unchanged.

SoL-Pi does not configure shell paths, command prefixes, storage paths, run IDs, provider URLs, reasoning levels, timeouts, or per-mechanism enable flags through environment variables. Apart from the EPR reducer provider/model route in `sol-pi.json`, model selection remains with Pi. Action Fusion uses Pi's default shell behavior. Persistent artifacts are derived from Pi's session directory and session ID.

## Trust

A project-local config can enable file mutation, shell execution, local archival, and remote diagnostic-log reduction. SoL-Pi waits for Pi's `session_start` context and ignores the project file unless `ctx.isProjectTrusted()` is true. Prefer the global file when you want one personal configuration across trusted projects.
