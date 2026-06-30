#!/usr/bin/env node
// Auto-discovering test runner.
//
// Replaces the hand-maintained `&&` chain in package.json's `test` script.
// Every `*.mjs` directly under `scripts/` is a test/smoke entrypoint and is
// run here as its own subprocess — so dropping a new `scripts/<name>.mjs`
// file in just works, with nothing to wire by hand (issue #6).
//
// Each entrypoint signals failure the way `node scripts/<name>.mjs` always
// has: a non-zero exit code (an uncaught `assert` throw, or `process.exit(1)`).
// We spawn each as a child process to preserve that exact isolation —
// importing them in-process would let one script's `process.exit` or open
// handles (e.g. the smoke server) leak into the others.
//
// `typecheck` + `build` run ahead of this via the `pretest` npm lifecycle hook.

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const self = basename(fileURLToPath(import.meta.url));

const entries = (await readdir(scriptsDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs") && entry.name !== self)
  .map((entry) => entry.name)
  .sort();

if (entries.length === 0) {
  console.error("run-tests: no test entrypoints found under scripts/");
  process.exit(1);
}

function runOne(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(scriptsDir, name)], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => resolve({ name, ok: false, code: null, output: `${output}\n${error.message}` }));
    child.on("close", (code) => resolve({ name, ok: code === 0, code, output }));
  });
}

const failures = [];
for (const name of entries) {
  const result = await runOne(name);
  console.log(`${result.ok ? "✓" : "✗"} ${name}${result.ok ? "" : ` (exit ${result.code})`}`);
  if (!result.ok) {
    failures.push(result);
    process.stderr.write(result.output.trimEnd() + "\n");
  }
}

console.log(`\n${entries.length - failures.length}/${entries.length} test entrypoints passed`);
if (failures.length > 0) {
  console.error(`run-tests: ${failures.length} failed -> ${failures.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
