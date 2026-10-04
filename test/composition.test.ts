import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, Scripted, accounting } from "./helpers.js";
import { Store } from "../src/store.js";
import { assertSchema, type WorkflowDefinition } from "../src/composition.js";
import type { Scope } from "../src/runtime.js";
import type { Json, Receipt } from "../src/types.js";
import { sleep } from "../src/util.js";

const definition = (
  name: string,
  run: (scope: Scope, input: Json) => Promise<{ passed: boolean; value: Json }>,
  extra: Partial<WorkflowDefinition> = {},
): WorkflowDefinition => ({
  name,
  version: "1",
  identity: name + "-code-1",
  inputSchema: {},
  outputSchema: {},
  run,
  ...extra,
});
const invocation = "delivery/workflow-v1/attempt-01";
const receipt = (text: string): Receipt => ({
  status: "succeeded",
  text,
  accounting,
});

test("one typed child runs standalone and inside two independent parents", async () => {
  const f = fixture();
  try {
    const child = definition("shared", async (s, value) => ({
      passed: true,
      value: await s.local("value", { v: 1 }, () => value),
    }));
    const parent = (name: string) =>
      definition(name, async (s) => {
        const result = await s.workflow("shared", child, 7);
        return { passed: result.passed, value: result.value };
      });
    const results = await f
      .runtime()
      .run(async (r) => [
        await r.workflow("direct", child, 7),
        await r.workflow("one", parent("one"), null),
        await r.workflow("two", parent("two"), null),
      ]);
    assert.deepEqual(
      results.map((r) => r.value),
      [7, 7, 7],
    );
    const rows = f.store.workflowInspect("run").workflows;
    assert.equal(rows.length, 5);
    assert.equal(new Set(rows.map((row) => row.id)).size, 5);
    assert.equal(rows.filter((row) => row.parent !== null).length, 2);
    assert.equal(f.store.workflowInspect("run").counts.actions, 3);
  } finally {
    f.close();
  }
});

test("nested workflows preserve business verdicts, provenance, source snapshots and replay", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const child = definition("review", async (s, input) => {
      calls++;
      return {
        passed: false,
        value: await s.local("check", { revision: 1 }, () => input),
      };
    });
    const parent = definition(
      "delivery",
      async (s, input) => {
        const result = await s.workflow("review", child, input);
        assert.equal(result.provenance.parentInvocation, invocation);
        return { passed: result.passed, value: result.value };
      },
      { document: { authored: { layout: "first", nodes: ["review"] } } },
    );
    const run = () =>
      f
        .runtime()
        .run((r) => r.workflow("delivery", parent, { revision: "abc" }));
    const result = await run();
    assert.equal(result.passed, false);
    assert.deepEqual(result.value, { revision: "abc" });
    const inspection = f.store.workflowInspect("run");
    assert.equal(inspection.workflows.length, 2);
    assert.equal(inspection.documents.length, 1);
    assert.equal(
      inspection.definitions[0]!.documentIdentity,
      inspection.definitions[1]!.documentIdentity,
    );
    assert.equal(
      inspection.actions[0]!.workflow,
      invocation + "/review/workflow-v1/attempt-01",
    );
    assert.equal(
      inspection.workflows[1]!.deadline <= inspection.workflows[0]!.deadline,
      true,
    );
    const ledger = f.store.db.prepare("SELECT * FROM ledger").all();
    parent.document = { authored: { layout: "new" } };
    assert.deepEqual(await run(), result);
    assert.equal(calls, 1);
    assert.deepEqual(f.store.db.prepare("SELECT * FROM ledger").all(), ledger);
    assert.deepEqual(
      f.store.workflowInspect("run").documents,
      inspection.documents,
    );
    assert.ok(
      f.store.events("run").some((e) => e.type === "workflow.replayed"),
    );
  } finally {
    f.close();
  }
});

test("bound input, schemas, code, and limits reject changes before execution", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const d = definition("flow", async (_s, input) => {
      calls++;
      return { passed: true, value: input };
    });
    const run = (input: Json, options = {}) =>
      f.runtime().run((r) => r.workflow("delivery", d, input, options));
    await run({ selected: 1 });
    await assert.rejects(run({ selected: 2 }), /input, or limits changed/);
    await assert.rejects(
      run({ selected: 1 }, { maxDispatches: 3 }),
      /limits changed/,
    );
    d.identity = "new-code";
    await assert.rejects(run({ selected: 1 }), /definition, input/);
    assert.equal(calls, 1);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM invocations").get()?.n,
      0,
    );
  } finally {
    f.close();
  }
});

test("selected input freezes before async work, and schemas reject invalid input before binding", async () => {
  const f = fixture();
  try {
    const input = { revision: "first" };
    const d = definition(
      "flow",
      async (_s, selected) => {
        await sleep(5);
        assert.equal(Object.isFrozen(selected), true);
        return { passed: true, value: selected };
      },
      {
        inputSchema: {
          type: "object",
          properties: { revision: { type: "string" } },
          required: ["revision"],
          additionalProperties: false,
        },
      },
    );
    const pending = f.runtime().run((r) => r.workflow("delivery", d, input));
    input.revision = "changed";
    assert.deepEqual((await pending).value, { revision: "first" });
    await assert.rejects(
      f
        .runtime({ runId: "invalid" })
        .run((r) => r.workflow("delivery", d, { revision: 1 })),
      /Workflow input/,
    );
    assert.equal(f.store.workflowInspect("invalid").workflows.length, 0);
  } finally {
    f.close();
  }
});

test("raw child result survives invalid output, and failed children require a new attempt", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const d = definition(
      "flow",
      async () => {
        calls++;
        return { passed: true, value: "wrong" };
      },
      { outputSchema: { type: "integer" } },
    );
    const run = (attempt = 1) =>
      f.runtime().run((r) => r.workflow("delivery", d, null, { attempt }));
    await assert.rejects(run(), /output validation/);
    assert.deepEqual(f.store.workflowInspect("run").workflows[0]!.raw, {
      passed: true,
      value: "wrong",
    });
    await assert.rejects(run(), /output validation/);
    assert.equal(calls, 1);
    await assert.rejects(run(2), /output validation/);
    assert.equal(calls, 2);
  } finally {
    f.close();
  }
});

test("retained raw child aggregate recovers the missing commit without rerunning its body", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const d = definition("flow", async () => {
      calls++;
      return { passed: true, value: 42 };
    });
    const run = () => f.runtime().run((r) => r.workflow("delivery", d, null));
    const result = await run();
    // Model the durable crash boundary after raw retention, before the aggregate commit.
    f.store.db.exec("DROP TRIGGER workflow_result_immutable");
    f.store.db
      .prepare(
        "UPDATE workflows SET status='running',result=NULL WHERE run='run'",
      )
      .run();
    assert.deepEqual(await run(), result);
    assert.equal(calls, 1);
  } finally {
    f.close();
  }
});

test("every structured correction uses shared ancestor quota and replay reserves no turns", async () => {
  const f = fixture();
  try {
    const h = new Scripted(["bad", '{"ok":true}']);
    const child = definition("child", async (s) => ({
      passed: true,
      value: (
        await s.agent<Json>(
          "answer",
          { harness: h, model: "test-model" },
          {
            prompt: "answer",
            corrections: 1,
            schema: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
              additionalProperties: false,
            },
          },
        )
      ).value,
    }));
    const parent = definition("parent", async (s) => {
      const value = await s.workflow("child", child, null, {
        maxDispatches: 2,
      });
      return { passed: value.passed, value: value.value };
    });
    const run = () =>
      f
        .runtime()
        .run((r) => r.workflow("delivery", parent, null, { maxDispatches: 2 }));
    await run();
    assert.deepEqual(
      f.store.workflowInspect("run").workflows.map((w) => w.dispatchesUsed),
      [2, 2],
    );
    const ledger = f.store.db.prepare("SELECT * FROM ledger").all();
    await run();
    assert.equal(h.calls.length, 2);
    assert.deepEqual(f.store.db.prepare("SELECT * FROM ledger").all(), ledger);
    assert.throws(
      () => f.store.db.exec("DELETE FROM workflow_usage"),
      /immutable/,
    );
  } finally {
    f.close();
  }
});

test("correction and concurrent children cannot overspend their ancestor quota", async () => {
  const f = fixture();
  try {
    const h = new Scripted([
      async () => {
        await sleep(10);
        return receipt("bad");
      },
    ]);
    const d = definition("flow", async (s) => {
      await s.parallel(
        ["a", "b"].map(
          (id) => async (group) =>
            group.agent(
              id,
              { harness: h, model: "test-model" },
              { prompt: id },
            ),
        ),
      );
      return { passed: true, value: null };
    });
    await assert.rejects(
      f
        .runtime()
        .run((r) => r.workflow("delivery", d, null, { maxDispatches: 1 })),
      /dispatch limit exhausted/,
    );
    assert.equal(h.calls.length, 1);
    assert.equal(
      f.store.workflowInspect("run").workflows[0]!.dispatchesUsed,
      1,
    );
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM ledger").get()?.n,
      1,
    );
    const correction = definition("correction", async (s) => ({
      passed: true,
      value: (
        await s.agent(
          "typed",
          { harness: h, model: "test-model" },
          { prompt: "answer", corrections: 1, schema: { type: "integer" } },
        )
      ).value,
    }));
    await assert.rejects(
      f
        .runtime({ runId: "correction" })
        .run((r) =>
          r.workflow("delivery", correction, null, { maxDispatches: 1 }),
        ),
      /dispatch limit exhausted/,
    );
    assert.equal(h.calls.length, 2);
  } finally {
    f.close();
  }
});

test("paid global budgets remain active with child quotas", async () => {
  const f = fixture();
  try {
    const h = new Scripted(["first", "second"]);
    h.live = true;
    const d = definition("flow", async (s) => {
      await s.agent(
        "one",
        { harness: h, model: "test-model" },
        { prompt: "one" },
      );
      await s.agent(
        "two",
        { harness: h, model: "test-model" },
        { prompt: "two" },
      );
      return { passed: true, value: null };
    });
    await assert.rejects(
      f
        .runtime({
          live: true,
          budget: { id: "paid", maxDispatches: 1, softUsd: 1 },
        })
        .run((r) => r.workflow("delivery", d, null, { maxDispatches: 10 })),
      /Dispatch budget exhausted/,
    );
    assert.equal(h.calls.length, 1);
    assert.equal(
      f.store.workflowInspect("run").workflows[0]!.dispatchesUsed,
      1,
    );
  } finally {
    f.close();
  }
});

test("blocked preflight resumes within its original deadline and does not renew it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  try {
    const h = new Scripted();
    let ready = false;
    h.preflight = async () => {
      if (!ready) throw new Error("not ready");
    };
    const d = definition("flow", async (s) => ({
      passed: true,
      value: (
        await s.agent("a", { harness: h, model: "test-model" }, { prompt: "a" })
      ).value,
    }));
    const run = () =>
      f
        .runtime()
        .run((r) => r.workflow("delivery", d, null, { timeoutMs: 30000 }));
    await assert.rejects(run(), /not ready/);
    const first = f.store.workflowInspect("run").workflows[0]!;
    assert.equal(first.status, "blocked");
    ready = true;
    t.mock.timers.tick(30001);
    await assert.rejects(run(), /deadline expired/);
    assert.equal(
      f.store.workflowInspect("run").workflows[0]!.deadline,
      first.deadline,
    );
    assert.equal(h.calls.length, 0);
  } finally {
    f.close();
  }
});

test("late native completion retains accounting and receipt after child timeout", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  try {
    const h = new Scripted([
      async () => {
        t.mock.timers.tick(30001);
        return receipt("known completion");
      },
    ]);
    const d = definition("flow", async (s) => ({
      passed: true,
      value: (
        await s.agent("a", { harness: h, model: "test-model" }, { prompt: "a" })
      ).value,
    }));
    const run = () =>
      f
        .runtime()
        .run((r) => r.workflow("delivery", d, null, { timeoutMs: 30000 }));
    await assert.rejects(run(), /deadline expired/);
    const native = f.store.invocation("run", invocation + "/a", 0)!;
    assert.ok(native.receipt);
    assert.equal(native.status, "received");
    assert.equal(
      f.store.db.prepare("SELECT complete FROM ledger").get()?.complete,
      1,
    );
    assert.equal(
      f.store.workflowInspect("run").workflows[0]!.status,
      "timeout",
    );
    await assert.rejects(run(), /deadline expired/);
    assert.equal(h.calls.length, 1);
  } finally {
    f.close();
  }
});

test("local callbacks reserve before effects, cache raw JSON, and never resend uncertainty", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const run = () =>
      f.runtime().run((r) =>
        r.local("local", { revision: "abc" }, () => {
          calls++;
          assert.equal(
            f.store.invocation("run", "local", 0)?.status,
            "reserved",
          );
          return { passed: false };
        }),
      );
    assert.deepEqual(await run(), { passed: false });
    assert.deepEqual(await run(), { passed: false });
    assert.equal(calls, 1);
    await assert.rejects(
      f
        .runtime()
        .run((r) => r.local("local", { revision: "changed" }, () => null)),
      /request changed/,
    );
    const uncertain = () =>
      f.runtime({ runId: "uncertain" }).run((r) =>
        r.local("effect", { revision: 1 }, () => {
          calls++;
          throw new Error("lost effect");
        }),
      );
    await assert.rejects(uncertain(), /lost effect/);
    await assert.rejects(uncertain(), /lost effect/);
    assert.equal(calls, 2);
    f.store.db
      .prepare("UPDATE actions SET status='pending' WHERE run='uncertain'")
      .run();
    await assert.rejects(uncertain(), /Uncertain local action/);
    assert.equal(calls, 2);
  } finally {
    f.close();
  }
});

test("local retained receipt recovers action commit without repeating the effect", async () => {
  const f = fixture();
  try {
    let effects = 0;
    const run = () =>
      f.runtime().run((r) =>
        r.local("effect", { v: 1 }, () => {
          effects++;
          return [1, 2];
        }),
      );
    await run();
    f.store.db
      .prepare(
        "UPDATE actions SET status='pending',result=NULL WHERE run='run'",
      )
      .run();
    assert.deepEqual(await run(), [1, 2]);
    assert.equal(effects, 1);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM ledger").get()?.n,
      1,
    );
  } finally {
    f.close();
  }
});

test("parallel failures abort and drain siblings, while false verdicts complete normally", async () => {
  const f = fixture();
  try {
    let cleaned = false;
    const d = definition("flow", async (s) => {
      await assert.rejects(
        s.parallel([
          async () => {
            await sleep(10);
            throw new Error("first failure");
          },
          async (group) => {
            await new Promise<void>((resolve) =>
              group.signal.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            );
            await sleep(10);
            cleaned = true;
            return null;
          },
        ]),
        /first failure/,
      );
      assert.equal(cleaned, true);
      const results = await s.parallel(
        ["one", "two"].map(
          (name) => async (group) =>
            group.workflow(
              name,
              definition(name, async () => ({ passed: false, value: name })),
              null,
            ),
        ),
      );
      assert.deepEqual(
        results.map((value) => value.passed),
        [false, false],
      );
      return { passed: true, value: "fallback" };
    });
    assert.equal(
      (await f.runtime().run((r) => r.workflow("delivery", d, null))).value,
      "fallback",
    );
  } finally {
    f.close();
  }
});

test("a child aggregate waits for unawaited durable descendants and rejects expired scopes", async () => {
  const f = fixture();
  try {
    let completed = false;
    let saved: Scope | undefined;
    const d = definition("flow", async (s) => {
      saved = s;
      void s.local("descendant", { v: 1 }, async () => {
        await sleep(10);
        completed = true;
        return null;
      });
      return { passed: true, value: "done" };
    });
    await f.runtime().run(async (r) => {
      await r.workflow("delivery", d, null);
      assert.equal(completed, true);
      await assert.rejects(
        () => saved!.local("late", { v: 1 }, () => null),
        /no longer active/,
      );
    });
    assert.equal(f.store.invocation("run", invocation + "/late", 0), undefined);
  } finally {
    f.close();
  }
});

test("recursive definitions and forged or preoccupied namespaces fail before effects", async () => {
  const f = fixture();
  try {
    const recursive = definition("recursive", async (s) => {
      await s.workflow("again", recursive, null);
      return { passed: true, value: null };
    });
    await assert.rejects(
      f.runtime().run((r) => r.workflow("delivery", recursive, null)),
      /Recursive workflow/,
    );
    const safe = definition("safe", async () => ({
      passed: true,
      value: null,
    }));
    await f
      .runtime({ runId: "occupied" })
      .run((r) => r.local(invocation + "/taken", {}, () => null));
    await assert.rejects(
      f
        .runtime({ runId: "occupied" })
        .run((r) => r.workflow("delivery", safe, null)),
      /already contains unrelated/,
    );
    await f
      .runtime({ runId: "forged" })
      .run((r) => r.workflow("delivery", safe, null));
    await assert.rejects(
      f
        .runtime({ runId: "forged" })
        .run((r) => r.local(invocation + "/new", {}, () => null)),
      /another scope/,
    );
  } finally {
    f.close();
  }
});

test("explicit draft2020-12 works for workflow and agent schemas without changing draft07 defaults", async () => {
  const f = fixture();
  try {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "array",
      prefixItems: [{ type: "string" }, { type: "integer" }],
      minItems: 2,
      maxItems: 2,
      items: false,
    };
    assertSchema(schema, ["x", 2]);
    assert.throws(() => assertSchema(schema, ["x", "wrong"]), /does not match/);
    const h = new Scripted(['["x",2]']);
    const d = definition(
      "flow",
      async (s) => ({
        passed: true,
        value: (
          await s.agent<Json>(
            "a",
            { harness: h, model: "test-model" },
            { prompt: "a", schema },
          )
        ).value,
      }),
      { outputSchema: schema },
    );
    assert.deepEqual(
      (await f.runtime().run((r) => r.workflow("delivery", d, null))).value,
      ["x", 2],
    );
  } finally {
    f.close();
  }
});

test("inspection pages exact rows, and accepts full authored snapshots up to one MiB", async () => {
  const f = fixture();
  try {
    const d = definition(
      "flow",
      async (s) => {
        for (let i = 0; i < 3; i++) await s.local("node-" + i, { i }, () => i);
        return { passed: true, value: "ok" };
      },
      { document: { authored: "x".repeat(300000) } },
    );
    await f.runtime().run((r) => r.workflow("delivery", d, null));
    const page = f.store.workflowInspect("run", 1, 1);
    assert.equal(page.counts.actions, 3);
    assert.equal(page.actions.length, 1);
    assert.match(page.actions[0]!.id, /node-1$/);
    assert.throws(
      () => f.store.workflowInspect("run", 0, 201),
      /Invalid.*window/,
    );
    assert.throws(
      () => f.store.db.exec("UPDATE workflow_documents SET value='{}'"),
      /immutable/,
    );
  } finally {
    f.close();
  }
});

test("original v1 databases open read-only and migrate additively without changing ledger or events", () => {
  const dir = mkdtempSync(join(tmpdir(), "asf-legacy-")),
    path = join(dir, "legacy.db");
  try {
    const old = new DatabaseSync(path);
    old.exec(
      readFileSync(new URL("./fixtures/store-v1.sql", import.meta.url), "utf8"),
    );
    old
      .prepare(
        "INSERT INTO runs VALUES('legacy','wf','completed',NULL,NULL,NULL,1)",
      )
      .run();
    old
      .prepare(
        "INSERT INTO actions VALUES('legacy','a','identity','completed','\"answer\"',NULL)",
      )
      .run();
    old
      .prepare(
        "INSERT INTO invocations VALUES('native','legacy','a',0,'received',?,NULL,'model',1,NULL,1)",
      )
      .run(JSON.stringify(receipt("answer")));
    old
      .prepare("INSERT INTO ledger VALUES('native',?,0.001,1)")
      .run(JSON.stringify(accounting));
    old
      .prepare("INSERT INTO reports VALUES('native','terminal',?)")
      .run(JSON.stringify(accounting));
    old
      .prepare(
        "INSERT INTO events(run,action,invocation,turn,source,time,type,data) VALUES('legacy','a','native',0,NULL,1,'action.completed','{}')",
      )
      .run();
    const tables = [
      "runs",
      "actions",
      "invocations",
      "ledger",
      "reports",
      "events",
    ];
    const before = tables.map((table) =>
      old.prepare(`SELECT * FROM ${table}`).all(),
    );
    old.close();
    const reader = new Store(path, true);
    assert.equal(reader.workflowInspect("legacy").counts.workflows, 0);
    assert.equal(reader.inspect("legacy").actions.length, 1);
    reader.close();
    const migrated = new Store(path);
    assert.equal(
      migrated.db.prepare("PRAGMA user_version").get()?.user_version,
      1,
    );
    assert.deepEqual(
      tables.map((table) =>
        migrated.db.prepare(`SELECT * FROM ${table}`).all(),
      ),
      before,
    );
    assert.equal(migrated.action("legacy", "a", "identity").result, '"answer"');
    assert.throws(
      () => migrated.db.exec("UPDATE ledger SET usd=0"),
      /immutable/,
    );
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blocked correction resumes from its raw turn with the same native session and deadline", async () => {
  const f = fixture();
  try {
    const h = new Scripted(["bad", '{"ok":true}']);
    let preflight = 0,
      ready = false;
    h.preflight = async () => {
      if (++preflight > 1 && !ready) throw new Error("correction gate");
    };
    const schema = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    };
    const d = definition("flow", async (s) => ({
      passed: true,
      value: (
        await s.agent<Json>(
          "a",
          { harness: h, model: "test-model" },
          { prompt: "a", schema, corrections: 1 },
        )
      ).value,
    }));
    const run = () =>
      f
        .runtime()
        .run((r) => r.workflow("delivery", d, null, { maxDispatches: 2 }));
    await assert.rejects(run(), /correction gate/);
    const first = f.store.workflowInspect("run").workflows[0]!;
    assert.equal(first.status, "blocked");
    assert.equal(first.dispatchesUsed, 1);
    ready = true;
    assert.deepEqual((await run()).value, { ok: true });
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1]!.session!.nativeId, "native-1");
    assert.equal(
      f.store.workflowInspect("run").workflows[0]!.deadline,
      first.deadline,
    );
    assert.equal(
      f.store.workflowInspect("run").workflows[0]!.dispatchesUsed,
      2,
    );
  } finally {
    f.close();
  }
});

test("external cancellation reaches nested native work and keeps the known receipt", async () => {
  const f = fixture();
  try {
    const controller = new AbortController();
    let seen = false;
    const h = new Scripted([
      async (request) => {
        await new Promise<void>((resolve) =>
          request.signal.addEventListener(
            "abort",
            () => {
              seen = true;
              resolve();
            },
            { once: true },
          ),
        );
        return { ...receipt("stopped"), status: "cancelled" };
      },
    ]);
    const d = definition("flow", async (s) => ({
      passed: true,
      value: (
        await s.agent("a", { harness: h, model: "test-model" }, { prompt: "a" })
      ).value,
    }));
    const timer = setTimeout(
      () => controller.abort(new Error("user stopped")),
      40,
    );
    try {
      await assert.rejects(
        f
          .runtime({ signal: controller.signal })
          .run((r) => r.workflow("delivery", d, null)),
        /user stopped/,
      );
    } finally {
      clearTimeout(timer);
    }
    assert.equal(seen, true);
    assert.ok(f.store.invocation("run", invocation + "/a", 0)!.receipt);
    assert.equal(
      f.store.db.prepare("SELECT complete FROM ledger").get()?.complete,
      1,
    );
    assert.equal(
      f.store.workflowInspect("run").workflows[0]!.status,
      "cancelled",
    );
  } finally {
    f.close();
  }
});

test("workflow data rejects lossy JavaScript values before any durable boundary", async () => {
  const f = fixture();
  try {
    const d = definition("flow", async () => ({ passed: true, value: null }));
    for (const value of [
      { missing: undefined },
      { code: () => 1 },
      new Date(),
      [undefined],
      { number: Infinity },
    ]) {
      await assert.rejects(
        f
          .runtime()
          .run((r) => r.workflow("delivery", d, value as unknown as Json)),
        /JSON/,
      );
    }
    assert.equal(f.store.workflowInspect("run").workflows.length, 0);
  } finally {
    f.close();
  }
});

test("escaped local JSON fits its durable receipt and replays exactly", async () => {
  const f = fixture();
  try {
    const value = { text: '"\\'.repeat(50000) };
    let calls = 0;
    const run = () =>
      f.runtime().run((r) =>
        r.local("escaped", { v: 1 }, () => {
          calls++;
          return value;
        }),
      );
    assert.deepEqual(await run(), value);
    assert.deepEqual(await run(), value);
    assert.equal(calls, 1);
    assert.ok(
      Buffer.byteLength(f.store.invocation("run", "escaped", 0)!.receipt!) <
        1024 * 1024,
    );
  } finally {
    f.close();
  }
});
