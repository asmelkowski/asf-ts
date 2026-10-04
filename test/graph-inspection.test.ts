import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraphInspection } from "../src/portable/inspection.js";
import { executeDocument, type Component } from "../src/portable/execute.js";
import { Store } from "../src/store.js";
import { fixture, Scripted, accounting } from "./helpers.js";
import { portableFixture } from "./portable-fixtures.js";
import {
  graphDocument,
  graphBindings,
  recordedGraph,
  sourceLiteral,
} from "./graph-fixtures.js";
import type { WorkflowDefinition } from "../src/composition.js";
import type { Json } from "../src/types.js";

test("stored authored source maps exact nested receipts and separates lifecycle from verdict", async () => {
  const f = await recordedGraph();
  try {
    const view = buildGraphInspection(f.store, "run");
    assert.equal(view.workflowWindowComplete, true);
    assert.equal(view.actionWindowComplete, true);
    assert.equal(view.documents[0]!.validated, true);
    assert.equal(view.graphs.length, 2);
    const parent = view.graphs[0]!,
      child = view.graphs[1]!;
    assert.equal(parent.lifecycle, "completed");
    assert.equal(parent.businessPassed, false);
    assert.equal(child.businessPassed, false);
    assert.equal(child.source!.version, sourceLiteral);
    const call = parent.nodes.find((n) => n.source.id === "child")!;
    assert.equal(call.children[0]!.invocationId, child.invocationId);
    assert.equal(call.actions.length, 0);
    assert.equal(child.parentLink!.invocationId, parent.invocationId);
    assert.deepEqual(
      parent.nodes.find((n) => n.source.id === "decision")!.edges,
      [
        { target: "child", label: "true" },
        { target: "rejected", label: "false" },
      ],
    );
    assert.equal(
      parent.nodes.find((n) => n.source.id === "rejected")!.actions.length,
      0,
    );
    const agent = child.nodes.find((n) => n.source.id === "judgement")!
      .actions[0]!;
    assert.equal(agent.nativeInvocationIds.length, 2);
    assert.equal(agent.knownUsd, 0.002);
    assert.equal(view.legacy.totals.knownUsd, 0.002);
    assert.equal(agent.unresolved, 0);
    assert.equal(parent.dispatchesUsed, 2);
    assert.equal(parent.unmappedActions.length, 0);
  } finally {
    f.close();
  }
});

test("actual replay events do not invent descendant replay or add cost", async () => {
  const f = await recordedGraph();
  try {
    const before = buildGraphInspection(f.store, "run");
    await f.replay();
    const after = buildGraphInspection(f.store, "run");
    assert.equal(after.graphs[0]!.replayEvents, 1);
    assert.equal(after.graphs[1]!.replayEvents, 0);
    assert.equal(
      after.graphs[1]!.nodes.find((n) => n.source.id === "judgement")!
        .actions[0]!.replayEvents,
      0,
    );
    assert.deepEqual(after.legacy.invocations, before.legacy.invocations);
    assert.equal(f.harness.calls.length, 2);
  } finally {
    f.close();
  }
});

test("partial workflow/action windows keep source independent and verify off-page parents", async () => {
  const f = await recordedGraph();
  try {
    const first = buildGraphInspection(f.store, "run", { limit: 1 });
    assert.equal(
      first.graphs[0]!.nodes.find((n) => n.source.id === "child")!.children
        .length,
      0,
    );
    assert.equal(first.workflowWindowComplete, false);
    assert.equal(first.actionWindowComplete, false);
    assert.match(first.warnings.join(" "), /outside this window/);
    const next = buildGraphInspection(f.store, "run", { offset: 1, limit: 1 });
    assert.equal(next.graphs[0]!.parentLink!.pageOffset, 0);
    assert.equal(next.documents.length, 1);
    const focused = buildGraphInspection(f.store, "run", {
      offset: 3,
      limit: 1,
      invocationId: first.graphs[0]!.invocationId,
    });
    assert.equal(focused.graphs.length, 0);
    assert.equal(focused.focusedGraph!.dispatchesUsed, 2);
    assert.equal(
      focused.focusedGraph!.definitionIdentity,
      first.graphs[0]!.definitionIdentity,
    );
    assert.throws(
      () => buildGraphInspection(f.store, "run", { limit: 201 }),
      /window/,
    );
    assert.throws(
      () => buildGraphInspection(f.store, "run", { invocationId: "foreign" }),
      /not found/,
    );
  } finally {
    f.close();
  }
});

test("malformed ledger payloads stay unresolved despite a completed scalar flag", async () => {
  const f = await recordedGraph();
  try {
    const child = buildGraphInspection(f.store, "run").graphs[1]!;
    const invocation = child.nodes.find(
      (node) => node.source.id === "judgement",
    )!.actions[0]!.nativeInvocationIds[0]!;
    // This fixture models corrupt retained data, not a supported ledger mutation.
    f.store.db.exec("DROP TRIGGER ledger_immutable");
    f.store.db
      .prepare("UPDATE ledger SET data=? WHERE invocation=?")
      .run('{"status":"complete","usd":"malformed"}', invocation);
    const action = () =>
      buildGraphInspection(f.store, "run").graphs[1]!.nodes.find(
        (node) => node.source.id === "judgement",
      )!.actions[0]!;
    assert.equal(action().unresolved, 1);
    assert.equal(action().knownUsd, 0.001);
    f.store.db
      .prepare("UPDATE invocations SET status='uncertain' WHERE id=?")
      .run(invocation);
    assert.equal(
      action().unresolved,
      1,
      "Invalid payload and uncertain flags count the same receipt once",
    );
  } finally {
    f.close();
  }
});

test("failed native work retains partial cost without an approved child or terminal node", async () => {
  const f = fixture();
  try {
    const h = new Scripted([
      async (_request, sink) => {
        sink.report("known", accounting);
        throw new Error("transport unknown");
      },
    ]);
    await assert.rejects(
      f
        .runtime()
        .run((r) =>
          executeDocument(
            r,
            graphDocument(),
            { ok: true },
            { bindings: graphBindings(h) },
          ),
        ),
      /transport unknown/,
    );
    const view = buildGraphInspection(f.store, "run"),
      child = view.graphs[1]!;
    assert.equal(view.graphs[0]!.lifecycle, "failed");
    assert.equal(view.graphs[0]!.businessPassed, null);
    assert.equal(child.businessPassed, null);
    const action = child.nodes.find((n) => n.source.id === "judgement")!
      .actions[0]!;
    assert.equal(action.unresolved, 1);
    assert.equal(action.knownUsd, 0.001);
    assert.equal(
      view.legacy.invocations.find((n) => n.action === action.id)!.receipt,
      null,
    );
    assert.equal(
      child.nodes.find((n) => n.source.id === "end")!.actions.length,
      0,
    );
  } finally {
    f.close();
  }
});

test("repeat and parallel links use declared slots and exact child names", async () => {
  const f = fixture();
  try {
    const d = portableFixture(),
      root = d.workflows.delivery!;
    root.outputSchema = { type: "boolean" };
    root.start = "loop";
    root.nodes = [
      {
        id: "loop",
        kind: "repeat",
        workflow: "review",
        input: { ok: false },
        until: { left: { $ref: "#/result/ok" }, op: "truthy" },
        maxIterations: 2,
        next: "join",
      },
      {
        id: "join",
        kind: "parallel",
        join: "any",
        branches: [
          { id: "yes", workflow: "review", input: { ok: true } },
          { id: "no", workflow: "review", input: { ok: false } },
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
    await f.runtime().run((r) => executeDocument(r, d, { ok: true }));
    const graph = buildGraphInspection(f.store, "run").graphs[0]!;
    assert.deepEqual(
      graph.nodes[0]!.children.map((c) => c.slot),
      ["iteration 1", "iteration 2"],
    );
    assert.deepEqual(
      graph.nodes[1]!.children.map((c) => c.slot),
      ["branch yes", "branch no"],
    );
    assert.deepEqual(
      graph.nodes[1]!.children.map((c) => c.businessPassed),
      [true, false],
    );
  } finally {
    f.close();
  }
});

test("custom inner actions map only within their registered node namespace", async () => {
  const f = fixture();
  try {
    const d = portableFixture(),
      child = d.workflows.review!;
    child.start = "registered";
    child.nodes = [
      {
        id: "registered",
        kind: "custom",
        component: "component",
        input: { $ref: "#/input" },
        inputSchema: child.inputSchema,
        outputSchema: child.outputSchema,
        next: "end",
      },
      { id: "end", kind: "end", output: { $ref: "#/nodes/registered" } },
    ];
    const component: Component = {
      identity: { v: 1 },
      inputSchema: child.inputSchema,
      outputSchema: child.outputSchema,
      readOnly: true,
      run: async (s, input) => s.local("inner", { v: 1 }, () => input),
    };
    await f
      .runtime()
      .run((r) =>
        executeDocument(r, d, { ok: true }, { components: { component } }),
      );
    const node = buildGraphInspection(f.store, "run").graphs[1]!.nodes[0]!;
    assert.equal(node.actions.length, 2);
    assert.equal(node.actions.filter((a) => a.insideComponent).length, 1);
    assert.ok(
      node.actions
        .find((a) => a.insideComponent)!
        .id.endsWith("/registered/inner"),
    );
  } finally {
    f.close();
  }
});

test("similar IDs and kind mismatches remain unmapped instead of implying declared execution", async () => {
  const f = fixture();
  try {
    const d = portableFixture(),
      w = d.workflows.delivery!;
    const definition: WorkflowDefinition = {
      name: "delivery",
      version: w.version,
      identity: "manual",
      inputSchema: w.inputSchema,
      outputSchema: w.outputSchema,
      document: d as unknown as Json,
      run: async (s, input) => {
        await s.local("child", {}, () => input);
        await s.local("child-like", {}, () => input);
        return { passed: true, value: input };
      },
    };
    await f
      .runtime()
      .run((r) => r.workflow("workflow", definition, { ok: true }));
    const graph = buildGraphInspection(f.store, "run").graphs[0]!;
    assert.equal(graph.nodes[0]!.actions.length, 0);
    assert.deepEqual(
      graph.unmappedActions.map((a) => a.id.split("/").at(-1)),
      ["child", "child-like"],
    );
  } finally {
    f.close();
  }
});

test("corrupt authored digests and incompatible stored definitions cannot supply graph overlays", async () => {
  const f = await recordedGraph();
  try {
    f.store.db.exec("DROP TRIGGER workflow_document_immutable");
    f.store.db.prepare("UPDATE workflow_documents SET value='{}'").run();
    const view = buildGraphInspection(f.store, "run");
    assert.equal(view.documents[0]!.validated, false);
    assert.equal(view.graphs[0]!.nodes.length, 0);
    assert.ok(view.legacy.invocations.length > 0);
    assert.match(view.warnings.join(" "), /digest disagrees/);
  } finally {
    f.close();
  }
});

test("a concurrent commit retries snapshots; continuously changing reads fail explicitly", async () => {
  const f = await recordedGraph(),
    writer = new Store(f.store.path);
  try {
    const inspect = f.store.workflowInspect.bind(f.store);
    let count = 0;
    f.store.workflowInspect = (...args) => {
      const rows = inspect(...args);
      if (++count === 1)
        writer.db
          .prepare("UPDATE runs SET error='new snapshot' WHERE id='run'")
          .run();
      return rows;
    };
    const view = buildGraphInspection(f.store, "run");
    assert.equal(view.legacy.run!.error, "new snapshot");
    assert.equal(count, 4);
    f.store.workflowInspect = (...args) => {
      const rows = inspect(...args);
      writer.db
        .prepare("UPDATE runs SET error=? WHERE id='run'")
        .run(String(++count));
      return rows;
    };
    assert.throws(
      () => buildGraphInspection(f.store, "run"),
      /changed while reading/,
    );
  } finally {
    writer.close();
    f.close();
  }
});

test("original v1 code-authored stores retain legacy inspection without fabricated graph", () => {
  const f = fixture(),
    path = join(f.dir, "original.db");
  try {
    const db = new DatabaseSync(path);
    db.exec(
      readFileSync(new URL("./fixtures/store-v1.sql", import.meta.url), "utf8"),
    );
    db.exec(
      "INSERT INTO runs VALUES('legacy','wf','completed',NULL,NULL,NULL,1)",
    );
    db.close();
    const reader = new Store(path, true);
    try {
      const view = buildGraphInspection(reader, "legacy");
      assert.equal(view.exists, true);
      assert.deepEqual(view.graphs, []);
      assert.deepEqual(view.documents, []);
      assert.equal(view.legacy.run!.status, "completed");
      assert.equal(buildGraphInspection(reader, "unknown").exists, false);
    } finally {
      reader.close();
    }
  } finally {
    f.close();
  }
});
