import Tokenizer from "./tokenizer";
import modelsJson from "./models.json";
import type * as encodings from "./encoding";

export default Tokenizer;
export { Tokenizer };
export type { Codec, CodecEncoding, Encoding } from "./tokenizer";

export type ModelName = keyof typeof modelsJson;

/**
 * What the Claude API charges for the structure of a conversation, on top of
 * the tokens of its text. A model that has these counts the way Anthropic's
 * `count_tokens` does: `count()` reads them instead of `perMessage`, and counts
 * neither role names nor tool call ids. Measured by
 * `scripts/generate-model-configs.ts --provider anthropic`.
 */
export interface AnthropicTokens {
  /** A user turn after an assistant turn. The first user turn is in `baseOverhead`. */
  userTurn: number;
  /** The system prompt, once, when there is one. */
  system: number;
  /** Each top-level parameter of a tool call's input, on top of its key and value. */
  toolUseParam: number;
  /** A tool call and its result: both blocks, on top of the name, input and output. */
  toolResult: number;
  /**
   * A user turn that starts with text, after an assistant turn that answered a
   * tool result, on top of `userTurn`: 2 on Opus 5.5 and later, 0 before.
   */
  userTurnAfterToolResult: number;
  /** A tool input property that is an array, on top of its items. */
  perArray: number;
  /** A tool result that is an error, on top of `toolResult`. */
  toolResultError: number;
  /** What the API puts in place of an empty tool result, instead of its text. */
  emptyToolResult: number;
  /** Text that follows a tool result in the same user turn. */
  textAfterToolResult: number;
  /** An image in a tool result, on top of what the same image costs in a user turn. */
  imageInToolResult: number;
  /** A tool result that holds an image, once, on top of its blocks. */
  toolResultWithImage: number;
  /** Each text block of a tool result that also holds an image. */
  textInImageToolResult: number;
}

/**
 * An image that is scaled down to fit a limit and then charged per square
 * patch of pixels. The long edge is cut to `maxEdge`. While the image still has
 * more than `maxPatches` patches, the long edge loses one pixel at a time and
 * the short edge follows at the same aspect ratio, rounded.
 */
export interface PatchImageTokens {
  kind: "patches";
  /** Side of a patch, in pixels. */
  patch: number;
  maxEdge: number;
  maxPatches: number;
  /** Tokens an image costs on top of its patches. */
  overhead: number;
}

/** How a model prices an image from its size. Measured by `scripts/measure-media-*.ts`. */
export type ImageTokens = PatchImageTokens;

export interface MediaTokens {
  image: ImageTokens;
}

export interface ModelTokens {
  /** With `anthropic`: the frame of a request that holds one user message. */
  baseOverhead: number;
  /** Not read when `anthropic` is set. */
  perMessage: number;
  toolsExist: number;
  perTool: number;
  perDesc: number;
  perFirstProp: number;
  perAdditionalProp: number;
  perPropDesc: number;
  perEnum: number;
  perNestedObject: number;
  perArrayOfObjects: number;
  /** 1 when `anthropic` is set: the encoding is exact. */
  contentMultiplier: number;
  anthropic?: AnthropicTokens;
  /** Image prices by size. A model without it counts every image as 85 tokens and every file as 100. */
  media?: MediaTokens;
}

// Override the encoding and tokens fields to be properly typed
type ModelWithTypedEncoding<T extends ModelName = ModelName> = Omit<
  (typeof modelsJson)[T],
  "encoding" | "tokens"
> & {
  encoding: keyof typeof encodings;
  tokens: ModelTokens;
};

export type Model<T extends ModelName = ModelName> = ModelWithTypedEncoding<T>;

// Fails to compile when a models.json entry does not fit `ModelTokens`.
modelsJson satisfies Record<string, { tokens: ModelTokens }>;

// Properly typed models record where each key maps to its specific model
export const models: {
  [K in ModelName]: Model<K>;
} = modelsJson as any;
