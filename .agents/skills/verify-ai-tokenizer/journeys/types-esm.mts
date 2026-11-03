// The README usage snippets, typechecked as a TypeScript ESM consumer would write them.
import Tokenizer, { models } from "ai-tokenizer";
import { count } from "ai-tokenizer/sdk";
import * as encoding from "ai-tokenizer/encoding";
import * as o200k_base from "ai-tokenizer/encoding/o200k_base";

const model = models["openai/gpt-5"];
const tokenizer = new Tokenizer(encoding[model.encoding]);
const result = count({ tokenizer, model, messages: [{ role: "user", content: "hello" }] });
const costUSD: number = result.total * model.pricing.input;

const direct = new Tokenizer(o200k_base);
const total: number = direct.count("some text input");

export { costUSD, total };
