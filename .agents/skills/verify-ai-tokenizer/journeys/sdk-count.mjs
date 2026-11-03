// sdk-count: the README "Estimate tokens with the AI SDK" path with real `ai` and `zod` objects.
import Tokenizer, { models } from "ai-tokenizer";
import { count } from "ai-tokenizer/sdk";
import * as encoding from "ai-tokenizer/encoding";
import { tool } from "ai";
import { z } from "zod";
import { get_encoding } from "tiktoken";
import { check, finish, outcome } from "./check.mjs";

const tokenizers = {};
const tokenizerFor = (model) => (tokenizers[model.encoding] ??= new Tokenizer(encoding[model.encoding]));
const isCount = (n) => Number.isInteger(n) && n >= 0;

const gpt5 = models["openai/gpt-5"];
const tok = tokenizerFor(gpt5);
const mult = gpt5.tokens.contentMultiplier;

// sdk-string: one user message with string content.
const r1 = outcome(() => count({ tokenizer: tok, model: gpt5, messages: [{ role: "user", content: "Hello, how are you?" }] }));
const v1 = r1.value;
check("string-content", 'count({ messages: [{ role: "user", content: "Hello, how are you?" }] })',
  { text: Math.round(tok.count("Hello, how are you?") * mult), totalIsSumOfParts: true },
  r1,
  v1 && v1.messages[0].content[0].type === "text" &&
    v1.messages[0].content[0].total === Math.round(tok.count("Hello, how are you?") * mult) &&
    v1.total === gpt5.tokens.baseOverhead + v1.messages[0].total + v1.tools.total);

// sdk-parts: assistant tool call, tool result, multi-part user content.
const messages = [
  { role: "system", content: "You are a weather bot." },
  { role: "user", content: [{ type: "text", text: "Weather in Berlin?" }] },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_1", toolName: "weather", input: { city: "Berlin" } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1", toolName: "weather", output: { type: "json", value: { tempC: 21 } } }] },
];
const r2 = outcome(() => count({ tokenizer: tok, model: gpt5, messages }));
const types = r2.value?.messages.map((m) => m.content.map((c) => c.type).join(","));
check("message-parts", "count() over system, user parts, tool-call and tool-result messages",
  { contentTypes: ["text", "text", "tool-call", "tool-result"], toolCallInput: ">0" },
  { contentTypes: types, r: r2 },
  r2.value && JSON.stringify(types) === JSON.stringify(["text", "text", "tool-call", "tool-result"]) &&
    r2.value.messages[2].content[0].input > 0 && r2.value.messages[3].content[0].output > 0);

// sdk-tools: tool definitions built with ai's tool() and a zod schema.
const tools = {
  weather: tool({ description: "Get the weather for a city", inputSchema: z.object({ city: z.string().describe("City name"), unit: z.enum(["c", "f"]) }) }),
  time: tool({ description: "Get the time", inputSchema: z.object({ tz: z.string() }) }),
};
const r3 = outcome(() => count({ tokenizer: tok, model: gpt5, messages: [], tools }));
const d = r3.value?.tools.definitions;
check("tools", "count({ tools: { weather: tool({ description, inputSchema: z.object(...) }), time: ... } })",
  { definitions: ["weather", "time"], each: "name, description, inputSchema > 0" },
  r3,
  d && ["weather", "time"].every((k) => d[k].name > 0 && d[k].description > 0 && d[k].inputSchema > 0) &&
    r3.value.tools.total > 0);

// sdk-every-model: README path for every entry in models.
const broken = [];
for (const [key, model] of Object.entries(models)) {
  const r = outcome(() => count({ tokenizer: tokenizerFor(model), model, messages: [{ role: "user", content: "Hi there" }], tools }));
  if (!r.value || !isCount(r.value.total) || r.value.total === 0) broken.push({ key, r });
}
check("every-model", `count() with new Tokenizer(encoding[model.encoding]) for all ${Object.keys(models).length} models`, [], broken, broken.length === 0);

// sdk-special-text: user text that merely mentions a special token. Providers count it as plain text,
// so a token estimate must not throw. tiktoken's encode_ordinary gives the plain-text count.
const o200k = get_encoding("o200k_base");
const special = "Explain what <|endoftext|> means in GPT tokenizers.";
const plain = o200k.encode_ordinary(special).length;
o200k.free();
const r4 = outcome(() => count({ tokenizer: tok, model: gpt5, messages: [{ role: "user", content: special }] }));
check("special-text/openai", `count() for openai/gpt-5 with user content "${special}"`,
  { text: Math.round(plain * mult), note: "tiktoken encode_ordinary length x contentMultiplier" }, r4,
  r4.value?.messages[0].content[0].total === Math.round(plain * mult));

const sonnet = models["anthropic/claude-sonnet-4.5"];
const ctext = "Wrap the answer in <META> tags.";
const r5 = outcome(() => count({ tokenizer: tokenizerFor(sonnet), model: sonnet, messages: [{ role: "user", content: [{ type: "text", text: ctext }] }] }));
check("special-text/anthropic", `count() for anthropic/claude-sonnet-4.5 with text part "${ctext}"`,
  "a numeric total", r5, r5.value && isCount(r5.value.total));

const r6 = outcome(() => count({ tokenizer: tok, model: gpt5, messages: [{ role: "tool", content: [{ type: "tool-result", toolCallId: "c", toolName: "read_file", output: { type: "text", value: "tokens: <|endoftext|>" } }] }] }));
check("special-text/tool-result", "count() with a tool-result whose output contains <|endoftext|>",
  "a numeric total", r6, r6.value && isCount(r6.value.total));

finish("sdk-count");
