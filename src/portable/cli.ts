import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Runtime } from "../runtime.js";
import { Store } from "../store.js";
import { errorText, json, hash } from "../util.js";
import type { AgentFileConfig } from "../config.js";
import {
  bindingsFromAgents,
  executeDocument,
  prepareExecution,
} from "./execute.js";
import {
  bundleDocument,
  compileDocument,
  loadDocument,
  loadRegistration,
  loadTargetBindings,
  renderDocument,
  supportReport,
  verifyBundle,
  writeArtifact,
} from "./files.js";
interface FileValues {
  file?: string;
  output?: string;
  registration?: string;
  targets?: string;
  "runtime-import"?: string;
  config?: string;
  input: string;
  run?: string;
  cwd: string;
  db: string;
  live: boolean;
  "trace-content": boolean;
  budget?: string;
  "max-dispatches"?: string;
  "soft-usd"?: string;
}
export const FILE_COMMANDS = [
  "validate",
  "compile",
  "render",
  "bundle",
  "verify-bundle",
  "run-file",
  "resume-file",
];
export async function fileCommand(
  verb: string,
  values: FileValues,
): Promise<void> {
  if (!values.file) throw new Error("--file required");
  const v =
    verb === "verify-bundle"
      ? verifyBundle(readFileSync(values.file, "utf8"))
      : loadDocument(values.file);
  if (verb === "validate" || verb === "verify-bundle") {
    console.log(
      JSON.stringify(
        {
          identity: v.identity,
          warnings: v.warnings,
          support: supportReport(v.document),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (["compile", "render", "bundle"].includes(verb)) {
    if (!values.output)
      throw new Error(
        "--output required; artifacts never overwrite existing files",
      );
    const contents =
      verb === "compile"
        ? compileDocument(v.document, {
            registration: values.registration,
            targets: values.targets,
            runtimeImport: values["runtime-import"],
          })
        : verb === "render"
          ? renderDocument(v.document)
          : bundleDocument(v.document);
    writeArtifact(values.output, contents);
    console.log(
      JSON.stringify({ output: resolve(values.output), identity: v.identity }),
    );
    return;
  }
  if (!values.run) throw new Error("--run required");
  const input = json(JSON.parse(values.input));
  const components = values.registration
    ? await loadRegistration(values.registration)
    : {};
  const config = values.config
    ? (JSON.parse(readFileSync(values.config, "utf8")) as Record<
        string,
        AgentFileConfig
      >)
    : {};
  // Provider modules load only for explicit execution; validation/compiler/render do not import them.
  const agents = Object.keys(config).length
    ? (await import("../config.js")).agentsFromConfig(
        config,
        resolve(values.db, "..", "native", values.run),
      )
    : {};
  const bindings = values.targets
      ? await loadTargetBindings(values.targets)
      : bindingsFromAgents(agents),
    prepared = prepareExecution(v.document, { bindings, components });
  const store = new Store(resolve(values.db)),
    controller = new AbortController(),
    abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const hasBudget =
      values.budget || values["max-dispatches"] || values["soft-usd"];
    if (
      hasBudget &&
      (!values.budget || !values["max-dispatches"] || !values["soft-usd"])
    )
      throw new Error(
        "Budget requires --budget, --max-dispatches and --soft-usd",
      );
    const budget = hasBudget
      ? {
          id: values.budget!,
          maxDispatches: Number(values["max-dispatches"]),
          softUsd: Number(values["soft-usd"]),
        }
      : undefined;
    const runtime = new Runtime({
      store,
      runId: values.run,
      workflowIdentity: hash({
        portable: prepared.identity,
        input,
        cwd: resolve(values.cwd),
      }),
      cwd: values.cwd,
      live: values.live,
      traceContent: values["trace-content"],
      signal: controller.signal,
      budget,
    });
    console.log(
      JSON.stringify(
        await runtime.run((r) =>
          executeDocument(r, v.document, input, { bindings, components }),
        ),
        null,
        2,
      ),
    );
  } catch (e) {
    throw new Error(errorText(e));
  } finally {
    await Promise.allSettled(
      [
        ...new Set([
          ...Object.values(agents).map((a) => a.harness),
          ...Object.values(bindings).map((b) => b.agent.harness),
        ]),
      ].map((h) => h.close?.()),
    );
    store.close();
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
