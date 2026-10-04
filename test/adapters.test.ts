import test from "node:test";
import assert from "node:assert/strict";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import type {
  SessionLogOutput,
  SessionInfo,
  SessionMessageInfo,
  TokenUsageInfo,
} from "@opencode-ai/client";
import {
  CodexHarness,
  type CodexOptions,
  type CodexPort,
} from "../src/adapters/codex.js";
import {
  OpenCodeHarness,
  type OpenCodeOptions,
} from "../src/adapters/opencode.js";
import type { OpenCodeClient } from "../src/adapters/opencode-server.js";
import type {
  Accounting,
  Harness,
  HarnessRequest,
  HarnessSink,
  Json,
  Receipt,
} from "../src/types.js";
import { fixture, pricing } from "./helpers.js";
import { sleep } from "../src/util.js";
import { localAdkProof } from "../examples/adk-proof.js";
import { executeDocument } from "../src/portable/execute.js";
import type { WorkflowDocument } from "../src/portable/model.js";
import type { ProfileBinding } from "../src/profiles.js";

function codexFixture(responses: string[] = ["ok"]) {
  let calls = 0;
  const options: ThreadOptions[] = [];
  const operations: { operation: string; id?: string }[] = [];
  const usage = {
    input_tokens: 100,
    cached_input_tokens: 20,
    cache_write_input_tokens: 10,
    output_tokens: 30,
    reasoning_output_tokens: 5,
  };
  const events: ThreadEvent[][] = [];
  const client: CodexPort = {
    startThread: (o) => {
      operations.push({ operation: "start" });
      options.push(o);
      return thread();
    },
    resumeThread: (id, o) => {
      operations.push({ operation: "resume", id });
      options.push(o);
      return thread();
    },
  };
  function thread() {
    return {
      runStreamed: async () => {
        const n = ++calls;
        const sequence =
          events[n - 1] ??
          ([
            { type: "thread.started", thread_id: "thread-owned" },
            { type: "turn.started" },
            {
              type: "item.completed",
              item: {
                id: `m${n}`,
                type: "agent_message",
                text: responses[n - 1] ?? "ok",
              },
            },
            {
              type: "turn.completed",
              usage: Object.fromEntries(
                Object.entries(usage).map(([k, v]) => [k, v * n]),
              ),
            },
          ] as ThreadEvent[]);
        return {
          events: (async function* () {
            for (const event of sequence) yield event;
          })(),
        };
      },
    };
  }
  return {
    harness: new CodexHarness({
      pricing,
      client,
      checkVersion: async () => {},
    }),
    events,
    operations,
    options,
    calls: () => calls,
  };
}
function openCodeFixture(responses: string[] = ["ok"]) {
  let calls = 0;
  let seq = 0;
  const operations: { operation: string; id?: string }[] = [];
  const tokens: TokenUsageInfo = {
    input: 70,
    output: 25,
    reasoning: 5,
    cache: { read: 20, write: 10 },
  };
  const total: TokenUsageInfo = {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };
  const log: SessionLogOutput[] = [];
  const messages: SessionMessageInfo[] = [];
  let transform = (events: SessionLogOutput[]): SessionLogOutput[] => events;
  let closed = 0;
  let aggregateCost = 0;
  let disconnect = false;
  const session = (): SessionInfo => ({
    id: "session-owned",
    projectID: "p",
    cost: aggregateCost,
    tokens: structuredClone(total),
    time: { created: 1, updated: 1 },
    location: { directory: "/tmp" },
  });
  const client = {
    model: {
      list: async () => ({
        data: [{ providerID: "test", id: "model", enabled: true }],
      }),
    },
    plugin: {
      list: async () => ({
        data: [
          {
            id: "asf-no-retry",
            state: { status: "active" },
            source: { type: "local", path: "x" },
            features: { server: true },
          },
        ],
      }),
    },
    session: {
      create: async () => {
        operations.push({ operation: "create" });
        return session();
      },
      get: async () => session(),
      interrupt: async () => ({}),
      prompt: async (request: { sessionID: string }) => {
        operations.push({ operation: "prompt", id: request.sessionID });
        const n = ++calls;
        const mid = `m${n}`;
        const generated: SessionLogOutput[] = [
          {
            type: "session.step.started",
            id: `e${++seq}`,
            created: 1,
            durable: { aggregateID: "session-owned", seq, version: 1 },
            data: {
              sessionID: "session-owned",
              assistantMessageID: mid,
              agent: "asf",
              model: { providerID: "test", id: "model" },
            },
          },
          {
            type: "session.step.ended",
            id: `e${++seq}`,
            created: 1,
            durable: { aggregateID: "session-owned", seq, version: 1 },
            data: {
              sessionID: "session-owned",
              assistantMessageID: mid,
              finish: "stop",
              cost: 0,
              tokens: structuredClone(tokens),
            },
          },
          {
            type: "session.execution.succeeded",
            id: `e${++seq}`,
            created: 1,
            durable: { aggregateID: "session-owned", seq, version: 1 },
            data: { sessionID: "session-owned", executionID: `x${n}` },
          } as SessionLogOutput,
        ];
        log.push(...transform(generated));
        total.input += tokens.input;
        total.output += tokens.output;
        total.reasoning += tokens.reasoning;
        total.cache.read += tokens.cache.read;
        total.cache.write += tokens.cache.write;
        messages.unshift({
          type: "assistant",
          id: mid,
          time: { created: 1, completed: 2 },
          agent: "asf",
          model: { providerID: "test", id: "model" },
          content: [{ type: "text", text: responses[n - 1] ?? "ok" }],
        });
        return {};
      },
      wait: async () => {
        await sleep(10);
      },
      log: async function* () {
        yield {
          type: "log.synced",
          aggregateID: "session-owned",
          seq,
        } as SessionLogOutput;
      },
    },
    event: {
      subscribe: async function* (o?: { signal?: AbortSignal }) {
        let i = log.length;
        yield { type: "server.connected", id: "connected", data: {} };
        while (!o?.signal?.aborted) {
          while (i < log.length) yield log[i++]!;
          if (disconnect && log.length > 0) return;
          await sleep(1);
        }
      },
    },
    message: { list: async () => ({ data: messages, cursor: {} }) },
  } as unknown as OpenCodeClient;
  const options: OpenCodeOptions = {
    pricing: { ...pricing, model: "test/model" },
    directory: "/tmp/not-used",
    server: async () => ({
      client,
      close: async () => {
        closed++;
      },
    }),
    checkVersion: async () => {},
  };
  return {
    harness: new OpenCodeHarness(options),
    options,
    client,
    calls: () => calls,
    operations,
    closed: () => closed,
    transform: (fn: typeof transform) => {
      transform = fn;
    },
    aggregateCost: (cost: number) => {
      aggregateCost = cost;
    },
    disconnect: () => {
      disconnect = true;
    },
    tokens,
  };
}
// Shared deterministic adapter contract: same runtime behavior, no vendor-specific workflow logic.
for (const name of ["codex", "opencode"] as const) {
  test(`${name} shared contract: raw, typed correction, continuation, scoped ledger, replay`, async () => {
    const f = fixture();
    try {
      const fixtureAdapter =
        name === "codex"
          ? codexFixture(["raw", "bad", '{"ok":true}', "continued"])
          : openCodeFixture(["raw", "bad", '{"ok":true}', "continued"]);
      const h: Harness = fixtureAdapter.harness;
      const model = name === "codex" ? "test-model" : "test/model";
      const workflow = async (r: ReturnType<typeof f.runtime>) => {
        const a = await r.agent(
          "raw",
          { harness: h, model },
          { prompt: "raw" },
        );
        const b = await r.agent<{ ok: boolean }>(
          "typed",
          { harness: h, model },
          {
            prompt: "typed",
            session: a.session,
            schema: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
              additionalProperties: false,
            },
            corrections: 1,
          },
        );
        assert.equal(b.value.ok, true);
        return r.agent(
          "continue",
          { harness: h, model },
          { prompt: "next", session: b.session },
        );
      };
      assert.equal(
        (await f.runtime({ live: true }).run(workflow)).text,
        "continued",
      );
      const expected =
        name === "codex"
          ? [
              { operation: "start" },
              ...Array.from({ length: 3 }, () => ({
                operation: "resume",
                id: "thread-owned",
              })),
            ]
          : [
              { operation: "create" },
              ...Array.from({ length: 4 }, () => ({
                operation: "prompt",
                id: "session-owned",
              })),
            ];
      assert.deepEqual(fixtureAdapter.operations, expected);
      await f.runtime({ live: true }).run(workflow);
      assert.deepEqual(fixtureAdapter.operations, expected);
      assert.equal(fixtureAdapter.calls(), 4);
      const rows = f.store.db.prepare("SELECT data FROM ledger").all();
      assert.equal(rows.length, 4);
      for (const row of rows) {
        const a = JSON.parse(String(row.data)) as Accounting;
        assert.equal(a.status, "complete");
        assert.equal(a.tokens?.output, 30);
        assert.equal(a.tokens?.reasoning, 5);
        assert.equal(a.usd, (70 + 2 + 20 + 90) / 1e6);
      }
      const events = f.store.events("run", 0, 200);
      assert.ok(events.some((e) => e.type === "usage"));
      assert.ok(events.some((e) => e.type === "model"));
    } finally {
      f.close();
    }
  });
}
const request: HarnessRequest = {
  prompt: "p",
  cwd: "/tmp",
  mode: "read-only",
  model: "test-model",
  signal: new AbortController().signal,
};
const sink: HarnessSink = { event: () => {}, report: () => {} };

test("adapter identity and execution use constructor snapshots while caller options remain mutable", async () => {
  let codexChecks = 0;
  let codexStarts = 0;
  const codexPricing = { ...pricing };
  const codexClient: CodexPort = {
    startThread: () => ({
      runStreamed: async () => {
        codexStarts++;
        return {
          events: (async function* () {
            yield {
              type: "thread.started",
              thread_id: "snapshot-thread",
            } as const;
            yield {
              type: "turn.completed",
              usage: {
                input_tokens: 1_000_000,
                cached_input_tokens: 0,
                cache_write_input_tokens: 0,
                output_tokens: 1,
                reasoning_output_tokens: 0,
              },
            } as const;
          })(),
        };
      },
    }),
    resumeThread: () => {
      throw new Error("unused");
    },
  };
  const codexOptions: CodexOptions = {
    pricing: codexPricing,
    executable: "original-codex",
    client: codexClient,
    checkVersion: async () => {
      codexChecks++;
    },
  };
  const codex = new CodexHarness(codexOptions);
  const codexIdentity = structuredClone(codex.identity);
  codexPricing.input = 9;
  codexPricing.source = "mutated";
  codexPricing.version = "mutated";
  codexOptions.executable = "mutated-codex";
  codexOptions.checkVersion = async () => {
    throw new Error("mutated check used");
  };
  codexClient.startThread = () => {
    throw new Error("mutated client method used");
  };
  assert.equal(codexPricing.input, 9);
  await codex.preflight({
    prompt: request.prompt,
    cwd: request.cwd,
    mode: request.mode,
    model: request.model,
  });
  const codexReceipt = await codex.invoke(request, sink);
  assert.equal(codexChecks, 1);
  assert.equal(codexStarts, 1);
  assert.deepEqual(codex.identity, codexIdentity);
  assert.deepEqual(codexReceipt.accounting.pricing, pricing);
  assert.equal(codexReceipt.accounting.usd, (1_000_000 + 3) / 1e6);

  const opencode = openCodeFixture();
  const opencodeIdentity = structuredClone(opencode.harness.identity);
  opencode.options.pricing.input = 99;
  opencode.options.pricing.source = "mutated";
  opencode.options.pricing.version = "mutated";
  opencode.options.directory = "/tmp/mutated-directory";
  opencode.options.executable = "mutated-opencode";
  opencode.options.server = async () => {
    throw new Error("mutated server used");
  };
  opencode.options.checkVersion = async () => {
    throw new Error("mutated check used");
  };
  assert.equal(opencode.options.pricing.input, 99);
  await opencode.harness.preflight({
    prompt: request.prompt,
    cwd: request.cwd,
    mode: request.mode,
    model: "test/model",
  });
  const opencodeReceipt = await opencode.harness.invoke(
    { ...request, model: "test/model" },
    sink,
  );
  assert.deepEqual(opencode.harness.identity, opencodeIdentity);
  assert.deepEqual(opencodeReceipt.accounting.pricing, {
    ...pricing,
    model: "test/model",
  });
  assert.equal(opencodeReceipt.accounting.usd, (70 + 2 + 20 + 90) / 1e6);
});

test("Codex cumulative baseline, duplicate terminal, regression, failure missing usage", async () => {
  const f = codexFixture();
  const first = await f.harness.invoke(request, sink);
  assert.ok(first.session);
  const second = await f.harness.invoke(
    { ...request, session: first.session },
    sink,
  );
  assert.equal(first.accounting.usd, second.accounting.usd);
  assert.equal(f.options[0]?.sandboxMode, "read-only");
  assert.equal(f.options[0]?.approvalPolicy, "never");
  const completed: ThreadEvent = {
    type: "turn.completed",
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
    },
  };
  f.events[2] = [completed, completed];
  const regression = await f.harness.invoke(
    { ...request, session: second.session },
    sink,
  );
  assert.equal(regression.accounting.status, "incomplete");
  f.events[3] = [
    completed,
    completed,
    { type: "error", message: "failed after usage" },
  ];
  const fail = await f.harness.invoke(request, sink);
  assert.equal(fail.accounting.status, "incomplete");
  assert.ok(fail.accounting.usd! > 0);
  f.events[4] = [{ type: "turn.failed", error: { message: "no usage" } }];
  const missing = await f.harness.invoke(request, sink);
  assert.equal(missing.accounting.usd, null);
});
test("Codex final answer not reasoning/tools; output bounded; actual model provenance honest", async () => {
  const f = codexFixture(["x".repeat(100000)]);
  const result = await f.harness.invoke(request, sink);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 65536);
  assert.equal(result.accounting.modelSource, "requested");
  assert.ok(result.accounting.excluded.some((s) => s.includes("reroutes")));
});
for (const traceContent of [false, true]) {
  for (const lateNotice of [false, true]) {
    test(`Codex textual reroute fails closed with ${traceContent ? "exhausted" : "disabled"} tracing, notice ${lateNotice ? "after" : "before"} usage`, async () => {
      const f = fixture();
      try {
        const c = codexFixture();
        const notice = "model rerouted: test-model -> other-model";
        const reroute: ThreadEvent = {
          type: "item.completed",
          item: { id: "reroute", type: "error", message: notice },
        };
        const terminal: ThreadEvent = {
          type: "turn.completed",
          usage: {
            input_tokens: 10,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 5,
            reasoning_output_tokens: 1,
          },
        };
        c.events[0] = [
          { type: "thread.started", thread_id: "thread-owned" },
          ...Array.from(
            { length: traceContent ? 501 : 1 },
            (_, i): ThreadEvent => ({
              type: "item.completed",
              item: { id: `m${i}`, type: "agent_message", text: "NOT_JSON" },
            }),
          ),
          ...(lateNotice ? [terminal, reroute] : [reroute, terminal]),
        ];
        await f.runtime({ live: true, traceContent }).run(async (r) => {
          const config = { harness: c.harness, model: "test-model" };
          await assert.rejects(
            r.agent("typed", config, {
              prompt: "x",
              schema: { type: "object" },
              corrections: 1,
            }),
            /Incomplete accounting: model rerouted:/,
          );
          await assert.rejects(
            r.agent("next", config, { prompt: "next" }),
            /Incomplete accounting\/uncertain send blocks dispatch/,
          );
        });
        assert.equal(c.calls(), 1); // Neither correction nor next paid action sent.
        const rows = f.store.db
          .prepare("SELECT receipt FROM invocations")
          .all();
        assert.equal(rows.length, 1);
        const receipt = JSON.parse(String(rows[0]!.receipt)) as Receipt;
        const ledger = JSON.parse(
          String(f.store.db.prepare("SELECT data FROM ledger").get()?.data),
        ) as Accounting;
        assert.equal(receipt.status, "failed");
        assert.equal(receipt.error, notice);
        assert.equal(receipt.session, undefined);
        assert.deepEqual(receipt.accounting, ledger);
        assert.equal(ledger.status, "incomplete");
        assert.equal(ledger.reason, notice);
        assert.equal(ledger.model, "test-model");
        assert.equal(ledger.modelSource, "requested");
        assert.deepEqual(ledger.pricing, pricing);
        assert.deepEqual(ledger.tokens, {
          input: 10,
          cacheRead: 0,
          cacheWrite: 0,
          output: 5,
          reasoning: 1,
        });
        assert.equal(ledger.usd, 25 / 1e6); // Requested-rate estimate, not actual-model pricing.
        const snapshot = f.store.inspect("run") as {
          totals: {
            knownUsd: number;
            unresolved: number;
            modelDispatches: number;
          };
        };
        assert.equal(snapshot.totals.knownUsd, ledger.usd);
        assert.equal(snapshot.totals.unresolved, 1);
        assert.equal(snapshot.totals.modelDispatches, 1);
        const traces = f.store.db
          .prepare("SELECT data FROM events WHERE source='reroute'")
          .all();
        if (traceContent) {
          assert.equal(traces.length, 0);
          assert.ok(
            f.store.db
              .prepare("SELECT 1 FROM events WHERE type='trace.truncated'")
              .get(),
          );
        } else {
          assert.equal(traces.length, 1);
          assert.deepEqual(JSON.parse(String(traces[0]!.data)), {
            contentOmitted: true,
          });
        }
      } finally {
        f.close();
      }
    });
  }
}

test("OpenCode durably reports a cost-only failed step through terminal failure or disconnect", async () => {
  for (const terminal of ["failure", "disconnect"] as const) {
    const f = openCodeFixture();
    f.aggregateCost(0.25);
    if (terminal === "disconnect") f.disconnect();
    f.transform((events) =>
      events.flatMap((event): SessionLogOutput[] => {
        if (event.type === "session.step.ended")
          return [
            {
              ...event,
              type: "session.step.failed" as const,
              data: {
                sessionID: event.data.sessionID,
                assistantMessageID: event.data.assistantMessageID,
                cost: 0.25,
                error: {
                  type: "provider.auth" as const,
                  message: `charged failure ${"x".repeat(10_000)}`,
                  status: 500,
                },
              },
            },
          ];
        if (event.type === "session.execution.succeeded")
          return terminal === "disconnect"
            ? []
            : [
                {
                  ...event,
                  type: "session.execution.failed" as const,
                  data: {
                    sessionID: event.data.sessionID,
                    error: {
                      type: "provider.auth" as const,
                      message: "provider charged then failed",
                      status: 500,
                    },
                  },
                },
              ];
        return [event];
      }),
    );
    const reports: Accounting[] = [];
    const receipt = await f.harness.invoke(
      { ...request, model: "test/model", traceContent: false },
      { event: () => {}, report: (_key, value) => reports.push(value) },
    );
    assert.equal(receipt.status, "failed", terminal);
    assert.equal(receipt.accounting.status, "incomplete", terminal);
    assert.equal(receipt.accounting.usd, null, terminal);
    assert.equal(receipt.accounting.tokens, null, terminal);
    assert.deepEqual(
      receipt.accounting.additional,
      [
        {
          usd: 0.25,
          kind: "harness-estimated",
          scope: "native failed-step estimate without reported token usage",
          model: null,
          source: "session.step.failed.cost",
          version: "0.0.0-beta-19271",
        },
      ],
      terminal,
    );
    assert.equal(reports.length, 1, terminal);
    assert.deepEqual(
      reports[0]?.additional,
      receipt.accounting.additional,
      terminal,
    );
    assert.match(JSON.stringify(reports[0]?.raw), /charged failure/);
    assert.ok(Buffer.byteLength(JSON.stringify(reports[0])) < 16 * 1024);
    assert.equal(f.closed(), 1, terminal);
  }
});

test("OpenCode keeps mixed token and cost-only steps non-additive with aggregate reconciliation", async () => {
  const f = openCodeFixture();
  f.aggregateCost(0.4);
  f.transform((events) => {
    const started = events[0];
    const ended = events[1];
    const execution = events[2];
    assert.equal(started?.type, "session.step.started");
    assert.equal(ended?.type, "session.step.ended");
    assert.equal(execution?.type, "session.execution.succeeded");
    if (
      started?.type !== "session.step.started" ||
      ended?.type !== "session.step.ended" ||
      execution?.type !== "session.execution.succeeded"
    )
      throw new Error("unexpected fixture events");
    const failed = (
      id: string,
      assistantMessageID: string,
      cost: number,
      startSeq: number,
    ): SessionLogOutput[] => [
      {
        ...started,
        id: `${id}-start`,
        durable: { ...started.durable, seq: startSeq },
        data: { ...started.data, assistantMessageID },
      },
      {
        type: "session.step.failed",
        id,
        created: 1,
        durable: { ...started.durable, seq: startSeq + 1 },
        data: {
          sessionID: started.data.sessionID,
          assistantMessageID,
          cost,
          error: { type: "unknown", message: `${id} failed` },
        },
      },
    ];
    return [
      { ...started, durable: { ...started.durable, seq: 1 } },
      { ...ended, durable: { ...ended.durable, seq: 2 } },
      ...failed("failed-one", "failed-message-one", 0.25, 3),
      ...failed("failed-two", "failed-message-two", 0.15, 5),
      { ...execution, durable: { ...execution.durable, seq: 7 } },
    ];
  });
  const reports: Accounting[] = [];
  const receipt = await f.harness.invoke(
    { ...request, model: "test/model", traceContent: false },
    { event: () => {}, report: (_key, value) => reports.push(value) },
  );
  const primary = (70 + 2 + 20 + 90) / 1e6;
  assert.equal(receipt.accounting.status, "incomplete");
  assert.equal(receipt.accounting.usd, primary);
  assert.equal(receipt.accounting.additional?.length, 1);
  assert.equal(receipt.accounting.additional?.[0]?.usd, 0.4);
  assert.equal(
    (receipt.accounting.usd ?? 0) +
      (receipt.accounting.additional?.[0]?.usd ?? 0),
    primary + 0.4,
  );
  assert.ok(
    !receipt.accounting.additional?.some((part) =>
      part.scope.includes("aggregate residual"),
    ),
  );
  assert.equal(reports.length, 4);
  assert.equal(reports.at(-1)?.additional?.[0]?.usd, 0.4);
  assert.equal(f.closed(), 1);
});

test("OpenCode provider denial stays actionable without content tracing", async () => {
  const f = openCodeFixture();
  const denial = {
    type: "provider.auth" as const,
    message: "This model route is not permitted for this client",
    status: 403,
  };
  f.transform((events) =>
    events.map((event) => {
      if (event.type === "session.step.ended")
        return {
          ...event,
          type: "session.step.failed" as const,
          data: {
            sessionID: event.data.sessionID,
            assistantMessageID: event.data.assistantMessageID,
            error: denial,
          },
        };
      if (event.type === "session.execution.succeeded")
        return {
          ...event,
          type: "session.execution.failed" as const,
          data: { sessionID: event.data.sessionID, error: denial },
        };
      return event;
    }),
  );
  const receipt = await f.harness.invoke(
    { ...request, model: "test/model", traceContent: false },
    sink,
  );
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.accounting.status, "incomplete");
  assert.equal(receipt.accounting.usd, null);
  assert.match(receipt.error!, /not permitted for this client/);
  assert.equal(f.calls(), 1);
  assert.equal(f.closed(), 1);
});

test("OpenCode zero normalization, missing/model mismatch, aux usage and failures fail closed", async () => {
  for (const kind of ["zero", "missing", "model", "aux", "failure"] as const) {
    const f = openCodeFixture();
    f.transform((events) => {
      if (kind === "model" && events[0]?.type === "session.step.started")
        events[0].data.model.id = "rerouted";
      if (kind === "zero" && events[1]?.type === "session.step.ended")
        events[1].data.tokens = {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        };
      if (kind === "missing")
        return events.filter((e) => e.type !== "session.step.started");
      if (kind === "failure" && events[1]?.type === "session.step.ended")
        events[1] = {
          ...events[1],
          type: "session.step.failed",
          data: {
            sessionID: "session-owned",
            assistantMessageID: "m1",
            error: { type: "unknown", message: "failure" },
          },
        } as unknown as SessionLogOutput;
      if (kind === "aux")
        events.push({
          type: "session.usage.recorded",
          id: "aux",
          created: 1,
          durable: { seq: 4, version: 1, aggregateID: "session-owned" },
          data: {
            sessionID: "session-owned",
            source: "title",
            cost: 0.002,
            tokens: f.tokens,
          },
        });
      return events;
    });
    const reports: Accounting[] = [];
    const result = await f.harness.invoke(
      { ...request, model: "test/model" },
      { event: () => {}, report: (_k, a) => reports.push(a) },
    );
    assert.equal(result.accounting.status, "incomplete", kind);
    assert.equal(f.closed(), 1);
    if (kind === "aux")
      assert.ok(
        reports.some((a) =>
          a.additional?.some(
            (p) => p.kind === "harness-estimated" && p.usd === 0.002,
          ),
        ),
      );
  }
});
test("known preflight pricing failures dispatch nothing", async () => {
  const c = codexFixture();
  await assert.rejects(
    c.harness.preflight({ ...request, model: "other" }),
    /matching model/,
  );
  assert.equal(c.calls(), 0);
  const o = openCodeFixture();
  await assert.rejects(
    o.harness.preflight({ ...request, model: "other" }),
    /matching model/,
  );
  assert.equal(o.calls(), 0);
});
test("accounting reports remain available on content-off SDK failure", async () => {
  const f = fixture();
  try {
    const c = codexFixture();
    c.events[0] = [
      {
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 1,
        },
      },
      { type: "error", message: "late failure" },
    ];
    await assert.rejects(
      f
        .runtime({ live: true })
        .run((r) =>
          r.agent(
            "a",
            { harness: c.harness, model: "test-model" },
            { prompt: "x" },
          ),
        ),
      /Incomplete/,
    );
    const a = JSON.parse(
      String(f.store.db.prepare("SELECT data FROM ledger").get()?.data),
    ) as Accounting;
    assert.ok(a.usd! > 0);
    assert.equal(a.status, "incomplete");
    assert.ok(f.store.events("run").some((e) => e.type === "usage"));
  } finally {
    f.close();
  }
});
// Ensure fixture baselines are JSON serializable, not SDK object handles.
const _baselineType: Json = { seq: 1 };
void _baselineType;

test("OpenCode auxiliary estimates remain distinct and present in known totals", async () => {
  const f = fixture();
  try {
    const adapter = openCodeFixture();
    adapter.transform((events) => [
      ...events,
      {
        type: "session.usage.recorded",
        id: "aux",
        created: 1,
        durable: { seq: 4, version: 1, aggregateID: "session-owned" },
        data: {
          sessionID: "session-owned",
          source: "title",
          cost: 0.002,
          tokens: adapter.tokens,
        },
      },
    ]);
    await assert.rejects(
      f
        .runtime({ live: true })
        .run((r) =>
          r.agent(
            "a",
            { harness: adapter.harness, model: "test/model" },
            { prompt: "x" },
          ),
        ),
      /Incomplete/,
    );
    const snapshot = f.store.inspect("run") as {
      totals: { knownUsd: number };
      costsByKind: { kind: string; knownUsd: number }[];
    };
    assert.equal(snapshot.totals.knownUsd, 0.002 + (70 + 2 + 20 + 90) / 1e6);
    assert.ok(
      snapshot.costsByKind.some(
        (p) => p.kind === "harness-estimated" && p.knownUsd === 0.002,
      ),
    );
  } finally {
    f.close();
  }
});
test("native OpenCode retry policy hook denies the retry decision", async () => {
  const url = new URL("../scripts/opencode-policy/index.mjs", import.meta.url)
    .href;
  type Decision = { decision: { retry: boolean; delay?: number } };
  let hook: ((event: Decision) => void) | undefined;
  const module = (await import(url)) as {
    default: {
      setup(ctx: {
        session: {
          hook(
            name: string,
            fn: (event: Decision) => void,
          ): Promise<{ dispose: () => Promise<void> }>;
        };
      }): Promise<() => Promise<void>>;
    };
  };
  let disposed = false;
  const cleanup = await module.default.setup({
    session: {
      hook: async (name, fn) => {
        assert.equal(name, "retry");
        hook = fn;
        return {
          dispose: async () => {
            disposed = true;
          },
        };
      },
    },
  });
  const event = { decision: { retry: true, delay: 1 } };
  hook!(event);
  assert.equal(event.decision.retry, false);
  await cleanup();
  assert.equal(disposed, true);
});

for (const target of ["codex", "opencode", "adk"] as const) {
  test(`${target} executes and replays the same portable typed child document`, async () => {
    const f = fixture(),
      expected = { ok: true, marker: "local-adk" };
    const native =
      target === "codex"
        ? codexFixture([JSON.stringify(expected)])
        : target === "opencode"
          ? openCodeFixture([JSON.stringify(expected)])
          : null;
    const h: Harness = native?.harness ?? localAdkProof();
    try {
      const model =
        target === "adk"
          ? "asf-local-proof"
          : target === "opencode"
            ? "test/model"
            : "test-model";
      const mode = target === "adk" ? "write" : "read-only";
      const binding: ProfileBinding = {
        agent: { harness: h, model, mode },
        capabilities: {
          revision: `${target}-offline-portable-v1`,
          modes: [mode],
          fresh: true,
          nativeSystem: false,
          strictTools: false,
        },
      };
      const schema = {
        type: "object",
        properties: { ok: { type: "boolean" }, marker: { type: "string" } },
        required: ["ok", "marker"],
        additionalProperties: false,
      };
      const document: WorkflowDocument = {
        format: "asf-ts-workflow/v1",
        root: "delivery",
        profiles: { worker: {} },
        workflows: {
          delivery: {
            version: "1",
            inputSchema: { type: "object", additionalProperties: false },
            outputSchema: schema,
            start: "review",
            nodes: [
              {
                id: "review",
                kind: "workflow",
                workflow: "review",
                input: { $ref: "#/input" },
                maxDispatches: 1,
                next: "end",
              },
              {
                id: "end",
                kind: "end",
                output: { $ref: "#/nodes/review" },
                passed: { $ref: "#/nodes/review/ok" },
              },
            ],
          },
          review: {
            version: "1",
            inputSchema: { type: "object", additionalProperties: false },
            outputSchema: schema,
            defaultProfile: "worker",
            start: "reviewer",
            nodes: [
              {
                id: "reviewer",
                kind: "agent",
                prompt:
                  "Call marker if available, then return ok and marker as JSON.",
                outputSchema: schema,
                next: "end",
              },
              {
                id: "end",
                kind: "end",
                output: { $ref: "#/nodes/reviewer" },
                passed: { $ref: "#/nodes/reviewer/ok" },
              },
            ],
          },
        },
      };
      const run = () =>
        f
          .runtime({ live: true })
          .run((r) =>
            executeDocument(r, document, {}, { bindings: { worker: binding } }),
          );
      const first = await run();
      assert.equal(first.passed, true);
      assert.deepEqual(first.value, expected);
      const rows = f.store.db
        .prepare(
          "SELECT l.data FROM ledger l JOIN invocations i ON i.id=l.invocation WHERE i.kind='model'",
        )
        .all();
      assert.equal(rows.length, 1);
      const account = JSON.parse(String(rows[0]!.data)) as Accounting;
      assert.equal(account.status, "complete");
      assert.ok(account.tokens && account.tokens.output > 0);
      if (target === "adk")
        assert.equal((account.raw as { modelCalls: number }).modelCalls, 2);
      const before = f.store.inspect("run").totals;
      assert.deepEqual(await run(), first);
      assert.deepEqual(f.store.inspect("run").totals, before);
      if (native) assert.equal(native.calls(), 1);
      assert.equal(f.store.workflowInspect("run").workflows.length, 2);
    } finally {
      await h.close?.();
      f.close();
    }
  });
}
