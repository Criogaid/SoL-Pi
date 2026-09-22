# Upstream PR status

This file tracks how the local `main` branch relates to pull requests in the direct upstream repository, [NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi).

Last reviewed: 2026-09-22

- Upstream main: `1559b5c0` (`origin/main`)
- Local review base: `4f48621`
- Supported Pi scope: `@earendil-works/pi-coding-agent >=0.84.2 <0.86.0`
- `Included` means the behavior is present locally. It does not imply that the upstream merge commit is an ancestor of local `main`.
- Update the pinned head and rationale whenever a PR changes materially or its upstream state changes.

## Latest upstream merges

| Upstream PR | Upstream merge | Local status | Follow-up |
| --- | --- | --- | --- |
| [#61](https://github.com/NVlabs/SoL-Pi/pull/61) | `a7f99a8` | Included independently | No code follow-up. Local config normalization trims the same route identifiers through the shared config-value parser. |
| [#9](https://github.com/NVlabs/SoL-Pi/pull/9) | `440ec56` | Included independently | No code follow-up. Local path normalization and regression coverage include the upstream Unicode-space behavior. |
| [#35](https://github.com/NVlabs/SoL-Pi/pull/35) | `1559b5c` | Included independently | No code follow-up. Local code already composes Windows drive, Unicode-space, home, and file-URL normalization. |

Merging these three upstream merge commits directly produces conflicts in shared config and Action Fusion files. The local implementations already cover their behavior and tests, so the merge commits are not replayed solely to reproduce ancestry.

## PR ledger

| PR | Pinned head | Upstream state | Local decision | Rationale |
| ---: | --- | --- | --- | --- |
| [#3](https://github.com/NVlabs/SoL-Pi/pull/3) | `c0f7521` | Merged | Baseline | Renderer assertion fix was already in the reviewed baseline. |
| [#4](https://github.com/NVlabs/SoL-Pi/pull/4) | `6f74efc` | Merged | Baseline | File-URL target preservation was already in the reviewed baseline. |
| [#6](https://github.com/NVlabs/SoL-Pi/pull/6) | `b0e62bc` | Open | Included | Actual removable-prefix pricing is part of the validated OCC set. |
| [#8](https://github.com/NVlabs/SoL-Pi/pull/8) | `972480d` | Open | Included | Verified receipt reuse is part of the validated EPR set. |
| [#9](https://github.com/NVlabs/SoL-Pi/pull/9) | `8c46b76` | Merged | Included | Unicode-space path normalization is present locally; see the upstream-merge table. |
| [#13](https://github.com/NVlabs/SoL-Pi/pull/13) | `c4c19d6` | Open | Included | Branch-scoped Observation Pack send counts were integrated with transactional ledger updates. |
| [#14](https://github.com/NVlabs/SoL-Pi/pull/14) | `b073a42` | Open | Included | Literal archived-observation search is present with bounded output and batched ledger writes. |
| [#15](https://github.com/NVlabs/SoL-Pi/pull/15) | `63e73e8` | Open | Not included: superseded | #56 supplies the bounded peer range and passed compatibility checks. |
| [#17](https://github.com/NVlabs/SoL-Pi/pull/17) | `3a12a63` | Open | Not included: deferred | Optional trajectory UI lacked authorized interactive/operator validation and overlaps #14. |
| [#18](https://github.com/NVlabs/SoL-Pi/pull/18) | `f1a2244` | Merged | Baseline | Star-history workflow change was already upstream. |
| [#19](https://github.com/NVlabs/SoL-Pi/pull/19) | `ad1fe60` | Merged | Baseline | Star-history layout restoration was already upstream. |
| [#23](https://github.com/NVlabs/SoL-Pi/pull/23) | `bdcd78d` | Open | Not included: deferred | Diagnostic UX lacked an operator and real closed-loop validation. |
| [#24](https://github.com/NVlabs/SoL-Pi/pull/24) | `22e5fe0` | Closed | Not included: superseded | #57 provides stricter portable storage checks without the best-effort fallback. |
| [#26](https://github.com/NVlabs/SoL-Pi/pull/26) | `f0d7102` | Open | Included | Trailing-newline line counting is part of the validated EPR set. |
| [#27](https://github.com/NVlabs/SoL-Pi/pull/27) | `b73c99a` | Open | Included | Cargo diagnostic-command restriction is part of the validated EPR set. |
| [#28](https://github.com/NVlabs/SoL-Pi/pull/28) | `ae58e2b` | Open | Included | Secret detection is part of the validated EPR trust boundary. |
| [#29](https://github.com/NVlabs/SoL-Pi/pull/29) | `3414a30` | Open | Included: partial | Kept missing-session fail-open with one warning per session; retained hard failure for unsafe session IDs. |
| [#30](https://github.com/NVlabs/SoL-Pi/pull/30) | `6088d36` | Open | Not included: superseded | #64 bounds reads while retaining stricter full-log validation. |
| [#31](https://github.com/NVlabs/SoL-Pi/pull/31) | `d3100b6` | Open | Included | Single-line placeholder excerpts are part of the validated Observation Pack set. |
| [#32](https://github.com/NVlabs/SoL-Pi/pull/32) | `f5571f9` | Open | Included | Bounded plan progress is part of the validated OCC set. |
| [#33](https://github.com/NVlabs/SoL-Pi/pull/33) | `1201100` | Open | Included | Projection optimization passed an independent 2 MiB benchmark. |
| [#34](https://github.com/NVlabs/SoL-Pi/pull/34) | `332bc4d` | Open | Included | UTF-8 offset alignment is part of the validated Observation Pack set. |
| [#35](https://github.com/NVlabs/SoL-Pi/pull/35) | `4b5f09b` | Merged | Included | Windows shell-path normalization is present locally; pinned head updated after upstream conflict resolution. |
| [#47](https://github.com/NVlabs/SoL-Pi/pull/47) | `2565836` | Open | Included | Distinct nonblank failure evidence is part of the validated EPR set. |
| [#49](https://github.com/NVlabs/SoL-Pi/pull/49) | `f083f88` | Open | Not included: deferred | No second supported reduced-export host was available for independent validation. |
| [#50](https://github.com/NVlabs/SoL-Pi/pull/50) | `ac2ac9f` | Open | Not included: rejected | The broad hardening conflicted with the baseline and retained a Windows package regression. |
| [#51](https://github.com/NVlabs/SoL-Pi/pull/51) | `bcc9d3e` | Merged | Baseline | README/example-config clarification was already upstream. |
| [#52](https://github.com/NVlabs/SoL-Pi/pull/52) | `980fef8` | Open | Included | Missing mutation paths now fail with a tool-visible validation error. |
| [#53](https://github.com/NVlabs/SoL-Pi/pull/53) | `bb88769` | Merged | Baseline | Blog paper/code link was already upstream. |
| [#54](https://github.com/NVlabs/SoL-Pi/pull/54) | `d53eff1` | Open | Not included: rejected | Provider registration changes ownership outside the extension boundary. |
| [#56](https://github.com/NVlabs/SoL-Pi/pull/56) | `c0e872a` | Open | Included | Bounded Pi peer policy passed package and compatibility checks. |
| [#57](https://github.com/NVlabs/SoL-Pi/pull/57) | `eec41aa` | Open | Included | Portable Observation Pack storage guards are part of the validated set. |
| [#58](https://github.com/NVlabs/SoL-Pi/pull/58) | `61f1283` | Open | Not included: rejected | It regressed repeated reducer archive reuse where atomic no-follow reads are unavailable. |
| [#59](https://github.com/NVlabs/SoL-Pi/pull/59) | `db582d4` | Open | Included | Bounded plan grammar is part of the validated OCC set. |
| [#60](https://github.com/NVlabs/SoL-Pi/pull/60) | `b1173e4` | Open | Included | Action Fusion reports savings only after successful follow-up execution. |
| [#61](https://github.com/NVlabs/SoL-Pi/pull/61) | `2415cdd` | Merged | Included | Route normalization is present locally; see the upstream-merge table. |
| [#62](https://github.com/NVlabs/SoL-Pi/pull/62) | `a3b0d3c` | Open | Included | Cumulative cache debt is part of the validated OCC state model. |
| [#63](https://github.com/NVlabs/SoL-Pi/pull/63) | `049aeac` | Merged | Baseline | Pi 0.85.1 and 0.84.2 compatibility policy was already upstream. |
| [#64](https://github.com/NVlabs/SoL-Pi/pull/64) | `eba3d8e` | Open | Included | Bounded diagnostic reads and full-log validation are part of the validated EPR set. |
| [#69](https://github.com/NVlabs/SoL-Pi/pull/69) | `4f8c310` | Open | Included | Batched ledger writes are integrated with branch-count commit semantics. |
| [#71](https://github.com/NVlabs/SoL-Pi/pull/71) | `27a85ce` | Open | Included | Request-horizon state reset is part of the validated OCC set. |
| [#72](https://github.com/NVlabs/SoL-Pi/pull/72) | `3e85e52` | Open | Included | Full context is retained whenever recall is inactive. |
| [#74](https://github.com/NVlabs/SoL-Pi/pull/74) | `d7b94a1` | Merged | Baseline | README arXiv link was already upstream. |
| [#75](https://github.com/NVlabs/SoL-Pi/pull/75) | `d2d78ea` | Merged to `gh-pages` | Not applicable to `main` | Documentation-site-only change; tracked here for completeness. |
| [#77](https://github.com/NVlabs/SoL-Pi/pull/77) | `3cfd447` | Open | Included | Explicit Action Fusion `bashOptions.shellPath` forwarding is present locally. |
| [#79](https://github.com/NVlabs/SoL-Pi/pull/79) | `b1cc23d` | Open | Not included: deferred | Pi 0.84.2–0.85.1 declares `getSystemPrompt(): string`; no supported array-returning host was independently demonstrated. Upstream and local adapted tests pass. |
| [#80](https://github.com/NVlabs/SoL-Pi/pull/80) | `d4ab9e4` | Open | Not included: deferred | Supported Pi validates registered tool arguments before `execute`; no supported host that skips this boundary was independently demonstrated. Upstream and local application tests pass. |
| [#81](https://github.com/NVlabs/SoL-Pi/pull/81) | `c52641e` | Open | Not included: superseded | Local #29 integration already fails open for ephemeral context while retaining unsafe-session-ID rejection. The remaining recall error normalization is not material enough to duplicate the change. |
| [#82](https://github.com/NVlabs/SoL-Pi/pull/82) | `8e8bef9` | Open | Reviewed: recommend adapted inclusion | It fixes a real gap for Pi-managed `shellPath`, but local integration must retain the injectable bash factory added after the PR base. Upstream and adapted local tests pass. |

## Review evidence for PRs #79–#82

- Each pinned upstream head passed `npm run typecheck` and its focused upstream test. #81's two additional failures in the complete Observation Pack file were the known Windows symlink-permission limitation; both new in-memory tests passed separately.
- Disposable local-application worktrees passed typecheck and focused tests for all four reviews. These worktrees are review evidence only; no product change was merged.
- Official Pi 0.85.1 validates registered tool arguments before execution, and its public `ExtensionContext.getSystemPrompt()` type returns `string`.
- PR #82 uses public `SettingsManager` and `getAgentDir` exports available in both tested Pi versions; its local application conflicts only with the later injectable bash-factory boundary.
