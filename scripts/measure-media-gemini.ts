/**
 * Measures what Gemini charges for one image, through the Vercel AI Gateway,
 * and writes src/fixtures/media-gemini.json. Run: bun scripts/measure-media-gemini.ts
 * (needs AI_GATEWAY_API_KEY; scripts/fit-media.ts needs no key).
 *
 * The number read is `usage.inputTokens`, which is Google's `promptTokenCount`.
 * The gateway also returns Google's per-modality split in `usage.raw`; the
 * script checks that its IMAGE count equals the image cost it computes.
 *
 * The gateway sends a request to Vertex first and silently falls back to
 * Google AI Studio when Vertex fails. The two count differently, so every
 * request is pinned to one backend with `providerOptions.gateway.only`, and
 * the script rejects a response that another backend served.
 */
import { generateText, type ModelMessage } from "ai";
import { writeFileSync } from "node:fs";
import { greyPng, MEASURED_SIZES } from "./media-samples";

type Backend = "vertex" | "google";
type Resolution = "default" | "low" | "medium" | "high";
type Size = readonly [number, number];
type Part = { image: Buffer; mediaType: "image/png" | "image/jpeg" };
type Reading = { prompt: number; image?: number; output: number };

const OUT = new URL("../src/fixtures/media-gemini.json", import.meta.url);
const MEASURED_AT = "2026-11-03";
const SPEND_CAP = 2.5;
const CONCURRENCY = 6;
const BACKENDS: Backend[] = ["vertex", "google"];

// Dollars per token, from the gateway's /v1/models pricing on 2026-11-03.
const MODELS: Record<
  string,
  { in: number; out: number; thinking: Record<string, string | number> }
> = {
  // 2.5 Flash accepts a zero thinking budget; 3.5 Flash only takes a level.
  "google/gemini-2.5-flash": {
    in: 0.3e-6,
    out: 2.5e-6,
    thinking: { thinkingBudget: 0 },
  },
  "google/gemini-3.5-flash": {
    in: 1.5e-6,
    out: 9e-6,
    thinking: { thinkingLevel: "minimal" },
  },
};

const LEVELS: Record<Exclude<Resolution, "default">, string> = {
  low: "MEDIA_RESOLUTION_LOW",
  medium: "MEDIA_RESOLUTION_MEDIUM",
  high: "MEDIA_RESOLUTION_HIGH",
};

// Boundaries found while fitting: the single-tile test, the crop unit's
// clamps, the 12-crop cap, the 2500 px pre-scale, and 3.5's integer grids.
const EXTRA_SIZES: ReadonlyArray<Size> = [
  [384, 192],
  [384, 193],
  [200, 100],
  [200, 101],
  [384, 385],
  [385, 200],
  [255, 600],
  [256, 600],
  [257, 600],
  [300, 600],
  [600, 800],
  [600, 801],
  [601, 802],
  [602, 802],
  [602, 803],
  [1151, 1536],
  [1152, 1536],
  [1152, 1537],
  [1536, 1536],
  [1537, 1537],
  [100, 1100],
  [100, 1200],
  [100, 1201],
  [2304, 2304],
  [2305, 2305],
  [1600, 2500],
  [1600, 2501],
  [1598, 2600],
  [1599, 2600],
  [1540, 2501],
  [1540, 2505],
  [1600, 3000],
  [2000, 4000],
  [4918, 8000],
  [4919, 8000],
  [1, 2],
  [1, 3],
  [2, 3],
  [10, 4],
  [1, 1000],
  [1, 2500],
  [1, 2501],
  [1, 4000],
  [2, 5000],
  [2, 5001],
  [1000, 1],
  [640, 360],
  [1280, 720],
  [800, 600],
  [1080, 1920],
  [4096, 2160],
  [3000, 1000],
  [2000, 1000],
  [1200, 300],
  [300, 1200],
  [1000, 700],
  [700, 1000],
  [3000, 2100],
  [1400, 500],
];

/** Sizes drawn after the fit was written, to check that it holds on sizes nobody picked. */
function heldOutSizes(): Size[] {
  let state = 20261103;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const between = (lo: number, hi: number) =>
    lo + Math.floor(random() * (hi - lo + 1));
  const sizes: Size[] = [];
  for (const [count, longest, shortest] of [
    [15, [2400, 6000], 300],
    [15, [385, 2400], 30],
    [10, [2, 384], 1],
  ] as const) {
    for (let i = 0; i < count; i++) {
      const long = between(longest[0], longest[1]);
      const short = between(shortest, long);
      sizes.push(random() < 0.5 ? [short, long] : [long, short]);
    }
  }
  return sizes;
}

const SIZES: ReadonlyArray<Size> = [
  ...new Map(
    [...MEASURED_SIZES, ...EXTRA_SIZES, ...heldOutSizes()].map((size) => [
      size.join("x"),
      size,
    ])
  ).values(),
];

// The reduced set measured at each media-resolution level.
const LEVEL_SIZES: ReadonlyArray<Size> = [
  [1, 1],
  [100, 100],
  [300, 200],
  [384, 384],
  [640, 480],
  [1000, 1000],
  [1920, 1080],
  [2577, 2577],
  [4000, 300],
  [10, 1000],
];
const PROBE_SIZE: Size = [1920, 1080];
const JPEG_SIZES: ReadonlyArray<Size> = [PROBE_SIZE, [300, 200]];

/**
 * A flat grey baseline JPEG. Every 8x8 block holds a zero DC difference and
 * an end-of-block, so the entropy-coded data is two zero bits per block.
 */
function greyJpeg(width: number, height: number): Buffer {
  const segment = (marker: number, body: number[]) => [
    0xff,
    marker,
    (body.length + 2) >> 8,
    (body.length + 2) & 0xff,
    ...body,
  ];
  // `perLength[i]` codes are `i + 1` bits long, assigned to `symbols` in order.
  const huffman = (id: number, perLength: number[], symbols: number[]) =>
    segment(0xc4, [
      id,
      ...Array.from({ length: 16 }, (_, i) => perLength[i] ?? 0),
      ...symbols,
    ]);
  const bits = Math.ceil(width / 8) * Math.ceil(height / 8) * 2;
  const scan = Buffer.alloc(Math.ceil(bits / 8));
  if (bits % 8) scan[scan.length - 1] = 0xff >> bits % 8;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from(segment(0xdb, [0, ...new Array<number>(64).fill(1)])),
    Buffer.from(
      segment(0xc0, [
        8,
        height >> 8,
        height & 0xff,
        width >> 8,
        width & 0xff,
        1,
        1,
        0x11,
        0,
      ])
    ),
    Buffer.from(huffman(0x00, [1], [0])), // DC: category 0 is the code "0"
    Buffer.from(huffman(0x10, [1, 1], [0, 1])), // AC: end-of-block "0", symbol 1 "10"
    Buffer.from(segment(0xda, [1, 1, 0, 0, 63, 0])),
    scan,
    Buffer.from([0xff, 0xd9]),
  ]);
}

const spend = { dollars: 0, input: 0, output: 0 };

class Rejected extends Error {}

function short(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  if (text.includes("usage.inputTokens")) return "gateway returned no usage";
  return text
    .split("\n")[0]!
    .replace(/\s+/g, " ")
    .replace(/ Learn more:.*$/, "")
    .slice(0, 140);
}

function png(width: number, height: number): Part {
  return { image: greyPng(width, height), mediaType: "image/png" };
}

function user(images: Part[]): ModelMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: "a" },
      ...images.map((p) => ({
        type: "file" as const,
        data: p.image,
        mediaType: p.mediaType,
      })),
    ],
  };
}

const ASSISTANT: ModelMessage = { role: "assistant", content: "a" };

async function ask(
  model: string,
  backend: Backend,
  messages: ModelMessage[],
  resolution: Resolution | "ultra" = "default"
): Promise<Reading> {
  const mediaResolution =
    resolution === "default"
      ? {}
      : {
          mediaResolution:
            resolution === "ultra"
              ? "MEDIA_RESOLUTION_ULTRA_HIGH"
              : LEVELS[resolution],
        };
  let last = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await generateText({
        model,
        messages,
        // At 1, the gateway returns no usage for 2.5 Flash. 16 works.
        maxOutputTokens: 16,
        providerOptions: {
          gateway: { only: [backend] },
          google: {
            thinkingConfig: MODELS[model]!.thinking,
            ...mediaResolution,
          },
        },
      });
      const served = (r.providerMetadata as any)?.gateway?.routing
        ?.finalProvider;
      if (served !== backend) throw new Error(`served by ${served}`);
      const raw = r.usage.raw as any;
      const reading: Reading = {
        prompt: r.usage.inputTokens!,
        image: raw?.promptTokensDetails?.find(
          (d: any) => d.modality === "IMAGE"
        )?.tokenCount,
        output: r.usage.outputTokens ?? 0,
      };
      spend.input += reading.prompt;
      spend.output += reading.output;
      spend.dollars +=
        reading.prompt * MODELS[model]!.in +
        reading.output * MODELS[model]!.out;
      if (spend.dollars > SPEND_CAP) {
        console.log(`spend cap reached: $${spend.dollars.toFixed(3)}`);
        process.exit(1);
      }
      return reading;
    } catch (e) {
      last = short(e);
      if (
        /provider options|not supported|invalid argument|unable to submit/i.test(
          last
        )
      )
        break;
    }
  }
  throw new Rejected(last);
}

async function pool<T, R>(
  items: T[],
  work: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await work(items[i]!);
      }
    })
  );
  return out;
}

type Case = {
  width: number;
  height: number;
  mediaResolution: Resolution;
  tokens?: number;
  imageModalityTokens?: number;
  error?: string;
};

async function measureModel(model: string, backend: Backend) {
  const tag = `${model} ${backend}`;
  const baseline = (await ask(model, backend, [user([])])).prompt;
  console.log(`${tag} baseline ${baseline}`);

  const jobs: Array<{ size: Size; resolution: Resolution }> = [
    ...SIZES.map((size) => ({ size, resolution: "default" as const })),
    ...(Object.keys(LEVELS) as Array<keyof typeof LEVELS>).flatMap(
      (resolution) => LEVEL_SIZES.map((size) => ({ size, resolution }))
    ),
  ];
  let modalityMatches = 0;
  const cases = await pool(
    jobs,
    async ({ size: [width, height], resolution }) => {
      const entry: Case = { width, height, mediaResolution: resolution };
      try {
        const r = await ask(
          model,
          backend,
          [user([png(width, height)])],
          resolution
        );
        entry.tokens = r.prompt - baseline;
        if (r.image === entry.tokens) modalityMatches++;
        else entry.imageModalityTokens = r.image;
        console.log(`${tag} ${resolution} ${width}x${height} ${entry.tokens}`);
      } catch (e) {
        entry.error = (e as Rejected).message;
        console.log(
          `${tag} ${resolution} ${width}x${height} rejected: ${entry.error}`
        );
      }
      return entry;
    }
  );
  const measured = cases.filter((c) => c.tokens !== undefined).length;
  console.log(
    `${tag} spend so far $${spend.dollars.toFixed(3)}, IMAGE modality equals the image cost in ${modalityMatches}/${measured}`
  );
  return { backend, baseline, cases };
}

async function probe(model: string, backend: Backend, baseline: number) {
  const [w, h] = PROBE_SIZE;
  const cost = async (
    messages: ModelMessage[],
    resolution?: Resolution | "ultra"
  ) => (await ask(model, backend, messages, resolution)).prompt - baseline;

  // Total image tokens of one request that holds n identical images.
  const identicalImages: Record<number, number> = {};
  for (const n of [1, 2, 3]) {
    identicalImages[n] = await cost([
      user(Array.from({ length: n }, () => png(w, h))),
    ]);
  }

  const twoImagesAtHigh: { tokens?: number; error?: string } = {};
  try {
    twoImagesAtHigh.tokens = await cost([user([png(w, h), png(w, h)])], "high");
  } catch (e) {
    twoImagesAtHigh.error = (e as Rejected).message;
  }

  // The same image in the first and in the last message of a conversation.
  const talk = (first: boolean, last: boolean) => [
    user(first ? [png(w, h)] : []),
    ASSISTANT,
    user(last ? [png(w, h)] : []),
  ];
  const talkBaseline = (await ask(model, backend, talk(false, false))).prompt;
  const talkCost = async (first: boolean, last: boolean) =>
    (await ask(model, backend, talk(first, last))).prompt - talkBaseline;
  const acrossMessages = {
    firstMessageOnly: await talkCost(true, false),
    lastMessageOnly: await talkCost(false, true),
    both: await talkCost(true, true),
  };

  const jpegInsteadOfPng = [];
  for (const [width, height] of JPEG_SIZES) {
    jpegInsteadOfPng.push({
      width,
      height,
      png: await cost([user([png(width, height)])]),
      jpeg: await cost([
        user([{ image: greyJpeg(width, height), mediaType: "image/jpeg" }]),
      ]),
    });
  }

  const ultraHigh: { tokens?: number; error?: string } = {};
  try {
    ultraHigh.tokens = await cost([user([png(w, h)])], "ultra");
  } catch (e) {
    ultraHigh.error = (e as Rejected).message;
  }

  const result = {
    width: w,
    height: h,
    identicalImages,
    twoImagesAtHigh,
    acrossMessages,
    jpegInsteadOfPng,
    mediaResolutionUltraHigh: ultraHigh,
  };
  console.log(`${model} ${backend} probes ${JSON.stringify(result)}`);
  return result;
}

const fixture = {
  provider: "google",
  measuredAt: MEASURED_AT,
  unit: 'Image tokens = prompt tokens (usage.inputTokens, Google promptTokenCount) of a request with text "a" and one image, minus prompt tokens of a request with text "a" alone.',
  gateway:
    "Every request is pinned to one backend with providerOptions.gateway.only. `models` is the Vertex backend, which the gateway tries first. `modelsAiStudio` is the Google AI Studio backend, which the gateway falls back to. mediaResolution is sent as providerOptions.google.mediaResolution.",
  models: {} as Record<string, unknown>,
  modelsAiStudio: {} as Record<string, unknown>,
  probes: { vertex: {}, google: {} } as Record<
    Backend,
    Record<string, unknown>
  >,
};

if (!process.env.AI_GATEWAY_API_KEY) {
  throw new Error("AI_GATEWAY_API_KEY is not set");
}

for (const model of Object.keys(MODELS)) {
  for (const backend of BACKENDS) {
    const result = await measureModel(model, backend);
    (backend === "vertex" ? fixture.models : fixture.modelsAiStudio)[model] =
      result;
    fixture.probes[backend][model] = await probe(
      model,
      backend,
      result.baseline
    );
  }
}

writeFileSync(OUT, JSON.stringify(fixture, null, 2) + "\n");
const all = [
  ...Object.values(fixture.models),
  ...Object.values(fixture.modelsAiStudio),
] as Array<{
  cases: Case[];
}>;
const cases = all.flatMap((m) => m.cases);
const rejected = cases.filter((c) => c.error !== undefined).length;
console.log(
  `${cases.length - rejected} cases measured, ${rejected} rejected, spend $${spend.dollars.toFixed(3)} (input ${spend.input} tokens, output ${spend.output} tokens)`
);
