// Loads the built `ai-tokenizer/sdk` from a directory that cannot see `ai`, as
// ESM and as CommonJS, and fails unless the error names the missing package.
// Run after `bun run build --dts=false`, with the default package.json: the
// sdk build must import `ai`, because `ai` is an optional peer dependency.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = new URL("../dist/", import.meta.url);
assert.match(
  readFileSync(new URL("sdk.js", dist), "utf8"),
  /from "ai"/,
  "sdk.js does not import ai: the build bundles it"
);

const lonely = mkdtempSync(join(tmpdir(), "ai-tokenizer-no-ai-"));
try {
  for (const file of readdirSync(dist)) {
    if (/^(sdk|tokenizer-.*)\.c?js$/.test(file)) {
      cpSync(new URL(file, dist), join(lonely, file));
    }
  }
  const load = (args) =>
    spawnSync(process.execPath, args, { cwd: lonely, encoding: "utf8" });
  const esm = load([
    "--input-type=module",
    "-e",
    `import(${JSON.stringify(pathToFileURL(join(lonely, "sdk.js")).href)})`,
  ]);
  const cjs = load([
    "-e",
    `require(${JSON.stringify(join(lonely, "sdk.cjs"))})`,
  ]);
  assert.notEqual(esm.status, 0, "esm: the sdk loaded without ai");
  assert.match(
    esm.stderr,
    /Cannot find package 'ai'/,
    "esm: the error names ai"
  );
  assert.notEqual(cjs.status, 0, "cjs: the sdk loaded without ai");
  assert.match(
    cjs.stderr,
    /Cannot find module 'ai'/,
    "cjs: the error names ai"
  );
  console.log("sdk without ai: both builds fail with an error that names ai");
} finally {
  rmSync(lonely, { recursive: true, force: true });
}
