/**
 * What count() charges for an image, against what the providers charged. The
 * fixtures hold the cost of one image at many sizes, measured by
 * scripts/measure-media-*.ts, so this runs without a key.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ModelMessage } from "ai";
import { pngHeader } from "../scripts/media-samples";
import { count } from "./sdk";
import { models, Tokenizer, type Model } from "./index";
import * as o200k from "./encoding/o200k_base";
import anthropic from "./fixtures/media-anthropic.json";

const tokenizer = new Tokenizer(o200k);

/** The tokens count() gives the one image part of a user message. */
function imageTokens(model: Model, part: unknown): number {
  const { messages } = count({
    tokenizer,
    model,
    messages: [{ role: "user", content: [part] }] as ModelMessage[],
  });
  return messages[0]!.content[0]!.total;
}

const sized = (width: number, height: number) => ({
  type: "image",
  image: pngHeader(width, height).toString("base64"),
  mediaType: "image/png",
});

let checked = 0;
let exact = 0;
function expectCost(model: Model, part: unknown, measured: number) {
  const got = imageTokens(model, part);
  checked++;
  exact += got === measured ? 1 : 0;
  expect(got).toBe(measured);
}

afterAll(() => {
  console.log(`image fixtures: ${exact}/${checked} exact`);
});

/** The catalog models that count like this API model, batch and fast ids included. */
function catalogModels(provider: string, apiId: string): Model[] {
  return Object.entries(models)
    .filter(
      ([id]) =>
        id.startsWith(`${provider}/`) &&
        id
          .slice(provider.length + 1)
          .replace(/-(batch|fast)$/, "")
          .replace(/\./g, "-") === apiId
    )
    .map(([, model]) => model as Model);
}

describe("Claude images against count_tokens", () => {
  const sizes = [
    ...anthropic.models["claude-opus-4-6"].cases.map(
      (c) => [c.width, c.height] as const
    ),
    ...(anthropic.denseSizes as Array<[number, number]>),
  ];

  test.each(Object.entries(anthropic.models))("%s", (apiId, measured) => {
    const catalog = catalogModels("anthropic", apiId);
    expect(catalog.length).toBeGreaterThan(0);
    const costs = [
      ...measured.cases.map((c) => (c as { tokens: number }).tokens),
      ...measured.dense,
    ];
    expect(costs).toHaveLength(sizes.length);
    for (const model of catalog) {
      sizes.forEach(([width, height], i) =>
        expectCost(model, sized(width, height), costs[i]!)
      );
    }
  });

  test.each(Object.entries(anthropic.files))(
    "%s, a real file, costs what its header size costs",
    (file, byModel) => {
      const bytes = readFileSync(
        new URL(`./fixtures/media/${file}`, import.meta.url)
      );
      for (const [apiId, cost] of Object.entries(byModel)) {
        for (const model of catalogModels("anthropic", apiId)) {
          expectCost(
            model,
            { type: "image", image: bytes, mediaType: "image/png" },
            cost as number
          );
        }
      }
    }
  );
});

describe("images without a size", () => {
  const opus46 = models["anthropic/claude-opus-4.6"] as Model;
  const at1024 = anthropic.models["claude-opus-4-6"].cases.find(
    (c) => c.width === 1024 && c.height === 1024
  )!;

  const unsized: Array<[string, unknown]> = [
    ["a URL", { type: "image", image: new URL("https://example.com/a.png") }],
    [
      "an https string",
      {
        type: "file",
        mediaType: "image/png",
        data: "https://example.com/a.png",
      },
    ],
    [
      "a provider file",
      {
        type: "file",
        mediaType: "image",
        data: { type: "reference", reference: { openai: "file_1" } },
      },
    ],
    [
      "bytes of an unknown format",
      { type: "image", image: new Uint8Array([1, 2, 3, 4]) },
    ],
  ];

  test.each(unsized)("%s costs a 1024x1024 image", (_name, part) => {
    expect(imageTokens(opus46, part)).toBe(
      (at1024 as { tokens: number }).tokens
    );
  });
});
