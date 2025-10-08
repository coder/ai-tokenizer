import Tokenizer from "./tokenizer";
import type { ModelMessage, ToolSet } from "ai";
import type { Model, ModelTokens } from ".";

export interface CountOptions<TOOLS extends ToolSet = ToolSet> {
  /**
   * The tokenizer instance to use for encoding.
   */
  tokenizer: Tokenizer;

  /**
   * Messages from the AI SDK.
   */
  messages: ModelMessage[];

  /**
   * Tools that you'd pass to `streamText` or `generateText`.
   */
  tools?: TOOLS;

  /**
   * The model you wish to use.
   */
  model: Model;
}

export type CountResultMessageContent =
  | {
      type: "text";
      total: number;
    }
  | {
      type: "tool-call";
      total: number;
      input: number;
    }
  | {
      type: "tool-result";
      total: number;
      output: number;
    };

export interface CountResultMessage {
  total: number;
  content: Array<CountResultMessageContent>;
}

export interface CountResultTools<TOOLS extends ToolSet = ToolSet> {
  total: number;
  definitions: Record<
    keyof TOOLS,
    {
      name: number;
      description: number;
      inputSchema: number;
    }
  >;
}

export interface CountResult<TOOLS extends ToolSet = ToolSet> {
  total: number;
  messages: Array<CountResultMessage>;
  tools: CountResultTools<TOOLS>;
}

/**
 * count returns a token estimation for a model given messages and tools.
 *
 * It returns a detailed breakdown per-message and per-tool.
 * Users can filter out messages based on large tool results, for example.
 */
export function count<TOOLS extends ToolSet = ToolSet>(
  options: CountOptions<TOOLS>
): CountResult<TOOLS> {
  const config = options.model.tokens;

  let total = config.baseOverhead;

  // Count messages with detailed breakdown
  const messages: CountResultMessage[] = [];
  for (const message of options.messages) {
    const messageResult = countMessageTokensDetailed(
      options.tokenizer,
      message,
      config
    );
    messages.push(messageResult);
    total += messageResult.total;
  }

  // Count tools with detailed breakdown
  const toolsResult = countToolsTokensDetailed(
    options.tokenizer,
    options.tools,
    config
  );
  total += toolsResult.total;

  return {
    total,
    messages,
    tools: toolsResult as CountResultTools<TOOLS>,
  };
}

/**
 * Count tokens for tools with detailed breakdown
 */
function countToolsTokensDetailed<TOOLS extends ToolSet = ToolSet>(
  tokenizer: Tokenizer,
  tools?: TOOLS,
  config?: ModelTokens
): CountResultTools<TOOLS> {
  if (!config) {
    throw new Error("config is required");
  }

  const definitions: Record<
    keyof TOOLS,
    {
      name: number;
      description: number;
      inputSchema: number;
    }
  > = {} as Record<
    keyof TOOLS,
    {
      name: number;
      description: number;
      inputSchema: number;
    }
  >;
  let total = 0;

  if (tools && Object.keys(tools).length > 0) {
    total += config.toolsExist;

    const toolEntries = Object.entries(tools);
    for (let i = 0; i < toolEntries.length; i++) {
      const [toolName, tool] = toolEntries[i]!;

      // Count name tokens
      const nameTokens = tokenizer.encode(toolName).length;

      // Count description tokens
      let descriptionTokens = 0;
      if (tool.description) {
        descriptionTokens =
          config.perDesc + tokenizer.encode(tool.description).length;
      }

      // Count inputSchema tokens
      let inputSchemaTokens = 0;
      if (tool.inputSchema) {
        const result = countZodSchemaProperties(
          tool.inputSchema,
          tokenizer,
          config
        );
        inputSchemaTokens = result.tokens;
      }

      definitions[toolName as keyof TOOLS] = {
        name: nameTokens,
        description: descriptionTokens,
        inputSchema: inputSchemaTokens,
      };

      total += nameTokens + descriptionTokens + inputSchemaTokens;

      // Add perTool overhead for additional tools (beyond first)
      if (i > 0) {
        total += config.perTool;
      }
    }
  }

  return { total, definitions };
}

/**
 * Count tokens for a single message with detailed breakdown
 */
function countMessageTokensDetailed(
  tokenizer: Tokenizer,
  message: ModelMessage,
  config: ModelTokens
): CountResultMessage {
  let total = config.perMessage;
  const content: CountResultMessageContent[] = [];

  // Count role
  total += tokenizer.encode(message.role).length;

  // Count content with detailed breakdown
  if (message.content) {
    const contentResult = countMessageContentTokensDetailed(
      tokenizer,
      message.content,
      config
    );
    content.push(...contentResult);
    total += contentResult.reduce((sum, c) => sum + c.total, 0);
  }

  return { total, content };
}

/**
 * Count tokens for message content with detailed breakdown
 */
function countMessageContentTokensDetailed(
  tokenizer: Tokenizer,
  content: ModelMessage["content"],
  config: ModelTokens
): CountResultMessageContent[] {
  const multiplier = config.contentMultiplier;
  const results: CountResultMessageContent[] = [];

  if (typeof content === "string") {
    const tokens = tokenizer.encode(content).length;
    const total = Math.round(tokens * multiplier);
    results.push({ type: "text", total });
    return results;
  }

  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === "text") {
        const tokens = tokenizer.encode(part.text).length;
        const total = Math.round(tokens * multiplier);
        results.push({ type: "text", total });
      } else if (part.type === "tool-call") {
        let toolCallTokens = 0;
        let inputTokens = 0;

        if (part.toolName) {
          toolCallTokens += tokenizer.encode(part.toolName).length;
        }
        if (part.input) {
          inputTokens = tokenizer.encode(JSON.stringify(part.input)).length;
          toolCallTokens += inputTokens;
        }

        const total = Math.round(toolCallTokens * multiplier);
        results.push({
          type: "tool-call",
          total,
          input: Math.round(inputTokens * multiplier),
        });
      } else if (part.type === "tool-result") {
        let toolResultTokens = 0;
        let outputTokens = 0;

        if (part.toolCallId) {
          toolResultTokens += tokenizer.encode(part.toolCallId).length;
        }
        if (part.output) {
          if (typeof part.output === "string") {
            outputTokens = tokenizer.encode(part.output).length;
          } else {
            outputTokens = tokenizer.encode(JSON.stringify(part.output)).length;
          }
          toolResultTokens += outputTokens;
        }

        const total = Math.round(toolResultTokens * multiplier);
        results.push({
          type: "tool-result",
          total,
          output: Math.round(outputTokens * multiplier),
        });
      } else if (part.type === "image") {
        // Images have a fixed token count (approximate for GPT-4o)
        results.push({ type: "text", total: 85 });
      } else if (part.type === "file") {
        // Files are treated similarly to text
        // This is an approximation - actual token count may vary
        results.push({ type: "text", total: 100 });
      }
    }
  }

  return results;
}

/**
 * Count properties in a Zod schema by walking its structure
 */
function countZodSchemaProperties(
  schema: any,
  tokenizer: Tokenizer,
  config: ModelTokens
): { tokens: number; propCount: number } {
  let tokens = 0;
  let propCount = 0;

  if (!schema || !schema._def) {
    return { tokens, propCount };
  }

  const def = schema._def;

  // Handle object schemas
  if (def.type === "object") {
    const shape = typeof def.shape === "function" ? def.shape() : def.shape;

    if (!shape) {
      return { tokens, propCount };
    }

    for (const [key, value] of Object.entries(shape)) {
      const isFirstProp = propCount === 0;
      propCount++;
      const propSchema = value as any;

      // Count property name tokens
      tokens += tokenizer.encode(key).length;

      // Add property overhead (first vs additional)
      tokens += isFirstProp ? config.perFirstProp : config.perAdditionalProp;

      // Count property description if present
      if (propSchema.description) {
        tokens += config.perPropDesc;
        tokens += tokenizer.encode(propSchema.description).length;
      }

      // Handle enums - count each enum value + overhead
      if (propSchema._def && propSchema._def.type === "enum") {
        const enumDef = propSchema._def;
        const enumValues =
          enumDef.values || Object.values(enumDef.entries || {});
        tokens += config.perEnum; // Enum overhead
        for (const enumValue of enumValues) {
          tokens += tokenizer.encode(String(enumValue)).length;
        }
      }

      // Handle nested objects
      if (propSchema._def) {
        const innerDef = propSchema._def;
        if (innerDef.type === "object") {
          // Add overhead for nested object if configured
          tokens += config.perNestedObject || 0;
          const nested = countZodSchemaProperties(
            propSchema,
            tokenizer,
            config
          );
          tokens += nested.tokens;
          // Don't accumulate propCount across nesting levels - each level is independent
        } else if (innerDef.type === "array" && innerDef.element) {
          // Handle arrays with object/complex items
          const elementDef = innerDef.element._def;
          if (elementDef && elementDef.type === "object") {
            // Add overhead for array of objects if configured
            tokens += config.perArrayOfObjects || 0;
          }
          const nested = countZodSchemaProperties(
            innerDef.element,
            tokenizer,
            config
          );
          tokens += nested.tokens;
          // Don't accumulate propCount across nesting levels
        }
      }
    }
  }

  return { tokens, propCount };
}
