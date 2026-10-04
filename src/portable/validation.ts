import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  isAlias,
  isCollection,
  isScalar,
  parseDocument as yamlDocument,
  stringify,
} from "yaml";
import { json, encode } from "../util.js";
import {
  portableHash as hash,
  portableCanonical as canonical,
} from "./canonical.js";
import { parseProfiles } from "../profiles.js";
import type { Json } from "../types.js";
import {
  NODE_CATALOGUE,
  type Node,
  type Predicate,
  type Schema,
  type Value,
  type WorkflowDocument,
  type ValidatedWorkflow,
} from "./model.js";
export const DOCUMENT_LIMIT = 1024 * 1024;
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label}: expected object`);
  return value as Record<string, unknown>;
}
function fields(
  value: unknown,
  allowed: string[],
  required: string[],
  label: string,
): Record<string, unknown> {
  const r = record(value, label);
  for (const k of Object.keys(r))
    if (!allowed.includes(k)) throw new Error(`${label}: unknown field ${k}`);
  for (const k of required)
    if (!Object.hasOwn(r, k)) throw new Error(`${label}: missing ${k}`);
  return r;
}
const id = (x: unknown): x is string =>
  typeof x === "string" &&
  /^[a-zA-Z0-9_.-]{1,100}$/.test(x) &&
  x !== "." &&
  x !== "..";
function bound(x: unknown, max: number, label: string, min = 1): void {
  if (!Number.isSafeInteger(x) || Number(x) < min || Number(x) > max)
    throw new Error(`${label}: invalid finite bound`);
}
export function parseDocument(
  source: string,
  byteLimit = DOCUMENT_LIMIT,
): WorkflowDocument {
  if (
    !Number.isSafeInteger(byteLimit) ||
    byteLimit < 1 ||
    byteLimit > 8 * DOCUMENT_LIMIT
  )
    throw new Error("Invalid parser bound");
  if (Buffer.byteLength(source) > byteLimit)
    throw new Error("Workflow document exceeds 1 MiB");
  const parsed = yamlDocument(source, {
    uniqueKeys: true,
    strict: true,
    version: "1.2",
  });
  if (parsed.errors.length)
    throw new Error(parsed.errors.map((e) => e.message).join("; "));
  let count = 0;
  const walk = (node: unknown): void => {
    if (++count > 20000)
      throw new Error("Workflow document has too many values");
    if (isAlias(node)) throw new Error("YAML aliases are unsupported");
    if (isCollection(node) || isScalar(node)) {
      if (
        node.tag &&
        !/^tag:yaml\.org,2002:(map|seq|str|null|bool|int|float)$/.test(node.tag)
      )
        throw new Error("YAML custom tags are unsupported");
      if (isCollection(node))
        for (const item of node.items) {
          if (
            item &&
            typeof item === "object" &&
            "key" in item &&
            "value" in item
          ) {
            walk(item.key);
            walk(item.value);
          } else walk(item);
        }
    }
  };
  walk(parsed.contents);
  if (parsed.warnings.length)
    throw new Error(parsed.warnings.map((w) => w.message).join("; "));
  return JSON.parse(
    encode(parsed.toJS({ maxAliasCount: 0 }), byteLimit),
  ) as WorkflowDocument;
}
function schemaCheck(schema: unknown, label: string): Schema {
  const s = record(schema, label);
  if (Buffer.byteLength(JSON.stringify(s)) > 16 * 1024)
    throw new Error(`${label}: schema exceeds 16 KiB`);
  const walk = (x: unknown): void => {
    if (x && typeof x === "object") {
      for (const [k, v] of Object.entries(x)) {
        if (k === "$ref" || k === "$dynamicRef" || k === "$recursiveRef")
          throw new Error(`${label}: schema references are unsupported`);
        walk(v);
      }
    }
  };
  walk(s);
  try {
    const ajv =
      s.$schema === "https://json-schema.org/draft/2020-12/schema"
        ? new Ajv2020({ strict: true })
        : new Ajv({ strict: true });
    ajv.compile(s);
  } catch (e) {
    throw new Error(`${label}: invalid schema: ${String(e)}`);
  }
  return s;
}
export function assertValue(
  schema: Schema,
  value: unknown,
  label = "Value",
): void {
  const ajv =
    schema.$schema === "https://json-schema.org/draft/2020-12/schema"
      ? new Ajv2020({ strict: true })
      : new Ajv({ strict: true });
  const v = ajv.compile(schema);
  if (!v(value)) throw new Error(`${label}: ${ajv.errorsText(v.errors)}`);
}
const commandSchema: Schema = {
  type: "object",
  properties: {
    code: { type: ["integer", "null"] },
    signal: { type: ["string", "null"] },
    stdout: { type: "string" },
    stderr: { type: "string" },
    truncated: { type: "boolean" },
    cancelled: { type: "boolean" },
  },
  required: ["code", "signal", "stdout", "stderr", "truncated", "cancelled"],
  additionalProperties: false,
};
function pathSchema(schema: Schema, segments: string[], label: string): Schema {
  let s = schema;
  for (const key of segments) {
    const props = s.properties as Record<string, Schema> | undefined;
    if (s.type === "object" && props && Object.hasOwn(props, key)) {
      if (!(s.required as string[] | undefined)?.includes(key))
        throw new Error(
          `${label}: optional property ${key} cannot be selected`,
        );
      s = props[key]!;
    } else if (s.type === "array" && /^\d+$/.test(key)) {
      if (Number(s.minItems ?? 0) <= Number(key))
        throw new Error(`${label}: array index is not guaranteed`);
      const tuple = (s.prefixItems ??
        (Array.isArray(s.items) ? s.items : undefined)) as Schema[] | undefined;
      s =
        tuple?.[Number(key)] ??
        (s.items && !Array.isArray(s.items) ? (s.items as Schema) : {});
    } else
      throw new Error(`${label}: unknown or nonselectable property ${key}`);
  }
  return s;
}
function valueSchema(
  value: Value,
  input: Schema,
  outputs: Map<string, Schema>,
  available: Set<string>,
  label: string,
): Schema {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (Object.hasOwn(value, "$ref")) {
      const keys = Object.keys(value);
      if (keys.length !== 1 || typeof value.$ref !== "string")
        throw new Error(`${label}: invalid data reference`);
      const parts = value.$ref.split("/");
      if (
        parts[0] !== "#" ||
        !["input", "nodes", "result"].includes(parts[1] ?? "")
      )
        throw new Error(`${label}: unsupported reference ${value.$ref}`);
      const rest = parts
        .slice(2)
        .map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
      if (parts[1] === "input") return pathSchema(input, rest, label);
      const name = parts[1] === "result" ? "$result" : rest.shift()!;
      if (!available.has(name))
        throw new Error(
          `${label}: reference ${name} is unavailable on an incoming path`,
        );
      return pathSchema(outputs.get(name)!, rest, label);
    }
    const properties: Record<string, Schema> = Object.create(null) as Record<
      string,
      Schema
    >;
    for (const [k, v] of Object.entries(value))
      properties[k] = valueSchema(v, input, outputs, available, label);
    return {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    };
  }
  if (Array.isArray(value))
    return {
      type: "array",
      minItems: value.length,
      maxItems: value.length,
      items: value.length
        ? {
            anyOf: value.map((x) =>
              valueSchema(x, input, outputs, available, label),
            ),
          }
        : {},
    };
  return {
    type:
      value === null
        ? "null"
        : typeof value === "number"
          ? Number.isInteger(value)
            ? "integer"
            : "number"
          : typeof value,
    const: value,
  };
}
function compatible(from: Schema, to: Schema, label: string): void {
  if (canonical(from) === canonical(to) || Object.keys(to).length === 0) return;
  if (Object.hasOwn(from, "const")) {
    try {
      assertValue(to, from.const, label);
    } catch (e) {
      throw new Error(`${label}: incompatible port value: ${String(e)}`);
    }
    return;
  }
  if (Array.isArray(from.enum)) {
    for (const value of from.enum) assertValue(to, value, label);
    return;
  }
  if (Array.isArray(from.anyOf)) {
    for (const option of from.anyOf as Schema[]) compatible(option, to, label);
    return;
  }
  if (Array.isArray(to.anyOf)) {
    for (const option of to.anyOf as Schema[]) {
      try {
        compatible(from, option, label);
        return;
      } catch {
        /* Try the next declared alternative. */
      }
    }
    throw new Error(`${label}: no compatible port alternative`);
  }
  const supported = new Set([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "prefixItems",
    "additionalItems",
    "minItems",
    "maxItems",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "enum",
    "const",
    "$schema",
    "$id",
    "title",
    "description",
    "default",
    "examples",
  ]);
  if (Object.keys(to).some((k) => !supported.has(k)))
    throw new Error(
      `${label}: structural port comparison is unsupported; use an identical schema`,
    );
  const types = (s: Schema): string[] =>
    s.type === undefined
      ? []
      : Array.isArray(s.type)
        ? (s.type as string[])
        : [String(s.type)];
  const a = types(from),
    b = types(to);
  if (
    b.length &&
    (!a.length ||
      a.some(
        (t) => !b.includes(t) && !(t === "integer" && b.includes("number")),
      ))
  )
    throw new Error(`${label}: incompatible port types`);
  if (Object.hasOwn(to, "const") || to.enum)
    throw new Error(`${label}: enum/constant subset cannot be proven`);
  for (const key of ["minimum", "exclusiveMinimum", "minLength", "minItems"])
    if (
      to[key] !== undefined &&
      (from[key] === undefined || Number(from[key]) < Number(to[key]))
    )
      throw new Error(`${label}: lower bound mismatch`);
  for (const key of ["maximum", "exclusiveMaximum", "maxLength", "maxItems"])
    if (
      to[key] !== undefined &&
      (from[key] === undefined || Number(from[key]) > Number(to[key]))
    )
      throw new Error(`${label}: upper bound mismatch`);
  for (const key of ["pattern", "format"])
    if (to[key] !== undefined && from[key] !== to[key])
      throw new Error(`${label}: ${key} restriction cannot be proven`);
  if (b.includes("object")) {
    const fp = from.properties as Record<string, Schema> | undefined,
      tp = to.properties as Record<string, Schema> | undefined;
    for (const key of (to.required as string[]) ?? [])
      if (!(from.required as string[] | undefined)?.includes(key) || !fp?.[key])
        throw new Error(`${label}: missing required port ${key}`);
    for (const [key, source] of Object.entries(fp ?? {})) {
      if (tp && Object.hasOwn(tp, key))
        compatible(source, tp[key]!, `${label}/${key}`);
      else if (to.additionalProperties === false)
        throw new Error(`${label}: undeclared port ${key}`);
      else if (
        to.additionalProperties &&
        typeof to.additionalProperties === "object"
      )
        compatible(
          source,
          to.additionalProperties as Schema,
          `${label}/${key}`,
        );
    }
    if (
      to.additionalProperties === false &&
      from.additionalProperties !== false
    )
      throw new Error(`${label}: unbounded object port`);
    if (from.additionalProperties !== false) {
      for (const [key, target] of Object.entries(tp ?? {}))
        if (!fp || !Object.hasOwn(fp, key))
          compatible(
            typeof from.additionalProperties === "object"
              ? (from.additionalProperties as Schema)
              : {},
            target,
            `${label}/${key}`,
          );
      if (
        to.additionalProperties &&
        typeof to.additionalProperties === "object"
      )
        compatible(
          typeof from.additionalProperties === "object"
            ? (from.additionalProperties as Schema)
            : {},
          to.additionalProperties as Schema,
          `${label} additional properties`,
        );
    }
  }
  if (b.includes("array")) {
    const tuple = (s: Schema): Schema[] | undefined =>
      (s.prefixItems ?? (Array.isArray(s.items) ? s.items : undefined)) as
        | Schema[]
        | undefined;
    const item = (s: Schema, index: number): Schema | false =>
      tuple(s)?.[index] ??
      (tuple(s)
        ? s.additionalItems === false || s.items === false
          ? false
          : typeof s.items === "object" && !Array.isArray(s.items)
            ? (s.items as Schema)
            : typeof s.additionalItems === "object"
              ? (s.additionalItems as Schema)
              : {}
        : s.items === false
          ? false
          : typeof s.items === "object"
            ? (s.items as Schema)
            : {});
    const width =
      Math.max(tuple(from)?.length ?? 0, tuple(to)?.length ?? 0) + 1;
    for (let index = 0; index < width; index++) {
      if (index >= Number(from.maxItems ?? Infinity)) break;
      const source = item(from, index),
        target = item(to, index);
      if (source === false) continue;
      if (target === false)
        throw new Error(`${label}: extra tuple items are unsupported`);
      compatible(source, target, `${label}[${index}]`);
    }
  }
}

export function transitions(node: Node): string[] {
  return node.kind === "end"
    ? []
    : node.kind === "branch"
      ? [node.then, node.else]
      : [node.next];
}
export function validateDocument(raw: unknown): ValidatedWorkflow {
  if (Buffer.byteLength(JSON.stringify(raw) ?? "") > DOCUMENT_LIMIT)
    throw new Error("Workflow document exceeds 1 MiB");
  const top = fields(
    raw,
    ["format", "root", "workflows", "profiles"],
    ["format", "root", "workflows"],
    "Document",
  );
  if (top.format !== "asf-ts-workflow/v1" || !id(top.root))
    throw new Error("Unsupported workflow format or root");
  const doc = JSON.parse(encode(raw, DOCUMENT_LIMIT)) as WorkflowDocument;
  if (top.profiles !== undefined) doc.profiles = parseProfiles(top.profiles);
  const definitions = record(doc.workflows, "workflows");
  if (
    Object.keys(definitions).length > 64 ||
    !Object.hasOwn(definitions, doc.root)
  )
    throw new Error("Invalid workflow closure/root");
  const dependencies = new Map<string, string[]>();
  const warnings: string[] = [];
  for (const [name, data] of Object.entries(doc.workflows)) {
    if (!id(name)) throw new Error("Invalid workflow name");
    fields(
      data,
      [
        "version",
        "inputSchema",
        "outputSchema",
        "defaultProfile",
        "start",
        "nodes",
        "layout",
      ],
      ["version", "inputSchema", "outputSchema", "start", "nodes"],
      name,
    );
    if (
      typeof data.version !== "string" ||
      !data.version ||
      data.version.length > 100 ||
      !id(data.start)
    )
      throw new Error(`${name}: invalid version/start`);
    schemaCheck(data.inputSchema, `${name} input`);
    schemaCheck(data.outputSchema, `${name} output`);
    if (
      data.defaultProfile !== undefined &&
      (typeof data.defaultProfile !== "string" ||
        !Object.hasOwn(doc.profiles ?? {}, data.defaultProfile))
    )
      throw new Error(`${name}: unknown default profile`);
    if (
      !Array.isArray(data.nodes) ||
      !data.nodes.length ||
      data.nodes.length > 128
    )
      throw new Error(`${name}: invalid node count`);
    const nodes = new Map<string, Node>(),
      deps: string[] = [];
    const outputs = new Map<string, Schema>();
    for (const n of data.nodes) {
      if (!id(n.id) || nodes.has(n.id))
        throw new Error(`${name}: invalid/duplicate node ID`);
      nodes.set(n.id, n);
      const label = `${name}/${n.id}`;
      const allowed: Record<string, string[]> = {
        agent: [
          "profile",
          "prompt",
          "context",
          "outputSchema",
          "corrections",
          "next",
        ],
        command: ["argv", "timeoutMs", "next"],
        workflow: [
          "workflow",
          "input",
          "attempt",
          "maxDispatches",
          "timeoutMs",
          "next",
        ],
        custom: ["component", "input", "inputSchema", "outputSchema", "next"],
        branch: ["predicate", "then", "else"],
        end: ["output", "passed"],
        repeat: ["workflow", "input", "until", "maxIterations", "next"],
        parallel: ["branches", "join", "next"],
      };
      const required: Record<string, string[]> = {
        agent: ["prompt", "outputSchema", "next"],
        command: ["argv", "next"],
        workflow: ["workflow", "input", "next"],
        custom: ["component", "input", "inputSchema", "outputSchema", "next"],
        branch: ["predicate", "then", "else"],
        end: ["output"],
        repeat: ["workflow", "input", "until", "maxIterations", "next"],
        parallel: ["branches", "join", "next"],
      };
      if (!NODE_CATALOGUE.some((c) => c.kind === n.kind))
        throw new Error(`${label}: unknown node kind`);
      fields(
        n,
        ["id", "kind", ...allowed[n.kind]!],
        ["id", "kind", ...required[n.kind]!],
        label,
      );
      for (const k of ["timeoutMs", "maxDispatches", "attempt"]) {
        const v = (n as unknown as Record<string, unknown>)[k];
        if (v !== undefined)
          bound(
            v,
            k === "timeoutMs" ? 3600000 : 10000,
            `${label} ${k}`,
            k === "maxDispatches" ? 0 : 1,
          );
      }
      if (n.kind === "agent") {
        if (typeof n.prompt !== "string" || Buffer.byteLength(n.prompt) > 65536)
          throw new Error(`${label}: invalid prompt`);
        if (
          n.profile !== undefined &&
          (typeof n.profile !== "string" ||
            !Object.hasOwn(doc.profiles ?? {}, n.profile))
        )
          throw new Error(`${label}: unknown profile`);
        if (!n.profile && !data.defaultProfile)
          throw new Error(`${label}: agent requires a profile`);
        if (
          n.corrections !== undefined &&
          (!Number.isInteger(n.corrections) ||
            n.corrections < 0 ||
            n.corrections > 3)
        )
          throw new Error(`${label}: corrections 0..3`);
        outputs.set(n.id, schemaCheck(n.outputSchema, label));
      } else if (n.kind === "command") {
        if (
          !Array.isArray(n.argv) ||
          !n.argv.length ||
          n.argv.length > 100 ||
          n.argv.some(
            (a) =>
              typeof a !== "string" || a.includes("\0") || a.length > 65536,
          )
        )
          throw new Error(`${label}: invalid argv`);
        outputs.set(n.id, commandSchema);
      } else if (n.kind === "custom") {
        if (!id(n.component)) throw new Error(`${label}: invalid component`);
        schemaCheck(n.inputSchema, label);
        outputs.set(n.id, schemaCheck(n.outputSchema, label));
      } else if (n.kind === "workflow" || n.kind === "repeat") {
        if (!id(n.workflow) || !Object.hasOwn(doc.workflows, n.workflow))
          throw new Error(`${label}: missing child ${n.workflow}`);
        deps.push(n.workflow);
        outputs.set(
          n.id,
          n.kind === "workflow"
            ? doc.workflows[n.workflow]!.outputSchema
            : {
                type: "object",
                properties: {
                  value: doc.workflows[n.workflow]!.outputSchema,
                  iterations: { type: "integer" },
                  passed: { type: "boolean" },
                },
                required: ["value", "iterations", "passed"],
                additionalProperties: false,
              },
        );
        if (n.kind === "repeat")
          bound(n.maxIterations, 100, `${label} iterations`);
      } else if (n.kind === "parallel") {
        if (
          !["all", "any"].includes(n.join) ||
          !Array.isArray(n.branches) ||
          !n.branches.length ||
          n.branches.length > 16
        )
          throw new Error(`${label}: invalid parallel join`);
        const ids = new Set<string>();
        for (const branch of n.branches) {
          fields(
            branch,
            ["id", "workflow", "input"],
            ["id", "workflow", "input"],
            label,
          );
          if (
            !id(branch.id) ||
            ids.has(branch.id) ||
            !id(branch.workflow) ||
            !Object.hasOwn(doc.workflows, branch.workflow)
          )
            throw new Error(`${label}: invalid branch`);
          ids.add(branch.id);
          deps.push(branch.workflow);
        }
        outputs.set(n.id, {
          type: "object",
          properties: {
            values: { type: "array", items: {} },
            passed: { type: "boolean" },
          },
          required: ["values", "passed"],
          additionalProperties: false,
        });
      }
    }
    dependencies.set(name, deps);
    if (!nodes.has(data.start)) throw new Error(`${name}: missing start`);
    if (data.layout !== undefined) {
      record(data.layout, `${name} layout`);
      for (const [key, pos] of Object.entries(data.layout)) {
        if (!nodes.has(key))
          throw new Error(`${name}: layout refers to missing node`);
        fields(pos, ["x", "y"], ["x", "y"], "layout");
        if (
          !Number.isFinite(pos.x) ||
          !Number.isFinite(pos.y) ||
          Math.abs(pos.x) > 10000 ||
          Math.abs(pos.y) > 10000
        )
          throw new Error("Invalid layout position");
      }
    }
    const visited = new Set<string>(),
      active = new Set<string>(),
      order: string[] = [];
    const visit = (key: string): void => {
      if (active.has(key))
        throw new Error(`${name}: structural cycle; use repeat`);
      if (visited.has(key)) return;
      const node = nodes.get(key);
      if (!node) throw new Error(`${name}: missing transition ${key}`);
      active.add(key);
      for (const next of transitions(node)) visit(next);
      active.delete(key);
      visited.add(key);
      order.unshift(key);
    };
    visit(data.start);
    if (visited.size !== nodes.size)
      throw new Error(`${name}: unreachable nodes`);
    const incoming = new Map<string, Set<string>>([[data.start, new Set()]]);
    for (const key of order) {
      const node = nodes.get(key)!,
        available = incoming.get(key)!;
      const select = (v: Value): Schema =>
        valueSchema(v, data.inputSchema, outputs, available, `${name}/${key}`);
      const predicate = (p: Predicate, result?: Schema): void => {
        fields(p, ["left", "op", "right"], ["left", "op"], "predicate");
        if (!["eq", "ne", "lt", "lte", "gt", "gte", "truthy"].includes(p.op))
          throw new Error("Invalid predicate operation");
        const out = result ? new Map(outputs).set("$result", result) : outputs;
        const avail = result ? new Set(available).add("$result") : available;
        const left = valueSchema(
          p.left,
          data.inputSchema,
          out,
          avail,
          "predicate",
        );
        if (p.op === "truthy")
          compatible(left, { type: "boolean" }, "predicate");
        else {
          if (p.right === undefined)
            throw new Error("Predicate requires right");
          const right = valueSchema(
            p.right,
            data.inputSchema,
            out,
            avail,
            "predicate",
          );
          if (["lt", "lte", "gt", "gte"].includes(p.op)) {
            compatible(left, { type: "number" }, "predicate");
            compatible(right, { type: "number" }, "predicate");
          } else if (
            left.type !== undefined &&
            right.type !== undefined &&
            left.type !== right.type &&
            !(
              new Set([left.type, right.type]).has("number") &&
              new Set([left.type, right.type]).has("integer")
            )
          )
            throw new Error("Incompatible predicate types");
        }
      };
      if (node.kind === "agent" && node.context !== undefined)
        select(node.context);
      if (node.kind === "workflow" || node.kind === "repeat") {
        compatible(
          select(node.input),
          doc.workflows[node.workflow]!.inputSchema,
          `${name}/${key} child input`,
        );
        if (node.kind === "repeat")
          predicate(node.until, doc.workflows[node.workflow]!.outputSchema);
      }
      if (node.kind === "custom")
        compatible(
          select(node.input),
          node.inputSchema,
          `${name}/${key} component input`,
        );
      if (node.kind === "parallel")
        for (const b of node.branches)
          compatible(
            select(b.input),
            doc.workflows[b.workflow]!.inputSchema,
            `${name}/${key} branch input`,
          );
      if (node.kind === "branch") predicate(node.predicate);
      if (node.kind === "end") {
        compatible(
          select(node.output),
          data.outputSchema,
          `${name}/${key} output`,
        );
        if (node.passed !== undefined)
          compatible(
            select(node.passed),
            { type: "boolean" },
            `${name}/${key} passed`,
          );
      }
      const after = new Set(available);
      if (outputs.has(key)) after.add(key);
      for (const next of transitions(node)) {
        const previous = incoming.get(next);
        incoming.set(
          next,
          previous
            ? new Set([...previous].filter((v) => after.has(v)))
            : new Set(after),
        );
      }
    }
  }
  const seen = new Set<string>(),
    active = new Set<string>();
  const child = (name: string): void => {
    if (active.has(name)) throw new Error("Recursive child workflow closure");
    if (seen.has(name)) return;
    active.add(name);
    for (const n of dependencies.get(name) ?? []) child(n);
    active.delete(name);
    seen.add(name);
  };
  for (const name of Object.keys(doc.workflows)) child(name);
  if (
    Object.values(doc.workflows).some((w) =>
      w.nodes.some((n) => n.kind === "command" || n.kind === "custom"),
    )
  )
    warnings.push(
      "Commands and custom registrations are trusted code; execution needs explicit local authorization.",
    );
  return { document: doc, identity: semanticIdentity(doc), warnings };
}
export function semanticIdentity(doc: WorkflowDocument): string {
  return hash({
    ...doc,
    workflows: Object.fromEntries(
      Object.entries(doc.workflows).map(([name, w]) => {
        const { layout: ignored, ...semantic } = w;
        void ignored;
        return [
          name,
          {
            ...semantic,
            nodes: [...w.nodes].sort((a, b) => a.id.localeCompare(b.id)),
          },
        ];
      }),
    ),
  });
}
export function serializeDocument(
  doc: WorkflowDocument,
  format: "json" | "yaml",
): string {
  validateDocument(doc);
  return format === "yaml"
    ? stringify(JSON.parse(encode(doc, DOCUMENT_LIMIT)), {
        aliasDuplicateObjects: false,
      })
    : JSON.stringify(doc, null, 2) + "\n";
}
export function resolveValue(
  value: Value,
  input: Json,
  outputs: Record<string, Json>,
  result?: Json,
): Json {
  if (Array.isArray(value))
    return value.map((v) => resolveValue(v, input, outputs, result));
  if (value && typeof value === "object") {
    if (Object.hasOwn(value, "$ref")) {
      const parts = String(value.$ref).split("/").slice(1),
        base = parts.shift();
      let selected: Json | undefined =
        base === "input"
          ? input
          : base === "result"
            ? result
            : outputs[parts.shift()!];
      for (const p of parts) {
        const key = p.replace(/~1/g, "/").replace(/~0/g, "~");
        if (
          !selected ||
          typeof selected !== "object" ||
          !Object.hasOwn(selected, key)
        )
          throw new Error("Unavailable runtime reference");
        selected = (selected as Record<string, Json>)[key];
      }
      if (selected === undefined)
        throw new Error("Unavailable runtime reference");
      return json(selected);
    }
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        resolveValue(v, input, outputs, result),
      ]),
    );
  }
  return value;
}
export function evaluatePredicate(
  predicate: Predicate,
  input: Json,
  outputs: Record<string, Json>,
  result?: Json,
): boolean {
  const left = resolveValue(predicate.left, input, outputs, result),
    right =
      predicate.right === undefined
        ? null
        : resolveValue(predicate.right, input, outputs, result);
  switch (predicate.op) {
    case "truthy":
      if (typeof left !== "boolean")
        throw new Error("Predicate requires boolean");
      return left;
    case "eq":
      return canonical(left) === canonical(right);
    case "ne":
      return canonical(left) !== canonical(right);
    default:
      if (typeof left !== "number" || typeof right !== "number")
        throw new Error("Predicate requires numbers");
      return predicate.op === "lt"
        ? left < right
        : predicate.op === "lte"
          ? left <= right
          : predicate.op === "gt"
            ? left > right
            : left >= right;
  }
}
