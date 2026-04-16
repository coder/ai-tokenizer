import Tokenizer from "./tokenizer";
import type * as encodings from "./encoding";

export default Tokenizer;
export { Tokenizer };
export type { Encoding } from "./tokenizer";

type ModelsJson = typeof import("./models.json");

export type ModelName = keyof ModelsJson;

// Override the encoding field to be properly typed
type ModelWithTypedEncoding<T extends ModelName = ModelName> = Omit<
  ModelsJson[T],
  "encoding"
> & {
  encoding: keyof typeof encodings;
};

export type Model<T extends ModelName = ModelName> = ModelWithTypedEncoding<T>;
export type ModelTokens = Model["tokens"];

// Lazy models — JSON is not parsed until first access
let _modelsJson: ModelsJson | undefined;
function getModelsJson(): ModelsJson {
  if (_modelsJson === undefined) {
    _modelsJson = require("./models.json");
  }
  return _modelsJson!;
}

// Properly typed models record where each key maps to its specific model
export const models: {
  [K in ModelName]: Model<K>;
} = new Proxy({} as any, {
  get(_, key: string) {
    return (getModelsJson() as any)[key];
  },
  has(_, key: string) {
    return key in getModelsJson();
  },
  ownKeys() {
    return Reflect.ownKeys(getModelsJson());
  },
  getOwnPropertyDescriptor(_, key: string) {
    const m = getModelsJson() as any;
    if (key in m) {
      return { configurable: true, enumerable: true, value: m[key] };
    }
    return undefined;
  },
});
