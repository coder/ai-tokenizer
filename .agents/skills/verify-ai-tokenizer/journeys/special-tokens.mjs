// special-tokens: allowedSpecial / disallowedSpecial on Tokenizer.encode, compared with tiktoken.
import { Tokenizer } from "ai-tokenizer";
import * as encoding from "ai-tokenizer/encoding";
import { get_encoding } from "tiktoken";
import { check, finish, outcome, sameJSON } from "./check.mjs";

const text = "hello <|endoftext|> world";

for (const name of ["o200k_base", "cl100k_base", "p50k_base"]) {
  const ours = new Tokenizer(encoding[name]);
  const oracle = get_encoding(name);
  const tk = (...args) => outcome(() => Array.from(oracle.encode(...args)));
  const me = (...args) => outcome(() => ours.encode(...args));
  const eot = encoding[name].special_tokens["<|endoftext|>"];

  const dflt = [me(text), tk(text)];
  check(`${name}/default-disallows`, `encode("${text}")`, { tiktoken: dflt[1] }, { ours: dflt[0] }, "threw" in dflt[0] && "threw" in dflt[1]);

  const list = [me(text, ["<|endoftext|>"]), tk(text, ["<|endoftext|>"])];
  check(`${name}/allowed-list`, `encode("${text}", ["<|endoftext|>"])`, list[1], list[0], sameJSON(list[0], list[1]) && list[0].value?.includes(eot));

  const all = [me(text, "all"), tk(text, "all")];
  check(`${name}/allowed-all`, `encode("${text}", "all")`, all[1], all[0], sameJSON(all[0], all[1]));

  const none = [me(text, [], []), tk(text, [], [])];
  check(`${name}/disallowed-none`, `encode("${text}", [], [])`, none[1], none[0], sameJSON(none[0], none[1]));

  const dec = outcome(() => ours.decode([eot]));
  check(`${name}/decode-special`, `decode([${eot}])`, "<|endoftext|>", dec, dec.value === "<|endoftext|>");

  const cnt = outcome(() => ours.count(text));
  check(`${name}/count-matches-encode`, `count("${text}") behaves like encode("${text}")`, { encode: dflt[0] }, { count: cnt }, sameJSON("threw" in cnt, "threw" in dflt[0]));
  oracle.free();
}

// claude special tokens look like ordinary markup, so users hit them in normal text.
const claude = new Tokenizer(encoding.claude);
const ctext = "a <EOT> b";
const cd = outcome(() => claude.encode(ctext));
check("claude/default-disallows", `encode("${ctext}")`, "throws, like the tiktoken encodings", cd, "threw" in cd);
const cl = outcome(() => claude.encode(ctext, ["<EOT>"]));
check("claude/allowed-list", `encode("${ctext}", ["<EOT>"])`, "contains special id 0", cl, cl.value?.includes(0));
const ca = outcome(() => claude.encode(ctext, "all"));
check("claude/allowed-all", `encode("${ctext}", "all")`, cl, ca, sameJSON(ca, cl));
const cdec = outcome(() => claude.decode([0]));
check("claude/decode-special", "decode([0])", "<EOT>", cdec, cdec.value === "<EOT>");

finish("special-tokens");
