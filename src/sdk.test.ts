/**
 * AI SDK token counting tests
 * Validates token counts for different models with small, medium, and large inputs
 */

import { describe, test, expect } from "bun:test";
import { count } from "./sdk";
import type { ModelMessage, ToolSet } from "ai";
import { models, Tokenizer, type Model } from "./index";
import * as o200k from "./encoding/o200k_base";
import * as claude from "./encoding/claude";
import { z } from "zod";

// Test data: small, medium, and large scenarios
const messages = {
  small: [{ role: "user", content: "Hello!" }] as ModelMessage[],
  medium: [
    { role: "user", content: "What is the weather like today?" },
    {
      role: "assistant",
      content: "I'll help you check the weather. Let me use the weather tool.",
    },
  ] as ModelMessage[],
  large: [
    {
      role: "system",
      content:
        "You are a helpful assistant that can answer questions and use tools to help users.",
    },
    {
      role: "user",
      content:
        "I need to know the weather in San Francisco and also calculate how many days until Christmas.",
    },
    { role: "assistant", content: "I'll help you with both of those tasks." },
    {
      role: "user",
      content: "Also, can you tell me a fun fact about the Golden Gate Bridge?",
    },
  ] as ModelMessage[],
};

const tools = {
  small: {
    getWeather: {
      description: "Get the current weather",
      inputSchema: z.object({ location: z.string() }),
    },
  },
  medium: {
    getWeather: {
      description: "Get the current weather for a location",
      inputSchema: z.object({
        location: z.string().describe("The city name"),
        units: z.enum(["celsius", "fahrenheit"]).describe("Temperature units"),
      }),
    },
    calculateDate: {
      description: "Calculate days between dates",
      inputSchema: z.object({ fromDate: z.string(), toDate: z.string() }),
    },
  },
  large: {
    getWeather: {
      description:
        "Get the current weather for a specific location with detailed information",
      inputSchema: z.object({
        location: z.string().describe("The city and country"),
        units: z
          .enum(["celsius", "fahrenheit", "kelvin"])
          .describe("Temperature units to use"),
        includeHourly: z.boolean().describe("Include hourly forecast"),
      }),
    },
    calculateDate: {
      description: "Calculate the number of days between two dates",
      inputSchema: z.object({
        fromDate: z.string().describe("Start date in YYYY-MM-DD format"),
        toDate: z.string().describe("End date in YYYY-MM-DD format"),
        includeWeekends: z.boolean(),
      }),
    },
    searchWikipedia: {
      description: "Search Wikipedia for information about a topic",
      inputSchema: z.object({
        query: z.string().describe("The search query"),
        language: z.string().describe("Language code"),
        maxResults: z.number().describe("Maximum number of results"),
        filters: z
          .object({
            category: z.string(),
            dateRange: z.object({ start: z.string(), end: z.string() }),
          })
          .describe("Search filters"),
      }),
    },
  },
};

describe("ai-sdk", () => {
  const testCases = [
    // gemini-2.5-pro
    {
      model: "google/gemini-2.5-pro",
      encoding: o200k,
      size: "small",
      withTools: false,
      expected: 1,
    },
    {
      model: "google/gemini-2.5-pro",
      encoding: o200k,
      size: "small",
      withTools: true,
      expected: 11,
    },
    {
      model: "google/gemini-2.5-pro",
      encoding: o200k,
      size: "medium",
      withTools: false,
      expected: 22,
    },
    {
      model: "google/gemini-2.5-pro",
      encoding: o200k,
      size: "medium",
      withTools: true,
      expected: 62,
    },
    {
      model: "google/gemini-2.5-pro",
      encoding: o200k,
      size: "large",
      withTools: false,
      expected: 61,
    },
    {
      model: "google/gemini-2.5-pro",
      encoding: o200k,
      size: "large",
      withTools: true,
      expected: 187,
    },
    // gpt-5
    {
      model: "openai/gpt-5",
      encoding: o200k,
      size: "small",
      withTools: false,
      expected: 12,
    },
    {
      model: "openai/gpt-5",
      encoding: o200k,
      size: "small",
      withTools: true,
      expected: 50,
    },
    {
      model: "openai/gpt-5",
      encoding: o200k,
      size: "medium",
      withTools: false,
      expected: 36,
    },
    {
      model: "openai/gpt-5",
      encoding: o200k,
      size: "medium",
      withTools: true,
      expected: 127,
    },
    {
      model: "openai/gpt-5",
      encoding: o200k,
      size: "large",
      withTools: false,
      expected: 83,
    },
    {
      model: "openai/gpt-5",
      encoding: o200k,
      size: "large",
      withTools: true,
      expected: 291,
    },
    // claude-sonnet-4.5
    {
      model: "anthropic/claude-sonnet-4.5",
      encoding: claude,
      size: "small",
      withTools: false,
      expected: 11,
    },
    {
      model: "anthropic/claude-sonnet-4.5",
      encoding: claude,
      size: "small",
      withTools: true,
      expected: 585,
    },
    {
      model: "anthropic/claude-sonnet-4.5",
      encoding: claude,
      size: "medium",
      withTools: false,
      expected: 37,
    },
    {
      model: "anthropic/claude-sonnet-4.5",
      encoding: claude,
      size: "medium",
      withTools: true,
      expected: 748,
    },
    {
      model: "anthropic/claude-sonnet-4.5",
      encoding: claude,
      size: "large",
      withTools: false,
      expected: 84,
    },
    {
      model: "anthropic/claude-sonnet-4.5",
      encoding: claude,
      size: "large",
      withTools: true,
      expected: 1106,
    },
  ];

  test.each(testCases)(
    "$model - $size (tools=$withTools)",
    ({ model: modelName, encoding, size, withTools, expected }) => {
      const modelConfig = models[modelName as keyof typeof models] as Model;
      const tokenizer = new Tokenizer(encoding);
      const result = count({
        tokenizer,
        messages: messages[size as keyof typeof messages],
        tools: withTools ? tools[size as keyof typeof tools] : undefined,
        model: modelConfig,
      });

      // Validate expected total
      expect(result.total).toBe(expected);

      // Validate that all message content totals sum correctly
      for (const message of result.messages) {
        const contentSum = message.content.reduce((sum, c) => sum + c.total, 0);
        // Message total should include content plus overhead (role + perMessage)
        expect(message.total).toBeGreaterThanOrEqual(contentSum);
      }

      // Validate that tool definition totals sum correctly
      const definitionSum = Object.values(result.tools.definitions).reduce(
        (sum, tool) => sum + tool.name + tool.description + tool.inputSchema,
        0
      );
      // Tools total should include all definitions plus overhead (toolsExist + perTool)
      expect(result.tools.total).toBeGreaterThanOrEqual(definitionSum);

      // Validate that root total equals messages + tools + baseOverhead
      const messagesSum = result.messages.reduce((sum, m) => sum + m.total, 0);
      const expectedTotal =
        messagesSum + result.tools.total + modelConfig.tokens.baseOverhead;
      expect(result.total).toBe(expectedTotal);
    }
  );

  test("should properly account for large tool result output", () => {
    // Generate a large JSON output to simulate a ~50k token tool result
    const largeData = Array.from({ length: 5000 }, (_, i) => ({
      id: i,
      name: `Item ${i}`,
      description: `This is a detailed description for item ${i} with additional context and information`,
      metadata: {
        created: "2024-01-01T00:00:00Z",
        updated: "2024-01-02T00:00:00Z",
        tags: ["tag1", "tag2", "tag3"],
      },
    }));

    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "Fetch all the data",
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_123",
            toolName: "fetchData",
            input: { query: "all" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_123",
            toolName: "fetchData",
            output: {
              type: "json",
              value: largeData,
            },
          },
        ],
      },
    ];

    const modelConfig = models["openai/gpt-5"] as Model;
    const tokenizer = new Tokenizer(o200k);
    const result = count({
      tokenizer,
      messages,
      model: modelConfig,
    });

    // Find the tool-result message (should be the last one)
    const toolResultMessage = result.messages[2];
    expect(toolResultMessage).toBeDefined();

    // Find the tool-result content item
    const toolResultContent = toolResultMessage!.content.find(
      (c) => c.type === "tool-result"
    )!;
    expect(toolResultContent).toBeDefined();
    expect(toolResultContent!.type).toBe("tool-result");

    // Verify the output tokens are substantial (should be ~50k+)
    expect(toolResultContent.output).toBeGreaterThan(40000);

    // Verify the total includes the output
    expect(toolResultContent.total).toBeGreaterThanOrEqual(
      toolResultContent.output
    );

    // Verify the message total includes this content
    const messageContentSum = toolResultMessage!.content.reduce(
      (sum, c) => sum + c.total,
      0
    );
    expect(toolResultMessage!.total).toBeGreaterThanOrEqual(messageContentSum);

    // Verify all totals add up correctly
    const messagesSum = result.messages.reduce((sum, m) => sum + m.total, 0);
    const expectedTotal =
      messagesSum + result.tools.total + modelConfig.tokens.baseOverhead;
    expect(result.total).toBe(expectedTotal);

    // Verify the large tool result is reflected in the overall total
    expect(result.total).toBeGreaterThan(40000);
  });
});
