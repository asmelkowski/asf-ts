// Trusted author workflow; importing it is inert. No model retries or rollback.
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { AgentConfig, CommandResult, Json } from "../src/types.js";
import type { Runtime } from "../src/runtime.js";
import { command } from "../src/process.js";
import { selectCheckEvidence as selectedCheck } from "../src/verification.js";

const helper = fileURLToPath(
  new URL("../scripts/self-improvement-files.mjs", import.meta.url),
);
const formatter = createRequire(import.meta.url).resolve(
  "prettier/bin/prettier.cjs",
);
const policy = `Work only on the explicit edit-file allowlist in this repository. Native file-read shell commands are allowed. Do not read credentials, private native history, or environment; do not use network, edit git/package/auth/config state, stage, commit, rename, or delete. Do not run tests, checks, or model/provider probes: the trusted host runs checks. No subagents. These instructions are not a security sandbox.`;
const schema = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    reason: { type: "string", maxLength: 2000 },
  },
  required: ["approved", "reason"],
  additionalProperties: false,
};
interface Snapshot {
  artifact: string;
  hash: string;
  state: string;
  files: number;
}
interface Scope {
  state: string;
  patch: string;
  files: number;
  editFiles: string[];
}
function ordinary(result: CommandResult): CommandResult {
  if (result.cancelled || result.signal !== null || result.code === null)
    throw new Error("Cancelled or nonordinary host command; no repair");
  return result;
}
function evidence<T>(result: CommandResult): T {
  ordinary(result);
  if (result.code !== 0 || result.truncated)
    throw new Error(`Source scope/snapshot failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as T;
}
export async function workflow(
  r: Runtime,
  input: Json,
  agents: Record<string, AgentConfig>,
): Promise<unknown> {
  if (!input || Array.isArray(input) || typeof input !== "object")
    throw new Error("Task object required");
  const { task, editFiles, readInstructions } = input;
  const maxRepairs = input.maxRepairs ?? 1;
  const reviewOnly = input.reviewOnly ?? false;
  const formatFiles = input.formatFiles ?? false;
  const existingSnapshot = input.snapshot;
  if (
    typeof task !== "string" ||
    !task.trim() ||
    task.length > 16000 ||
    !Array.isArray(editFiles) ||
    !editFiles.length ||
    editFiles.length > 20 ||
    editFiles.some((p) => typeof p !== "string") ||
    typeof maxRepairs !== "number" ||
    !Number.isInteger(maxRepairs) ||
    maxRepairs < 0 ||
    maxRepairs > 3 ||
    typeof reviewOnly !== "boolean" ||
    typeof formatFiles !== "boolean" ||
    (existingSnapshot !== undefined &&
      (!reviewOnly ||
        !existingSnapshot ||
        Array.isArray(existingSnapshot) ||
        typeof existingSnapshot !== "object")) ||
    (readInstructions !== undefined &&
      (typeof readInstructions !== "string" || readInstructions.length > 8000))
  )
    throw new Error(
      "Require task, editFiles, maxRepairs 0..3, optional readInstructions/reviewOnly/formatFiles",
    );
  if (!agents.worker || !agents.reviewer)
    throw new Error("Reusable worker and reviewer agents required");
  const worker = { ...agents.worker, mode: "write" as const };
  const reviewer = { ...agents.reviewer, mode: "read-only" as const };
  const artifact = `.asf/self-improvement/${r.options.runId}`;
  const snapshot =
    existingSnapshot === undefined
      ? evidence<Snapshot>(
          await r.command("baseline/snapshot", [
            process.execPath,
            helper,
            "capture",
            artifact,
            JSON.stringify(editFiles),
          ]),
        )
      : (existingSnapshot as unknown as Snapshot);
  if (
    typeof snapshot.artifact !== "string" ||
    !/^\.asf\/self-improvement\/[a-zA-Z0-9_-]{1,100}$/.test(
      snapshot.artifact,
    ) ||
    (existingSnapshot === undefined && snapshot.artifact !== artifact) ||
    typeof snapshot.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(snapshot.hash) ||
    typeof snapshot.state !== "string" ||
    !/^[a-f0-9]{64}$/.test(snapshot.state) ||
    !Number.isInteger(snapshot.files) ||
    snapshot.files < 0 ||
    snapshot.files > 5000
  )
    throw new Error("Malformed baseline descriptor");
  const inspectArgv = [
    process.execPath,
    helper,
    "inspect",
    snapshot.artifact,
    snapshot.hash,
  ];
  const checkedScope = (result: CommandResult): Scope => {
    const value = evidence<Scope>(result);
    if (
      !/^[a-f0-9]{64}$/.test(value.state) ||
      typeof value.patch !== "string" ||
      Buffer.byteLength(value.patch) > 16 * 1024
    )
      throw new Error("Malformed scope/patch snapshot");
    if (JSON.stringify(value.editFiles) !== JSON.stringify(editFiles))
      throw new Error("Snapshot edit-file allowlist differs");
    return value;
  };
  const currentScope = () =>
    command(
      inspectArgv,
      r.cwd,
      r.options.signal ?? new AbortController().signal,
      60000,
      24 * 1024,
    );
  // Recheck real scope even when durable commands below will replay.
  const initialScope = checkedScope(await currentScope());
  // Each immutable expected state is also included in that action's recorded
  // context. Runtime calls preflight only for NEW sends, including corrections,
  // never for completed action or raw receipt replay.
  const guarded = (config: AgentConfig, expectedState: string): AgentConfig => {
    const delegate = config.harness;
    return {
      ...config,
      harness: {
        name: delegate.name,
        live: delegate.live,
        // Identical across write/repair actions: native session binding stays stable.
        identity: {
          delegate: delegate.identity,
          sourceGuard: "checked-state-v1",
        },
        async preflight(request) {
          const actual = checkedScope(await currentScope());
          if (actual.state !== expectedState)
            throw new Error(
              "Source changed before new model send; no reservation",
            );
          await delegate.preflight(request);
        },
        invoke: (request, sink) => delegate.invoke(request, sink),
      },
    };
  };
  const scope = async (id: string): Promise<Scope> =>
    checkedScope(await r.command(id, inspectArgv));
  const format = (id: string) =>
    r.command(
      id,
      [process.execPath, formatter, "--write", ...(editFiles as string[])],
      {
        timeoutMs: 60000,
      },
    );
  let baselineState = reviewOnly ? initialScope.state : snapshot.state;
  // Review-only is a NEW run for an existing candidate, never a writer resend or
  // an identity override on a completed run. Optional formatting is a durable,
  // trusted host action restricted to the already scope-checked edit files.
  if (reviewOnly && formatFiles) {
    const formatted = ordinary(await format("baseline/format"));
    if (formatted.code !== 0)
      return { accepted: false, reason: "Host formatter failed", formatted };
    baselineState = (await scope("baseline/formatted-scope")).state;
  }
  // Baseline checks precede any paid action. Output truncation is not a failing exit.
  const baseline = ordinary(
    await r.command("baseline/check", ["npm", "run", "check"], {
      timeoutMs: 600000,
    }),
  );
  if (baseline.code !== 0)
    return {
      accepted: false,
      reason: "Baseline npm run check failed",
      baseline,
    };
  const baselineScope = await scope("baseline/scope");
  if (baselineScope.state !== baselineState)
    throw new Error("Baseline check changed source");
  let checks: {
    diff: CommandResult;
    check: CommandResult;
    format?: CommandResult;
  };
  let change: Scope;
  if (reviewOnly) {
    const diff = ordinary(
      await r.command("baseline/diff-check", ["git", "diff", "--check"], {
        timeoutMs: 60000,
      }),
    );
    if (diff.code !== 0)
      return { accepted: false, reason: "Candidate diff check failed", diff };
    checks = { diff, check: baseline };
    change = baselineScope;
  } else {
    let coder = await r.agent("coder/write", guarded(worker, snapshot.state), {
      prompt: `${policy}\nImplement the selected task. Return a concise change summary.`,
      context: {
        task,
        editFiles,
        readInstructions: readInstructions ?? null,
        expectedSourceState: snapshot.state,
      },
    });
    for (let repair = 0; ; repair++) {
      const id = `host-${repair}`;
      await scope(`${id}/scope-before-format`);
      const formatted = formatFiles
        ? ordinary(await format(`${id}/format`))
        : undefined;
      const beforeChecks = await scope(`${id}/scope-before`);
      const diff = ordinary(
        await r.command(`${id}/diff-check`, ["git", "diff", "--check"], {
          timeoutMs: 60000,
        }),
      );
      const check = ordinary(
        await r.command(`${id}/check`, ["npm", "run", "check"], {
          timeoutMs: 600000,
        }),
      );
      change = await scope(`${id}/scope-after`);
      if (beforeChecks.state !== change.state)
        throw new Error(
          "Source changed during host checks; no acceptance or repair",
        );
      checks = { diff, check, ...(formatted ? { format: formatted } : {}) };
      if (
        diff.code === 0 &&
        check.code === 0 &&
        (!formatted || formatted.code === 0)
      )
        break;
      if (repair === maxRepairs)
        return {
          accepted: false,
          reason: "Host checks failed; repair bound reached",
          checks,
        };
      const selected = {
        diff: selectedCheck(checks.diff),
        check: selectedCheck(checks.check),
        ...(formatted ? { format: selectedCheck(formatted) } : {}),
      };
      if (
        Object.values(selected).some(
          (c) => c.code !== 0 && c.captureTruncated && !c.diagnosticAvailable,
        )
      )
        return {
          accepted: false,
          reason: "Host check diagnostic-unavailable; no repair",
          checks,
        };
      coder = await r.agent(
        `coder/repair-${repair + 1}`,
        guarded(worker, change.state),
        {
          prompt: `${policy}\nRepair only the ordinary host check failures, in the same coder session.`,
          session: coder.session,
          context: {
            task,
            editFiles,
            expectedSourceState: change.state,
            checks: selected,
          },
        },
      );
    }
  }
  const review = await r.agent<{ approved: boolean; reason: string }>(
    "review/readonly",
    guarded(reviewer, change.state),
    {
      prompt: `${policy}\nFresh read-only review. Judge the actual baseline-relative patch and host evidence; use repository reads if needed. Approve only if the task is satisfied. Do not edit any file. ${readInstructions ?? ""}`,
      context: {
        task,
        editFiles,
        patch: change.patch,
        expectedSourceState: change.state,
        scopeEvidence: {
          baseline: { ...snapshot },
          checkedState: change.state,
          editFiles: change.editFiles,
          patchBytes: Buffer.byteLength(change.patch),
          policy:
            "helper verified protected source hashes, HEAD/branch/index, regular files and edit-file-only differences against immutable baseline",
        },
        checks: {
          diff: selectedCheck(checks.diff),
          check: selectedCheck(checks.check),
        },
      },
      schema,
      corrections: 1,
    },
  );
  // Runtime actions replay their evidence. This read-only host inspection runs again
  // on explicit resume, preventing stale acceptance after files change (also catches
  // reviewer edits). It has no source/artifact write effects and never dispatches.
  const actual = checkedScope(await currentScope());
  if (actual.state !== change.state || actual.patch !== change.patch)
    throw new Error("Source changed after checked snapshot; no acceptance");
  return {
    accepted: review.value.approved,
    review: review.value,
    checks,
    snapshot,
    change,
  };
}
