// Loads the built `ai-tokenizer/sdk` as CommonJS and as ESM against the
// installed `ai` and `zod`, and fails unless both give the same counts.
// Run after `bun run build --dts=false`.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

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

  assert.equal(result.tools.unresolved.length, 0, `${format}: unresolved tools`);
  const { zodTool, jsonTool } = result.tools.definitions;
  assert.ok(zodTool.inputSchema > 0, `${format}: zod schema counted`);
  assert.equal(zodTool.inputSchema, jsonTool.inputSchema, `${format}: zod = jsonSchema`);
  return result.total;
}

const cjs = await smoke("cjs");
const esm = await smoke("esm");
assert.equal(cjs, esm, "CJS and ESM totals differ");
console.log(
  `smoke node=${process.version} ai=${aiVersion} zod=${zodVersion} cjs=${cjs} esm=${esm}`
);
