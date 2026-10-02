# Pi Compatibility

SoL-Pi is developed and tested against `@earendil-works/pi-coding-agent` 0.99.2. The runtime range is expressed as a peer dependency because Pi owns installation and upgrade of its packages. Earlier release checks do not establish compatibility with the current source.

SoL-Pi declares Pi package peers at `>=0.99.0 <0.100.0`; the full suite runs against the pinned 0.99.2 development dependencies. SoL-Pi imports only public package exports:

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

Pi 0.99 passes `ExtensionToolContext` to tool execution and reports a nonzero Bash exit through `AgentToolResult.isError`. Action Fusion translates that result into its existing `then_run` failure contract, preserving the completed mutation and reporting the command output.

Action Fusion decodes `file://` targets with Node's `fileURLToPath()` before resolving the queue and hash-check path. This keeps file URLs, including percent-encoded filenames and Pi's optional `@` prefix, aligned with the file handled by the built-in mutation tool.

On Windows it applies the same drive-path conversion Pi's own resolver applies, so Git Bash, MSYS, Cygwin, and WSL targets such as `/c/src/app.ts` and home-relative `~\` paths resolve to the file the built-in mutation tool wrote. On other platforms those inputs keep their POSIX meaning.

The queue covers only fused operations registered by this SoL-Pi instance. External processes, direct built-in-tool calls outside the replacement, and unrelated extensions are not globally locked. SoL-Pi hashes the target immediately before launching `then_run` and skips the command if it observes an intervening content change.

## ObservationPack

ObservationPack changes only the messages projected through the public `context` event. Stored session history remains intact. Original bytes and the JSONL ledger live under the session-derived SoL-Pi directory.

The directory returned by Pi's `SessionManager.getSessionDir()` is the trusted storage boundary; Pi's session directory and its ancestors must remain under the user's control. ObservationPack checks the final object directory when storing a result and rejects symbolic links at the object path before reading or reusing it.

Object access uses `O_NOFOLLOW` where available and compares the opened handle with the path's pre-open identity. These object checks are not an atomic defense against processes replacing parent directories. This filtered branch does not include the later descendant-directory-chain checks.

## Evidence-Preserving Reducer

The reducer handles public `tool_result` events and resolves the configured reducer provider/model through Pi's model registry before calling `ExtensionContext.modelRegistry.complete()`. Pi owns request-time authentication and provider dispatch. The reducer preserves the original result whenever the configured reducer model is unavailable or eligibility, model-call, schema, source-hash, exact-quote, size, or likely-secret checks fail.

All persistent paths use `SessionManager.getSessionDir()` and `getSessionId()`, which are public in Pi 0.99.2. If the session directory is empty (`--no-session` or `SessionManager.inMemory()`), SoL-Pi lazily creates a private `sol-pi-<session-id>-<random>/` directory under `os.tmpdir()`. Its path is reused by session ID across contexts and both archiving mechanisms while the extension is loaded. These files remain available after worker shutdown for callers that need to read evidence; cleanup is left to the host or caller. SoL-Pi creates no configurable storage-path surface.

The unpublished shared artifact layout is not read or migrated. Each persistent session starts from its own `<sessionDir>/sol-pi/<sessionId>/` directory; ephemeral sessions use the temporary fallback above.


## Online Context Compact

Online Context Compact uses ordinary public `context` and `before_provider_request` handlers instead of fork-only post-transform observer methods. Public handlers run in extension load order, so the SoL-Pi entrypoint registers Online Context Compact after its other context transformers. A third-party transformer loaded later is outside the context-growth observation used by its estimate.

Pi does not expose its active retained-tail compaction setting through the public extension context. The standalone extension therefore uses the Pi 0.99.2 default of 20,000 tokens for its economic estimate. Its programmatic factory accepts an explicit matching value for a non-default Pi setting.

Pi's `ExtensionContext.compact()` aborts an active agent before summarizing and does not automatically resume the interrupted turn. After a completed `update_plan`, Online Context Compact checks the finalized tool batch at `turn_end`, including tool success and cancellation, before selecting compaction. It saves plan and progress state, calls `ExtensionContext.abort()` to stop the run, and runs native compaction from the resulting `agent_settled`. The handler awaits the compaction's `onComplete`/`onError` callback. On success, a hidden `ExtensionAPI.sendMessage()` reminder with `triggerTurn: true` starts a new turn against the compacted context so the model rebuilds the plan.

Pi 0.99.2 defers turns requested from `agent_settled` until all handlers return, then awaits those turns before the original prompt resolves. The SoL-Pi handler yields after queuing its continuation. A continuation is armed after successful boundary compaction or a known rejection before a replacement summary is committed (nothing to compact, already compacted, or incomplete summary). Rejections retain the original context and clear pending debt immediately; successful non-plan tool work or new input is required before retrying. Cancellation and exit do not schedule a continuation, and unknown failures propagate. Settlement diagnostics mark recovery continuations with `compaction: "skipped"`.

`sendMessage()` returns no continuation promise. Real `AgentSession` tests verify that one and two consecutive compact-and-continue cycles finish before the original prompt returns on Pi 0.99.2. An intentional `abort()` can leave an empty error/aborted assistant entry; the extension does not rewrite that record or filter unrelated empty assistant messages. Later-loaded extensions with long asynchronous `agent_settled` handlers require their own integration checks.

Pi reports the session as idle while an extension-requested manual compaction is running. SoL-Pi cancels `session_before_tree` during that interval to prevent tree navigation from moving the active leaf underneath the compaction. Navigation works normally after the compaction callback settles.

The compaction cut-point and projection adapter stays in `online-context-compact/extension.ts`. It maps only observed messages to active source entries, including the last compaction summary, without rerunning context hooks. Raw summarizer input remains separate from provider-visible savings. Successful compaction preserves the current plan; replaying completed steps produces no new completion transition. The persisted v1 state accepts older entries without `lastCompactionRequestCount`, treating their cooldown baseline as unknown.

Online Context Compact reads `ExtensionContext.getContextUsage()` for both the context window and the provider-counted context size. When Pi reports no size — as it does between a compaction and the next answered request — the boundary falls back to its own estimate.

The standalone entry passes `cacheWriteReadRatio` from `sol-pi.json` into Online Context Compact's cache-rebuild check. Pi model price metadata estimates summary cost in cache-read token equivalents. The configured ratio stays fixed; use a new session for a different model/pricing policy. Missing summary prices defer economic compaction while leaving window protection active. Hosts missing the public `findCutPoint`, `sessionEntryToContextMessages`, `convertToLlm`, or `serializeConversation` helpers skip optional boundary compaction and retain the host's native compaction policy.

## Interactive TUI

The lightning savings treatment uses Pi 0.99.2's public `renderCall`,
`renderResult`, `ctx.ui.notify()`, and keyed `ctx.ui.setStatus()` APIs. It checks
`ctx.mode === "tui"` rather than `ctx.hasUI`, because RPC mode also reports UI
support. The renderer therefore changes only the interactive terminal display;
it does not change session messages, provider requests, tool results, JSON
events, print output, or RPC UI requests.

## Test doubles

The test suite drives every extension through the same public `ExtensionAPI` and `ExtensionContext` surface Pi provides, over a real public `SessionManager`, without calling a remote model provider. That keeps the suite zero-spend and independent of the deleted Pi monorepo test harness. Suites that need a genuine session tree — branch order, compaction entries, custom entries, resume — use `SessionManager.inMemory()` or `SessionManager.create()` rather than reimplementing them.

`tests/pi-package-integration.test.ts` loads the actual TypeScript entrypoint through Pi's `DefaultResourceLoader`, reads a trusted all-enabled project configuration, and executes a fused write/command and a plan update in a real `AgentSession`. `tests/online-context-compact-agent-session.test.ts` verifies one and two consecutive native compactions and waits for automatic continuation before the original prompt returns. These integration tests use Pi's deterministic faux provider; they verify runtime compatibility, not live provider authentication or token savings.


## Windows compatibility

Action Fusion's `then_run` commands require Bash on Windows, available through Git for Windows. Its file paths support `~\` home expansion consistently with Pi's built-in tools; no additional SoL-Pi configuration is required.

When reusing or recalling an observation, ObservationPack rejects a symbolic link before opening it and checks the opened file's identity. Native `O_NOFOLLOW` remains enabled where available. The additional `lstat()` and file-handle `stat()` run on all platforms; these checks add filesystem I/O and are not an atomic defense against processes that can replace parent directories or modify file contents.

Windows archive confidentiality depends on the session directory's inherited ACLs; SoL-Pi does not provision Windows ACLs.

The real `AgentSession` regression suite also checks repeated post-compaction plan imports with unchanged and renamed step ids. Imported completed steps do not create new boundaries; subsequent observed completion transitions still compact and settle within the original prompt invocation.

The earlier [real-provider verification](research/2026-09-30-fixes-validation.md) exercised Pi 0.85.1's public SDK with all four mechanisms enabled. It remains historical evidence; live-provider validation has not been repeated for Pi 0.99.2.

## Dependency security

The root manifest overrides `brace-expansion` to its patched version. The root lockfile omits Pi's `hasShrinkwrap` flag so npm applies that override instead of reinstalling the version in Pi's published shrinkwrap. Keep both changes together: editing the resolved version alone can make lockfile audit pass while `npm ci` still installs vulnerable files. Verify the installed dependency with `npm ls brace-expansion --all` after a clean install.

These resolutions apply to this checkout. They do not update a separately installed Pi CLI or another project's dependency tree.

## Pi 0.99 API reuse assessment

This assessment uses the installed 0.99.2 public declarations and implementation. Action Fusion uses `ExtensionToolContext` and interprets `AgentToolResult.isError` to preserve command-failure reporting. EPR uses the required `ModelRegistry.find()` and `complete()` methods directly; the pre-0.99 fork authentication adapter is outside the supported peer range and has been removed.

`ExtensionToolContext.executeTool()` runs nested calls through validation, hooks, and permissions and attaches nested-call metadata. Replacing Action Fusion's built-in Bash definition with it would change event delivery and could run reducers or diagnostics twice. The existing direct invocation preserves the current tool-result contract.

`agent_before_settle` and actionable `turn_end` results can commit boundary entries and request continuation. Calling the current native `compact()` path inside an awaited boundary handler is unsuitable: compaction aborts the agent and waits for idle while the agent is waiting for that handler. Replacing it with draft compaction entries would also require reimplementing native summarization and lifecycle behavior. OCC therefore retains its tested `agent_settled` continuation path.

Pi's public file-mutation queue does not replace Action Fusion's queue: the latter covers both the mutation and its follow-up command, while built-in mutation tools acquire their own queue internally. Nesting those operations under the same queue can deadlock.
