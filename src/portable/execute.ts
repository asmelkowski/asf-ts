import type { AgentConfig, Json } from "../types.js";
import type { Runtime, Scope } from "../runtime.js";
import type {
  WorkflowDefinition,
  WorkflowResult,
  WorkflowValue,
} from "../composition.js";
import {
  resolveProfile,
  type ProfileBinding,
  type ProfileIntent,
  type ResolvedProfile,
} from "../profiles.js";
import { json, encode } from "../util.js";
import {
  portableHash as hash,
  portableCanonical as canonical,
} from "./canonical.js";
import {
  assertValue,
  evaluatePredicate,
  resolveValue,
  validateDocument,
} from "./validation.js";
import type { Schema, WorkflowDocument } from "./model.js";
export interface Component {
  identity: Json;
  inputSchema: Schema;
  outputSchema: Schema;
  readOnly: boolean;
  run(scope: Scope, input: Json): Promise<Json>;
}
export interface ExecutionOptions {
  bindings?: Record<string, ProfileBinding>;
  components?: Record<string, Component>;
  profileOverride?: ProfileIntent;
}
export function bindingsFromAgents(
  agents: Record<string, AgentConfig>,
): Record<string, ProfileBinding> {
  return Object.fromEntries(
    Object.entries(agents).map(([name, agent]) => [
      name,
      {
        agent,
        capabilities: {
          revision: `${agent.harness.name}:legacy-v1`,
          modes: [agent.mode ?? "read-only"],
          strictTools: false,
          nativeSystem: false,
          fresh: true,
        },
      },
    ]),
  );
}
interface Prepared {
  document: WorkflowDocument;
  identity: string;
  profiles: Map<string, ResolvedProfile>;
  components: Record<string, Component>;
}
export function prepareExecution(
  raw: WorkflowDocument,
  options: ExecutionOptions = {},
): Prepared {
  const { document, identity } = validateDocument(raw),
    profiles = new Map<string, ResolvedProfile>(),
    components: Record<string, Component> = {};
  for (const [name, w] of Object.entries(document.workflows))
    for (const n of w.nodes) {
      if (n.kind === "agent")
        profiles.set(
          `${name}/${n.id}`,
          resolveProfile({
            profiles: document.profiles ?? {},
            bindings: options.bindings ?? {},
            defaultProfile: w.defaultProfile,
            nodeProfile: n.profile,
            override: options.profileOverride,
          }),
        );
      if (n.kind === "custom") {
        const c = options.components?.[n.component];
        if (
          !c ||
          typeof c.run !== "function" ||
          typeof c.readOnly !== "boolean"
        )
          throw new Error(`Missing trusted component ${n.component}`);
        if (
          canonical(c.inputSchema) !== canonical(n.inputSchema) ||
          canonical(c.outputSchema) !== canonical(n.outputSchema)
        )
          throw new Error(`Component schema differs: ${n.component}`);
        components[n.component] = Object.freeze({
          ...c,
          identity: json(c.identity),
          inputSchema: json(c.inputSchema) as Schema,
          outputSchema: json(c.outputSchema) as Schema,
        });
      }
    }
  const readOnly = (name: string): boolean =>
    document.workflows[name]!.nodes.every((n) =>
      n.kind === "command"
        ? false
        : n.kind === "agent"
          ? profiles.get(`${name}/${n.id}`)!.agentConfig.mode === "read-only"
          : n.kind === "custom"
            ? components[n.component]!.readOnly
            : n.kind === "workflow" || n.kind === "repeat"
              ? readOnly(n.workflow)
              : n.kind === "parallel"
                ? n.branches.every((b) => readOnly(b.workflow))
                : true,
    );
  for (const w of Object.values(document.workflows))
    for (const n of w.nodes)
      if (
        n.kind === "parallel" &&
        !n.branches.every((b) => readOnly(b.workflow))
      )
        throw new Error(
          "Parallel effects require workspace isolation; only read-only children are supported",
        );
  return {
    document,
    profiles,
    components,
    identity: hash({
      document: identity,
      profiles: Object.fromEntries(
        [...profiles].map(([name, p]) => [name, p.identity]),
      ),
      components: Object.fromEntries(
        Object.entries(components).map(([name, c]) => [name, c.identity]),
      ),
    }),
  };
}
/** Called inside Runtime.run; all side effects use its existing durable seam. */
export async function executeDocument(
  runtime: Runtime,
  raw: WorkflowDocument,
  input: Json,
  options: ExecutionOptions = {},
): Promise<WorkflowResult<Json>> {
  const prepared = prepareExecution(raw, options),
    document = prepared.document;
  const definition = (name: string): WorkflowDefinition<Json, Json> => {
    const w = document.workflows[name]!;
    return {
      name,
      version: w.version,
      identity: hash({ closure: prepared.identity, name }),
      inputSchema: w.inputSchema,
      outputSchema: w.outputSchema,
      document: JSON.parse(encode(document, 1024 * 1024)) as Json,
      run: async (scope, selected): Promise<WorkflowValue<Json>> => {
        const outputs: Record<string, Json> = Object.create(null) as Record<
          string,
          Json
        >;
        const nodes = new Map(w.nodes.map((n) => [n.id, n]));
        let current = w.start;
        for (let count = 0; count < w.nodes.length; count++) {
          scope.signal.throwIfAborted();
          const n = nodes.get(current)!;
          const value = (v: Json): Json => resolveValue(v, selected, outputs);
          if (n.kind === "agent") {
            const p = prepared.profiles.get(`${name}/${n.id}`)!;
            const outcome = await scope.agent<Json>(n.id, p.agentConfig, {
              prompt: n.prompt,
              context: n.context === undefined ? undefined : value(n.context),
              schema: n.outputSchema,
              corrections: n.corrections,
            });
            assertValue(n.outputSchema, outcome.value, `${name}/${n.id}`);
            outputs[n.id] = json(outcome.value);
          } else if (n.kind === "command") {
            const result = await scope.command(n.id, n.argv, {
              timeoutMs: n.timeoutMs,
            });
            if (result.cancelled) throw new Error(`Command cancelled: ${n.id}`);
            outputs[n.id] = json(result);
          } else if (n.kind === "workflow") {
            const child = await scope.workflow(
              n.id,
              definition(n.workflow),
              value(n.input),
              {
                attempt: n.attempt,
                maxDispatches: n.maxDispatches,
                timeoutMs: n.timeoutMs,
              },
            );
            outputs[n.id] = json(child.value);
          } else if (n.kind === "custom") {
            const c = prepared.components[n.component]!,
              selectedInput = value(n.input);
            assertValue(c.inputSchema, selectedInput, `${n.id} input`);
            const result = await scope.local(
              n.id,
              { component: c.identity, input: selectedInput },
              () => c.run(scope.scope(n.id), selectedInput),
            );
            assertValue(c.outputSchema, result, `${n.id} output`);
            outputs[n.id] = result;
          } else if (n.kind === "branch") {
            const decision = evaluatePredicate(n.predicate, selected, outputs);
            const route = await scope.local(
              n.id,
              { predicate: json(n.predicate), selected: json(outputs) },
              () => ({ next: decision ? n.then : n.else }),
            );
            if (route.next !== (decision ? n.then : n.else))
              throw new Error("Cached branch differs from bound predicate");
            current = String(route.next);
            continue;
          } else if (n.kind === "end") {
            const output = value(n.output),
              passed = n.passed === undefined ? true : value(n.passed);
            if (typeof passed !== "boolean")
              throw new Error("End verdict must be boolean");
            const result = await scope.local(n.id, { output, passed }, () => ({
              value: output,
              passed,
            }));
            assertValue(w.outputSchema, result.value, `${name} output`);
            return { value: result.value, passed: result.passed as boolean };
          } else if (n.kind === "repeat") {
            let output: Json = null,
              done = false,
              iterations = 0;
            for (let i = 1; i <= n.maxIterations; i++) {
              scope.signal.throwIfAborted();
              const child = await scope
                .scope(n.id)
                .workflow(
                  `iteration-${i}`,
                  definition(n.workflow),
                  value(n.input),
                );
              output = child.value;
              iterations = i;
              if (evaluatePredicate(n.until, selected, outputs, output)) {
                done = true;
                break;
              }
            }
            outputs[n.id] = await scope.local(
              n.id,
              { iterations, value: output, passed: done },
              () => ({ iterations, value: output, passed: done }),
            );
          } else if (n.kind === "parallel") {
            const completed = await scope
              .scope(n.id)
              .parallel(
                n.branches.map(
                  (b) => (childScope) =>
                    childScope.workflow(
                      b.id,
                      definition(b.workflow),
                      value(b.input),
                    ),
                ),
              );
            const passed =
              n.join === "all"
                ? completed.every((r) => r.passed)
                : completed.some((r) => r.passed);
            outputs[n.id] = await scope.local(
              n.id,
              {
                join: n.join,
                children: completed.map((r) => r.provenance.invocationId),
              },
              () => ({ values: completed.map((r) => r.value), passed }),
            );
          }
          current = n.next;
        }
        throw new Error("Workflow did not terminate");
      },
    };
  };
  return runtime.workflow("workflow", definition(document.root), json(input));
}
