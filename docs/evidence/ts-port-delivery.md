# ASF-TS portable workflow delivery

Delivery date: 4 October 2026. Upstream baseline: `bd82062e27407e6cec6799ef22d632a123186d33`. Port reference: [Python PR #21](https://github.com/asmelkowski/asf/pull/21), head `5f6cd638cd7134b2e959861eb2ae2849fd30a181`.

The [TS analysis and design](../designs/ts-port.md) maps Python features to the existing TS runtime. The port retains ordinary async TypeScript, native Codex/OpenCode sessions, immutable accounting, supervised self-improvement and the original inspector. Portable files add an optional authoring layer over the same reservation and receipt boundary.

## Ticket acceptance

The table maps upstream tickets to implementation, design and plan evidence. All feature tickets remain open until upstream accepts the final integration PR. [Roadmap #1](https://github.com/asmelkowski/asf-ts/issues/1) tracks the delivery and deferred frameworks.

| Ticket                                                 | Delivered behavior                                                                                       | Reviewed smaller PRs                                                                           | Design and plan                                                                                                                                    |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#2](https://github.com/asmelkowski/asf-ts/issues/2)   | Typed children, durable ancestry, explicit attempts, ancestor quotas/deadlines and cancellation          | [5](https://github.com/Kordikk/asf-ts/pull/5)                                                  | [Child design](../designs/child-workflows.md), [plan](../plans/child-workflows.md)                                                                 |
| [#3](https://github.com/asmelkowski/asf-ts/issues/3)   | Optional personas resolved against explicit local capabilities; child defaults and strict requirements   | [2](https://github.com/Kordikk/asf-ts/pull/2)                                                  | [Profile design](../designs/profiles.md), [plan](../plans/profiles.md)                                                                             |
| [#4](https://github.com/asmelkowski/asf-ts/issues/4)   | Frozen Git candidate, fixed checks, fresh reviewer and current-byte acceptance across cached parents     | [9](https://github.com/Kordikk/asf-ts/pull/9)                                                  | [Candidate design](../designs/candidate-verification.md), [plan](../plans/candidate-verification.md)                                               |
| [#5](https://github.com/asmelkowski/asf-ts/issues/5)   | Strict YAML/JSON, schema/reference validation, closure identity and equivalent file/generated execution  | [4](https://github.com/Kordikk/asf-ts/pull/4), [6](https://github.com/Kordikk/asf-ts/pull/6)   | [Portable design](../designs/portable-files.md), [plan](../plans/portable-files.md)                                                                |
| [#6](https://github.com/asmelkowski/asf-ts/issues/6)   | Finite repeats and all/any joins with exact branch scopes, cancellation and sibling draining             | [5](https://github.com/Kordikk/asf-ts/pull/5), [6](https://github.com/Kordikk/asf-ts/pull/6)   | [Child design](../designs/child-workflows.md), [portable plan](../plans/portable-files.md)                                                         |
| [#7](https://github.com/asmelkowski/asf-ts/issues/7)   | Full-contract SVGs, deterministic closure bundles, tamper checks and recipient support reports           | [6](https://github.com/Kordikk/asf-ts/pull/6), [12](https://github.com/Kordikk/asf-ts/pull/12) | [Portable design](../designs/portable-files.md), [plan](../plans/portable-files.md), [ADR 0011](../adr/0011-render-complete-portable-contracts.md) |
| [#8](https://github.com/asmelkowski/asf-ts/issues/8)   | Actual optional ADK SDK Runner/model/tool/graph proof and three-target portable conformance              | [3](https://github.com/Kordikk/asf-ts/pull/3), [7](https://github.com/Kordikk/asf-ts/pull/7)   | [ADK design](../designs/adk.md), [plan](../plans/adk.md)                                                                                           |
| [#9](https://github.com/asmelkowski/asf-ts/issues/9)   | Visual block/profile/schema editing, shared validation, invalid-draft handling and JSON/YAML round trips | [8](https://github.com/Kordikk/asf-ts/pull/8)                                                  | [Studio design](../designs/studio.md), [plan](../plans/studio.md), [browser evidence](studio.md)                                                   |
| [#10](https://github.com/asmelkowski/asf-ts/issues/10) | Declared edges with exact recorded child/action/receipt mappings and bounded accounting inspection       | [11](https://github.com/Kordikk/asf-ts/pull/11)                                                | [Inspection design](../designs/declared-inspection.md), [plan](../plans/declared-inspection.md), [browser evidence](declared-inspection.md)        |
| [#11](https://github.com/asmelkowski/asf-ts/issues/11) | Native-export assessment; outside-UI ASF driver generation is the supported execution output             | [7](https://github.com/Kordikk/asf-ts/pull/7)                                                  | [ADR 0008](../adr/0008-native-export-assessment.md), [portable plan](../plans/portable-files.md)                                                   |

The later [UI follow-up ticket #13](https://github.com/asmelkowski/asf-ts/issues/13) adds a default dark theme, distinct blocks, branch sibling placement and direct canvas movement. See its [acceptance record](studio-modernization.md) and [design](../designs/studio-modernization.md).

[Foundation PR 1](https://github.com/Kordikk/asf-ts/pull/1) records the design, dependency/platform choices and offline CI. [PR 10](https://github.com/Kordikk/asf-ts/pull/10) removes host scheduling from two persisted-deadline regression fixtures; it changes no production deadline behavior. All smaller PRs target `Kordikk/asf-ts:integration/portable-workflows` because the current account has read access to upstream. See [ADR 0003](../adr/0003-delivery-topology.md).

The shared [runtime/roles](../plans/runtime-and-roles.md), [candidate/ADK](../plans/candidate-and-adk.md) and [editor/inspection](../plans/editor-and-inspection.md) plans combine the port design with specialist designs. The design-to-plan relationship is many-to-many. New technical documents use the [Google developer documentation style decision](../adr/0001-document-style.md).

## Validation evidence

Final production source under review: `1f7dbb2d30cd0d9ee6962cfe875c15a146338bbc`. Independent Standards and Spec reviews cleared the final renderer delta. Actual Chromium rendering confirmed visible, distinct branch labels when both ports share a target. Seven renderer/file tests passed at that exact revision.

The complete local `npm run check` at predecessor `ec8575ade842b7b68365f783b27aeaa380e5fb31` passed type checks, lint, formatting, build and **242 tests**, with **zero failures and two opt-in lifecycle skips**. The final Linux [push CI](https://github.com/Kordikk/asf-ts/actions/runs/37195648389/job/111416830518) and [PR CI](https://github.com/Kordikk/asf-ts/actions/runs/37195650248/job/111416836079) passed the same complete gate at `1f7dbb2d30cd0d9ee6962cfe875c15a146338bbc`, including the later branch visibility fix. Both checks were successful before merge.

The skips are installed-native-CLI probes controlled by `ASF_TEST_CODEX` and `ASF_TEST_OPENCODE`. Normal CI does not opt into them. Codex/OpenCode portable conformance uses injected official SDK seams; ADK conformance uses the actual pinned SDK with deterministic local models and tools. No paid provider qualification, invoice completeness or restored unfinished native checkpoint is claimed. Dependency audit on 4 October 2026 reported zero vulnerabilities.

| Browser check      | Observed result                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original inspector | Built/source/served parity; scope/session/turn selection, live polling, bounded paging, literal content, mobile/keyboard and unresolved costs passed                        |
| Studio             | All eight block forms, typed children, profiles, layouts, invalid drafts, stale response rejection and actual JSON/YAML download/reimport passed                            |
| Declared graph     | Exact ancestry and receipt IDs, corrections, completed business rejection, unchanged replay counts, uncertain-send subtotal, independent windows and focused queries passed |

These three actual Playwright checks ran against built assets at source `27b64cebdf662c811510ead6c72d3151b3c68721` on 4 October 2026, using Chromium `141.0.7390.37`. The graph report timestamp is `2026-10-04T10:07:56.746Z`. At that delivery snapshot, the source/build/served assets matched. The later [Studio modernization acceptance](studio-modernization.md) records the updated UI assets and preserved behavior. Fixtures used synthetic or ephemeral SQLite stores, scripted native receipts and local callbacks. Browser checks made no external provider requests, read no private native sessions and dispatched no work through inspection. Studio validation did not write run/event rows.

Reproduce from the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm audit
# Install the pinned browser once if it is not cached:
npx playwright install chromium
npm run verify:ui -- --quick
npx tsx scripts/verify-studio.ts
npx tsx scripts/verify-graph.ts
```

Local browser artifacts are ignored under `.asf/ui-verification/`, `.asf/studio-verification/` and `.asf/graph-verification/`. Historical live-provider evidence retained from the TS baseline is separate and does not qualify this delivery's SDK pins.

## Product decisions and operating bounds

| Decision                        | Reason and recorded boundary                                                                                                                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TS-specific format and identity | Preserve the TS runtime/ABI and adapt Python semantics explicitly; [ADR 0002](../adr/0002-ts-port-boundary.md) and [ADR 0007](../adr/0007-portable-hashes-and-recipient-code.md)                                                                                                         |
| Data-only Studio                | UI edits and validates; CLI/library generates, renders, bundles, runs and resumes; [ADR 0202](../adr/0202-studio-data-boundary.md)                                                                                                                                                       |
| Trusted recipient bindings      | Files cannot grant adapter capabilities or carry credentials; executable entry hashes bind reviewed code, while recipients own transitive dependency revisions; [ADR 0004](../adr/0004-portable-data-and-trust.md) and [ADR 0007](../adr/0007-portable-hashes-and-recipient-code.md)     |
| Conservative concurrency        | Portable parallel writers/commands/effectful components reject until safe isolation exists; started siblings drain; [ADR 0211](../adr/0211-workflow-limits-and-cancellation.md)                                                                                                          |
| Current candidate acceptance    | Call `requireCurrent` after the outer workflow, including cached replay, and at the consuming publication boundary; no atomic merge or publication authorization; [ADR 0122](../adr/0122-candidate-consumption.md)                                                                       |
| Optional ADK proof              | Pin `@google/adk@2.2.0`; test its actual SDK on Node 22.22.3. ADK remains write-only and native cancellation is cooperative; [ADR 0120](../adr/0120-adk-model-boundary.md), [ADR 0121](../adr/0121-adk-accounting.md) and [ADR 0005](../adr/0005-offline-platform-and-adk-dependency.md) |
| One generated execution engine  | Generate ASF TypeScript drivers instead of a second native compiler; full native export and other agentic frameworks remain deferred; [ADR 0008](../adr/0008-native-export-assessment.md)                                                                                                |

Use the [portable guide](../portable.md) for the file pipeline and local UI. This delivery adds no hosted editor, provider credential manager, process sandbox, automatic publication or hard invoice cap. Unknown accounting remains unresolved, and uncertain effects are not automatically repeated.
