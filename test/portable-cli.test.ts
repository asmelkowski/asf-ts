import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { portableFixture } from "./portable-fixtures.js";
import { compileDocument, loadTargetBindings } from "../src/portable/files.js";
const cli = resolve("src/cli.ts");
function run(args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}
test("file pipeline validates, generates TS outside UI, runs equivalent results and replays", () => {
  const dir = mkdtempSync(join(tmpdir(), "asf-ts-cli-"));
  try {
    const source = join(dir, "flow.json"),
      driver = join(dir, "driver.ts"),
      db = join(dir, "store.db"),
      svg = join(dir, "flow.svg"),
      bundle = join(dir, "flow.asfb");
    writeFileSync(source, JSON.stringify(portableFixture()));
    run(["validate", "--file", source]);
    run(["compile", "--file", source, "--output", driver]);
    run(["render", "--file", source, "--output", svg]);
    run(["bundle", "--file", source, "--output", bundle]);
    run(["verify-bundle", "--file", bundle]);
    const direct = run([
      "run-file",
      "--file",
      source,
      "--run",
      "direct",
      "--db",
      db,
      "--input",
      '{"ok":false}',
    ]);
    assert.deepEqual(direct.value, { ok: false });
    assert.equal(direct.passed, false);
    const generated = run([
      "run",
      "--workflow",
      driver,
      "--run",
      "generated",
      "--db",
      db,
      "--input",
      '{"ok":false}',
    ]);
    assert.deepEqual(generated, direct.value);
    assert.deepEqual(
      run([
        "resume-file",
        "--file",
        source,
        "--run",
        "direct",
        "--db",
        db,
        "--input",
        '{"ok":false}',
      ]),
      direct,
    );
    assert.ok(readFileSync(svg, "utf8").includes("review"));
    const exists = spawnSync(
      process.execPath,
      ["--import", "tsx", cli, "compile", "--file", source, "--output", driver],
      { encoding: "utf8" },
    );
    assert.notEqual(exists.status, 0);
    assert.match(exists.stderr, /EEXIST/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("generated TS syntax types match public runtime API", () => {
  const dir = mkdtempSync(join(tmpdir(), "asf-ts-driver-"));
  try {
    const driver = join(dir, "generated.ts");
    writeFileSync(driver, compileDocument(portableFixture()));
    const result = spawnSync(
      process.execPath,
      [
        "node_modules/typescript/bin/tsc",
        "--noEmit",
        "--skipLibCheck",
        "--strict",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--target",
        "ES2023",
        driver,
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("explicit target file source changes bind replay and generated loading rejects stale code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "asf-ts-targets-"));
  try {
    const target = join(dir, "targets.mjs");
    writeFileSync(target, "export const bindings = {};\n");
    const a = await loadTargetBindings(target);
    assert.deepEqual(a, {});
    const source = compileDocument(portableFixture(), {
      targets: target,
      runtimeImport: pathToFileURL(resolve("src/portable/index.ts")).href,
    });
    writeFileSync(target, "export const bindings = {}; // changed\n");
    assert.ok(source.includes("loadTargetBindings"));
    const driver = join(dir, "generated.mts");
    writeFileSync(driver, source);
    const imported = (await import(pathToFileURL(driver).href)) as {
      workflow: (...args: unknown[]) => Promise<unknown>;
    };
    await assert.rejects(imported.workflow(null, null, {}), /source changed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account-free ADK example validates and executes identically through file and generated CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "asf-ts-adk-cli-"));
  try {
    const source = resolve("examples/portable/adk.yaml"),
      targets = resolve("examples/portable/adk-targets.ts"),
      driver = join(dir, "adk.mts"),
      db = join(dir, "store.db");
    const report = run(["validate", "--file", source]);
    assert.ok(report.identity);
    run([
      "compile",
      "--file",
      source,
      "--targets",
      targets,
      "--output",
      driver,
    ]);
    const direct = run([
      "run-file",
      "--file",
      source,
      "--targets",
      targets,
      "--db",
      db,
      "--run",
      "direct",
      "--input",
      "{}",
    ]);
    assert.deepEqual(direct.value, { ok: true, marker: "local-adk" });
    assert.equal(direct.passed, true);
    const replay = run([
      "resume-file",
      "--file",
      source,
      "--targets",
      targets,
      "--db",
      db,
      "--run",
      "direct",
      "--input",
      "{}",
    ]);
    assert.deepEqual(replay, direct);
    const generated = run([
      "run",
      "--workflow",
      driver,
      "--db",
      db,
      "--run",
      "generated",
      "--input",
      "{}",
    ]);
    assert.deepEqual(generated, direct.value);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
