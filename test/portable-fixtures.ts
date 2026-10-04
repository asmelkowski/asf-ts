import type { WorkflowDocument } from "../src/portable/model.js";
export function portableFixture(): WorkflowDocument {
  const schema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  };
  return {
    format: "asf-ts-workflow/v1",
    root: "delivery",
    workflows: {
      delivery: {
        version: "1",
        inputSchema: schema,
        outputSchema: schema,
        start: "child",
        nodes: [
          {
            id: "child",
            kind: "workflow",
            workflow: "review",
            input: { $ref: "#/input" },
            next: "end",
          },
          {
            id: "end",
            kind: "end",
            output: { $ref: "#/nodes/child" },
            passed: { $ref: "#/nodes/child/ok" },
          },
        ],
      },
      review: {
        version: "1",
        inputSchema: schema,
        outputSchema: schema,
        start: "end",
        nodes: [
          {
            id: "end",
            kind: "end",
            output: { $ref: "#/input" },
            passed: { $ref: "#/input/ok" },
          },
        ],
      },
    },
  };
}
