#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "./store.js";
import { Runtime } from "./runtime.js";
import { serve } from "./http.js";
import type { AgentFileConfig } from "./config.js";
import type { AgentConfig, Json } from "./types.js";
import { errorText, hash, sleep } from "./util.js";
import { FILE_COMMANDS, fileCommand } from "./portable/cli.js";
import {
  loadClaudeMarketplace,
  loadPersonaCatalogue,
} from "./persona-catalogue.js";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string", default: ".asf/store.db" },
    run: { type: "string" },
    workflow: { type: "string" },
    file: { type: "string" },
    source: { type: "string" },
    revision: { type: "string" },
    "persona-catalog": { type: "string" },
    output: { type: "string" },
    registration: { type: "string" },
    targets: { type: "string" },
    "runtime-import": { type: "string" },
    budget: { type: "string" },
    "max-dispatches": { type: "string" },
    "soft-usd": { type: "string" },
    config: { type: "string" },
    input: { type: "string", default: "null" },
    cwd: { type: "string", default: process.cwd() },
    live: { type: "boolean", default: false },
    "trace-content": { type: "boolean", default: false },
    offset: { type: "string", default: "0" },
    after: { type: "string", default: "0" },
    limit: { type: "string", default: "100" },
    follow: { type: "boolean" },
    port: { type: "string", default: "0" },
    help: { type: "boolean" },
  },
});
const verb = positionals[0];
if (values.help || !verb) {
  console.log(
    `ASF v0.1 (Node 22, Linux)\n  run|resume --run ID --workflow FILE [--config FILE] [--input JSON] [--cwd DIR] [--live] [--trace-content]\n  inspect --run ID [--offset 0] [--limit 100]\n  events --run ID [--after CURSOR] [--limit 100] [--follow]\n  serve [--port 0] [--persona-catalog JSON_FILE]\n  import-marketplace (--file JSON_FILE | --source PINNED_RAW_GITHUB_URL) --revision 40SHA --output NEW_JSON_FILE\n  validate|render|bundle|compile --file YAML_OR_JSON [--output FILE] [--registration TRUSTED_MODULE] [--targets TRUSTED_MODULE]\n  verify-bundle --file BUNDLE\n  run-file|resume-file --file YAML_OR_JSON --run ID [--config FILE] [--input JSON] [--registration TRUSTED_MODULE] [--targets TRUSTED_MODULE]\nAll accept --db PATH. Live model use requires --live. Workflow modules are trusted executable code.\nContent and results are sensitive/untrusted; local HTTP offers inspection and data validation, not execution or authentication. Marketplace import reads metadata only and does not install plugins.`,
  );
} else if (verb === "import-marketplace") {
  try {
    if (!values.revision || !values.output)
      throw new Error("Marketplace import requires --revision and --output");
    const catalogue = await loadClaudeMarketplace({
      file: values.file,
      source: values.source,
      revision: values.revision,
    });
    writeFileSync(
      resolve(values.output),
      JSON.stringify(catalogue, null, 2) + "\n",
      { flag: "wx" },
    );
    console.log(
      JSON.stringify({
        output: resolve(values.output),
        plugins: catalogue.plugins.length,
        unpinned: catalogue.plugins.filter((plugin) => !plugin.revision).length,
      }),
    );
  } catch (error) {
    console.error(errorText(error));
    process.exitCode = 1;
  }
} else if (FILE_COMMANDS.includes(verb)) {
  try {
    await fileCommand(verb, values);
  } catch (e) {
    console.error(errorText(e));
    process.exitCode = 1;
  }
} else {
  const readonly = ["inspect", "events", "serve"].includes(verb);
  if (verb === "serve" && !existsSync(resolve(values.db)))
    new Store(resolve(values.db)).close();
  const store = new Store(resolve(values.db), readonly);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    if (verb === "serve") {
      const server = await serve(store, Number(values.port), {
        ...(values["persona-catalog"]
          ? {
              personaCatalogue: loadPersonaCatalogue(
                resolve(values["persona-catalog"]),
              ),
            }
          : {}),
      });
      const address = server.address();
      if (address && typeof address !== "string")
        console.log(`Read-only local UI: http://127.0.0.1:${address.port}/`);
      await new Promise<void>((r) =>
        controller.signal.addEventListener(
          "abort",
          () => {
            server.closeAllConnections();
            server.close(() => r());
          },
          { once: true },
        ),
      );
    } else {
      if (!values.run) throw new Error("--run is required");
      if (verb === "inspect")
        console.log(
          JSON.stringify(
            store.inspect(
              values.run,
              Number(values.offset),
              Number(values.limit),
            ),
            null,
            2,
          ),
        );
      else if (verb === "events") {
        let cursor = Number(values.after);
        do {
          const rows = store.events(values.run, cursor, Number(values.limit));
          for (const row of rows) {
            console.log(JSON.stringify(row));
            cursor = row.cursor;
          }
          if (values.follow) await sleep(100);
        } while (values.follow && !controller.signal.aborted);
      } else if (verb === "run" || verb === "resume") {
        if (!values.workflow)
          throw new Error("--workflow required (also on resume)");
        const path = resolve(values.workflow);
        const config = values.config
          ? (JSON.parse(readFileSync(values.config, "utf8")) as Record<
              string,
              AgentFileConfig
            >)
          : {};
        const input = JSON.parse(values.input) as Json;
        // Read-only inspection/serve never needs to import provider adapters.
        const { agentsFromConfig } = await import("./config.js");
        const agents = agentsFromConfig(
          config,
          resolve(values.db, "..", "native", values.run),
        );
        const module = (await import(pathToFileURL(path).href)) as {
          workflow: (
            r: Runtime,
            input: Json,
            agents: Record<string, AgentConfig>,
          ) => Promise<unknown>;
        };
        if (typeof module.workflow !== "function")
          throw new Error("Module must export workflow");
        const runtime = new Runtime({
          store,
          runId: values.run,
          workflowIdentity: hash({
            path,
            source: readFileSync(path, "utf8"),
            config,
            input,
            cwd: resolve(values.cwd),
          }),
          cwd: values.cwd,
          live: values.live,
          traceContent: values["trace-content"],
          signal: controller.signal,
        });
        console.log(
          JSON.stringify(
            await runtime.run((r) => module.workflow(r, input, agents)),
            null,
            2,
          ),
        );
      } else throw new Error("Unknown command");
    }
  } catch (e) {
    console.error(errorText(e));
    process.exitCode = 1;
  } finally {
    store.close();
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
