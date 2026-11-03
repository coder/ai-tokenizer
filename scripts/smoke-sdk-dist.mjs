// Loads the built `ai-tokenizer/sdk` as CommonJS and as ESM against the
// installed `ai` and `zod`, and fails unless both give the same counts. It also
// loads them without `ai` and checks that the error names it.
// Run after `bun run build --dts=false`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const dist = new URL("../dist/", import.meta.url);

const aiVersion = require("ai/package.json").version;
const zodVersion = require("zod/package.json").version;

async function smoke(format) {
  const load = async (name) =>
    format === "cjs"
      ? require(new URL(`${name}.cjs`, dist).pathname)
      : import(new URL(`${name}.js`, dist).href);
  const { count } = await load("sdk");
  const { Tokenizer, models } = await load("index");
  const encoding = await load("encoding/o200k_base");
  const ai = format === "cjs" ? require("ai") : await import("ai");
  const { z } = format === "cjs" ? require("zod") : await import("zod");

  const result = count({
    tokenizer: new Tokenizer(encoding),
    model: models["openai/gpt-5"],
    messages: [
      { role: "system", content: "Be brief." },
      {
        role: "user",
        content: [
          { type: "text", text: "Weather in Paris?" },
          { type: "image", image: "iVBORw0KGgo=", mediaType: "image/png" },
        ],
      },
    ],
    tools: {
      zodTool: {
        description: "Get the weather",
        inputSchema: z.object({ city: z.string().describe("City name") }),
      },
      jsonTool: {
        description: "Get the weather",
        inputSchema: ai.jsonSchema({
          type: "object",
          properties: { city: { type: "string", description: "City name" } },
        }),
      },
    },
  });

  const claude = count({
    tokenizer: new Tokenizer(await load("encoding/claude_v5")),
    model: models["anthropic/claude-opus-5.5"],
    messages: [
      { role: "user", content: "Weather in Paris?  " },
      { role: "assistant", content: "Sunny.  " },
      { role: "user", content: "Thanks" },
    ],
  });

  assert.equal(result.tools.unresolved.length, 0, `${format}: unresolved tools`);
  const { zodTool, jsonTool } = result.tools.definitions;
  assert.ok(zodTool.inputSchema > 0, `${format}: zod schema counted`);
  assert.equal(zodTool.inputSchema, jsonTool.inputSchema, `${format}: zod = jsonSchema`);
  return [result.total, claude.total];
}

const cjs = await smoke("cjs");
const esm = await smoke("esm");
assert.deepEqual(cjs, esm, "CJS and ESM totals differ");

// Without `ai`, loading the sdk fails with an error that names the package.
const lonely = mkdtempSync(join(tmpdir(), "ai-tokenizer-no-ai-"));
for (const file of readdirSync(dist)) {
  if (/^(sdk|tokenizer-.*)\.(js|cjs)$/.test(file)) {
    cpSync(new URL(file, dist), join(lonely, file));
  }
}
const loadWithoutAi = (args) =>
  spawnSync(process.execPath, args, { cwd: lonely, encoding: "utf8" });
const esmFailure = loadWithoutAi([
  "--input-type=module",
  "-e",
  `import(${JSON.stringify(pathToFileURL(join(lonely, "sdk.js")).href)})`,
]);
const cjsFailure = loadWithoutAi(["-e", `require(${JSON.stringify(join(lonely, "sdk.cjs"))})`]);
rmSync(lonely, { recursive: true });
assert.notEqual(esmFailure.status, 0, "esm: the sdk loaded without ai");
assert.match(esmFailure.stderr, /Cannot find package 'ai'/, "esm: error names ai");
assert.notEqual(cjsFailure.status, 0, "cjs: the sdk loaded without ai");
assert.match(cjsFailure.stderr, /Cannot find module 'ai'/, "cjs: error names ai");

console.log(
  `smoke node=${process.version} ai=${aiVersion} zod=${zodVersion} cjs=${cjs[0]} esm=${esm[0]} claude=${cjs[1]}/${esm[1]} without-ai=ok`
);
