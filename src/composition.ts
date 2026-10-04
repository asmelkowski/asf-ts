import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { clip, encode, hash } from "./util.js";
import type { Scope } from "./runtime.js";
import type { Json } from "./types.js";

export class WorkflowTimeoutError extends Error {}

export interface WorkflowValue<T extends Json = Json> {
  passed: boolean;
  value: T;
  summary?: string;
}
export interface WorkflowDefinition<
  I extends Json = Json,
  O extends Json = Json,
> {
  name: string;
  version: string;
  /** Caller-owned identity of workflow code and relevant dependencies. */
  identity: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  run(scope: Scope, input: I): Promise<WorkflowValue<O>>;
  /** Data-only authored graph. Its first snapshot remains the inspection source. */
  document?: Json;
}
export interface WorkflowOptions {
  attempt?: number;
  maxDispatches?: number;
  timeoutMs?: number;
}
export interface WorkflowResult<
  T extends Json = Json,
> extends WorkflowValue<T> {
  provenance: {
    runId: string;
    invocationId: string;
    parentInvocation: string | null;
    attempt: number;
    definitionIdentity: string;
    inputIdentity: string;
  };
}
export interface PreparedWorkflow<I extends Json, O extends Json> {
  definition: Json;
  definitionIdentity: string;
  input: I;
  inputIdentity: string;
  document?: Json;
  attempt: number;
  maxDispatches: number | null;
  timeoutMs: number;
  output: ValidateFunction<O>;
  run: WorkflowDefinition<I, O>["run"];
}

/** Preserve legacy draft-07 behavior; explicit 2020-12 contracts use their own engine. */
export function precompileSchema<T = unknown>(
  schema: Record<string, unknown>,
): ValidateFunction<T> {
  const dialect = schema.$schema;
  const modern =
    typeof dialect === "string" &&
    /^https?:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/.test(dialect);
  const validator = modern
    ? new Ajv2020({ strict: true, allErrors: false })
    : new Ajv({ strict: true, allErrors: false });
  return validator.compile<T>(schema);
}

export function assertSchema(
  schema: Record<string, unknown>,
  value: unknown,
  label = "value",
): void {
  const validate = precompileSchema(schema);
  if (!validate(value))
    throw new Error(
      `${label} does not match its schema: ${clip(JSON.stringify(validate.errors), 2048)}`,
    );
}

export function snapshot<T>(value: T, limit = 64 * 1024): T {
  const ancestors = new Set<object>();
  const check = (item: unknown, depth: number): void => {
    if (depth > 64) throw new Error("JSON value exceeds 64 levels");
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || ancestors.has(item))
      throw new Error("Workflow data must contain only finite JSON values");
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new Error("Workflow data must use plain JSON objects");
    if (Object.getOwnPropertySymbols(item).length)
      throw new Error("Workflow data cannot contain symbol keys");
    ancestors.add(item);
    for (const child of Array.isArray(item) ? item : Object.values(item))
      check(child, depth + 1);
    ancestors.delete(item);
  };
  check(value, 0);
  const copy: unknown = JSON.parse(encode(value, limit));
  const freeze = (item: unknown): void => {
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy as T;
}

export function prepareWorkflow<I extends Json, O extends Json>(
  definition: WorkflowDefinition<I, O>,
  input: Json,
  options: WorkflowOptions,
): PreparedWorkflow<I, O> {
  if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(definition.name))
    throw new Error("Invalid workflow name");
  if (!definition.version || Buffer.byteLength(definition.version) > 128)
    throw new Error("Invalid workflow version");
  if (!definition.identity || Buffer.byteLength(definition.identity) > 256)
    throw new Error("Workflow requires a bounded code/dependency identity");
  const attempt = options.attempt ?? 1;
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 999999)
    throw new Error("Invalid workflow attempt");
  const maxDispatches = options.maxDispatches ?? null;
  if (
    maxDispatches !== null &&
    (!Number.isSafeInteger(maxDispatches) ||
      maxDispatches < 0 ||
      maxDispatches > 100000)
  )
    throw new Error("Invalid workflow dispatch limit");
  const timeoutMs = options.timeoutMs ?? 300000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000)
    throw new Error("Invalid workflow timeout");
  const inputSchema = snapshot(definition.inputSchema, 16 * 1024);
  const outputSchema = snapshot(definition.outputSchema, 16 * 1024);
  const selected = snapshot(input) as I;
  assertSchema(inputSchema, selected, "Workflow input");
  const metadata: Json = {
    name: definition.name,
    version: definition.version,
    identity: definition.identity,
    inputSchema: inputSchema as Json,
    outputSchema: outputSchema as Json,
  };
  return {
    definition: snapshot(metadata),
    definitionIdentity: hash(metadata),
    input: selected,
    inputIdentity: hash(selected),
    ...(definition.document === undefined
      ? {}
      : { document: snapshot(definition.document, 1024 * 1024) }),
    attempt,
    maxDispatches,
    timeoutMs,
    output: precompileSchema<O>(outputSchema),
    run: definition.run,
  };
}
