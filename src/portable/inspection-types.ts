import type { Json } from "../types.js";
import type { Inspection } from "../inspection.js";

export interface GraphDefinitionSource {
  version: string;
  inputSchema: Json;
  outputSchema: Json;
  defaultProfile: string | null;
  start: string;
  layout: Record<string, { x: number; y: number }> | null;
}
export interface GraphAction {
  id: string;
  kind: string;
  lifecycle: string;
  error: string | null;
  result: string | null;
  nativeInvocationIds: string[];
  knownUsd: number | null;
  unresolved: number;
  metadata: Json | null;
  insideComponent: boolean;
  replayEvents: number;
}
export interface GraphChildLink {
  invocationId: string;
  pageOffset: number;
  nodeId: string;
  slot: string;
  lifecycle: string;
  businessPassed: boolean | null;
}
export interface GraphNode {
  source: { id: string; kind: string; data: Json };
  edges: { target: string; label: string }[];
  actions: GraphAction[];
  children: GraphChildLink[];
}
export interface WorkflowGraph {
  invocationId: string;
  parentInvocation: string | null;
  parentLink: GraphChildLink | null;
  definitionIdentity: string;
  sourceDocumentIdentity: string | null;
  name: string | null;
  attempt: number;
  lifecycle: string;
  businessPassed: boolean | null;
  deadline: number;
  dispatchesUsed: number;
  maxDispatches: number | null;
  replayEvents: number;
  inputIdentity: string;
  input: Json;
  raw: Json | null;
  result: Json | null;
  error: string | null;
  source: GraphDefinitionSource | null;
  nodes: GraphNode[];
  unmappedActions: GraphAction[];
}
export interface GraphInspection {
  runId: string;
  exists: boolean;
  observedAt: number;
  offset: number;
  limit: number;
  counts: {
    documents: number;
    definitions: number;
    workflows: number;
    actions: number;
  };
  sourceWindow: { offset: 0; limit: 200; complete: boolean };
  workflowWindowComplete: boolean;
  actionWindowComplete: boolean;
  warnings: string[];
  documents: { identity: string; value: Json; validated: boolean }[];
  graphs: WorkflowGraph[];
  focusedGraph: WorkflowGraph | null;
  legacy: Inspection;
}
