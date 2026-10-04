// Fixed host protocol. Runtime owns its process group, reservation, and receipt.
import { spawn } from "node:child_process";
import { dirname } from "node:path";
const [directory, source] = process.argv.slice(2);
const argv = JSON.parse(source);
if (
  !directory ||
  !Array.isArray(argv) ||
  !argv.length ||
  argv.some((value) => typeof value !== "string" || value.includes("\0"))
)
  throw new Error("Invalid fixed check request");
const limit = 4096;
let stdout = Buffer.alloc(0),
  stderr = Buffer.alloc(0),
  truncated = false;
const append = (old, chunk) => {
  if (old.length + chunk.length > limit) truncated = true;
  return Buffer.concat([
    old,
    chunk.subarray(0, Math.max(0, limit - old.length)),
  ]);
};
const env = { ...process.env };
for (const name of Object.keys(env))
  if (name.startsWith("GIT_")) delete env[name];
env.GIT_CEILING_DIRECTORIES = dirname(directory);
const child = spawn(argv[0], argv.slice(1), {
  cwd: directory,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => {
  stdout = append(stdout, chunk);
});
child.stderr.on("data", (chunk) => {
  stderr = append(stderr, chunk);
});
const result = await new Promise((resolve) => {
  child.once("error", (error) =>
    resolve({
      available: false,
      code: null,
      signal: null,
      error: error.message,
    }),
  );
  child.once("close", (code, signal) =>
    resolve({ available: true, code, signal }),
  );
});
const decode = (value) => new TextDecoder().decode(value, { stream: true });
process.stdout.write(
  JSON.stringify({
    ...result,
    stdout: decode(stdout),
    stderr: decode(stderr),
    truncated,
  }) + "\n",
);
