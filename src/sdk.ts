import Tokenizer from "./tokenizer";
import { asSchema, type ModelMessage, type ToolSet } from "ai";
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

/**
 * A tool description or input schema that `count()` could not read
 * synchronously. It contributes 0 tokens to the total.
 */
export interface UnresolvedToolPart {
  tool: string;
  part: "description" | "inputSchema";
  /**
   * `async`: the schema is a Promise, or a thunk that returns one.
   * `error`: reading it threw, for example a Standard Schema vendor without
   * JSON Schema conversion. The thrown value is in `error`.
   */
  reason: "async" | "error";
  error?: unknown;
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
  /** Empty when every tool definition was counted in full. */
  unresolved: UnresolvedToolPart[];
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
  const unresolved: UnresolvedToolPart[] = [];
  let total = 0;

  if (tools && Object.keys(tools).length > 0) {
    total += config.toolsExist;

    const toolEntries = Object.entries(tools);
    for (let i = 0; i < toolEntries.length; i++) {
      const [toolName, tool] = toolEntries[i]!;
      const definition = tool as {
        type?: unknown;
        description?: unknown;
        inputSchema?: unknown;
      };

      // Count name tokens
      const nameTokens = tokenizer.count(toolName);

      // Count description tokens
      let descriptionTokens = 0;
      const description = readDescription(definition.description);
      if ("error" in description) {
        unresolved.push({
          tool: toolName,
          part: "description",
          reason: "error",
          error: description.error,
        });
      } else if (description.text) {
        descriptionTokens = config.perDesc + tokenizer.count(description.text);
      }

      // Count inputSchema tokens
      let inputSchemaTokens = 0;
      if (definition.inputSchema && !isProviderTool(definition.type)) {
        const schema = readInputSchema(definition.inputSchema);
        if (schema.status === "ok") {
          inputSchemaTokens = countToolSchema(
            schema.jsonSchema,
            tokenizer,
            config
          );
        } else {
          unresolved.push({
            tool: toolName,
            part: "inputSchema",
            reason: schema.status,
            ...(schema.status === "error" && { error: schema.error }),
          });
        }
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

  return { total, definitions, unresolved };
}

/**
 * AI SDK v7 allows a function that builds the description from the tool's
 * runtime context. `count()` has no context, so the function gets an empty one.
 */
function readDescription(
  description: unknown
): { text: string | undefined } | { error: unknown } {
  if (typeof description === "function") {
    try {
      const text: unknown = description({ context: {} });
      return { text: typeof text === "string" ? text : undefined };
    } catch (error) {
      return { error };
    }
  }
  return { text: typeof description === "string" ? description : undefined };
}

/**
 * Provider tools (`provider-defined` in v5, `provider` in v6 and v7) still
 * carry an `inputSchema`, but the provider sends its own definition instead.
 */
function isProviderTool(type: unknown): boolean {
  return type === "provider" || type === "provider-defined";
}

type InputSchemaRead =
  | { status: "ok"; jsonSchema: unknown }
  | { status: "async" }
  | { status: "error"; error: unknown };

/**
 * Reads the JSON Schema the provider receives for a tool, whichever schema
 * library defined it. `asSchema` is the AI SDK's own conversion, so zod 3,
 * zod 4, `jsonSchema()` and (v6+) Standard Schema tools all arrive here as
 * JSON Schema.
 */
function readInputSchema(inputSchema: unknown): InputSchemaRead {
  try {
    const jsonSchema: unknown = asSchema(
      inputSchema as Parameters<typeof asSchema>[0]
    ).jsonSchema;
    if (isThenable(jsonSchema)) {
      try {
        // Mark the rejection as handled: we are not going to await it.
        jsonSchema.then(undefined, () => {});
      } catch {
        // A thenable whose `then` throws is still not readable synchronously.
      }
      return { status: "async" };
    }
    if (!isRecord(jsonSchema)) {
      // For example an arktype schema on ai v5, which converts only zod.
      throw new TypeError("asSchema() returned no JSON Schema object");
    }
    return { status: "ok", jsonSchema };
  } catch (error) {
    return { status: "error", error };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === "function";
}

/**
 * Object schemas are recognised by `properties`, not `type: "object"`:
 * AI SDK v5 omits `type` on the empty schema it makes for an undefined input.
 */
function propertiesOf(schema: unknown): Record<string, unknown> | undefined {
  return isRecord(schema) && isRecord(schema.properties)
    ? schema.properties
    : undefined;
}

/**
 * Follows a local JSON pointer `$ref` ("#", "#/definitions/X", "#/$defs/X") to
 * its target in the root schema. Anchors ("#name") are not resolved. zod 4 emits one for a schema registered with `.meta({ id })`
 * and pydantic-based MCP servers emit them for nested models. A `description`
 * next to the `$ref` wins over the target's.
 */
function resolveRef(
  schema: Record<string, unknown>,
  root: unknown
): Record<string, unknown> {
  const ref = schema.$ref;
  if (typeof ref !== "string" || (ref !== "#" && !ref.startsWith("#/"))) {
    return schema;
  }
  let target: unknown = root;
  try {
    for (const segment of ref.slice(1).split("/").slice(1)) {
      const key = decodeURIComponent(segment)
        .replace(/~1/g, "/")
        .replace(/~0/g, "~");
      target = isRecord(target) ? target[key] : undefined;
    }
  } catch {
    return schema;
  }
  if (!isRecord(target)) {
    return schema;
  }
  const { $ref: _ref, ...siblings } = schema;
  return { ...target, ...siblings };
}

/**
 * `.nullable()` becomes `anyOf: [inner, { type: "null" }]`. Read through it, so
 * a nullable property counts like the same property without `null`. A real
 * union (two or more non-null variants) is left alone.
 */
function withoutNull(schema: Record<string, unknown>): Record<string, unknown> {
  const variants = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(variants)) {
    return schema;
  }
  const rest = variants.filter((v) => !(isRecord(v) && v.type === "null"));
  const inner = rest[0];
  if (
    rest.length !== 1 ||
    rest.length === variants.length ||
    !isRecord(inner)
  ) {
    return schema;
  }
  return schema.description === undefined
    ? inner
    : { ...inner, description: schema.description };
}

interface SchemaWalk {
  tokenizer: Tokenizer;
  config: ModelTokens;
  /** The whole tool schema, which local `$ref`s point into. */
  root: unknown;
  /** `properties` objects being walked, so a recursive schema ends. */
  ancestors: Set<unknown>;
  /**
   * Tokens of each `properties` object already walked. Every definition is
   * walked once per tool, which bounds the walk by the size of the schema.
   * Without it, definitions that share definitions would be walked once per
   * path, and recursive ones once per cycle.
   */
  counted: Map<unknown, number>;
}

/** The schema a property stands for once `$ref` and `null` wrappers are read through. */
function unwrap(value: Record<string, unknown>, walk: SchemaWalk) {
  return resolveRef(withoutNull(resolveRef(value, walk.root)), walk.root);
}

function countToolSchema(
  jsonSchema: unknown,
  tokenizer: Tokenizer,
  config: ModelTokens
): number {
  if (!isRecord(jsonSchema)) {
    return 0;
  }
  const walk: SchemaWalk = {
    tokenizer,
    config,
    root: jsonSchema,
    ancestors: new Set(),
    counted: new Map(),
  };
  return countSchemaProperties(resolveRef(jsonSchema, jsonSchema), walk);
}

/**
 * Count the properties of a JSON Schema object by walking its structure.
 * Unions (`anyOf`, `oneOf`, `allOf`) and non-local `$ref`s are not followed.
 */
function countSchemaProperties(schema: unknown, walk: SchemaWalk): number {
  const { tokenizer, config, ancestors } = walk;
  const properties = propertiesOf(schema);
  if (!properties) {
    return 0;
  }
  const counted = walk.counted.get(properties);
  if (counted !== undefined) {
    return counted;
  }
  if (ancestors.has(properties)) {
    return 0;
  }
  ancestors.add(properties);

  let tokens = 0;
  let isFirstProp = true;

  for (const [key, value] of Object.entries(properties)) {
    // Count property name tokens
    tokens += tokenizer.count(key);

    // Add property overhead (first vs additional)
    tokens += isFirstProp ? config.perFirstProp : config.perAdditionalProp;
    isFirstProp = false;

    if (!isRecord(value)) {
      continue;
    }
    const propSchema = unwrap(value, walk);

    // Count property description if present
    if (typeof propSchema.description === "string" && propSchema.description) {
      tokens += config.perPropDesc;
      tokens += tokenizer.count(propSchema.description);
    }

    // Handle enums - count each enum value + overhead
    if (Array.isArray(propSchema.enum)) {
      tokens += config.perEnum;
      for (const enumValue of propSchema.enum) {
        tokens += tokenizer.count(String(enumValue));
      }
    }

    if (propertiesOf(propSchema)) {
      // Handle nested objects
      tokens += config.perNestedObject || 0;
      tokens += countSchemaProperties(propSchema, walk);
    } else if (isRecord(propSchema.items)) {
      // Handle arrays with object items
      const items = unwrap(propSchema.items, walk);
      if (propertiesOf(items)) {
        tokens += config.perArrayOfObjects || 0;
      }
      tokens += countSchemaProperties(items, walk);
    }
  }

  ancestors.delete(properties);
  // A definition inside a cycle is counted with its back edge cut where the
  // walk first reached it, and that count is reused wherever it is referenced.
  walk.counted.set(properties, tokens);
  return tokens;
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
  total += tokenizer.count(message.role);

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
    const tokens = tokenizer.count(content);
    const total = Math.round(tokens * multiplier);
    results.push({ type: "text", total });
    return results;
  }

  if (Array.isArray(content)) {
    // Parts are read as plain records: their shape differs between AI SDK
    // v5, v6 and v7, and unknown parts are skipped. That includes `reasoning`
    // and `reasoning-file`: Anthropic's count_tokens gives the same total with
    // and without the signed thinking block of an earlier assistant turn.
    for (const part of content as unknown[]) {
      if (!isRecord(part)) {
        continue;
      }
      const tally = createTally(tokenizer);

      if (part.type === "text") {
        if (typeof part.text === "string") {
          tally.addText(part.text);
        }
        results.push({
          type: "text",
          total: Math.round(tally.text * multiplier) + tally.media,
        });
      } else if (part.type === "tool-call") {
        let nameTokens = 0;
        if (part.toolName && typeof part.toolName === "string") {
          nameTokens = tokenizer.count(part.toolName);
        }
        if (part.input) {
          tally.addText(JSON.stringify(part.input));
        }

        results.push({
          type: "tool-call",
          total: Math.round((nameTokens + tally.text) * multiplier),
          input: Math.round(tally.text * multiplier),
        });
      } else if (part.type === "tool-result") {
        let idTokens = 0;
        if (part.toolCallId && typeof part.toolCallId === "string") {
          idTokens = tokenizer.count(part.toolCallId);
        }
        tallyToolOutput(tally, part.output);

        results.push({
          type: "tool-result",
          total: Math.round((idTokens + tally.text) * multiplier) + tally.media,
          output: Math.round(tally.text * multiplier) + tally.media,
        });
      } else if (typeof part.type === "string" && MEDIA_KINDS.has(part.type)) {
        tallyMedia(tally, part);
        results.push({
          type: "text",
          total: Math.round(tally.text * multiplier) + tally.media,
        });
      }
    }
  }

  return results;
}

/**
 * Tokens of one content part. `text` is raw tokenizer tokens and still gets
 * `contentMultiplier`. `media` is a fixed estimate and never does.
 */
function createTally(tokenizer: Tokenizer) {
  const tally = {
    text: 0,
    media: 0,
    addText(text: string) {
      tally.text += tokenizer.count(text);
    },
    addMedia(media: Media) {
      tally.media += countMediaTokens(media);
    },
  };
  return tally;
}

type Tally = ReturnType<typeof createTally>;

type MediaKind = "image" | "file";

interface Media {
  kind: MediaKind;
  /** IANA media type, `"image"` (AI SDK v7 wildcard) or undefined. */
  mediaType: string | undefined;
  /**
   * The part's payload as the caller gave it: base64 string, bytes, URL,
   * AI SDK v7 tagged file data, or a provider file reference.
   */
  data: unknown;
}

/**
 * The single place that prices an image or a file. Every image-like and
 * file-like part reaches it, whatever its AI SDK shape.
 */
function countMediaTokens(media: Media): number {
  // Images have a fixed token count (approximate for GPT-4o)
  // Files are treated similarly to text, which is an approximation too.
  return media.kind === "image" ? 85 : 100;
}

/**
 * Message parts and tool-result content items that carry an image or a file,
 * with the kind to use when the media type does not say. The names are from
 * AI SDK v5 (`media`), v6 (`image-*`, `file-*`) and v7 (`file`).
 */
const MEDIA_KINDS = new Map<string, MediaKind>([
  ["image", "image"],
  ["image-data", "image"],
  ["image-url", "image"],
  ["image-file-id", "image"],
  ["image-file-reference", "image"],
  ["file", "file"],
  ["media", "file"],
  ["file-data", "file"],
  ["file-url", "file"],
  ["file-id", "file"],
  ["file-reference", "file"],
]);

function mediaData(part: Record<string, unknown>): unknown {
  return (
    part.data ?? part.image ?? part.url ?? part.fileId ?? part.providerReference
  );
}

/** AI SDK v7 inline text documents are text, not a binary file. */
function inlineText(part: Record<string, unknown>): string | undefined {
  const data = mediaData(part);
  return isRecord(data) && data.type === "text" && typeof data.text === "string"
    ? data.text
    : undefined;
}

function isBinaryMediaPart(part: Record<string, unknown>): boolean {
  return (
    typeof part.type === "string" &&
    MEDIA_KINDS.has(part.type) &&
    inlineText(part) === undefined
  );
}

function toMedia(part: Record<string, unknown>): Media {
  const mediaType =
    typeof part.mediaType === "string" ? part.mediaType : undefined;
  const isImageMediaType =
    mediaType !== undefined &&
    (mediaType === "image" || mediaType.startsWith("image/"));
  return {
    kind:
      isImageMediaType || MEDIA_KINDS.get(part.type as string) === "image"
        ? "image"
        : "file",
    mediaType,
    data: mediaData(part),
  };
}

function tallyMedia(tally: Tally, part: Record<string, unknown>): void {
  const text = inlineText(part);
  if (text !== undefined) {
    tally.addText(text);
  } else {
    tally.addMedia(toMedia(part));
  }
}

/**
 * A tool result counts as `JSON.stringify(output)`, the `{ type, value }`
 * wrapper included, as it always has. The wrapper stands in for the
 * `tool_result` block overhead that `ModelTokens` has no field for yet, and
 * counting only the payload under-counts every result by about 6 tokens.
 *
 * The one exception is a `content` output: its images and files are priced by
 * `countMediaTokens` instead of serialising their base64 or URL.
 */
function tallyToolOutput(tally: Tally, output: unknown): void {
  if (!output) {
    return;
  }
  if (typeof output === "string") {
    tally.addText(output);
    return;
  }
  if (
    isRecord(output) &&
    output.type === "content" &&
    Array.isArray(output.value)
  ) {
    const rest: unknown[] = [];
    for (const item of output.value as unknown[]) {
      if (isRecord(item) && isBinaryMediaPart(item)) {
        tally.addMedia(toMedia(item));
      } else {
        rest.push(item);
      }
    }
    tally.addText(JSON.stringify({ ...output, value: rest }));
    return;
  }
  tally.addText(JSON.stringify(output));
}
