import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { serve } from "../src/http.js";
import { parseDocument, validateDocument } from "../src/portable/validation.js";
import { fixture } from "./helpers.js";

const document = {
  format: "asf-ts-workflow/v1",
  root: "main",
  workflows: {
    main: {
      version: "1",
      inputSchema: {},
      outputSchema: {},
      start: "end",
      nodes: [
        { id: "end", kind: "end", output: { $ref: "#/input" }, passed: true },
      ],
    },
  },
};

async function serverFixture() {
  const f = fixture(),
    server = await serve(f.store);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    ...f,
    server,
    base: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
      f.close();
    },
  };
}

test("studio source validation shares strict YAML/JSON contracts and writes no run data", async () => {
  const f = await serverFixture();
  try {
    for (const route of ["/studio", "/studio.js", "/studio.css"]) {
      const response = await fetch(f.base + route);
      assert.equal(response.status, 200);
      assert.match(
        response.headers.get("content-security-policy")!,
        /default-src 'none'/,
      );
    }
    const response = await fetch(f.base + "/studio/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: f.base },
      body: JSON.stringify({ source: JSON.stringify(document) }),
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      document: unknown;
      identity: string;
      yaml: string;
      catalogue: { kind: string }[];
    };
    assert.equal(result.identity, validateDocument(document).identity);
    assert.equal(
      validateDocument(parseDocument(result.yaml)).identity,
      result.identity,
    );
    assert.ok(result.catalogue.some((node) => node.kind === "parallel"));
    assert.deepEqual(f.store.runs(), []);
    assert.equal(
      f.store.db.prepare("SELECT count(*) AS n FROM events").get()!.n,
      0,
    );
  } finally {
    await f.stop();
  }
});

test("studio alone allows same-origin JSON POSTs; server paths and execution routes are absent", async () => {
  const f = await serverFixture();
  try {
    const body = JSON.stringify({ source: JSON.stringify(document) });
    const rejectedHeaders: Record<string, string>[] = [
      { Origin: "https://other.example", "Content-Type": "application/json" },
      { "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" },
    ];
    for (const headers of rejectedHeaders)
      assert.equal(
        (
          await fetch(f.base + "/studio/validate", {
            method: "POST",
            headers,
            body,
          })
        ).status,
        403,
      );
    const foreignHost = await new Promise<number | undefined>(
      (resolve, reject) => {
        const req = request(
          f.base + "/studio/validate",
          {
            method: "POST",
            headers: {
              Host: "other.example:80",
              "Content-Type": "application/json",
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on("error", reject);
        req.end(body);
      },
    );
    assert.equal(foreignHost, 403);
    assert.equal(
      (await fetch(f.base + "/studio/validate", { method: "POST", body }))
        .status,
      415,
    );
    assert.equal(
      (
        await fetch(f.base + "/inspect?run=run", {
          headers: { Origin: f.base },
        })
      ).status,
      403,
    );
    for (const route of [
      "/studio/compile",
      "/studio/generate",
      "/studio/run",
      "/studio/resume",
      "/studio/retry",
      "/studio/file",
      "/studio/bundle",
      "/studio/render",
    ]) {
      assert.equal((await fetch(f.base + route)).status, 404);
      assert.equal(
        (await fetch(f.base + route, { method: "POST", body })).status,
        403,
      );
    }
    for (const payload of [
      { filepath: "/tmp/workflow.yaml" },
      { source: JSON.stringify(document), filepath: "/tmp/workflow.yaml" },
      { source: 42 },
    ])
      assert.equal(
        (
          await fetch(f.base + "/studio/validate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        ).status,
        400,
      );
  } finally {
    await f.stop();
  }
});

test("studio request bounds and malformed draft errors fail without changing inspection", async () => {
  const f = await serverFixture();
  try {
    for (const source of [
      "{invalid",
      "a: 1\na: 2",
      "a: &alias {}\nb: *alias",
      JSON.stringify({ ...document, credentials: "secret" }),
    ]) {
      const response = await fetch(f.base + "/studio/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
      assert.equal(response.status, 400);
      assert.equal(
        typeof ((await response.json()) as { error: unknown }).error,
        "string",
      );
    }
    const response = await fetch(f.base + "/studio/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "x".repeat(1024 * 1024) }),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await (await fetch(f.base + "/runs")).json(), []);
  } finally {
    await f.stop();
  }
});
