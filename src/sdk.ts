import Tokenizer from "./tokenizer";
import { asSchema, type ModelMessage, type ToolSet } from "ai";
import type { AnthropicTokens, Model, ModelTokens } from ".";

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
  const messages: CountResultMessage[] = config.anthropic
    ? countClaudeMessages(options.tokenizer, options.messages, config.anthropic)
    : options.messages.map((message) =>
        countMessageTokensDetailed(options.tokenizer, message, config)
      );
  for (const message of messages) {
    total += message.total;
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
  const countText = config.anthropic
    ? (text: string) => tokenizer.countUntrimmed(text)
    : (text: string) => tokenizer.count(text);

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
      const nameTokens = countText(toolName);

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
        descriptionTokens = config.perDesc + countText(description.text);
      }

      // Count inputSchema tokens
      let inputSchemaTokens = 0;
      if (definition.inputSchema && !isProviderTool(definition.type)) {
        const schema = readInputSchema(definition.inputSchema);
        if (schema.status === "ok") {
          inputSchemaTokens = countToolSchema(
            schema.jsonSchema,
            countText,
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
 * JSON Schema read from each tool input schema, so repeated `count()` calls on
 * the same tools do not convert them again. Only complete reads are kept: the
 * conversion depends on nothing but the input schema.
 *
 * An entry lives as long as its input schema object and is never refreshed. A
 * plain JSON Schema object that is edited in place is read as it is on every
 * count, but a lazy schema (a `jsonSchema()` thunk, a zod schema built on
 * demand) is converted once. To make `count()` read a changed schema, pass a
 * new input schema object.
 */
const convertedSchemas = new WeakMap<object, unknown>();

function isCacheKey(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

/**
 * Reads the JSON Schema the provider receives for a tool, whichever schema
 * library defined it. `asSchema` is the AI SDK's own conversion, so zod 3,
 * zod 4, `jsonSchema()` and (v6+) Standard Schema tools all arrive here as
 * JSON Schema.
 */
function readInputSchema(inputSchema: unknown): InputSchemaRead {
  const cacheKey = isCacheKey(inputSchema) ? inputSchema : undefined;
  if (cacheKey && convertedSchemas.has(cacheKey)) {
    return { status: "ok", jsonSchema: convertedSchemas.get(cacheKey) };
  }
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
    if (cacheKey) {
      convertedSchemas.set(cacheKey, jsonSchema);
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
 * The properties of a `$ref` target with the properties written next to the
 * `$ref` on top, which win on a clash. It is counted as the target's count
 * plus the difference the sibling keys make, so a target that many `$ref`s
 * share is counted once and each `$ref` costs only its own siblings.
 */
class MergedProperties {
  constructor(
    readonly target: Record<string, unknown>,
    readonly siblings: Record<string, unknown>
  ) {}
}

type Properties = Record<string, unknown> | MergedProperties;

/**
 * Object schemas are recognised by `properties`, not `type: "object"`:
 * AI SDK v5 omits `type` on the empty schema it makes for an undefined input.
 */
function propertiesOf(schema: unknown): Properties | undefined {
  if (!isRecord(schema)) {
    return undefined;
  }
  const { properties } = schema;
  return properties instanceof MergedProperties || isRecord(properties)
    ? properties
    : undefined;
}

/** The same pair always gives the same object, so a walk can tell it is already inside it. */
const mergedProperties = new WeakMap<object, WeakMap<object, Properties>>();

function mergeProperties(target: Properties, siblings: Properties): Properties {
  let bySiblings = mergedProperties.get(target);
  if (!bySiblings) {
    bySiblings = new WeakMap();
    mergedProperties.set(target, bySiblings);
  }
  let merged = bySiblings.get(siblings);
  if (!merged) {
    // Two layers of `$ref` and `null` wrappers each carrying properties is
    // rare: spell the result out instead of nesting merges. It is kept like
    // the others, or a recursive schema would make a new object on every lap.
    merged =
      target instanceof MergedProperties || siblings instanceof MergedProperties
        ? { ...flatten(target), ...flatten(siblings) }
        : new MergedProperties(target, siblings);
    bySiblings.set(siblings, merged);
  }
  return merged;
}

function flatten(properties: Properties): Record<string, unknown> {
  return properties instanceof MergedProperties
    ? { ...properties.target, ...properties.siblings }
    : properties;
}

/**
 * The schema with the keywords written next to it on top: `description`,
 * `enum`, `properties` and the rest of them count with the target's. A
 * keyword that is `undefined` is ignored.
 */
function withSiblings(
  target: Record<string, unknown>,
  siblings: Record<string, unknown>
): Record<string, unknown> {
  const defined = Object.entries(siblings).filter(
    ([, value]) => value !== undefined
  );
  const merged = { ...target, ...Object.fromEntries(defined) };
  const targetProperties = propertiesOf(target);
  const siblingProperties = propertiesOf(siblings);
  if (targetProperties && siblingProperties) {
    merged.properties = mergeProperties(targetProperties, siblingProperties);
  }
  return merged;
}

/**
 * Follows a local JSON pointer `$ref` ("#", "#/definitions/X", "#/$defs/X") to
 * its target in the root schema. Anchors ("#name") are not resolved. zod 4 emits one for a schema registered with `.meta({ id })`
 * and pydantic-based MCP servers emit them for nested models. Keywords next to
 * the `$ref`, such as a `description`, win over the target's.
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
  return withSiblings(target, siblings);
}

/**
 * `.nullable()` becomes `anyOf: [inner, { type: "null" }]`. Read through it, so
 * a nullable property counts like the same property without `null`. Keywords
 * next to the `anyOf` (`description`, `enum`, ...) win over the inner schema's.
 * A real union (two or more non-null variants) is left alone.
 */
function withoutNull(schema: Record<string, unknown>): Record<string, unknown> {
  const key = Array.isArray(schema.anyOf) ? "anyOf" : "oneOf";
  const variants = schema[key];
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
  const { [key]: _variants, ...siblings } = schema;
  return withSiblings(inner, siblings);
}

interface SchemaWalk {
  countText: (text: string) => number;
  config: ModelTokens;
  /** The whole tool schema, which local `$ref`s point into. */
  root: unknown;
  /** `properties` being walked, so a recursive schema ends. */
  ancestors: Set<Properties>;
  /**
   * Tokens of each `properties` already walked. Every definition is
   * walked once per tool, which bounds the walk by the size of the schema.
   * Without it, definitions that share definitions would be walked once per
   * path, and recursive ones once per cycle.
   */
  counted: Map<Properties, number>;
  /** Tokens each key of a walked, plain `properties` contributes. */
  byKey: Map<Record<string, unknown>, Map<string, number>>;
}

/** The schema a property stands for once `$ref` and `null` wrappers are read through. */
function unwrap(value: Record<string, unknown>, walk: SchemaWalk) {
  return resolveRef(withoutNull(resolveRef(value, walk.root)), walk.root);
}

function countToolSchema(
  jsonSchema: unknown,
  countText: (text: string) => number,
  config: ModelTokens
): number {
  if (!isRecord(jsonSchema)) {
    return 0;
  }
  const walk: SchemaWalk = {
    countText,
    config,
    root: jsonSchema,
    ancestors: new Set(),
    counted: new Map(),
    byKey: new Map(),
  };
  return countSchemaProperties(resolveRef(jsonSchema, jsonSchema), walk);
}

/**
 * Count the properties of a JSON Schema object by walking its structure.
 * Unions (`anyOf`, `oneOf`, `allOf`) and non-local `$ref`s are not followed.
 */
function countSchemaProperties(schema: unknown, walk: SchemaWalk): number {
  const properties = propertiesOf(schema);
  return properties ? countProperties(properties, walk) : 0;
}

function countProperties(properties: Properties, walk: SchemaWalk): number {
  const counted = walk.counted.get(properties);
  if (counted !== undefined) {
    return counted;
  }
  if (walk.ancestors.has(properties)) {
    return 0;
  }
  walk.ancestors.add(properties);
  const tokens =
    properties instanceof MergedProperties
      ? countMerged(properties, walk)
      : countEntries(properties, walk);
  walk.ancestors.delete(properties);
  // A definition inside a cycle is counted with its back edge cut where the
  // walk first reached it, and that count is reused wherever it is referenced.
  walk.counted.set(properties, tokens);
  return tokens;
}

function countEntries(
  properties: Record<string, unknown>,
  walk: SchemaWalk
): number {
  const byKey = new Map<string, number>();
  let tokens = 0;
  for (const [key, value] of Object.entries(properties)) {
    const keyTokens = countProperty(key, value, byKey.size === 0, walk);
    byKey.set(key, keyTokens);
    tokens += keyTokens;
  }
  walk.byKey.set(properties, byKey);
  return tokens;
}

const firstKeys = new WeakMap<object, string | undefined>();

function firstKey(properties: Record<string, unknown>): string | undefined {
  if (!firstKeys.has(properties)) {
    for (const key in properties) {
      firstKeys.set(properties, key);
      return key;
    }
    firstKeys.set(properties, undefined);
  }
  return firstKeys.get(properties);
}

/**
 * The target's tokens, with each sibling key replacing the target's key of the
 * same name or following the target's last key. The target is already walked
 * (or is being walked: then its back edge is cut and only the siblings count).
 */
function countMerged(merged: MergedProperties, walk: SchemaWalk): number {
  const { target, siblings } = merged;
  if (walk.ancestors.has(target)) {
    return countEntries(siblings, walk);
  }
  let tokens = countProperties(target, walk);
  const targetKeys = walk.byKey.get(target);
  const targetFirst = firstKey(target);
  const siblingFirst = firstKey(siblings);
  for (const [key, value] of Object.entries(siblings)) {
    const replaced = targetKeys?.get(key);
    const isFirst =
      targetFirst === undefined ? key === siblingFirst : key === targetFirst;
    tokens += countProperty(key, value, isFirst, walk) - (replaced ?? 0);
  }
  return tokens;
}

/** The tokens one property of an object schema adds. */
function countProperty(
  key: string,
  value: unknown,
  isFirstProp: boolean,
  walk: SchemaWalk
): number {
  const { countText, config } = walk;
  // Count property name tokens
  let tokens = countText(key);

  // Add property overhead (first vs additional)
  tokens += isFirstProp ? config.perFirstProp : config.perAdditionalProp;

  if (!isRecord(value)) {
    return tokens;
  }
  const propSchema = unwrap(value, walk);

  // Count property description if present
  if (typeof propSchema.description === "string" && propSchema.description) {
    tokens += config.perPropDesc;
    tokens += countText(propSchema.description);
  }

  // Handle enums - count each enum value + overhead
  if (Array.isArray(propSchema.enum)) {
    tokens += config.perEnum;
    if (config.anthropic) {
      // The API reads the values as one JSON array.
      tokens += countText(spacedJson(propSchema.enum) ?? "");
    } else {
      for (const enumValue of propSchema.enum) {
        tokens += countText(String(enumValue));
      }
    }
  }

  if (propertiesOf(propSchema)) {
    // Handle nested objects
    tokens += config.perNestedObject || 0;
    tokens += countSchemaProperties(propSchema, walk);
  } else if (isRecord(propSchema.items)) {
    tokens += config.anthropic?.perArray ?? 0;
    // Handle arrays with object items
    const items = unwrap(propSchema.items, walk);
    if (propertiesOf(items)) {
      tokens += config.perArrayOfObjects || 0;
    }
    tokens += countSchemaProperties(items, walk);
  }
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
    // A `file` part counts as a file whatever its media type, as it always
    // has. The image-counting change will decide this from `mediaType`.
    kind:
      part.type !== "file" &&
      (isImageMediaType || MEDIA_KINDS.get(part.type as string) === "image")
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

/** One text, tool call, tool result or media part of a Claude request. */
type ClaudeBlock =
  | { kind: "text"; text: string; part: TextContent }
  | { kind: "tool-call"; name: string; input: unknown; part: ToolCallContent }
  | {
      kind: "tool-result";
      text: string;
      media: number;
      isError: boolean;
      part: ToolResultContent;
    }
  | { kind: "media" };

type TextContent = Extract<CountResultMessageContent, { type: "text" }>;
type ToolCallContent = Extract<
  CountResultMessageContent,
  { type: "tool-call" }
>;
type ToolResultContent = Extract<
  CountResultMessageContent,
  { type: "tool-result" }
>;
type TextBlock = Extract<ClaudeBlock, { kind: "text" }>;

/**
 * The blocks of one request message. The API merges consecutive user and tool
 * messages into one user turn and consecutive assistant messages into one
 * assistant turn, as the AI SDK's Anthropic provider does before it sends them.
 */
interface ClaudeTurn {
  role: "system" | "user" | "assistant";
  /** The message that carries the overhead of this turn. */
  first: number;
  blocks: ClaudeBlock[];
}

/**
 * Counts messages the way Anthropic's `count_tokens` does for the model whose
 * encoding `tokenizer` has: one frame in `baseOverhead`, the tokens of the
 * text, and the overhead of each turn and block. Role names and tool call ids
 * are not tokens. `results[i]` is the breakdown of `messages[i]`.
 */
function countClaudeMessages(
  tokenizer: Tokenizer,
  messages: ModelMessage[],
  tokens: AnthropicTokens
): CountResultMessage[] {
  const results = messages.map(
    (): CountResultMessage => ({ total: 0, content: [] })
  );
  const system: ClaudeTurn = { role: "system", first: -1, blocks: [] };
  const turns: ClaudeTurn[] = [];
  messages.forEach((message, index) => {
    const result = results[index]!;
    if (message.role === "system") {
      system.first = system.first < 0 ? index : system.first;
      addClaudeBlocks(system, message.content, result);
      return;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    let turn = turns.at(-1);
    if (turn?.role !== role) {
      turn = { role, first: index, blocks: [] };
      turns.push(turn);
    }
    addClaudeBlocks(turn, message.content, result);
  });

  // A final assistant message is what the model continues, and the provider
  // trims its text: the API refuses to end it with whitespace.
  const last = turns.at(-1);
  const lastBlock = last?.blocks.at(-1);
  if (last?.role === "assistant" && lastBlock?.kind === "text") {
    lastBlock.text = lastBlock.text.trim();
  }

  if (system.first >= 0) {
    results[system.first]!.total += tokens.system;
    countClaudeTurn(tokenizer, tokens, system);
  }
  // Turns alternate, so the turn before an assistant turn is a user turn.
  turns.forEach((turn, i) => {
    if (turn.role === "user" && turns[i - 1]?.role === "assistant") {
      const answersToolResult =
        turns[i - 2]?.blocks.at(-1)?.kind === "tool-result" &&
        turn.blocks[0]?.kind !== "tool-result";
      results[turn.first]!.total +=
        tokens.userTurn +
        (answersToolResult ? tokens.userTurnAfterToolResult : 0);
    }
    countClaudeTurn(tokenizer, tokens, turn);
  });
  for (const result of results) {
    result.total += result.content.reduce((sum, part) => sum + part.total, 0);
  }
  return results;
}

function addClaudeBlocks(
  turn: ClaudeTurn,
  content: ModelMessage["content"],
  result: CountResultMessage
): void {
  const addText = (text: string) => {
    const part: TextContent = { type: "text", total: 0 };
    result.content.push(part);
    turn.blocks.push({ kind: "text", text, part });
  };
  if (typeof content === "string") {
    addText(content);
    return;
  }
  if (!Array.isArray(content)) {
    return;
  }
  for (const part of content as unknown[]) {
    if (!isRecord(part)) {
      continue;
    }
    if (part.type === "text") {
      addText(typeof part.text === "string" ? part.text : "");
    } else if (part.type === "tool-call") {
      const counted: ToolCallContent = {
        type: "tool-call",
        total: 0,
        input: 0,
      };
      result.content.push(counted);
      turn.blocks.push({
        kind: "tool-call",
        name: typeof part.toolName === "string" ? part.toolName : "",
        input: part.input,
        part: counted,
      });
    } else if (part.type === "tool-result") {
      const counted: ToolResultContent = {
        type: "tool-result",
        total: 0,
        output: 0,
      };
      result.content.push(counted);
      turn.blocks.push({
        kind: "tool-result",
        ...readToolResult(part.output),
        part: counted,
      });
    } else if (typeof part.type === "string" && MEDIA_KINDS.has(part.type)) {
      const text = inlineText(part);
      if (text !== undefined) {
        addText(text);
      } else {
        result.content.push({
          type: "text",
          total: countMediaTokens(toMedia(part)),
        });
        turn.blocks.push({ kind: "media" });
      }
    }
  }
}

/** The text and media of a tool result, as the provider puts them in `tool_result.content`. */
function readToolResult(output: unknown): {
  text: string;
  media: number;
  isError: boolean;
} {
  if (typeof output === "string") {
    return { text: output, media: 0, isError: false };
  }
  if (!isRecord(output)) {
    return { text: "", media: 0, isError: false };
  }
  const isError = output.type === "error-text" || output.type === "error-json";
  if (output.type === "text" || output.type === "error-text") {
    return { text: String(output.value ?? ""), media: 0, isError };
  }
  if (output.type === "execution-denied") {
    const reason =
      typeof output.reason === "string" ? output.reason : undefined;
    return { text: reason ?? "Tool call execution denied.", media: 0, isError };
  }
  if (output.type === "content" && Array.isArray(output.value)) {
    let text = "";
    let media = 0;
    for (const item of output.value as unknown[]) {
      if (!isRecord(item)) {
        continue;
      }
      const inline = inlineText(item);
      if (item.type === "text" && typeof item.text === "string") {
        text += item.text;
      } else if (inline !== undefined) {
        text += inline;
      } else if (isBinaryMediaPart(item)) {
        media += countMediaTokens(toMedia(item));
      }
    }
    return { text, media, isError };
  }
  return { text: JSON.stringify(output.value) ?? "", media: 0, isError };
}

function countClaudeTurn(
  tokenizer: Tokenizer,
  tokens: AnthropicTokens,
  turn: ClaudeTurn
): void {
  const { blocks } = turn;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.kind === "tool-call") {
      const input = countToolInput(tokenizer, tokens, block.input);
      block.part.input = input;
      block.part.total = tokenizer.countUntrimmed(block.name) + input;
    } else if (block.kind === "tool-result") {
      const output =
        block.text === "" && block.media === 0
          ? tokens.emptyToolResult
          : tokenizer.countUntrimmed(block.text) + block.media;
      block.part.output = output;
      block.part.total =
        tokens.toolResult +
        (block.isError ? tokens.toolResultError : 0) +
        output;
    } else if (block.kind === "text") {
      let end = i;
      while (blocks[end + 1]?.kind === "text") {
        end++;
      }
      const run = blocks.slice(i, end + 1) as TextBlock[];
      // The API trims the end of a user message and of the system prompt,
      // which only the last run of the turn can reach.
      const trimmed =
        turn.role === "system" ||
        (turn.role === "user" && end === blocks.length - 1);
      const shares = countTextRun(tokenizer, run, trimmed);
      if (blocks[i - 1]?.kind === "tool-result") {
        shares[0]! += tokens.textAfterToolResult;
      }
      run.forEach((textBlock, k) => {
        textBlock.part.total = shares[k]!;
      });
      i = end;
    }
  }
}

const WHITESPACE_ONLY = /^[\t-\r ]*$/;

/**
 * The tokens of text blocks that the API joins with no separator, shared out
 * over the blocks. A part's share is its own tokens, moved by what joining
 * changed: it can be less than the tokens of the part alone, and never less
 * than 0. The shares sum to the count of the joined text.
 */
function countTextRun(
  tokenizer: Tokenizer,
  run: TextBlock[],
  trimmed: boolean
): number[] {
  const joined = run.map((block) => block.text).join("");
  // A last block of only whitespace is not trimmed, and neither is the rest.
  const isTrimmed = trimmed && !WHITESPACE_ONLY.test(run.at(-1)!.text);
  const total = isTrimmed
    ? tokenizer.count(joined)
    : tokenizer.countUntrimmed(joined);
  if (run.length === 1) {
    return [total];
  }
  const shares = run.map((block) => tokenizer.countUntrimmed(block.text));
  let rest = total - shares.reduce((sum, share) => sum + share, 0);
  for (let k = shares.length - 1; k >= 0 && rest !== 0; k--) {
    const move = rest > 0 ? rest : Math.max(rest, -shares[k]!);
    shares[k]! += move;
    rest -= move;
  }
  return shares;
}

/**
 * JSON the way the API counts a tool call's parameter: a space after each comma
 * and colon, which compact JSON leaves out and which count as tokens.
 */
function spacedJson(value: unknown): string | undefined {
  const json = JSON.stringify(value);
  return json === undefined ? undefined : spaced(JSON.parse(json));
}

function spaced(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(spaced).join(", ")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).map(
      ([key, item]) => `${JSON.stringify(key)}: ${spaced(item)}`
    );
    return `{${entries.join(", ")}}`;
  }
  return JSON.stringify(value);
}

/**
 * A tool call's input as the request body holds it: each top-level parameter
 * costs `toolUseParam` plus its key and its value, a string as it is and any
 * other value as spaced JSON.
 */
function countToolInput(
  tokenizer: Tokenizer,
  tokens: AnthropicTokens,
  input: unknown
): number {
  if (!isRecord(input) || Array.isArray(input)) {
    return input === undefined || input === null
      ? 0
      : tokenizer.countUntrimmed(JSON.stringify(input) ?? "");
  }
  let total = 0;
  for (const [key, value] of Object.entries(input)) {
    // JSON.stringify leaves out what it cannot write, and so does the body.
    const text = typeof value === "string" ? value : spacedJson(value);
    if (text !== undefined) {
      total +=
        tokens.toolUseParam +
        tokenizer.countUntrimmed(key) +
        tokenizer.countUntrimmed(text);
    }
  }
  return total;
}
