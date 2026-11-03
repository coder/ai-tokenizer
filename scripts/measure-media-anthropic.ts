/**
 * Measures what Anthropic charges for one image, with the free count_tokens,
 * on every live Claude model, and writes src/fixtures/media-anthropic.json:
 *
 *   bun scripts/measure-media-anthropic.ts
 *
 * Honors ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY.
 * The cost of an image is count_tokens of a user turn with the text "a" and
 * the image, minus count_tokens of the turn with the text "a" alone.
 */
import { writeFileSync } from "node:fs";
import { greyPng, MEASURED_SIZES, randomSizes } from "./media-samples";
import { mapLimit } from "./anthropic";

const FIXTURE = new URL(
  "../src/fixtures/media-anthropic.json",
  import.meta.url
);

const MODELS = [
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-1",
];

// Around the 1,568 token cap, the 1,568 px edge, and the API's 8,000 px limit.
const EXTRA_SIZES: Array<[number, number]> = [
  [1100, 1100],
  [1200, 1200],
  [1400, 700],
  [1568, 100],
  [1569, 100],
  [2576, 100],
  [2577, 100],
  [2000, 2000],
  [2576, 1800],
  [3000, 3000],
  [8000, 8000],
  [8001, 100],
];

const sizes = [...MEASURED_SIZES, ...EXTRA_SIZES];
// A seeded random sample, to find where a recipe is wrong between the sizes above.
const DENSE_SIZES = randomSizes(400, 7);
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

type Block = Record<string, unknown>;

const text = (value: string): Block => ({ type: "text", text: value });
const image = (png: Buffer): Block => ({
  type: "image",
  source: {
    type: "base64",
    media_type: "image/png",
    data: png.toString("base64"),
  },
});

class Rejected extends Error {}

async function countTokens(
  model: string,
  messages: unknown[]
): Promise<number> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages }),
    });
    if (response.ok) {
      return ((await response.json()) as { input_tokens: number }).input_tokens;
    }
    if (response.status === 429 || response.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    const body = await response.text();
    let message = body.slice(0, 200);
    try {
      message = JSON.parse(body).error.message;
    } catch {}
    throw new Rejected(`${response.status}: ${message.slice(0, 160)}`);
  }
  throw new Error(`${model}: retries exhausted`);
}

const user = (...content: Block[]) => ({ role: "user", content });

type Case =
  | { width: number; height: number; tokens: number }
  | { width: number; height: number; error: string };

const out: Record<
  string,
  { baseline: number; cases: Case[]; dense: number[] }
> = {};
let measured = 0;
let rejected = 0;

const pngs = new Map(sizes.map(([w, h]) => [`${w}x${h}`, greyPng(w, h)]));

for (const model of MODELS) {
  const baseline = await countTokens(model, [user(text("a"))]);
  const cases = await mapLimit(sizes, 6, async ([width, height]) => {
    const png = pngs.get(`${width}x${height}`)!;
    try {
      const total = await countTokens(model, [user(text("a"), image(png))]);
      measured++;
      return { width, height, tokens: total - baseline } satisfies Case;
    } catch (error) {
      if (!(error instanceof Rejected)) throw error;
      rejected++;
      return { width, height, error: error.message } satisfies Case;
    }
  });
  const dense = await mapLimit(DENSE_SIZES, 6, async ([width, height]) => {
    measured++;
    const total = await countTokens(model, [
      user(text("a"), image(greyPng(width, height))),
    ]);
    return total - baseline;
  });
  out[model] = { baseline, cases, dense };
  const ok = cases.filter((c) => "tokens" in c) as Array<
    Extract<Case, { tokens: number }>
  >;
  console.log(
    `${model.padEnd(18)} baseline ${baseline} 1338x579=${ok.find((c) => c.width === 1338 && c.height === 579)?.tokens} 2000x2000=${ok.find((c) => c.width === 2000 && c.height === 2000)?.tokens}`
  );
}

writeFileSync(
  FIXTURE,
  JSON.stringify(
    {
      provider: "anthropic",
      measuredAt: new Date().toISOString().slice(0, 10),
      unit: 'image tokens = count_tokens of a user turn with the text "a" and the image, minus count_tokens of the turn with the text "a" alone',
      denseSizes: DENSE_SIZES,
      models: out,
    },
    null,
    1
  ) + "\n"
);
console.log(
  `${measured} cases measured, ${rejected} rejected on ${MODELS.length} models`
);
