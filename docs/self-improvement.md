# Trusted self-improvement workflow

For an existing candidate that needs fixed checks and independent review, use
the reusable [candidate verification child](designs/candidate-verification.md).
It has standalone and two-parent examples. The self-improvement flow below
keeps its existing writer, repair, scope, and native-session behavior; both flows
reuse the same bounded check-evidence projection.

Preparation plumbing only; no native-error fix or live qualification is included.
`examples/self-improvement.ts` exports the ordinary
`workflow(runtime, input, agents)` function. Reuse agent configs named `worker`
and `reviewer` from the existing JSON config reader, with explicit models/prices.
The workflow selects write/read-only modes respectively; review starts a fresh
session. Importing the workflow or asking the CLI for help is inert.

Task JSON:

```json
{
  "task": "Implement the selected, separately authorized change",
  "editFiles": ["path/to/existing.ts", "test/new-test.ts"],
  "maxRepairs": 1,
  "formatFiles": true,
  "reviewOnly": false,
  "readInstructions": "Optional repository reading guidance"
}
```

`maxRepairs` defaults to 1, accepts 0–3. `formatFiles` defaults to false; when enabled, the trusted host runs the pinned Prettier on only the scope-checked edit files before post-write checks. `reviewOnly` defaults to false; a **new run** can format/check/review an existing candidate without dispatching another writer. Use a new run ID and the same audited budget/database for such a follow-up; never override an old workflow identity or repeat a failed/uncertain native action. For implementation review, set `snapshot` in the review-only task to the original writer's snapshot descriptor (its returned `snapshot`, or JSON parsed from the durable `baseline/snapshot` command result’s `stdout`). The helper verifies the immutable artifact hash and exact edit-file allowlist, then supplies the complete original-baseline-relative patch plus checked scope/size evidence. No native session is imported or reused. Without `snapshot`, review-only captures the existing candidate as a new baseline, so its patch describes only optional formatting—not the implementation. These modes do not apply, stage or commit patches.

Paths are explicit, regular source
files (1–20); no ignored files, dot-path edits, deletions, renames or mode changes.
Only ordinary command-check failures get same-coder-session repair. Native,
accounting, uncertain-command, cancellation and scope failures escape immediately.
Typed read-only review allows one same-session format correction, not another
implementation attempt. Rejected review is nonacceptance.

## Opt-in execution

Use Node **22.22.x** (tested 22.22.3, npm 10.9.8). After a separate allowance audit,
create a private config/task and isolated repository snapshot. Preserve the
uncommitted source/index baseline, including dependency upgrades. Run fixed code
outside the target that the worker edits:

```sh
/root/asf-ts/node_modules/.bin/tsx /root/asf-ts/scripts/self-improve.ts \
  --live --config /private/agents.json --task /private/task.json \
  --cwd /isolated/repository --db /private/shared.db \
  --run explicit-run-id --budget approved-budget-id \
  --max-dispatches 100 --soft-usd 100
```

There are **no default limits, model, pricing, credential lookup or key fields**.
The displayed limits are only a command shape, not permission or an allowance
reset. Reuse the audited database/budget; Store enforces immutable limits and
unresolved-liability blocking. Old unresolved records must remain unchanged.
100 dispatches means ASF reservations, not hidden native requests. The USD gate
uses already-known estimates and is **not a hard money cap**. Output includes
nullable known subtotals, unresolved counts and cost classifications.

`npm run build` already copies the helper. A frozen build can instead run with
`node /root/asf-ts/dist/scripts/self-improve.js` and the same arguments. Do not
rebuild a frozen runner during a trial. Identity binds executing workflow,
helper, runner, runtime tree, launcher/policy, package/lock pins, Node version,
config/task paths and contents, cwd, database, trace flag and budget. Changed
code or inputs invalidate explicit resume. Repeat exactly the same command to
resume; `--live` is required even for completed replay. No automatic retry,
fallback, application of patches, staging, merging or commit is performed.
Reusable harnesses are closed by the CLI owner.

## Evidence and limits

The trusted host reserves a durable snapshot command before creating a new
ignored `.asf/self-improvement/RUN` artifact directory under the target cwd.
It retains hashes of all tracked/nonignored-untracked regular source, missing
tracked paths, HEAD/branch/index content and index flags, and copies of allowed baseline files.
Existing staged and unstaged changes are baseline, not attributed to the task.
Scope verification prevents deletions and changes outside the allowlist; adding
an allowed source is permitted. Actual bounded `git diff --no-index` patches
against those copies include new untracked tests. Symlinks, binary allowed
sources, malformed UTF-8, oversized/changing snapshots, corrupt baseline copies,
and oversized patches fail closed. Known native/private paths such as `.codex`,
`.pi`, `.env` and `.npmrc` are refused before reading if accidentally nonignored;
move private logs out of the source snapshot rather than changing ignore rules.
Limits: 5,000 paths, 1 MiB per allowed text file/copy, 64 MiB aggregate source
bytes. Larger nonallowed public assets (including videos) are content-hashed in
64 KiB chunks within that aggregate bound, not copied into baseline artifacts.
Patches are limited to 16 KiB (also at most 22 KiB serialized helper output).
Ignored native/build data is not enumerated.

Before any paid action, the host runs full `npm run check`. After writing (and
each bounded repair), it checks scope, runs argv `git diff --check` and full
`npm run check`, then captures scope/patch again. Only zero ordinary check exits
and approved review can be accepted. Runtime's stdout/stderr prefixes may be
truncated at 24 KiB/stream; **a successful check is not rejected for normal log
truncation**. The real exit, cancellation, signal and truncation evidence are
retained. Repair/review prompts select at most 3,000 bytes per captured stream:
failure-focused excerpts around retained diagnostic markers, or a failure tail
when no marker is present; success uses prefixes. Capture and selection truncation
flags are separate; full captured evidence stays in the DB and returned result.
A capture-truncated failing check without a retained diagnostic stops as
`diagnostic-unavailable`, without blind repair or rerunning the check. No test
counts or diagnostic summaries are fabricated.
Patch/source helper output must never be truncated.

A workflow-local delegating harness performs a fresh read-only source inspection
in NEW-send preflight, before Runtime reservation and before real adapter
preflight. The initial coder expects the baseline state; repair and review expect
the checked state. The expected state is recorded in each action's context/request
identity; the guard's policy identity stays stable across coder/repair so native
session binding is unchanged. Pending read-only JSON correction is guarded too.
Completed actions and retained native receipts replay without checking obsolete
intermediate states or resending. A separate read-only host inspection rechecks
the actual source at acceptance even on completed replay, so stale durable checks
cannot accept later file changes or reviewer edits.

Workflow/config/prompt authors are trusted. Native file-reading shell commands
are permitted; prompts prohibit native tests/provider probes, credential/history/
environment reads, network and git/package/config edits. This is **not a sandbox**,
rollback promise, or protection against hostile/detached native processes.
Ignored writes are not audited. The host checks may generate ignored build files.
Keep the isolated snapshot, DB/WAL, baseline artifacts and native data private.
Tracing defaults off; `--trace-content` explicitly enables bounded sensitive
content, without modifying receipt, accounting or validation semantics. Even
with tracing off, raw receipts/results may contain sensitive text. Do not run
this CLI in CI or execute live model tasks without separate authorization.
