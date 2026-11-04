/**
 * Refreshes src/fixtures/claude-count-tokens.json with real `count_tokens`
 * results for every case text in that file. To add a case, append
 * `{ "name", "text" }` to `cases` and run:
 *
 *   ANTHROPIC_API_KEY=... bun scripts/generate-claude-fixture.ts
 *
 * Honors ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN. count_tokens is free.
 *
 * count_tokens prices one user message as a fixed frame plus the content.
 * The frame is measured as count_tokens("a") - 1, because "a" is a single
 * word piece in both vocabularies. The script checks the measured frame
 * against the expected one: ctok publishes 7 (Opus 4.6), 11 (Opus 4.7) and
 * 6 (Opus 4.8), and Opus 5.5 measures 8. So the fixture and ctok agree on
 * where the frame ends and the content begins.
 */
import { readFileSync, writeFileSync } from "node:fs";

const FIXTURE = new URL(
  "../src/fixtures/claude-count-tokens.json",
  import.meta.url
);

const encodings = {
  claude_v3: { model: "claude-opus-4-6", frame: 7 },
  claude_v4_7: { model: "claude-opus-4-7", frame: 11 },
  claude_v4_8: { model: "claude-opus-4-8", frame: 6 },
  claude_v5: { model: "claude-opus-5-5", frame: 8 },
} as const;
type EncodingName = keyof typeof encodings;

interface Case {
  name: string;
  text: string;
  input_tokens?: Record<EncodingName, number>;
}

const baseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const headers: Record<string, string> = {
  "anthropic-version": "2023-06-01",
  "content-type": "application/json",
};
if (process.env.ANTHROPIC_AUTH_TOKEN) {
  headers.authorization = `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`;
}
if (process.env.ANTHROPIC_API_KEY) {
  headers["x-api-key"] = process.env.ANTHROPIC_API_KEY;
}
if (!headers.authorization && !headers["x-api-key"]) {
  throw new Error("set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN");
}

async function countTokens(model: string, text: string): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: text }],
      }),
    });
    if (res.ok) {
      const body = (await res.json()) as { input_tokens: number };
      return body.input_tokens;
    }
    if (res.status === 429 || res.status >= 500) {
      await Bun.sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new Error(`${model} ${res.status}: ${await res.text()}`);
  }
  throw new Error(`${model}: retries exhausted`);
}

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
  cases: Case[];
};

for (const [name, { model, frame }] of Object.entries(encodings)) {
  const measured = (await countTokens(model, "a")) - 1;
  if (measured !== frame) {
    throw new Error(
      `${name}: ${model} frame is ${measured}, expected ${frame}`
    );
  }
}

const queue = [...fixture.cases];
async function worker() {
  for (let c = queue.shift(); c; c = queue.shift()) {
    const counts = {} as Record<EncodingName, number>;
    for (const [name, { model }] of Object.entries(encodings)) {
      counts[name as EncodingName] = await countTokens(model, c.text);
    }
    c.input_tokens = counts;
    console.log(`${c.name}: ${JSON.stringify(counts)}`);
  }
}
await Promise.all(Array.from({ length: 8 }, worker));

writeFileSync(
  FIXTURE,
  JSON.stringify({ encodings, cases: fixture.cases }, null, 2) + "\n"
);
console.log(`cases: ${fixture.cases.length}`);
