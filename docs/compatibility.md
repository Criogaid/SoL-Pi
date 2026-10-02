# Pi Compatibility

SoL-Pi is developed and tested against `@earendil-works/pi-coding-agent` 0.85.1. Earlier validation also covered 0.84.2; the Windows changes have not been revalidated on that release. Previous checks covered the public API surface of Pi 0.81.1, the base used by the original Pi fork; they are not a current full-suite compatibility guarantee. The runtime range is deliberately expressed as a peer dependency because Pi owns installation and upgrade of its packages; it is not a guarantee for every Pi version.

SoL-Pi declares Pi package peers at `>=0.84.2 <0.86.0`. Pi 0.85.1 is the validated runtime for this filtered branch; the declared lower bound reflects earlier compatibility checks, not a new full-suite run of this branch on 0.84.2. Pi 0.81.1 remains an API compatibility check rather than a supported runtime baseline. SoL-Pi imports only public package exports:

- `createEditToolDefinition`
- `createWriteToolDefinition`
- `createBashToolDefinition`
- extension types and `ExtensionAPI.registerTool`
- `context`, `before_provider_request`, `tool_result`, `turn_end`, `agent_settled`, and `session_before_tree` extension events
- native compaction events, `ExtensionContext.getContextUsage()`, and `ExtensionContext.compact()`
- `ExtensionContext.model` and `ExtensionContext.modelRegistry`
- the public session-manager methods exposed through `ExtensionContext`

## Action Fusion

The built-in edit/write definitions capture their working directory, so SoL-Pi caches one definition per `ctx.cwd`. Its own per-file queue surrounds the built-in mutation and follow-up command. It does not nest Pi's built-in mutation queue.

Action Fusion decodes `file://` targets with Node's `fileURLToPath()` before resolving the queue and hash-check path. This keeps file URLs, including percent-encoded filenames and Pi's optional `@` prefix, aligned with the file handled by the built-in mutation tool.

On Windows it applies the same drive-path conversion Pi's own resolver applies, so Git Bash, MSYS, Cygwin, and WSL targets such as `/c/src/app.ts` and home-relative `~\` paths resolve to the file the built-in mutation tool wrote. On other platforms those inputs keep their POSIX meaning.

The queue covers only fused operations registered by this SoL-Pi instance. External processes, direct built-in-tool calls outside the replacement, and unrelated extensions are not globally locked. SoL-Pi hashes the target immediately before launching `then_run` and skips the command if it observes an intervening content change.

## ObservationPack

ObservationPack changes only the messages projected through the public `context` event. Stored session history remains intact. Original bytes and the JSONL ledger live under the session-derived SoL-Pi directory.

The directory returned by Pi's `SessionManager.getSessionDir()` is the trusted storage boundary; Pi's session directory and its ancestors must remain under the user's control. ObservationPack checks the final object directory when storing a result and rejects symbolic links at the object path before reading or reusing it.

Object access uses `O_NOFOLLOW` where available and compares the opened handle with the path's pre-open identity. These object checks are not an atomic defense against processes replacing parent directories. This filtered branch does not include the later descendant-directory-chain checks.

## Evidence-Preserving Reducer

The reducer handles public `tool_result` events and resolves the configured reducer provider/model through Pi's model registry before calling `ExtensionContext.modelRegistry.complete()` when available. For the Pi 0.81.1 fork, which exposes no registry `complete()` method, it resolves authentication for that reducer model through `getApiKeyAndHeaders()` and calls the shared `@earendil-works/pi-ai/compat` completion API. The reducer preserves the original result whenever the configured reducer model is unavailable or eligibility, model-call, schema, source-hash, exact-quote, size, or likely-secret checks fail.

All persistent paths use `SessionManager.getSessionDir()` and `getSessionId()`, which are present in both the fork and Pi 0.85.1. SoL-Pi creates no configurable storage-path surface.

The unpublished shared artifact layout is not read or migrated. Each session starts from its own `<sessionDir>/sol-pi/<sessionId>/` directory.


## Online Context Compact

Online Context Compact uses ordinary public `context` and `before_provider_request` handlers instead of fork-only post-transform observer methods. Public handlers run in extension load order, so the SoL-Pi entrypoint registers Online Context Compact after its other context transformers. A third-party transformer loaded later is outside the context-growth observation used by its estimate.

Pi does not expose its active retained-tail compaction setting through the public extension context. The standalone extension therefore uses the Pi 0.85.1 default of 20,000 tokens for its economic estimate. Its programmatic factory accepts an explicit matching value for a non-default Pi setting.

Pi's `ExtensionContext.compact()` aborts an active agent before summarizing and does not automatically resume the interrupted turn. After a completed `update_plan`, Online Context Compact checks the finalized tool batch at `turn_end`, including tool success and cancellation, before selecting compaction. It saves plan and progress state, calls `ExtensionContext.abort()` to stop the run, and runs native compaction from the resulting `agent_settled`. The handler awaits the compaction's `onComplete`/`onError` callback. On success, a hidden `ExtensionAPI.sendMessage()` reminder with `triggerTurn: true` starts a new turn against the compacted context so the model rebuilds the plan.

On Pi 0.85.1, a settlement barrier keeps the original `agent_settled` dispatch open until the synchronously started continuation settles. On Pi 0.87.1, `sendMessage()` defers that turn until all `agent_settled` handlers return, so the handler yields and Pi awaits the queued continuation. Print and JSON modes complete the compact-and-continue sequence within the same invocation on both tested hosts. A continuation is armed after successful boundary compaction or a known rejection before a replacement summary is committed (nothing to compact, already compacted, or incomplete summary). Rejections retain the original context and clear pending debt immediately; successful non-plan tool work or new input is required before retrying. Cancellation and exit do not schedule a continuation, and unknown failures propagate. Settlement diagnostics mark recovery continuations with `compaction: "skipped"`.

`sendMessage()` does not return the continuation promise. Pi 0.85.1 starts a turn requested from `agent_settled` synchronously, while Pi 0.87.0 and later defer it with `ctx.isIdle()` still true. The extension handles both contracts; the 0.87.1 check used a real `AgentSession` with a faux provider, but the declared peer range still ends before 0.86.0. An intentional `abort()` can leave an empty error/aborted assistant entry; the extension does not rewrite that record or filter unrelated empty assistant messages. Later-loaded extensions with long asynchronous `agent_settled` handlers require their own integration checks.

Pi reports the session as idle while an extension-requested manual compaction is running. SoL-Pi cancels `session_before_tree` during that interval to prevent tree navigation from moving the active leaf underneath the compaction. Navigation works normally after the compaction callback settles.

The compaction cut-point and projection adapter stays in `online-context-compact/extension.ts`. It maps only observed messages to active source entries, including the last compaction summary, without rerunning context hooks. Raw summarizer input remains separate from provider-visible savings. Successful compaction preserves the current plan; replaying completed steps produces no new completion transition. The persisted v1 state accepts older entries without `lastCompactionRequestCount`, treating their cooldown baseline as unknown.

Online Context Compact reads `ExtensionContext.getContextUsage()` for both the context window and the provider-counted context size. When Pi reports no size — as it does between a compaction and the next answered request — the boundary falls back to its own estimate.

The standalone entry passes `cacheWriteReadRatio` from `sol-pi.json` into Online Context Compact's cache-rebuild check. Pi model price metadata estimates summary cost in cache-read token equivalents. The configured ratio stays fixed; use a new session for a different model/pricing policy. Missing summary prices defer economic compaction while leaving window protection active. Hosts missing the public `findCutPoint`, `sessionEntryToContextMessages`, `convertToLlm`, or `serializeConversation` helpers skip optional boundary compaction and retain the host's native compaction policy.

## Interactive TUI

The lightning savings treatment uses Pi 0.85.1's public `renderCall`,
`renderResult`, `ctx.ui.notify()`, and keyed `ctx.ui.setStatus()` APIs. It checks
`ctx.mode === "tui"` rather than `ctx.hasUI`, because RPC mode also reports UI
support. The renderer therefore changes only the interactive terminal display;
it does not change session messages, provider requests, tool results, JSON
events, print output, or RPC UI requests.

## Test doubles

The test suite drives every extension through the same public `ExtensionAPI` and `ExtensionContext` surface Pi provides, over a real public `SessionManager`, without calling a remote model provider. That keeps the suite zero-spend and independent of the deleted Pi monorepo test harness. Suites that need a genuine session tree — branch order, compaction entries, custom entries, resume — use `SessionManager.inMemory()` or `SessionManager.create()` rather than reimplementing them.

`tests/pi-package-integration.test.ts` loads the actual TypeScript entrypoint through Pi's `DefaultResourceLoader`, reads a trusted all-enabled project configuration, and executes a fused write/command and a plan update in a real `AgentSession`. `tests/online-context-compact-agent-session.test.ts` verifies one and two consecutive native compactions and waits for automatic continuation before the original prompt returns. These integration tests use Pi's deterministic faux provider; they verify runtime compatibility, not live provider authentication or token savings.

The earlier 0.84.2 backward-compatibility run used an isolated copy of the then-current source and tests, separate dependencies, and an empty Pi agent directory. Only the copy's four Pi development dependency versions, lockfile, and installation-guide version mentions changed. No source or test changes were needed. The run included all four mechanisms and the native compaction/continuation integration tests; it did not repeat live-provider benchmarks on 0.84.2.

## Windows compatibility

Action Fusion's `then_run` commands require Bash on Windows, available through Git for Windows. Its file paths support `~\` home expansion consistently with Pi's built-in tools; no additional SoL-Pi configuration is required.

When reusing or recalling an observation, ObservationPack rejects a symbolic link before opening it and checks the opened file's identity. Native `O_NOFOLLOW` remains enabled where available. The additional `lstat()` and file-handle `stat()` run on all platforms; these checks add filesystem I/O and are not an atomic defense against processes that can replace parent directories or modify file contents.

Windows archive confidentiality depends on the session directory's inherited ACLs; SoL-Pi does not provision Windows ACLs.

The real `AgentSession` regression suite also checks repeated post-compaction plan imports with unchanged and renamed step ids. Imported completed steps do not create new boundaries; subsequent observed completion transitions still compact and settle within the original prompt invocation.

The [real-provider verification](research/2026-09-30-fixes-validation.md) additionally exercises Pi 0.85.1's public SDK with all four mechanisms enabled, actual tool execution, branch navigation, native summaries, and EPR calls to a configured model. It validates behavior on synthetic fixtures, not production savings or compatibility with newer Pi releases. The current pinned dependency audit reports a high-severity transitive `undici` finding; the managed installation gate remains unsatisfied.
