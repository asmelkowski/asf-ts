import test from "node:test";
import assert from "node:assert/strict";
import {
  BaseAgent,
  BaseLlm,
  LlmAgent,
  FunctionTool,
  Workflow,
  createEvent,
  type Event,
  type InvocationContext,
  type LlmRequest,
  type LlmResponse,
} from "@google/adk";
import { AdkHarness, type AdkOptions } from "../src/adapters/adk.js";
import {
  LocalProofModel,
  localAdkProof,
  localPricing,
} from "../examples/adk-proof.js";
import type {
  Accounting,
  HarnessRequest,
  HarnessSink,
  Pricing,
} from "../src/types.js";
import { fixture, pricing } from "./helpers.js";
import { sleep } from "../src/util.js";

const response = (text = "ok"): LlmResponse => ({
  content: { role: "model", parts: [{ text }] },
  modelVersion: "test-model",
  usageMetadata: {
    promptTokenCount: 10,
    cachedContentTokenCount: 2,
    candidatesTokenCount: 3,
    thoughtsTokenCount: 1,
  },
});
class Model extends BaseLlm {
  calls = 0;
  closed = 0;
  requests: LlmRequest[] = [];
  constructor(
    private readonly run: (
      signal?: AbortSignal,
    ) => AsyncGenerator<LlmResponse, void> = async function* () {
      yield response();
    },
  ) {
    super({ model: "test-model" });
  }
  override connect(): never {
    throw new Error("No live transport");
  }
  override async *generateContentAsync(
    request: LlmRequest,
    _stream?: boolean,
    signal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    this.calls++;
    this.requests.push({
      ...request,
      contents: structuredClone(request.contents),
      config: structuredClone(request.config),
    });
    try {
      yield* this.run(signal);
    } finally {
      this.closed++;
    }
  }
}
const request = (): HarnessRequest => ({
  prompt: "task",
  model: "test-model",
  cwd: process.cwd(),
  mode: "write",
  signal: new AbortController().signal,
});
function sink() {
  const reports: Accounting[] = [];
  const events: unknown[] = [];
  const value: HarnessSink = {
    report: (_key, value) => reports.push(structuredClone(value)),
    event: (value) => events.push(value),
  };
  return { value, reports, events };
}
function harness(model: Model, options: Partial<AdkOptions> = {}) {
  return new AdkHarness({
    revision: "fixture-v1",
    live: false,
    model: { create: () => model, pricing },
    ...options,
  });
}

test("actual ADK model and tool execution carries native instruction and all model usage", async () => {
  const model = new LocalProofModel();
  let tools = 0;
  const priced: Pricing = {
    ...localPricing,
    input: 1,
    cacheRead: 0.1,
    output: 3,
  };
  const h = new AdkHarness({
    revision: "tool-proof",
    live: false,
    model: { create: () => model, pricing: priced },
    instruction: "Native system marker",
    tools: [
      new FunctionTool({
        name: "marker",
        description: "marker",
        execute: () => {
          tools++;
          return { marker: "local-adk" };
        },
      }),
    ],
  });
  const s = sink();
  const result = await h.invoke(
    { ...request(), model: localPricing.model },
    s.value,
  );
  assert.equal(result.status, "succeeded");
  assert.deepEqual(JSON.parse(result.text), { ok: true, marker: "local-adk" });
  assert.equal(tools, 1);
  assert.equal(model.requests.length, 2);
  assert.match(
    JSON.stringify(model.requests[0]?.config?.systemInstruction),
    /Native system marker/,
  );
  assert.equal(Object.keys(model.requests[0]?.toolsDict ?? {}).length, 1);
  assert.deepEqual(result.accounting.tokens, {
    input: 16,
    cacheRead: 4,
    cacheWrite: 0,
    output: 8,
    reasoning: 2,
  });
  assert.equal(result.accounting.usd, (16 + 0.4 + 24) / 1e6);
  assert.deepEqual(
    s.reports.map((r) => r.raw),
    [
      { modelCalls: 1, settledModelCalls: 1 },
      { modelCalls: 2, settledModelCalls: 2 },
      { modelCalls: 2, settledModelCalls: 2 },
    ],
  );
  await h.close();
});

test("actual ADK continuation, same-session correction and durable replay", async () => {
  const f = fixture();
  let n = 0;
  const model = new Model(async function* () {
    yield response(++n === 1 ? "bad" : '{"ok":true}');
  });
  const h = harness(model);
  const workflow = async (r: ReturnType<typeof f.runtime>) => {
    const first = await r.agent<{ ok: boolean }>(
      "typed",
      { harness: h, model: pricing.model, mode: "write" },
      {
        prompt: "task",
        corrections: 1,
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    );
    return r.agent(
      "continued",
      { harness: h, model: pricing.model, mode: "write" },
      { prompt: "continue", session: first.session },
    );
  };
  try {
    const first = await f.runtime().run(workflow);
    assert.equal(model.calls, 3);
    assert.match(
      JSON.stringify(model.requests[2]?.contents),
      /Format correction/,
    );
    assert.deepEqual(await f.runtime().run(workflow), first);
    assert.equal(model.calls, 3);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) n FROM ledger").get()?.n,
      3,
    );
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) n FROM sessions").get()?.n,
      1,
    );
  } finally {
    await h.close();
    f.close();
  }
});

test("malformed structured output retains raw receipt and does not resend on replay", async () => {
  const f = fixture();
  const model = new Model(async function* () {
    yield response("bad");
  });
  const h = harness(model);
  const run = () =>
    f
      .runtime()
      .run((r) =>
        r.agent(
          "invalid",
          { harness: h, model: pricing.model, mode: "write" },
          { prompt: "task", schema: { type: "object" } },
        ),
      );
  try {
    await assert.rejects(run);
    await assert.rejects(run);
    assert.equal(model.calls, 1);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) n FROM ledger").get()?.n,
      1,
    );
  } finally {
    await h.close();
    f.close();
  }
});

test("missing usage is unresolved and prevents success or automatic redispatch", async () => {
  const f = fixture();
  const model = new Model(async function* () {
    yield { content: { role: "model", parts: [{ text: "ok" }] } };
  });
  const h = harness(model);
  const run = () =>
    f
      .runtime()
      .run((r) =>
        r.agent(
          "a",
          { harness: h, model: pricing.model, mode: "write" },
          { prompt: "task" },
        ),
      );
  try {
    await assert.rejects(run, /accounting/i);
    await assert.rejects(run);
    assert.equal(model.calls, 1);
    const receipt = f.store.db
      .prepare("SELECT receipt FROM invocations")
      .get()?.receipt;
    assert.equal(JSON.parse(String(receipt)).accounting.usd, null);
  } finally {
    await h.close();
    f.close();
  }
});

test("cancellation drops late success but captures usage and closes the actual model generator", async () => {
  const model = new Model(async function* () {
    await sleep(30);
    yield response();
  });
  const h = harness(model);
  const controller = new AbortController();
  const s = sink();
  setTimeout(() => controller.abort(), 5);
  const result = await h.invoke(
    { ...request(), signal: controller.signal },
    s.value,
  );
  assert.equal(result.status, "cancelled");
  assert.equal(result.text, "");
  assert.equal(result.accounting.status, "incomplete");
  assert.ok((result.accounting.usd ?? 0) > 0);
  assert.equal(model.closed, 1);
  await h.close();
});

test("runtime timeout and replay never accept a model which returns after abort", async () => {
  const f = fixture();
  const model = new Model(async function* () {
    await sleep(30);
    yield response();
  });
  const h = harness(model);
  const run = () =>
    f
      .runtime()
      .run((r) =>
        r.agent(
          "late",
          { harness: h, model: pricing.model, mode: "write", timeoutMs: 5 },
          { prompt: "task" },
        ),
      );
  try {
    await assert.rejects(run);
    await assert.rejects(run);
    assert.equal(model.calls, 1);
    assert.equal(model.closed, 1);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) n FROM ledger").get()?.n,
      1,
    );
  } finally {
    await h.close();
    f.close();
  }
});

test("model failure retains known subtotal as incomplete and cleans up", async () => {
  const model = new Model(async function* () {
    yield response();
    throw new Error("native failure");
  });
  const h = harness(model);
  const s = sink();
  const result = await h.invoke(request(), s.value);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /native failure/);
  assert.equal(result.accounting.status, "incomplete");
  assert.ok((result.accounting.usd ?? 0) > 0);
  assert.equal(model.closed, 1);
  await h.close();
});

test("usage snapshots from one call are not added twice", async () => {
  const model = new Model(async function* () {
    yield { ...response(), content: undefined };
    yield response();
  });
  const h = harness(model);
  const result = await h.invoke(request(), sink().value);
  assert.equal(result.status, "succeeded");
  assert.equal(result.accounting.tokens?.input, 8);
  assert.equal(
    result.accounting.raw &&
      typeof result.accounting.raw === "object" &&
      !Array.isArray(result.accounting.raw)
      ? result.accounting.raw.modelCalls
      : null,
    1,
  );
  await h.close();
});

test("bounded tool loop stops before the second underlying model call", async () => {
  const model = new Model(async function* () {
    yield {
      ...response(),
      content: {
        role: "model",
        parts: [{ functionCall: { name: "again", args: {} } }],
      },
    };
  });
  const h = harness(model, {
    maxLlmCalls: 1,
    tools: [
      new FunctionTool({
        name: "again",
        description: "again",
        execute: () => ({ ok: true }),
      }),
    ],
  });
  const result = await h.invoke(request(), sink().value);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /limit|bound/i);
  assert.equal(model.calls, 1);
  assert.equal(result.accounting.status, "complete");
  await h.close();
});

test("unsupported sandbox, model selectors and native sessions reject before execution", async () => {
  const model = new Model();
  const h = harness(model);
  await assert.rejects(
    h.preflight({ ...request(), mode: "read-only" }),
    /sandbox/,
  );
  await assert.rejects(
    h.preflight({ ...request(), model: "other" }),
    /matching/,
  );
  await assert.rejects(
    h.preflight({
      ...request(),
      session: { nativeId: "foreign", baseline: {} },
    }),
    /unavailable/,
  );
  const first = await h.invoke(request(), sink().value);
  assert.ok(first.session);
  await assert.rejects(
    h.preflight({ ...request(), session: { ...first.session, baseline: {} } }),
    /baseline/,
  );
  const restarted = harness(new Model());
  await assert.rejects(
    restarted.preflight({ ...request(), session: first.session }),
    /unavailable/,
  );
  assert.equal(model.calls, 1);
  await h.close();
  await restarted.close();
  await assert.rejects(h.preflight(request()), /closed/);
});

test("active native session ownership prevents concurrent continuation and close", async () => {
  let n = 0;
  let started!: () => void;
  let release!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = new Model(async function* () {
    if (++n === 2) {
      started();
      await wait;
    }
    yield response();
  });
  const h = harness(model);
  const first = await h.invoke(request(), sink().value);
  const next = h.invoke({ ...request(), session: first.session }, sink().value);
  await running;
  await assert.rejects(
    h.preflight({ ...request(), session: first.session }),
    /busy/,
  );
  await assert.rejects(h.close(), /active/);
  release();
  const second = await next;
  assert.equal(second.status, "succeeded");
  await assert.rejects(
    h.preflight({ ...request(), session: first.session }),
    /baseline/,
  );
  assert.equal(model.calls, 2);
  await h.close();
});

class LocalAgent extends BaseAgent {
  constructor() {
    super({ name: "local_agent" });
  }
  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    context.abortSignal?.throwIfAborted();
    yield createEvent({
      author: this.name,
      content: { role: "model", parts: [{ text: "native-agent" }] },
    });
  }
  protected override runLiveImpl(): never {
    throw new Error("unsupported");
  }
}
test("actual custom BaseAgent and native Workflow run inside a fixed component boundary", async () => {
  for (const create of [
    () => new LocalAgent(),
    () =>
      new Workflow({
        name: "local_graph",
        dynamicEntry: async () => ({ ok: true, route: "local" }),
      }),
  ]) {
    const model = new Model();
    const h = harness(model, {
      root: { revision: "native-root-v1", modelUsage: "injected-only", create },
    });
    const result = await h.invoke(request(), sink().value);
    assert.equal(result.status, "succeeded", result.error);
    assert.equal(model.calls, 0);
    assert.equal(result.accounting.usd, 0);
    assert.ok(
      result.text.includes("native-agent") ||
        result.text.includes('"route":"local"'),
    );
    await h.close();
  }
});

test("native root refuses agent overrides and every model-policy field binds identity", () => {
  const model = new Model();
  const h = harness(model);
  const changed = harness(model, { revision: "v2", instruction: "native" });
  assert.notDeepEqual(h.identity, changed.identity);
  assert.throws(
    () =>
      harness(model, {
        root: {
          revision: "native",
          modelUsage: "injected-only",
          create: () => new LocalAgent(),
        },
        instruction: "override",
      }),
    /overrides/,
  );
  assert.throws(() => harness(model, { maxLlmCalls: 0 }), /positive/);
  assert.deepEqual(h.capabilities.tools, []);
  assert.equal(h.capabilities.nativeSystem, true);
  assert.equal(h.capabilities.strictTools, true);
  assert.ok(Object.isFrozen(h.capabilities.tools));
  const native = harness(model, {
    root: {
      revision: "fixed",
      modelUsage: "injected-only",
      create: () => new LocalAgent(),
    },
  });
  assert.equal(native.capabilities.nativeSystem, false);
  assert.equal(native.capabilities.strictTools, false);
  assert.equal(native.capabilities.tools, undefined);
});

test("failed native receipts stop the runtime and replay without another ADK call", async () => {
  const f = fixture();
  const model = new Model(async function* () {
    yield {
      ...response(),
      errorCode: "MODEL_FAILURE",
      errorMessage: "native denied",
    };
  });
  const h = harness(model);
  const run = () =>
    f
      .runtime()
      .run((r) =>
        r.agent(
          "failed",
          { harness: h, model: pricing.model, mode: "write" },
          { prompt: "task" },
        ),
      );
  try {
    await assert.rejects(run);
    await assert.rejects(run);
    assert.equal(model.calls, 1);
    const receipt = JSON.parse(
      String(
        f.store.db.prepare("SELECT receipt FROM invocations").get()?.receipt,
      ),
    );
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.accounting.status, "incomplete");
    assert.ok(receipt.accounting.usd > 0);
  } finally {
    await h.close();
    f.close();
  }
});

test("native graph model nodes share the measured bound and only root output is selected", async () => {
  const model = new Model();
  const h = harness(model, {
    root: {
      revision: "two-native-nodes",
      modelUsage: "injected-only",
      create: (tracked) =>
        new Workflow({
          name: "delivery_graph",
          dynamicEntry: async (ctx, input) => {
            const first = await ctx.runNode(
              new LlmAgent({ name: "review_node", model: tracked }),
              input,
            );
            const second = await ctx.runNode(
              new LlmAgent({ name: "verify_node", model: tracked }),
              input,
            );
            return { review: first.output, verify: second.output, root: true };
          },
        }),
    },
  });
  const result = await h.invoke(request(), sink().value);
  assert.equal(result.status, "succeeded", result.error);
  assert.deepEqual(JSON.parse(result.text), {
    review: "ok",
    verify: "ok",
    root: true,
  });
  assert.equal(model.calls, 2);
  assert.equal(result.accounting.tokens?.input, 16);
  await h.close();
});

test("native graph cannot use an untracked LlmAgent model", async () => {
  const tracked = new Model();
  const hidden = new Model();
  const h = harness(tracked, {
    root: {
      revision: "reject-untracked",
      modelUsage: "injected-only",
      create: () => new LlmAgent({ name: "hidden", model: hidden }),
    },
  });
  const result = await h.invoke(request(), sink().value);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /boundary/);
  assert.equal(hidden.calls, 0);
  assert.equal(tracked.calls, 0);
  assert.equal(result.accounting.status, "incomplete");
  assert.equal(result.accounting.usd, null);
  await h.close();
});

test("model reroutes, invalid or non-text usage stay incomplete", async () => {
  for (const value of [
    { ...response(), modelVersion: "unpriced-model" },
    {
      ...response(),
      usageMetadata: { promptTokenCount: -1, candidatesTokenCount: 1 },
    },
    {
      ...response(),
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 1,
        toolUsePromptTokenCount: 1,
      },
    },
    {
      ...response(),
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 1,
        promptTokensDetails: [{ modality: "IMAGE", tokenCount: 1 }],
      },
    },
  ] as LlmResponse[]) {
    const model = new Model(async function* () {
      yield value;
    });
    const h = harness(model);
    const result = await h.invoke(request(), sink().value);
    assert.equal(result.accounting.status, "incomplete");
    assert.equal(result.accounting.usd, null);
    assert.equal(model.calls, 1);
    await h.close();
  }
});

test("native authentication wait and event floods cannot produce success", async () => {
  class Waiting extends BaseAgent {
    constructor() {
      super({ name: "waiting" });
    }
    protected override async *runAsyncImpl(
      context: InvocationContext,
    ): AsyncGenerator<Event, void, void> {
      context.abortSignal?.throwIfAborted();
      yield createEvent({
        author: this.name,
        actions: {
          requestedToolConfirmations: {
            wait: { hint: "approve", confirmed: false },
          },
        },
        content: { role: "model", parts: [{ text: "not complete" }] },
      });
    }
    protected override runLiveImpl(): never {
      throw new Error("unsupported");
    }
  }
  const model = new Model();
  const h = harness(model, {
    root: {
      revision: "waiting",
      modelUsage: "injected-only",
      create: () => new Waiting(),
    },
  });
  const result = await h.invoke(request(), sink().value);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /waiting/);
  assert.equal(result.text, "");
  await h.close();
  const flood = harness(
    new Model(async function* () {
      yield response("one");
      yield response("two");
    }),
    { maxEvents: 1 },
  );
  const flooded = await flood.invoke(request(), sink().value);
  assert.equal(flooded.status, "failed");
  assert.match(flooded.error ?? "", /event bound/);
  await flood.close();
});

test("local executable proof uses only the official SDK seam", async () => {
  const f = fixture();
  const h = localAdkProof();
  try {
    const result = await f
      .runtime()
      .run((r) =>
        r.agent(
          "proof",
          { harness: h, model: localPricing.model, mode: "write" },
          { prompt: "show marker" },
        ),
      );
    assert.deepEqual(JSON.parse(result.text), {
      ok: true,
      marker: "local-adk",
    });
  } finally {
    await h.close();
    f.close();
  }
});
