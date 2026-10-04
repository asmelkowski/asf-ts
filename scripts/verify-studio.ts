// Account-free browser acceptance against built assets and a new empty database.
// Run npm run build, then npx tsx scripts/verify-studio.ts.
import {
  chromium,
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Route,
} from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { parseDocument, validateDocument } from "../src/portable/validation.js";
import {
  openStudioDetails,
  verifyModernStudio,
} from "./verify-studio-modern.js";
import { personaCatalogueFixture, verifyPersonas } from "./verify-personas.js";

const output = resolve(".asf/studio-verification");
mkdirSync(output, { recursive: true });
const fixture = mkdtempSync(join(output, "offline-"));
const db = join(fixture, "empty.db");
const personaCatalogue = join(fixture, "persona-catalogue.json");
writeFileSync(personaCatalogue, JSON.stringify(personaCatalogueFixture));
const store = new Store(db);
const child = spawn(
  process.execPath,
  [
    "dist/src/cli.js",
    "serve",
    "--db",
    db,
    "--port",
    "0",
    "--persona-catalog",
    personaCatalogue,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let stderr = "";
child.stderr.on("data", (chunk: Buffer) => {
  stderr += chunk.toString();
});
const basePromise = new Promise<string>((resolveUrl, reject) => {
  const timer = setTimeout(
    () => reject(new Error(`Studio startup timeout: ${stderr}`)),
    10000,
  );
  child.once("error", reject);
  child.once("exit", (code) => {
    clearTimeout(timer);
    reject(new Error(`Studio exited ${code}: ${stderr}`));
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
let browser: Browser | undefined;
let context: BrowserContext | undefined;
try {
  const executable = process.env.ASF_STUDIO_BROWSER;
  const macChrome =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const executablePath =
    executable ??
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
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const errors: string[] = [],
    requests: { url: string; method: string }[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) =>
    requests.push({ url: request.url(), method: request.method() }),
  );
  const base = await basePromise;
  await page.goto(new URL("/studio", base).href);
  for (const asset of [
    "studio.html",
    "studio.js",
    "persona-editor.js",
    "studio.css",
    "ui.css",
  ]) {
    const response = await page.request.get(
      new URL(asset === "studio.html" ? "/studio" : `/${asset}`, base).href,
    );
    assert.equal(response.status(), 200);
    const bytes = await response.body();
    assert.deepEqual(bytes, readFileSync(`src/web/${asset}`));
    assert.deepEqual(bytes, readFileSync(`dist/src/web/${asset}`));
  }
  const modernChecks = await verifyModernStudio(page, base, fixture, output);
  const personaChecks = await verifyPersonas(page, fixture, output);
  const download = page.locator("#studio-download");
  const node = page.locator("#studio-node-form");
  const settings = page.locator("#studio-workflow-form");
  const commit = async (control: Locator, text: string) => {
    await openStudioDetails(control);
    await control.fill(text);
    await control.press("Tab");
  };
  const validate = async () => {
    await page.click("#studio-validate");
    await expect(page.locator("#studio-status")).toHaveText("Document valid");
    await expect(download).toBeEnabled();
  };
  const source = async () =>
    parseDocument(await page.locator("#studio-source").inputValue());
  const pick = async (id: string, kind: string) => {
    const button = page.getByRole("button", {
      name: `${kind} block ${id}`,
      exact: true,
    });
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#studio-node-title")).toContainText(id);
  };
  await expect(download).toBeEnabled();
  await expect(
    page.getByRole("button", { name: /^Add .* block$/ }),
  ).toHaveCount(8);
  await expect(page.locator(".studio-page-footer")).toContainText(
    "Compile, run, render, and bundle it with the ASF CLI",
  );

  // Author the reusable child and all compound blocks through actual controls.
  await openStudioDetails(page.locator("#studio-child-name"));
  await page.fill("#studio-child-name", "review");
  await page.click("#studio-add-child");
  await expect(page.locator("#studio-definition option")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Add workflow block", exact: true })
    .click();
  await expect(node.getByLabel("Child workflow", { exact: true })).toHaveValue(
    "review",
  );
  for (const field of [
    "input",
    "attempt",
    "maxDispatches",
    "timeoutMs",
    "next target",
  ])
    await expect(node.getByLabel(field, { exact: true })).toBeVisible();
  await expect(page.locator("#studio-child-contract")).toContainText(
    '"defaultProfile": null',
  );
  await commit(node.getByLabel("maxDispatches", { exact: true }), "0");
  await page
    .getByRole("button", { name: "Open child review", exact: true })
    .click();
  await expect(page.locator("#studio-definition")).toHaveValue("review");
  const schema = JSON.stringify({
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  });
  await commit(
    settings.getByLabel("Workflow input schema", { exact: true }),
    schema,
  );
  await commit(
    settings.getByLabel("Workflow output schema", { exact: true }),
    schema,
  );
  await page.selectOption("#studio-definition", "main");
  await pick("workflow", "workflow");
  await commit(node.getByLabel("input", { exact: true }), '{"ok":true}');
  await validate();

  for (const kind of [
    "repeat",
    "parallel",
    "branch",
    "agent",
    "command",
    "custom",
  ]) {
    await pick("complete", "end");
    await page
      .getByRole("button", { name: `Add ${kind} block`, exact: true })
      .click();
    if (kind === "repeat") {
      await expect(
        node.getByLabel("maxIterations", { exact: true }),
      ).toHaveValue("2");
      await expect(node.getByLabel("until", { exact: true })).toBeVisible();
      await commit(node.getByLabel("input", { exact: true }), '{"ok":true}');
    } else if (kind === "parallel") {
      await expect(node.getByLabel("join", { exact: true })).toHaveValue("all");
      await commit(
        node.getByLabel("branches", { exact: true }),
        '[{"id":"first","workflow":"review","input":{"ok":true}},{"id":"second","workflow":"review","input":{"ok":false}}]',
      );
    } else if (kind === "branch") {
      await expect(node.getByLabel("true target", { exact: true })).toHaveValue(
        "complete",
      );
      await expect(
        node.getByLabel("false target", { exact: true }),
      ).toHaveValue("complete");
    } else if (kind === "agent") {
      await commit(
        node.getByLabel("prompt", { exact: true }),
        '<img src="https://example.invalid/steal" onerror="globalThis.studioXss=true">',
      );
      await expect(
        node.getByLabel("corrections", { exact: true }),
      ).toBeVisible();
    } else if (kind === "command") {
      await commit(
        node.getByLabel("argv", { exact: true }),
        '["node","--version"]',
      );
    } else {
      for (const field of ["component", "input", "inputSchema", "outputSchema"])
        await expect(node.getByLabel(field, { exact: true })).toBeVisible();
    }
  }
  // Branch routes must include the subsequently authored chain.
  await pick("branch", "branch");
  await node.getByLabel("true target", { exact: true }).selectOption("agent");
  await node.getByLabel("false target", { exact: true }).selectOption("agent");
  await page.getByText("Advanced persona JSON", { exact: true }).click();
  await commit(
    page.locator("#studio-profiles"),
    JSON.stringify({
      reviewer: {
        instructions: "Review this candidate",
        instructionsChannel: "native-system",
        model: "local-model",
        mode: "write",
        tools: [],
        strict: true,
        timeoutMs: 1000,
        session: "fresh",
      },
    }),
  );
  await settings
    .getByLabel("Workflow default profile", { exact: true })
    .selectOption("reviewer");
  await pick("agent", "agent");
  await node
    .getByLabel("Node profile", { exact: true })
    .selectOption("reviewer");
  await validate();
  const authored = await source();
  assert.equal(
    (
      authored.workflows.main!.nodes.find(
        (block) => block.id === "workflow",
      ) as { maxDispatches: number }
    ).maxDispatches,
    0,
    "Zero child allowance is preserved by the form and shared validator",
  );
  assert.equal(
    authored.workflows.review!.defaultProfile,
    undefined,
    "Child defaults stay isolated",
  );
  assert.equal(authored.workflows.main!.defaultProfile, "reviewer");
  const beforeLayout = validateDocument(authored).identity;
  await commit(node.getByLabel("Layout x", { exact: true }), "-100");
  await validate();
  assert.equal(validateDocument(await source()).identity, beforeLayout);
  assert.match(
    (await page.locator("#studio-graph").getAttribute("viewBox"))!,
    /^-/,
  );
  await page.click("#studio-arrange");
  await validate();
  assert.equal(validateDocument(await source()).identity, beforeLayout);
  await page.screenshot({
    path: join(output, "studio-desktop.png"),
    fullPage: true,
  });

  // Invalid JSON disables export immediately, survives selection, and cannot leak into a download.
  await node.getByLabel("outputSchema", { exact: true }).fill("{invalid");
  await expect(download).toBeDisabled();
  await node.getByLabel("outputSchema", { exact: true }).press("Tab");
  await pick("complete", "end");
  await pick("agent", "agent");
  await expect(node.getByLabel("outputSchema", { exact: true })).toHaveValue(
    "{invalid",
  );
  await page.click("#studio-validate");
  await expect(download).toBeDisabled();
  await expect(page.locator("#studio-message")).toContainText(
    "pending outputSchema",
  );
  await commit(node.getByLabel("outputSchema", { exact: true }), "{}");
  await validate();
  const priorProfiles = (await source()).profiles;
  await page.locator("#studio-profiles").fill("[");
  await page.locator("#studio-profiles").press("Tab");
  await page.click("#studio-validate");
  await expect(download).toBeDisabled();
  assert.deepEqual(
    (await source()).profiles,
    priorProfiles,
    "Malformed profile draft cannot partially mutate canonical data",
  );
  await commit(page.locator("#studio-profiles"), JSON.stringify(priorProfiles));
  await validate();

  // A late successful validation cannot approve a newer edit.
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((r) => {
      entered = r;
    }),
    released = new Promise<void>((r) => {
      release = r;
    });
  const hold = async (route: Route) => {
    const response = await route.fetch();
    entered();
    await released;
    await route.fulfill({ response });
  };
  await page.route("**/studio/validate", hold);
  await page.click("#studio-validate");
  await reached;
  await node
    .getByLabel("prompt", { exact: true })
    .fill("A newer pending prompt");
  release();
  await page.waitForResponse((response) =>
    response.url().endsWith("/studio/validate"),
  );
  await expect(download).toBeDisabled();
  await expect(page.locator("#studio-status")).not.toHaveText("Document valid");
  await page.unroute("**/studio/validate", hold);
  await commit(node.getByLabel("prompt", { exact: true }), "Review this input");
  await validate();

  // Real downloads reimport through both file formats with the same semantic identity.
  const roundTripIdentity = validateDocument(await source()).identity;
  for (const format of ["json", "yaml"]) {
    await page.selectOption("#studio-format", format);
    const downloaded = page.waitForEvent("download");
    await download.click();
    const file = join(fixture, `workflow.${format}`);
    await (await downloaded).saveAs(file);
    assert.equal(
      validateDocument(parseDocument(readFileSync(file, "utf8"))).identity,
      roundTripIdentity,
    );
    await page.locator("#studio-file").setInputFiles(file);
    await expect(download).toBeEnabled();
    await expect(page.locator("#studio-identity")).toContainText(
      roundTripIdentity,
    );
  }
  await page
    .locator("#studio-source")
    .fill("format: asf-ts-workflow/v1\nroot: main\nroot: other\n");
  await page.click("#studio-apply-source");
  await expect(download).toBeDisabled();
  await expect(page.locator("#studio-source")).toHaveValue(/root: other/);
  await expect(page.locator("#studio-message")).toContainText(
    "Map keys must be unique",
  );
  await page
    .locator("#studio-file")
    .setInputFiles(join(fixture, "workflow.yaml"));
  await expect(download).toBeEnabled();

  // Deleting an invalid node clears its own pending buffer; the remaining graph can validate.
  await page.click("#studio-new");
  await expect(download).toBeEnabled();
  await page
    .getByRole("button", { name: "Add branch block", exact: true })
    .click();
  await node.getByLabel("predicate", { exact: true }).fill("{broken");
  await node.getByLabel("predicate", { exact: true }).press("Tab");
  await page.click("#studio-delete");
  await settings
    .getByLabel("Start block", { exact: true })
    .selectOption("complete");
  await validate();
  await expect(page.locator("#studio-graph .studio-block")).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await pick("complete", "end");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "Editor scroll stays local on mobile",
  );
  await page.screenshot({
    path: join(output, "studio-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "Inspect runs", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Author a workflow", exact: true }),
  ).toHaveAttribute("href", "/studio");
  await expect(page.locator("#list-status")).toHaveText(
    "No runs on this page.",
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM runs").get()!.count,
    0,
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM events").get()!.count,
    0,
  );
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => "studioXss" in globalThis), false);
  assert.ok(
    requests.every((request) => request.url.startsWith(base)),
    "Imported text sends no external requests",
  );
  assert.ok(
    requests
      .filter((request) => request.method !== "GET")
      .every((request) =>
        ["/studio/validate", "/studio/persona-catalogue"].includes(
          new URL(request.url).pathname,
        ),
      ),
    "Only data validation is posted",
  );
  writeFileSync(
    join(output, "acceptance.json"),
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        browser: await browser.version(),
        fixture,
        sourceAssets: Object.fromEntries(
          [
            "studio.html",
            "studio.js",
            "persona-editor.js",
            "studio.css",
            "ui.css",
            "graph.css",
          ].map((asset) => [
            asset,
            createHash("sha256")
              .update(readFileSync(`src/web/${asset}`))
              .digest("hex"),
          ]),
        ),
        checks: [
          ...modernChecks,
          ...personaChecks,
          "built asset parity",
          "catalogue forms",
          "typed child and isolated profiles",
          "finite repeat and parallel",
          "layout identity",
          "invalid drafts",
          "stale response",
          "YAML/JSON actual downloads",
          "deleted draft cleanup",
          "keyboard and mobile",
          "inspection link",
          "no run writes or external requests",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: Studio dark defaults, sibling insertion, pointer/keyboard layout, zoom/cancellation, built assets, catalogue forms, persona fields/CRUD/pins/draft and response guards, typed child/profile authoring, finite composition, invalid draft retention/cleanup, revision guard, YAML/JSON file round trips, layout identity, keyboard/mobile and inspection separation; no execution or hosted calls.",
  );
} finally {
  await context?.close();
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  store.close();
}
