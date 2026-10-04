import test from "node:test";
import assert from "node:assert/strict";
import { fixture, Scripted, accounting } from "./helpers.js";
import { portableFixture } from "./portable-fixtures.js";
import { executeDocument, type Component } from "../src/portable/execute.js";
import type { WorkflowDocument } from "../src/portable/model.js";
import type { ProfileBinding } from "../src/profiles.js";
const bindings = (h: Scripted): Record<string, ProfileBinding> => ({
  worker: {
    agent: { harness: h, model: "test-model", mode: "read-only" },
    capabilities: {
      revision: "scripted-1",
      modes: ["read-only"],
      fresh: true,
      nativeSystem: false,
      strictTools: false,
    },
  },
});
function agentDocument(): WorkflowDocument {
  const d = portableFixture();
  d.profiles = { worker: {} };
  d.workflows.review!.defaultProfile = "worker";
  d.workflows.review!.nodes = [
    {
      id: "agent",
      kind: "agent",
      prompt: "Return typed ok",
      context: { $ref: "#/input" },
      outputSchema: d.workflows.review!.outputSchema,
      next: "end",
    },
    {
      id: "end",
      kind: "end",
      output: { $ref: "#/nodes/agent" },
      passed: { $ref: "#/nodes/agent/ok" },
    },
  ];
  d.workflows.review!.start = "agent";
  return d;
}
test("typed child reuses root runtime, preserves business rejection, and layout replay sends nothing", async () => {
  const f = fixture();
  try {
    const d = portableFixture();
    const run = () =>
      f.runtime().run((r) => executeDocument(r, d, { ok: false }));
    const a = await run();
    assert.equal(a.passed, false);
    assert.deepEqual(a.value, { ok: false });
    const invocations = f.store.inspect("run").totals.invocations;
    d.workflows.delivery!.layout = { child: { x: 20, y: 30 } };
    assert.deepEqual(await run(), a);
    assert.equal(f.store.inspect("run").totals.invocations, invocations);
    const data = f.store.workflowInspect("run");
    assert.equal(data.workflows.length, 2);
    assert.equal(
      data.workflows.filter((w) => w.binding.parentInvocation !== null).length,
      1,
    );
    const recorded = data.documents[0]!.value as unknown as WorkflowDocument;
    assert.equal(recorded.workflows.delivery!.layout, undefined);
  } finally {
    f.close();
  }
});
test("same child works as standalone and in two independently named parent runs", async () => {
  const f = fixture();
  try {
    const d = portableFixture();
    for (const [runId, root] of [
      ["standalone", "review"],
      ["delivery", "delivery"],
      ["existing-pr", "delivery"],
    ] as const) {
      const result = await f
        .runtime({ runId, workflowIdentity: runId })
        .run((r) => executeDocument(r, { ...d, root }, { ok: true }));
      assert.equal(result.passed, true);
      assert.deepEqual(result.value, { ok: true });
      assert.equal(result.provenance.runId, runId);
    }
  } finally {
    f.close();
  }
});
test("changed closure or selected input cannot replay a completed portable child", async () => {
  const f = fixture();
  try {
    const d = portableFixture();
    await f.runtime().run((r) => executeDocument(r, d, { ok: true }));
    await assert.rejects(
      f.runtime().run((r) => executeDocument(r, d, { ok: false })),
      /changed|binding/i,
    );
    d.workflows.review!.version = "2";
    await assert.rejects(
      f.runtime().run((r) => executeDocument(r, d, { ok: true })),
      /changed|binding/i,
    );
  } finally {
    f.close();
  }
});
test("native failure and cancellation stop both first execution and replay before terminal approval", async () => {
  for (const state of ["failed", "cancelled", "throw"] as const) {
    const f = fixture();
    try {
      const h = new Scripted([
        async () => {
          if (state === "throw") throw new Error("transport unknown");
          return {
            status: state,
            text: '{"ok":true}',
            accounting: accounting,
            error: "native stopped",
          };
        },
      ]);
      const d = agentDocument(),
        run = () =>
          f
            .runtime()
            .run((r) =>
              executeDocument(r, d, { ok: true }, { bindings: bindings(h) }),
            );
      await assert.rejects(run());
      await assert.rejects(run());
      assert.equal(h.calls.length, 1);
      assert.ok(
        !f.store
          .inspect("run")
          .actions.some(
            (a) => a.id.endsWith("/end") && a.status === "completed",
          ),
      );
    } finally {
      f.close();
    }
  }
});
test("known invalid custom output is retained without re-executing side effects", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const d = portableFixture(),
      w = d.workflows.review!,
      component: Component = {
        identity: { revision: 1 },
        readOnly: true,
        inputSchema: w.inputSchema,
        outputSchema: w.outputSchema,
        run: async () => {
          calls++;
          return { ok: 4 };
        },
      };
    w.start = "custom";
    w.nodes = [
      {
        id: "custom",
        kind: "custom",
        component: "review",
        input: { $ref: "#/input" },
        inputSchema: w.inputSchema,
        outputSchema: w.outputSchema,
        next: "end",
      },
      { id: "end", kind: "end", output: { $ref: "#/nodes/custom" } },
    ];
    const run = () =>
      f
        .runtime()
        .run((r) =>
          executeDocument(
            r,
            d,
            { ok: true },
            { components: { review: component } },
          ),
        );
    await assert.rejects(run(), /output/);
    await assert.rejects(run(), /output/);
    assert.equal(calls, 1);
    assert.ok(
      f.store
        .inspect("run")
        .invocations.some((i) => i.kind === "local" && i.receipt !== null),
    );
  } finally {
    f.close();
  }
});
test("parallel all/any business joins drain every child and reject effectful branches before commands", async () => {
  for (const join of ["all", "any"] as const) {
    const f = fixture();
    try {
      const d = portableFixture(),
        w = d.workflows.delivery!;
      w.outputSchema = { type: "boolean" };
      w.start = "join";
      w.nodes = [
        {
          id: "join",
          kind: "parallel",
          join,
          branches: [
            { id: "one", workflow: "review", input: { ok: true } },
            { id: "two", workflow: "review", input: { ok: false } },
          ],
          next: "end",
        },
        {
          id: "end",
          kind: "end",
          output: { $ref: "#/nodes/join/passed" },
          passed: { $ref: "#/nodes/join/passed" },
        },
      ];
      const result = await f
        .runtime()
        .run((r) => executeDocument(r, d, { ok: true }));
      assert.equal(result.value, join === "any");
      assert.equal(f.store.workflowInspect("run").workflows.length, 3);
      const bad = structuredClone(d);
      bad.workflows.review!.nodes.unshift({
        id: "command",
        kind: "command",
        argv: [process.execPath, "-e", ""],
        next: "end",
      });
      bad.workflows.review!.start = "command";
      await assert.rejects(
        f
          .runtime({ runId: "effects", workflowIdentity: "effects" })
          .run((r) => executeDocument(r, bad, { ok: true })),
        /isolation/,
      );
      assert.equal(f.store.inspect("effects").totals.invocations, 0);
    } finally {
      f.close();
    }
  }
});
test("repeat exhaustion is a durable negative verdict with exact finite child attempts", async () => {
  const f = fixture();
  try {
    const d = portableFixture(),
      w = d.workflows.delivery!;
    w.outputSchema = { type: "boolean" };
    w.start = "loop";
    w.nodes = [
      {
        id: "loop",
        kind: "repeat",
        workflow: "review",
        input: { ok: false },
        until: { left: { $ref: "#/result/ok" }, op: "truthy" },
        maxIterations: 3,
        next: "end",
      },
      {
        id: "end",
        kind: "end",
        output: { $ref: "#/nodes/loop/passed" },
        passed: { $ref: "#/nodes/loop/passed" },
      },
    ];
    const run = () =>
      f.runtime().run((r) => executeDocument(r, d, { ok: true }));
    assert.equal((await run()).passed, false);
    assert.equal(f.store.workflowInspect("run").workflows.length, 4);
    const count = f.store.inspect("run").totals.invocations;
    assert.equal((await run()).value, false);
    assert.equal(f.store.inspect("run").totals.invocations, count);
  } finally {
    f.close();
  }
});

test("zero logical child allowance permits pure work and rejects model dispatch before reservation", async () => {
  const f = fixture();
  try {
    const pure = portableFixture();
    Object.assign(pure.workflows.delivery!.nodes[0]!, { maxDispatches: 0 });
    assert.equal(
      (await f.runtime().run((r) => executeDocument(r, pure, { ok: true })))
        .passed,
      true,
    );
    const d = agentDocument(),
      h = new Scripted(['{"ok":true}']);
    Object.assign(d.workflows.delivery!.nodes[0]!, { maxDispatches: 0 });
    await assert.rejects(
      f
        .runtime({ runId: "zero", workflowIdentity: "zero" })
        .run((r) =>
          executeDocument(r, d, { ok: true }, { bindings: bindings(h) }),
        ),
      /dispatch limit/i,
    );
    assert.equal(h.calls.length, 0);
    assert.equal(f.store.inspect("zero").totals.invocations, 0);
  } finally {
    f.close();
  }
});
