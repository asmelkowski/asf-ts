import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { workflow } from "../examples/self-improvement.js";
import { accounting, fixture, Scripted } from "./helpers.js";
import { hash } from "../src/util.js";
import type { HarnessRequest, Receipt, Json } from "../src/types.js";

const helper = fileURLToPath(
  new URL("../scripts/self-improvement-files.mjs", import.meta.url),
);
const cli = fileURLToPath(
  new URL("../scripts/self-improve.ts", import.meta.url),
);
function repo() {
  const f = fixture(),
    cwd = join(f.dir, "repo");
  mkdirSync(cwd);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init", "-q");
  writeFileSync(join(cwd, ".gitignore"), ".asf/\n");
  writeFileSync(join(cwd, "worker.txt"), "original\n");
  writeFileSync(join(cwd, "dependency.txt"), "pinned-v1\n");
  writeFileSync(
    join(cwd, "check.mjs"),
    `import{readFileSync}from'node:fs';console.log('x'.repeat(5000));const bad=readFileSync('worker.txt','utf8').includes('bad');if(bad)console.log('not ok 1 - worker regression\\n  AssertionError: expected fixed worker');console.log('x'.repeat(30000));if(bad)process.exit(1);`,
  );
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ scripts: { check: "node check.mjs" } }),
  );
  git("add", ".");
  git(
    "-c",
    "user.name=offline",
    "-c",
    "user.email=offline@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  // A staged dependency upgrade AND missing tracked file are baseline, not task patch.
  writeFileSync(join(cwd, "dependency.txt"), "pinned-v2\n");
  git("add", "dependency.txt");
  writeFileSync(join(cwd, "untracked.txt"), "baseline source\n");
  mkdirSync(join(cwd, ".asf"));
  const input: Json = {
    task: "Improve worker and add a regression fixture",
    editFiles: ["worker.txt", "new-test.txt"],
    maxRepairs: 1,
  };
  const runtime = (extra: { runId?: string; workflowIdentity?: string } = {}) =>
    f.runtime({ cwd, ...extra });
  const receipt = (
    r: HarnessRequest,
    text = "done",
    extra: Partial<Receipt> = {},
  ): Receipt => ({
    status: "succeeded",
    text,
    accounting,
    session: { nativeId: r.session?.nativeId ?? "session", baseline: 1 },
    ...extra,
  });
  const write = (r: HarnessRequest, text: string) => {
    writeFileSync(join(cwd, "worker.txt"), `${text}\n`);
    writeFileSync(join(cwd, "new-test.txt"), "new regression\n");
    return receipt(r);
  };
  const review = new Scripted(['{"approved":true,"reason":"checked"}']);
  const agents = (worker: Scripted, reviewer = review) => ({
    worker: { harness: worker, model: "test-model" },
    reviewer: { harness: reviewer, model: "test-model" },
  });
  return { ...f, cwd, git, input, runtime, receipt, write, review, agents };
}

test("uncommitted baseline, new-file real diff, bounded same-session repair/review correction and replay", async () => {
  const f = repo();
  try {
    const worker = new Scripted([
      async (r) => f.write(r, "bad"),
      async (r) => f.write(r, "fixed"),
    ]);
    const reviewer = new Scripted([
      "NOT_JSON",
      '{"approved":true,"reason":"checked"}',
    ]);
    const run = () =>
      f.runtime().run((r) => workflow(r, f.input, f.agents(worker, reviewer)));
    const result = (await run()) as {
      accepted: boolean;
      change: { patch: string };
      checks: { check: { code: number; truncated: boolean } };
    };
    assert.equal(result.accepted, true);
    assert.equal(result.checks.check.code, 0);
    assert.equal(result.checks.check.truncated, true); // successful full check, not rejected
    assert.match(result.change.patch, /new regression/);
    assert.match(result.change.patch, /-original/);
    assert.doesNotMatch(result.change.patch, /pinned-v[12]/);
    assert.equal(worker.calls.length, 2);
    assert.equal(worker.calls[1]?.session?.nativeId, "session");
    assert.match(worker.calls[1]!.prompt, /not ok 1 - worker regression/);
    assert.match(
      worker.calls[1]!.prompt,
      /AssertionError: expected fixed worker/,
    );
    assert.ok(Buffer.byteLength(worker.calls[1]!.prompt) < 64 * 1024);
    assert.match(worker.calls[1]!.prompt, /"captureTruncated":true/);
    assert.match(worker.calls[1]!.prompt, /"selectedOutputTruncated":true/);
    assert.equal(reviewer.calls.length, 2);
    assert.equal(reviewer.calls[0]?.mode, "read-only");
    assert.equal(reviewer.calls[0]?.session, undefined);
    assert.equal(reviewer.calls[1]?.session?.nativeId, "native-1");
    assert.equal(worker.calls[0]?.traceContent, false);
    assert.match(reviewer.calls[0]!.prompt, /new regression/);
    const before = f.store.inspect("run").totals;
    assert.deepEqual(await run(), result);
    assert.deepEqual(f.store.inspect("run").totals, before);
    assert.equal(worker.calls.length, 2);
    // A completed action is not permission to accept externally altered source.
    writeFileSync(join(f.cwd, "worker.txt"), "changed after check\n");
    await assert.rejects(run(), /changed after checked snapshot/);
    assert.equal(worker.calls.length, 2);
  } finally {
    f.close();
  }
});

test("baseline failure is account-free and does not dispatch", async () => {
  const f = repo();
  try {
    writeFileSync(join(f.cwd, "worker.txt"), "bad baseline\n");
    const worker = new Scripted();
    const result = (await f
      .runtime()
      .run((r) => workflow(r, f.input, f.agents(worker)))) as {
      accepted: boolean;
    };
    assert.equal(result.accepted, false);
    assert.equal(worker.calls.length, 0);
    assert.equal(f.review.calls.length, 0);
  } finally {
    f.close();
  }
});

for (const failure of ["native", "incomplete", "cancelled", "throw"] as const) {
  test(`${failure} model failure never repairs or reviews, including explicit replay`, async () => {
    const f = repo();
    try {
      const worker = new Scripted([
        async (r, sink) => {
          sink.report("known", accounting);
          if (failure === "throw") throw new Error("uncertain transport");
          return f.receipt(
            r,
            "",
            failure === "incomplete"
              ? {
                  accounting: {
                    ...accounting,
                    status: "incomplete",
                    reason: "coverage missing",
                  },
                }
              : {
                  status: failure === "cancelled" ? "cancelled" : "failed",
                  error: "native diagnostic",
                },
          );
        },
      ]);
      const run = () =>
        f.runtime().run((r) => workflow(r, f.input, f.agents(worker)));
      await assert.rejects(run());
      await assert.rejects(run());
      assert.equal(worker.calls.length, 1);
      assert.equal(f.review.calls.length, 0);
      assert.equal(f.store.inspect("run").totals.knownUsd, accounting.usd);
    } finally {
      f.close();
    }
  });
}

test("only ordinary command failure repairs; finite bound returns rejection", async () => {
  const f = repo();
  try {
    const worker = new Scripted([
      async (r) => f.write(r, "bad"),
      async (r) => f.write(r, "still bad"),
    ]);
    const result = (await f
      .runtime()
      .run((r) => workflow(r, f.input, f.agents(worker)))) as {
      accepted: boolean;
    };
    assert.equal(result.accepted, false);
    assert.equal(worker.calls.length, 2);
    assert.equal(f.review.calls.length, 0);
  } finally {
    f.close();
  }
});

test("cancelled host check never invokes repair", async () => {
  const f = repo();
  try {
    const worker = new Scripted([async (r) => f.write(r, "fixed")]);
    const runtime = f.runtime(),
      original = runtime.command.bind(runtime);
    runtime.command = async (id, argv, options) =>
      id === "host-0/check"
        ? {
            code: 1,
            signal: null,
            cancelled: true,
            truncated: false,
            stdout: "",
            stderr: "",
          }
        : original(id, argv, options);
    await assert.rejects(
      runtime.run((r) => workflow(r, f.input, f.agents(worker))),
      /nonordinary/,
    );
    assert.equal(worker.calls.length, 1);
    assert.equal(f.review.calls.length, 0);
  } finally {
    f.close();
  }
});

for (const mutation of [
  "outside",
  "delete",
  "stage",
  "rename",
  "reviewer",
] as const) {
  test(`scope violation (${mutation}) is fatal, never repaired`, async () => {
    const f = repo();
    try {
      const mutate = () => {
        if (mutation === "outside")
          writeFileSync(join(f.cwd, "untracked.txt"), "changed\n");
        if (mutation === "delete") rmSync(join(f.cwd, "worker.txt"));
        if (mutation === "stage") f.git("add", "worker.txt");
        if (mutation === "rename") f.git("branch", "-m", "other-branch");
        if (mutation === "reviewer")
          writeFileSync(join(f.cwd, "worker.txt"), "reviewer edit\n");
      };
      const worker = new Scripted([
        async (r) => {
          const result = f.write(r, "fixed");
          if (mutation !== "reviewer") mutate();
          return result;
        },
      ]);
      const reviewer = new Scripted([
        async (r) => {
          mutate();
          return f.receipt(r, '{"approved":true,"reason":"ok"}');
        },
      ]);
      await assert.rejects(
        f
          .runtime()
          .run((r) => workflow(r, f.input, f.agents(worker, reviewer))),
        /scope|Scope|changed after/,
      );
      assert.equal(worker.calls.length, 1);
      assert.equal(reviewer.calls.length, mutation === "reviewer" ? 1 : 0);
    } finally {
      f.close();
    }
  });
}

test("review rejection is ordinary nonacceptance, not another writer turn", async () => {
  const f = repo();
  try {
    const worker = new Scripted([async (r) => f.write(r, "fixed")]);
    const reviewer = new Scripted([
      '{"approved":false,"reason":"insufficient"}',
    ]);
    const result = (await f
      .runtime()
      .run((r) => workflow(r, f.input, f.agents(worker, reviewer)))) as {
      accepted: boolean;
    };
    assert.equal(result.accepted, false);
    assert.equal(worker.calls.length, 1);
  } finally {
    f.close();
  }
});

test("snapshot handles missing tracked source and fails closed on artifact corruption / oversized patch", async () => {
  const f = repo();
  try {
    rmSync(join(f.cwd, "dependency.txt")); // Missing tracked baseline is retained, not fabricated.
    const args = [
      helper,
      "capture",
      ".asf/self-improvement/offline",
      '["worker.txt","new-test.txt"]',
    ];
    mkdirSync(join(f.cwd, ".asf/self-improvement"));
    const snapshot = JSON.parse(
      execFileSync(process.execPath, args, { cwd: f.cwd, encoding: "utf8" }),
    ) as { hash: string };
    const inspectArgs = [
      helper,
      "inspect",
      ".asf/self-improvement/offline",
      snapshot.hash,
    ];
    execFileSync(process.execPath, inspectArgs, { cwd: f.cwd });
    writeFileSync(join(f.cwd, "new-test.txt"), "large\n".repeat(6000));
    assert.throws(
      () =>
        execFileSync(process.execPath, inspectArgs, {
          cwd: f.cwd,
          stdio: "pipe",
        }),
      /Command failed/,
    );
    rmSync(join(f.cwd, "new-test.txt"));
    writeFileSync(
      join(f.cwd, ".asf/self-improvement/offline/0.before"),
      "corrupt\n",
    );
    assert.throws(
      () =>
        execFileSync(process.execPath, inspectArgs, {
          cwd: f.cwd,
          stdio: "pipe",
        }),
      /Command failed/,
    );
  } finally {
    f.close();
  }
});

test("uncertain host command is not resent or repaired on explicit resume", async () => {
  const f = repo();
  try {
    const worker = new Scripted([async (r) => f.write(r, "fixed")]);
    const runtime = f.runtime(),
      original = runtime.command.bind(runtime);
    runtime.command = async (id, argv, options) => {
      if (id === "host-0/check") {
        f.store.action(
          "run",
          id,
          hash({
            argv,
            cwd: runtime.cwd,
            timeoutMs: options?.timeoutMs ?? 60000,
            policy: 1,
          }),
        );
        f.store.reserve("run", id, 0, undefined, undefined, false, "command");
      }
      return original(id, argv, options);
    };
    await assert.rejects(
      runtime.run((r) => workflow(r, f.input, f.agents(worker))),
      /Uncertain command/,
    );
    await assert.rejects(
      f.runtime().run((r) => workflow(r, f.input, f.agents(worker))),
      /Uncertain command/,
    );
    assert.equal(worker.calls.length, 1);
    assert.equal(f.review.calls.length, 0);
  } finally {
    f.close();
  }
});

test("check evidence is invalidated if a host check changes allowed source", async () => {
  const f = repo();
  try {
    const worker = new Scripted([async (r) => f.write(r, "fixed")]);
    const runtime = f.runtime(),
      original = runtime.command.bind(runtime);
    runtime.command = async (id, argv, options) => {
      const result = await original(id, argv, options);
      if (id === "host-0/check")
        writeFileSync(join(f.cwd, "worker.txt"), "changed during check\n");
      return result;
    };
    await assert.rejects(
      runtime.run((r) => workflow(r, f.input, f.agents(worker))),
      /changed during host checks/,
    );
    assert.equal(worker.calls.length, 1);
    assert.equal(f.review.calls.length, 0);
  } finally {
    f.close();
  }
});

test("review correction exhaustion is fatal without more writer turns", async () => {
  const f = repo();
  try {
    const worker = new Scripted([async (r) => f.write(r, "fixed")]);
    const reviewer = new Scripted(["invalid", "still invalid"]);
    await assert.rejects(
      f.runtime().run((r) => workflow(r, f.input, f.agents(worker, reviewer))),
      /Output validation failed/,
    );
    assert.equal(worker.calls.length, 1);
    assert.equal(reviewer.calls.length, 2);
  } finally {
    f.close();
  }
});

test("truncated source descriptor fails closed before writer", async () => {
  const f = repo();
  try {
    const worker = new Scripted(),
      runtime = f.runtime();
    runtime.command = async () => ({
      code: 0,
      signal: null,
      cancelled: false,
      truncated: true,
      stdout: "{}",
      stderr: "",
    });
    await assert.rejects(
      runtime.run((r) => workflow(r, f.input, f.agents(worker))),
      /scope\/snapshot failed/,
    );
    assert.equal(worker.calls.length, 0);
  } finally {
    f.close();
  }
});

test("task bounds are validated before any model dispatch", async () => {
  const f = repo();
  try {
    const worker = new Scripted();
    await assert.rejects(
      f
        .runtime()
        .run((r) =>
          workflow(
            r,
            { task: "x", editFiles: ["worker.txt"], maxRepairs: 4 },
            f.agents(worker),
          ),
        ),
      /maxRepairs/,
    );
    assert.equal(worker.calls.length, 0);
  } finally {
    f.close();
  }
});

test("CLI is inert without arguments/with help, and rejects incomplete live acknowledgement before IO", () => {
  const f = fixture();
  try {
    for (const args of [
      [],
      ["--help"],
      ["--help", "--live", "--db", join(f.dir, "no.db")],
    ]) {
      const result = spawnSync(
        process.execPath,
        [resolve("node_modules/tsx/dist/cli.mjs"), cli, ...args],
        { cwd: f.dir, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Trusted self-improvement/);
    }
    const result = spawnSync(
      process.execPath,
      [resolve("node_modules/tsx/dist/cli.mjs"), cli, "--live"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--config required/);
    assert.throws(() => readFileSync(join(f.dir, "no.db")));
  } finally {
    f.close();
  }
});

test("dirty baseline hashes a tracked 14 MiB binary asset without copying it; outside change fails", () => {
  const f = repo();
  try {
    const asset = join(f.cwd, "public.webm");
    writeFileSync(asset, Buffer.alloc(14332852, 7));
    f.git("add", "public.webm");
    const artifact = ".asf/self-improvement/asset";
    const snapshot = JSON.parse(
      execFileSync(
        process.execPath,
        [helper, "capture", artifact, '["worker.txt"]'],
        { cwd: f.cwd, encoding: "utf8" },
      ),
    ) as { hash: string };
    const inspect = () =>
      execFileSync(
        process.execPath,
        [helper, "inspect", artifact, snapshot.hash],
        { cwd: f.cwd, stdio: "pipe" },
      );
    assert.doesNotThrow(inspect);
    const manifest = JSON.parse(
      readFileSync(join(f.cwd, artifact, "manifest.json"), "utf8"),
    ) as {
      baseline: { files: Record<string, { size: number; hash: string }> };
    };
    assert.equal(manifest.baseline.files["public.webm"]!.size, 14332852);
    assert.match(
      manifest.baseline.files["public.webm"]!.hash,
      /^[a-f0-9]{64}$/,
    );
    assert.equal(
      readFileSync(join(f.cwd, artifact, "0.before"), "utf8"),
      "original\n",
    );
    assert.throws(() => readFileSync(join(f.cwd, artifact, "1.before")));
    writeFileSync(asset, Buffer.alloc(14332852, 8));
    assert.throws(inspect, /Scope violation: public.webm/);
  } finally {
    f.close();
  }
});

test("allowed text still has a 1 MiB copy limit at capture and inspection", () => {
  const f = repo();
  try {
    const capture = (id: string) =>
      execFileSync(
        process.execPath,
        [helper, "capture", `.asf/self-improvement/${id}`, '["worker.txt"]'],
        { cwd: f.cwd, encoding: "utf8", stdio: "pipe" },
      );
    const snapshot = JSON.parse(capture("small")) as { hash: string };
    writeFileSync(join(f.cwd, "worker.txt"), "x".repeat(1024 * 1024 + 1));
    assert.throws(() => capture("large"), /oversized source\/artifact/);
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [helper, "inspect", ".asf/self-improvement/small", snapshot.hash],
          { cwd: f.cwd, stdio: "pipe" },
        ),
      /oversized source\/artifact/,
    );
  } finally {
    f.close();
  }
});

for (const phase of ["coder", "repair", "review", "correction"] as const) {
  for (const changed of [false, true]) {
    test(`pre-reservation ${phase} resume ${changed ? "blocks changed allowed source" : "continues unchanged source"}`, async () => {
      const f = repo();
      try {
        const worker = new Scripted([
          async (r) => f.write(r, phase === "repair" ? "bad" : "fixed"),
          async (r) => f.write(r, "fixed"),
        ]);
        const reviewer = new Scripted(
          phase === "correction"
            ? ["NOT_JSON", '{"approved":true,"reason":"checked"}']
            : ['{"approved":true,"reason":"checked"}'],
        );
        let stop = true,
          workerPreflights = 0,
          reviewPreflights = 0;
        worker.preflight = async () => {
          workerPreflights++;
          if (
            stop &&
            ((phase === "coder" && worker.calls.length === 0) ||
              (phase === "repair" && worker.calls.length === 1))
          )
            throw new Error("offline stop before reservation");
        };
        reviewer.preflight = async () => {
          reviewPreflights++;
          if (
            stop &&
            ((phase === "review" && reviewer.calls.length === 0) ||
              (phase === "correction" && reviewer.calls.length === 1))
          )
            throw new Error("offline stop before reservation");
        };
        const run = () =>
          f
            .runtime()
            .run((r) => workflow(r, f.input, f.agents(worker, reviewer)));
        await assert.rejects(run(), /offline stop before reservation/);
        const reservations = () =>
          f.store
            .inspect("run", 0, 200)
            .invocations.filter((i) => i.kind === "model");
        const before = reservations(),
          calls = worker.calls.length + reviewer.calls.length;
        const preflights = workerPreflights + reviewPreflights;
        assert.equal(before.length, calls);
        const blockedId =
          phase === "coder"
            ? "coder/write"
            : phase === "repair"
              ? "coder/repair-1"
              : "review/readonly";
        assert.equal(
          f.store.inspect("run", 0, 200).actions.find((a) => a.id === blockedId)
            ?.status,
          "pending",
        );
        stop = false;
        if (changed) {
          writeFileSync(
            join(f.cwd, "worker.txt"),
            "externally changed allowed source\n",
          );
          await assert.rejects(run(), /Source changed before new model send/);
          assert.deepEqual(reservations(), before);
          assert.equal(worker.calls.length + reviewer.calls.length, calls);
          assert.equal(workerPreflights + reviewPreflights, preflights); // Guard precedes real preflight.
        } else {
          assert.equal(((await run()) as { accepted: boolean }).accepted, true);
          const completed = reservations();
          assert.equal(((await run()) as { accepted: boolean }).accepted, true);
          assert.deepEqual(reservations(), completed);
          if (phase === "repair")
            assert.equal(worker.calls[1]?.session?.nativeId, "session");
          if (phase === "correction")
            assert.equal(reviewer.calls[1]?.session?.nativeId, "native-1");
        }
      } finally {
        f.close();
      }
    });
  }
}

test("native receipt replay skips obsolete initial source gate without resending writer", async () => {
  const f = repo();
  try {
    const worker = new Scripted([async (r) => f.write(r, "fixed")]);
    const original = f.store.finishAction.bind(f.store);
    f.store.finishAction = (run, id, result, error) => {
      if (id === "coder/write")
        throw new Error("offline stop after native receipt");
      original(run, id, result, error);
    };
    const run = () =>
      f.runtime().run((r) => workflow(r, f.input, f.agents(worker)));
    await assert.rejects(run(), /offline stop after native receipt/);
    assert.ok(
      f.store
        .inspect("run", 0, 200)
        .invocations.find((i) => i.action === "coder/write")?.receipt,
    );
    f.store.finishAction = original;
    assert.equal(((await run()) as { accepted: boolean }).accepted, true);
    assert.equal(worker.calls.length, 1);
    assert.equal(f.review.calls.length, 1);
  } finally {
    f.close();
  }
});

test("capture-truncated failure with omitted diagnostics stops without paid repair or check resend", async () => {
  const f = repo();
  try {
    writeFileSync(
      join(f.cwd, "check.mjs"),
      `import{readFileSync}from'node:fs';console.log('x'.repeat(80000));if(readFileSync('worker.txt','utf8').includes('bad')){console.log('not ok 1 - omitted failure\\nAssertionError: omitted');process.exit(1);}`,
    );
    const worker = new Scripted([async (r) => f.write(r, "bad")]);
    const run = () =>
      f.runtime().run((r) => workflow(r, f.input, f.agents(worker)));
    const result = (await run()) as {
      accepted: boolean;
      reason: string;
      checks: { check: { stdout: string; truncated: boolean } };
    };
    assert.equal(result.accepted, false);
    assert.match(result.reason, /diagnostic-unavailable/);
    assert.equal(result.checks.check.truncated, true);
    assert.doesNotMatch(
      result.checks.check.stdout,
      /omitted failure|AssertionError/,
    );
    assert.equal(worker.calls.length, 1);
    assert.equal(f.review.calls.length, 0);
    const before = f.store.inspect("run", 0, 200).invocations;
    assert.deepEqual(await run(), result);
    assert.deepEqual(f.store.inspect("run", 0, 200).invocations, before);
    assert.equal(worker.calls.length, 1);
  } finally {
    f.close();
  }
});

test("review-only candidate uses trusted host formatting, checks and fresh reviewer without a writer", async () => {
  const f = repo();
  try {
    writeFileSync(join(f.cwd, "worker.json"), '{"value":1}\n');
    writeFileSync(join(f.cwd, "new-test.json"), '{"test":true}\n');
    const worker = new Scripted();
    const input: Json = {
      ...(f.input as { [key: string]: Json }),
      editFiles: ["worker.json", "new-test.json"],
      reviewOnly: true,
      formatFiles: true,
    };
    const run = () =>
      f.runtime().run((r) => workflow(r, input, f.agents(worker)));
    const result = (await run()) as {
      accepted: boolean;
      change: { patch: string };
    };
    assert.equal(result.accepted, true);
    assert.equal(worker.calls.length, 0);
    assert.equal(f.review.calls.length, 1);
    assert.equal(f.review.calls[0]?.mode, "read-only");
    assert.equal(f.review.calls[0]?.session, undefined);
    assert.equal(
      readFileSync(join(f.cwd, "worker.json"), "utf8"),
      '{ "value": 1 }\n',
    );
    assert.match(result.change.patch, /value/);
    const before = f.store.inspect("run", 0, 200).invocations;
    assert.deepEqual(await run(), result);
    assert.deepEqual(f.store.inspect("run", 0, 200).invocations, before);
    assert.equal(f.review.calls.length, 1);
  } finally {
    f.close();
  }
});

test("optional host formatter runs after writer and before acceptance checks", async () => {
  const f = repo();
  try {
    writeFileSync(join(f.cwd, "worker.json"), '{ "value": 0 }\n');
    const worker = new Scripted([
      async (r) => {
        writeFileSync(join(f.cwd, "worker.json"), '{"value":1}\n');
        writeFileSync(join(f.cwd, "new-test.json"), '{"test":true}\n');
        return f.receipt(r);
      },
    ]);
    const input: Json = {
      ...(f.input as { [key: string]: Json }),
      editFiles: ["worker.json", "new-test.json"],
      formatFiles: true,
    };
    const result = (await f
      .runtime()
      .run((r) => workflow(r, input, f.agents(worker)))) as {
      accepted: boolean;
      checks: { format: { code: number } };
    };
    assert.equal(result.accepted, true);
    assert.equal(result.checks.format.code, 0);
    assert.equal(worker.calls.length, 1);
    assert.equal(f.review.calls.length, 1);
    assert.equal(
      readFileSync(join(f.cwd, "worker.json"), "utf8"),
      '{ "value": 1 }\n',
    );
  } finally {
    f.close();
  }
});

test("review-only reuse preserves original implementation patch and verified scope evidence", async () => {
  const f = repo();
  try {
    const worker = new Scripted([async (r) => f.write(r, "fixed")]);
    const original = (await f
      .runtime()
      .run((r) => workflow(r, f.input, f.agents(worker)))) as {
      snapshot: Json;
      change: { patch: string };
    };
    const reviewer = new Scripted([
      '{"approved":true,"reason":"original scope checked"}',
    ]);
    const input: Json = {
      ...(f.input as { [key: string]: Json }),
      reviewOnly: true,
      snapshot: original.snapshot,
    };
    const result = (await f
      .runtime({ runId: "review-run", workflowIdentity: "review-only-v1" })
      .run((r) => workflow(r, input, f.agents(worker, reviewer)))) as {
      accepted: boolean;
      change: { patch: string };
    };
    assert.equal(result.accepted, true);
    assert.equal(result.change.patch, original.change.patch);
    assert.match(result.change.patch, /-original/);
    assert.match(result.change.patch, /new regression/);
    assert.match(reviewer.calls[0]!.prompt, /scopeEvidence/);
    assert.match(reviewer.calls[0]!.prompt, /patchBytes/);
    assert.match(reviewer.calls[0]!.prompt, /HEAD\/branch\/index/);
    assert.equal(worker.calls.length, 1);
    assert.equal(reviewer.calls.length, 1);
  } finally {
    f.close();
  }
});

test("reused snapshot requires exact task allowlist before any new send", async () => {
  const f = repo();
  try {
    const worker = new Scripted([async (r) => f.write(r, "fixed")]);
    const original = (await f
      .runtime()
      .run((r) => workflow(r, f.input, f.agents(worker)))) as {
      snapshot: Json;
    };
    const reviewer = new Scripted([
      '{"approved":true,"reason":"must not send"}',
    ]);
    const input: Json = {
      ...(f.input as { [key: string]: Json }),
      editFiles: ["worker.txt"],
      reviewOnly: true,
      snapshot: original.snapshot,
    };
    await assert.rejects(
      f
        .runtime({
          runId: "review-mismatch",
          workflowIdentity: "review-mismatch-v1",
        })
        .run((r) => workflow(r, input, f.agents(worker, reviewer))),
      /Snapshot edit-file allowlist differs/,
    );
    assert.equal(worker.calls.length, 1);
    assert.equal(reviewer.calls.length, 0);
  } finally {
    f.close();
  }
});

test("review-only formatter failure sends no model request", async () => {
  const f = repo();
  try {
    const worker = new Scripted();
    const input: Json = {
      ...(f.input as { [key: string]: Json }),
      editFiles: ["missing.json"],
      reviewOnly: true,
      formatFiles: true,
    };
    const result = (await f
      .runtime()
      .run((r) => workflow(r, input, f.agents(worker)))) as {
      accepted: boolean;
      reason: string;
    };
    assert.equal(result.accepted, false);
    assert.match(result.reason, /formatter failed/);
    assert.equal(worker.calls.length, 0);
    assert.equal(f.review.calls.length, 0);
  } finally {
    f.close();
  }
});
