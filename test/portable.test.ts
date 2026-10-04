import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDocument,
  validateDocument,
  serializeDocument,
  resolveValue,
  evaluatePredicate,
} from "../src/portable/index.js";
import { portableFixture } from "./portable-fixtures.js";
import type { WorkflowDocument } from "../src/portable/model.js";

test("portable JSON/YAML round trip and layout preserve meaning", () => {
  const doc = portableFixture(),
    a = validateDocument(doc);
  for (const format of ["json", "yaml"] as const)
    assert.equal(
      validateDocument(parseDocument(serializeDocument(doc, format))).identity,
      a.identity,
    );
  doc.workflows.delivery!.layout = { child: { x: 123, y: 44 } };
  doc.workflows.delivery!.nodes.reverse();
  assert.equal(validateDocument(doc).identity, a.identity);
});
test("safe parser rejects duplicates, aliases, tags, nonfinite and limits", () => {
  for (const text of [
    '{"a":1,"a":2}',
    "a: &thing 1\nb: *thing",
    "a: !evil 1",
    "a: .inf",
    "a: .nan",
    "x".repeat(1024 * 1024 + 1),
  ])
    assert.throws(() => parseDocument(text));
});
test("strict structure rejects unknown fields, missing edges, cycles, recursion and invalid schemas", () => {
  for (const mutate of [
    (d: WorkflowDocument) => Object.assign(d, { extra: true }),
    (d: WorkflowDocument) =>
      d.workflows.delivery!.nodes.push({
        id: "loose",
        kind: "end",
        output: { ok: true },
      }),
    (d: WorkflowDocument) =>
      ((d.workflows.delivery!.nodes[0] as { next: string }).next = "missing"),
    (d: WorkflowDocument) =>
      ((d.workflows.delivery!.nodes[0] as { next: string }).next = "child"),
    (d: WorkflowDocument) =>
      (d.workflows.review!.nodes = [
        {
          id: "end",
          kind: "workflow",
          workflow: "delivery",
          input: { $ref: "#/input" },
          next: "end",
        },
      ]),
    (d: WorkflowDocument) =>
      (d.workflows.review!.inputSchema = {
        $ref: "https://example.com/schema",
      }),
  ]) {
    const d = portableFixture();
    mutate(d);
    assert.throws(() => validateDocument(d));
  }
});
test("references must exist on every incoming path and expose required typed properties", () => {
  const d = portableFixture(),
    w = d.workflows.delivery!;
  w.nodes = [
    {
      id: "branch",
      kind: "branch",
      predicate: { left: { $ref: "#/input/ok" }, op: "truthy" },
      then: "child",
      else: "end",
    },
    ...w.nodes,
  ];
  w.start = "branch";
  assert.throws(() => validateDocument(d), /incoming path/);
  const d2 = portableFixture();
  d2.workflows.review!.inputSchema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    additionalProperties: false,
  };
  assert.throws(() => validateDocument(d2), /optional|missing required/);
});
test("typed child ports reject mismatched data and JSON references resolve deterministically", () => {
  const d = portableFixture();
  (d.workflows.delivery!.nodes[0] as { input: unknown }).input = { ok: 3 };
  assert.throws(() => validateDocument(d), /incompatible/);
  assert.deepEqual(
    resolveValue({ ok: { $ref: "#/nodes/a/ok" } }, null, { a: { ok: false } }),
    { ok: false },
  );
  assert.equal(
    evaluatePredicate({ left: { $ref: "#/nodes/a/ok" }, op: "truthy" }, null, {
      a: { ok: false },
    }),
    false,
  );
  assert.throws(() =>
    resolveValue({ $ref: "#/nodes/a/absent" }, null, { a: { ok: false } }),
  );
});

test("known array and optional object port contradictions reject before execution", () => {
  for (const [source, target] of [
    [
      { type: "array", items: { type: "string" } },
      { type: "array", items: { type: "integer" } },
    ],
    [
      {
        type: "object",
        properties: { x: { type: "string" } },
        required: ["x"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { x: { type: "integer" } },
        additionalProperties: false,
      },
    ],
    [
      { type: "array", items: [{ type: "string" }], minItems: 1, maxItems: 1 },
      { type: "array", items: [{ type: "integer" }], minItems: 1, maxItems: 1 },
    ],
  ] as const) {
    const doc = portableFixture();
    doc.workflows.delivery!.inputSchema = source as unknown as Record<
      string,
      unknown
    >;
    doc.workflows.review!.inputSchema = target as unknown as Record<
      string,
      unknown
    >;
    doc.workflows.delivery!.outputSchema = {};
    doc.workflows.delivery!.nodes[1] = { id: "end", kind: "end", output: null };
    doc.workflows.review!.outputSchema = {};
    doc.workflows.review!.nodes = [
      { id: "end", kind: "end", output: { $ref: "#/input" } },
    ];
    assert.throws(() => validateDocument(doc), /incompatible/);
  }
});
test("selector scalars reject coercion and malformed falsy values", () => {
  for (const mutate of [
    (d: WorkflowDocument) =>
      ((
        d.workflows.delivery!.nodes[0] as unknown as { workflow: unknown }
      ).workflow = ["review"]),
    (d: WorkflowDocument) =>
      Object.assign(d.workflows.delivery!, { defaultProfile: false }),
    (d: WorkflowDocument) => {
      d.profiles = { worker: {} };
      d.workflows.delivery!.nodes = [
        {
          id: "agent",
          kind: "agent",
          profile: 0 as unknown as string,
          prompt: "x",
          outputSchema: {},
          next: "end",
        },
        { id: "end", kind: "end", output: null },
      ];
      d.workflows.delivery!.start = "agent";
      d.workflows.delivery!.outputSchema = {};
    },
  ]) {
    const d = portableFixture();
    mutate(d);
    assert.throws(() => validateDocument(d));
  }
});
test("literal __proto__ is retained as data and cannot become schema prototype", () => {
  const d = portableFixture();
  d.workflows.delivery!.inputSchema = {};
  d.workflows.review!.inputSchema = {
    type: "object",
    properties: JSON.parse('{"__proto__":{"type":"string"}}') as Record<
      string,
      unknown
    >,
    required: ["__proto__"],
    additionalProperties: false,
  };
  d.workflows.review!.outputSchema = {};
  d.workflows.review!.nodes = [{ id: "end", kind: "end", output: null }];
  (d.workflows.delivery!.nodes[0] as unknown as { input: unknown }).input =
    JSON.parse('{"__proto__":3}') as unknown;
  assert.throws(() => validateDocument(d));
});

test("portable canonical identity supports bounded closures above legacy256KiB", () => {
  const d: WorkflowDocument = {
    format: "asf-ts-workflow/v1",
    root: "w0",
    workflows: {},
  };
  for (let i = 0; i < 40; i++)
    d.workflows[`w${i}`] = {
      version: "1",
      inputSchema: { description: "i".repeat(4096) },
      outputSchema: { description: "o".repeat(4096) },
      start: "end",
      nodes: [{ id: "end", kind: "end", output: null }],
    };
  assert.ok(Buffer.byteLength(JSON.stringify(d)) > 256 * 1024);
  const v = validateDocument(d);
  assert.equal(
    validateDocument(parseDocument(serializeDocument(d, "yaml"))).identity,
    v.identity,
  );
});
