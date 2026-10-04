// Account-free acceptance. Run npm run build, then npx tsx scripts/verify-graph.ts.
import {
  chromium,
  expect,
  type Browser,
  type BrowserContext,
} from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import {
  recordedGraph,
  graphDocument,
  graphBindings,
  sourceLiteral,
} from "../test/graph-fixtures.js";
import { Scripted, accounting } from "../test/helpers.js";
import { portableFixture } from "../test/portable-fixtures.js";
import { executeDocument, type Component } from "../src/portable/execute.js";
import { buildGraphInspection } from "../src/portable/inspection.js";

const output = resolve(".asf/graph-verification");
mkdirSync(output, { recursive: true });
const f = await recordedGraph();
await f.replay();
const rejected = new Scripted([
  async (_request, sink) => {
    sink.report("known-before-failure", accounting);
    throw new Error("Offline unknown transport outcome");
  },
]);
await assert.rejects(() =>
  f
    .runtime({ runId: "failed" })
    .run((r) =>
      executeDocument(
        r,
        graphDocument(),
        { ok: true },
        { bindings: graphBindings(rejected) },
      ),
    ),
);
await f
  .runtime({ runId: "ordinary" })
  .run((r) => r.local("plain", { v: 1 }, () => ({ ok: true })));

const many = portableFixture(),
  root = many.workflows.delivery!;
delete many.workflows.review;
root.start = "custom";
root.nodes = [
  {
    id: "custom",
    kind: "custom",
    component: "component",
    input: { $ref: "#/input" },
    inputSchema: root.inputSchema,
    outputSchema: root.outputSchema,
    next: "end",
  },
  { id: "end", kind: "end", output: { $ref: "#/nodes/custom" } },
];
const component: Component = {
  identity: { fixture: "thirty-local-receipts-v1" },
  inputSchema: root.inputSchema,
  outputSchema: root.outputSchema,
  readOnly: true,
  run: async (scope, input) => {
    for (let index = 0; index < 30; index++)
      await scope.local(`inner-${index}`, { index }, () => input);
    return input;
  },
};
await f
  .runtime({ runId: "many" })
  .run((r) =>
    executeDocument(r, many, { ok: true }, { components: { component } }),
  );
const proof = buildGraphInspection(f.store, "run"),
  parent = proof.graphs[0]!,
  nested = proof.graphs[1]!;
const action = nested.nodes.find((node) => node.source.id === "judgement")!
  .actions[0]!;
const beforeEvents = Number(
  f.store.db.prepare("SELECT COUNT(*) AS n FROM events").get()!.n,
);
const child = spawn(
  process.execPath,
  ["dist/src/cli.js", "serve", "--db", join(f.dir, "store.db"), "--port", "0"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let stderr = "";
child.stderr.on("data", (chunk: Buffer) => {
  stderr += chunk.toString();
});
const basePromise = new Promise<string>((resolveUrl, reject) => {
  const timer = setTimeout(
    () => reject(new Error(`Graph startup timeout: ${stderr}`)),
    10000,
  );
  child.once("error", reject);
  child.once("exit", (code) => {
    clearTimeout(timer);
    reject(new Error(`Graph server exited ${code}: ${stderr}`));
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\//);
    if (match) {
      clearTimeout(timer);
      resolveUrl(match[0]);
    }
  });
});
let browser: Browser | undefined, context: BrowserContext | undefined;
try {
  const macChrome =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const executablePath =
    process.env.ASF_GRAPH_BROWSER ??
    (existsSync(chromium.executablePath())
      ? undefined
      : existsSync(macChrome)
        ? macChrome
        : undefined);
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage(),
    errors: string[] = [],
    requests: { url: string; method: string }[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) =>
    requests.push({ url: request.url(), method: request.method() }),
  );
  const base = await basePromise;
  await page.goto(new URL("/graph?run=run", base).href);
  await expect(page.locator("#graph-lifecycle")).toHaveText(
    "Workflow lifecycle: completed",
  );
  await expect(page.locator("#graph-verdict")).toHaveText(
    "Business passed: false",
  );
  await expect(page.locator("#graph-binding")).toContainText(
    "recorded replay events 1",
  );
  await expect(page.locator("#graph-binding")).toContainText(
    "reserved ASF dispatches 2",
  );
  await expect(page.locator("#graph-cost")).toContainText("$0.002000 USD");
  await expect(page.locator("#graph-diagram svg path[marker-end]")).toHaveCount(
    3,
  );
  for (const asset of ["graph.html", "graph.js", "graph.css"]) {
    const response = await page.request.get(
      new URL(asset === "graph.html" ? "/graph" : `/${asset}`, base).href,
    );
    assert.equal(response.status(), 200);
    assert.deepEqual(await response.body(), readFileSync(`src/web/${asset}`));
    assert.deepEqual(
      await response.body(),
      readFileSync(`dist/src/web/${asset}`),
    );
  }
  const pick = async (name: string) => {
    const block = page.getByRole("button", { name, exact: true });
    await block.focus();
    await page.keyboard.press("Enter");
  };
  await pick("Inspect node rejected, end, unobserved");
  await expect(page.locator("#graph-node-evidence")).toContainText(
    "no skipped-state claim",
  );
  await pick("Inspect node child, workflow, completed");
  const childLink = page.locator("#graph-node-evidence a.graph-child");
  await expect(childLink).toContainText("business passed false");
  const destination = new URL((await childLink.getAttribute("href"))!, base);
  assert.equal(destination.searchParams.get("invocation"), nested.invocationId);
  await childLink.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#graph-invocation")).toHaveValue(
    nested.invocationId,
  );
  await expect(page.locator("#graph-title")).toHaveText("review · attempt 1");
  await expect(page.locator("#graph-binding")).toContainText(
    "recorded replay events 0",
  );
  await expect(page.locator("#graph-verdict")).toHaveText(
    "Business passed: false",
  );
  await pick("Inspect node judgement, agent, completed");
  const receiptButtons = page.locator("#graph-node-evidence button");
  await expect(receiptButtons).toHaveCount(2);
  for (let index = 0; index < action.nativeInvocationIds.length; index++) {
    const id = action.nativeInvocationIds[index]!;
    await expect(receiptButtons.nth(index)).toContainText(id);
    await receiptButtons.nth(index).click();
    const retained = JSON.parse(
      (await page.locator("#graph-receipt").textContent())!,
    );
    assert.equal(retained.id, id);
    assert.equal(retained.turn, index);
    assert.equal(
      retained.receipt,
      proof.legacy.invocations.find((row) => row.id === id)!.receipt,
    );
  }
  await page
    .getByText("Stored authored source document", { exact: true })
    .click();
  await expect(page.locator("#graph-source")).toContainText(sourceLiteral);
  assert.equal(await page.evaluate(() => "graphXss" in globalThis), false);
  const parentLink = page.locator("#graph-parent a");
  assert.equal(
    new URL((await parentLink.getAttribute("href"))!, base).searchParams.get(
      "invocation",
    ),
    parent.invocationId,
  );
  await page.screenshot({
    path: join(output, "graph-nested-receipt.png"),
    fullPage: true,
  });
  await parentLink.click();
  await expect(page.locator("#graph-invocation")).toHaveValue(
    parent.invocationId,
  );

  // A failed transport shows retained partial cost and no business approval.
  await page.locator("#graph-run").fill("failed");
  await page.locator("#graph-run").press("Enter");
  await expect(page.locator("#graph-lifecycle")).toHaveText(
    "Workflow lifecycle: failed",
  );
  await expect(page.locator("#graph-verdict")).toContainText(
    "unavailable until a typed workflow result completes",
  );
  await expect(page.locator("#graph-cost")).toContainText("$0.001000 USD");
  await expect(page.locator("#graph-cost")).toContainText(
    "unresolved invocations 1",
  );
  await page.selectOption(
    "#graph-invocation",
    buildGraphInspection(f.store, "failed").graphs[1]!.invocationId,
  );
  await pick("Inspect node judgement, agent, failed");
  await expect(page.locator("#graph-node-evidence")).toContainText(
    "unresolved loaded receipts 1",
  );
  await page.locator("#graph-node-evidence button").click();
  assert.equal(
    JSON.parse((await page.locator("#graph-receipt").textContent())!).receipt,
    null,
  );
  await page.screenshot({
    path: join(output, "graph-uncertain.png"),
    fullPage: true,
  });

  // Action and invocation windows advance independently; exact workflow focus survives.
  await page.selectOption("#graph-runs", "many");
  await expect(page.locator("#graph-run-heading")).toHaveText("many");
  await expect(page.locator("#graph-next")).toBeEnabled();
  await expect(page.locator("#graph-warnings")).toContainText(
    "independently paged",
  );
  await page.click("#graph-next");
  await expect(page.locator("#graph-coverage")).toContainText(
    "Record window 20–39",
  );
  await expect(page.locator("#graph-title")).toHaveText("delivery · attempt 1");
  await pick("Inspect node custom, custom, completed");
  await expect(page.locator("#graph-node-evidence")).toContainText(
    "registered component inner action",
  );
  await expect(page.locator("#graph-node-evidence")).toContainText("inner-29");
  await expect(page.locator("#graph-node-evidence")).not.toContainText(
    "inner-0 ·",
  );
  await page.screenshot({
    path: join(output, "graph-partial-window.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "Graph scroll remains local on mobile",
  );
  await page.screenshot({
    path: join(output, "graph-mobile.png"),
    fullPage: true,
  });

  await page.selectOption("#graph-runs", "ordinary");
  await expect(page.locator("#graph-empty")).toBeVisible();
  await expect(page.locator("#graph-selected")).toBeHidden();
  await page.locator("#graph-run").fill("missing");
  await page.locator("#graph-run").press("Enter");
  await expect(page.locator("#graph-status")).toHaveText("Run not found.");
  await expect(page.locator("#graph-workspace")).toBeHidden();
  assert.deepEqual(errors, []);
  assert.ok(
    requests.every(
      (request) => request.method === "GET" && request.url.startsWith(base),
    ),
    "The graph sends local GETs only",
  );
  assert.equal(
    Number(f.store.db.prepare("SELECT COUNT(*) AS n FROM events").get()!.n),
    beforeEvents,
    "Inspection adds no execution or replay events",
  );
  assert.equal(f.harness.calls.length, 2);
  assert.equal(rejected.calls.length, 1);
  writeFileSync(
    join(output, "acceptance.json"),
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        browser: await browser.version(),
        fixtures:
          "Ephemeral real SQLite runs with account-free scripted native receipts",
        checks: [
          "built and served asset parity",
          "declared edges",
          "lifecycle versus business false",
          "actual root replay count",
          "literal authored source",
          "exact child and parent IDs",
          "two correction receipts and ledger subtotal",
          "failed native partial cost",
          "independent windows and exact focus",
          "legacy fallback",
          "unknown run",
          "keyboard and mobile",
          "GET-only no execution",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: Graph built assets, declared edges, real receipts, exact nested links, completed-negative/replay/uncertain states, partial windows, legacy fallback, literal source, keyboard/mobile and GET-only inspection.",
  );
} finally {
  await context?.close();
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  f.close();
}
