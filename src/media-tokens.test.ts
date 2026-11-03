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
import * as claude_v3 from "./encoding/claude_v3";
import * as claude_v4_7 from "./encoding/claude_v4_7";
import * as claude_v4_8 from "./encoding/claude_v4_8";
import * as claude_v5 from "./encoding/claude_v5";
import { fitGeminiImage, fitOpenAiImage } from "../scripts/fit-media";
import anthropic from "./fixtures/media-anthropic.json";
import gemini from "./fixtures/media-gemini.json";
import openai from "./fixtures/media-openai.json";
import pdfs from "./fixtures/media-anthropic-pdf.json";

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

const sized = (width: number, height: number, imageDetail?: string) => ({
  type: "image",
  image: pngHeader(width, height).toString("base64"),
  mediaType: "image/png",
  ...(imageDetail && { providerOptions: { openai: { imageDetail } } }),
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

describe("OpenAI images against the Responses API", () => {
  // gpt-5.5 and gpt-6.1-sol are measured but not in the catalog: they get
  // the recipe that was fitted to them, so the fit is tested as well.
  const modelOf = (apiId: string): Model => {
    const catalog = models[`openai/${apiId}` as keyof typeof models] as
      | Model
      | undefined;
    return (catalog ?? {
      tokens: {
        ...(models["openai/gpt-5"] as Model).tokens,
        media: fitOpenAiImage(apiId),
      },
    }) as Model;
  };

  test.each(Object.entries(openai.models))("%s", (apiId, measured) => {
    const model = modelOf(apiId);
    const cases = measured.cases.filter(
      (c): c is typeof c & { tokens: number } => "tokens" in c
    );
    expect(cases.length).toBeGreaterThan(200);
    for (const c of cases) {
      expectCost(model, sized(c.width, c.height, c.detail), c.tokens);
    }
  });

  test("a model without a recipe ignores the detail", () => {
    const grok = models["xai/grok-4"] as Model;
    expect(imageTokens(grok, sized(2000, 2000, "high"))).toBe(85);
  });

  test("the catalog has the recipes of the measured models it lists", () => {
    for (const id of ["gpt-5", "gpt-4o", "gpt-4.1-mini"]) {
      expect(
        models[`openai/${id}` as keyof typeof models].tokens
      ).toHaveProperty("media");
    }
  });
});

describe("Gemini images against the AI Gateway (Vertex), at the default resolution", () => {
  // gemini-3.5-flash is measured but not in the catalog.
  const modelOf = (id: string): Model =>
    (models[id as keyof typeof models] ?? {
      tokens: {
        ...(models["google/gemini-2.5-flash"] as Model).tokens,
        media: fitGeminiImage(id),
      },
    }) as Model;

  test.each(Object.entries(gemini.models))("%s", (id, measured) => {
    const model = modelOf(id);
    const cases = measured.cases.filter(
      (c): c is typeof c & { tokens: number } =>
        "tokens" in c && c.mediaResolution === "default"
    );
    expect(cases.length).toBeGreaterThan(100);
    for (const c of cases) {
      expectCost(model, sized(c.width, c.height), c.tokens);
    }
  });

  test.each(Object.entries(gemini.probes.vertex))(
    "%s: the cost of several identical images in one request",
    (id, probe) => {
      const model = modelOf(id);
      for (const [images, total] of Object.entries(probe.identicalImages)) {
        const part = sized(probe.width, probe.height);
        const { messages } = count({
          tokenizer,
          model,
          messages: [
            { role: "user", content: Array(Number(images)).fill(part) },
          ] as ModelMessage[],
        });
        const got = messages[0]!.content.reduce((sum, c) => sum + c.total, 0);
        checked++;
        exact += got === total ? 1 : 0;
        expect(got).toBe(total);
      }
    }
  );

  test("images in different messages count as one request", () => {
    const model = modelOf("google/gemini-2.5-flash");
    const message = (content: unknown[]) => ({ role: "user", content });
    const part = sized(1920, 1080);
    const costs = (messages: unknown[]) =>
      count({
        tokenizer,
        model,
        messages: messages as ModelMessage[],
      }).messages.map((m) => m.content[0]!.total);
    expect(costs([message([part])])).toEqual([1806]);
    expect(costs([message([part]), message([part])])).toEqual([258, 258]);
  });
});

describe("Claude PDFs against count_tokens", () => {
  const encodings = { claude_v3, claude_v4_7, claude_v4_8, claude_v5 };
  // The reader does not decrypt a file with a user password, and a line just
  // below the edge of a CropBox is clipped differently on Claude 4.7 and later.
  const inexact: Record<string, number> = {
    "qpdf-encrypted.pdf": 0.05,
    "pymupdf-cropbox.pdf": 0.002,
  };
  let exactPdfs = 0;
  let checkedPdfs = 0;

  afterAll(() => {
    console.log(`pdf fixtures: ${exactPdfs}/${checkedPdfs} exact`);
  });

  test.each(Object.entries(pdfs.models))("%s", (apiId, measured) => {
    const catalog = catalogModels("anthropic", apiId);
    expect(catalog.length).toBeGreaterThan(0);
    for (const model of catalog) {
      const pdfTokenizer = new Tokenizer(
        encodings[model.encoding as keyof typeof encodings]
      );
      for (const [file, cost] of Object.entries(measured)) {
        const bytes = new Uint8Array(
          readFileSync(new URL(`./fixtures/pdf/${file}`, import.meta.url))
        );
        const { messages } = count({
          tokenizer: pdfTokenizer,
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "file", mediaType: "application/pdf", data: bytes },
              ],
            },
          ] as ModelMessage[],
        });
        const got = messages[0]!.content[0]!.total;
        const measuredCost = cost as number;
        checkedPdfs++;
        exactPdfs += got === measuredCost ? 1 : 0;
        if (file in inexact) {
          expect(Math.abs(got - measuredCost) / measuredCost).toBeLessThan(
            inexact[file]!
          );
        } else {
          expect(got).toBe(measuredCost);
        }
      }
    }
  });

  test("a PDF that cannot be read costs a typical page", () => {
    const model = models["anthropic/claude-opus-4.6"] as Model;
    const typical = model.tokens.media!.pdf!.unreadable;
    const part = (data: unknown) => ({
      type: "file",
      mediaType: "application/pdf",
      data,
    });
    for (const data of [
      new URL("https://example.com/a.pdf"),
      "Zm9vYmFy",
      new Uint8Array([1, 2, 3]),
      { type: "reference", reference: { anthropic: "file_1" } },
    ]) {
      expect(imageTokens(model, part(data))).toBe(typical);
    }
  });

  test("a model without a PDF recipe counts a PDF as a 100 token file", () => {
    const grok = models["xai/grok-4"] as Model;
    expect(
      imageTokens(grok, {
        type: "file",
        mediaType: "application/pdf",
        data: new Uint8Array(
          readFileSync(
            new URL("./fixtures/pdf/reportlab-table.pdf", import.meta.url)
          )
        ),
      })
    ).toBe(100);
  });
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
