import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import {
  CandidateVerifier,
  verifyCandidate,
  type Candidate,
} from "../src/verification.js";
import {
  verificationParents,
  runCandidateParent,
  runStandaloneVerification,
} from "../examples/candidate-verification.js";
import { fixture, Scripted, accounting } from "./helpers.js";
import type { Receipt } from "../src/types.js";

const approved = JSON.stringify({
  verdict: "approved",
  reason: "Fixed checks and candidate satisfy the task",
});
function setup(
  checkCode = "process.exit(0)",
  responses: ConstructorParameters<typeof Scripted>[0] = [approved],
) {
  const f = fixture();
  const repository = join(f.dir, "repository");
  mkdirSync(repository);
  const git = (argv: string[], input?: string) =>
    execFileSync("git", argv, {
      cwd: repository,
      input,
      stdio: ["pipe", "pipe", "pipe"],
    }).toString();
  git(["init", "--quiet"]);
  git(["config", "user.name", "Offline Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repository, ".gitignore"), ".asf/\nignored.txt\n");
  writeFileSync(join(repository, "source.txt"), "before\n");
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "fixture baseline"]);
  writeFileSync(join(repository, "source.txt"), "candidate\n");
  const reviewer = new Scripted(responses);
  const verifier = new CandidateVerifier({
    repository,
    base: "HEAD",
    revision: "candidate-test-v1",
    checks: [{ name: "fixed", argv: [process.execPath, "-e", checkCode] }],
    reviewer: { harness: reviewer, model: "test-model", mode: "read-only" },
  });
  const runtime = (runId = "run") => f.runtime({ cwd: repository, runId });
  const capture = () =>
    runtime().run((r) => verifier.capture(r.scope("source")));
  const run = (candidate: Candidate, task = "Review candidate") =>
    runtime().run(async (r) => {
      const result = await r.workflow("verification", verifier.definition, {
        candidate,
        task,
      });
      verifier.requireCurrent(result.value);
      return result;
    });
  const unlock = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      chmodSync(path, 0o700);
      for (const item of readdirSync(path)) unlock(join(path, item));
    }
  };
  return {
    ...f,
    repository,
    git,
    reviewer,
    verifier,
    runtime,
    capture,
    run,
    close: () => {
      unlock(f.dir);
      f.close();
    },
  };
}
function receipt(text: string): Receipt {
  return {
    status: "succeeded",
    text,
    accounting,
    session: { nativeId: "review-owned", baseline: 1 },
  };
}

test("standalone fixed checks and fresh review run on frozen bytes and replay without sends", async () => {
  const f = setup(
    "if(require('node:fs').readFileSync('source.txt','utf8')!=='candidate\\n')process.exit(1)",
  );
  try {
    const result = await runStandaloneVerification(
      f.runtime(),
      f.verifier,
      "Review candidate",
    );
    const candidate = result.value.candidate;
    assert.equal(result.passed, true);
    assert.equal(result.value.verdict, "approved");
    assert.equal(result.value.checks[0]?.status, "passed");
    assert.equal(f.reviewer.calls.length, 1);
    assert.equal(f.reviewer.calls[0]?.cwd, candidate.directory);
    assert.equal(f.reviewer.calls[0]?.mode, "read-only");
    assert.equal(f.reviewer.calls[0]?.session, undefined);
    assert.equal(
      readFileSync(join(candidate.directory, "source.txt"), "utf8"),
      "candidate\n",
    );
    assert.equal(
      lstatSync(join(candidate.directory, "source.txt")).mode & 0o777,
      0o444,
    );
    assert.match(f.reviewer.calls[0]!.prompt, /before/);
    assert.match(f.reviewer.calls[0]!.prompt, /candidate/);
    assert.deepEqual(
      await runStandaloneVerification(
        f.runtime(),
        f.verifier,
        "Review candidate",
      ),
      result,
    );
    assert.equal(f.reviewer.calls.length, 1);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) n FROM ledger").get()?.n,
      3,
    );
  } finally {
    f.close();
  }
});

test("two different parents reuse one definition, guard cached root and require an explicit repair attempt", async () => {
  const f = setup("process.exit(0)", [approved, approved, approved]);
  const { delivery, existingPr } = verificationParents(f.verifier);
  const run = (definition: typeof delivery, attempt = 1) =>
    runCandidateParent(
      f.runtime(),
      f.verifier,
      definition,
      "Review candidate",
      attempt,
    );
  try {
    const first = await run(delivery);
    const second = await run(existingPr);
    assert.equal(first.passed && second.passed, true);
    assert.equal(f.reviewer.calls.length, 2);
    assert.notEqual(
      first.provenance.invocationId,
      second.provenance.invocationId,
    );
    assert.equal(
      first.value.candidate.identity,
      second.value.candidate.identity,
    );
    assert.deepEqual(await run(delivery), first);
    assert.equal(f.reviewer.calls.length, 2);
    writeFileSync(join(f.repository, "source.txt"), "repaired\n");
    await assert.rejects(() => run(delivery), /Original candidate changed/);
    assert.equal(f.reviewer.calls.length, 2);
    const repaired = await run(delivery, 2);
    assert.equal(repaired.passed, true);
    assert.notEqual(
      repaired.value.candidate.identity,
      first.value.candidate.identity,
    );
    assert.equal(f.reviewer.calls.length, 3);
    assert.equal(f.reviewer.calls[2]?.session, undefined);
  } finally {
    f.close();
  }
});

test("capture binds deletion, executable mode and symlink target text without following the link", async () => {
  const f = setup();
  try {
    unlinkSync(join(f.repository, "source.txt"));
    writeFileSync(join(f.repository, "executable"), "echo fixture\n");
    chmodSync(join(f.repository, "executable"), 0o755);
    const secret = join(f.dir, "outside-private-fixture");
    writeFileSync(secret, "OUTSIDE_BYTES_MUST_NOT_COPY");
    symlinkSync(secret, join(f.repository, "link"));
    const candidate = await f.capture();
    verifyCandidate(candidate);
    assert.equal(
      lstatSync(join(candidate.directory, "link")).isSymbolicLink(),
      false,
    );
    assert.equal(
      readFileSync(join(candidate.directory, "link"), "utf8"),
      secret,
    );
    assert.equal(
      lstatSync(join(candidate.directory, "executable")).mode & 0o777,
      0o555,
    );
    const manifest = readFileSync(
      join(dirname(candidate.directory), "manifest.json"),
      "utf8",
    );
    assert.match(manifest, /deleted/);
    assert.ok(!manifest.includes("OUTSIDE_BYTES_MUST_NOT_COPY"));
    await f.run(candidate);
  } finally {
    f.close();
  }
});

test("original contents, mode, new files, index and HEAD invalidate a captured candidate", async () => {
  for (const mutate of [
    (f: ReturnType<typeof setup>) =>
      writeFileSync(join(f.repository, "source.txt"), "changed"),
    (f: ReturnType<typeof setup>) =>
      chmodSync(join(f.repository, "source.txt"), 0o755),
    (f: ReturnType<typeof setup>) =>
      writeFileSync(join(f.repository, "new.txt"), "new"),
    (f: ReturnType<typeof setup>) => f.git(["add", "source.txt"]),
    (f: ReturnType<typeof setup>) =>
      f.git(["commit", "--allow-empty", "--quiet", "-m", "new head"]),
  ]) {
    const f = setup();
    try {
      const candidate = await f.capture();
      mutate(f);
      assert.throws(
        () => verifyCandidate(candidate),
        /Original candidate changed/,
      );
      assert.equal(f.reviewer.calls.length, 0);
    } finally {
      f.close();
    }
  }
});

test("ignored file changes do not enter the public candidate boundary", async () => {
  const f = setup();
  try {
    const candidate = await f.capture();
    writeFileSync(join(f.repository, "ignored.txt"), "ignored fixture");
    verifyCandidate(candidate);
    assert.equal((await f.run(candidate)).passed, true);
  } finally {
    f.close();
  }
});

test("bounded binary assets above the old 1 MiB limit are copied and changes stay candidate-bound", async () => {
  const f = setup();
  const data = Buffer.alloc(2 * 1024 * 1024);
  try {
    writeFileSync(join(f.repository, "public-asset.bin"), data);
    f.git(["add", "public-asset.bin"]);
    f.git(["commit", "--quiet", "-m", "public binary fixture"]);
    const verifier = new CandidateVerifier({
      repository: f.repository,
      base: "HEAD",
      revision: "binary-bound-v1",
      checks: [
        { name: "fixed", argv: [process.execPath, "-e", "process.exit(0)"] },
      ],
      reviewer: { harness: f.reviewer, model: "test-model", mode: "read-only" },
    });
    const first = await f
      .runtime()
      .run((r) => verifier.capture(r.scope("binary")));
    verifyCandidate(first);
    assert.deepEqual(
      readFileSync(join(first.directory, "public-asset.bin")),
      data,
    );
    data[data.length - 1] = 1;
    writeFileSync(join(f.repository, "public-asset.bin"), data);
    assert.throws(() => verifyCandidate(first), /Original candidate changed/);
    const second = await f
      .runtime("changed-binary")
      .run((r) => verifier.capture(r.scope("binary")));
    verifyCandidate(second);
    assert.notEqual(first.identity, second.identity);
    assert.deepEqual(
      readFileSync(join(second.directory, "public-asset.bin")),
      data,
    );
    const manifest = readFileSync(
      join(dirname(second.directory), "manifest.json"),
      "utf8",
    );
    assert.match(manifest, /binary SHA-256/);
  } finally {
    f.close();
  }
});

test("fixed checks cannot accidentally discover the original ancestor Git repository", async () => {
  const f = setup(
    "const r=require('node:child_process').spawnSync('git',['rev-parse','--show-toplevel']);if(r.status===0)process.exit(8)",
  );
  try {
    const candidate = await f.capture();
    assert.equal((await f.run(candidate)).passed, true);
  } finally {
    f.close();
  }
});

test("mutating the frozen snapshot during a fixed check stops before reviewer dispatch", async () => {
  const f = setup(
    "const fs=require('node:fs');fs.chmodSync('source.txt',0o644);fs.writeFileSync('source.txt','edited snapshot')",
  );
  try {
    const candidate = await f.capture();
    await assert.rejects(() => f.run(candidate), /snapshot changed/);
    await assert.rejects(() => f.run(candidate));
    assert.equal(f.reviewer.calls.length, 0);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) n FROM ledger").get()?.n,
      2,
    );
  } finally {
    f.close();
  }
});

test("reviewer edits stop after the native receipt is retained", async () => {
  let original = "";
  const f = setup("process.exit(0)", [
    async (_request, sink) => {
      writeFileSync(original, "reviewer changed source");
      sink.report("terminal", accounting);
      return receipt(approved);
    },
  ]);
  original = join(f.repository, "source.txt");
  try {
    const candidate = await f.capture();
    await assert.rejects(() => f.run(candidate), /Original candidate changed/);
    assert.equal(f.reviewer.calls.length, 1);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) n FROM ledger").get()?.n,
      3,
    );
    const raw = f.store.db
      .prepare("SELECT receipt FROM invocations WHERE kind='model'")
      .get()?.receipt;
    assert.equal(JSON.parse(String(raw)).status, "succeeded");
  } finally {
    f.close();
  }
});

test("known check failure and missing executable are nonacceptance; no review model runs", async () => {
  const f = setup(
    "process.stdout.write('retained out');process.stderr.write('retained err');process.exit(7)",
  );
  try {
    const candidate = await f.capture();
    const result = await f.run(candidate);
    assert.equal(result.passed, false);
    assert.equal(result.value.verdict, "changes_requested");
    assert.equal(result.value.checks[0]?.code, 7);
    assert.equal(result.value.checks[0]?.stdout, "retained out");
    assert.equal(result.value.checks[0]?.stderr, "retained err");
    assert.equal(f.reviewer.calls.length, 0);
  } finally {
    f.close();
  }
  const unavailable = setup();
  try {
    const verifier = new CandidateVerifier({
      repository: unavailable.repository,
      base: "HEAD",
      revision: "unavailable",
      checks: [
        {
          name: "missing",
          argv: [join(unavailable.dir, "missing-executable")],
        },
      ],
      reviewer: {
        harness: unavailable.reviewer,
        model: "test-model",
        mode: "read-only",
      },
    });
    const result = await unavailable.runtime().run(async (r) => {
      const candidate = await verifier.capture(r.scope("candidate"));
      return r.workflow("verification", verifier.definition, {
        candidate,
        task: "Review",
      });
    });
    assert.equal(result.value.verdict, "unavailable");
    assert.equal(result.value.checks[0]?.status, "unavailable");
    assert.equal(unavailable.reviewer.calls.length, 0);
  } finally {
    unavailable.close();
  }
});

test("signal-ending check and malformed/native-failed reviewer remain execution failures", async () => {
  const killed = setup("process.kill(process.pid,'SIGTERM')");
  try {
    const candidate = await killed.capture();
    await assert.rejects(() => killed.run(candidate), /ordinary exit/);
    assert.equal(killed.reviewer.calls.length, 0);
  } finally {
    killed.close();
  }
  for (const response of [
    "malformed",
    async (
      _request: unknown,
      sink: { report: (key: string, value: typeof accounting) => void },
    ): Promise<Receipt> => {
      sink.report("failed", accounting);
      return {
        ...receipt("failed"),
        status: "failed",
        error: "native review failed",
      };
    },
  ]) {
    const f = setup("process.exit(0)", [response]);
    try {
      const candidate = await f.capture();
      await assert.rejects(() => f.run(candidate));
      await assert.rejects(() => f.run(candidate));
      assert.equal(f.reviewer.calls.length, 1);
    } finally {
      f.close();
    }
  }
});

test("typed reviewer unavailable is completed business data", async () => {
  const f = setup("process.exit(0)", [
    JSON.stringify({ verdict: "unavailable", reason: "Insufficient evidence" }),
  ]);
  try {
    const candidate = await f.capture();
    const result = await f.run(candidate);
    assert.equal(result.passed, false);
    assert.equal(result.value.verdict, "unavailable");
    assert.equal(
      f.store.db.prepare("SELECT status FROM workflows").get()?.status,
      "completed",
    );
  } finally {
    f.close();
  }
});

test("consumption rejects altered review bindings, check contracts and inconsistent approval", async () => {
  const f = setup();
  try {
    const candidate = await f.capture();
    const { value } = await f.run(candidate);
    assert.throws(
      () =>
        f.verifier.requireCurrent({ ...value, contractIdentity: "changed" }),
      /contract changed/,
    );
    const wrongCheck = structuredClone(value);
    wrongCheck.checks[0]!.argv = ["another-check"];
    assert.throws(
      () => f.verifier.requireCurrent(wrongCheck),
      /check contract/,
    );
    const contradictory = structuredClone(value);
    contradictory.checks[0]!.code = 7;
    assert.throws(
      () => f.verifier.requireCurrent(contradictory),
      /contradicts its evidence/,
    );
    f.reviewer.identity = { adapter: "scripted", v: 2 };
    assert.throws(
      () => f.verifier.requireCurrent(value),
      /reviewer binding changed/,
    );
    assert.equal(f.reviewer.calls.length, 1);
  } finally {
    f.close();
  }
});

test("fixed-check timeout drains its child process and replay does not start it again", async () => {
  const f = setup();
  const marker = join(f.dir, "check-child-pid");
  const verifier = new CandidateVerifier({
    repository: f.repository,
    base: "HEAD",
    revision: "timeout-proof",
    checks: [
      {
        name: "timeout",
        argv: [
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`,
        ],
        timeoutMs: 300,
      },
    ],
    reviewer: { harness: f.reviewer, model: "test-model", mode: "read-only" },
  });
  const run = () =>
    f.runtime().run(async (r) => {
      const candidate = await verifier.capture(r.scope("candidate"));
      return r.workflow("verification", verifier.definition, {
        candidate,
        task: "Review",
      });
    });
  try {
    await assert.rejects(run);
    const childPid = Number(readFileSync(marker, "utf8"));
    assert.throws(
      () => process.kill(childPid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
    await assert.rejects(run);
    assert.equal(readFileSync(marker, "utf8"), String(childPid));
    assert.equal(f.reviewer.calls.length, 0);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) n FROM ledger").get()?.n,
      2,
    );
  } finally {
    f.close();
  }
});

test("snapshot tampering cannot be legitimized by changing its manifest hash", async () => {
  const f = setup();
  try {
    const candidate = await f.capture(),
      path = join(candidate.directory, "source.txt");
    chmodSync(path, 0o644);
    writeFileSync(path, "forged");
    chmodSync(path, 0o444);
    const manifestPath = join(dirname(candidate.directory), "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.snapshotFiles["source.txt"].hash = createHash("sha256")
      .update("forged")
      .digest("hex");
    manifest.snapshotFiles["source.txt"].bytes = 6;
    const raw = JSON.stringify(manifest);
    chmodSync(manifestPath, 0o600);
    writeFileSync(manifestPath, raw);
    chmodSync(manifestPath, 0o400);
    assert.throws(
      () =>
        verifyCandidate({
          ...candidate,
          manifestHash: createHash("sha256").update(raw).digest("hex"),
        }),
      /differs from original bytes/,
    );
  } finally {
    f.close();
  }
});

test("unsafe/private files, unmerged index and oversized candidates reject capture before any review", async () => {
  for (const mutate of [
    (f: ReturnType<typeof setup>) =>
      writeFileSync(join(f.repository, ".env"), "private fixture"),
    (f: ReturnType<typeof setup>) =>
      writeFileSync(
        join(f.repository, "large"),
        Buffer.alloc(16 * 1024 * 1024 + 1),
      ),
    (f: ReturnType<typeof setup>) => {
      const asset = Buffer.alloc(12 * 1024 * 1024);
      for (const name of ["one.bin", "two.bin", "three.bin"])
        writeFileSync(join(f.repository, name), asset);
    },
    (f: ReturnType<typeof setup>) => {
      const blob = f.git(["rev-parse", "HEAD:source.txt"]).trim();
      f.git(
        ["update-index", "--index-info"],
        `0 ${"0".repeat(40)}\tsource.txt\n100644 ${blob} 1\tsource.txt\n100644 ${blob} 2\tsource.txt\n`,
      );
    },
  ]) {
    const f = setup();
    try {
      mutate(f);
      await assert.rejects(f.capture);
      assert.equal(f.reviewer.calls.length, 0);
    } finally {
      f.close();
    }
  }
});
