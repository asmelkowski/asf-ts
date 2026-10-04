# Agent guidance

## Current delivery scope

The user authorized the 2026-10-04 port of Python PR #21 to ASF-TS, including optional portable graphs, visual authoring, Google ADK proof, tests, documents, commits, feature PRs, self-review and merges into an integration branch. Work in the task checkout and its worktrees. This scope supersedes the historical path, no-graph/UI, and no-publication restrictions below. Keep credential, private-session, accounting, and separately authorized live-model boundaries. See `docs/designs/ts-port.md`.

## Historical boundaries and authorization

- Work only in `/root/asf-ts`. `/root/asf` (including untracked `typescript/`) is read-only reference; never copy it wholesale.
- The user authorized v1 implementation, tests, CI, documentation, and offline qualification. The previous documentation-only restriction is superseded.
- Do not commit, publish, inspect credentials/private native sessions, change auth/global services/user configuration, or run live model tasks without separate explicit approval.
- `npm run check` is account-free. The opt-in private-server lifecycle test uses empty temporary HOME/XDG directories and sends no prompt. The live qualification runner is **not** an offline check.

## Design invariants

- Ordinary async functions, reusable agent objects, explicit action IDs, `Promise.all`. No graph/DSL, broker, UI framework, councils, or replay engine.
- Durable reservation before dispatch; raw receipt/accounting before output validation. Never automatically resend uncertain sends (including commands), retry native failures, or redo work for accounting.
- Mandatory immutable accounting is separate from lossy, opt-in content tracing. Unknown/pending costs are null/unresolved, not zero. “Complete” is relative to the stated scope, never invoice completeness.
- Preserve native session ownership, policy/model/workdir binding, and compare-and-swap baselines. Do not import or externally use ASF-owned sessions.
- Pin and source-check exact SDK/CLI protocols. OpenCode beta uses the matching official HTTP client plus an owned private server; its embedded SDK package is not Node-compatible.
- Keep typed correction bounded and same-session. Validate request identity on resume. New adapters implement `Harness` and the shared contract tests.
- SQLite is authoritative. Events are observations in commit order, not cross-agent causality. Results/events/native sessions are sensitive and untrusted; no redaction guarantee.

## Checks

`npm ci --ignore-scripts && npm run check`

Optional **non-model**, isolated installed-CLI lifecycle check:

`ASF_TEST_OPENCODE="$(command -v opencode2)" npx tsx --test test/opencode-lifecycle.test.ts`

Read `docs/design.md`, `docs/sdk-qualification.md`, and `docs/live-qualification.md` before changing safety/accounting boundaries. Never put the live runner in CI.
