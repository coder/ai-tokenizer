/**
 * count() against what Anthropic's count_tokens said about the same requests,
 * recorded in src/fixtures/claude-sdk-count-tokens.json by
 * scripts/generate-claude-sdk-fixture.ts. No key is needed to run it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { jsonSchema, tool, type ModelMessage, type ToolSet } from "ai";
import { count } from "./sdk";
import { models, Tokenizer, type ModelName } from "./index";
import * as encodings from "./encoding";
import fixture from "./fixtures/claude-sdk-count-tokens.json";

interface Conversation {
  name: string;
  kind: "exact" | "calls" | "schema";
  messages: ModelMessage[];
  tools?: Record<string, { description?: string; inputSchema: object }>;
  api: Record<string, number>;
}
const conversations = fixture.conversations as unknown as Conversation[];

function toolsOf(conversation: Conversation): ToolSet | undefined {
  return (
    conversation.tools &&
    Object.fromEntries(
      Object.entries(conversation.tools).map(([name, definition]) => [
        name,
        tool({
          description: definition.description,
          inputSchema: jsonSchema(definition.inputSchema as never),
        }),
      ])
    )
  );
}

/**
 * How far count() may be from the API, in tokens. The API charges a few more
 * for the first tool call of a conversation on some models, and for numbers
 * and nested values in a call. A tool schema is counted by its properties:
 * optional properties and names that JSON writes twice cost a percent or so.
 */
const tolerance = (conversation: Conversation, api: number) =>
  ({ exact: 0, calls: 2, schema: Math.ceil(api * 0.015) })[conversation.kind];

describe("count() against count_tokens", () => {
  let within = 0;
  let total = 0;
  for (const id of Object.keys(fixture.models) as ModelName[]) {
    const model = models[id];
    const tokenizer = new Tokenizer(encodings[model.encoding]);
    for (const conversation of conversations) {
      test(`${id}: ${conversation.name}`, () => {
        const api = conversation.api[id]!;
        const counted = count({
          tokenizer,
          model,
          messages: conversation.messages,
          tools: toolsOf(conversation),
        }).total;
        total++;
        expect(Math.abs(counted - api)).toBeLessThanOrEqual(
          tolerance(conversation, api)
        );
        within++;
      });
    }
  }
  afterAll(() => {
    console.log(`claude count() fixture: ${within}/${total} within tolerance`);
  });
});
