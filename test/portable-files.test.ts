import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { portableFixture } from "./portable-fixtures.js";
import {
  loadDocument,
  bundleDocument,
  verifyBundle,
  renderDocument,
  compileDocument,
  loadRegistration,
  loadTargetBindings,
  bytesHash,
} from "../src/portable/files.js";
import { validateDocument } from "../src/portable/validation.js";
test("bundle closure verifies without extraction and detects changed source, render and report", () => {
  const doc = portableFixture(),
    bundle = bundleDocument(doc);
  assert.equal(bundle, bundleDocument(doc));
  assert.equal(verifyBundle(bundle).identity, validateDocument(doc).identity);
  for (const mutate of [
    (b: Record<string, unknown>) => (b.workflowIdentity = "wrong"),
    (b: Record<string, unknown>) => (b.support = {}),
    (b: Record<string, unknown>) => {
      const m = b.members as Record<string, { data: string }>;
      m["workflow.svg"]!.data = "tampered";
    },
    (b: Record<string, unknown>) => {
      const m = b.members as Record<string, unknown>;
      m["../../escape"] = { data: "x", sha256: "x" };
    },
  ]) {
    const b = JSON.parse(bundle) as Record<string, unknown>;
    mutate(b);
    assert.throws(() => verifyBundle(JSON.stringify(b)));
  }
});
test("renderer escapes labels and generated ASF driver freezes complete source without bindings", () => {
  const doc = portableFixture();
  doc.workflows.review!.version = '<script>alert("x")</script>';
  const svg = renderDocument(doc);
  assert.ok(svg.includes("&lt;script&gt;"));
  assert.ok(!svg.includes("<script>"));
  const source = compileDocument(doc);
  assert.ok(source.includes("executeDocument"));
  assert.ok(!source.includes("CandidateVerifier"));
  assert.ok(source.includes("review"));
  assert.ok(!source.includes("apiKey"));
});
test("CLI closure loader resolves local definitions and rejects escape, cycles and duplicates", () => {
  const dir = mkdtempSync(join(tmpdir(), "asf-ts-files-"));
  try {
    const doc = portableFixture(),
      review = doc.workflows.review!;
    delete doc.workflows.review;
    writeFileSync(
      join(dir, "root.json"),
      JSON.stringify({ ...doc, imports: ["child.json"] }),
    );
    writeFileSync(
      join(dir, "child.json"),
      JSON.stringify({
        format: doc.format,
        root: "review",
        workflows: { review },
      }),
    );
    assert.equal(
      loadDocument(join(dir, "root.json")).document.workflows.review!.version,
      "1",
    );
    writeFileSync(
      join(dir, "root.json"),
      JSON.stringify({ ...doc, imports: ["../outside.json"] }),
    );
    assert.throws(() => loadDocument(join(dir, "root.json")), /imports/);
    writeFileSync(
      join(dir, "root.json"),
      JSON.stringify({ ...doc, imports: ["root.json"] }),
    );
    assert.throws(() => loadDocument(join(dir, "root.json")), /cycle/);
    mkdirSync(join(dir, "sub"));
    writeFileSync(
      join(dir, "root.json"),
      JSON.stringify({ ...doc, imports: ["child.json", "child.json"] }),
    );
    assert.throws(() => loadDocument(join(dir, "root.json")), /Duplicate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trusted module entry changes use matching exports and raw byte identities", async () => {
  const dir = mkdtempSync(join(tmpdir(), "asf-ts-modules-"));
  try {
    const path = join(dir, "component.mjs");
    const source = (n: number) =>
      `export const components={value:{identity:{revision:${n}},inputSchema:{},outputSchema:{},readOnly:true,run:async()=>${n}}};export const bindings={value:{agent:{marker:${n}},capabilities:{revision:"${n}"}}};`;
    writeFileSync(path, source(1));
    const first = await loadRegistration(path);
    const target1 = await loadTargetBindings(path);
    writeFileSync(path, source(2));
    const second = await loadRegistration(path, bytesHash(source(2)));
    const target2 = await loadTargetBindings(path, bytesHash(source(2)));
    // Access the trusted loader without invoking any agent or provider.
    assert.equal(
      (first.value!.identity as { declared: { revision: number } }).declared
        .revision,
      1,
    );
    assert.equal(
      (second.value!.identity as { declared: { revision: number } }).declared
        .revision,
      2,
    );
    assert.notEqual(
      target1.value!.capabilities.revision,
      target2.value!.capabilities.revision,
    );
    assert.equal(
      (target2.value!.agent as unknown as { marker: number }).marker,
      2,
    );
    await assert.rejects(
      loadRegistration(path, bytesHash(source(1))),
      /source changed/,
    );
    await assert.rejects(
      loadTargetBindings(path, bytesHash(source(1))),
      /source changed/,
    );
    assert.notEqual(
      bytesHash(Uint8Array.of(255)),
      bytesHash(Uint8Array.of(254)),
    );
    const changing = join(dir, "changing.mjs");
    writeFileSync(
      changing,
      `import {writeFileSync} from "node:fs"; writeFileSync(new URL(import.meta.url), "export const components={};export const bindings={};");export const components={};export const bindings={};`,
    );
    await assert.rejects(loadRegistration(changing), /changed during import/);
    writeFileSync(
      changing,
      `import {writeFileSync} from "node:fs"; writeFileSync(new URL(import.meta.url), "export const bindings={};");export const bindings={};`,
    );
    await assert.rejects(loadTargetBindings(changing), /changed during import/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shared render exposes typed interfaces, profile intent and finite compound contracts", () => {
  const d = portableFixture(),
    w = d.workflows.delivery!;
  d.profiles = {
    reviewer: {
      instructions: "Review <script>literal</script>",
      model: "render-model",
      mode: "read-only",
    },
  };
  w.defaultProfile = "reviewer";
  const child = w.nodes[0]!;
  assert.equal(child.kind, "workflow");
  if (child.kind !== "workflow") throw new Error("fixture child expected");
  child.attempt = 2;
  child.maxDispatches = 3;
  child.timeoutMs = 25000;
  child.next = "repeat";
  w.nodes.splice(
    1,
    0,
    {
      id: "repeat",
      kind: "repeat",
      workflow: "review",
      input: { $ref: "#/input" },
      until: { left: { $ref: "#/result/ok" }, op: "truthy" },
      maxIterations: 7,
      next: "parallel",
    },
    {
      id: "parallel",
      kind: "parallel",
      join: "any",
      branches: [
        { id: "left", workflow: "review", input: { $ref: "#/input" } },
        { id: "right", workflow: "review", input: { $ref: "#/input" } },
      ],
      next: "end",
    },
  );
  const svg = renderDocument(d);
  for (const label of [
    "inputSchema",
    "outputSchema",
    "properties",
    "boolean",
    "render-model",
    "instructions",
    "maxDispatches",
    "timeoutMs",
    "25000",
    "attempt",
    "maxIterations",
    "branches",
    "join",
    "left",
    "right",
    "at most 7",
  ])
    assert.ok(svg.includes(label), `missing ${label}`);
  assert.ok(svg.includes("&lt;script&gt;literal&lt;/script&gt;"));
  assert.ok(!svg.includes("<script>"));
  assert.equal(svg, renderDocument(d));
  assert.equal(
    verifyBundle(bundleDocument(d)).identity,
    validateDocument(d).identity,
  );
});

test("renderer names both branch ports when they reach the same target", () => {
  const d = portableFixture(),
    w = d.workflows.review!;
  w.start = "route";
  w.nodes.unshift({
    id: "route",
    kind: "branch",
    predicate: { left: { $ref: "#/input/ok" }, op: "truthy" },
    then: "end",
    else: "end",
  });
  const svg = renderDocument(d);
  const ports = ["true", "false"].map((label) => {
    const match = svg.match(
      new RegExp(`<text x="([^"]+)" y="([^"]+)">${label}</text>`),
    );
    assert.ok(match, `missing ${label} port`);
    return [Number(match[1]), Number(match[2])];
  });
  assert.notDeepEqual(ports[0], ports[1], "branch labels must be distinct");
  const cards = [
    ...svg.matchAll(
      /<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g,
    ),
  ].map((m) => m.slice(1).map(Number));
  for (const [x, y] of ports) {
    assert.ok(
      cards.every(
        ([cx, cy, width, height]) =>
          x! + 48 <= cx! ||
          x! >= cx! + width! ||
          y! <= cy! ||
          y! - 14 >= cy! + height!,
      ),
      "branch labels must stay outside every node card",
    );
  }
});

test("render and bundle bytes are independent of workflow-map insertion order", () => {
  const d = portableFixture(),
    reordered = {
      ...d,
      workflows: Object.fromEntries(Object.entries(d.workflows).reverse()),
    };
  assert.equal(renderDocument(d), renderDocument(reordered));
  assert.equal(bundleDocument(d), bundleDocument(reordered));
  assert.equal(
    verifyBundle(bundleDocument(reordered)).identity,
    validateDocument(d).identity,
  );
});
