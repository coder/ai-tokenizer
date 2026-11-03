/**
 * Refreshes src/fixtures/claude-sdk-count-tokens.json: conversations and the
 * `input_tokens` count_tokens gives for each of them on every Claude model, so
 * that `bun test` checks count() against the API without a key. Run it as
 *
 *   bun scripts/generate-claude-sdk-fixture.ts
 *
 * Honors ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY.
 * count_tokens is free.
 */
import { writeFileSync } from "node:fs";
import { format, resolveConfig } from "prettier";
import {
  asSchema,
  jsonSchema,
  tool,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { models } from "../src";
import {
  buildConversation,
  seeded,
  tools as workloadTools,
} from "./accuracy-workload";
import { countMessagesTokens, mapLimit } from "./anthropic";
import {
  checkConversations,
  claudeApiId,
  isMeasurableClaude,
  residualConversations,
} from "./calibrate-anthropic";
import Tokenizer from "../src/tokenizer";
import { count } from "../src/sdk";
import * as encodings from "../src/encoding";

type JsonTools = Record<string, { description?: string; inputSchema: object }>;

/** `exact`: no tool call, counted exactly. `calls`: a few tokens off. `schema`: a real tool schema, a percent off. */
type Kind = "exact" | "calls" | "schema";

interface Conversation {
  name: string;
  kind: Kind;
  messages: ModelMessage[];
  tools?: JsonTools;
  api: Record<string, number>;
}

function toJson(tools: ToolSet | undefined): JsonTools | undefined {
  if (!tools) return undefined;
  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => [
      name,
      {
        description:
          typeof definition.description === "string"
            ? definition.description
            : undefined,
        inputSchema: asSchema(definition.inputSchema).jsonSchema as object,
      },
    ])
  );
}

function toTools(json: JsonTools | undefined): ToolSet | undefined {
  if (!json) return undefined;
  return Object.fromEntries(
    Object.entries(json).map(([name, definition]) => [
      name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(definition.inputSchema as never),
      }),
    ])
  );
}

const hasToolCall = (messages: ModelMessage[]) =>
  messages.some(
    (m) =>
      Array.isArray(m.content) && m.content.some((p) => p.type === "tool-call")
  );

const sources: Omit<Conversation, "api">[] = [
  ...Object.entries(checkConversations).map(([name, probe]) => ({
    name,
    kind: hasToolCall(probe.messages) ? ("calls" as const) : ("exact" as const),
    messages: probe.messages,
    tools: toJson(probe.tools),
  })),
  ...Object.entries(residualConversations).map(([name, probe]) => ({
    name,
    kind: "calls" as const,
    messages: probe.messages,
    tools: toJson(probe.tools),
  })),
];

// The accuracy workload at two sizes, sized with one model so the text is shared.
const sizer = models["anthropic/claude-opus-4.6"];
const sizerTokenizer = new Tokenizer(encodings[sizer.encoding]);
for (const target of [500, 5000]) {
  sources.push({
    name: `accuracy workload, about ${target} tokens`,
    kind: "schema",
    messages: buildConversation(
      (messages) =>
        count({
          tokenizer: sizerTokenizer,
          model: sizer,
          messages,
          tools: workloadTools,
        }).total,
      target,
      seeded(target)
    ),
    tools: toJson(workloadTools),
  });
}

const gatewayIds = (Object.keys(models) as (keyof typeof models)[]).filter(
  (id) => id.startsWith("anthropic/claude-") && isMeasurableClaude(id)
);
const apiModels = Object.fromEntries(
  gatewayIds.map((id) => [id, claudeApiId(id)])
);

const conversations: Conversation[] = [];
for (const source of sources) {
  const api: Record<string, number> = {};
  await mapLimit(gatewayIds, 4, async (id) => {
    api[id] = await countMessagesTokens(
      apiModels[id]!,
      source.messages,
      toTools(source.tools)
    );
  });
  conversations.push({ ...source, api });
  console.log(`${source.name}: ${gatewayIds.length} models`);
}

const file = new URL(
  "../src/fixtures/claude-sdk-count-tokens.json",
  import.meta.url
);
writeFileSync(
  file,
  await format(JSON.stringify({ models: apiModels, conversations }), {
    ...(await resolveConfig(file.pathname)),
    parser: "json",
  })
);
console.log(`conversations: ${conversations.length}`);
