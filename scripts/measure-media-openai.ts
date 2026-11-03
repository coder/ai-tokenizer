/**
 * Measures what OpenAI charges, in input tokens, for one image, and writes
 * src/fixtures/media-openai.json. The recipes are fitted to it by scripts/fit-media.ts.
 *
 *   OPENAI_API_KEY=... bun scripts/measure-media-openai.ts [--dry-run]
 *
 * Honors OPENAI_BASE_URL. Responses are not stored. A `/responses` call is
 * paid, so the script runs a three-size dry run per model first and prints the
 * extrapolated cost of the full sweep, cheapest model first. The sweep stops
 * for good when the spend of the run passes the cap ($2.50, or
 * MEDIA_SPEND_CAP in dollars), and keeps the models it finished.
 * `--dry-run` stops after the dry run and writes nothing. A rerun keeps the
 * cases that the same model snapshot measured into the fixture, so it pays only
 * for new sizes; delete the fixture to measure everything again.
 *
 * Image cost = `usage.input_tokens` for a request that holds the text "a" and
 * the image, minus `usage.input_tokens` for the same request with the text "a"
 * alone. A size the API rejects is a result: its error is recorded.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { format, resolveConfig } from "prettier";
import { greyPng, MEASURED_SIZES } from "./media-samples";

const FIXTURE = new URL("../src/fixtures/media-openai.json", import.meta.url);
const SPEND_CAP = Number(process.env.MEDIA_SPEND_CAP ?? 2.5);
const CONCURRENCY = 6;

const MODELS = ["gpt-5", "gpt-5.5", "gpt-6.1-sol", "gpt-4.1-mini", "gpt-4o"];

/** Dollars per token: the `pricing` of `openai/<id>` in the AI Gateway model list. */
const PRICES: Record<string, { input: number; output: number }> = {
  "gpt-5": { input: 0.00000125, output: 0.00001 },
  "gpt-5.5": { input: 0.000005, output: 0.00003 },
  "gpt-6.1-sol": { input: 0.000002, output: 0.00001 },
  "gpt-4.1-mini": { input: 0.0000004, output: 0.0000016 },
  "gpt-4o": { input: 0.0000025, output: 0.00001 },
};

/**
 * Sizes on top of MEASURED_SIZES, added where the sweep needed a boundary:
 * patch counts at which a multiplier gives a whole number, resizes that land
 * just either side of a tile, a patch or a side limit, and long strips for the
 * longest side.
 */
const EXTRA_SIZES: ReadonlyArray<readonly [number, number]> = [
  [32, 32],
  [33, 32],
  [160, 32],
  [256, 32],
  [320, 32],
  [512, 32],
  [934, 700],
  [1023, 767],
  [1025, 768],
  [1601, 1601],
  [800, 64],
  [1026, 769],
  [2049, 513],
  [1067, 800],
  [2050, 1024],
  [33, 513],
  [44, 700],
  [2049, 33],
  [2080, 33],
  [1555, 1025],
  [2002, 1259],
  [2279, 1091],
  [8000, 32],
  [12000, 32],
];

const SIZES = [...MEASURED_SIZES, ...EXTRA_SIZES];
const DRY_RUN_SIZES: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [1000, 1000],
  [4000, 4000],
];

/** Smallest first. `null` sends no `reasoning` field: non-reasoning models reject it. */
const EFFORTS = ["none", "minimal", "low", null] as const;
type Effort = (typeof EFFORTS)[number];

const PROBE_SIZE = [1338, 579] as const;
const PROBE_PAIR_SIZE = [640, 480] as const;

const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("set OPENAI_API_KEY");

const spend = { dollars: 0, input: 0, output: 0 };

class SpendCapExceeded extends Error {}

const NO_USAGE = "usage reported no input tokens";

type Part =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: string };

type Reply =
  | { ok: true; input: number; output: number; model: string }
  | { ok: false; error: string };

/** The part of an API error that is safe and short to keep. */
function shorten(message: string): string {
  return message
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-…")
    .replace(/\s*\(?request id [\w-]+\)?\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

async function request(
  model: string,
  effort: Effort,
  content: Part[]
): Promise<Reply> {
  const body = JSON.stringify({
    model,
    input: [{ role: "user", content }],
    max_output_tokens: 16,
    store: false,
    ...(effort ? { reasoning: { effort } } : {}),
  });
  let error = "retries exhausted";
  let empty = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body,
      });
    } catch (e) {
      error = shorten(String(e));
      await Bun.sleep(1000 * 2 ** attempt);
      continue;
    }
    const json = (await res.json().catch(() => ({}))) as {
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      error?: { message?: string };
    };
    if (res.status === 429 || res.status >= 500) {
      error = `${res.status} ${shorten(json.error?.message ?? "")}`;
      await Bun.sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) {
      return {
        ok: false,
        error: shorten(json.error?.message ?? `status ${res.status}`),
      };
    }
    const { input_tokens: input, output_tokens: output } = json.usage ?? {};
    // A reasoning model that spends all 16 output tokens before it writes
    // anything is sometimes reported with 0 input tokens (gpt-5 at "minimal"
    // effort always is). That is no measurement: ask again, then give up.
    if (!input || output === undefined) {
      error = NO_USAGE;
      if (++empty < 3) continue;
      return { ok: false, error };
    }
    const price = PRICES[model]!;
    spend.input += input;
    spend.output += output;
    spend.dollars += input * price.input + output * price.output;
    if (spend.dollars > SPEND_CAP) throw new SpendCapExceeded();
    return { ok: true, input, output, model: json.model ?? model };
  }
  return { ok: false, error };
}

const TEXT: Part = { type: "input_text", text: "a" };

type Format = "png" | "jpeg";

interface ImageSpec {
  width: number;
  height: number;
  /** `undefined` leaves the field out of the request. */
  detail: string | undefined;
  format?: Format;
}

const encoded = new Map<string, string>();

function imagePart({ width, height, detail, format = "png" }: ImageSpec): Part {
  const key = `${format}-${width}x${height}`;
  let data = encoded.get(key);
  if (!data) {
    const bytes =
      format === "png" ? greyPng(width, height) : greyJpeg(width, height);
    data = bytes.toString("base64");
    encoded.set(key, data);
  }
  return {
    type: "input_image",
    image_url: `data:image/${format};base64,${data}`,
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * A flat grey baseline JPEG, one component, standard Huffman tables. Every
 * 8x8 block is "DC difference 0, end of block", so the entropy data is the
 * same six bits per block.
 */
function greyJpeg(width: number, height: number): Buffer {
  const segment = (marker: number, body: number[]) =>
    Buffer.from([
      0xff,
      marker,
      (body.length + 2) >> 8,
      (body.length + 2) & 255,
      ...body,
    ]);
  const dcCounts = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
  const acCounts = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
  // prettier-ignore
  const acSymbols = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
    0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
    0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
    0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
    0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
    0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3,
    0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
    0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
    0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
    0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ];
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  const scan: number[] = [];
  let bits = 0;
  let nbits = 0;
  const put = (value: number, length: number) => {
    bits = (bits << length) | value;
    nbits += length;
    while (nbits >= 8) {
      const byte = (bits >> (nbits - 8)) & 255;
      scan.push(byte);
      if (byte === 0xff) scan.push(0);
      nbits -= 8;
    }
    bits &= (1 << nbits) - 1;
  };
  for (let i = 0; i < blocks; i++) {
    put(0b00, 2); // DC: category 0
    put(0b1010, 4); // AC: end of block
  }
  if (nbits) put((1 << (8 - nbits)) - 1, 8 - nbits);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xdb, [0, ...new Array<number>(64).fill(1)]),
    segment(0xc0, [
      8,
      height >> 8,
      height & 255,
      width >> 8,
      width & 255,
      1,
      1,
      0x11,
      0,
    ]),
    segment(0xc4, [
      0x00,
      ...dcCounts,
      ...Array.from({ length: 12 }, (_, i) => i),
    ]),
    segment(0xc4, [0x10, ...acCounts, ...acSymbols]),
    segment(0xda, [1, 1, 0x00, 0, 63, 0]),
    Buffer.from(scan),
    Buffer.from([0xff, 0xd9]),
  ]);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]!);
      }
    })
  );
  return results;
}

type Measured = { tokens: number } | { error: string };

interface ModelRun {
  id: string;
  /** The id the API says it served, for an alias such as `gpt-5`. */
  resolved: string;
  effort: Effort;
  baseline: number;
  details: string[];
  /** Whether the fixture from an earlier run holds this snapshot's results. */
  seeded: boolean;
  /** Replies by request shape, so no request is paid for twice. */
  cache: Map<string, Promise<Measured>>;
}

/** Tokens the images add to a request that also holds the text "a". */
function measure(run: ModelRun, key: string, parts: Part[]): Promise<Measured> {
  let hit = run.cache.get(key);
  if (!hit) {
    hit = request(run.id, run.effort, parts).then((reply) =>
      reply.ok ? { tokens: reply.input - run.baseline } : { error: reply.error }
    );
    run.cache.set(key, hit);
  }
  return hit;
}

const imageKey = ({ format = "png", width, height, detail }: ImageSpec) =>
  `${format} ${width}x${height} ${detail}`;

function measureImage(run: ModelRun, spec: ImageSpec): Promise<Measured> {
  return measure(run, imageKey(spec), [TEXT, imagePart(spec)]);
}

/**
 * `previous` is the model's entry in the fixture from an earlier run. Its cases
 * are kept when the same model snapshot, effort and baseline measured them, so
 * a rerun pays only for the sizes it has not seen.
 */
async function setup(id: string, previous?: FixtureModel): Promise<ModelRun> {
  let lastError = "";
  for (const effort of EFFORTS) {
    const reply = await request(id, effort, [TEXT]);
    if (!reply.ok) {
      lastError = reply.error;
      continue;
    }
    const run: ModelRun = {
      id,
      resolved: reply.model,
      effort,
      baseline: reply.input,
      details: [],
      seeded: false,
      cache: new Map(),
    };
    run.details = await supportedDetails(run);
    if (
      previous?.resolvedModel === run.resolved &&
      previous.reasoningEffort === run.effort &&
      previous.baseline === run.baseline
    ) {
      run.seeded = true;
      for (const { width, height, detail, ...result } of previous.cases) {
        if (result.error === NO_USAGE) continue;
        const key = imageKey({ width, height, detail });
        run.cache.set(key, Promise.resolve(result as Measured));
      }
    }
    return run;
  }
  throw new Error(lastError);
}

/** The API lists the accepted values in the error for a value it rejects. */
async function supportedDetails(run: ModelRun): Promise<string[]> {
  const reply = await request(run.id, run.effort, [
    TEXT,
    imagePart({ width: 8, height: 8, detail: "?" }),
  ]);
  const listed =
    !reply.ok && /Supported values are:(.*)$/.exec(reply.error)?.[1];
  const values = listed
    ? [...listed.matchAll(/'([\w-]+)'/g)].map((match) => match[1]!)
    : [];
  const first = ["auto", "low", "high"];
  if (!first.every((detail) => values.includes(detail))) {
    throw new Error(
      `cannot read the detail values from: ${reply.ok ? "an accepted request" : reply.error}`
    );
  }
  return [...first, ...values.filter((detail) => !first.includes(detail))];
}

interface Case {
  width: number;
  height: number;
  detail: string;
  tokens?: number;
  error?: string;
}

interface FixtureModel {
  resolvedModel: string;
  reasoningEffort: Effort;
  baseline: number;
  cases: Case[];
}

interface Fixture {
  models: Record<string, FixtureModel>;
  probes: Record<string, object>;
}

function readFixture(): Fixture {
  return existsSync(FIXTURE)
    ? (JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture)
    : { models: {}, probes: {} };
}

async function sweep(
  run: ModelRun,
  sizes: ReadonlyArray<readonly [number, number]> = SIZES
): Promise<Case[]> {
  const jobs = sizes.flatMap(([width, height]) =>
    run.details.map((detail) => ({ width, height, detail }))
  );
  return mapLimit(jobs, CONCURRENCY, async (job) => ({
    ...job,
    ...(await measureImage(run, job)),
  }));
}

function cell(result: Case): string {
  return `${result.detail}=${result.tokens ?? "ERR"}`;
}

function printSizes(run: ModelRun, cases: Case[]): void {
  for (let i = 0; i < cases.length; i += run.details.length) {
    const row = cases.slice(i, i + run.details.length);
    const { width, height } = row[0]!;
    console.log(
      `${run.id.padEnd(13)} ${`${width}x${height}`.padEnd(10)} ${row.map(cell).join(" ")}`
    );
  }
}

/** One case each; every number is tokens added by the image. */
async function probes(run: ModelRun) {
  const [width, height] = PROBE_SIZE;
  const [pairWidth, pairHeight] = PROBE_PAIR_SIZE;
  const tokens = (m: Measured) => ("tokens" in m ? m.tokens : m.error);
  const png = (w: number, h: number, detail?: string): ImageSpec => ({
    width: w,
    height: h,
    detail,
  });
  const one = await measureImage(run, png(pairWidth, pairHeight, "high"));
  const two = await measure(run, `two ${pairWidth}x${pairHeight}`, [
    TEXT,
    imagePart(png(pairWidth, pairHeight, "high")),
    imagePart(png(pairWidth, pairHeight, "high")),
  ]);
  const jpeg = await measureImage(run, {
    ...png(width, height, "high"),
    format: "jpeg",
  });
  const pngReply = await measureImage(run, png(width, height, "high"));
  const omitted = await measureImage(run, png(width, height, undefined));
  const auto = await measureImage(run, png(width, height, "auto"));
  const imageFirst = await measure(run, `first ${width}x${height}`, [
    imagePart(png(width, height, "high")),
    TEXT,
  ]);
  return {
    twoImages: {
      width: pairWidth,
      height: pairHeight,
      detail: "high",
      one: tokens(one),
      both: tokens(two),
      second:
        "tokens" in one && "tokens" in two ? two.tokens - one.tokens : null,
    },
    jpeg: {
      width,
      height,
      detail: "high",
      png: tokens(pngReply),
      jpeg: tokens(jpeg),
    },
    detailOmitted: {
      width,
      height,
      auto: tokens(auto),
      omitted: tokens(omitted),
    },
    imageFirst: {
      width,
      height,
      detail: "high",
      textFirst: tokens(pngReply),
      imageFirst: tokens(imageFirst),
    },
  };
}

function dollars(value: number): string {
  return `$${value.toFixed(4)}`;
}

async function writeFixture(models: object, probeResults: object) {
  const fixture = {
    provider: "openai",
    measuredAt: new Date().toISOString().slice(0, 10),
    unit: 'Image tokens = usage.input_tokens of a /responses request holding the text "a" and the image, minus usage.input_tokens of the request holding the text "a" alone (the baseline of that model).',
    models,
    probes: probeResults,
  };
  const path = FIXTURE.pathname;
  // One line per case, so a rerun that adds sizes adds lines to the diff.
  const json = JSON.stringify(fixture, null, 2).replace(
    /\{\s+("width"[^{}]*?)\s+\}/g,
    (_, body: string) => `{ ${body.replace(/\n\s*/g, " ")} }`
  );
  const text = await format(json, {
    ...(await resolveConfig(path)),
    filepath: path,
  });
  writeFileSync(FIXTURE, text);
}

/**
 * Measures the three dry-run sizes and prices every size of the sweep at the
 * dry-run size nearest to it in pixel count, as if nothing were reused from an
 * earlier run: a rough number, not a bound.
 */
async function dryRun(run: ModelRun): Promise<number> {
  const costs: number[] = [];
  for (const size of DRY_RUN_SIZES) {
    const cases = await sweep(run, [size]);
    const inputTokens = cases.reduce(
      (sum, { tokens }) =>
        sum + (tokens === undefined ? 0 : tokens + run.baseline),
      0
    );
    costs.push(inputTokens * PRICES[run.id]!.input);
  }
  const logPixels = ([width, height]: readonly [number, number]) =>
    Math.log(width * height);
  return SIZES.reduce((sum, size) => {
    const distances = DRY_RUN_SIZES.map((dry) =>
      Math.abs(logPixels(dry) - logPixels(size))
    );
    return sum + costs[distances.indexOf(Math.min(...distances))]!;
  }, 0);
}

async function main() {
  const dryRunOnly = process.argv.includes("--dry-run");
  const previous = readFixture();
  const runs: { run: ModelRun; estimate: number }[] = [];
  for (const id of MODELS) {
    try {
      const run = await setup(id, previous.models[id]);
      const forSweep = await dryRun(run);
      runs.push({ run, estimate: forSweep });
      console.log(
        `${id}: served by ${run.resolved}, effort ${run.effort ?? "none sent"}, baseline ${run.baseline}, details ${run.details.join("/")}, ${run.seeded ? "reusing the fixture" : "measuring from scratch"}, full sweep from scratch about ${dollars(forSweep)}`
      );
    } catch (e) {
      console.log(`${id}: FAILED ${shorten(String(e))}`);
    }
  }
  const estimate = runs.reduce((sum, { estimate }) => sum + estimate, 0);
  console.log(
    `dry run spend ${dollars(spend.dollars)}, a sweep from scratch would add about ${dollars(estimate)}`
  );
  if (dryRunOnly) return;
  runs.sort((a, b) => a.estimate - b.estimate);

  const models: Record<string, object> = { ...previous.models };
  const probeResults: Record<string, object> = { ...previous.probes };
  try {
    for (const { run } of runs) {
      const cases = await sweep(run);
      printSizes(run, cases);
      if (!run.seeded || !(run.id in previous.probes)) {
        probeResults[run.id] = await probes(run);
      }
      models[run.id] = {
        resolvedModel: run.resolved,
        reasoningEffort: run.effort,
        baseline: run.baseline,
        cases,
      };
      console.log(`${run.id}: spend ${dollars(spend.dollars)} so far`);
    }
  } catch (e) {
    if (!(e instanceof SpendCapExceeded)) throw e;
    console.log(
      `ABORT: spend passed ${dollars(SPEND_CAP)}; keeping finished models`
    );
    process.exitCode = 2;
  }
  const inOrder = (byModel: Record<string, object>) =>
    Object.fromEntries(
      MODELS.filter((id) => id in byModel).map((id) => [id, byModel[id]!])
    );
  await writeFixture(inOrder(models), inOrder(probeResults));
  const cases = Object.values(models).flatMap(
    (model) => (model as FixtureModel).cases
  );
  const rejected = cases.filter((c) => c.error !== undefined).length;
  console.log(
    `${cases.length - rejected} cases measured, ${rejected} rejected, spend ${dollars(spend.dollars)} (input ${spend.input} tokens, output ${spend.output} tokens)`
  );
}

await main();
