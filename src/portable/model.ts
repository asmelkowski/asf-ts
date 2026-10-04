import type { Json } from "../types.js";
import type { ProfileIntent } from "../profiles.js";
export type Schema = Record<string, unknown>;
/** JSON data with exact {$ref:'#/input/x' | '#/nodes/id/x'} selection objects. */
export type Value = Json;
export interface Predicate {
  left: Value;
  op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "truthy";
  right?: Json;
}
interface Base {
  id: string;
}
export type Node =
  | (Base & {
      kind: "agent";
      profile?: string;
      prompt: string;
      context?: Value;
      outputSchema: Schema;
      corrections?: number;
      next: string;
    })
  | (Base & {
      kind: "command";
      argv: string[];
      timeoutMs?: number;
      next: string;
    })
  | (Base & {
      kind: "workflow";
      workflow: string;
      input: Value;
      attempt?: number;
      maxDispatches?: number;
      timeoutMs?: number;
      next: string;
    })
  | (Base & {
      kind: "custom";
      component: string;
      input: Value;
      inputSchema: Schema;
      outputSchema: Schema;
      next: string;
    })
  | (Base & {
      kind: "branch";
      predicate: Predicate;
      then: string;
      else: string;
    })
  | (Base & { kind: "end"; output: Value; passed?: Value })
  | (Base & {
      kind: "repeat";
      workflow: string;
      input: Value;
      until: Predicate;
      maxIterations: number;
      next: string;
    })
  | (Base & {
      kind: "parallel";
      branches: { id: string; workflow: string; input: Value }[];
      join: "all" | "any";
      next: string;
    });
export interface WorkflowDefinitionData {
  version: string;
  inputSchema: Schema;
  outputSchema: Schema;
  defaultProfile?: string;
  start: string;
  nodes: Node[];
  layout?: Record<string, { x: number; y: number }>;
}
export interface WorkflowDocument {
  format: "asf-ts-workflow/v1";
  root: string;
  workflows: Record<string, WorkflowDefinitionData>;
  profiles?: Record<string, ProfileIntent>;
}
export interface ValidatedWorkflow {
  document: WorkflowDocument;
  identity: string;
  warnings: string[];
}
export const NODE_CATALOGUE = [
  {
    kind: "agent",
    label: "Agent",
    description: "Typed native agent action with a selected profile",
  },
  {
    kind: "command",
    label: "Command",
    description: "Trusted shell-free argv check",
  },
  {
    kind: "workflow",
    label: "Child workflow",
    description: "Typed reusable child with explicit limits",
  },
  {
    kind: "custom",
    label: "Registered component",
    description: "Separately trusted local code",
  },
  {
    kind: "branch",
    label: "Branch",
    description: "Typed deterministic predicate",
  },
  {
    kind: "end",
    label: "End",
    description: "Typed result and business verdict",
  },
  {
    kind: "repeat",
    label: "Repeat",
    description: "Finite child calls with a stop predicate",
  },
  {
    kind: "parallel",
    label: "Parallel",
    description: "Read-only children with all/any join and complete drain",
  },
] as const;
