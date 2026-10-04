import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import type { WorkflowDocument } from "../src/portable/model.js";

interface PersonaActions {
  replace(value: unknown): void;
  reassign(oldName: string, newName?: string): number;
  pending(owner: string, field: string, value: string): void;
  apply(owner: string, field: string): boolean;
  guard(sourceDirty: boolean, rawDirty: boolean): boolean;
  inspect(): string;
}

// Execute the production draft/reference actions. The real browser runner covers
// persona click handlers, rendering, native constraints, focus and networking.
function editor() {
  class Element {
    value = "";
    textContent = "";
    className = "";
    dataset: Record<string, string> = {};
    disabled = false;
    validationMessage = "";
    setCustomValidity(message: string) {
      this.validationMessage = message;
    }
    checkValidity() {
      return !this.validationMessage;
    }
    append() {}
    replaceChildren() {}
    setAttribute() {}
    addEventListener() {}
  }
  class Input extends Element {}
  class Select extends Element {}
  class Button extends Element {}
  class SVG extends Element {}
  const elements = new Map<string, Element>([
    ["studio-source", new Input()],
    ["studio-download", new Button()],
    ["studio-status", new Element()],
    ["studio-message", new Element()],
    ["studio-graph-scroll", new Element()],
    ["studio-graph", new SVG()],
  ]);
  const source = readFileSync("src/web/studio.js", "utf8");
  const boundary = source.indexOf('studioElement("studio-new").onclick');
  assert.ok(boundary > 0);
  const context = createContext({
    document: {
      getElementById: (id: string) => elements.get(id),
      createElement: (tag: string) =>
        tag === "select" ? new Select() : new Input(),
    },
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
      studioRenderGraph = studioRenderNode = studioRenderSettings = () => {};
      const fixture = {
        format:'asf-ts-workflow/v1',root:'main',profiles:{reviewer:{model:'old'}},
        workflows:{
          main:{version:'1',start:'agent',inputSchema:{},outputSchema:{},defaultProfile:'reviewer',
            nodes:[{id:'agent',kind:'agent',profile:'reviewer',next:'end'}, {id:'end',kind:'end'}]},
          child:{version:'1',start:'end',inputSchema:{},outputSchema:{},
            nodes:[{id:'end',kind:'end'}]}
        }
      };
      studioLoad(fixture);
      const owned = new Map();
      function owner(name) {
        if(name === 'main') return studioState.document.workflows.main;
        if(name === 'agent') return studioState.document.workflows.main.nodes[0];
        if(!owned.has(name)) {
          owned.set(name, studioState.document.profiles[name]);
          studioPersonaOwners.set(owned.get(name), name);
        }
        return owned.get(name);
      }
      globalThis.actions = {
        replace: studioReplaceProfiles, reassign:studioReassignPersona,
        pending: (name, field, value) => {
          const scope = owner(name),
            control = studioField(new HTMLInputElement(), scope, field,
              scope[field], field === 'model' ? 'text' : 'select',
              value => scope[field] = value);
          control.value = value;
          studioState.drafts.set(studioScope(scope)+':'+field,
            {control,type:'text',change:value=>scope[field]=value,label:field,optional:false});
        },
        apply: (name, field) => {
          const key = studioScope(owner(name))+':'+field;
          return studioApplyField(key, studioState.drafts.get(key));
        },
        guard: (sourceDirty, rawDirty) => {
          studioState.sourceDirty = sourceDirty;
          const key = studioScope(studioState.document)+':profiles';
          if(rawDirty) studioState.drafts.set(key, {});
          else studioState.drafts.delete(key);
          return studioPersonaWritable();
        },
        inspect: () => JSON.stringify({
          document:studioState.document,
          drafts:[...studioState.drafts].map(([key,draft]) => [key,draft.control?.value]),
          owners:[...studioPersonaOwners.values()]
        })
      };`,
    context,
    { filename: "studio.js", timeout: 1000 },
  );
  const actions = context.actions as PersonaActions;
  const inspect = () =>
    JSON.parse(actions.inspect()) as {
      document: WorkflowDocument;
      drafts: [string, string][];
      owners: string[];
    };
  return { actions, inspect };
}

test("persona rename updates canonical and pending assignment references without affecting child defaults", () => {
  const { actions, inspect } = editor();
  actions.pending("main", "defaultProfile", "reviewer");
  actions.pending("agent", "profile", "reviewer");
  assert.equal(actions.reassign("reviewer", "constructor"), 2);
  const renamed = inspect();
  assert.equal(renamed.document.workflows.main!.defaultProfile, "constructor");
  assert.equal(renamed.document.workflows.child!.defaultProfile, undefined);
  assert.ok(renamed.drafts.every(([, value]) => value === "constructor"));
  actions.apply("main", "defaultProfile");
  actions.apply("agent", "profile");
  assert.equal(
    inspect().document.workflows.main!.defaultProfile,
    "constructor",
  );
  assert.equal(actions.reassign("constructor"), 2);
  assert.equal(inspect().document.workflows.main!.defaultProfile, undefined);
  assert.equal(inspect().drafts.length, 0);
});

test("advanced JSON replacement keeps pending persona callback ownership on the current intent", () => {
  const { actions, inspect } = editor();
  actions.pending("reviewer", "model", "pending-model");
  actions.replace({
    reviewer: { instructions: "new instructions", model: "new" },
  });
  assert.equal(inspect().drafts[0]![1], "pending-model");
  assert.equal(actions.apply("reviewer", "model"), true);
  assert.deepEqual(inspect().document.profiles!.reviewer, {
    instructions: "new instructions",
    model: "pending-model",
  });
  assert.equal(inspect().drafts.length, 0);
});

test("removing one persona through JSON discards only its owned drafts", () => {
  const { actions, inspect } = editor();
  actions.pending("reviewer", "model", "pending-model");
  actions.pending("main", "defaultProfile", "reviewer");
  actions.replace({ other: { model: "retained" } });
  const replaced = inspect();
  assert.deepEqual(replaced.owners, []);
  assert.deepEqual(replaced.document.profiles, {
    other: { model: "retained" },
  });
  assert.equal(replaced.drafts.length, 1);
  assert.equal(replaced.drafts[0]![1], "reviewer");
});

test("persona writable guard rejects pending source and raw JSON without canonical mutation", () => {
  const { actions, inspect } = editor();
  const before = inspect().document;
  assert.equal(actions.guard(true, false), false);
  assert.deepEqual(inspect().document, before);
  assert.equal(actions.guard(false, true), false);
  assert.deepEqual(inspect().document, before);
  assert.equal(actions.guard(false, false), true);
});
