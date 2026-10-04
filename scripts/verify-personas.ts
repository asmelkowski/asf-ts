// Persona acceptance shares verify-studio.ts's built server, empty Store and request audit.
import assert from "node:assert/strict";
import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, validateDocument } from "../src/portable/validation.js";
import type { PersonaCatalogue } from "../src/persona-catalogue.js";
import { openStudioDetails } from "./verify-studio-modern.js";

export const personaCatalogueFixture: PersonaCatalogue = {
  format: "asf-persona-catalogue/v1",
  models: ["local-model", "alternate-model"],
  tools: ["read", "shell"],
  plugins: [
    {
      id: "fixture/reviewer",
      name: "Review plugin",
      revision: "a".repeat(40),
      description:
        "<img src=https://example.invalid/plugin onerror=personaXss=1>",
    },
    { id: "fixture/unpinned", name: "Unpinned plugin" },
  ],
};

export async function verifyPersonas(
  page: Page,
  fixture: string,
  output: string,
): Promise<string[]> {
  const checks: string[] = [];
  const dialog = page.locator("#studio-persona-dialog"),
    form = page.locator("#studio-persona-form"),
    download = page.locator("#studio-download");
  const read = async () =>
    parseDocument(await page.locator("#studio-source").inputValue());
  const persona = async (name: string) => {
    const profiles = (await read()).profiles;
    return profiles && Object.hasOwn(profiles, name)
      ? profiles[name]
      : undefined;
  };
  const field = (label: string) => form.getByLabel(label, { exact: true });
  const commit = async (control: Locator, value: string) => {
    await control.fill(value);
    await control.press("Tab");
  };
  const validate = async () => {
    await page.click("#studio-validate");
    await expect(page.locator("#studio-status")).toHaveText("Document valid");
    await expect(download).toBeEnabled();
  };
  const open = async () => {
    await page.click("#studio-persona-open");
    await expect(dialog).toBeVisible();
  };
  const close = async () => {
    await page.click("#studio-persona-close");
    await expect(dialog).not.toBeVisible();
  };
  const create = async (name: string) => {
    await page.fill("#studio-persona-new-name", name);
    await page.click("#studio-persona-add");
    await expect(page.locator("#studio-persona-list")).toHaveValue(name);
    await expect(page.locator("#studio-persona-new-name")).toHaveValue("");
  };
  const importCatalogue = async (catalogue: unknown, name: string) => {
    const path = join(fixture, name);
    writeFileSync(path, JSON.stringify(catalogue));
    await page.locator("#studio-persona-catalogue-file").setInputFiles(path);
  };

  await page.click("#studio-new");
  await open();
  await expect(page.locator("#studio-persona-message")).toContainText(
    "Create a named persona",
  );
  await close();
  const existingPersona = await read();
  existingPersona.profiles = { imported: { model: "local-model" } };
  const existingPath = join(fixture, "existing-persona.json");
  writeFileSync(existingPath, JSON.stringify(existingPersona));
  await page.locator("#studio-file").setInputFiles(existingPath);
  await expect(download).toBeEnabled();
  await open();
  await expect(page.locator("#studio-persona-list")).toHaveValue("imported");
  await expect(page.locator("#studio-persona-message")).not.toContainText(
    "Create a named persona",
  );
  await close();
  await page.click("#studio-new");
  await open();
  await create("reviewer");
  await expect(field("Available tools")).toBeDisabled();
  assert.equal((await persona("reviewer"))!.tools, undefined);
  await field("Tool selection").selectOption("explicit");
  await expect(field("Available tools")).toBeEnabled();
  assert.deepEqual((await persona("reviewer"))!.tools, []);
  await form.getByLabel("read", { exact: true }).check();
  await expect(field("Available tools")).toHaveValue("read");
  await commit(
    field("System instructions"),
    "Review the exact candidate; report failed checks.",
  );
  await field("Instruction delivery").selectOption("native-system");
  await commit(field("Model"), "local-model");
  await expect(page.locator("#studio-persona-models option")).toHaveCount(2);
  await field("Mode").selectOption("write");
  await field("Strict tool selection").selectOption("true");
  await commit(field("Timeout (ms)"), "12345");
  await field("Session policy").selectOption("fresh");
  await field("Plugin selection").selectOption("explicit");
  await expect(
    form.getByLabel("Select plugin Unpinned plugin", { exact: true }),
  ).toBeDisabled();
  await form.getByLabel("Select plugin Review plugin", { exact: true }).check();
  const checkboxGeometry = await form
    .getByLabel("Select plugin Review plugin", { exact: true })
    .evaluate((element) => ({
      glyph: element.getBoundingClientRect().toJSON(),
      row: element.closest("label")!.getBoundingClientRect().toJSON(),
    }));
  assert.equal(checkboxGeometry.glyph.width, 20);
  assert.equal(checkboxGeometry.glyph.height, 20);
  assert.ok(checkboxGeometry.row.height >= 44);
  assert.equal(await page.evaluate(() => "personaXss" in globalThis), false);
  await expect(form).toContainText("selected catalogue metadata");
  await expect(form).toContainText("does not install or enable");
  assert.deepEqual(await persona("reviewer"), {
    instructions: "Review the exact candidate; report failed checks.",
    instructionsChannel: "native-system",
    model: "local-model",
    mode: "write",
    strict: true,
    timeoutMs: 12345,
    session: "fresh",
    tools: ["read"],
    plugins: [{ id: "fixture/reviewer", revision: "a".repeat(40) }],
  });
  await close();
  await page
    .getByRole("button", { name: "Add agent block", exact: true })
    .click();
  await page
    .locator("#studio-workflow-form")
    .getByLabel("Workflow default profile", { exact: true })
    .selectOption("reviewer");
  await page
    .locator("#studio-node-form")
    .getByLabel("Node profile", { exact: true })
    .selectOption("reviewer");
  await openStudioDetails(page.locator("#studio-child-name"));
  await page.fill("#studio-child-name", "review-child");
  await page.click("#studio-add-child");
  assert.equal(
    (await read()).workflows["review-child"]!.defaultProfile,
    undefined,
  );
  await open();
  const longestName = "p".repeat(128);
  await page.fill("#studio-persona-rename-name", longestName);
  await page.click("#studio-persona-rename");
  await close();
  await validate();
  const boundaryDocument = await read();
  assert.equal(boundaryDocument.workflows.main!.defaultProfile, longestName);
  assert.ok(
    boundaryDocument.workflows.main!.nodes.some(
      (node) => node.kind === "agent" && node.profile === longestName,
    ),
  );
  await open();
  await page.fill("#studio-persona-rename-name", "constructor");
  await page.click("#studio-persona-rename");
  await expect(page.locator("#studio-persona-list")).toHaveValue("constructor");
  const renamed = await read();
  assert.ok(Object.hasOwn(renamed.profiles!, "constructor"));
  assert.equal(renamed.profiles!.reviewer, undefined);
  assert.equal(renamed.workflows.main!.defaultProfile, "constructor");
  const agent = renamed.workflows.main!.nodes.find(
    (node) => node.kind === "agent",
  );
  assert.equal(
    agent?.kind === "agent" ? agent.profile : undefined,
    "constructor",
  );
  await close();
  await validate();
  const authored = await read(),
    identity = validateDocument(authored).identity;
  for (const format of ["json", "yaml"] as const) {
    await page.selectOption("#studio-format", format);
    const event = page.waitForEvent("download");
    await download.click();
    const result = await event;
    const path = join(fixture, `personas.${format}`);
    await result.saveAs(path);
    const restored = parseDocument(readFileSync(path, "utf8"));
    assert.equal(validateDocument(restored).identity, identity);
    assert.deepEqual(restored.profiles, authored.profiles);
    await page.locator("#studio-file").setInputFiles(path);
    await expect(download).toBeEnabled();
    assert.equal(validateDocument(await read()).identity, identity);
    await open();
    await expect(page.locator("#studio-persona-list")).toHaveValue(
      "constructor",
    );
    await expect(page.locator("#studio-persona-message")).not.toContainText(
      "Create a named persona",
    );
    await close();
  }
  checks.push(
    "persona form fields, catalogue choices and exact plugin pins survive JSON/YAML actual downloads",
    "128-character and literal constructor persona names update workflow/agent references; child defaults stay isolated",
    "plugin checkbox glyphs stay 20px inside 44px row targets; hostile metadata stays inert",
  );

  // Invalid field drafts must survive selection and block shared validation/export.
  await open();
  const canonicalTimeout = (await persona("constructor"))!.timeoutMs;
  await field("Timeout (ms)").fill("0");
  await field("Timeout (ms)").press("Tab");
  await create("second");
  await page.selectOption("#studio-persona-list", "constructor");
  await expect(field("Timeout (ms)")).toHaveValue("0");
  assert.equal((await persona("constructor"))!.timeoutMs, canonicalTimeout);
  await close();
  await page.click("#studio-validate");
  await expect(download).toBeDisabled();
  await open();
  await commit(field("Timeout (ms)"), "12345");
  await field("Tool selection").selectOption("unspecified");
  assert.equal((await persona("constructor"))!.tools, undefined);
  await field("Strict tool selection").selectOption("false");
  await field("Plugin selection").selectOption("unspecified");
  assert.equal((await persona("constructor"))!.plugins, undefined);
  await field("Tool selection").selectOption("explicit");
  await field("Plugin selection").selectOption("explicit");
  assert.deepEqual((await persona("constructor"))!.tools, []);
  assert.deepEqual((await persona("constructor"))!.plugins, []);
  await form
    .getByRole("button", { name: "Use binding instructions", exact: true })
    .click();
  assert.equal((await persona("constructor"))!.instructions, undefined);
  await commit(field("System instructions"), "Temporary instructions");
  await commit(field("System instructions"), "");
  assert.equal((await persona("constructor"))!.instructions, "");
  await close();
  await validate();
  checks.push(
    "invalid persona drafts survive selection and cannot validate/export; omitted versus explicit-empty instruction/tool/plugin intents remain distinct",
  );

  // Advanced JSON replaces a surviving persona while its pending field still owns its object.
  await open();
  await field("Model").fill(" ");
  await field("Model").press("Tab");
  await close();
  const raw = page.locator("#studio-profiles");
  await openStudioDetails(raw);
  const replacement = {
    ...(await read()).profiles,
    constructor: {
      ...(await persona("constructor")),
      instructions: "Replaced through advanced JSON",
    },
  };
  await commit(raw, JSON.stringify(replacement));
  await open();
  await expect(field("Model")).toHaveValue(" ");
  await expect(field("System instructions")).toHaveValue(
    "Replaced through advanced JSON",
  );
  await commit(field("Model"), "alternate-model");
  assert.equal((await persona("constructor"))!.model, "alternate-model");
  assert.equal(
    (await persona("constructor"))!.instructions,
    "Replaced through advanced JSON",
  );
  await close();
  await validate();
  const beforeInvalidRaw = JSON.stringify((await read()).profiles);
  await raw.fill("{invalid");
  await raw.press("Tab");
  await open();
  await page.fill("#studio-persona-new-name", "blocked");
  await page.click("#studio-persona-add");
  await expect(page.locator("#studio-persona-message")).toContainText(
    "Apply pending",
  );
  assert.equal(JSON.stringify((await read()).profiles), beforeInvalidRaw);
  await close();
  await commit(raw, beforeInvalidRaw);
  await validate();
  await openStudioDetails(page.locator("#studio-source"));
  const source = await page.locator("#studio-source").inputValue();
  const beforePendingSource = await page.evaluate<string>(
    "JSON.stringify(studioState.document)",
  );
  await page.locator("#studio-source").fill("{invalid");
  await open();
  await page.fill("#studio-persona-new-name", "blocked");
  await page.click("#studio-persona-add");
  assert.equal(
    await page.evaluate<string>("JSON.stringify(studioState.document)"),
    beforePendingSource,
    "Pending source cannot authorize a canonical persona mutation",
  );
  await close();
  await page.locator("#studio-source").fill(source);
  await page.click("#studio-apply-source");
  await expect(download).toBeEnabled();
  await open();
  await expect(page.locator("#studio-persona-message")).not.toContainText(
    "Create a named persona",
  );
  await close();
  checks.push(
    "raw replacement keeps pending persona controls attached; invalid advanced JSON/source cannot mutate persona intent",
  );

  // Unknown selected pins remain authored data when a different local catalogue is connected.
  const withUnknown = {
    ...(await read()).profiles,
    constructor: {
      ...(await persona("constructor")),
      plugins: [{ id: "legacy/unknown", revision: "c".repeat(64) }],
    },
  };
  await commit(raw, JSON.stringify(withUnknown));
  await open();
  await expect(form).toContainText("legacy/unknown");
  await expect(form).toContainText("not in this catalogue");
  await commit(field("Model"), "local-model");
  assert.deepEqual((await persona("constructor"))!.plugins, [
    { id: "legacy/unknown", revision: "c".repeat(64) },
  ]);
  const canonical = JSON.stringify(await read());
  await importCatalogue(
    { ...personaCatalogueFixture, sourcePath: "/tmp/private.db" },
    "invalid-catalogue.json",
  );
  await expect(page.locator("#studio-persona-message")).toContainText(
    "Unknown catalogue field",
  );
  assert.equal(JSON.stringify(await read()), canonical);
  const nextCatalogue = {
    ...personaCatalogueFixture,
    models: ["replacement-model"],
    tools: ["replacement-tool"],
    plugins: [
      ...personaCatalogueFixture.plugins,
      ...Array.from({ length: 313 }, (_, index) => ({
        id: `fixture/entry-${index}`,
        name: `Entry ${index}`,
        revision: "d".repeat(40),
      })),
    ],
  };
  await importCatalogue(nextCatalogue, "catalogue.json");
  await expect(page.locator("#studio-persona-models option")).toHaveCount(1);
  await expect(page.locator("#studio-persona-models option")).toHaveAttribute(
    "value",
    "replacement-model",
  );
  await expect(form).toContainText("not in this catalogue");
  await expect(form.locator(".studio-persona-plugin-list input")).toHaveCount(
    100,
  );
  await page.fill("#studio-persona-plugin-search", "fixture/entry-312");
  await expect(form.locator(".studio-persona-plugin-list input")).toHaveCount(
    1,
  );
  await form.getByLabel("Select plugin Entry 312", { exact: true }).check();
  await form
    .getByRole("button", { name: "Remove plugin legacy/unknown", exact: true })
    .click();
  assert.deepEqual((await persona("constructor"))!.plugins, [
    { id: "fixture/entry-312", revision: "d".repeat(40) },
  ]);
  await close();
  await commit(raw, JSON.stringify(withUnknown));
  await open();
  await page.fill("#studio-persona-plugin-search", "");
  await expect(form).toContainText("legacy/unknown");
  checks.push(
    "catalogue import is validated local data; unknown selected pins are retained and unpinned metadata cannot be selected",
    "315-entry catalogue caps visible rows, searches later entries, and exact reference removal preserves other selected pins",
  );

  // A response for an older persona revision cannot approve a later form edit.
  await close();
  let held: Route | undefined, release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/studio/validate", async (route) => {
    const response = await route.fetch();
    held = route;
    await wait;
    await route.fulfill({ response });
  });
  await page.click("#studio-validate");
  await expect.poll(() => Boolean(held)).toBe(true);
  await open();
  await commit(field("System instructions"), "Newer persona revision");
  await close();
  const oldValidation = page.waitForResponse((response) =>
    response.url().endsWith("/studio/validate"),
  );
  release();
  await oldValidation;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.locator("#studio-status")).toContainText("Draft");
  await expect(download).toBeDisabled();
  assert.equal(
    (await persona("constructor"))!.instructions,
    "Newer persona revision",
  );
  await page.unroute("**/studio/validate");
  await validate();
  checks.push(
    "stale shared-validation response cannot approve a newer persona edit",
  );

  // Catalogues have their own response revision guard.
  await open();
  let old: Route | undefined, releaseCatalogue!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseCatalogue = resolve;
  });
  let imports = 0;
  await page.route("**/studio/persona-catalogue", async (route) => {
    if (route.request().method() !== "POST" || ++imports !== 1)
      return route.continue();
    const response = await route.fetch();
    old = route;
    await gate;
    await route.fulfill({ response });
  });
  await importCatalogue(
    { ...personaCatalogueFixture, models: ["older-model"] },
    "older-catalogue.json",
  );
  await expect.poll(() => Boolean(old)).toBe(true);
  await importCatalogue(
    { ...personaCatalogueFixture, models: ["newer-model"] },
    "newer-catalogue.json",
  );
  await expect(
    page.locator("#studio-persona-models option").first(),
  ).toHaveAttribute("value", "newer-model");
  const oldCatalogue = page.waitForResponse(
    (response) =>
      response.url().endsWith("/studio/persona-catalogue") &&
      Boolean(response.request().postData()?.includes("older-model")),
  );
  releaseCatalogue();
  await oldCatalogue;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.unroute("**/studio/persona-catalogue");
  await expect(
    page.locator("#studio-persona-models option").first(),
  ).toHaveAttribute("value", "newer-model");
  checks.push(
    "older catalogue response cannot overwrite newer connected choices",
  );

  // Focus stays in the native dialog; mobile width stays local.
  await page.screenshot({
    path: join(output, "persona-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  assert.equal(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
    true,
    "Persona dialog has no horizontal overflow at 390px",
  );
  await field("System instructions").focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
    true,
  );
  await page.screenshot({
    path: join(output, "persona-mobile.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await validate();
  await page.selectOption("#studio-format", "yaml");
  const unknownDownload = page.waitForEvent("download");
  await download.click();
  const unknownPath = join(fixture, "unknown-plugin-personas.yaml");
  await (await unknownDownload).saveAs(unknownPath);
  const exportedName: string = "constructor";
  assert.deepEqual(
    parseDocument(readFileSync(unknownPath, "utf8")).profiles![exportedName]!
      .plugins,
    [{ id: "legacy/unknown", revision: "c".repeat(64) }],
  );
  await open();
  await page.click("#studio-persona-delete");
  await expect(page.locator("#studio-persona-delete")).toHaveText(
    "Confirm delete persona",
  );
  await expect(page.locator("#studio-persona-message")).toContainText(
    "2 assignments",
  );
  assert.ok(await persona("constructor"));
  await page.click("#studio-persona-delete");
  assert.equal(await persona("constructor"), undefined);
  const deleted = await read();
  assert.equal(deleted.workflows.main!.defaultProfile, undefined);
  assert.ok(
    deleted.workflows.main!.nodes.every(
      (node) => node.kind !== "agent" || node.profile === undefined,
    ),
  );
  await close();
  await page.click("#studio-validate");
  await expect(page.locator("#studio-message")).toContainText(
    "agent requires a profile",
  );
  await expect(download).toBeDisabled();
  await page.locator("#studio-definition").selectOption("main");
  await page
    .locator("#studio-workflow-form")
    .getByLabel("Workflow default profile", { exact: true })
    .selectOption("second");
  await validate();
  checks.push(
    "native dialog keyboard/mobile controls remain usable; confirmed deletion removes exact references and requires orphaned agents to be reassigned before export",
  );
  await page.click("#studio-new");
  await expect(download).toBeEnabled();
  return checks;
}
