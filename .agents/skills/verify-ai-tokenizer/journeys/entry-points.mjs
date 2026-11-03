// entry-points (ESM): every public subpath resolves to the ESM build and works.
import Tokenizer, { Tokenizer as Named, models } from "ai-tokenizer";
import { count } from "ai-tokenizer/sdk";
import * as encoding from "ai-tokenizer/encoding";
import * as cl100k_base from "ai-tokenizer/encoding/cl100k_base";
import * as o200k_base from "ai-tokenizer/encoding/o200k_base";
import * as p50k_base from "ai-tokenizer/encoding/p50k_base";
import * as claude from "ai-tokenizer/encoding/claude";
import * as claude_v3 from "ai-tokenizer/encoding/claude_v3";
import * as claude_v4_7 from "ai-tokenizer/encoding/claude_v4_7";
import * as claude_v4_8 from "ai-tokenizer/encoding/claude_v4_8";
import * as claude_v5 from "ai-tokenizer/encoding/claude_v5";
import { check, finish, outcome, sameJSON } from "./check.mjs";

const specs = ["ai-tokenizer", "ai-tokenizer/sdk", "ai-tokenizer/encoding", ...["cl100k_base", "o200k_base", "p50k_base", "claude", "claude_v3", "claude_v4_7", "claude_v4_8", "claude_v5"].map((n) => `ai-tokenizer/encoding/${n}`)];
for (const s of specs) {
  const r = outcome(() => import.meta.resolve(s));
  check(`resolve/${s}`, `import.meta.resolve("${s}")`, "a dist/*.js file inside node_modules/ai-tokenizer", r, /node_modules\/ai-tokenizer\/dist\/.+\.js$/.test(r.value ?? ""));
}

check("default-export", 'import Tokenizer, { Tokenizer } from "ai-tokenizer"', "the same class", { same: Tokenizer === Named, type: typeof Tokenizer }, Tokenizer === Named && typeof Tokenizer === "function");
check("models", 'import { models } from "ai-tokenizer"', "a non-empty record with encoding names", Object.keys(models).length, Object.keys(models).length > 0 && Object.values(models).every((m) => m.encoding in encoding));
check("sdk-count", 'import { count } from "ai-tokenizer/sdk"', "function", typeof count, typeof count === "function");

const subpaths = { cl100k_base, o200k_base, p50k_base, claude, claude_v3, claude_v4_7, claude_v4_8, claude_v5 };
for (const [name, mod] of Object.entries(subpaths)) {
  check(`encoding/${name}/name`, `import * as ${name} from "ai-tokenizer/encoding/${name}"`, name, mod.name, mod.name === name);
  const a = outcome(() => new Tokenizer(mod).encode("hello world"));
  const b = outcome(() => new Tokenizer(encoding[name]).encode("hello world"));
  check(`encoding/${name}/same-as-namespace`, `new Tokenizer(${name}) vs new Tokenizer(encoding.${name})`, b, a, sameJSON(a, b) && Array.isArray(a.value));
}

finish("entry-points-esm");
