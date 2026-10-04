// Trusted author code. Importing this module is inert.
import type { Runtime } from "../src/runtime.js";
import type { WorkflowDefinition, WorkflowResult } from "../src/composition.js";
import {
  CandidateVerifier,
  type VerificationReport,
} from "../src/verification.js";

type Task = { task: string };
export function verificationParents(verifier: CandidateVerifier): {
  delivery: WorkflowDefinition<Task, VerificationReport>;
  existingPr: WorkflowDefinition<Task, VerificationReport>;
} {
  const parent = (
    name: string,
  ): WorkflowDefinition<Task, VerificationReport> => ({
    name,
    version: "1",
    identity: `candidate-parent-v1:${name}:${verifier.identity}`,
    inputSchema: {
      type: "object",
      properties: { task: { type: "string", minLength: 1, maxLength: 8000 } },
      required: ["task"],
      additionalProperties: false,
    },
    outputSchema: verifier.definition.outputSchema,
    run: async (scope, input) => {
      const candidate = await verifier.capture(scope);
      const report = await scope.workflow("review", verifier.definition, {
        candidate,
        task: input.task,
      });
      verifier.requireCurrent(report.value);
      return { passed: report.passed, value: report.value };
    },
  });
  return { delivery: parent("delivery"), existingPr: parent("existing-pr") };
}

/** Freshness is checked outside the parent, including completed parent replay. */
export async function runCandidateParent(
  runtime: Runtime,
  verifier: CandidateVerifier,
  definition: WorkflowDefinition<Task, VerificationReport>,
  task: string,
  attempt = 1,
): Promise<WorkflowResult<VerificationReport>> {
  const result = await runtime.run((run) =>
    run.workflow(definition.name, definition, { task }, { attempt }),
  );
  verifier.requireCurrent(result.value);
  return result;
}

export async function runStandaloneVerification(
  runtime: Runtime,
  verifier: CandidateVerifier,
  task: string,
): Promise<WorkflowResult<VerificationReport>> {
  const result = await runtime.run(async (run) => {
    const candidate = await verifier.capture(run.scope("candidate"));
    return run.workflow("verification", verifier.definition, {
      candidate,
      task,
    });
  });
  verifier.requireCurrent(result.value);
  return result;
}
