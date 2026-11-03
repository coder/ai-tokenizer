// entry-points (CJS): every public subpath resolves to the CJS build and works with require().
const results = [];
const check = (id, action, expected, observed, pass) => results.push({ id, pass: Boolean(pass), action, expected, observed });
const outcome = (fn) => { try { return { value: fn() }; } catch (e) { return { threw: String(e && e.message ? e.message : e) }; } };

const names = ["cl100k_base", "o200k_base", "p50k_base", "claude", "claude_v3", "claude_v4_7"];
const specs = ["ai-tokenizer", "ai-tokenizer/sdk", "ai-tokenizer/encoding", ...names.map((n) => `ai-tokenizer/encoding/${n}`)];
for (const s of specs) {
  const r = outcome(() => require.resolve(s));
  check(`resolve/${s}`, `require.resolve("${s}")`, "a dist/*.cjs file inside node_modules/ai-tokenizer", r, /node_modules\/ai-tokenizer\/dist\/.+\.cjs$/.test(r.value || ""));
}

const root = require("ai-tokenizer");
check("named-exports", 'const { Tokenizer, models } = require("ai-tokenizer")', "class and record", { Tokenizer: typeof root.Tokenizer, models: typeof root.models }, typeof root.Tokenizer === "function" && Object.keys(root.models || {}).length > 0);
check("default-interop", 'require("ai-tokenizer").default', "the Tokenizer class", typeof root.default, root.default === root.Tokenizer);

const { count } = require("ai-tokenizer/sdk");
const encoding = require("ai-tokenizer/encoding");
for (const n of names) {
  const mod = require(`ai-tokenizer/encoding/${n}`);
  const a = outcome(() => new root.Tokenizer(mod).encode("hello world"));
  const b = outcome(() => new root.Tokenizer(encoding[n]).encode("hello world"));
  check(`encoding/${n}`, `new Tokenizer(require("ai-tokenizer/encoding/${n}")).encode("hello world")`, b, a, mod.name === n && JSON.stringify(a) === JSON.stringify(b) && Array.isArray(a.value));
}
const model = root.models["openai/gpt-5"];
const r = outcome(() => count({ tokenizer: new root.Tokenizer(encoding[model.encoding]), model, messages: [{ role: "user", content: "hi" }] }).total);
check("sdk-count", 'require("ai-tokenizer/sdk").count({...})', "a positive integer", r, Number.isInteger(r.value) && r.value > 0);

const failed = results.filter((x) => !x.pass);
console.log(JSON.stringify({ feature: "entry-points-cjs", passed: results.length - failed.length, failed: failed.length, checks: results }, null, 2));
for (const x of results) console.error(`${x.pass ? "PASS" : "FAIL"} entry-points-cjs/${x.id}`);
process.exitCode = failed.length ? 1 : 0;
