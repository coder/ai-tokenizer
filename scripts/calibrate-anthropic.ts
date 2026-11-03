/**
 * Measures every Claude model with Anthropic's count_tokens and writes
 * src/models.json for them. Run it as
 *
 *   bun scripts/generate-model-configs.ts --provider anthropic [--model <id>]
 *
 * The tool fields come from the probes in ./probes.ts, the message fields from
 * the probes below. A model is written only when the sdk's `count()` gives the
 * API's number on every probe and on a set of check conversations, so a
 * mismatch between what `count()` models and what the API charges fails here.
 * Metadata comes from the AI Gateway's public model list.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import Tokenizer from "../src/tokenizer";
import * as encodings from "../src/encoding";
import { count } from "../src/sdk";
import type { AnthropicTokens, Model, ModelTokens, PdfTokens } from "../src";
import { imageTokens } from "../src/image-tokens";
import { countMessagesTokens, mapLimit } from "./anthropic";
import { greyPng, pdf } from "./media-samples";
import { fitAnthropicImage, unreadablePdfTokens } from "./fit-media";
import { pdfTokens } from "../src/pdf-tokens";
import { toolProbes, type ToolProbeName } from "./probes";

/**
 * Every Claude model the API counts, with the encoding that matches it. A
 * model that is not here is refused: its encoding has to be measured, not
 * guessed.
 */
const CLAUDE_ENCODINGS: Record<string, keyof typeof encodings> = {
  "claude-haiku-4-5": "claude_v3",
  "claude-sonnet-4-5": "claude_v3",
  "claude-opus-4-5": "claude_v3",
  "claude-opus-4-6": "claude_v3",
  "claude-sonnet-4-6": "claude_v3",
  "claude-opus-4-7": "claude_v4_7",
  "claude-opus-4-8": "claude_v4_8",
  "claude-sonnet-5": "claude_v4_8",
  "claude-fable-5": "claude_v4_8",
  "claude-opus-5": "claude_v5",
  "claude-opus-5-5": "claude_v5",
  "claude-sonnet-5-5": "claude_v5",
  "claude-haiku-5-5": "claude_v5",
  "claude-fable-5-1": "claude_v5",
};

/**
 * Claude models the gateway no longer lists and the API no longer counts keep
 * their entries, on the encoding of the Claude models around them, with the
 * measurements of this model.
 */
const RETIRED_ENCODING = "claude_v3";
const RETIRED_MEASURED_AS = "claude-sonnet-4-5";

/** The pricing keys models.json holds. The gateway adds nested ones. */
const PRICING_KEYS = [
  "input",
  "output",
  "input_cache_read",
  "input_cache_write",
];

interface GatewayModel {
  id: string;
  name: string;
  type: string;
  context_window: number;
  max_tokens: number;
  pricing: Record<string, unknown>;
}

interface Entry {
  encoding: string;
  tokens: ModelTokens;
  name: string;
  contextWindow: number;
  maxTokens: number;
  pricing: Record<string, number>;
}

/** `anthropic/claude-opus-4.5-batch` is `claude-opus-4-5`: the API has one id per model. */
export function claudeApiId(gatewayId: string): string {
  return gatewayId
    .replace(/^anthropic\//, "")
    .replace(/-(batch|fast)$/, "")
    .replace(/\./g, "-");
}

/** False for a Claude model that count_tokens no longer takes, and for -batch and -fast ids, which share their base model's measurements. */
export function isMeasurableClaude(gatewayId: string): boolean {
  return (
    claudeApiId(gatewayId) in CLAUDE_ENCODINGS &&
    !/-(batch|fast)$/.test(gatewayId)
  );
}

const getTokenizer = (name: keyof typeof encodings) =>
  new Tokenizer(encodings[name]);

const user = (content: string): ModelMessage => ({ role: "user", content });
const assistant = (content: string): ModelMessage => ({
  role: "assistant",
  content,
});

const f = tool({ inputSchema: z.object({}) });
const toolCall = (input: Record<string, unknown>): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: "call_1", toolName: "f", input }],
});
const toolResult = (output: {
  type: string;
  value?: unknown;
}): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: "call_1",
      toolName: "f",
      output: output as never,
    },
  ],
});

/** Pixels of the image the probes send: 4 patches on every Claude model. */
const PROBE_IMAGE = { width: 56, height: 56 };
const probeImage = (size = PROBE_IMAGE) =>
  greyPng(size.width, size.height).toString("base64");
const userImage = (size?: { width: number; height: number }) => ({
  type: "file",
  mediaType: "image/png",
  data: probeImage(size),
});
const resultImage = () => ({
  type: "file",
  mediaType: "image/png",
  data: { type: "data", data: probeImage() },
});
const userPdf = (...pages: Parameters<typeof pdf>[0]) =>
  ({
    role: "user",
    content: [
      { type: "text", text: "a" },
      {
        type: "file",
        mediaType: "application/pdf",
        data: pdf(pages).toString("base64"),
      },
    ],
  }) as ModelMessage;
const resultText = (text: string) => ({ type: "text", text });
const toolContent = (...value: unknown[]): ModelMessage =>
  toolResult({ type: "content", value });

/** A page is drawn with its long edge at 1568 px, on every Claude model. */
const PDF_PAGE: PdfTokens["page"] = {
  patch: 28,
  edge: 1568,
  maxPatches: 1568,
  overhead: 3,
};

export interface MessageProbe {
  messages: ModelMessage[];
  tools?: ToolSet;
}

/** The probes the message fields come from. Each difference isolates one field. */
const messageProbes = {
  user: { messages: [user("a")] },
  userAssistant: { messages: [user("a"), assistant("b")] },
  userAssistantUser: { messages: [user("a"), assistant("b"), user("c")] },
  system: { messages: [{ role: "system", content: "x" }, user("a")] },
  // The tool probes below all send the tool `f`, so its definition cancels.
  toolOnly: { messages: [user("a")], tools: { f } },
  cycle: {
    messages: [
      user("a"),
      toolCall({}),
      toolResult({ type: "text", value: "b" }),
    ],
    tools: { f },
  },
  twoCycles: {
    messages: [
      user("a"),
      toolCall({}),
      toolResult({ type: "text", value: "b" }),
      toolCall({}),
      toolResult({ type: "text", value: "b" }),
    ],
    tools: { f },
  },
  cycleParam: {
    messages: [
      user("a"),
      toolCall({ y: "b" }),
      toolResult({ type: "text", value: "b" }),
    ],
    tools: { f },
  },
  cycleError: {
    messages: [
      user("a"),
      toolCall({}),
      toolResult({ type: "error-text", value: "b" }),
    ],
    tools: { f },
  },
  cycleEmpty: {
    messages: [
      user("a"),
      toolCall({}),
      toolResult({ type: "text", value: "" }),
    ],
    tools: { f },
  },
  cycleAnswered: {
    messages: [
      user("a"),
      toolCall({}),
      toolResult({ type: "text", value: "b" }),
      assistant("b"),
    ],
    tools: { f },
  },
  cycleAnsweredThenUser: {
    messages: [
      user("a"),
      toolCall({}),
      toolResult({ type: "text", value: "b" }),
      assistant("b"),
      user("c"),
    ],
    tools: { f },
  },
  userImage: {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "a" }, userImage()],
      } as ModelMessage,
    ],
  },
  cycleImage: {
    messages: [user("a"), toolCall({}), toolContent(resultImage())],
    tools: { f },
  },
  cycleTwoImages: {
    messages: [
      user("a"),
      toolCall({}),
      toolContent(resultImage(), resultImage()),
    ],
    tools: { f },
  },
  cycleTextImage: {
    messages: [
      user("a"),
      toolCall({}),
      toolContent(resultText("b"), resultImage()),
    ],
    tools: { f },
  },
  pdfBlank: { messages: [userPdf({})] },
  pdfTwoBlank: { messages: [userPdf({}, {})] },
  pdfText: { messages: [userPdf({ words: 30 })] },
  cycleThenText: {
    messages: [
      user("a"),
      toolCall({}),
      toolResult({ type: "text", value: "b" }),
      user("c"),
    ],
    tools: { f },
  },
} satisfies Record<string, MessageProbe>;

/**
 * Conversations `count()` must get exactly right once the fields are
 * measured. They cover what the probes do not: text that joins, trims and
 * absorbs, nested and non-string tool inputs, results of every kind, a tool
 * with more than one property, and a final assistant message.
 */
export const checkConversations: Record<string, MessageProbe> = {
  systemAndUser: {
    messages: [
      { role: "system", content: "You are brief.  " },
      user("Hello there.  "),
    ],
  },
  systemMessagesJoin: {
    messages: [
      { role: "system", content: "Be " },
      { role: "system", content: "brief." },
      user("Hello there."),
    ],
  },
  assistantMessagesJoin: {
    messages: [
      user("a"),
      assistant("Mixed "),
      assistant("café 日本語"),
      user("b"),
    ],
  },
  joinedUserBlocks: {
    messages: [
      user("a"),
      assistant("b  c  "),
      {
        role: "user",
        content: [
          { type: "text", text: "Mixed café 日本語 " },
          { type: "text", text: "second block  " },
        ],
      },
    ],
  },
  whitespaceOnlyLastBlock: {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "a  " },
          { type: "text", text: "   " },
        ],
      },
    ],
  },
  toolCycles: {
    messages: [
      { role: "system", content: "Use the tools." },
      user("Find it"),
      toolCall({ query: "needle", scope: "all" }),
      toolResult({ type: "text", value: "Found it in 3 files." }),
      assistant("Found it."),
      user("Again"),
      toolCall({ query: "again" }),
      toolResult({ type: "error-text", value: "boom" }),
      toolCall({ query: "retry" }),
      toolResult({ type: "text", value: "" }),
      toolCall({ query: "last" }),
      toolResult({ type: "text", value: "ok" }),
      user("thanks  "),
      assistant("You are welcome"),
    ],
    tools: { f },
  },
  finalAssistant: {
    messages: [user("Say hi"), assistant("Hi there  ")],
  },
  pdfPages: {
    messages: [
      userPdf(
        { words: 120 },
        { width: 595, height: 842 },
        { width: 300, height: 200, words: 5 }
      ),
    ],
  },
  userImages: {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Compare these" },
          userImage({ width: 640, height: 480 }),
          userImage({ width: 3000, height: 2000 }),
          userImage({ width: 1, height: 1 }),
        ],
      } as ModelMessage,
    ],
  },
  toolImages: {
    messages: [
      user("Look"),
      toolCall({ q: "screen" }),
      toolContent(
        resultText("Screenshot"),
        resultImage(),
        resultText("and its twin"),
        resultImage()
      ),
      assistant("Seen."),
    ],
    tools: { f },
  },
};

/**
 * What `count()` does not get exactly: numbers and nested values in a tool
 * call, and JSON in a tool result. They are measured and reported, not gated.
 */
export const residualConversations: Record<string, MessageProbe> = {
  nestedInputNumberAndJsonResult: {
    messages: [
      user("Find it"),
      toolCall({ limit: 3, nested: { a: [1, 2], b: null } }),
      toolResult({ type: "json", value: { found: true, items: ["a", "b"] } }),
      assistant("Done."),
    ],
    tools: { f },
  },
};

/**
 * What `count()` may be off, in tokens, on a conversation with a tool call. The
 * API charges 1 token more for the first tool call of a conversation on the
 * Claude 4.x models, and `count()` charges every one the same.
 */
const TOOL_CALL_TOLERANCE = 2;

const hasToolCall = (probe: MessageProbe) =>
  probe.messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "tool-call")
  );

type Run = (probe: MessageProbe) => Promise<number>;

interface Measured {
  tokens: ModelTokens;
  checked: number;
  /** `count()` minus the API, per conversation in `residualConversations`. */
  residuals: Record<string, number>;
}

/** The ModelTokens of one API model, measured and then checked against `count()`. */
async function measure(
  apiModel: string,
  encoding: keyof typeof encodings
): Promise<Measured> {
  const tokenizer = getTokenizer(encoding);
  const n = (text: string) => tokenizer.countUntrimmed(text);
  const run: Run = (probe) =>
    countMessagesTokens(apiModel, probe.messages, probe.tools);

  const probes: Record<string, MessageProbe> = {
    ...messageProbes,
    ...toolProbes,
    ...checkConversations,
  };
  const names = Object.keys(probes);
  const counts = Object.fromEntries(
    await Promise.all(
      [...names, ...Object.keys(residualConversations)].map(async (name) => [
        name,
        await run(probes[name] ?? residualConversations[name]!),
      ])
    )
  ) as Record<string, number>;
  const m = counts as Record<keyof typeof messageProbes, number> &
    Record<ToolProbeName, number>;

  // `count()` has the assistant message cost its text and nothing else.
  if (m.userAssistant - m.user !== n("b")) {
    throw new Error(
      `${apiModel}: an assistant message costs ${m.userAssistant - m.user - n("b")} tokens beyond its text`
    );
  }
  const innerProps = m.flatTwoProps - m.emptyTool;
  const userTurn = m.userAssistantUser - m.userAssistant - n("c");
  // From the second cycle: the first one costs 1 token more on some models.
  const toolResultTokens = m.twoCycles - m.cycle - userTurn - n("f") - n("b");
  const media = fitAnthropicImage(apiModel);
  const probeCost = imageTokens(media.image, PROBE_IMAGE);
  const imageAlone = m.cycleImage - m.cycle + n("b") - probeCost;
  const imageInToolResult = m.cycleTwoImages - m.cycleImage - probeCost;
  // A PDF with every field 0 costs its page images and its text: what is
  // measured beyond that is the block's own overhead.
  const bare = {
    base: 0,
    perPage: 0,
    textDiscount: 0,
    page: PDF_PAGE,
    unreadable: 0,
  };
  const pdfBare = (...pages: Parameters<typeof pdf>[0]) =>
    pdfTokens(bare, tokenizer, pdf(pages));
  const perPage = m.pdfTwoBlank - m.pdfBlank - (pdfBare({}, {}) - pdfBare({}));
  const pdfRecipe: PdfTokens = {
    base: m.pdfBlank - m.user - pdfBare({}) - perPage,
    perPage,
    textDiscount:
      pdfBare({ words: 30 }) - pdfBare({}) - (m.pdfText - m.pdfBlank),
    page: PDF_PAGE,
    unreadable: unreadablePdfTokens(encoding),
  };
  const anthropic: AnthropicTokens = {
    userTurn,
    system: m.system - m.user - n("x"),
    toolUseParam: m.cycleParam - m.cycle - n("y") - n("b"),
    perArray: m.arrayOfStrings - m.describedItems,
    userTurnAfterToolResult:
      m.cycleAnsweredThenUser - m.cycleAnswered - userTurn - n("c"),
    toolResult: toolResultTokens,
    toolResultError: m.cycleError - m.cycle,
    emptyToolResult: m.cycleEmpty - m.cycle + n("b"),
    textAfterToolResult: m.cycleThenText - m.cycle - n("c"),
    imageInToolResult,
    toolResultWithImage: imageAlone - imageInToolResult,
    textInImageToolResult: m.cycleTextImage - m.cycleImage - n("b"),
  };
  const perFirstProp = m.oneProp - m.emptyTool - n("y");
  const perPropDesc = m.propWithDesc - m.oneProp - n("Hi");
  const tokens: ModelTokens = {
    contentMultiplier: 1,
    baseOverhead: m.user - n("a"),
    perMessage: 0,
    toolsExist: m.emptyTool - m.noTools - n("x"),
    perTool: m.twoTools - m.emptyTool - n("y"),
    perDesc: m.withDesc - m.emptyTool - n("Hi"),
    perFirstProp,
    perAdditionalProp: m.twoProp - m.oneProp - n("z"),
    perPropDesc,
    // `count()` counts the values as the JSON array the API reads.
    perEnum: m.enumProp - m.stringProp - n('["a", "b", "c"]'),
    perNestedObject:
      m.nestedTwoProps -
      m.flatTwoProps -
      n("data") -
      perFirstProp -
      perPropDesc -
      n("Data"),
    perArrayOfObjects: m.arrayOfObjects - m.arrayOfStrings - innerProps,
    anthropic,
    media: { ...media, pdf: pdfRecipe },
  };

  // Every probe, and every check, must come out the way the API counted it.
  const model = { tokens } as Model;
  const counted = (probe: MessageProbe) =>
    count({
      tokenizer,
      model,
      messages: probe.messages,
      tools: probe.tools,
    }).total;
  const mismatches = names.flatMap((name) => {
    const probe = probes[name]!;
    const got = counted(probe);
    const allowed = hasToolCall(probe) ? TOOL_CALL_TOLERANCE : 0;
    return Math.abs(got - counts[name]!) <= allowed
      ? []
      : [`${name}: count() ${got}, API ${counts[name]}`];
  });
  if (mismatches.length > 0) {
    throw new Error(`${apiModel}:\n  ${mismatches.join("\n  ")}`);
  }
  const residuals = Object.fromEntries(
    Object.entries(residualConversations).map(([name, probe]) => [
      name,
      counted(probe) - counts[name]!,
    ])
  );
  return { tokens, checked: names.length, residuals };
}

async function fetchGatewayClaudeModels(): Promise<GatewayModel[]> {
  const response = await fetch("https://ai-gateway.vercel.sh/v1/models");
  if (!response.ok) {
    throw new Error(`AI Gateway model list: ${response.status}`);
  }
  const { data } = (await response.json()) as { data: GatewayModel[] };
  return data.filter(
    (model) =>
      model.type === "language" && model.id.startsWith("anthropic/claude-")
  );
}

function pricingOf(model: GatewayModel): Record<string, number> {
  const pricing: Record<string, number> = {};
  for (const key of PRICING_KEYS) {
    const value = Number(model.pricing[key]);
    if (model.pricing[key] !== undefined && Number.isFinite(value)) {
      pricing[key] = value;
    }
  }
  return pricing;
}

export async function generateAnthropicConfigs(only?: string): Promise<void> {
  const path = join(process.cwd(), "src", "models.json");
  const existing = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    Entry
  >;
  const gateway = await fetchGatewayClaudeModels();
  const listed = new Set(gateway.map((model) => model.id));
  const retired = Object.keys(existing).filter(
    (id) => id.startsWith("anthropic/claude-") && !listed.has(id)
  );
  const wanted = (id: string) => only === undefined || id.includes(only);

  // One measurement per API model: -batch and -fast ids count like their base.
  const apiModels = new Map<string, keyof typeof encodings>();
  for (const model of gateway) {
    const apiModel = claudeApiId(model.id);
    const encoding = CLAUDE_ENCODINGS[apiModel];
    if (!encoding) {
      throw new Error(
        `${model.id}: no encoding for ${apiModel}. Measure it, then add it to CLAUDE_ENCODINGS.`
      );
    }
    apiModels.set(apiModel, encoding);
  }
  const needed = [
    ...new Set(
      [...gateway.map((model) => model.id), ...retired]
        .filter(wanted)
        .map((id) => (listed.has(id) ? claudeApiId(id) : RETIRED_MEASURED_AS))
    ),
  ];
  console.log(`Measuring ${needed.length} Claude models with count_tokens...`);
  const measured = new Map<string, Measured>();
  await mapLimit(needed, 4, async (apiModel) => {
    const encoding = apiModels.get(apiModel);
    if (!encoding) {
      throw new Error(`${apiModel} is not on the gateway list`);
    }
    const result = await measure(apiModel, encoding);
    measured.set(apiModel, result);
    console.log(
      `  ${apiModel.padEnd(20)} ${encoding.padEnd(12)} ${result.checked} probes ok, frame ${result.tokens.baseOverhead}, user turn ${result.tokens.anthropic!.userTurn}`
    );
  });

  const entries = new Map<string, Entry>();
  for (const model of gateway) {
    if (!wanted(model.id)) continue;
    const apiModel = claudeApiId(model.id);
    entries.set(model.id, {
      encoding: apiModels.get(apiModel)!,
      tokens: measured.get(apiModel)!.tokens,
      name: model.name,
      contextWindow: model.context_window,
      maxTokens: model.max_tokens,
      pricing: pricingOf(model),
    });
  }
  for (const id of retired.filter(wanted)) {
    const { encoding: _old, tokens: _tokens, ...metadata } = existing[id]!;
    entries.set(id, {
      encoding: RETIRED_ENCODING,
      tokens: measured.get(RETIRED_MEASURED_AS)!.tokens,
      ...metadata,
    });
  }

  // Existing entries keep their place. New ones follow the last Claude entry.
  const lastClaude = Object.keys(existing)
    .filter((id) => id.startsWith("anthropic/claude-"))
    .at(-1);
  const result: Record<string, Entry> = {};
  const add = (id: string) => {
    result[id] = entries.get(id) ?? existing[id]!;
  };
  for (const id of Object.keys(existing)) {
    add(id);
    if (id === lastClaude) {
      gateway
        .map((model) => model.id)
        .filter((added) => !(added in existing) && entries.has(added))
        .sort()
        .forEach(add);
    }
  }
  writeFileSync(path, JSON.stringify(result, null, 2) + "\n");
  console.log(
    `Wrote ${entries.size} Claude entries (${retired.filter(wanted).length} retired) to src/models.json`
  );
}
