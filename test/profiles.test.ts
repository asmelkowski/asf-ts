import test from "node:test";
import assert from "node:assert/strict";
import {
  parseProfile,
  parseProfiles,
  parsePluginReferences,
  resolveProfile,
  type PluginReference,
  type ProfileBinding,
  type ProfileSelection,
} from "../src/profiles.js";
import { Scripted, fixture } from "./helpers.js";
import { executeDocument } from "../src/portable/execute.js";
import type { WorkflowDocument } from "../src/portable/model.js";
import {
  parseDocument,
  serializeDocument,
  validateDocument,
} from "../src/portable/validation.js";

function binding(extra: Partial<ProfileBinding> = {}): ProfileBinding {
  return {
    agent: { harness: new Scripted(), model: "test-model" },
    capabilities: {
      revision: "fixture/v1",
      modes: ["read-only", "write"],
      tools: ["read", "write"],
      strictTools: false,
      nativeSystem: false,
      fresh: true,
    },
    ...extra,
  };
}
function selection(extra: Partial<ProfileSelection> = {}): ProfileSelection {
  return {
    profiles: {
      writer: { instructions: "Write", mode: "write" },
      reviewer: { instructions: "Review" },
    },
    bindings: { writer: binding(), reviewer: binding() },
    defaultProfile: "writer",
    ...extra,
  };
}

test("named profiles replace defaults; explicit caller selection and field overrides win", () => {
  const resolved = resolveProfile(
    selection({
      defaults: { instructions: "Default", mode: "read-only", timeoutMs: 1000 },
      nodeProfile: "reviewer",
      callerProfile: "writer",
      override: { instructions: "Caller" },
    }),
  );
  assert.equal(resolved.name, "writer");
  assert.equal(resolved.agentConfig.instructions, "Caller");
  assert.equal(resolved.agentConfig.mode, "write");
  assert.equal(resolved.agentConfig.timeoutMs, 1000);
  assert.equal(resolved.sessionPolicy, "fresh");
  assert.equal(
    resolveProfile(selection({ nodeProfile: "reviewer" })).agentConfig
      .instructions,
    "Review",
  );
  assert.throws(
    () => resolveProfile(selection({ nodeProfile: "absent" })),
    /Unknown selected/,
  );
  assert.throws(
    () => resolveProfile(selection({ bindings: {} })),
    /Missing local binding/,
  );
});

test("portable profiles reject unknown fields, literal credentials and invalid scalar shapes", () => {
  for (const value of [
    { secret: "private" },
    { executable: "/bin/tool" },
    { capabilities: {} },
    { credentials: { key: "private" } },
    { model: "" },
    { strict: "false" },
    { instructions: 42 },
    { tools: "read" },
    { tools: ["read", "read"] },
    { timeoutMs: 1.5 },
    { timeoutMs: Infinity },
    { session: "continue" },
    { mode: "admin" },
    { instructionsChannel: "system" },
    { strict: true },
  ])
    assert.throws(() => parseProfile(value));
  for (const value of [
    [],
    null,
    "profiles",
    { "../escape": {} },
    { __proto__: {} },
  ])
    assert.throws(() => parseProfiles(value));
  assert.equal(parseProfile({ strict: true, tools: [] }).tools!.length, 0);
});

test("resolved identities and previews are frozen snapshots without harness credentials", () => {
  const tools = ["read"],
    instructions = { instructions: "Review", tools };
  const bind = binding();
  const resolved = resolveProfile(
    selection({
      profiles: { reviewer: instructions },
      bindings: { reviewer: bind },
      defaultProfile: "reviewer",
    }),
  );
  const initial = JSON.stringify(resolved.preview());
  tools.push("write");
  instructions.instructions = "Changed";
  bind.agent.model = "changed";
  assert.equal(JSON.stringify(resolved.preview()), initial);
  assert.equal(resolved.agentConfig.model, "test-model");
  assert.ok(Object.isFrozen(resolved));
  assert.ok(Object.isFrozen(resolved.intent.tools));
  assert.ok(!JSON.stringify(resolved.preview()).includes("harness"));
  const first = resolveProfile(selection());
  const changed = resolveProfile(selection({ defaults: { timeoutMs: 12 } }));
  assert.notEqual(first.identity, changed.identity);
});

test("tools are explicit requirements; strict empty selection means no tools", () => {
  assert.throws(
    () =>
      resolveProfile(selection({ profiles: { writer: { tools: ["shell"] } } })),
    /does not provide/,
  );
  assert.throws(
    () =>
      resolveProfile(
        selection({ profiles: { writer: { tools: ["read"], strict: true } } }),
      ),
    /exact strict/,
  );
  const local = binding();
  local.capabilities = { ...local.capabilities, tools: [], strictTools: true };
  const resolved = resolveProfile(
    selection({
      profiles: { writer: { tools: [], strict: true } },
      bindings: { writer: local },
    }),
  );
  assert.equal(
    (resolved.preview() as Record<string, unknown>).toolSupport,
    "enforced",
  );
  local.capabilities = { ...local.capabilities, tools: ["read", "write"] };
  assert.throws(
    () =>
      resolveProfile(
        selection({
          profiles: { writer: { tools: ["read"], strict: true } },
          bindings: { writer: local },
        }),
      ),
    /exact strict/,
  );
  const unknown = binding();
  delete unknown.capabilities.tools;
  assert.throws(
    () =>
      resolveProfile(
        selection({
          profiles: { writer: { tools: [] } },
          bindings: { writer: unknown },
        }),
      ),
    /inventory is unknown/,
  );
});

test("partial defaults and overrides inherit selected tools before the strict invariant", () => {
  const local = binding();
  local.capabilities = {
    ...local.capabilities,
    tools: ["read"],
    strictTools: true,
  };
  const input = selection({
    profiles: { writer: { tools: ["read"] } },
    bindings: { writer: local },
  });
  for (const fragment of [
    { override: { strict: true } },
    { defaults: { strict: true } },
  ]) {
    const resolved = resolveProfile({ ...input, ...fragment });
    assert.equal(resolved.intent.strict, true);
    assert.deepEqual(resolved.intent.tools, ["read"]);
  }
  assert.throws(
    () => resolveProfile(selection({ override: { strict: true } })),
    /explicit tools/,
  );
  assert.throws(
    () => resolveProfile({ ...input, override: { strict: "true" } as never }),
    /must be boolean/,
  );
  assert.throws(
    () => resolveProfile({ ...input, defaults: { capabilities: {} } as never }),
    /Unknown profile field/,
  );
});

test("native system instructions require an exact preconfigured native binding", () => {
  const intent = {
    instructions: "Review",
    instructionsChannel: "native-system" as const,
  };
  assert.throws(
    () => resolveProfile(selection({ profiles: { writer: intent } })),
    /exact native system/,
  );
  const local = binding({
    instructionChannel: "native-system",
    nativeInstructions: "Review",
  });
  local.capabilities = { ...local.capabilities, nativeSystem: true };
  const resolved = resolveProfile(
    selection({ profiles: { writer: intent }, bindings: { writer: local } }),
  );
  assert.equal(resolved.agentConfig.instructions, undefined);
  assert.equal(
    (resolved.preview() as Record<string, unknown>).instructionSupport,
    "enforced",
  );
  assert.throws(
    () =>
      resolveProfile(
        selection({
          profiles: { writer: { ...intent, instructions: "Different" } },
          bindings: { writer: local },
        }),
      ),
    /exact native system/,
  );
});

test("fresh reviewers reject continuation; compatible profiles bind all resolved identity", () => {
  const fresh = resolveProfile(selection());
  assert.throws(() => fresh.checkContinuation(fresh.identity), /Fresh profile/);
  const compatible = resolveProfile(
    selection({ override: { session: "compatible" } }),
  );
  compatible.checkContinuation(compatible.identity);
  assert.throws(
    () => compatible.checkContinuation(fresh.identity),
    /identity changed/,
  );
  const local = binding();
  local.capabilities = {
    ...local.capabilities,
    fresh: false,
    modes: ["write"],
  };
  assert.throws(
    () => resolveProfile(selection({ bindings: { writer: local } })),
    /fresh sessions/,
  );
  assert.throws(
    () =>
      resolveProfile(
        selection({
          bindings: { writer: local },
          override: { mode: "read-only" },
        }),
      ),
    /does not support mode/,
  );
});

test("legacy runtime receives one visible prompt prefix and advisory tool guidance", async () => {
  const f = fixture(),
    local = binding();
  try {
    const resolved = resolveProfile(
      selection({
        profiles: {
          writer: { instructions: "Review carefully", tools: ["read"] },
        },
        bindings: { writer: local },
      }),
    );
    await f.runtime().run((run) =>
      run.agent("review", resolved.agentConfig, {
        prompt: "Review candidate",
      }),
    );
    const request = (local.agent.harness as Scripted).calls[0]!;
    assert.equal(request.prompt.split("Review carefully").length, 2);
    assert.match(request.prompt, /Advisory tool guidance/);
    assert.match(request.prompt, /does not enforce/);
    assert.equal(request.mode, "read-only");
    assert.equal(
      (resolved.preview() as Record<string, unknown>).instructionChannel,
      "prompt-prefix",
    );
  } finally {
    f.close();
  }
});

const reviewPlugin: PluginReference = {
  id: "team/reviewer",
  revision: "a".repeat(40),
};
const testPlugin: PluginReference = {
  id: "team/test-runner",
  revision: "b".repeat(64),
};

function pluginBinding(activePlugins?: readonly PluginReference[]) {
  const local = binding();
  if (activePlugins !== undefined)
    local.capabilities = { ...local.capabilities, activePlugins };
  return local;
}

test("plugin references reject unknown fields, unpinned revisions, duplicate IDs and invalid slugs", () => {
  for (const value of [
    null,
    "team/reviewer",
    [null],
    [{ ...reviewPlugin, credentials: "private" }],
    [{ ...reviewPlugin, installed: true }],
    [{ id: reviewPlugin.id }],
    [{ revision: reviewPlugin.revision }],
    [{ ...reviewPlugin, id: "reviewer" }],
    [{ ...reviewPlugin, id: "Team/reviewer" }],
    [{ ...reviewPlugin, id: "../reviewer" }],
    [{ ...reviewPlugin, id: "team/reviewer/child" }],
    [{ ...reviewPlugin, id: "team/reviewer\n" }],
    [{ ...reviewPlugin, id: `team/${"a".repeat(129)}` }],
    [{ ...reviewPlugin, revision: "main" }],
    [{ ...reviewPlugin, revision: "A".repeat(40) }],
    [{ ...reviewPlugin, revision: "a".repeat(39) }],
    [{ ...reviewPlugin, revision: "a".repeat(40) + "\n" }],
    [reviewPlugin, { ...reviewPlugin, revision: testPlugin.revision }],
    Array.from({ length: 257 }, (_, i) => ({
      id: `team/plugin-${i}`,
      revision: reviewPlugin.revision,
    })),
  ])
    assert.throws(() => parseProfile({ plugins: value }));
  assert.deepEqual(parsePluginReferences([]), []);
  assert.equal(
    parsePluginReferences(
      Array.from({ length: 256 }, (_, i) => ({
        id: `team/plugin-${i}`,
        revision: reviewPlugin.revision,
      })),
    ).length,
    256,
  );
});

test("plugin selections and active inventories are sorted frozen snapshots", () => {
  const first = { ...reviewPlugin },
    second = { ...testPlugin },
    requested = [second, first],
    active = [first, second];
  const resolved = resolveProfile(
    selection({
      profiles: { writer: { plugins: requested } },
      bindings: { writer: pluginBinding(active) },
    }),
  );
  const snapshot = JSON.stringify(resolved.preview()),
    identity = resolved.identity;
  first.revision = "c".repeat(40);
  requested.reverse();
  active.pop();
  assert.equal(JSON.stringify(resolved.preview()), snapshot);
  assert.equal(resolved.identity, identity);
  assert.deepEqual(resolved.intent.plugins, [reviewPlugin, testPlugin]);
  assert.deepEqual(resolved.capabilities.activePlugins, [
    reviewPlugin,
    testPlugin,
  ]);
  assert.ok(Object.isFrozen(resolved.intent.plugins));
  assert.ok(Object.isFrozen(resolved.intent.plugins![0]));
  assert.ok(Object.isFrozen(resolved.capabilities.activePlugins));
  assert.ok(Object.isFrozen(resolved.capabilities.activePlugins![0]));
  const reordered = resolveProfile(
    selection({
      profiles: { writer: { plugins: [reviewPlugin, testPlugin] } },
      bindings: { writer: pluginBinding([testPlugin, reviewPlugin]) },
    }),
  );
  assert.equal(reordered.identity, identity);
});

test("plugin requirements need an exact known active inventory, including explicit empty selection", () => {
  for (const requested of [[], [reviewPlugin]])
    assert.throws(
      () =>
        resolveProfile(
          selection({ profiles: { writer: { plugins: requested } } }),
        ),
      /active plugin inventory is unknown/,
    );
  for (const [requested, active] of [
    [[], [reviewPlugin]],
    [[reviewPlugin], []],
    [[reviewPlugin], [reviewPlugin, testPlugin]],
    [[reviewPlugin], [{ ...reviewPlugin, revision: "c".repeat(40) }]],
  ])
    assert.throws(
      () =>
        resolveProfile(
          selection({
            profiles: { writer: { plugins: requested } },
            bindings: { writer: pluginBinding(active) },
          }),
        ),
      /exact profile selection/,
    );
  const empty = resolveProfile(
    selection({
      profiles: { writer: { plugins: [] } },
      bindings: { writer: pluginBinding([]) },
    }),
  );
  assert.deepEqual(empty.intent.plugins, []);
  assert.throws(
    () =>
      resolveProfile(
        selection({
          bindings: { writer: pluginBinding([reviewPlugin, reviewPlugin]) },
        }),
      ),
    /duplicate plugin id/,
  );
});

test("plugin arrays replace defaults and selected intent through explicit caller overrides", () => {
  const selected = selection({
    defaults: { plugins: [reviewPlugin] },
    profiles: { writer: { plugins: [testPlugin], model: "test-model" } },
    bindings: { writer: pluginBinding([testPlugin]) },
  });
  assert.deepEqual(resolveProfile(selected).intent.plugins, [testPlugin]);
  const overridden = resolveProfile({
    ...selected,
    bindings: { writer: pluginBinding([]) },
    override: { plugins: [] },
  });
  assert.deepEqual(overridden.intent.plugins, []);
  assert.equal(overridden.agentConfig.model, "test-model");
});

test("omitted plugin metadata preserves the established legacy profile identity", () => {
  const legacy = resolveProfile(selection());
  // Captured from integration 5f805b9 before the plugin contract change.
  assert.equal(
    legacy.identity,
    "1c7e0a1f9f14b160a7353a7d8a01b978e16704b0e271ee25d9c4f85e3d79e026",
  );
  assert.ok(!Object.hasOwn(legacy.intent, "plugins"));
  assert.ok(!Object.hasOwn(legacy.capabilities, "activePlugins"));
  const knownEmpty = resolveProfile(
    selection({ bindings: { writer: pluginBinding([]) } }),
  );
  assert.notEqual(knownEmpty.identity, legacy.identity);
  const knownActive = resolveProfile(
    selection({ bindings: { writer: pluginBinding([reviewPlugin]) } }),
  );
  assert.notEqual(knownActive.identity, knownEmpty.identity);
  assert.equal(knownActive.intent.plugins, undefined);
});

test("changed plugin pins or active inventory reject compatible continuation", () => {
  const make = (plugin: PluginReference, requested = true) =>
    resolveProfile(
      selection({
        profiles: {
          writer: {
            session: "compatible",
            ...(requested ? { plugins: [plugin] } : {}),
          },
        },
        bindings: { writer: pluginBinding([plugin]) },
      }),
    );
  for (const requested of [true, false]) {
    const original = make(reviewPlugin, requested),
      changed = make({ ...reviewPlugin, revision: "c".repeat(40) }, requested);
    original.checkContinuation(original.identity);
    assert.throws(
      () => changed.checkContinuation(original.identity),
      /identity changed/,
    );
  }
});

function pluginDocument(): WorkflowDocument {
  return {
    format: "asf-ts-workflow/v1",
    root: "main",
    profiles: { writer: { plugins: [reviewPlugin] } },
    workflows: {
      main: {
        version: "1",
        inputSchema: {},
        outputSchema: {},
        defaultProfile: "writer",
        start: "review",
        nodes: [
          {
            id: "review",
            kind: "agent",
            prompt: "Review",
            outputSchema: {},
            next: "complete",
          },
          { id: "complete", kind: "end", output: { $ref: "#/nodes/review" } },
        ],
      },
    },
  };
}

test("portable YAML and JSON preserve plugin requirements and semantic identity", () => {
  const document = pluginDocument(),
    identity = validateDocument(document).identity;
  for (const format of ["yaml", "json"] as const) {
    const restored = parseDocument(serializeDocument(document, format));
    assert.deepEqual(restored.profiles!.writer!.plugins, [reviewPlugin]);
    assert.equal(validateDocument(restored).identity, identity);
  }
});

test("unknown or mismatched plugin inventory rejects portable execution before any native reservation", async () => {
  for (const active of [undefined, []]) {
    const f = fixture(),
      local = pluginBinding(active);
    try {
      await assert.rejects(
        f
          .runtime()
          .run((runtime) =>
            executeDocument(
              runtime,
              pluginDocument(),
              {},
              { bindings: { writer: local } },
            ),
          ),
        /active plugin inventory is unknown|exact profile selection/,
      );
      assert.equal((local.agent.harness as Scripted).calls.length, 0);
      assert.equal(f.store.inspect("run").totals.invocations, 0);
      assert.equal(f.store.workflowInspect("run").workflows.length, 0);
    } finally {
      f.close();
    }
  }
});
