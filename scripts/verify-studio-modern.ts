// Browser interaction regressions. This module runs inside verify-studio.ts's
// isolated server, request audit, and empty database fixture.
import assert from "node:assert/strict";
import { expect, type Locator, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowDocument } from "../src/portable/model.js";
import { parseDocument, validateDocument } from "../src/portable/validation.js";

/** Open collapsed ancestor panels by their actual summary controls. */
export async function openStudioDetails(control: Locator) {
  const ancestors = control.locator("xpath=ancestor::details");
  for (let i = (await ancestors.count()) - 1; i >= 0; i--) {
    const details = ancestors.nth(i);
    if ((await details.getAttribute("open")) === null)
      await details.locator(":scope > summary").click();
  }
}

export async function verifyModernStudio(
  page: Page,
  base: string,
  fixture: string,
  output: string,
) {
  const checks: string[] = [];
  const download = page.locator("#studio-download");
  const form = page.locator("#studio-node-form");
  const read = async () =>
    parseDocument(await page.locator("#studio-source").inputValue());
  const validate = async () => {
    await page.click("#studio-validate");
    await expect(page.locator("#studio-status")).toHaveText("Document valid");
    await expect(download).toBeEnabled();
  };
  const block = (id: string, kind: string) =>
    page.getByRole("button", { name: `${kind} block ${id}`, exact: true });
  const pick = async (id: string, kind: string) => {
    await block(id, kind).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#studio-node-title")).toContainText(id);
  };
  const worldPosition = async (id: string, kind: string) =>
    block(id, kind).evaluate((element) => {
      if (!(element instanceof SVGGraphicsElement))
        throw new Error("Expected an SVG block");
      const matrix = element.transform.baseVal.consolidate()?.matrix;
      if (!matrix) throw new Error("Block has no world position");
      return { x: matrix.e, y: matrix.f };
    });
  const drag = async (
    id: string,
    kind: string,
    dx: number,
    dy: number,
    cancel = false,
    blocked = false,
  ) => {
    const target = block(id, kind);
    await target.scrollIntoViewIfNeeded();
    const before = await worldPosition(id, kind);
    const screen = await target.evaluate(
      (element, vector) => {
        if (!(element instanceof SVGGraphicsElement))
          throw new Error("Expected an SVG block");
        const matrix = element.getScreenCTM();
        if (!matrix) throw new Error("Canvas is not rendered");
        const start = new DOMPoint(95, 45).matrixTransform(matrix);
        return {
          x: start.x,
          y: start.y,
          dx: matrix.a * vector.dx + matrix.c * vector.dy,
          dy: matrix.b * vector.dx + matrix.d * vector.dy,
        };
      },
      { dx, dy },
    );
    await page.mouse.move(screen.x, screen.y);
    await page.mouse.down();
    await page.mouse.move(screen.x + screen.dx, screen.y + screen.dy, {
      steps: 8,
    });
    if (cancel)
      await page.locator("#studio-graph").dispatchEvent("pointercancel", {
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        bubbles: true,
      });
    await page.mouse.up();
    const after = await worldPosition(id, kind);
    assert.ok(
      Math.abs(after.x - before.x - (cancel || blocked ? 0 : dx)) < 2 &&
        Math.abs(after.y - before.y - (cancel || blocked ? 0 : dy)) < 2,
      `World-space drag ${cancel ? "cancel" : "commit"}: ${JSON.stringify({ before, after, dx, dy })}`,
    );
    return after;
  };
  const pan = async () => {
    const graph = page.locator("#studio-graph");
    for (let i = 0; i < 8; i++) {
      const room = await page
        .locator("#studio-graph-scroll")
        .evaluate(
          (element) =>
            element.scrollWidth - element.clientWidth > 100 ||
            element.scrollHeight - element.clientHeight > 100,
        );
      if (room) break;
      await page.click("#studio-zoom-in");
    }
    await graph.scrollIntoViewIfNeeded();
    const before = await worldPosition("route", "branch");
    const probe = await graph.evaluate((element) => {
      if (!(element instanceof SVGSVGElement))
        throw new Error("Expected an SVG canvas");
      const bounds = element.getBoundingClientRect();
      const viewport = element.parentElement!.getBoundingClientRect();
      const left = Math.max(bounds.left, viewport.left, 0);
      const topEdge = Math.max(bounds.top, viewport.top, 0);
      const right = Math.min(bounds.right, viewport.right, innerWidth);
      const bottom = Math.min(bounds.bottom, viewport.bottom, innerHeight - 80);
      const matrix = element.getScreenCTM();
      if (!matrix) throw new Error("Missing canvas matrix");
      for (const x of [0.2, 0.5, 0.8])
        for (const y of [0.2, 0.5, 0.8]) {
          const px = left + (right - left) * x;
          const py = topEdge + (bottom - topEdge) * y;
          const top = document.elementFromPoint(px, py);
          if (
            py > 0 &&
            py < innerHeight - 80 &&
            top &&
            element.contains(top) &&
            !top.closest(".studio-block")
          )
            return { x: px, y: py, e: matrix.e, f: matrix.f };
        }
      throw new Error("No visible blank canvas area for pan gesture");
    });
    await page.mouse.move(probe.x, probe.y);
    await page.mouse.down();
    await page.mouse.move(probe.x - 35, probe.y - 30, { steps: 6 });
    await page.mouse.up();
    assert.deepEqual(
      await worldPosition("route", "branch"),
      before,
      "Panning moves the viewport, not stored block positions",
    );
    const after = await graph.evaluate((element) => {
      if (!(element instanceof SVGSVGElement)) throw new Error("Expected SVG");
      const matrix = element.getScreenCTM();
      if (!matrix) throw new Error("Missing canvas matrix");
      return { e: matrix.e, f: matrix.f };
    });
    assert.ok(
      Math.abs(after.e - probe.e) > 10 || Math.abs(after.f - probe.f) > 10,
      "A blank-canvas pointer gesture actually pans the viewport",
    );
  };
  const importDocument = async (document: WorkflowDocument) => {
    const file = join(fixture, "modern-import.json");
    writeFileSync(file, JSON.stringify(document));
    await page.locator("#studio-file").setInputFiles(file);
    await expect(download).toBeEnabled();
  };
  const positions = async (document: WorkflowDocument) => {
    const result: Record<string, { x: number; y: number }> = {};
    for (const node of document.workflows.main!.nodes)
      result[node.id] = await worldPosition(node.id, node.kind);
    return result;
  };

  // The product default is dark on all three pages, even for a light OS theme.
  await page.emulateMedia({ colorScheme: "light" });
  for (const path of ["/studio", "/", "/graph"]) {
    await page.goto(new URL(path, base).href);
    const theme = await page.locator("body").evaluate((element) => {
      const style = getComputedStyle(element);
      const luminances = [style.backgroundColor, style.color].map((text) => {
        const channels = text
          .match(/[\d.]+/g)
          ?.slice(0, 3)
          .map(Number);
        if (!channels || channels.length !== 3)
          throw new Error(`Unexpected color ${text}`);
        const linear = channels.map((v) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
      });
      const background = luminances[0]!;
      const foreground = luminances[1]!;
      return {
        background,
        contrast:
          (Math.max(background, foreground) + 0.05) /
          (Math.min(background, foreground) + 0.05),
        colorScheme: style.colorScheme,
      };
    });
    assert.ok(theme.background < 0.1, `${path} defaults to a dark surface`);
    assert.ok(theme.contrast >= 4.5, `${path} has readable default text`);
    assert.match(theme.colorScheme, /dark/, `${path} has dark native controls`);
  }
  checks.push(
    "default dark on authoring and both inspectors with light OS theme",
  );
  await page.goto(new URL("/studio", base).href);
  await expect(download).toBeEnabled();
  await expect(page.locator("#studio-source-panel")).not.toHaveAttribute(
    "open",
  );
  await page.setViewportSize({ width: 1265, height: 712 });
  await page.screenshot({ path: join(output, "studio-workbench-1265.png") });
  const density = await page.evaluate(() =>
    Object.fromEntries(
      [
        ["sidebar", ".studio-sidebar"],
        ["definitions", "[aria-label='Workflow definitions']"],
        ["library", ".studio-library"],
        ["heading", ".studio-library h2"],
        ["agent", "#studio-catalogue button[data-kind='agent']"],
      ].map(([name, selector]) => [
        name,
        document.querySelector(selector!)?.getBoundingClientRect().toJSON(),
      ]),
    ),
  );
  writeFileSync(
    join(output, "studio-workbench-1265-layout.json"),
    JSON.stringify(density, null, 2),
  );
  await expect(
    page.getByRole("heading", { name: "Available blocks", exact: true }),
  ).toBeInViewport();
  const visibleAgent = page.getByRole("button", {
    name: "Add agent block",
    exact: true,
  });
  await expect(visibleAgent).toBeInViewport({ ratio: 0.5 });
  await expect(visibleAgent.locator(".studio-icon")).toBeInViewport({
    ratio: 1,
  });
  await expect(visibleAgent.locator("strong")).toBeInViewport({ ratio: 1 });
  const visibleHeight = await visibleAgent.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return Math.min(box.bottom, innerHeight) - Math.max(box.top, 0);
  });
  assert.ok(
    visibleHeight >= 44,
    "First add-block affordance has a visible pointer target",
  );
  await expect(
    page.locator("#studio-child-name").locator("xpath=ancestor::details"),
  ).not.toHaveAttribute("open");
  await visibleAgent.locator("strong").click();
  await expect(page.locator("#studio-node-title")).toHaveText("agent");
  await page.click("#studio-new");
  await expect(download).toBeEnabled();
  await page.setViewportSize({ width: 1440, height: 1000 });
  checks.push(
    "block palette remains visible at 1265x712 with definition management collapsed",
  );

  // The reported branch scenario must insert two siblings at their own ports.
  await openStudioDetails(page.locator("#studio-child-name"));
  await page.fill("#studio-child-name", "review");
  await page.click("#studio-add-child");
  await page
    .getByRole("button", { name: "Add branch block", exact: true })
    .click();
  await page.locator("#studio-insert-port").selectOption("true");
  await page
    .getByRole("button", { name: "Add parallel block", exact: true })
    .click();
  await pick("branch", "branch");
  await page.locator("#studio-insert-port").selectOption("false");
  await page
    .getByRole("button", { name: "Add parallel block", exact: true })
    .click();
  await validate();
  const siblings = await read();
  const branch = siblings.workflows.main!.nodes.find((n) => n.id === "branch");
  assert.equal(branch?.kind, "branch");
  if (branch?.kind !== "branch") throw new Error("Expected authored branch");
  assert.equal(branch.then, "parallel");
  assert.equal(branch.else, "parallel1");
  for (const id of ["parallel", "parallel1"]) {
    const parallel = siblings.workflows.main!.nodes.find((n) => n.id === id);
    assert.equal(parallel?.kind, "parallel");
    assert.ok(parallel?.kind === "parallel" && parallel.next === "complete");
  }
  const anchor = await worldPosition("branch", "branch");
  const first = await worldPosition("parallel", "parallel");
  const second = await worldPosition("parallel1", "parallel");
  assert.ok(
    Math.abs(first.x - second.x) < 2,
    "True and false children share the downstream sibling column",
  );
  assert.ok(
    Math.hypot(first.x - anchor.x, first.y - anchor.y) < 700 &&
      Math.hypot(second.x - anchor.x, second.y - anchor.y) < 700,
    "Both route children stay near their branch anchor",
  );
  assert.ok(
    Math.hypot(first.x - second.x, first.y - second.y) >= 120,
    "Sibling cards do not overlap",
  );
  await page.screenshot({ path: join(output, "studio-branch-siblings.png") });
  checks.push(
    "true/false insertion ports preserve successor and sibling placement",
  );

  const implicit = structuredClone(siblings);
  delete implicit.workflows.main!.layout;
  await importDocument(implicit);
  await page.click("#studio-zoom-fit");
  const beforeImplicit = await positions(implicit);
  await drag("branch", "branch", -35, 25);
  for (const node of implicit.workflows.main!.nodes)
    if (node.id !== "branch")
      assert.deepEqual(
        await worldPosition(node.id, node.kind),
        beforeImplicit[node.id],
        `Moving the imported branch does not reflow ${node.id}`,
      );
  await validate();
  assert.equal(
    validateDocument(await read()).identity,
    validateDocument(implicit).identity,
  );
  checks.push(
    "moving one block freezes implicit imported positions without reflow",
  );

  // Import negative and distant coordinates. Measure actual pointer transforms
  // instead of assuming a scale or a specific screen origin.
  const imported: WorkflowDocument = {
    format: "asf-ts-workflow/v1",
    root: "main",
    profiles: {},
    workflows: {
      main: {
        version: "1",
        inputSchema: {},
        outputSchema: {},
        start: "route",
        nodes: [
          {
            id: "route",
            kind: "branch",
            predicate: { left: true, op: "truthy" },
            then: "complete",
            else: "complete",
          },
          {
            id: "complete",
            kind: "end",
            output: { $ref: "#/input" },
            passed: true,
          },
        ],
        layout: { route: { x: -250, y: -120 }, complete: { x: 1450, y: 980 } },
      },
    },
  };
  await importDocument(imported);
  const semanticIdentity = validateDocument(imported).identity;
  await page.click("#studio-zoom-fit");
  await pick("route", "branch");
  const titleStyle = await block("route", "branch").evaluate((element) => {
    const texts = [...element.querySelectorAll("text")];
    const kind = texts.find((text) => text.textContent === "branch");
    const title = texts.find((text) => text.textContent === "route");
    if (!kind || !title)
      throw new Error("Kind and ID need separate visible labels");
    return {
      kind: parseFloat(getComputedStyle(kind).fontSize),
      title: parseFloat(getComputedStyle(title).fontSize),
      weight: getComputedStyle(title).fontWeight,
    };
  });
  assert.ok(
    titleStyle.title > titleStyle.kind,
    "Block ID is stronger than kind caption",
  );
  assert.ok(
    Number(titleStyle.weight) >= 600,
    "Block title has a strong visual weight",
  );
  const glyph = await block("route", "branch").evaluate((element) => {
    const icon = element.querySelector(".studio-icon");
    const frame = element.querySelector(".studio-node-frame");
    if (!icon || !frame) throw new Error("Missing kind icon or card frame");
    return {
      fill: getComputedStyle(icon).fill,
      glyphWidth: parseFloat(getComputedStyle(icon).strokeWidth),
      frameWidth: parseFloat(getComputedStyle(frame).strokeWidth),
    };
  });
  assert.equal(
    glyph.fill,
    "none",
    "Selected kind icon remains an outlined glyph",
  );
  assert.ok(
    glyph.glyphWidth > 0 && glyph.glyphWidth < glyph.frameWidth,
    "Selection strengthens the card frame without thickening the kind icon",
  );
  const focusCard = block("complete", "end");
  const resting = await focusCard.evaluate((element) => {
    const frame = element.querySelector(".studio-node-frame");
    if (!frame) throw new Error("Missing card focus surface");
    const style = getComputedStyle(frame);
    return { width: parseFloat(style.strokeWidth), stroke: style.stroke };
  });
  await focusCard.focus();
  await expect(focusCard).toBeFocused();
  const focus = await focusCard.evaluate((element) => {
    const rect = element.querySelector(".studio-node-frame");
    if (!rect) throw new Error("Missing card focus surface");
    const style = getComputedStyle(rect);
    return { width: parseFloat(style.strokeWidth), stroke: style.stroke };
  });
  assert.ok(
    focus.width >= 2 && focus.stroke !== "none",
    "Keyboard focus is visible on the card",
  );
  assert.notDeepEqual(
    focus,
    resting,
    "Focus is distinct from an unselected card",
  );
  checks.push("strong block title/kind distinction and visible keyboard focus");
  await block("route", "branch").focus();
  await drag("route", "branch", -45, 30);
  const beforeZoom = await page.locator("#studio-zoom-label").textContent();
  await page.click("#studio-zoom-in");
  await expect(page.locator("#studio-zoom-label")).toContainText(/\d+%/);
  await expect(page.locator("#studio-zoom-label")).not.toHaveText(beforeZoom!);
  await drag("route", "branch", 60, -20);
  await page.click("#studio-zoom-out");
  await page.locator("#studio-graph-scroll").evaluate((element) => {
    element.scrollLeft = 75;
    element.scrollTop = 50;
  });
  await page.evaluate(() => window.scrollBy(0, 150));
  await drag("route", "branch", 30, 25);
  await pan();
  await drag("route", "branch", -20, 15);
  await drag("route", "branch", 90, 80, true);
  checks.push(
    "negative imported coordinates, real drag under zoom/scroll/pan, pointer cancellation",
  );

  // Four buttons and arrow keys offer equivalent layout-only movement.
  await pick("route", "branch");
  const beforeButtons = await worldPosition("route", "branch");
  for (const direction of ["left", "up", "right", "down"]) {
    const before = await worldPosition("route", "branch");
    await page.click(`#studio-move-${direction}`);
    const after = await worldPosition("route", "branch");
    const expected = direction === "left" || direction === "up" ? -1 : 1;
    const axis = direction === "left" || direction === "right" ? "x" : "y";
    const fixed = axis === "x" ? "y" : "x";
    assert.ok(
      (after[axis] - before[axis]) * expected > 0,
      `${direction} button moves the selected block in that direction`,
    );
    assert.equal(after[fixed], before[fixed]);
  }
  assert.deepEqual(await worldPosition("route", "branch"), beforeButtons);
  await form.getByLabel("Block ID", { exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  assert.deepEqual(
    await worldPosition("route", "branch"),
    beforeButtons,
    "Arrow keys in an input retain their native caret behavior",
  );
  await block("route", "branch").focus();
  for (const key of ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"]) {
    const before = await worldPosition("route", "branch");
    await page.keyboard.press(`Alt+${key}`);
    assert.notDeepEqual(
      await worldPosition("route", "branch"),
      before,
      `${key} moves the focused block`,
    );
  }
  assert.deepEqual(await worldPosition("route", "branch"), beforeButtons);
  await validate();
  assert.equal(validateDocument(await read()).identity, semanticIdentity);
  checks.push(
    "four-direction buttons and keyboard movement preserve semantic identity",
  );

  // A layout gesture must never approve an invalid form/profile/source draft.
  const predicate = form.getByLabel("predicate", { exact: true });
  await openStudioDetails(predicate);
  await predicate.fill("{invalid");
  await predicate.press("Tab");
  await drag("route", "branch", 25, 10);
  await pick("complete", "end");
  await pick("route", "branch");
  await expect(predicate).toHaveValue("{invalid");
  await page.click("#studio-validate");
  await expect(download).toBeDisabled();
  await predicate.fill('{"left":true,"op":"truthy"}');
  await predicate.press("Tab");
  await validate();
  const profiles = page.locator("#studio-profiles");
  await openStudioDetails(profiles);
  await profiles.fill("[");
  await profiles.press("Tab");
  await drag("route", "branch", 20, 10);
  await page.click("#studio-validate");
  await expect(download).toBeDisabled();
  await expect(profiles).toHaveValue("[");
  assert.deepEqual((await read()).profiles, {});
  await profiles.fill("{}");
  await profiles.press("Tab");
  await validate();
  const canonical = JSON.stringify(await read());
  const source = page.locator("#studio-source");
  await openStudioDetails(source);
  const invalidSource =
    "format: asf-ts-workflow/v1\nroot: main\nroot: invalid\n";
  await source.fill(invalidSource);
  await drag("route", "branch", 20, 10, false, true);
  await pick("complete", "end");
  await expect(source).toHaveValue(invalidSource);
  await page.click("#studio-validate");
  await expect(download).toBeDisabled();
  await source.fill(canonical);
  await page.click("#studio-apply-source");
  await expect(download).toBeEnabled();
  checks.push(
    "drag and selection never approve invalid node, profile or source drafts",
  );

  // Exported layout reflects the pointer gesture in each actual file format.
  const dragged = await read();
  for (const format of ["json", "yaml"]) {
    await page.selectOption("#studio-format", format);
    const pending = page.waitForEvent("download");
    await download.click();
    const file = join(fixture, `dragged.${format}`);
    await (await pending).saveAs(file);
    const restored = parseDocument(readFileSync(file, "utf8"));
    assert.deepEqual(
      restored.workflows.main!.layout,
      dragged.workflows.main!.layout,
    );
    assert.equal(validateDocument(restored).identity, semanticIdentity);
    await page.locator("#studio-file").setInputFiles(file);
    await expect(download).toBeEnabled();
    assert.deepEqual(
      (await read()).workflows.main!.layout,
      dragged.workflows.main!.layout,
    );
  }
  checks.push(
    "actual YAML/JSON downloads retain dragged layout and semantic identity",
  );

  for (const id of ["__proto__", "constructor"]) {
    await importDocument(imported);
    await pick("route", "branch");
    const oldPosition = await worldPosition("route", "branch");
    const idControl = form.getByLabel("Block ID", { exact: true });
    await idControl.fill(id);
    await idControl.press("Tab");
    await expect(block(id, "branch")).toBeVisible();
    assert.deepEqual(
      await worldPosition(id, "branch"),
      oldPosition,
      "Renaming a block to a literal object key retains its position",
    );
    await validate();
    const literalIdentity = validateDocument(await read()).identity;
    await page.click("#studio-zoom-fit");
    const moved = await drag(id, "branch", -30, 25);
    await validate();
    const literal = await read();
    assert.ok(Object.hasOwn(literal.workflows.main!.layout!, id));
    assert.deepEqual(literal.workflows.main!.layout![id], moved);
    assert.equal(validateDocument(literal).identity, literalIdentity);
    await page.selectOption("#studio-format", "json");
    const pending = page.waitForEvent("download");
    await download.click();
    const file = join(fixture, `literal-${id}.json`);
    await (await pending).saveAs(file);
    const restored = parseDocument(readFileSync(file, "utf8"));
    assert.ok(Object.hasOwn(restored.workflows.main!.layout!, id));
    assert.deepEqual(restored.workflows.main!.layout![id], moved);
    assert.equal(validateDocument(restored).identity, literalIdentity);
    await page.locator("#studio-file").setInputFiles(file);
    await expect(download).toBeEnabled();
    assert.deepEqual(await worldPosition(id, "branch"), moved);
  }
  checks.push(
    "literal object-key IDs rename/move/JSON reimport with own coordinates and stable identity",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "390px mobile page has no horizontal overflow",
  );
  for (const id of [
    "studio-move-left",
    "studio-move-right",
    "studio-move-up",
    "studio-move-down",
    "studio-zoom-in",
    "studio-zoom-out",
    "studio-zoom-fit",
  ]) {
    const bounds = await page.locator(`#${id}`).boundingBox();
    assert.ok(
      bounds && bounds.width >= 44 && bounds.height >= 44,
      `${id} remains a usable mobile control`,
    );
  }
  await page.screenshot({
    path: join(output, "studio-modern-mobile.png"),
    fullPage: true,
  });
  checks.push("390px mobile page has no overflow and 44px canvas controls");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.click("#studio-new");
  await expect(download).toBeEnabled();
  return checks;
}
