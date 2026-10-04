/* Local data authoring. File generation and execution belong to the CLI. */
/** @typedef {{id:string, kind:string, next?:string, then?:string, else?:string, profile?:string, workflow?:string, branches?:{id:string,workflow:string,input:unknown}[], [key:string]:unknown}} StudioBlock */
/** @typedef {{x:number,y:number}} StudioPosition */
/** @typedef {{version:string,inputSchema:unknown,outputSchema:unknown,start:string,nodes:StudioBlock[],defaultProfile?:string,layout?:Record<string,StudioPosition>,[key:string]:unknown}} StudioDefinition */
/** @typedef {{format:string,root:string,workflows:Record<string,StudioDefinition>,profiles?:unknown}} StudioDocument */
/** @typedef {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement} StudioControl */
/** @typedef {{control:StudioControl,type:string,change:(value:unknown)=>void,label:string,optional:boolean}} StudioDraft */
/** @typedef {{values?:string[],optional?:boolean,allowEmpty?:boolean,min?:number,max?:number,label?:string}} StudioFieldOptions */
/** @param {string} id @returns {HTMLElement} */
const studioElement = (id) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing editor element ${id}`);
  return element;
};
/** @param {string} id @returns {StudioControl} */
const studioControl = (id) => {
  const element = studioElement(id);
  if (
    !(
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    )
  )
    throw new Error(`Missing editor control ${id}`);
  return element;
};
/** @param {string} id @returns {HTMLButtonElement} */
const studioButton = (id) => {
  const element = studioElement(id);
  if (!(element instanceof HTMLButtonElement))
    throw new Error(`Missing editor button ${id}`);
  return element;
};
/** @template {keyof HTMLElementTagNameMap} T @param {T} tag @param {unknown} [text] @returns {HTMLElementTagNameMap[T]} */
const studioText = (tag, text) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = String(text);
  return element;
};
/** @param {unknown} value @returns {string} */
const studioJSON = (value) => JSON.stringify(value, null, 2);
/** @template T @param {T} value @returns {T} */
const studioClone = (value) => JSON.parse(JSON.stringify(value));
/** @type {{document:StudioDocument,workflow:string,selected:string,revision:number,validated:number,sourceDirty:boolean,drafts:Map<string,StudioDraft>,scopes:WeakMap<object,number>,nextScope:number,yaml:string,catalogue:{kind:string,label:string,description:string}[]}} */
const studioState = {
  document: studioNewDocument(),
  workflow: "",
  selected: "",
  revision: 0,
  validated: -1,
  sourceDirty: false,
  drafts: new Map(),
  scopes: new WeakMap(),
  nextScope: 0,
  yaml: "",
  catalogue: [],
};
/** @type {ReturnType<typeof createPersonaEditor>|null} */
let studioPersonas = null;
/** Profile object names let advanced JSON rebind surviving field drafts. */
/** @type {Map<object,string>} */
const studioPersonaOwners = new Map();
/** @param {string} text @param {string} [kind] */
function studioNotice(text, kind = "") {
  studioElement("studio-message").textContent = text;
  studioElement("studio-message").className = kind;
  if (document.getElementById("studio-persona-dialog")?.hasAttribute("open")) {
    const message = studioElement("studio-persona-message");
    message.textContent = text;
    message.dataset.state = kind;
  }
}
function studioDirty() {
  // A new document edit cannot race a captured layout preview.
  if (studioCanvas.gesture) studioCancelGesture();
  studioState.revision++;
  studioState.validated = -1;
  studioButton("studio-download").disabled = true;
  studioElement("studio-status").textContent =
    "Draft · validate before download";
  studioElement("studio-status").dataset.state = "draft";
}
function studioDefinition() {
  return studioState.document.workflows[studioState.workflow];
}
function studioNode() {
  return studioDefinition().nodes.find(
    (node) => node.id === studioState.selected,
  );
}
/** @returns {StudioDefinition} */
function studioNewDefinition() {
  return {
    version: "1",
    inputSchema: {},
    outputSchema: {},
    start: "complete",
    nodes: [
      {
        id: "complete",
        kind: "end",
        output: { $ref: "#/input" },
        passed: true,
      },
    ],
  };
}
/** @returns {StudioDocument} */
function studioNewDocument() {
  return {
    format: "asf-ts-workflow/v1",
    root: "main",
    workflows: { main: studioNewDefinition() },
    profiles: {},
  };
}
/** @param {object} value @returns {number} */
function studioScope(value) {
  if (!studioState.scopes.has(value))
    studioState.scopes.set(value, ++studioState.nextScope);
  return /** @type {number} */ (studioState.scopes.get(value));
}
/** @param {string} value @param {string} [label] */
function studioOption(value, label = value) {
  const option = studioText("option", label);
  option.value = value;
  return option;
}
/** @param {HTMLElement} element @param {string[]} values @param {string} [selected] */
function studioSelect(element, values, selected) {
  if (!(element instanceof HTMLSelectElement))
    throw new Error("Expected a select control");
  const options = [...values];
  if (selected !== undefined && !options.includes(selected))
    options.push(selected);
  element.replaceChildren(...options.map((value) => studioOption(value)));
  element.value = selected ?? "";
}
function studioSource() {
  if (!studioState.sourceDirty)
    studioControl("studio-source").value = studioJSON(studioState.document);
}
/** @param {StudioDocument} document */
function studioLoad(document) {
  studioState.document = studioClone(document);
  studioState.workflow = document.root;
  studioState.selected = studioDefinition().start;
  studioState.sourceDirty = false;
  studioState.drafts.clear();
  studioPersonaOwners.clear();
  studioPersonas?.reset();
  studioCanvasReset();
  studioDirty();
  studioRender();
}
function studioWritable() {
  if (studioCanvas.gesture) studioCancelGesture();
  if (!studioState.sourceDirty) return true;
  studioNotice(
    "Apply the pending source before editing forms or blocks.",
    "error",
  );
  return false;
}
/** @param {string} key @param {StudioDraft} draft */
function studioApplyField(key, draft) {
  const { control, type, change, label, optional } = draft;
  try {
    control.setCustomValidity("");
    const value =
      optional && control.value === ""
        ? undefined
        : type === "json"
          ? JSON.parse(control.value)
          : type === "number"
            ? Number(control.value)
            : control.value;
    if (!control.checkValidity()) throw new Error(control.validationMessage);
    if (!studioWritable())
      throw new Error("Apply the pending source before changing a field");
    change(value);
    studioState.drafts.delete(key);
    studioSource();
    studioRenderGraph();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    control.setCustomValidity(message);
    studioState.drafts.set(key, draft);
    studioDirty();
    studioNotice(`${label}: ${message}`, "error");
    return false;
  }
}
/** @param {HTMLElement} form @param {object} scope @param {string} name @param {unknown} value @param {string} type @param {(value:unknown)=>void} change @param {StudioFieldOptions} [options] */
function studioField(form, scope, name, value, type, change, options = {}) {
  const {
    values = [],
    optional = false,
    allowEmpty = false,
    min,
    max,
    label = name,
  } = options;
  const key = `${studioScope(scope)}:${name}`,
    pending = studioState.drafts.get(key);
  const group = studioText("label", label);
  let control;
  if (type === "select") {
    control = studioText("select");
    studioSelect(
      control,
      values,
      value === undefined ? undefined : String(value),
    );
  } else {
    control = studioText(
      type === "json" || type === "multiline" ? "textarea" : "input",
    );
    control.value =
      type === "json"
        ? studioJSON(value ?? (optional ? null : {}))
        : String(value ?? "");
    if (control instanceof HTMLTextAreaElement) {
      control.rows = type === "json" ? 5 : 4;
      control.spellcheck = false;
    }
    if (type === "number" && control instanceof HTMLInputElement) {
      control.type = "number";
      if (min !== undefined) control.min = String(min);
      if (max !== undefined) control.max = String(max);
    }
  }
  control.id = `studio-field-${studioScope(scope)}-${name}`;
  control.setAttribute("aria-label", label);
  control.required = !optional && !allowEmpty && type !== "select";
  if (pending) {
    control.value = pending.control.value;
    control.setCustomValidity(pending.control.validationMessage);
  }
  const draft = { control, type, change, label, optional };
  if (pending) studioState.drafts.set(key, draft);
  control.addEventListener("input", () => {
    control.setCustomValidity("");
    studioState.drafts.set(key, draft);
    studioDirty();
  });
  control.addEventListener("change", () => {
    studioDirty();
    studioApplyField(key, draft);
  });
  group.append(control);
  form.append(group);
  return control;
}
function studioRender() {
  studioSelect(
    studioElement("studio-definition"),
    Object.keys(studioState.document.workflows),
    studioState.workflow,
  );
  studioSelect(
    studioElement("studio-root"),
    Object.keys(studioState.document.workflows),
    studioState.document.root,
  );
  studioSource();
  studioRenderSettings();
  studioRenderProfiles();
  studioRenderGraph();
  studioRenderNode();
  studioPersonas?.render();
}
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function studioProfileRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function studioProfileNames() {
  return studioProfileRecord(studioState.document.profiles)
    ? Object.keys(studioState.document.profiles)
    : [];
}
/** @param {object} scope @param {string} [name] */
function studioDiscardPersonaDrafts(scope, name) {
  const prefix = `${studioScope(scope)}:`;
  for (const key of studioState.drafts.keys())
    if (
      name === undefined ? key.startsWith(prefix) : key === `${prefix}${name}`
    )
      studioState.drafts.delete(key);
}
/** @param {unknown} replacement */
function studioReplaceProfiles(replacement) {
  if (studioProfileRecord(replacement)) {
    for (const [scope, name] of [...studioPersonaOwners]) {
      const next = Object.hasOwn(replacement, name)
        ? replacement[name]
        : undefined;
      if (studioProfileRecord(next) && studioProfileRecord(scope)) {
        // Keep the object that existing controls and pending callbacks own.
        for (const key of Object.keys(scope)) delete scope[key];
        for (const [key, value] of Object.entries(next))
          Object.defineProperty(scope, key, {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        Object.defineProperty(replacement, name, {
          value: scope,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else studioDiscardPersonaDrafts(scope);
      if (!studioProfileRecord(next)) studioPersonaOwners.delete(scope);
    }
  }
  studioState.document.profiles = replacement;
  studioRenderSettings();
  studioRenderNode();
  studioPersonas?.render();
}
/** @param {string} oldName @param {string} [newName] */
function studioReassignPersona(oldName, newName) {
  let count = 0;
  /** @param {StudioDefinition|StudioBlock} owner @param {string} field */
  function reassign(owner, field) {
    if (owner[field] === oldName) {
      if (newName === undefined) delete owner[field];
      else owner[field] = newName;
      count++;
    }
    const key = `${studioScope(owner)}:${field}`,
      draft = studioState.drafts.get(key);
    if (draft?.control.value === oldName) {
      if (newName === undefined) studioState.drafts.delete(key);
      else {
        if (draft.control instanceof HTMLSelectElement)
          draft.control.append(studioOption(newName));
        draft.control.value = newName;
      }
    }
  }
  for (const definition of Object.values(studioState.document.workflows)) {
    reassign(definition, "defaultProfile");
    for (const block of definition.nodes)
      if (block.kind === "agent") reassign(block, "profile");
  }
  for (const [owner, name] of studioPersonaOwners) {
    if (name !== oldName) continue;
    if (newName === undefined) studioPersonaOwners.delete(owner);
    else studioPersonaOwners.set(owner, newName);
  }
  return count;
}
function studioPersonaWritable() {
  if (!studioWritable()) return false;
  if (studioState.drafts.has(`${studioScope(studioState.document)}:profiles`)) {
    studioNotice(
      "Apply the pending advanced profile JSON before editing personas.",
      "error",
    );
    return false;
  }
  return true;
}
function studioRenderSettings() {
  const form = studioElement("studio-workflow-form"),
    definition = studioDefinition();
  form.replaceChildren();
  for (const [name, label, type] of [
    ["version", "Version", "text"],
    ["inputSchema", "Workflow input schema", "json"],
    ["outputSchema", "Workflow output schema", "json"],
  ])
    studioField(
      form,
      definition,
      name,
      definition[name],
      type,
      (value) => {
        definition[name] = value;
      },
      { label },
    );
  studioField(
    form,
    definition,
    "defaultProfile",
    definition.defaultProfile ?? "",
    "select",
    (value) => {
      if (value) definition.defaultProfile = String(value);
      else delete definition.defaultProfile;
    },
    {
      values: ["", ...studioProfileNames()],
      label: "Workflow default profile",
    },
  );
  studioField(
    form,
    definition,
    "start",
    definition.start,
    "select",
    (value) => {
      definition.start = String(value);
    },
    { values: definition.nodes.map((node) => node.id), label: "Start block" },
  );
}
function studioRenderProfiles() {
  const control = studioControl("studio-profiles"),
    scope = studioScope(studioState.document),
    key = `${scope}:profiles`,
    draft = studioState.drafts.get(key);
  control.value =
    draft?.control.value ?? studioJSON(studioState.document.profiles ?? {});
  /** @type {StudioDraft} */
  const next = {
    control,
    type: "json",
    label: "Named profile intents",
    optional: false,
    change: (value) => {
      studioReplaceProfiles(value);
    },
  };
  if (draft) studioState.drafts.set(key, next);
  control.oninput = () => {
    control.setCustomValidity("");
    studioState.drafts.set(key, next);
    studioDirty();
  };
  control.onchange = () => {
    studioDirty();
    studioApplyField(key, next);
  };
}
/* Canvas geometry stays separate from authored edges and pending form values. */
/** @typedef {{left:number,top:number,width:number,height:number}} StudioBounds */
/** @typedef {{pointer:number,node?:string,origin?:StudioPosition,preview?:StudioPosition,start:StudioPosition,scroll:StudioPosition,moved:boolean,allowed:boolean,bounds:StudioBounds}} StudioGesture */
const studioCardWidth = 240;
/** @param {StudioBlock} block @returns {{id:string,workflow:string}[]} */
function studioBranches(block) {
  // Parsed form JSON can be structurally invalid until the user validates it.
  if (!Array.isArray(block.branches)) return [];
  return block.branches.filter(
    (child) =>
      child &&
      typeof child.id === "string" &&
      typeof child.workflow === "string",
  );
}
/** @type {{zoom:number,workflow:string,bounds:StudioBounds,gesture:StudioGesture|null}} */
const studioCanvas = {
  zoom: 1,
  workflow: "",
  bounds: { left: 0, top: 0, width: 650, height: 420 },
  gesture: null,
};
/** @param {StudioBlock} block */
function studioCardHeight(block) {
  return block.kind === "branch"
    ? 128
    : block.kind === "parallel"
      ? 112 + Math.min(studioBranches(block).length, 4) * 23
      : 112;
}
/** @param {StudioBlock} node @returns {[string,string|undefined][]} */
function studioEdges(node) {
  if (node.kind === "end") return [];
  if (node.kind === "branch")
    return [
      ["true", node.then],
      ["false", node.else],
    ];
  return [["next", node.next]];
}
/** @param {StudioPosition} position @param {StudioBlock} block @param {Map<string,StudioPosition>} positions @param {StudioDefinition} definition @param {Set<string>} [ignored] */
function studioFreePosition(
  position,
  block,
  positions,
  definition,
  ignored = new Set(),
) {
  const clear = /** @param {StudioPosition} candidate */ (candidate) =>
    definition.nodes.every((other) => {
      const placed = positions.get(other.id);
      return (
        !placed ||
        ignored.has(other.id) ||
        other.id === block.id ||
        candidate.x + studioCardWidth + 24 <= placed.x ||
        candidate.x >= placed.x + studioCardWidth + 24 ||
        candidate.y + studioCardHeight(block) + 24 <= placed.y ||
        candidate.y >= placed.y + studioCardHeight(other) + 24
      );
    });
  // Prefer the requested column. Expand to another column for crowded imports.
  for (let column = 0; column < 129; column++)
    for (let row = 0; row < 129; row++) {
      const candidate = {
        x: Math.max(
          -10000,
          Math.min(
            10000,
            position.x +
              (column === 0
                ? 0
                : Math.ceil(column / 2) * (column % 2 ? 1 : -1) * 340),
          ),
        ),
        y: Math.max(
          -10000,
          Math.min(
            10000,
            position.y +
              (row === 0
                ? 0
                : Math.ceil(row / 2) *
                  (row % 2 ? 1 : -1) *
                  (studioCardHeight(block) + 48)),
          ),
        ),
      };
      if (clear(candidate)) return candidate;
    }
  return {
    x: Math.max(-10000, Math.min(10000, position.x)),
    y: Math.max(-10000, Math.min(10000, position.y)),
  };
}
/** @returns {Map<string,StudioPosition>} */
function studioPositions() {
  const definition = studioDefinition(),
    positions = new Map();
  for (const node of definition.nodes) {
    const authored =
      definition.layout && Object.hasOwn(definition.layout, node.id)
        ? definition.layout[node.id]
        : undefined;
    if (authored) positions.set(node.id, { ...authored });
  }
  const pending = [{ id: definition.start, x: 40, y: 180 }],
    visited = new Set();
  while (pending.length) {
    const next = pending.shift();
    if (!next || visited.has(next.id)) continue;
    visited.add(next.id);
    const node = definition.nodes.find((block) => block.id === next.id);
    if (!node) continue;
    if (!positions.has(node.id))
      positions.set(
        node.id,
        studioFreePosition(next, node, positions, definition),
      );
    const position = /** @type {StudioPosition} */ (positions.get(node.id));
    for (const [port, target] of studioEdges(node))
      if (target)
        pending.push({
          id: target,
          x: position.x + 340,
          y: position.y + (port === "true" ? -110 : port === "false" ? 110 : 0),
        });
  }
  for (const node of definition.nodes)
    if (!positions.has(node.id))
      positions.set(
        node.id,
        studioFreePosition({ x: 40, y: 180 }, node, positions, definition),
      );
  const gesture = studioCanvas.gesture;
  if (gesture?.node && gesture.preview)
    positions.set(gesture.node, gesture.preview);
  return positions;
}
/** @param {StudioBlock} node @returns {StudioPosition} */
function studioPosition(node) {
  return /** @type {StudioPosition} */ (studioPositions().get(node.id));
}
/** @param {Map<string,StudioPosition>} positions */
function studioKeepPositions(positions) {
  const definition = studioDefinition();
  definition.layout = Object.fromEntries([
    ...Object.entries(definition.layout ?? {}),
    ...[...positions].map(([id, position]) => [id, { ...position }]),
  ]);
}
/** @param {StudioBlock} node @param {string} port */
function studioPortY(node, port) {
  return node.kind === "branch"
    ? port === "true"
      ? 40
      : 94
    : studioCardHeight(node) / 2;
}
/** @template {keyof SVGElementTagNameMap} T @param {T} tag @param {Record<string,string|number|boolean>} attributes @param {unknown} [text] @returns {SVGElementTagNameMap[T]} */
function studioSVG(tag, attributes, text) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes))
    element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = String(text);
  return element;
}
/** @returns {SVGSVGElement} */
function studioGraph() {
  const element = studioElement("studio-graph");
  if (!(element instanceof SVGSVGElement))
    throw new Error("Expected the Studio canvas");
  return element;
}
/** @param {StudioPosition} point @returns {StudioPosition|null} */
function studioCanvasPoint(point) {
  const matrix = studioGraph().getScreenCTM();
  if (!matrix) return null;
  const translated = new DOMPoint(point.x, point.y).matrixTransform(
    matrix.inverse(),
  );
  return { x: translated.x, y: translated.y };
}
function studioCanvasReset() {
  studioCancelGesture();
  studioCanvas.zoom = 1;
  studioCanvas.workflow = studioState.workflow;
  const viewport = studioElement("studio-graph-scroll");
  viewport.scrollLeft = viewport.scrollTop = 0;
}
/** @param {string} value @param {number} [length] */
function studioShort(value, length = 27) {
  return value.length > length ? value.slice(0, length - 1) + "…" : value;
}
/** @type {Record<string,string>} */
const studioIcons = {
  agent: "M5 9h14v12H5z M9 5h6 M12 5v4 M8 14h1 M15 14h1 M9 18h6",
  command: "M5 7l6 5-6 5 M13 18h7",
  workflow: "M5 5h14v14H5z M9 9h14v14H9",
  branch: "M12 3l9 9-9 9-9-9z M12 8v8 M8 12h8",
  end: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M8 12l3 3 6-7",
  repeat: "M5 10a8 8 0 0 1 14-3 M19 3v5h-5 M19 14a8 8 0 0 1-14 3 M5 21v-5h5",
  parallel: "M5 4v16 M19 4v16 M5 7h14 M5 17h14 M12 7v10",
  custom: "M5 5h14v14H5z M9 2v3 M15 2v3 M9 19v3 M15 19v3 M2 9h3 M19 9h3",
};
/** @param {string} id @param {boolean} [focus] */
function studioPick(id, focus = false) {
  studioState.selected = id;
  studioRenderGraph();
  studioRenderNode();
  if (focus) studioFocusBlock(id);
}
/** @param {string} id */
function studioFocusBlock(id) {
  const block = [...studioGraph().querySelectorAll(".studio-block")].find(
    (node) => node.getAttribute("data-node-id") === id,
  );
  if (block instanceof SVGElement) block.focus();
}
function studioRenderInsertPort() {
  const control = document.getElementById("studio-insert-port");
  if (!(control instanceof HTMLSelectElement)) return;
  const block = studioNode(),
    previous = control.value;
  const ports = block ? studioEdges(block).map(([port]) => port) : [];
  control.replaceChildren(
    studioOption("auto", "Auto"),
    ...ports.map((port) => studioOption(port, port)),
  );
  control.value = ["auto", ...ports].includes(previous) ? previous : "auto";
}
function studioRenderGraph() {
  if (studioCanvas.workflow !== studioState.workflow) studioCanvasReset();
  const graph = studioGraph(),
    definition = studioDefinition(),
    positions = studioPositions();
  graph.replaceChildren();
  const definitions = studioSVG("defs", {}),
    marker = studioSVG("marker", {
      id: "studio-arrow",
      viewBox: "0 0 10 10",
      refX: 9,
      refY: 5,
      markerWidth: 7,
      markerHeight: 7,
      orient: "auto-start-reverse",
    });
  marker.append(
    studioSVG("path", { d: "M0 0 L10 5 L0 10 Z", fill: "currentColor" }),
  );
  definitions.append(marker);
  graph.append(definitions);
  studioElement("studio-graph-title").textContent =
    `${studioState.workflow} · declared flow`;
  const left = Math.min(0, ...[...positions.values()].map((p) => p.x - 40)),
    top = Math.min(0, ...[...positions.values()].map((p) => p.y - 40));
  const bounds = studioCanvas.gesture?.bounds ?? {
    left,
    top,
    width:
      Math.max(
        650,
        ...[...positions.values()].map((p) => p.x + studioCardWidth + 80),
      ) - left,
    height:
      Math.max(
        420,
        ...definition.nodes.map(
          (node) =>
            (positions.get(node.id)?.y ?? 0) + studioCardHeight(node) + 80,
        ),
      ) - top,
  };
  studioCanvas.bounds = bounds;
  graph.setAttribute(
    "viewBox",
    `${bounds.left} ${bounds.top} ${bounds.width} ${bounds.height}`,
  );
  graph.setAttribute("width", String(bounds.width * studioCanvas.zoom));
  graph.setAttribute("height", String(bounds.height * studioCanvas.zoom));
  graph.style.width = `${bounds.width * studioCanvas.zoom}px`;
  graph.style.height = `${bounds.height * studioCanvas.zoom}px`;
  graph.style.touchAction = "none";
  graph.append(
    studioSVG("rect", {
      x: bounds.left,
      y: bounds.top,
      width: bounds.width,
      height: bounds.height,
      class: "studio-canvas-background",
      fill: "transparent",
    }),
  );
  for (const node of definition.nodes)
    for (const [port, target] of studioEdges(node)) {
      if (!target) continue;
      const from = positions.get(node.id),
        to = positions.get(target),
        targetNode = definition.nodes.find((block) => block.id === target);
      if (!from || !to || !targetNode) continue;
      const x1 = from.x + studioCardWidth + 5,
        y1 = from.y + studioPortY(node, port),
        x2 = to.x - 5,
        y2 = to.y + studioCardHeight(targetNode) / 2;
      const bend = Math.max(55, Math.abs(x2 - x1) / 2);
      graph.append(
        studioSVG("path", {
          d: `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`,
          class: "studio-edge",
          "data-port": port,
          "data-from": node.id,
          "data-to": target,
          "marker-end": "url(#studio-arrow)",
        }),
      );
      // Labels stay beside their source port, away from successor cards.
      graph.append(
        studioSVG(
          "text",
          {
            x: x1 + 14,
            y: y1 - 9,
            class: "studio-edge-label studio-port",
            "data-port": port,
          },
          port,
        ),
      );
    }
  for (const block of definition.nodes) {
    const position = positions.get(block.id),
      selected = studioState.selected === block.id;
    if (!position) continue;
    const height = studioCardHeight(block),
      group = studioSVG("g", {
        class: `studio-block${selected ? " selected" : ""}`,
        "data-kind": block.kind,
        "data-node-id": block.id,
        transform: `translate(${position.x},${position.y})`,
        tabindex: 0,
        role: "button",
        "aria-label": `${block.kind} block ${block.id}`,
        "aria-pressed": selected,
        "aria-keyshortcuts":
          "ArrowLeft ArrowRight ArrowUp ArrowDown Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown",
      });
    group.append(
      studioSVG(
        "title",
        {},
        `${block.kind}: ${block.id}. Drag to move, or use arrow keys.`,
      ),
    );
    if (block.kind === "workflow" || block.kind === "repeat")
      group.append(
        studioSVG("rect", {
          x: 5,
          y: -5,
          width: studioCardWidth - 10,
          height,
          rx: 14,
          class: "studio-node-frame studio-node-stack",
        }),
      );
    group.append(
      block.kind === "branch"
        ? studioSVG("polygon", {
            points: `20,0 ${studioCardWidth - 20},0 ${studioCardWidth},${height / 2} ${studioCardWidth - 20},${height} 20,${height} 0,${height / 2}`,
            class: "studio-node-frame",
          })
        : studioSVG("rect", {
            width: studioCardWidth,
            height,
            rx: block.kind === "end" ? 40 : 14,
            class: "studio-node-frame",
          }),
    );
    group.append(
      studioSVG("path", {
        d: studioIcons[block.kind] ?? studioIcons.custom,
        transform: "translate(16,15)",
        class: "studio-icon",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 1.7,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      }),
      studioSVG("text", { x: 50, y: 30, class: "studio-kind" }, block.kind),
      studioSVG(
        "text",
        { x: 18, y: 61, class: "studio-node-name" },
        studioShort(block.id),
      ),
    );
    const detail = block.workflow
      ? `Child: ${block.workflow}`
      : block.profile
        ? `Profile: ${block.profile}`
        : block.kind === "parallel"
          ? `${block.join ?? "all"} join · ${studioBranches(block).length} ${studioBranches(block).length === 1 ? "child" : "children"}`
          : block.kind === "branch"
            ? "Choose true or false"
            : block.kind === "end"
              ? "Return workflow result"
              : block.kind === "command"
                ? "Local command"
                : block.kind === "custom"
                  ? String(block.component ?? "Registered component")
                  : "Agent instruction";
    group.append(
      studioSVG(
        "text",
        { x: 18, y: 85, class: "studio-node-detail" },
        studioShort(detail, 30),
      ),
    );
    if (block.kind === "parallel") {
      for (const [index, child] of studioBranches(block).slice(0, 4).entries())
        group.append(
          studioSVG(
            "text",
            {
              x: 24,
              y: 111 + index * 23,
              class: "studio-node-detail studio-child-label",
            },
            studioShort(`${child.id} → ${child.workflow}`, 28),
          ),
        );
      if (studioBranches(block).length > 4)
        group.append(
          studioSVG(
            "text",
            { x: 150, y: height - 8, class: "studio-node-detail" },
            `+${studioBranches(block).length - 4} more`,
          ),
        );
    }
    group.append(
      studioSVG("circle", {
        cx: 0,
        cy: height / 2,
        r: 5,
        class: "studio-handle",
        "data-port": "input",
      }),
    );
    for (const [port] of studioEdges(block))
      group.append(
        studioSVG("circle", {
          cx: studioCardWidth,
          cy: studioPortY(block, port),
          r: 5,
          class: "studio-handle",
          "data-port": port,
        }),
      );
    group.addEventListener("keydown", (event) => {
      const movement = studioDirection(event.key);
      if (movement) {
        event.preventDefault();
        studioState.selected = block.id;
        studioMove(
          movement.x * (event.shiftKey ? 60 : 20),
          movement.y * (event.shiftKey ? 60 : 20),
          true,
        );
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        studioPick(block.id);
        studioElement("studio-node-form").querySelector("input")?.focus();
      }
    });
    graph.append(group);
  }
  studioRenderInsertPort();
  const label = document.getElementById("studio-zoom-label");
  if (label) label.textContent = `${Math.round(studioCanvas.zoom * 100)}%`;
  for (const direction of ["left", "right", "up", "down"]) {
    const button = document.getElementById(`studio-move-${direction}`);
    if (button instanceof HTMLButtonElement) button.disabled = !studioNode();
  }
}
/** @param {string} key @returns {StudioPosition|null} */
function studioDirection(key) {
  return (
    {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    }[key] ?? null
  );
}
/** @param {number} x @param {number} y @param {boolean} [focus] */
function studioMove(x, y, focus = false) {
  const node = studioNode();
  if (!node || !studioWritable()) return;
  const position = studioPosition(node);
  studioSetPosition(node.id, { x: position.x + x, y: position.y + y });
  if (focus) studioFocusBlock(node.id);
}
/** @param {string} id @param {StudioPosition} position */
function studioSetPosition(id, position) {
  const definition = studioDefinition();
  // Freeze visible automatic positions before moving one block.
  studioKeepPositions(studioPositions());
  definition.layout ??= {};
  definition.layout[id] = {
    x: Math.round(Math.max(-10000, Math.min(10000, position.x))),
    y: Math.round(Math.max(-10000, Math.min(10000, position.y))),
  };
  studioDirty();
  studioSource();
  studioRenderGraph();
  studioRenderNode();
}
/** @param {number} zoom @param {StudioPosition} [anchor] */
function studioZoom(zoom, anchor) {
  if (studioCanvas.gesture) return;
  const viewport = studioElement("studio-graph-scroll"),
    rectangle = viewport.getBoundingClientRect();
  const fixed = anchor ?? {
    x: rectangle.left + viewport.clientWidth / 2,
    y: rectangle.top + viewport.clientHeight / 2,
  };
  const point = studioCanvasPoint(fixed);
  studioCanvas.zoom = Math.max(0.25, Math.min(2.5, zoom));
  studioRenderGraph();
  if (point) {
    const matrix = studioGraph().getScreenCTM();
    if (matrix) {
      const translated = new DOMPoint(point.x, point.y).matrixTransform(matrix);
      viewport.scrollLeft += translated.x - fixed.x;
      viewport.scrollTop += translated.y - fixed.y;
    }
  }
}
function studioFit() {
  if (studioCanvas.gesture) return;
  const viewport = studioElement("studio-graph-scroll"),
    bounds = studioCanvas.bounds;
  studioZoom(
    Math.min(
      (viewport.clientWidth - 20) / bounds.width,
      (viewport.clientHeight - 20) / bounds.height,
      1,
    ),
  );
  viewport.scrollLeft = viewport.scrollTop = 0;
}
function studioCancelGesture() {
  const gesture = studioCanvas.gesture;
  if (!gesture) return;
  studioCanvas.gesture = null;
  if (!gesture.node) {
    const viewport = studioElement("studio-graph-scroll");
    viewport.scrollLeft = gesture.scroll.x;
    viewport.scrollTop = gesture.scroll.y;
  }
  const graph = studioGraph();
  if (graph.hasPointerCapture(gesture.pointer))
    graph.releasePointerCapture(gesture.pointer);
  studioRenderGraph();
}
function studioBindCanvas() {
  const graph = studioGraph();
  graph.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || studioCanvas.gesture) return;
    const target =
      event.target instanceof Element
        ? event.target.closest(".studio-block")
        : null;
    const id = target?.getAttribute("data-node-id") ?? undefined;
    const node = id
      ? studioDefinition().nodes.find((block) => block.id === id)
      : undefined;
    const origin = node ? studioPosition(node) : undefined;
    studioCanvas.gesture = {
      pointer: event.pointerId,
      node: id,
      origin,
      start: { x: event.clientX, y: event.clientY },
      scroll: {
        x: studioElement("studio-graph-scroll").scrollLeft,
        y: studioElement("studio-graph-scroll").scrollTop,
      },
      moved: false,
      allowed: !id || studioWritable(),
      bounds: { ...studioCanvas.bounds },
    };
    graph.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  graph.addEventListener("pointermove", (event) => {
    const gesture = studioCanvas.gesture;
    if (!gesture || event.pointerId !== gesture.pointer) return;
    const dx = event.clientX - gesture.start.x,
      dy = event.clientY - gesture.start.y;
    if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
    gesture.moved = true;
    if (!gesture.node) {
      const viewport = studioElement("studio-graph-scroll");
      viewport.scrollLeft = gesture.scroll.x - dx;
      viewport.scrollTop = gesture.scroll.y - dy;
    } else if (gesture.allowed && gesture.origin) {
      const from = studioCanvasPoint(gesture.start),
        to = studioCanvasPoint({ x: event.clientX, y: event.clientY });
      if (!from || !to) return;
      gesture.preview = {
        x: Math.max(-10000, Math.min(10000, gesture.origin.x + to.x - from.x)),
        y: Math.max(-10000, Math.min(10000, gesture.origin.y + to.y - from.y)),
      };
      studioRenderGraph();
    }
  });
  graph.addEventListener("pointerup", (event) => {
    const gesture = studioCanvas.gesture;
    if (!gesture || event.pointerId !== gesture.pointer) return;
    studioCanvas.gesture = null;
    if (graph.hasPointerCapture(event.pointerId))
      graph.releasePointerCapture(event.pointerId);
    if (gesture.node) {
      studioState.selected = gesture.node;
      if (
        gesture.preview &&
        gesture.allowed &&
        gesture.moved &&
        studioWritable()
      )
        studioSetPosition(gesture.node, gesture.preview);
      else studioPick(gesture.node);
    }
  });
  graph.addEventListener("pointercancel", studioCancelGesture);
  graph.addEventListener("lostpointercapture", () => {
    if (studioCanvas.gesture) studioCancelGesture();
  });
  graph.addEventListener("click", (event) => {
    if (event.detail !== 0) return;
    const target =
      event.target instanceof Element
        ? event.target.closest(".studio-block")
        : null;
    const id = target?.getAttribute("data-node-id");
    if (id) studioPick(id);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && studioCanvas.gesture) {
      event.preventDefault();
      studioCancelGesture();
    }
  });
  for (const [id, action] of /** @type {[string,()=>void][]} */ ([
    ["studio-zoom-in", () => studioZoom(studioCanvas.zoom * 1.2)],
    ["studio-zoom-out", () => studioZoom(studioCanvas.zoom / 1.2)],
    ["studio-zoom-fit", studioFit],
    ["studio-move-left", () => studioMove(-20, 0)],
    ["studio-move-right", () => studioMove(20, 0)],
    ["studio-move-up", () => studioMove(0, -20)],
    ["studio-move-down", () => studioMove(0, 20)],
  ])) {
    const button = document.getElementById(id);
    if (button) button.onclick = action;
  }
}
/** @type {Record<string,[string,string,boolean?][]>} */
const studioFields = {
  agent: [
    ["prompt", "multiline"],
    ["profile", "profile"],
    ["context", "json", true],
    ["outputSchema", "json"],
    ["corrections", "number", true],
  ],
  command: [
    ["argv", "json"],
    ["timeoutMs", "number", true],
  ],
  workflow: [
    ["workflow", "workflow"],
    ["input", "json"],
    ["attempt", "number", true],
    ["maxDispatches", "number", true],
    ["timeoutMs", "number", true],
  ],
  branch: [["predicate", "json"]],
  end: [
    ["output", "json"],
    ["passed", "json", true],
  ],
  repeat: [
    ["workflow", "workflow"],
    ["input", "json"],
    ["until", "json"],
    ["maxIterations", "number"],
  ],
  parallel: [
    ["branches", "json"],
    ["join", "join"],
  ],
  custom: [
    ["component", "text"],
    ["input", "json"],
    ["inputSchema", "json"],
    ["outputSchema", "json"],
  ],
};
/** @param {unknown} value @param {string} oldId @param {string} newId */
function studioReplaceReferences(value, oldId, newId) {
  if (Array.isArray(value))
    value.forEach((item) => studioReplaceReferences(item, oldId, newId));
  else if (value && typeof value === "object") {
    const reference = /** @type {Record<string,unknown>} */ (value);
    const prefix = `#/nodes/${oldId}`;
    if (
      typeof reference.$ref === "string" &&
      (reference.$ref === prefix || reference.$ref.startsWith(prefix + "/"))
    )
      reference.$ref = `#/nodes/${newId}` + reference.$ref.slice(prefix.length);
    for (const child of Object.values(value))
      studioReplaceReferences(child, oldId, newId);
  }
}
function studioRenderNode() {
  const form = studioElement("studio-node-form"),
    block = studioNode();
  form.replaceChildren();
  studioElement("studio-child-contract").replaceChildren();
  studioButton("studio-delete").disabled = !block;
  studioElement("studio-node-title").textContent = block
    ? block.id
    : "Select a block";
  if (!block) return;
  studioField(
    form,
    block,
    "id",
    block.id,
    "text",
    (value) => {
      const old = block.id,
        renamed = String(value);
      block.id = renamed;
      studioState.selected = renamed;
      const definition = studioDefinition();
      if (definition.start === old) definition.start = String(value);
      for (const node of definition.nodes)
        for (const key of ["next", "then", "else"])
          if (node[key] === old) node[key] = value;
      studioReplaceReferences(definition.nodes, old, renamed);
      if (definition.layout && Object.hasOwn(definition.layout, old)) {
        Object.defineProperty(definition.layout, renamed, {
          value: definition.layout[old],
          enumerable: true,
          writable: true,
          configurable: true,
        });
        if (renamed !== old) delete definition.layout[old];
      }
      studioRenderSettings();
    },
    { label: "Block ID" },
  );
  for (const [name, originalType, optional = false] of studioFields[
    block.kind
  ] ?? []) {
    let type = originalType,
      values = /** @type {string[]} */ ([]);
    if (["profile", "workflow", "join"].includes(type)) {
      values =
        type === "profile"
          ? ["", ...studioProfileNames()]
          : type === "workflow"
            ? Object.keys(studioState.document.workflows)
            : ["all", "any"];
      type = "select";
    }
    studioField(
      form,
      block,
      name,
      block[name] ?? (optional && type === "select" ? "" : undefined),
      type,
      (value) => {
        if (value === undefined || (name === "profile" && value === ""))
          delete block[name];
        else block[name] = value;
        if (name === "workflow") studioRenderNode();
      },
      {
        optional,
        values,
        min: ["corrections", "maxDispatches"].includes(name) ? 0 : 1,
        max: name === "corrections" ? 3 : undefined,
        label:
          name === "workflow"
            ? "Child workflow"
            : name === "profile"
              ? "Node profile"
              : name,
      },
    );
  }
  for (const [port, field] of block.kind === "end"
    ? []
    : block.kind === "branch"
      ? [
          ["true", "then"],
          ["false", "else"],
        ]
      : [["next", "next"]])
    studioField(
      form,
      block,
      field,
      block[field],
      "select",
      (value) => {
        block[field] = value;
      },
      {
        values: studioDefinition().nodes.map((node) => node.id),
        label: `${port} target`,
      },
    );
  const position = studioPosition(block);
  for (const axis of /** @type {const} */ (["x", "y"]))
    studioField(
      form,
      block,
      `layout-${axis}`,
      position[axis],
      "number",
      (value) => {
        const definition = studioDefinition();
        studioKeepPositions(studioPositions());
        definition.layout ??= {};
        definition.layout[block.id][axis] = Number(value);
      },
      { min: -10000, max: 10000, label: `Layout ${axis}` },
    );
  const children = block.workflow
    ? [{ id: block.workflow, workflow: block.workflow }]
    : block.kind === "parallel"
      ? studioBranches(block)
      : [];
  for (const child of children ?? []) {
    const definition = studioState.document.workflows[child.workflow];
    const area = studioElement("studio-child-contract");
    area.append(
      studioText("h3", `Child: ${child.id}`),
      studioText(
        "pre",
        definition
          ? studioJSON({
              inputSchema: definition.inputSchema,
              outputSchema: definition.outputSchema,
              defaultProfile: definition.defaultProfile ?? null,
            })
          : "Missing child definition",
      ),
    );
    if (definition) {
      const open = studioText("button", `Open child ${child.workflow}`);
      open.onclick = () => {
        studioState.workflow = child.workflow;
        studioState.selected = definition.start;
        studioRender();
      };
      area.append(open);
    }
  }
}
function studioRenderCatalogue() {
  const area = studioElement("studio-catalogue");
  area.replaceChildren();
  for (const contract of studioState.catalogue) {
    const button = studioText("button");
    const icon = studioSVG("svg", {
      viewBox: "0 0 24 24",
      width: 24,
      height: 24,
      class: "studio-icon",
      "aria-hidden": true,
    });
    icon.append(
      studioSVG("path", {
        d: studioIcons[contract.kind] ?? studioIcons.custom,
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 1.7,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      }),
    );
    button.append(
      icon,
      studioText("strong", contract.label),
      studioText("small", contract.description),
    );
    button.setAttribute("aria-label", `Add ${contract.kind} block`);
    button.setAttribute("data-kind", contract.kind);
    button.onclick = () => studioAddBlock(contract.kind);
    area.append(button);
  }
}
/** @param {StudioBlock|undefined} block @returns {{port:string,field:string}|null} */
function studioInsertionPort(block) {
  if (!block || block.kind === "end") return null;
  const edges = studioEdges(block),
    control = document.getElementById("studio-insert-port");
  const requested =
    control instanceof HTMLSelectElement ? control.value : "auto";
  const chosen =
    edges.find(([port]) => port === requested) ??
    edges.find(
      ([, target]) =>
        !target ||
        studioDefinition().nodes.find((node) => node.id === target)?.kind ===
          "end",
    ) ??
    edges[0];
  if (!chosen) return null;
  return {
    port: chosen[0],
    field:
      chosen[0] === "true" ? "then" : chosen[0] === "false" ? "else" : "next",
  };
}
/** @param {string} kind */
function studioAddBlock(kind) {
  if (!studioWritable()) return;
  const definition = studioDefinition(),
    selected = studioNode();
  let id = kind,
    suffix = 1;
  while (definition.nodes.some((node) => node.id === id)) id = kind + suffix++;
  const terminal = definition.nodes.find((node) => node.kind === "end"),
    insertion = studioInsertionPort(selected),
    successor = selected && insertion ? selected[insertion.field] : undefined,
    target =
      typeof successor === "string"
        ? successor
        : (terminal?.id ?? selected?.id ?? id);
  const positions = studioPositions();
  const child =
    Object.keys(studioState.document.workflows).find(
      (name) => name !== studioState.workflow,
    ) ?? "child";
  /** @type {Record<string,Record<string,unknown>>} */
  const defaults = {
    agent: { prompt: "Describe the result", outputSchema: {}, next: target },
    command: { argv: [], next: target },
    workflow: { workflow: child, input: { $ref: "#/input" }, next: target },
    branch: {
      predicate: { left: true, op: "truthy" },
      then: target,
      else: target,
    },
    end: { output: { $ref: "#/input" }, passed: true },
    repeat: {
      workflow: child,
      input: { $ref: "#/input" },
      until: { left: true, op: "truthy" },
      maxIterations: 2,
      next: target,
    },
    parallel: {
      branches: [{ id: "first", workflow: child, input: { $ref: "#/input" } }],
      join: "all",
      next: target,
    },
    custom: {
      component: "component",
      input: { $ref: "#/input" },
      inputSchema: {},
      outputSchema: {},
      next: target,
    },
  };
  const block = { id, kind, ...studioClone(defaults[kind]) };
  const selectedPosition = selected ? positions.get(selected.id) : undefined;
  let desired = selectedPosition
    ? {
        x: selectedPosition.x + (selected?.kind === "end" ? 0 : 340),
        y: selectedPosition.y,
      }
    : { x: 40, y: 180 };
  if (selected?.kind === "branch" && insertion) {
    const lane = Math.max(110, (studioCardHeight(block) + 48) / 2);
    desired.y += insertion.port === "true" ? -lane : lane;
    // A sibling can already have a taller card. Keep the new card close and clear.
    const other = definition.nodes.find(
      (node) =>
        node.id === selected[insertion.field === "then" ? "else" : "then"],
    );
    const otherPosition = other ? positions.get(other.id) : undefined;
    if (
      otherPosition &&
      other &&
      other.kind !== "end" &&
      Math.abs(otherPosition.x - desired.x) < 100
    ) {
      desired.x = otherPosition.x;
      desired.y =
        insertion.port === "false"
          ? otherPosition.y + studioCardHeight(other) + 48
          : otherPosition.y - studioCardHeight(block) - 48;
    }
  }
  if (selected?.kind === "end" && kind !== "end") {
    for (const node of definition.nodes)
      for (const key of ["next", "then", "else"])
        if (node[key] === selected.id) node[key] = id;
    if (definition.start === selected.id) definition.start = id;
    positions.set(
      selected.id,
      studioFreePosition(
        { x: desired.x + 340, y: desired.y },
        selected,
        positions,
        definition,
      ),
    );
  } else if (selected && insertion) {
    selected[insertion.field] = id;
    const next = definition.nodes.find((node) => node.id === target),
      placed = positions.get(target);
    // Insertion opens a lane ahead of a nearby successor without changing its ID.
    if (
      next &&
      placed &&
      placed.x >= desired.x - 24 &&
      placed.x < desired.x + studioCardWidth + 24
    )
      positions.set(
        next.id,
        studioFreePosition(
          { x: desired.x + 340, y: placed.y },
          next,
          positions,
          definition,
        ),
      );
  }
  desired = studioFreePosition(desired, block, positions, definition);
  positions.set(id, desired);
  studioKeepPositions(positions);
  definition.nodes.push(block);
  studioState.selected = id;
  studioDirty();
  studioRender();
  studioNotice(
    "Block added. Configure its contracts and validate the document.",
  );
}
async function studioValidate() {
  try {
    if (!studioState.sourceDirty)
      while (studioState.drafts.size) {
        const rawKey = `${studioScope(studioState.document)}:profiles`,
          rawDraft = studioState.drafts.get(rawKey);
        const [key, draft] = rawDraft
          ? [rawKey, rawDraft]
          : /** @type {[string,StudioDraft]} */ (
              studioState.drafts.entries().next().value
            );
        if (!studioApplyField(key, draft))
          throw new Error(
            `Correct the pending ${draft.label} field before validation.`,
          );
      }
    const revision = studioState.revision,
      applyingSource = studioState.sourceDirty,
      source = studioState.sourceDirty
        ? studioControl("studio-source").value
        : studioJSON(studioState.document);
    studioElement("studio-status").textContent = "Validating…";
    studioElement("studio-status").dataset.state = "validating";
    studioButton("studio-download").disabled = true;
    const response = await fetch("/studio/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source }),
    });
    const result = await response.json();
    if (revision !== studioState.revision) return;
    if (!response.ok) throw new Error(result.error ?? response.statusText);
    studioState.document = studioClone(result.document);
    studioState.sourceDirty = false;
    studioState.drafts.clear();
    studioPersonaOwners.clear();
    if (!studioState.document.workflows[studioState.workflow])
      studioState.workflow = result.document.root;
    if (!studioNode()) studioState.selected = studioDefinition().start;
    if (applyingSource) {
      studioCanvasReset();
      studioPersonas?.reset();
    }
    studioState.catalogue = result.catalogue;
    studioState.yaml = result.yaml;
    studioState.validated = revision;
    studioButton("studio-download").disabled = false;
    studioElement("studio-status").textContent = "Document valid";
    studioElement("studio-status").dataset.state = "valid";
    studioElement("studio-identity").textContent =
      `Semantic identity ${result.identity}`;
    studioNotice(
      result.warnings.length
        ? result.warnings.join(" · ")
        : "Document valid. Execution still requires local target preflight.",
      "success",
    );
    studioRenderCatalogue();
    studioRender();
  } catch (error) {
    studioDirty();
    studioNotice(
      error instanceof Error ? error.message : String(error),
      "error",
    );
  }
}
studioElement("studio-new").onclick = () => {
  studioLoad(studioNewDocument());
  void studioValidate();
};
studioElement("studio-file").onchange = async () => {
  const input = studioControl("studio-file");
  const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
  if (!file) return;
  // A user can reopen the same file after a rejected source draft.
  input.value = "";
  studioDirty();
  if (file.size > 900 * 1024)
    return studioNotice(
      "Source file exceeds the editor's 900 KiB import limit.",
      "error",
    );
  const revision = studioState.revision,
    text = await file.text();
  if (revision !== studioState.revision) return;
  studioControl("studio-source").value = text;
  studioState.sourceDirty = true;
  await studioValidate();
};
studioElement("studio-definition").onchange = () => {
  studioState.workflow = studioControl("studio-definition").value;
  studioState.selected = studioDefinition().start;
  studioRender();
};
studioElement("studio-root").onchange = () => {
  if (!studioWritable()) return;
  studioState.document.root = studioControl("studio-root").value;
  studioDirty();
  studioSource();
};
studioElement("studio-add-child").onclick = () => {
  if (!studioWritable()) return;
  const name = studioControl("studio-child-name").value.trim();
  if (
    !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name) ||
    Object.hasOwn(studioState.document.workflows, name)
  )
    return studioNotice(
      "Enter a new child name that starts with a letter.",
      "error",
    );
  studioState.document.workflows[name] = studioNewDefinition();
  studioDirty();
  studioRender();
  studioNotice(
    "Child added. Connect it with a workflow, repeat, or parallel block.",
  );
};
studioButton("studio-delete").onclick = () => {
  const block = studioNode();
  if (!studioWritable() || !block) return;
  const definition = studioDefinition(),
    scope = studioScope(block);
  for (const key of studioState.drafts.keys())
    if (key.startsWith(`${scope}:`)) studioState.drafts.delete(key);
  definition.nodes = definition.nodes.filter((node) => node !== block);
  if (definition.layout) delete definition.layout[block.id];
  studioState.selected = definition.nodes[0]?.id ?? "";
  studioDirty();
  studioRender();
  studioNotice(
    "Block removed. Repair start and transitions before validation.",
  );
};
studioElement("studio-arrange").onclick = () => {
  if (!studioWritable()) return;
  const definition = studioDefinition();
  definition.layout = {};
  studioKeepPositions(studioPositions());
  studioCanvasReset();
  studioDirty();
  studioRender();
};
studioControl("studio-source").oninput = () => {
  studioState.sourceDirty = true;
  studioDirty();
};
studioElement("studio-apply-source").onclick = studioValidate;
studioElement("studio-validate").onclick = studioValidate;
for (const id of ["studio-workflow-form", "studio-node-form"])
  studioElement(id).addEventListener("submit", (event) =>
    event.preventDefault(),
  );
studioButton("studio-download").onclick = () => {
  if (
    studioState.validated !== studioState.revision ||
    studioState.sourceDirty ||
    studioState.drafts.size
  )
    return studioNotice("Validate the current draft before download.", "error");
  const format = studioControl("studio-format").value,
    text =
      format === "yaml" ? studioState.yaml : studioJSON(studioState.document);
  const url = URL.createObjectURL(
    new Blob([text], {
      type: format === "yaml" ? "application/yaml" : "application/json",
    }),
  );
  const link = studioText("a");
  link.href = url;
  link.download = `workflow.${format}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};
studioPersonas = createPersonaEditor({
  document: () => studioState.document,
  field: (form, scope, name, value, type, change, options) => {
    if (studioProfileRecord(studioState.document.profiles))
      for (const [profileName, intent] of Object.entries(
        studioState.document.profiles,
      ))
        if (scope === intent) studioPersonaOwners.set(scope, profileName);
    return studioField(
      form,
      scope,
      name,
      value,
      type,
      (value) => {
        if (
          !studioProfileRecord(studioState.document.profiles) ||
          !Object.values(studioState.document.profiles).includes(scope)
        )
          throw new Error(
            "Restore this persona in advanced profile JSON before applying its pending fields.",
          );
        change(value);
      },
      options,
    );
  },
  writable: studioPersonaWritable,
  commit: (change) => {
    if (!studioPersonaWritable()) return false;
    change();
    studioDirty();
    studioRender();
    return true;
  },
  sync: () => {
    studioRenderProfiles();
  },
  pending: (scope, name) =>
    studioState.drafts.has(`${studioScope(scope)}:${name}`),
  discard: studioDiscardPersonaDrafts,
  reassign: studioReassignPersona,
});
studioBindCanvas();
studioLoad(studioNewDocument());
void studioValidate();
