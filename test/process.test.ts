import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { command } from "../src/process.js";
import { CODEX_VERSION, CodexHarness } from "../src/adapters/codex.js";
import { fixture, pricing } from "./helpers.js";
import { sleep } from "../src/util.js";
function running(pid: number): boolean {
  try {
    return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}
async function ready(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  const marked = () =>
    existsSync(path) && readFileSync(path, "utf8").length > 0;
  while (!marked() && Date.now() < deadline) await sleep(10);
  assert.ok(marked(), `readiness marker missing/empty: ${path}`);
}
async function stopped(pid: number): Promise<void> {
  // SIGKILL delivery/exit is asynchronous, including for a non-child descendant.
  const deadline = Date.now() + 1000;
  while (running(pid) && Date.now() < deadline) await sleep(10);
  assert.equal(running(pid), false, `process ${pid} survived cleanup`);
}
test("host command abort kills ready process group including TERM-ignoring grandchild", async () => {
  const f = fixture();
  const controller = new AbortController();
  const grandchild = `process.on("SIGTERM",()=>{});require('fs').writeFileSync('ready',String(process.pid));setInterval(()=>{},100)`;
  const script = `const {spawn}=require('child_process');const f=require('fs');const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});f.writeFileSync('pids',process.pid+' '+c.pid);setInterval(()=>{},100);`;
  const pending = command(
    [process.execPath, "-e", script],
    f.dir,
    controller.signal,
    10000,
  );
  try {
    await ready(join(f.dir, "ready"));
    await ready(join(f.dir, "pids"));
    const pids = readFileSync(join(f.dir, "pids"), "utf8")
      .split(" ")
      .map(Number);
    assert.equal(Number(readFileSync(join(f.dir, "ready"), "utf8")), pids[1]);
    controller.abort();
    const result = await pending;
    assert.equal(result.cancelled, true);
    for (const pid of pids) await stopped(pid);
  } finally {
    controller.abort();
    await pending;
    f.close();
  }
});
test("execution deadline excludes cleanup grace but cancels a still-running command", async () => {
  const f = fixture();
  try {
    const success = await command(
      [process.execPath, "-e", ""],
      f.dir,
      new AbortController().signal,
      100,
    );
    assert.equal(success.code, 0);
    assert.equal(success.cancelled, false);
    const timeout = await command(
      ["/bin/sleep", "10"],
      f.dir,
      new AbortController().signal,
      100,
    );
    assert.equal(timeout.cancelled, true);
    assert.equal(timeout.code, null);
  } finally {
    f.close();
  }
});
test("leader exit does not hang on descendant pipe writer; cancellation preserves output", async () => {
  const f = fixture();
  try {
    const start = Date.now();
    const result = await command(
      [
        "node",
        "-e",
        `require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'inherit'});console.log('before');process.exit(0);`,
      ],
      f.dir,
      new AbortController().signal,
      1000,
    );
    assert.ok(Date.now() - start < 2000);
    assert.equal(result.stdout, "before\n");
    const controller = new AbortController();
    const pending = command(
      [
        process.execPath,
        "-e",
        `process.stdout.write('partial\\n',()=>require('fs').writeFileSync('output-ready','1'));setInterval(()=>{},100)`,
      ],
      f.dir,
      controller.signal,
      10000,
    );
    try {
      await ready(join(f.dir, "output-ready"));
    } finally {
      controller.abort();
      await pending;
    }
    const cancelled = await pending;
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.stdout, "partial\n");
    await assert.rejects(
      command(
        ["/missing-executable"],
        f.dir,
        new AbortController().signal,
        1000,
      ),
      /ENOENT/,
    );
  } finally {
    f.close();
  }
});
test("real official Codex SDK exec transport through lifecycle shim, no model", async () => {
  const f = fixture();
  try {
    const executable = join(f.dir, "fake-codex");
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nif(process.argv.includes('--version')){console.log('codex-cli ${CODEX_VERSION}');process.exit(0)}\nprocess.stdin.resume();process.stdin.on('end',()=>{for(const e of [{type:'thread.started',thread_id:'fixture-thread'},{type:'item.completed',item:{type:'agent_message',id:'message',text:'official-sdk'}},{type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:4,reasoning_output_tokens:1}}])console.log(JSON.stringify(e));});\n`,
    );
    chmodSync(executable, 0o755);
    const harness = new CodexHarness({ pricing, executable });
    const result = await f
      .runtime({ live: true })
      .run((r) =>
        r.agent(
          "a",
          { harness, model: "test-model" },
          { prompt: "offline fixture only" },
        ),
      );
    assert.equal(result.text, "official-sdk");
  } finally {
    f.close();
  }
});
test("Codex transport abort cleans grandchild, SDK failure leaves unknown usage", async () => {
  const f = fixture();
  try {
    const executable = join(f.dir, "fake-codex");
    const pidfile = join(f.dir, "pid");
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nrequire('child_process').spawn(process.execPath,['-e',${JSON.stringify(`process.on("SIGTERM",()=>{});require('fs').writeFileSync(${JSON.stringify(pidfile)},String(process.pid));setInterval(()=>{},100)`)}],{stdio:'inherit'});setInterval(()=>{},100);`,
    );
    chmodSync(executable, 0o755);
    const harness = new CodexHarness({
      pricing,
      executable,
      checkVersion: async () => {},
    });
    const controller = new AbortController();
    const promise = harness.invoke(
      {
        prompt: "offline",
        model: "test-model",
        cwd: f.dir,
        mode: "read-only",
        signal: controller.signal,
      },
      { event: () => {}, report: () => {} },
    );
    try {
      await ready(pidfile);
    } finally {
      controller.abort();
      await promise;
    }
    const receipt = await promise;
    assert.equal(receipt.accounting.usd, null);
    assert.equal(receipt.status, "cancelled");
    await stopped(Number(readFileSync(pidfile, "utf8")));
  } finally {
    f.close();
  }
});
test("SIGKILL after durable reservation: fresh process can claim but never resends", async () => {
  const f = fixture();
  try {
    const runtimeUrl = new URL("../src/runtime.ts", import.meta.url).href,
      storeUrl = new URL("../src/store.ts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import {Runtime} from ${JSON.stringify(runtimeUrl)};import {Store} from ${JSON.stringify(storeUrl)};import {writeFileSync} from 'node:fs';const store=new Store(${JSON.stringify(f.store.path)});const h={name:'crash',identity:{adapter:'crash'},live:false,preflight:async()=>{},invoke:async()=>{writeFileSync(${JSON.stringify(join(f.dir, "sent"))},'1');await new Promise(()=>{});}};await new Runtime({store,runId:'run',workflowIdentity:'wf',cwd:${JSON.stringify(f.dir)}}).run(r=>r.agent('a',{harness:h,model:'test-model'},{prompt:'x'}));setInterval(()=>{},1000);`,
      ],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "ignore" },
    );
    try {
      for (let i = 0; i < 200 && !existsSync(join(f.dir, "sent")); i++)
        await sleep(10);
      assert.ok(existsSync(join(f.dir, "sent")));
      const exit = new Promise<void>((r) => child.once("exit", () => r()));
      child.kill("SIGKILL");
      await exit;
      let sends = 0;
      const harness = {
        name: "crash",
        identity: { adapter: "crash" },
        live: false,
        preflight: async () => {},
        invoke: async () => {
          sends++;
          throw new Error("must not send");
        },
      };
      await assert.rejects(
        f
          .runtime()
          .run((r) =>
            r.agent("a", { harness, model: "test-model" }, { prompt: "x" }),
          ),
        /Uncertain send/,
      );
      assert.equal(sends, 0);
    } finally {
      child.kill("SIGKILL");
    }
  } finally {
    f.close();
  }
});
