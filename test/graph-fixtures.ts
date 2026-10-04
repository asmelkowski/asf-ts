import { fixture, Scripted } from "./helpers.js";
import { portableFixture } from "./portable-fixtures.js";
import type { WorkflowDocument } from "../src/portable/model.js";
import type { ProfileBinding } from "../src/profiles.js";
import { executeDocument } from "../src/portable/execute.js";

export const sourceLiteral = "<script>globalThis.graphXss=1</script>";
export const graphBindings = (
  harness: Scripted,
): Record<string, ProfileBinding> => ({
  worker: {
    agent: { harness, model: "test-model", mode: "read-only" },
    capabilities: {
      revision: "graph-fixture-v1",
      modes: ["read-only"],
      fresh: true,
      nativeSystem: false,
      strictTools: false,
    },
  },
});
export function graphDocument(): WorkflowDocument {
  const document = portableFixture(),
    parent = document.workflows.delivery!,
    child = document.workflows.review!;
  document.profiles = { worker: {} };
  child.version = sourceLiteral;
  child.defaultProfile = "worker";
  child.start = "judgement";
  child.nodes.unshift({
    id: "judgement",
    kind: "agent",
    prompt: "Review the selected input",
    outputSchema: child.outputSchema,
    corrections: 1,
    next: "end",
  });
  child.nodes[1] = {
    id: "end",
    kind: "end",
    output: { $ref: "#/nodes/judgement" },
    passed: { $ref: "#/nodes/judgement/ok" },
  };
  parent.start = "decision";
  parent.nodes.unshift({
    id: "decision",
    kind: "branch",
    predicate: { left: { $ref: "#/input/ok" }, op: "truthy" },
    then: "child",
    else: "rejected",
  });
  parent.nodes.push({
    id: "rejected",
    kind: "end",
    output: { $ref: "#/input" },
    passed: false,
  });
  return document;
}
export async function recordedGraph() {
  const f = fixture(),
    document = graphDocument(),
    harness = new Scripted(["bad", '{"ok":false}']);
  try {
    const run = () =>
      f
        .runtime()
        .run((r) =>
          executeDocument(
            r,
            document,
            { ok: true },
            { bindings: graphBindings(harness) },
          ),
        );
    await run();
    return { ...f, document, harness, replay: run };
  } catch (error) {
    f.close();
    throw error;
  }
}
