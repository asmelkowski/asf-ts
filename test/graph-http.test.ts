import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { serve } from "../src/http.js";
import { recordedGraph } from "./graph-fixtures.js";
import type { GraphInspection } from "../src/portable/inspection-types.js";

test("declared graph routes preserve GET guards, exact focused paging and no mutation", async () => {
  const f = await recordedGraph(),
    server = await serve(f.store),
    address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`,
    before = f.store.inspect("run").totals;
  try {
    for (const [route, file] of [
      ["/graph", "graph.html"],
      ["/graph.js", "graph.js"],
      ["/graph.css", "graph.css"],
    ]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200);
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        readFileSync(`src/web/${file}`),
      );
    }
    const response = await fetch(base + "/workflow-inspect?run=run&limit=1");
    assert.equal(response.status, 200);
    const dto = (await response.json()) as GraphInspection;
    assert.equal(dto.graphs.length, 1);
    const root = f.store
      .workflowInspect("run")
      .workflows.find((w) => w.binding.parentInvocation === null)!;
    const focus = await fetch(
      base +
        `/workflow-inspect?run=run&offset=1&limit=1&invocation=${encodeURIComponent(root.id)}`,
    );
    const focused = (await focus.json()) as GraphInspection;
    assert.equal(focused.focusedGraph!.invocationId, root.id);
    assert.equal(focused.focusedGraph!.businessPassed, false);
    assert.equal(
      (await fetch(base + "/workflow-inspect?run=run&limit=201")).status,
      400,
    );
    assert.equal((await fetch(base + "/workflow-inspect")).status, 400);
    assert.equal(
      (await fetch(base + "/workflow-inspect?run=run", { method: "POST" }))
        .status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/workflow-inspect?run=run", {
          headers: { Origin: base },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/graph", {
          headers: { "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
      403,
    );
    const foreign = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        base + "/workflow-inspect?run=run",
        { headers: { Host: "other.example:80" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(foreign, 403);
    assert.deepEqual(f.store.inspect("run").totals, before);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    f.close();
  }
});
