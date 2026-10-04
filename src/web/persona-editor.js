/* Classic script. Persona intent stays in the authored workflow document. */
/** @typedef {{id:string,revision:string}} PersonaPluginReference */
/** @typedef {{id:string,name:string,description?:string,revision?:string,source?:string}} PersonaCataloguePlugin */
/** @typedef {{format:string,models:string[],tools:string[],plugins:PersonaCataloguePlugin[],marketplace?:{name:string,revision:string,source?:string}}} PersonaCatalogue */
/** @typedef {{document:()=>StudioDocument,field:typeof studioField,writable:()=>boolean,commit:(change:()=>void)=>boolean,sync:()=>void,pending:(scope:object,name:string)=>boolean,discard:(scope:object,name?:string)=>void,reassign:(oldName:string,newName?:string)=>number}} PersonaEditorHost */
/** @param {PersonaEditorHost} host */
// Called by studio.js after this classic script loads.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function createPersonaEditor(host) {
  const dialog = document.getElementById("studio-persona-dialog");
  if (!(dialog instanceof HTMLDialogElement))
    throw new Error("Missing persona editor dialog");
  /** @param {string} id @returns {HTMLElement} */
  function element(id) {
    const result = document.getElementById(id);
    if (!result) throw new Error(`Missing persona editor element ${id}`);
    return result;
  }
  /** @param {string} id @returns {HTMLInputElement} */
  function input(id) {
    const result = element(id);
    if (!(result instanceof HTMLInputElement))
      throw new Error(`Missing persona editor input ${id}`);
    return result;
  }
  const listElement = element("studio-persona-list"),
    form = element("studio-persona-form");
  if (
    !(listElement instanceof HTMLSelectElement) ||
    !(form instanceof HTMLFormElement)
  )
    throw new Error("Missing persona editor list or form");
  const list = /** @type {HTMLSelectElement} */ (listElement);
  const namePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/,
    revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
  const emptyHint =
    "Create a named persona, then assign it in workflow settings or an agent block.";
  let selected = "",
    confirmingDelete = "",
    pluginFilter = "",
    catalogueRevision = 0;
  /** @type {PersonaCatalogue} */
  let catalogue = {
    format: "asf-persona-catalogue/v1",
    models: [],
    tools: [],
    plugins: [],
  };
  /** @param {string} text @param {boolean} [error] */
  function message(text, error = false) {
    const status = element("studio-persona-message");
    status.textContent = text;
    status.dataset.state = error ? "error" : "info";
  }
  /** @param {unknown} value @returns {value is Record<string,unknown>} */
  function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function profiles() {
    const value = host.document().profiles;
    return value === undefined ? {} : record(value) ? value : null;
  }
  /** @param {string} name */
  function validName(name) {
    if (!namePattern.test(name))
      throw new Error(
        "Use 1–128 characters: start with a letter, then letters, digits, dots, underscores or hyphens.",
      );
  }
  /** @param {()=>void} action */
  function action(action) {
    try {
      if (!host.writable()) {
        message(
          "Apply pending source and advanced profile JSON before editing personas.",
          true,
        );
        return;
      }
      action();
    } catch (error) {
      message(error instanceof Error ? error.message : String(error), true);
    }
  }
  /** @param {string} name @param {Record<string,unknown>} intent @param {string} label @param {string} type @param {StudioFieldOptions} [options] @param {(value:unknown)=>unknown} [convert] */
  function field(
    name,
    intent,
    label,
    type,
    options = {},
    convert = (value) => value,
  ) {
    return host.field(
      form,
      intent,
      name,
      intent[name],
      type,
      (value) => {
        if (!host.writable())
          throw new Error(
            "Apply pending source and advanced profile JSON first.",
          );
        const next = convert(value);
        if (next === undefined) delete intent[name];
        else
          Object.defineProperty(intent, name, {
            value: next,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        confirmingDelete = "";
        host.sync();
      },
      { optional: true, ...options, label },
    );
  }
  /** @param {unknown} value @returns {string[]} */
  function tools(value) {
    const names = String(value ?? "")
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean);
    if (names.length > 256 || names.some((name) => name.length > 256))
      throw new Error(
        "Use at most 256 tool names, each at most 256 characters.",
      );
    if (new Set(names).size !== names.length)
      throw new Error("Tool names must be unique.");
    return names.sort();
  }
  /** @param {Record<string,unknown>} intent */
  function renderTools(intent) {
    const explicit =
      intent.tools !== undefined || host.pending(intent, "tools");
    const choice = host.field(
      form,
      intent,
      "toolSelection",
      explicit ? "explicit" : "unspecified",
      "select",
      (value) => {
        if (!host.writable())
          throw new Error(
            "Apply pending source and advanced profile JSON first.",
          );
        if (value === "unspecified") {
          delete intent.tools;
          host.discard(intent, "tools");
        } else if (intent.tools === undefined) intent.tools = [];
        confirmingDelete = "";
        host.sync();
        queueMicrotask(render);
      },
      { label: "Tool selection", values: ["unspecified", "explicit"] },
    );
    const value = Array.isArray(intent.tools)
      ? intent.tools.join("\n")
      : (intent.tools ?? "");
    const control = host.field(
      form,
      intent,
      "tools",
      value,
      "multiline",
      (value) => {
        if (!host.writable())
          throw new Error(
            "Apply pending source and advanced profile JSON first.",
          );
        intent.tools = tools(value);
        confirmingDelete = "";
        host.sync();
        updateInventory();
      },
      { label: "Available tools", allowEmpty: true },
    );
    control.disabled = choice.value !== "explicit";
    const inventory = document.createElement("fieldset");
    inventory.className = "persona-inventory";
    const legend = document.createElement("legend");
    legend.textContent = "Catalogue tool names";
    inventory.append(legend);
    /** @type {HTMLInputElement[]} */
    const checkboxes = [];
    function updateInventory() {
      const names = Array.isArray(intent.tools) ? intent.tools : [];
      for (const checkbox of checkboxes)
        checkbox.checked = names.includes(checkbox.value);
    }
    for (const name of catalogue.tools) {
      const label = document.createElement("label"),
        checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = name;
      checkbox.disabled = control.disabled;
      checkbox.addEventListener("change", () => {
        action(() => {
          if (host.pending(intent, "tools"))
            throw new Error(
              "Apply the pending Available tools field before selecting catalogue tools.",
            );
          const names = new Set(
            Array.isArray(intent.tools) ? intent.tools : [],
          );
          if (checkbox.checked) names.add(name);
          else names.delete(name);
          control.value = [...names].sort().join("\n");
          control.dispatchEvent(new Event("input", { bubbles: true }));
          control.dispatchEvent(new Event("change", { bubbles: true }));
        });
        updateInventory();
      });
      checkboxes.push(checkbox);
      label.append(checkbox, document.createTextNode(name));
      inventory.append(label);
    }
    updateInventory();
    const hint = document.createElement("p");
    hint.className = "studio-hint";
    hint.textContent =
      "Unspecified uses the local binding. Explicit with an empty list requests no tools. Catalogue names do not prove a target provides or restricts them.";
    form.append(inventory, hint);
  }
  /** @param {unknown} value @returns {value is PersonaPluginReference} */
  function pluginReference(value) {
    return (
      record(value) &&
      typeof value.id === "string" &&
      typeof value.revision === "string" &&
      Object.keys(value).length === 2
    );
  }
  /** @param {Record<string,unknown>} intent */
  function renderPlugins(intent) {
    host.field(
      form,
      intent,
      "pluginSelection",
      intent.plugins === undefined ? "unspecified" : "explicit",
      "select",
      (value) => {
        if (!host.writable())
          throw new Error(
            "Apply pending source and advanced profile JSON first.",
          );
        if (value === "unspecified") delete intent.plugins;
        else if (intent.plugins === undefined) intent.plugins = [];
        confirmingDelete = "";
        host.sync();
        queueMicrotask(render);
      },
      { label: "Plugin selection", values: ["unspecified", "explicit"] },
    );
    const inventory = document.createElement("fieldset");
    inventory.className = "persona-inventory";
    const legend = document.createElement("legend");
    legend.textContent = "Marketplace plugins";
    inventory.append(legend);
    const searchLabel = document.createElement("label"),
      search = document.createElement("input"),
      pluginList = document.createElement("div"),
      count = document.createElement("p");
    searchLabel.textContent = "Find marketplace plugins";
    search.type = "search";
    search.id = "studio-persona-plugin-search";
    search.value = pluginFilter;
    searchLabel.append(search);
    pluginList.className = "studio-persona-plugin-list";
    count.className = "studio-hint";
    count.setAttribute("role", "status");
    inventory.append(searchLabel, count, pluginList);
    const references = Array.isArray(intent.plugins) ? intent.plugins : [];
    function renderPluginList() {
      const filter = pluginFilter.trim().toLowerCase(),
        matches = catalogue.plugins.filter((plugin) =>
          `${plugin.id} ${plugin.name} ${plugin.description ?? ""}`
            .toLowerCase()
            .includes(filter),
        );
      count.textContent = `${Math.min(matches.length, 100)} of ${matches.length} matching plugins${matches.length > 100 ? "; narrow the search to show more" : ""}. ${catalogue.plugins.length} catalogue entries.`;
      pluginList.replaceChildren();
      for (const plugin of matches.slice(0, 100)) {
        const label = document.createElement("label"),
          checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.disabled = intent.plugins === undefined || !plugin.revision;
        checkbox.checked = references.some(
          (reference) =>
            pluginReference(reference) &&
            reference.id === plugin.id &&
            reference.revision === plugin.revision,
        );
        checkbox.setAttribute("aria-label", `Select plugin ${plugin.name}`);
        checkbox.addEventListener("change", () => {
          action(() => {
            if (!plugin.revision || !revisionPattern.test(plugin.revision))
              throw new Error(
                "This catalogue plugin has no immutable revision and is browse-only.",
              );
            host.commit(() => {
              const remaining = references.filter(
                (reference) =>
                  !pluginReference(reference) || reference.id !== plugin.id,
              );
              if (checkbox.checked)
                remaining.push({ id: plugin.id, revision: plugin.revision });
              intent.plugins = remaining;
              confirmingDelete = "";
            });
          });
          checkbox.checked = references.some(
            (reference) =>
              pluginReference(reference) &&
              reference.id === plugin.id &&
              reference.revision === plugin.revision,
          );
        });
        const copy = document.createElement("span");
        copy.className = "studio-persona-plugin-copy";
        copy.append(
          document.createTextNode(
            `${plugin.name} · ${plugin.id}${plugin.revision ? "" : " · unpinned, browse-only"}`,
          ),
        );
        if (plugin.description) {
          const description = document.createElement("small");
          description.textContent = plugin.description;
          copy.append(description);
        }
        label.append(checkbox, copy);
        pluginList.append(label);
      }
    }
    search.addEventListener("input", () => {
      pluginFilter = search.value;
      renderPluginList();
    });
    renderPluginList();
    if (intent.plugins !== undefined) {
      const selected = document.createElement("ul");
      selected.className = "persona-selected-plugins";
      if (!Array.isArray(intent.plugins)) {
        const item = document.createElement("li");
        item.textContent =
          "The authored plugin value is invalid. Repair it in advanced profile JSON.";
        selected.append(item);
      }
      for (const [index, reference] of references.entries()) {
        const item = document.createElement("li"),
          detail = document.createElement("span"),
          remove = document.createElement("button");
        if (!pluginReference(reference))
          detail.textContent = `Invalid authored plugin reference: ${JSON.stringify(reference)}`;
        else {
          const known = catalogue.plugins.find(
            (plugin) =>
              plugin.id === reference.id &&
              plugin.revision === reference.revision,
          );
          detail.textContent = `${reference.id} @ ${reference.revision} · ${!revisionPattern.test(reference.revision) ? "unpinned authored reference" : known ? "selected catalogue metadata" : "not in this catalogue"}`;
        }
        remove.type = "button";
        remove.textContent = "Remove";
        remove.setAttribute(
          "aria-label",
          pluginReference(reference)
            ? `Remove plugin ${reference.id}`
            : `Remove invalid plugin reference ${index + 1}`,
        );
        remove.addEventListener("click", () =>
          action(() =>
            host.commit(() => {
              intent.plugins = references.filter(
                (_, position) => position !== index,
              );
              confirmingDelete = "";
            }),
          ),
        );
        item.append(detail, remove);
        selected.append(item);
      }
      inventory.append(selected);
    }
    const hint = document.createElement("p");
    hint.className = "studio-hint";
    hint.textContent =
      "Catalogue entries are metadata. Selecting a plugin does not install or enable it. Execution needs an exact, locally configured plugin inventory. Unspecified uses the binding; an explicit empty list requires no active plugins.";
    form.append(inventory, hint);
  }
  function render() {
    const all = profiles(),
      names = all ? Object.keys(all) : [];
    if (!Object.hasOwn(all ?? {}, selected)) selected = names[0] ?? "";
    list.replaceChildren(
      ...names.map((name) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        return option;
      }),
    );
    list.value = selected;
    input("studio-persona-rename-name").value = selected;
    element("studio-persona-delete").textContent =
      confirmingDelete === selected && selected
        ? "Confirm delete persona"
        : "Delete persona";
    form.replaceChildren();
    const intent = all?.[selected];
    if (!all || (selected && !record(intent))) {
      message(
        "Profiles must be named objects. Repair the advanced profile JSON before using this editor.",
        true,
      );
      return;
    }
    if (!selected || !record(intent)) {
      message(emptyHint);
      return;
    }
    if (element("studio-persona-message").textContent === emptyHint)
      message("");
    field(
      "instructions",
      intent,
      "System instructions",
      "multiline",
      { optional: false, allowEmpty: true },
      (value) => {
        if (new TextEncoder().encode(String(value)).length > 64 * 1024)
          throw new Error("System instructions exceed 64 KiB.");
        return value;
      },
    );
    const inherit = document.createElement("button");
    inherit.type = "button";
    inherit.textContent = "Use binding instructions";
    inherit.addEventListener("click", () =>
      action(() =>
        host.commit(() => {
          delete intent.instructions;
          host.discard(intent, "instructions");
        }),
      ),
    );
    form.append(inherit);
    field(
      "instructionsChannel",
      intent,
      "Instruction delivery",
      "select",
      { values: ["", "prompt-prefix", "native-system"] },
      (value) => value || undefined,
    );
    const instructionHint = document.createElement("p");
    instructionHint.className = "studio-hint";
    instructionHint.textContent =
      "Prompt prefixes are advisory. Native system delivery needs a local target configured with these exact instructions. Empty options use profile defaults; they do not verify target support.";
    form.append(instructionHint);
    const model = field("model", intent, "Model", "text", {}, (value) => {
      if (
        value !== undefined &&
        (!String(value).trim() ||
          new TextEncoder().encode(String(value)).length > 64 * 1024)
      )
        throw new Error("Model must be a nonempty name of at most 64 KiB.");
      return value;
    });
    model.setAttribute("list", "studio-persona-models");
    const models = document.createElement("datalist");
    models.id = "studio-persona-models";
    for (const name of catalogue.models) {
      const option = document.createElement("option");
      option.value = name;
      models.append(option);
    }
    form.append(models);
    renderTools(intent);
    field(
      "mode",
      intent,
      "Mode",
      "select",
      { values: ["", "read-only", "write"] },
      (value) => value || undefined,
    );
    field(
      "strict",
      intent,
      "Strict tool selection",
      "select",
      { values: ["", "false", "true"] },
      (value) =>
        value === "" || value === undefined ? undefined : value === "true",
    );
    field("timeoutMs", intent, "Timeout (ms)", "number", {
      min: 1,
      max: 3600000,
    });
    field(
      "session",
      intent,
      "Session policy",
      "select",
      { values: ["", "fresh", "compatible"] },
      (value) => value || undefined,
    );
    renderPlugins(intent);
  }
  element("studio-persona-open").addEventListener("click", () => {
    render();
    if (!dialog.open) dialog.showModal();
  });
  element("studio-persona-close").addEventListener("click", () =>
    dialog.close(),
  );
  form.addEventListener("submit", (event) => event.preventDefault());
  list.addEventListener("change", () => {
    selected = list.value;
    confirmingDelete = "";
    render();
  });
  element("studio-persona-add").addEventListener("click", () =>
    action(() => {
      const name = input("studio-persona-new-name").value;
      validName(name);
      const all = profiles();
      if (!all)
        throw new Error(
          "Repair advanced profile JSON before creating a persona.",
        );
      if (Object.hasOwn(all, name))
        throw new Error(`Persona ${name} already exists.`);
      if (Object.keys(all).length >= 256)
        throw new Error("The document already has 256 personas.");
      host.commit(() => {
        host.document().profiles = Object.fromEntries([
          ...Object.entries(all),
          [name, {}],
        ]);
        selected = name;
        confirmingDelete = "";
        input("studio-persona-new-name").value = "";
      });
      message(
        `Persona ${name} created. Assign it in workflow settings or an agent block.`,
      );
    }),
  );
  element("studio-persona-rename").addEventListener("click", () =>
    action(() => {
      const name = input("studio-persona-rename-name").value;
      validName(name);
      const all = profiles();
      if (!all || !Object.hasOwn(all, selected))
        throw new Error("Select a persona to rename.");
      if (name === selected) return;
      if (Object.hasOwn(all, name))
        throw new Error(`Persona ${name} already exists.`);
      const oldName = selected;
      host.commit(() => {
        host.document().profiles = Object.fromEntries(
          Object.entries(all).map(([key, value]) => [
            key === oldName ? name : key,
            value,
          ]),
        );
        host.reassign(oldName, name);
        selected = name;
        confirmingDelete = "";
      });
      message(
        `Persona ${oldName} renamed to ${name}. Its assignments were updated.`,
      );
    }),
  );
  element("studio-persona-delete").addEventListener("click", () =>
    action(() => {
      const all = profiles();
      if (!all || !Object.hasOwn(all, selected))
        throw new Error("Select a persona to delete.");
      const references = Object.values(host.document().workflows).reduce(
        (count, definition) =>
          count +
          Number(definition.defaultProfile === selected) +
          definition.nodes.filter(
            (node) => node.kind === "agent" && node.profile === selected,
          ).length,
        0,
      );
      if (confirmingDelete !== selected) {
        confirmingDelete = selected;
        element("studio-persona-delete").textContent = "Confirm delete persona";
        message(
          `Delete persona ${selected}${references ? ` and remove ${references} assignment${references === 1 ? "" : "s"}` : ""}? Click Confirm delete persona to continue.`,
        );
        return;
      }
      const name = selected;
      host.commit(() => {
        const intent = all[name];
        if (record(intent)) host.discard(intent);
        host.document().profiles = Object.fromEntries(
          Object.entries(all).filter(([key]) => key !== name),
        );
        host.reassign(name);
        selected = "";
        confirmingDelete = "";
      });
      message(
        `Persona ${name} deleted. ${references} assignment${references === 1 ? "" : "s"} removed.`,
      );
    }),
  );
  /** @param {string} method @param {unknown} [value] */
  async function loadCatalogue(method, value) {
    const revision = ++catalogueRevision;
    try {
      const response = await fetch(
        "/studio/persona-catalogue",
        method === "GET"
          ? {}
          : {
              method,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(value),
            },
      );
      const result = await response.json();
      if (revision !== catalogueRevision) return;
      if (!response.ok) throw new Error(result.error ?? response.statusText);
      catalogue = result;
      render();
      message(
        `Catalogue loaded: ${catalogue.models.length} models, ${catalogue.tools.length} tools, ${catalogue.plugins.length} plugins. Metadata does not install or enable plugins.`,
      );
    } catch (error) {
      if (revision === catalogueRevision)
        message(error instanceof Error ? error.message : String(error), true);
    }
  }
  input("studio-persona-catalogue-file").addEventListener(
    "change",
    async () => {
      const chooser = input("studio-persona-catalogue-file"),
        file = chooser.files?.[0];
      chooser.value = "";
      if (!file) return;
      const revision = ++catalogueRevision;
      try {
        if (file.size > 1024 * 1024)
          throw new Error("Persona catalogue exceeds 1 MiB.");
        const text = await file.text();
        if (revision !== catalogueRevision) return;
        await loadCatalogue("POST", JSON.parse(text));
      } catch (error) {
        if (revision === catalogueRevision)
          message(error instanceof Error ? error.message : String(error), true);
      }
    },
  );
  void loadCatalogue("GET");
  return {
    render,
    reset() {
      selected = "";
      confirmingDelete = "";
      pluginFilter = "";
      render();
    },
  };
}
