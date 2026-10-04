import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";

import { Store } from "./store.js";
import { errorText } from "./util.js";
import { buildGraphInspection } from "./portable/inspection.js";
import {
  emptyPersonaCatalogue,
  parsePersonaCatalogue,
  type PersonaCatalogue,
} from "./persona-catalogue.js";

const STUDIO_BODY_LIMIT = 1024 * 1024;

async function studioJson(
  req: IncomingMessage,
  res: ServerResponse,
  project: (payload: unknown) => unknown | Promise<unknown>,
): Promise<void> {
  if (
    req.headers["content-type"]?.split(";", 1)[0]?.toLowerCase() !==
    "application/json"
  ) {
    res.writeHead(415).end("Studio requires application/json");
    return;
  }
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0,
        settled = false;
      req.on("data", (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > STUDIO_BODY_LIMIT) {
          settled = true;
          reject(new Error("Studio request exceeds 1 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      req.once("end", () => {
        if (!settled) {
          settled = true;
          resolve(Buffer.concat(chunks).toString("utf8"));
        }
      });
      req.once("error", reject);
      req.once("aborted", () => reject(new Error("Studio request aborted")));
    });
    const payload: unknown = JSON.parse(body);
    const result = await project(payload);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  } catch (error) {
    res.setHeader("Content-Type", "application/json");
    res
      .writeHead(errorText(error).includes("exceeds 1 MiB") ? 413 : 400)
      .end(JSON.stringify({ error: errorText(error) }));
  }
}

async function validateStudio(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await studioJson(req, res, async (payload) => {
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.keys(payload).length !== 1 ||
      !("source" in payload) ||
      typeof payload.source !== "string"
    )
      throw new Error("Studio validation requires only a source string");
    const { parseDocument, validateDocument, serializeDocument } =
      await import("./portable/validation.js");
    const { NODE_CATALOGUE } = await import("./portable/model.js");
    const result = validateDocument(parseDocument(payload.source));
    return {
      ...result,
      catalogue: NODE_CATALOGUE,
      yaml: serializeDocument(result.document, "yaml"),
    };
  });
}
export interface ServeOptions {
  personaCatalogue?: PersonaCatalogue;
}
/** Local inspection and data authoring; clients never drain provider streams. */
export async function serve(
  store: Store,
  port = 0,
  options: ServeOptions = {},
): Promise<Server> {
  // Snapshot parsed data. Later caller mutation cannot change a running server's catalogue.
  const personaCatalogue = parsePersonaCatalogue(
    options.personaCatalogue ?? emptyPersonaCatalogue(),
  );
  // Explicit allowlist, resolved relative to this module for source and dist.
  const assets = new Map(
    [
      ["/", "index.html", "text/html; charset=utf-8"],
      ["/flow-model.js", "flow-model.js", "text/javascript; charset=utf-8"],
      ["/ui.js", "ui.js", "text/javascript; charset=utf-8"],
      ["/ui.css", "ui.css", "text/css; charset=utf-8"],
      ["/studio", "studio.html", "text/html; charset=utf-8"],
      ["/studio.js", "studio.js", "text/javascript; charset=utf-8"],
      [
        "/persona-editor.js",
        "persona-editor.js",
        "text/javascript; charset=utf-8",
      ],
      ["/studio.css", "studio.css", "text/css; charset=utf-8"],
      ["/graph", "graph.html", "text/html; charset=utf-8"],
      ["/graph.js", "graph.js", "text/javascript; charset=utf-8"],
      ["/graph.css", "graph.css", "text/css; charset=utf-8"],
    ].map(([route, file, type]) => [
      route,
      {
        body: readFileSync(new URL(`./web/${file}`, import.meta.url)),
        type: type!,
      },
    ]),
  );
  const server = createServer((req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    // No CORS, remote bind, or run writes; deny browser cross-origin fetches.
    const host = req.headers.host ?? "";
    const route = (req.url ?? "/").split("?", 1)[0];
    const studioPost =
      req.method === "POST" &&
      ["/studio/validate", "/studio/persona-catalogue"].includes(route!);
    if (
      (req.method !== "GET" && !studioPost) ||
      (req.headers.origin &&
        (!studioPost || req.headers.origin !== `http://${host}`)) ||
      !/^(127\.0\.0\.1|localhost):[0-9]+$/.test(host) ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      res.writeHead(403).end();
      return;
    }
    if (studioPost) {
      if (route === "/studio/validate") void validateStudio(req, res);
      else void studioJson(req, res, parsePersonaCatalogue);
      return;
    }
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/studio/persona-catalogue") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(personaCatalogue));
        return;
      }
      const asset = assets.get(url.pathname);
      if (asset) {
        res.setHeader("Content-Type", asset.type);
        res.end(asset.body);
        return;
      }
      if (url.pathname === "/runs") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            store.runs(
              Number(url.searchParams.get("offset") ?? 0),
              Number(url.searchParams.get("limit") ?? 100),
            ),
          ),
        );
        return;
      }
      if (
        !["/inspect", "/events", "/workflow-inspect"].includes(url.pathname)
      ) {
        res.writeHead(404).end();
        return;
      }
      const run = url.searchParams.get("run");
      if (!run || run.length > 200) {
        res.writeHead(400).end("run required");
        return;
      }
      if (url.pathname === "/workflow-inspect") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            buildGraphInspection(store, run, {
              offset: Number(url.searchParams.get("offset") ?? 0),
              limit: Number(url.searchParams.get("limit") ?? 20),
              invocationId: url.searchParams.get("invocation") ?? undefined,
            }),
          ),
        );
        return;
      }
      if (url.pathname === "/inspect") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            store.inspect(
              run,
              Number(url.searchParams.get("offset") ?? 0),
              Number(url.searchParams.get("limit") ?? 100),
            ),
          ),
        );
        return;
      }
      if (url.pathname !== "/events") {
        res.writeHead(404).end();
        return;
      }
      let cursor = Number(
        req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0,
      );
      let rows = store.events(
        run,
        cursor,
        Math.min(100, Number(url.searchParams.get("limit") ?? 100)),
      );
      if (url.searchParams.get("stream") !== "1") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(rows));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
      });
      res.flushHeaders();
      let busy = false;
      let stalledAt = 0;
      const timer = setInterval(() => {
        if (busy) {
          if (Date.now() - stalledAt > 2000) res.destroy();
          return;
        }
        try {
          rows = store.events(run, cursor, 100);
          for (const row of rows) {
            cursor = row.cursor;
            if (
              !res.write(`id: ${row.cursor}\ndata: ${JSON.stringify(row)}\n\n`)
            ) {
              busy = true;
              stalledAt = Date.now();
              break;
            }
          }
        } catch {
          res.destroy();
        }
      }, 50);
      res.on("drain", () => {
        busy = false;
      });
      res.on("close", () => clearInterval(timer));
    } catch (e) {
      res.writeHead(400).end(errorText(e));
    }
  });
  server.maxConnections = 32;
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}
