# ASF TypeScript workflow core

Small SDK-first workflow runtime for **Node 22.22.x / Linux**. Ordinary async TypeScript, explicit durable actions, native sessions, bounded JSON correction, commands, and parallel scopes. This is an independent implementation with optional portable workflow authoring.

**Accounting is mandatory; content tracing is optional.** Costs are scoped estimates, not invoices. Unknown/failed accounting blocks further model dispatch. An uncertain send is never automatically repeated.

## Portable authoring and composition

Portable YAML/JSON, typed child workflows, profiles, file-driven TypeScript generation, rendering, bundles, and an optional Google ADK proof build on the existing durable runtime. The local UI preserves its execution inspector and adds document authoring. Generation and execution stay in the CLI/library. See the [portable guide](docs/portable.md), [port design](docs/designs/ts-port.md), [decisions](docs/adr), and [delivery evidence](docs/evidence/ts-port-delivery.md).

## Run offline

Current pins: `@openai/codex-sdk@0.159.2` (bundled `codex-cli 0.159.2`) and `@opencode-ai/client@0.0.0-beta-19271`. OpenCode requires the matching `@opencode-ai/cli@0.0.0-beta-19271` (`opencode2`), not the timestamped `opencode-ai` beta or stable 1.x SDK. Use project-local executables; see [installation, source checks and offline upgrade limits](docs/sdk-upgrade-20260930.md). Historical live results below do **not** qualify these pins, and old session/action bindings cannot be continued with the upgraded adapters.

```sh
npm ci --ignore-scripts
npm run check
npm run asf -- run --run demo --workflow examples/workflow.ts
npm run asf -- resume --run demo --workflow examples/workflow.ts
npm run asf -- inspect --run demo
npm run asf -- events --run demo --follow
npm run asf -- serve --port 8080
```

The example needs no model by default: a failed local check takes a finite repair branch. Configure a `worker` agent and pass `--live` to exercise parallel planning, implementation, command checks, one repair, and typed review. Workflow modules/commands are trusted executable code; do not run untrusted modules.

```ts
const agent = { harness, model: explicitModel, mode: "read-only" as const };
await runtime.run(async (run) => {
  const plans = await Promise.all(
    ["api", "tests"].map((name) =>
      run.scope(name).agent("plan", agent, { prompt: `Plan ${name}` }),
    ),
  );
  return run.agent<{ approved: boolean }>("review", agent, {
    prompt: "Review these plans. Return JSON.",
    context: plans.map((p) => p.text),
    schema: {
      type: "object",
      properties: { approved: { type: "boolean" } },
      required: ["approved"],
      additionalProperties: false,
    },
    corrections: 1,
  });
});
```

Create `Store`, `Runtime`, and a harness via `src/index.ts` (or built `dist/src/index.js`). See the runnable [example](examples/workflow.ts). All actions must be awaited. JSON schemas are trusted author-supplied schemas; generic result types must match them.

## Inspect and qualify

- [Design/API, durability, limits, adapter contract](docs/design.md)
- [Exact SDK compatibility and accounting coverage](docs/sdk-qualification.md)
- [Opt-in live runner and shared allowance instructions](docs/live-qualification.md)
- [Explicit model/pricing template](examples/agents.template.json) — intentionally invalid until filled in; no guessed prices/models.

### Mixing providers in one workflow

[`mixedQualificationWorkflow`](scripts/mixed-qualification-workflow.ts) runs two typed read-only actions with `Promise.all`, then continues the Codex session with both returned values as explicit JSON context. It accepts ordinary reusable `{codex, opencode}` agent configs—no graph or broker. The historical live Codex `gpt-6-astra` + OpenCode Go `glm-5.2` check produced **49 + 39 → 88**, and replay sent nothing. See [results and retained failure history](docs/verification.md) and [machine-readable evidence](docs/evidence/qualification-mixed-20260922.json). The original live allowance is exhausted; these results do not authorize another run.

## Local read-only UI

```sh
npm run asf -- serve --db .asf/store.db --port 8080
# Or, after npm run build:
node dist/src/cli.js serve --db .asf/store.db --port 8080
```

Open the printed `http://127.0.0.1:8080/` URL. `serve` initializes a missing database, then opens it read-only; omit `--port` for an ephemeral port. Select a run, then click an execution-map card or turn to read retained final responses, errors, command outputs, session IDs and provider observations in the panel alongside it (stacked on mobile). Action/turn dropdowns remain available for keyboard navigation. The inspector has no dispatch, retry or editing controls. Author portable documents at `/studio` and inspect declared graphs at `/graph`; see the [portable guide](docs/portable.md). Costs show the **known subtotal plus unresolved invocations**, not an invoice or cumulative reports added to final ledger.

The **execution map** groups explicit action-ID scope prefixes into lanes, with distinct agent and command cards. It is a page-local view, **not a dependency DAG**: placement does not infer causal/data flow, parallelism or timing intervals. Dashed session rails link only recorded session membership; numbered turns show within-action order (including corrections), with possible gaps. Session labels are page-local. Missing action/invocation records remain explicit, and a completed run does not override a pending node. Card costs are **visible final-ledger subtotals**, including known auxiliary amounts, never full-action totals or reports added to ledger. Unknown is not zero. This is presentation over ordinary async TypeScript, not a graph engine.

**Not a complete harness terminal transcript:** prompts aren't retained; tracing defaults off and can truncate/drop content. Only exposed provider events are available. Final receipts remain with tracing off. Item snapshots and delta/end events are not normalized conversation messages. Content is rendered literally, never as HTML/Markdown or external resources.

Run lists refresh manually and page 20 at a time, newest first (ID breaks timestamp ties). Actions/invocations are independently paged, 20 each; related records can be on other pages. Selected run status polls every second. Observations start from the beginning, keep only the latest **100 loaded** rows, and pause on a full batch until you click **Load next observations / resume live**. Selection filters that window; absent observations do not prove tracing was enabled or complete. Changing runs resets the cursor/window and cancels old requests. Reconnecting resumes the cursor without duplicates. Reselect a run to read earlier history; there is no automatic unbounded history fetch or archive.

HTTP binds **127.0.0.1 only**, with `/`, explicit `/ui.js`, `/flow-model.js` and `/ui.css` assets, bounded `/runs?offset=0&limit=100`, `/inspect?run=ID&offset=0&limit=100`, and `/events?run=ID&after=0&stream=1`. Run/inspection pages have a maximum limit of 200; event HTTP batches cap at 100. SSE still supports `Last-Event-ID`; the UI uses same-origin GET polling because the existing guard rejects **any Origin header**, including browser EventSource headers. GET/Host/cross-site restrictions are unchanged. This is not an authenticated/public service; don't expose it through a proxy. JSON, event content, results, and native session files are sensitive/untrusted; no redaction guarantee.

### Offline Playwright video verification

```sh
npm ci --ignore-scripts
npm run check
# If matching Chromium is not already cached (one-time browser download):
# npx playwright install chromium
npm run verify:ui
# Optional faster regression pass, still records: npm run verify:ui -- --quick
```

Uses pinned Playwright/Chromium and an actual `recordVideo` browser context against the **built CLI/assets**. Creates only a fresh, clearly labelled **SYNTHETIC** database under ignored `.asf/ui-verification/synthetic-*/demo.db`: mock harness receipts/events and local Node commands, no provider imports/dispatch, private native state, qualification database or paid model calls. The script prints the exact command for inspecting its synthetic DB. It asserts scope lanes, session membership, card/turn/dropdown and keyboard selection, focus across polling, mobile layout, source/built/served asset parity, run/action/turn selection, live tool updates and reconnect, final receipts with tracing off, literal XSS-like strings/no external requests, known versus unresolved costs, omissions/truncation, bounded paging and unknown runs. Normal pacing leaves time to read the walkthrough.

Artifacts (overwritten on reproduction): `.asf/ui-verification/workflow-ui.webm` and `workflow-ui.png`. Database fixtures are retained in their unique directories; these ignored artifacts are not committed.

[Verification results](docs/verification.md): Codex passed five live turns covering tools, native continuation, writing, and same-session correction; replay sent no new requests. OpenCode historically also passed five live ASF turns and account-free replay on the explicitly authorized `opencode-go/gpt-5.6-luna` route, with real tools, native continuation/correction and complete **declared-scope estimates**. Private API-key provisioning is opt-in; global auth is not imported or changed. The earlier free-route HTTP 403 and its unresolved accounting remain preserved, and no invoice-completeness claim is made. Portable graphs now lower into the same durable Runtime. No additional agentic frameworks or automatic uncertain-send reconciliation are included.

### Separately authorized real Codex recording

`scripts/verify-ui-live.ts --help` (or no arguments) is inert. It is **not** part of `npm run check` or CI. The offline regression above remains synthetic and is never presented as real model evidence.

For the explicitly approved continuation only:

```sh
npm run check
npx tsx scripts/verify-ui-live.ts --live \
  --config .asf/qualification-agents.json --db .asf/qualification.db \
  --run ui-real-codex-review-v1 --budget ui-real-codex-authorized-v1
```

The script requires the retained `.asf/ui-verification/real-codex-authorization.json`, exact approved `gpt-6-astra` configuration/rate provenance, the existing seven-reservation shared DB, and a previously unused run/budget. This authorization adds an immutable **3 reservation / $3 soft estimate** budget without resetting the old allowance or declaring its two incomplete ledger entries free. This raw-output workflow uses **two** actual Codex turns and no correction/retry: read-only review of an allowlisted, fingerprinted current-source snapshot; genuine `npm run check` through an ASF command; same-native-session follow-up with that actual check result. Only the official CodexHarness dispatches models. Snapshot dependencies are linked for the trusted host checks; the model is instructed not to traverse them or read outside the snapshot. Native sandbox/permission limitations still apply.

Playwright selects the running run **before** the first reservation and records actual tool/model observations, nullable pending accounting, final receipts, checks, and continuation. It verifies served/source/built asset byte equality. The existing history is hashed before/after, not rendered as review content. **Do not rerun on failure or uncertainty, even to improve footage.** Missing accounting stops further sends. A later read-only capture of persisted history must be labelled history/replay, not live execution. The dollar threshold is not a hard bill cap; vendor-internal retries and requested-model attribution limitations remain.

[Committed real-workflow recording and verification note](docs/ui-verification.md) includes the explicitly approved video copy in `docs/evidence/ui-real-codex-workflow.webm`, including the recorded check failures and later standalone pass. This copy contains real conversation/native identifiers and is **not redacted**; original `.asf` artifacts remain ignored and private.

Real artifacts are separate: `.asf/ui-verification/real-codex-workflow.webm`, `real-codex-workflow.png`, `real-codex-workflow-report.json`, plus a unique `real-codex-*/` directory with source manifest/snapshot, historical hashes, actual results and scoped accounting. Failed footage is retained. These contain sensitive real output/tool traces/native IDs with **no redaction guarantee**; keep private. The script never opens native history. Inspect the retained real run without any model calls using `npm run asf -- serve --db .asf/qualification.db --port 8080`. Read the report's failure/assertion fields before claiming verification passed.
