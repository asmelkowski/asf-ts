import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { serve } from "../src/http.js";
import {
  emptyPersonaCatalogue,
  type PersonaCatalogue,
} from "../src/persona-catalogue.js";
import { fixture } from "./helpers.js";

async function setup(personaCatalogue?: PersonaCatalogue) {
  const f = fixture(),
    server = await serve(f.store, 0, { personaCatalogue });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    ...f,
    base,
    stop: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
      f.close();
    },
  };
}
test("catalogue GET snapshots local discovery data; POST validates without replacing or writing it", async () => {
  const catalogue = { ...emptyPersonaCatalogue(), models: ["local-model"] };
  const f = await setup(catalogue);
  try {
    catalogue.models.push("late-mutation");
    assert.deepEqual(
      await (await fetch(f.base + "/studio/persona-catalogue")).json(),
      { ...emptyPersonaCatalogue(), models: ["local-model"] },
    );
    const uploaded = {
      ...emptyPersonaCatalogue(),
      tools: ["read"],
      plugins: [
        {
          id: "synthetic/reviewer",
          name: "Reviewer",
          revision: "a".repeat(40),
        },
      ],
    };
    const response = await fetch(f.base + "/studio/persona-catalogue", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: f.base },
      body: JSON.stringify(uploaded),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), uploaded);
    assert.deepEqual(
      await (await fetch(f.base + "/studio/persona-catalogue")).json(),
      { ...emptyPersonaCatalogue(), models: ["local-model"] },
    );
    assert.deepEqual(f.store.runs(), []);
    assert.equal(
      f.store.db.prepare("SELECT count(*) AS n FROM events").get()!.n,
      0,
    );
  } finally {
    await f.stop();
  }
});
test("catalogue data endpoint keeps loopback, same-origin, MIME and request bounds", async () => {
  const f = await setup();
  try {
    assert.deepEqual(
      await (await fetch(f.base + "/studio/persona-catalogue")).json(),
      emptyPersonaCatalogue(),
    );
    const denied: Record<string, string>[] = [
      { Origin: "https://other.example" },
      { "Sec-Fetch-Site": "cross-site" },
    ];
    for (const headers of denied) {
      const response = await fetch(f.base + "/studio/persona-catalogue", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(emptyPersonaCatalogue()),
      });
      assert.equal(response.status, 403);
    }
    const foreignHost = await new Promise<number | undefined>(
      (resolve, reject) => {
        const req = request(
          f.base + "/studio/persona-catalogue",
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
        req.end(JSON.stringify(emptyPersonaCatalogue()));
      },
    );
    assert.equal(foreignHost, 403);
    assert.equal(
      (
        await fetch(f.base + "/studio/persona-catalogue", {
          method: "POST",
          body: "{}",
        })
      ).status,
      415,
    );
    for (const payload of [
      { source: "https://example.com/plugins" },
      { path: "/tmp/plugins.json" },
      { ...emptyPersonaCatalogue(), installed: true },
    ]) {
      assert.equal(
        (
          await fetch(f.base + "/studio/persona-catalogue", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        ).status,
        400,
      );
    }
    assert.equal(
      (
        await fetch(f.base + "/studio/persona-catalogue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: "x".repeat(1024 * 1024) }),
        })
      ).status,
      413,
    );
    assert.equal(
      (await fetch(f.base + "/runs", { method: "POST", body: "{}" })).status,
      403,
    );
    assert.deepEqual(await (await fetch(f.base + "/runs")).json(), []);
  } finally {
    await f.stop();
  }
});
