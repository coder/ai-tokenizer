// The README SDK snippet, typechecked as a TypeScript CommonJS consumer would write it.
import { Tokenizer, models } from "ai-tokenizer";
import { count } from "ai-tokenizer/sdk";
import * as claude from "ai-tokenizer/encoding/claude";

const model = models["anthropic/claude-sonnet-4.5"];
const tokenizer = new Tokenizer(claude);
export const total: number = count({ tokenizer, model, messages: [{ role: "user", content: "hello" }] }).total;
