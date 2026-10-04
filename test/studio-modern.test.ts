import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import type { WorkflowDocument } from "../src/portable/model.js";
import { parseDocument, validateDocument } from "../src/portable/validation.js";

const fixture: WorkflowDocument = {
  format: "asf-ts-workflow/v1",
  root: "main",
  profiles: {},
  workflows: {
    main: {
      version: "1",
      inputSchema: {},
      outputSchema: {},
      start: "branch",
      nodes: [
        {
          id: "branch",
          kind: "branch",
          predicate: { left: true, op: "truthy" },
          then: "complete",
          else: "complete",
        },
        { id: "complete", kind: "end", output: { $ref: "#/input" } },
      ],
      layout: { branch: { x: -300, y: -80 }, complete: { x: 380, y: -80 } },
    },
    review: {
      version: "1",
      inputSchema: {},
      outputSchema: {},
      start: "complete",
      nodes: [{ id: "complete", kind: "end", output: { $ref: "#/input" } }],
    },
  },
};

interface EditorActions {
  load(document: WorkflowDocument): void;
  add(kind: string): void;
  pick(id: string): void;
  move(x: number, y: number): void;
  cancel(): void;
  preview(id: string, x: number, y: number): void;
  port(value: string): void;
  pending(value: boolean): void;
  draft(): void;
  inspect(): string;
}

/** Execute the actual editor actions. Only DOM rendering is replaced: geometry
 * and pointer transforms remain covered by the real Chromium acceptance run. */
function editor() {
  class Element {
    value = "";
    textContent = "";
    className = "";
    dataset: Record<string, string> = {};
    disabled = false;
    scrollLeft = 0;
    scrollTop = 0;
  }
  class Input extends Element {}
  class Select extends Element {}
  class Button extends Element {}
  class SVG extends Element {
    hasPointerCapture() {
      return false;
    }
  }
  const elements = new Map<string, Element>([
    ["studio-source", new Input()],
    ["studio-insert-port", new Select()],
    ["studio-download", new Button()],
    ["studio-status", new Element()],
    ["studio-message", new Element()],
    ["studio-graph-scroll", new Element()],
    ["studio-graph", new SVG()],
  ]);
  const source = readFileSync("src/web/studio.js", "utf8");
  const boundary = source.indexOf('studioElement("studio-new").onclick');
  assert.ok(
    boundary > 0,
    "Editor keeps bootstrap separate from action functions",
  );
  const context = createContext({
    document: { getElementById: (id: string) => elements.get(id) },
    HTMLInputElement: Input,
    HTMLTextAreaElement: Input,
    HTMLSelectElement: Select,
    HTMLButtonElement: Button,
    SVGSVGElement: SVG,
  });
  runInContext(
    source.slice(0, boundary) +
      `
      studioRender = () => studioSource();
      studioRenderGraph = () => {};
      studioRenderNode = () => {};
      globalThis.actions = {
        load: studioLoad, add: studioAddBlock, pick: studioPick,
        move: studioMove, cancel: studioCancelGesture,
        port: value => studioControl('studio-insert-port').value = value,
        pending: value => studioState.sourceDirty = value,
        draft: () => studioState.drafts.set('node:predicate', {raw:'{invalid'}),
        preview: (node, x, y) => studioCanvas.gesture = {
          pointer:1,node,preview:{x,y},scroll:{x:0,y:0},
          start:{x:0,y:0},allowed:true,moved:true
        },
        inspect: () => JSON.stringify({
          document:studioState.document,
          source:studioControl('studio-source').value,
          selected:studioState.selected,
          position:studioPosition(studioNode()),
          draftKeys:[...studioState.drafts.keys()],
          validated:studioState.validated,
          disabled:studioButton('studio-download').disabled,
          gesture:studioCanvas.gesture
        })
      };`,
    context,
    { filename: "studio.js", timeout: 1000 },
  );
  const actions = context.actions as EditorActions;
  actions.load(fixture);
  const inspect = () =>
    JSON.parse(actions.inspect()) as {
      document: WorkflowDocument;
      source: string;
      selected: string;
      position: { x: number; y: number };
      draftKeys: string[];
      validated: number;
      disabled: boolean;
      gesture: unknown;
    };
  return { actions, inspect };
}

test("branch route insertion preserves each original successor and keeps sibling columns", () => {
  const { actions, inspect } = editor();
  actions.port("true");
  actions.add("parallel");
  actions.pick("branch");
  actions.port("false");
  actions.add("parallel");
  const { document } = inspect();
  const main = document.workflows.main!;
  const branch = main.nodes.find((node) => node.id === "branch");
  assert.ok(branch?.kind === "branch");
  assert.equal(branch.then, "parallel");
  assert.equal(branch.else, "parallel1");
  for (const id of ["parallel", "parallel1"]) {
    const child = main.nodes.find((node) => node.id === id);
    assert.ok(child?.kind === "parallel");
    assert.equal(child.next, "complete");
  }
  const first = main.layout!.parallel!;
  const second = main.layout!.parallel1!;
  assert.equal(first.x, second.x);
  assert.ok(Math.abs(first.y - second.y) >= 150);
  validateDocument(document);
});

test("Auto chooses the remaining terminal branch route; explicit insertion retains a prior child", () => {
  const { actions, inspect } = editor();
  actions.port("auto");
  actions.add("parallel");
  actions.pick("branch");
  actions.add("parallel");
  actions.pick("branch");
  actions.port("true");
  actions.add("workflow");
  const main = inspect().document.workflows.main!;
  const branch = main.nodes.find((node) => node.id === "branch");
  const workflow = main.nodes.find((node) => node.id === "workflow");
  assert.ok(branch?.kind === "branch" && workflow?.kind === "workflow");
  assert.equal(branch.then, "workflow");
  assert.equal(branch.else, "parallel1");
  assert.equal(workflow.next, "parallel");
  validateDocument(inspect().document);
});

test("negative imported movement changes only layout, clamps bounds and retains invalid drafts", () => {
  const { actions, inspect } = editor();
  const before = inspect();
  const identity = validateDocument(before.document).identity;
  actions.draft();
  actions.move(-20, 40);
  const moved = inspect();
  assert.deepEqual(moved.position, { x: -320, y: -40 });
  assert.deepEqual(
    moved.document.workflows.main!.nodes,
    before.document.workflows.main!.nodes,
  );
  assert.deepEqual(moved.draftKeys, ["node:predicate"]);
  assert.equal(moved.validated, -1);
  assert.equal(moved.disabled, true);
  assert.equal(validateDocument(moved.document).identity, identity);
  actions.move(-20000, 20000);
  assert.deepEqual(inspect().position, { x: -10000, y: 10000 });
  actions.pending(true);
  const blocked = inspect();
  actions.move(40, 30);
  actions.add("command");
  assert.deepEqual(inspect(), blocked, "Pending source blocks canonical edits");
});

test("cancelled position preview restores imported layout without changing canonical source", () => {
  const { actions, inspect } = editor();
  const before = inspect();
  actions.preview("branch", -600, -400);
  const preview = inspect();
  assert.deepEqual(preview.position, { x: -600, y: -400 });
  assert.deepEqual(preview.document, before.document);
  assert.equal(preview.source, before.source);
  actions.cancel();
  const after = inspect();
  assert.equal(after.gesture, null);
  assert.deepEqual(after.position, before.position);
  assert.deepEqual(after.document, before.document);
  assert.equal(after.source, before.source);
});

test("moving one imported block freezes implicit positions without moving its successors", () => {
  const { actions, inspect } = editor();
  const imported = structuredClone(fixture);
  delete imported.workflows.main!.layout;
  actions.load(imported);
  const identity = validateDocument(imported).identity;
  actions.pick("complete");
  const beforeSuccessor = inspect().position;
  actions.pick("branch");
  actions.move(-70, 40);
  actions.pick("complete");
  assert.deepEqual(
    inspect().position,
    beforeSuccessor,
    "An individual move cannot reflow an implicit successor position",
  );
  assert.equal(validateDocument(inspect().document).identity, identity);
});

test("a later block edit cancels a stale drag preview without saving its position", () => {
  const { actions, inspect } = editor();
  const before = inspect();
  actions.preview("branch", -850, -600);
  actions.pick("complete");
  actions.move(20, 0);
  const after = inspect();
  assert.equal(after.gesture, null);
  assert.deepEqual(
    after.document.workflows.main!.layout!.branch,
    before.document.workflows.main!.layout!.branch,
  );
  assert.deepEqual(after.document.workflows.main!.layout!.complete, {
    x: 400,
    y: -80,
  });
  assert.equal(
    validateDocument(after.document).identity,
    validateDocument(before.document).identity,
  );
});

for (const id of ["__proto__", "constructor"])
  test(`literal block ID ${id} has finite own layout and survives source round trip`, () => {
    const { actions, inspect } = editor();
    const imported = structuredClone(fixture);
    const definition = imported.workflows.main!;
    definition.start = id;
    definition.nodes[0]!.id = id;
    definition.layout = {};
    actions.load(imported);
    const initial = inspect().position;
    assert.ok(Number.isFinite(initial.x) && Number.isFinite(initial.y));
    const identity = validateDocument(imported).identity;
    actions.pick("complete");
    const successor = inspect().position;
    actions.pick(id);
    actions.move(25, -30);
    const moved = inspect();
    const expected = { x: initial.x + 25, y: initial.y - 30 };
    assert.deepEqual(moved.position, expected);
    assert.ok(Object.hasOwn(moved.document.workflows.main!.layout!, id));
    actions.pick("complete");
    assert.deepEqual(inspect().position, successor);
    const restored = parseDocument(moved.source);
    assert.ok(Object.hasOwn(restored.workflows.main!.layout!, id));
    assert.deepEqual(restored.workflows.main!.layout![id], expected);
    assert.equal(validateDocument(restored).identity, identity);
  });
