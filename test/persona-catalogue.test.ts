import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  emptyPersonaCatalogue,
  importClaudeMarketplace,
  loadClaudeMarketplace,
  loadPersonaCatalogue,
  parsePersonaCatalogue,
  PERSONA_CATALOGUE_LIMIT,
} from "../src/persona-catalogue.js";
import { parsePluginReferences } from "../src/profiles.js";

const pin = "a".repeat(40),
  externalPin = "b".repeat(40);
const source = `https://raw.githubusercontent.com/example/plugins/${pin}/.claude-plugin/marketplace.json`;
const marketplace = () => ({
  name: "review-tools",
  owner: { name: "Synthetic owner" },
  plugins: [
    {
      name: "local",
      source: "./plugins/local",
      version: "1.0.0",
      hooks: { SessionStart: "never execute" },
    },
    {
      name: "remote",
      source: {
        source: "github",
        repo: "example/remote",
        sha: externalPin,
        ref: "mutable",
      },
    },
    {
      name: "branch",
      source: {
        source: "git-subdir",
        url: "https://github.com/example/branch",
        path: "plugins/branch",
        ref: "main",
      },
      version: "2.0.0",
    },
    { name: "npm", source: { source: "npm", package: "unfetched@1.0.0" } },
    {
      name: "command",
      source: { source: "command", command: "never execute" },
    },
  ],
});

test("catalogue validates bounded discovery data independently of loaded bindings", () => {
  const input = {
    ...emptyPersonaCatalogue(),
    models: ["local-model"],
    tools: ["read"],
    plugins: [
      {
        id: "market/constructor",
        name: "Constructor",
        revision: pin,
        source: "https://example.com/plugin",
      },
      { id: "market/unpinned", name: "Unpinned" },
    ],
  };
  const parsed = parsePersonaCatalogue(input);
  input.models.push("mutated");
  input.plugins[0]!.name = "Changed";
  assert.deepEqual(parsed.models, ["local-model"]);
  assert.equal(parsed.plugins[0]!.name, "Constructor");
  assert.equal(parsed.plugins[1]!.revision, undefined);
  for (const invalid of [
    { ...input, installed: true },
    { ...input, tools: ["read", "read"] },
    {
      ...input,
      plugins: [{ id: "Market/Plugin", name: "Plugin", revision: pin }],
    },
    { ...input, plugins: [input.plugins[0], input.plugins[0]] },
    {
      ...input,
      plugins: [{ id: "market/plugin", name: "Plugin", revision: "1.0.0" }],
    },
    {
      ...input,
      plugins: [{ id: "market/plugin", name: "Plugin", revision: pin + "\n" }],
    },
    {
      ...input,
      plugins: [{ id: "market/plugin", name: "Plugin", loaded: true }],
    },
    {
      ...input,
      plugins: [
        {
          id: "market/plugin",
          name: "Plugin",
          source: "https://user:secret@example.com/plugin",
        },
      ],
    },
    { ...input, models: Array.from({ length: 513 }, (_, i) => `model${i}`) },
    {
      ...input,
      plugins: [
        { id: "market/plugin", name: "x".repeat(PERSONA_CATALOGUE_LIMIT) },
      ],
    },
  ])
    assert.throws(() => parsePersonaCatalogue(invalid));
});

test("canonical URL expansion and normalized whole-catalogue size obey the same reload bounds", () => {
  const catalogue = (sources: string[]) => ({
    ...emptyPersonaCatalogue(),
    plugins: sources.map((source, i) => ({
      id: `market/plugin${i}`,
      name: "Plugin",
      source,
    })),
  });
  assert.throws(
    () =>
      parsePersonaCatalogue(
        catalogue(["https://example.com/" + "é".repeat(1000)]),
      ),
    /Catalogue source/,
  );
  const normalized = parsePersonaCatalogue(
    catalogue(["https://example.com/" + "é".repeat(100)]),
  );
  assert.ok(Buffer.byteLength(normalized.plugins[0]!.source!) <= 2048);
  assert.deepEqual(parsePersonaCatalogue(normalized), normalized);
  const many = catalogue(
    Array.from({ length: 512 }, () => "https://example.com/" + "é".repeat(333)),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(many)) < PERSONA_CATALOGUE_LIMIT);
  assert.throws(() => parsePersonaCatalogue(many), /exceeds 1 MiB/);
});

test("Claude projection retains exact pins but never imports components or treats versions as pins", () => {
  const parsed = importClaudeMarketplace(marketplace(), {
    revision: pin,
    source,
  });
  assert.deepEqual(parsed.marketplace, {
    name: "review-tools",
    revision: pin,
    source,
  });
  assert.deepEqual(
    parsed.plugins.map((p) => [p.id, p.revision]),
    [
      ["review-tools/local", pin],
      ["review-tools/remote", externalPin],
      ["review-tools/branch", undefined],
      ["review-tools/npm", undefined],
      ["review-tools/command", undefined],
    ],
  );
  assert.deepEqual(parsed.models, []);
  assert.deepEqual(parsed.tools, []);
  assert.equal(
    parsePluginReferences(
      parsed.plugins
        .filter((plugin) => plugin.revision)
        .map((plugin) => ({ id: plugin.id, revision: plugin.revision })),
    ).length,
    2,
  );
  assert.ok(!JSON.stringify(parsed).includes("never execute"));
  const bare = marketplace();
  bare.plugins = [
    { name: "local", source: "local", version: "v1" },
  ] as typeof bare.plugins;
  assert.equal(
    importClaudeMarketplace(
      { ...bare, metadata: { pluginRoot: "./plugins" } },
      { revision: pin },
    ).plugins[0]!.revision,
    pin,
  );
  for (const invalid of [
    { ...marketplace(), owner: undefined },
    {
      ...marketplace(),
      plugins: [{ name: "escape", source: "./plugins/../../outside" }],
    },
    { ...marketplace(), plugins: [{ name: "escape", source: "plugins/bare" }] },
    {
      ...marketplace(),
      plugins: [{ name: "escape", source: "./plugins\\outside" }],
    },
    { ...marketplace(), metadata: { pluginRoot: "./../outside" } },
    {
      ...marketplace(),
      plugins: [
        {
          name: "remote",
          source: { source: "github", repo: "example/remote", sha: "main" },
        },
      ],
    },
    {
      ...marketplace(),
      plugins: [
        { name: "remote", source: { source: "url", sha: externalPin } },
      ],
    },
    {
      ...marketplace(),
      plugins: [
        {
          name: "remote",
          source: {
            source: "url",
            url: "ssh://git@example.com/plugin",
            sha: externalPin,
          },
        },
      ],
    },
    {
      ...marketplace(),
      plugins: [
        {
          name: "remote",
          source: {
            source: "git-subdir",
            url: "https://example.com/plugin",
            sha: externalPin,
          },
        },
      ],
    },
    {
      ...marketplace(),
      plugins: [
        {
          name: "remote",
          source: {
            source: "git-subdir",
            url: "https://example.com/plugin",
            path: "../outside",
            sha: externalPin,
          },
        },
      ],
    },
    {
      ...marketplace(),
      plugins: [marketplace().plugins[0], marketplace().plugins[0]],
    },
    {
      ...marketplace(),
      plugins: Array.from({ length: 513 }, (_, i) => ({
        name: `p${i}`,
        source: "./plugin",
      })),
    },
  ])
    assert.throws(() => importClaudeMarketplace(invalid, { revision: pin }));
  assert.throws(() =>
    importClaudeMarketplace(marketplace(), { revision: "main" }),
  );
});

test("immutable raw metadata fetch is one bounded request with no redirects or plugin downloads", async () => {
  const calls: { url: string; options: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(marketplace()));
  };
  const parsed = await loadClaudeMarketplace(
    { source, revision: pin },
    fetcher,
  );
  assert.equal(parsed.plugins.length, 5);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, source);
  assert.equal(calls[0]!.options?.redirect, "error");
  assert.equal(calls[0]!.options?.credentials, "omit");
  assert.ok(calls[0]!.options?.signal instanceof AbortSignal);
  for (const invalid of [
    source.replace(pin, "main"),
    source.replace(pin, externalPin),
    source.replace("raw.githubusercontent.com", "localhost"),
    source.replace("https:", "http:"),
    `${source}?token=secret`,
    `${source}#fragment`,
    source.replace(
      "raw.githubusercontent.com",
      "user:secret@raw.githubusercontent.com",
    ),
    source.replace(
      "raw.githubusercontent.com",
      "raw.githubusercontent.com:8443",
    ),
    source.replace("marketplace.json", "plugin.json"),
  ])
    await assert.rejects(
      loadClaudeMarketplace({ source: invalid, revision: pin }, fetcher),
    );
  assert.equal(calls.length, 1, "Invalid sources fail before network access");
  await assert.rejects(
    loadClaudeMarketplace(
      { source, revision: pin },
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://example.com" },
        }),
    ),
    /fetch failed/,
  );
  let cancelled = false;
  const oversized: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(PERSONA_CATALOGUE_LIMIT + 1));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  await assert.rejects(
    loadClaudeMarketplace({ source, revision: pin }, oversized),
    /exceeds 1 MiB/,
  );
  assert.equal(cancelled, true);
});

test("local metadata CLI creates a new JSON catalogue without a database or executable imports", () => {
  const dir = mkdtempSync(join(tmpdir(), "asf-persona-catalogue-"));
  try {
    const file = join(dir, "marketplace.json"),
      output = join(dir, "catalogue.json"),
      db = join(dir, "absent", "store.db");
    writeFileSync(file, JSON.stringify(marketplace()));
    const args = [
      "--import",
      "tsx",
      resolve("src/cli.ts"),
      "import-marketplace",
      "--file",
      file,
      "--revision",
      pin,
      "--output",
      output,
      "--db",
      db,
    ];
    const result = spawnSync(process.execPath, args, {
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(db), false);
    assert.deepEqual(JSON.parse(result.stdout), {
      output,
      plugins: 5,
      unpinned: 3,
    });
    const bytes = readFileSync(output, "utf8");
    assert.equal(loadPersonaCatalogue(output).plugins[0]!.revision, pin);
    const duplicate = spawnSync(process.execPath, args, {
      encoding: "utf8",
      timeout: 30000,
    });
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /EEXIST/);
    assert.equal(readFileSync(output, "utf8"), bytes);
    writeFileSync(file, "x".repeat(PERSONA_CATALOGUE_LIMIT + 1));
    assert.throws(() => loadPersonaCatalogue(file), /exceeds 1 MiB/);
    assert.throws(() => loadPersonaCatalogue(dir), /regular JSON file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
