/**
 * count() for a model that counts like Anthropic's count_tokens: a model whose
 * tokens have an `anthropic` block. Every field has its own value, so a total
 * matches only when each one was applied to the right thing.
 */

import { describe, test, expect } from "bun:test";
import type { ModelMessage, ToolSet } from "ai";
import { z } from "zod";
import { count } from "./sdk";
import { Tokenizer, type AnthropicTokens, type Model } from "./index";
import * as claude_v4_8 from "./encoding/claude_v4_8";
import * as claude_v5 from "./encoding/claude_v5";

const anthropic: AnthropicTokens = {
  userTurn: 6,
  system: 3,
  toolUseParam: 15,
  perArray: 10,
  userTurnAfterToolResult: 2,
  toolResult: 39,
  toolResultError: 8,
  emptyToolResult: 14,
  textAfterToolResult: 5,
};
const model = {
  tokens: {
    contentMultiplier: 1,
    baseOverhead: 7,
    perMessage: 0,
    toolsExist: 311,
    perTool: 53,
    perDesc: 5,
    perFirstProp: 13,
    perAdditionalProp: 17,
    perPropDesc: 19,
    perEnum: 23,
    perNestedObject: 29,
    perArrayOfObjects: 31,
    anthropic,
  },
} as Model;

const v48 = new Tokenizer(claude_v4_8);
const v5 = new Tokenizer(claude_v5);
const n = (text: string) => v48.count(text);

const user = (content: string): ModelMessage => ({ role: "user", content });
const assistant = (content: string): ModelMessage => ({
  role: "assistant",
  content,
});
const system = (content: string): ModelMessage => ({ role: "system", content });
const blocks = (...texts: string[]): ModelMessage => ({
  role: "user",
  content: texts.map((text) => ({ type: "text" as const, text })),
});
const call = (
  input: Record<string, unknown>,
  toolName = "f"
): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: "call_1", toolName, input }],
});
const result = (output: unknown): ModelMessage =>
  ({
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: "call_1", toolName: "f", output },
    ],
  }) as ModelMessage;
const text = (value: string) => result({ type: "text", value });

function total(messages: ModelMessage[], tokenizer = v48, tools?: ToolSet) {
  return count({ tokenizer, model, messages, tools }).total;
}

describe("messages", () => {
  test("one user message costs the frame and its text, not its role", () => {
    expect(total([user("Hello there")])).toBe(7 + n("Hello there"));
  });

  test("an assistant message costs its text and nothing else", () => {
    expect(total([user("a"), assistant("Hi, how are you?")])).toBe(
      7 + n("a") + n("Hi, how are you?")
    );
  });

  test("a user turn after an assistant turn costs userTurn", () => {
    expect(total([user("a"), assistant("b"), user("c")])).toBe(
      7 + n("a") + n("b") + 6 + n("c")
    );
    expect(
      total([user("a"), assistant("b"), user("c"), assistant("b"), user("c")])
    ).toBe(7 + n("a") + 2 * n("b") + 2 * n("c") + 2 * 6);
  });

  test("the system prompt costs system once, and its messages join", () => {
    expect(total([system("x"), user("a")])).toBe(7 + 3 + n("x") + n("a"));
    expect(total([system("Be "), system("brief."), user("a")])).toBe(
      7 + 3 + n("Be brief.") + n("a")
    );
  });

  test("consecutive assistant messages and consecutive user messages share a turn", () => {
    expect(total([user("a"), assistant("b"), assistant("c")])).toBe(
      7 + n("a") + n("bc")
    );
    expect(total([user("a"), user("b")])).toBe(7 + n("ab"));
  });

  test("the breakdown follows the messages and sums to their totals", () => {
    const messages = [
      system("x"),
      user("a"),
      assistant("b"),
      blocks("c ", "d"),
    ];
    const counted = count({ tokenizer: v48, model, messages });
    expect(counted.messages).toHaveLength(4);
    expect(counted.messages.map((m) => m.content.length)).toEqual([1, 1, 1, 2]);
    expect(counted.messages[0]!.total).toBe(3 + n("x"));
    expect(counted.messages[3]!.total).toBe(
      6 + counted.messages[3]!.content.reduce((sum, p) => sum + p.total, 0)
    );
    expect(counted.total).toBe(
      7 + counted.messages.reduce((sum, m) => sum + m.total, 0)
    );
  });

  test("an unknown part counts nothing", () => {
    const reasoning = {
      role: "assistant",
      content: [{ type: "reasoning", text: "thinking hard" }],
    } as ModelMessage;
    expect(total([user("a"), reasoning])).toBe(7 + n("a"));
  });
});

describe("text blocks and trailing whitespace", () => {
  test("the blocks of one message join with no separator", () => {
    expect(total([blocks("a", "b", "c")])).toBe(7 + n("abc"));
    expect(total([user("x"), assistant("y"), blocks("Mixed ", "text")])).toBe(
      7 + n("x") + n("y") + 6 + n("Mixed text")
    );
  });

  test("a part's total is its share of the joined text", () => {
    const counted = count({
      tokenizer: v48,
      model,
      messages: [blocks("hell", "o world")],
    });
    const [first, second] = counted.messages[0]!.content;
    expect(first!.total + second!.total).toBe(n("hello world"));
    expect(first!.total).toBeGreaterThanOrEqual(0);
    expect(second!.total).toBeGreaterThanOrEqual(0);
  });

  test("claude_v5 drops the whitespace at the end of a user message and the system prompt", () => {
    expect(total([user("a  \n")], v5)).toBe(total([user("a")], v5));
    expect(total([system("x  "), user("a")], v5)).toBe(
      total([system("x"), user("a")], v5)
    );
    expect(total([blocks("a  ", "b  ")], v5)).toBe(7 + v48.count("a  b"));
  });

  test("claude_v5 keeps it everywhere else", () => {
    // The end of a user message is the end of its turn, whatever follows.
    expect(total([user("a  "), assistant("b")], v5)).toBe(7 + n("a") + n("b"));
    // Not in assistant text or in a tool result.
    expect(total([user("a"), assistant("b  "), user("c")], v5)).toBe(
      7 + n("a") + n("b  ") + 6 + n("c")
    );
    expect(
      total([user("a"), call({}), text("ok  \n")], v5, { f: {} } as never)
    ).toBe(
      total([user("a"), call({}), text("ok  \n")], v48, { f: {} } as never)
    );
    // Not when the last block is only whitespace.
    expect(total([blocks("a  ", "   ")], v5)).toBe(7 + n("a     "));
  });

  test("the trim leaves the other models alone", () => {
    expect(total([user("a  ")], v48)).toBe(7 + n("a  "));
    expect(n("a  ")).toBeGreaterThan(n("a"));
  });

  test("a final assistant message is trimmed, as the AI SDK provider does", () => {
    expect(total([user("a"), assistant("  b  ")])).toBe(
      total([user("a"), assistant("b")])
    );
    expect(total([user("a"), assistant("b  "), user("c")])).toBe(
      7 + n("a") + n("b  ") + 6 + n("c")
    );
  });
});

describe("tool calls and results", () => {
  const tools = { f: { inputSchema: z.object({}) } } as unknown as ToolSet;
  const frame = 7 + n("a");

  test("a call costs its name, and each top-level parameter its key and value", () => {
    expect(total([user("a"), call({}), text("b")], v48, tools)).toBe(
      frame + 311 + n("f") + n("f") + 0 + 6 + 39 + n("b")
    );
    const withInput = total(
      [user("a"), call({ path: "src/a.ts", limit: 5 }), text("b")],
      v48,
      tools
    );
    const without = total([user("a"), call({}), text("b")], v48, tools);
    expect(withInput - without).toBe(
      2 * 15 + n("path") + n("src/a.ts") + n("limit") + n("5")
    );
  });

  test("a string value counts as it is, and any other value as JSON with spaces", () => {
    const base = total([user("a"), call({}), text("b")], v48, tools);
    const counted = (input: Record<string, unknown>) =>
      total([user("a"), call(input), text("b")], v48, tools) - base - 15;
    expect(counted({ x: 'say "hi"\n' })).toBe(n("x") + n('say "hi"\n'));
    expect(counted({ x: { a: [1, 2], b: null } })).toBe(
      n("x") + n('{"a": [1, 2], "b": null}')
    );
    expect(counted({ x: [true, "s"] })).toBe(n("x") + n('[true, "s"]'));
  });

  test("a value JSON cannot write is left out of the request, and so out of the count", () => {
    const base = total([user("a"), call({}), text("b")], v48, tools);
    expect(
      total(
        [user("a"), call({ gone: undefined, fn: () => 1 }), text("b")],
        v48,
        tools
      )
    ).toBe(base);
  });

  test("the call id is not counted", () => {
    const long = {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "toolu_01ABCDEFGHIJKLMNOPQRSTUVWXYZ",
          toolName: "f",
          input: {},
        },
      ],
    } as ModelMessage;
    expect(total([user("a"), long, text("b")], v48, tools)).toBe(
      total([user("a"), call({}), text("b")], v48, tools)
    );
  });

  test("a result counts its payload, not the {type, value} wrapper", () => {
    const value = { status: "ok", count: 3 };
    const counted = count({
      tokenizer: v48,
      model,
      messages: [user("a"), call({}), result({ type: "json", value })],
      tools,
    });
    const part = counted.messages[2]!.content[0]!;
    expect(part).toEqual({
      type: "tool-result",
      total: 39 + n(JSON.stringify(value)),
      output: n(JSON.stringify(value)),
    });
  });

  test("an error result costs toolResultError more, an empty one the placeholder", () => {
    const base = total([user("a"), call({}), text("boom")], v48, tools);
    expect(
      total(
        [user("a"), call({}), result({ type: "error-text", value: "boom" })],
        v48,
        tools
      )
    ).toBe(base + 8);
    expect(
      total(
        [user("a"), call({}), result({ type: "error-json", value: "boom" })],
        v48,
        tools
      )
    ).toBe(base - n("boom") + n('"boom"') + 8);
    expect(total([user("a"), call({}), text("")], v48, tools)).toBe(
      base - n("boom") - 39 + 39 + 14
    );
    expect(
      total(
        [user("a"), call({}), result({ type: "execution-denied" })],
        v48,
        tools
      )
    ).toBe(base - n("boom") + n("Tool call execution denied."));
  });

  test("text after a result in the same user turn costs textAfterToolResult", () => {
    const answered = [user("a"), call({}), text("b")];
    expect(total([...answered, user("c")], v48, tools)).toBe(
      total(answered, v48, tools) + 5 + n("c")
    );
  });

  test("the user turn after the assistant answered a result costs userTurnAfterToolResult", () => {
    const cycle = [user("a"), call({}), text("b")];
    const answered = [...cycle, assistant("c")];
    expect(total([...answered, user("d")], v48, tools)).toBe(
      total(answered, v48, tools) + 6 + 2 + n("d")
    );
    // A result that is followed by another call is not answered.
    expect(
      total([...cycle, call({}), text("b"), assistant("c")], v48, tools)
    ).toBe(total(cycle, v48, tools) + n("f") + 6 + 39 + n("b") + n("c"));
  });
});

describe("tool definitions", () => {
  const defs = (inputSchema: z.ZodType) =>
    ({ f: { inputSchema } }) as unknown as ToolSet;
  const tokens = model.tokens;
  const base = (tools: ToolSet) =>
    total([user("a")], v48, tools) - (7 + n("a")) - tokens.toolsExist - n("f");

  test("an array property costs perArray on top of its items", () => {
    expect(base(defs(z.object({ tags: z.array(z.string()) })))).toBe(
      n("tags") + tokens.perFirstProp + 10
    );
  });

  test("enum values count as the JSON array the API reads", () => {
    expect(base(defs(z.object({ u: z.enum(["sum", "avg"]) })))).toBe(
      n("u") + tokens.perFirstProp + tokens.perEnum + n('["sum", "avg"]')
    );
  });

  test("a model without the block counts enum values one by one", () => {
    const legacy = {
      tokens: { ...tokens, anthropic: undefined },
    } as unknown as Model;
    const result = count({
      tokenizer: v48,
      model: legacy,
      messages: [],
      tools: defs(z.object({ u: z.enum(["sum", "avg"]) })),
    });
    expect(result.tools.definitions.f!.inputSchema).toBe(
      n("u") + tokens.perFirstProp + tokens.perEnum + n("sum") + n("avg")
    );
  });

  test("tool text keeps the trailing whitespace on claude_v5", () => {
    const described = (description: string) =>
      count({
        tokenizer: v5,
        model,
        messages: [],
        tools: { f: { description, inputSchema: z.object({}) } } as never,
      }).tools.definitions.f!.description;
    expect(described("Reads a file.  ")).toBe(5 + n("Reads a file.  "));
  });
});
