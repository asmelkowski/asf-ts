import { createHash } from "node:crypto";
import { knownUsd, validateAccounting } from "../accounting.js";
import type { Inspection } from "../inspection.js";
import type {
  GraphAction,
  GraphChildLink,
  GraphNode,
  WorkflowGraph,
  GraphInspection,
} from "./inspection-types.js";
export type { GraphInspection } from "./inspection-types.js";
import { Store, type WorkflowInspection, type WorkflowRow } from "../store.js";
import type { Accounting, Json } from "../types.js";
import { encode, errorText, hash, parse } from "../util.js";
import type {
  Node,
  WorkflowDocument,
  WorkflowDefinitionData,
} from "./model.js";
import { validateDocument } from "./validation.js";

type WorkflowProof = WorkflowInspection["workflows"][number];
interface Source {
  documentIdentity: string;
  name: string;
  workflow: WorkflowDefinitionData;
}
function verdict(row: { status: string; result: Json | null }): boolean | null {
  const result = row.result;
  return row.status === "completed" &&
    result !== null &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    typeof result.passed === "boolean"
    ? result.passed
    : null;
}
function edges(node: Node): GraphNode["edges"] {
  return node.kind === "end"
    ? []
    : node.kind === "branch"
      ? [
          { target: node.then, label: "true" },
          { target: node.else, label: "false" },
        ]
      : [{ target: node.next, label: "next" }];
}
function expectedChild(
  parent: WorkflowProof,
  child: WorkflowProof,
  source: Source,
): { nodeId: string; slot: string } | null {
  if (
    child.parent !== parent.id ||
    child.binding.parentInvocation !== parent.id
  )
    return null;
  const relative = child.id.startsWith(parent.id + "/")
    ? child.id.slice(parent.id.length + 1)
    : "";
  const suffix = `/workflow-v1/attempt-${String(child.binding.attempt).padStart(2, "0")}`;
  if (!relative.endsWith(suffix)) return null;
  const caller = relative.slice(0, -suffix.length);
  for (const node of source.workflow.nodes) {
    if (
      node.kind === "workflow" &&
      caller === node.id &&
      child.binding.attempt === (node.attempt ?? 1)
    )
      return { nodeId: node.id, slot: "child" };
    if (
      node.kind === "repeat" &&
      child.binding.attempt === 1 &&
      caller.startsWith(node.id + "/")
    ) {
      const match = caller
        .slice(node.id.length + 1)
        .match(/^iteration-([1-9][0-9]*)$/);
      if (match && Number(match[1]) <= node.maxIterations)
        return { nodeId: node.id, slot: `iteration ${match[1]}` };
    }
    if (node.kind === "parallel" && child.binding.attempt === 1) {
      const branch = node.branches.find(
        (branch) => caller === `${node.id}/${branch.id}`,
      );
      if (branch) return { nodeId: node.id, slot: `branch ${branch.id}` };
    }
  }
  return null;
}
function childName(node: Node, slot: string): string | null {
  if (node.kind === "workflow" || node.kind === "repeat") return node.workflow;
  if (node.kind === "parallel")
    return (
      node.branches.find((branch) => slot === `branch ${branch.id}`)
        ?.workflow ?? null
    );
  return null;
}
function proof(row: WorkflowRow, used = 0): WorkflowProof {
  return {
    ...row,
    binding: parse(row.binding),
    raw: row.raw === null ? null : parse(row.raw),
    result: row.result === null ? null : parse(row.result),
    dispatchesUsed: used,
  };
}

/** Read-only declared source projection. Never infer execution edges from observations. */
export function buildGraphInspection(
  store: Store,
  run: string,
  options: { offset?: number; limit?: number; invocationId?: string } = {},
): GraphInspection {
  const offset = options.offset ?? 0,
    limit = options.limit ?? 20;
  if (
    options.invocationId !== undefined &&
    (!options.invocationId.length || options.invocationId.length > 512)
  )
    throw new Error("Invalid focused invocation ID");
  // Separate legacy APIs each read a WAL snapshot. Reject interleaved external commits.
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = store.db.prepare("PRAGMA data_version").get()?.data_version;
    const window = store.workflowInspect(run, offset, limit),
      sources = store.workflowInspect(run, 0, 200),
      legacy = store.inspect(run, offset, limit);
    const focused =
      options.invocationId && window.counts.workflows > 0
        ? store.workflow(run, options.invocationId)
        : undefined;
    if (options.invocationId && !focused)
      throw new Error("Workflow invocation not found in this run");
    const projected = project(
      store,
      run,
      window,
      sources,
      legacy,
      focused
        ? proof(
            focused,
            Number(
              store.db
                .prepare(
                  "SELECT COUNT(*) AS n FROM workflow_usage WHERE run=? AND workflow=?",
                )
                .get(run, focused.id)?.n ?? 0,
            ),
          )
        : undefined,
    );
    if (store.db.prepare("PRAGMA data_version").get()?.data_version === before)
      return projected;
  }
  throw new Error("Inspection changed while reading; refresh the graph");
}
function project(
  store: Store,
  run: string,
  window: WorkflowInspection,
  sources: WorkflowInspection,
  legacy: Inspection,
  focused?: WorkflowProof,
): GraphInspection {
  const warnings: string[] = [];
  const documents = new Map<string, WorkflowDocument>();
  const documentRows = sources.documents.map((row) => {
    let validated = false;
    try {
      const digest = createHash("sha256")
        .update(encode(row.value, 1024 * 1024))
        .digest("hex");
      if (digest !== row.identity)
        throw new Error("Authored snapshot digest disagrees with its identity");
      documents.set(row.identity, validateDocument(row.value).document);
      validated = true;
    } catch (error) {
      warnings.push(`Source ${row.identity}: ${errorText(error)}`);
    }
    return { ...row, validated };
  });
  const definitions = new Map(
    sources.definitions.map((row) => [row.identity, row]),
  );
  const sourceFor = (row: WorkflowProof): Source | null => {
    if (row.definition !== row.binding.definitionIdentity) return null;
    const definition = definitions.get(row.definition),
      value = definition?.value;
    const name =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value?.name === "string"
        ? value.name
        : null;
    if (!definition?.documentIdentity || !name) return null;
    const workflow = documents.get(definition.documentIdentity)?.workflows[
      name
    ];
    if (
      !workflow ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    )
      return null;
    try {
      if (
        hash(value) !== definition.identity ||
        value.version !== workflow.version ||
        hash(value.inputSchema) !== hash(workflow.inputSchema) ||
        hash(value.outputSchema) !== hash(workflow.outputSchema)
      )
        return null;
    } catch {
      return null;
    }
    return { name, workflow, documentIdentity: definition.documentIdentity };
  };
  const workflows = new Map(window.workflows.map((row) => [row.id, row]));
  if (focused) {
    const existing = workflows.get(focused.id);
    workflows.set(focused.id, existing ?? focused);
  }
  const native = new Map(legacy.actions.map((row) => [row.id, row]));
  const replays = (id: string, type: string): number =>
    Number(
      store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE run=? AND action=? AND type=?",
        )
        .get(run, id, type)?.n ?? 0,
    );
  const actionFor = (
    owned: WorkflowInspection["actions"][number],
    insideComponent: boolean,
  ): GraphAction => {
    const action = native.get(owned.id),
      receipts = legacy.invocations.filter((row) => row.action === owned.id);
    let amount: number | null = null,
      unresolved = 0;
    for (const row of receipts) {
      let malformed = false;
      try {
        const accounting = parse<Accounting>(row.accounting);
        validateAccounting(accounting);
        const known = knownUsd(accounting);
        if (known !== null) amount = (amount ?? 0) + known;
      } catch {
        malformed = true;
      }
      const unresolvedRow = store.db
        .prepare(
          "SELECT CASE WHEN l.complete=1 AND i.status!='uncertain' AND NOT EXISTS(SELECT 1 FROM reports p WHERE p.invocation=i.id AND json_extract(p.data,'$.status')='incomplete') THEN 0 ELSE 1 END AS unresolved FROM invocations i LEFT JOIN ledger l ON l.invocation=i.id WHERE i.id=? AND i.run=?",
        )
        .get(row.id, run);
      // Count each receipt once, even when its payload and persisted flags disagree.
      unresolved += Math.max(
        malformed ? 1 : 0,
        Number(unresolvedRow?.unresolved ?? 1),
      );
    }
    return {
      id: owned.id,
      kind: owned.kind,
      lifecycle: action?.status ?? "outside action window",
      error: action?.error ?? null,
      result: action?.result ?? null,
      nativeInvocationIds: receipts.map((row) => row.id),
      knownUsd: amount,
      unresolved,
      metadata: owned.metadata,
      insideComponent,
      replayEvents: replays(owned.id, "action.replayed"),
    };
  };
  const pageFor = (id: string): number => {
    const position = Number(
      store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM workflows WHERE run=? AND rowid < (SELECT rowid FROM workflows WHERE run=? AND id=?)",
        )
        .get(run, run, id)?.n ?? 0,
    );
    return Math.floor(position / window.limit) * window.limit;
  };
  const childLink = (
    parent: WorkflowProof,
    child: WorkflowProof,
  ): GraphChildLink | null => {
    const parentSource = sourceFor(parent),
      childSource = sourceFor(child);
    if (!parentSource || !childSource) return null;
    const mapping = expectedChild(parent, child, parentSource);
    const node =
      mapping &&
      parentSource.workflow.nodes.find((node) => node.id === mapping.nodeId);
    if (
      !mapping ||
      !node ||
      childName(node, mapping.slot) !== childSource.name ||
      child.definition !== child.binding.definitionIdentity
    )
      return null;
    return {
      ...mapping,
      invocationId: child.id,
      pageOffset: pageFor(child.id),
      lifecycle: child.status,
      businessPassed: verdict(child),
    };
  };
  const graphs: WorkflowGraph[] = [...workflows.values()].map((row) => {
    const source =
      row.definition === row.binding.definitionIdentity ? sourceFor(row) : null;
    if (!source)
      warnings.push(
        `Invocation ${row.id}: no verified declared source in the loaded source window`,
      );
    const retainedParent = row.parent
      ? store.workflow(run, row.parent)
      : undefined;
    const parentRow = row.parent
      ? (workflows.get(row.parent) ??
        (retainedParent ? proof(retainedParent) : undefined))
      : undefined;
    const relationship = parentRow ? childLink(parentRow, row) : null;
    const parentLink =
      relationship && parentRow
        ? {
            ...relationship,
            invocationId: parentRow.id,
            pageOffset: pageFor(parentRow.id),
            lifecycle: parentRow.status,
            businessPassed: verdict(parentRow),
          }
        : null;
    if (row.parent && !parentLink)
      warnings.push(
        `Invocation ${row.id}: parent relationship does not match a loaded declared call`,
      );
    const mapped = new Set<string>();
    const nodes: GraphNode[] =
      source?.workflow.nodes.map((node) => {
        const actions = window.actions
          .filter((action) => {
            if (
              action.workflow !== row.id ||
              !action.id.startsWith(row.id + "/")
            )
              return false;
            const relative = action.id.slice(row.id.length + 1);
            if (node.kind === "custom" && relative.startsWith(node.id + "/"))
              return true;
            const kind =
              node.kind === "agent"
                ? "model"
                : node.kind === "command"
                  ? "command"
                  : node.kind === "workflow"
                    ? null
                    : "local";
            return relative === node.id && action.kind === kind;
          })
          .map((action) => {
            mapped.add(action.id);
            return actionFor(action, action.id !== `${row.id}/${node.id}`);
          });
        const children = [...workflows.values()]
          .filter((child) => child.parent === row.id)
          .map((child) => childLink(row, child))
          .filter(
            (child): child is GraphChildLink =>
              child !== null && child.nodeId === node.id,
          );
        return {
          source: {
            id: node.id,
            kind: node.kind,
            data: parse<Json>(encode(node, 1024 * 1024)),
          },
          edges: edges(node),
          actions,
          children,
        };
      }) ?? [];
    return {
      invocationId: row.id,
      parentInvocation: row.parent,
      parentLink,
      definitionIdentity: row.definition,
      sourceDocumentIdentity: source?.documentIdentity ?? null,
      name: source?.name ?? null,
      attempt: row.binding.attempt,
      lifecycle: row.status,
      businessPassed: verdict(row),
      deadline: row.deadline,
      dispatchesUsed: row.dispatchesUsed,
      maxDispatches: row.binding.maxDispatches,
      replayEvents: replays(row.id, "workflow.replayed"),
      inputIdentity: row.binding.inputIdentity,
      input: row.binding.input,
      raw: row.raw,
      result: row.result,
      error: row.error,
      source: source
        ? {
            version: source.workflow.version,
            inputSchema: parse<Json>(encode(source.workflow.inputSchema)),
            outputSchema: parse<Json>(encode(source.workflow.outputSchema)),
            defaultProfile: source.workflow.defaultProfile ?? null,
            start: source.workflow.start,
            layout: source.workflow.layout ?? null,
          }
        : null,
      nodes,
      unmappedActions: window.actions
        .filter(
          (action) => action.workflow === row.id && !mapped.has(action.id),
        )
        .map((action) => actionFor(action, false)),
    };
  });
  const complete =
    window.offset === 0 && window.workflows.length === window.counts.workflows;
  const actionComplete =
    window.offset === 0 &&
    window.actions.length === window.counts.actions &&
    legacy.actions.length === window.counts.actions &&
    legacy.invocations.length === legacy.totals.invocations;
  if (!complete)
    warnings.push(
      "Workflow invocations are paged. Missing children and states are outside this window, not skipped work.",
    );
  if (!actionComplete)
    warnings.push(
      "Actions and native receipts are independently paged. Node subtotals cover loaded ledger receipts only.",
    );
  return {
    runId: run,
    exists: !!legacy.run,
    observedAt: Date.now(),
    offset: window.offset,
    limit: window.limit,
    counts: window.counts,
    sourceWindow: {
      offset: 0,
      limit: 200,
      complete:
        sources.documents.length === sources.counts.documents &&
        sources.definitions.length === sources.counts.definitions,
    },
    workflowWindowComplete: complete,
    actionWindowComplete: actionComplete,
    warnings,
    documents: documentRows,
    graphs: graphs.filter((graph) =>
      window.workflows.some((row) => row.id === graph.invocationId),
    ),
    focusedGraph: focused
      ? (graphs.find((graph) => graph.invocationId === focused.id) ?? null)
      : null,
    legacy,
  };
}
