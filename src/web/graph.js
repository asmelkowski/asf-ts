/* Classic script. Every request is a local GET; no executable source is loaded. */
(() => {
  /** @type {import('../portable/inspection-types.js').GraphInspection | null} */
  let snapshot = null;
  let offset = Number(new URL(location.href).searchParams.get("offset") ?? 0);
  const limit = 20;
  let request = 0;
  const availableGraphs = () => {
    if (!snapshot) return [];
    return snapshot.focusedGraph &&
      !snapshot.graphs.some(
        (graph) => graph.invocationId === snapshot?.focusedGraph?.invocationId,
      )
      ? [...snapshot.graphs, snapshot.focusedGraph]
      : snapshot.graphs;
  };
  /** @template {HTMLElement} T @param {string} id @returns {T} */
  const element = (id) =>
    /** @type {T} */ (/** @type {unknown} */ (document.getElementById(id)));
  /** @param {string} id @param {string} text */
  const text = (id, text) => {
    element(id).textContent = text;
  };
  /** @param {unknown} value */
  const pretty = (value) => JSON.stringify(value, null, 2);
  /** @param {number | null} amount */
  const dollars = (amount) =>
    amount === null ? "unknown" : `$${amount.toFixed(6)} USD`;
  /** @param {string} id @param {number} pageOffset */
  const invocationUrl = (id, pageOffset) => {
    const url = new URL("/graph", location.href);
    url.searchParams.set("run", snapshot?.runId ?? "");
    url.searchParams.set("offset", String(pageOffset));
    url.searchParams.set("invocation", id);
    return url.pathname + url.search;
  };
  /** @param {import('../portable/inspection-types.js').GraphChildLink} child */
  const childLink = (child) => {
    const anchor = document.createElement("a");
    anchor.className = "graph-child";
    anchor.href = invocationUrl(child.invocationId, child.pageOffset);
    anchor.textContent = `${child.slot}: ${child.invocationId} · lifecycle ${child.lifecycle} · business passed ${child.businessPassed === null ? "unavailable" : child.businessPassed}`;
    return anchor;
  };
  /** @param {import('../portable/inspection-types.js').GraphNode} node */
  const states = (node) => [
    ...new Set([
      ...node.actions.map((action) => action.lifecycle),
      ...node.children.map((child) => child.lifecycle),
    ]),
  ];
  /** @param {string} id */
  const showReceipt = (id) => {
    const receipt = snapshot?.legacy.invocations.find((row) => row.id === id);
    text(
      "graph-receipt",
      receipt
        ? pretty(receipt)
        : "Receipt is outside this independently paged window.",
    );
    element("graph-receipt-title").scrollIntoView({ block: "nearest" });
  };
  /** @param {import('../portable/inspection-types.js').GraphNode} node */
  const selectNode = (node) => {
    text("graph-node-title", `Node ${node.source.id} · ${node.source.kind}`);
    const detail = element("graph-node-evidence");
    detail.replaceChildren();
    const source = document.createElement("pre");
    source.textContent = pretty(node.source.data);
    detail.append(source);
    const coverage = document.createElement("p");
    coverage.textContent = states(node).length
      ? `Loaded lifecycle states: ${states(node).join(", ")}.`
      : "Unobserved in this window; no skipped-state claim.";
    detail.append(coverage);
    for (const child of node.children) detail.append(childLink(child));
    for (const action of node.actions) {
      const section = document.createElement("div");
      section.className = "graph-evidence";
      const title = document.createElement("h4");
      title.textContent = action.id;
      section.append(title);
      const state = document.createElement("p");
      state.textContent = `${action.kind} · lifecycle ${action.lifecycle}${action.insideComponent ? " · registered component inner action" : ""} · recorded replay events ${action.replayEvents} · loaded ledger subtotal ${dollars(action.knownUsd)} · unresolved loaded receipts ${action.unresolved}`;
      section.append(state);
      const result = document.createElement("pre");
      result.textContent = pretty({
        metadata: action.metadata,
        result: action.result,
        error: action.error,
      });
      section.append(result);
      if (!action.nativeInvocationIds.length) {
        const missing = document.createElement("p");
        missing.textContent =
          "No native/local receipt loaded for this action. Other turns may be on another page.";
        section.append(missing);
      }
      for (const id of action.nativeInvocationIds) {
        const button = document.createElement("button");
        button.textContent = `Receipt ${id} · turn ${snapshot?.legacy.invocations.find((row) => row.id === id)?.turn ?? "outside window"}`;
        button.addEventListener("click", () => showReceipt(id));
        section.append(button);
      }
      detail.append(section);
    }
  };
  /** @param {import('../portable/inspection-types.js').WorkflowGraph} graph */
  const draw = (graph) => {
    const panel = element("graph-diagram"),
      list = element("graph-node-list");
    panel.replaceChildren();
    list.replaceChildren();
    if (!graph.source) {
      panel.textContent =
        "No verified declared source is available. Raw workflow records remain below.";
      return;
    }
    const namespace = "http://www.w3.org/2000/svg";
    const raw = graph.nodes.map((node, index) => ({
      node,
      x: graph.source?.layout?.[node.source.id]?.x ?? (index % 2) * 300,
      y:
        graph.source?.layout?.[node.source.id]?.y ??
        Math.floor(index / 2) * 140,
    }));
    const minX = Math.min(0, ...raw.map((p) => p.x)),
      minY = Math.min(0, ...raw.map((p) => p.y));
    const positions = new Map(
      raw.map((p) => [
        p.node.source.id,
        { ...p, x: p.x - minX + 40, y: p.y - minY + 40 },
      ]),
    );
    const width = Math.max(
        600,
        ...[...positions.values()].map((p) => p.x + 300),
      ),
      height = Math.max(180, ...[...positions.values()].map((p) => p.y + 140));
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("role", "group");
    svg.setAttribute("aria-label", `Authored topology for ${graph.name}`);
    const definitions = document.createElementNS(namespace, "defs");
    const marker = document.createElementNS(namespace, "marker");
    for (const [key, value] of Object.entries({
      id: "graph-arrow",
      markerWidth: "8",
      markerHeight: "8",
      refX: "7",
      refY: "4",
      orient: "auto",
    }))
      marker.setAttribute(key, value);
    const tip = document.createElementNS(namespace, "path");
    tip.setAttribute("d", "M0 0L8 4L0 8Z");
    marker.append(tip);
    definitions.append(marker);
    svg.append(definitions);
    for (const node of graph.nodes) {
      const p = positions.get(node.source.id);
      if (!p) continue;
      for (const edge of node.edges) {
        const q = positions.get(edge.target);
        if (!q) continue;
        const path = document.createElementNS(namespace, "path");
        path.setAttribute(
          "d",
          `M ${p.x + 115} ${p.y + 76} L ${q.x + 115} ${q.y}`,
        );
        path.setAttribute("marker-end", "url(#graph-arrow)");
        svg.append(path);
        const label = document.createElementNS(namespace, "text");
        label.setAttribute("x", String((p.x + q.x) / 2 + 115));
        label.setAttribute("y", String((p.y + q.y) / 2 + 36));
        label.textContent = edge.label;
        svg.append(label);
      }
    }
    for (const node of graph.nodes) {
      const p = positions.get(node.source.id);
      if (!p) continue;
      const state = states(node),
        button = document.createElement("button");
      button.className = "graph-node-button";
      button.textContent = `${node.source.id} · ${node.source.kind} · ${state.join(", ") || "unobserved"}`;
      button.addEventListener("click", () => selectNode(node));
      list.append(button);
      const group = document.createElementNS(namespace, "g");
      group.setAttribute("role", "button");
      group.setAttribute("tabindex", "0");
      group.setAttribute(
        "aria-label",
        `Inspect node ${node.source.id}, ${node.source.kind}, ${state.join(", ") || "unobserved"}`,
      );
      group.setAttribute(
        "class",
        state.map((s) => `node-${s.replace(/[^a-z]/g, "")}`).join(" "),
      );
      group.addEventListener("click", () => selectNode(node));
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectNode(node);
        }
      });
      const rectangle = document.createElementNS(namespace, "rect");
      rectangle.setAttribute("x", String(p.x));
      rectangle.setAttribute("y", String(p.y));
      rectangle.setAttribute("width", "250");
      rectangle.setAttribute("height", "80");
      rectangle.setAttribute("rx", "8");
      group.append(rectangle);
      for (const [index, value] of [
        `${node.source.id} · ${node.source.kind}`,
        state.join(", ") || "unobserved in this window",
        node.children.length
          ? `Child business passed: ${node.children.map((child) => child.businessPassed ?? "pending").join(", ")}`
          : `${node.actions.length} loaded action(s)`,
      ].entries()) {
        const label = document.createElementNS(namespace, "text");
        label.setAttribute("x", String(p.x + 10));
        label.setAttribute("y", String(p.y + 22 + index * 22));
        label.textContent = value;
        group.append(label);
      }
      svg.append(group);
    }
    panel.append(svg);
  };
  const selectWorkflow = () => {
    const id = /** @type {HTMLSelectElement} */ (element("graph-invocation"))
      .value;
    const graph = availableGraphs().find((graph) => graph.invocationId === id);
    element("graph-selected").hidden = !graph;
    if (!graph || !snapshot) return;
    text(
      "graph-title",
      `${graph.name ?? "Unverified source"} · attempt ${graph.attempt}`,
    );
    text("graph-lifecycle", `Workflow lifecycle: ${graph.lifecycle}`);
    text(
      "graph-verdict",
      `Business passed: ${graph.businessPassed === null ? "unavailable until a typed workflow result completes" : graph.businessPassed}`,
    );
    text(
      "graph-binding",
      `${graph.invocationId} · reserved ASF dispatches ${graph.dispatchesUsed} / ${graph.maxDispatches ?? "unbounded"} · recorded replay events ${graph.replayEvents} · persisted deadline ${new Date(graph.deadline).toISOString()}`,
    );
    const parent = element("graph-parent");
    parent.replaceChildren();
    if (graph.parentLink)
      parent.append(
        childLink({
          ...graph.parentLink,
          slot: `parent via ${graph.parentLink.nodeId} (${graph.parentLink.slot})`,
        }),
      );
    else if (graph.parentInvocation)
      parent.textContent = `Unverified parent relation: ${graph.parentInvocation}`;
    text(
      "graph-workflow-proof",
      pretty({
        invocationId: graph.invocationId,
        definitionIdentity: graph.definitionIdentity,
        inputIdentity: graph.inputIdentity,
        sourceDocumentIdentity: graph.sourceDocumentIdentity,
        input: graph.input,
        raw: graph.raw,
        result: graph.result,
        error: graph.error,
      }),
    );
    text(
      "graph-source",
      pretty(
        snapshot.documents.find(
          (doc) => doc.identity === graph.sourceDocumentIdentity,
        )?.value ?? null,
      ),
    );
    text("graph-unmapped", pretty(graph.unmappedActions));
    text("graph-receipt", "Select an exact receipt ID from a node.");
    element("graph-node-evidence").replaceChildren();
    text("graph-node-title", "Select a declared node");
    draw(graph);
    const url = new URL(location.href);
    url.searchParams.set("run", snapshot.runId);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("invocation", id);
    history.replaceState(null, "", url);
  };
  const load = async () => {
    const run = /** @type {HTMLInputElement} */ (
      element("graph-run")
    ).value.trim();
    if (!run) {
      text("graph-status", "Enter a run ID.");
      return;
    }
    const token = ++request;
    element("graph-workspace").hidden = true;
    text("graph-status", "Reading stored graph and receipts…");
    try {
      const focused = new URL(location.href).searchParams.get("invocation");
      const response = await fetch(
        `/workflow-inspect?run=${encodeURIComponent(run)}&offset=${offset}&limit=${limit}${focused ? `&invocation=${encodeURIComponent(focused)}` : ""}`,
      );
      if (!response.ok) throw new Error(await response.text());
      const value =
        /** @type {import('../portable/inspection-types.js').GraphInspection} */ (
          await response.json()
        );
      if (token !== request) return;
      snapshot = value;
      if (!value.exists) {
        text("graph-status", "Run not found.");
        return;
      }
      element("graph-workspace").hidden = false;
      text(
        "graph-status",
        `Read-only snapshot at ${new Date(value.observedAt).toISOString()}.`,
      );
      text("graph-run-heading", value.runId);
      text(
        "graph-cost",
        `Run-wide ledger subtotal: ${dollars(value.legacy.totals.knownUsd)} · unresolved invocations ${value.legacy.totals.unresolved ?? 0}. Reports are not added to ledger receipts.`,
      );
      text(
        "graph-coverage",
        `Record window ${offset}–${offset + limit - 1}: ${value.graphs.length} of ${value.counts.workflows} workflow invocations. Source window: first ${value.sourceWindow.limit} documents and definitions; ${value.sourceWindow.complete ? "complete" : "incomplete"}. Actions and receipts are independent windows.`,
      );
      const warnings = element("graph-warnings");
      warnings.replaceChildren();
      for (const warning of value.warnings) {
        const item = document.createElement("li");
        item.textContent = warning;
        warnings.append(item);
      }
      /** @type {HTMLButtonElement} */ (element("graph-prev")).disabled =
        offset === 0;
      /** @type {HTMLButtonElement} */ (element("graph-next")).disabled =
        offset + limit >=
        Math.max(
          value.counts.workflows,
          value.counts.actions,
          value.legacy.totals.invocations,
        );
      const choices = /** @type {HTMLSelectElement} */ (
        element("graph-invocation")
      );
      choices.replaceChildren();
      for (const graph of availableGraphs()) {
        const option = document.createElement("option");
        option.value = graph.invocationId;
        option.textContent = `${graph.name ?? "unverified"} · ${graph.lifecycle} · ${graph.invocationId}`;
        choices.append(option);
      }
      element("graph-empty").hidden = availableGraphs().length > 0;
      const requested = new URL(location.href).searchParams.get("invocation");
      if (
        requested &&
        availableGraphs().some((graph) => graph.invocationId === requested)
      )
        choices.value = requested;
      selectWorkflow();
    } catch (error) {
      if (token === request)
        text(
          "graph-status",
          error instanceof Error ? error.message : String(error),
        );
    }
  };
  const loadRun = () => {
    offset = 0;
    const url = new URL(location.href);
    url.searchParams.delete("invocation");
    history.replaceState(null, "", url);
    void load();
  };
  element("graph-load").addEventListener("click", loadRun);
  element("graph-run").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      loadRun();
    }
  });
  element("graph-invocation").addEventListener("change", selectWorkflow);
  element("graph-prev").addEventListener("click", () => {
    offset = Math.max(0, offset - limit);
    void load();
  });
  element("graph-next").addEventListener("click", () => {
    offset += limit;
    void load();
  });
  element("graph-runs").addEventListener("change", () => {
    /** @type {HTMLInputElement} */ (element("graph-run")).value =
      /** @type {HTMLSelectElement} */ (element("graph-runs")).value;
    loadRun();
  });
  const selectedRun = new URL(location.href).searchParams.get("run");
  if (selectedRun) {
    /** @type {HTMLInputElement} */ (element("graph-run")).value = selectedRun;
    void load();
  }
  void fetch("/runs?offset=0&limit=200")
    .then((response) => {
      if (!response.ok) throw new Error("Run list unavailable");
      return response.json();
    })
    .then(
      /** @param {import('../inspection.js').RunSummary[]} rows */ (rows) => {
        const select = element("graph-runs");
        for (const row of rows) {
          const option = document.createElement("option");
          option.value = row.id;
          option.textContent = `${row.id} · ${row.status}`;
          select.append(option);
        }
      },
    )
    .catch((error) => {
      if (!selectedRun) text("graph-status", String(error));
    });
})();
