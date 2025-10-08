import Tokenizer from "./tokenizer";
import modelsJson from "./models.json";
import type * as encodings from "./encoding";

export default Tokenizer;
export { Tokenizer };
export type { Encoding } from "./tokenizer";

export type ModelName = keyof typeof modelsJson;

// Override the encoding field to be properly typed
type ModelWithTypedEncoding<T extends ModelName = ModelName> = Omit<
  (typeof modelsJson)[T],
  "encoding"
> & {
  encoding: keyof typeof encodings;
};

export type Model<T extends ModelName = ModelName> = ModelWithTypedEncoding<T>;
export type ModelTokens = Model["tokens"];

// Properly typed models record where each key maps to its specific model
export const models: {
  [K in ModelName]: Model<K>;
} = modelsJson as any;
