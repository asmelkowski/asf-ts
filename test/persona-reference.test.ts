import test from "node:test";
import assert from "node:assert/strict";
import type { WorkflowDocument } from "../src/portable/model.js";
import {
  parseDocument,
  serializeDocument,
  validateDocument,
} from "../src/portable/validation.js";

function document(name: string): WorkflowDocument {
  return {
    format: "asf-ts-workflow/v1",
    root: "main",
    profiles: { [name]: { model: "local-model" } },
    workflows: {
      main: {
        version: "1",
        inputSchema: {},
        outputSchema: {},
        defaultProfile: name,
        start: "review",
        nodes: [
          {
            id: "review",
            kind: "agent",
            profile: name,
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

test("workflow and node persona references use the profile name bound through portable round trips", () => {
  for (const length of [100, 101, 128]) {
    const name = "p".repeat(length),
      source = document(name),
      result = validateDocument(source);
    for (const format of ["json", "yaml"] as const) {
      const restored = validateDocument(
        parseDocument(serializeDocument(result.document, format)),
      );
      assert.equal(restored.identity, result.identity);
      assert.equal(restored.document.workflows.main!.defaultProfile, name);
      const node = restored.document.workflows.main!.nodes[0]!;
      assert.equal(node.kind, "agent");
      assert.ok(node.kind === "agent");
      assert.equal(node.profile, name);
    }
  }
  assert.throws(
    () => validateDocument(document("p".repeat(129))),
    /profile name/,
  );
  const invalidNode = document("valid");
  invalidNode.workflows.main!.nodes[0]!.id = "n".repeat(101);
  assert.throws(() => validateDocument(invalidNode), /node ID/);
  for (const value of [128, {}, "missing"]) {
    const source = document("valid");
    Object.assign(source.workflows.main!, { defaultProfile: value });
    assert.throws(() => validateDocument(source), /unknown default profile/);
    Object.assign(source.workflows.main!, { defaultProfile: "valid" });
    Object.assign(source.workflows.main!.nodes[0]!, { profile: value });
    assert.throws(() => validateDocument(source), /unknown profile/);
  }
});
