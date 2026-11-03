// encode-decode: plain text through each encoding, compared with tiktoken.
import { Tokenizer } from "ai-tokenizer";
import * as encoding from "ai-tokenizer/encoding";
import { get_encoding } from "tiktoken";
import { check, finish, sameJSON } from "./check.mjs";

const corpus = {
  english: "The quick brown fox jumps over the lazy dog.",
  unicode: "Grüße, 你好, こんにちは, مرحبا, 🌍🚀👩‍👩‍👧",
  code: "def f(x):\n    return x ** 2  # square\r\n\n\tprint(f(3))\n",
  numbers: "1234567890 3.14159 -42 1e10",
  whitespace: "   leading and trailing   \n\n\n",
  repeated: "ab".repeat(2000),
  empty: "",
};

for (const name of ["o200k_base", "cl100k_base", "p50k_base"]) {
  const ours = new Tokenizer(encoding[name]);
  const oracle = get_encoding(name);
  for (const [label, text] of Object.entries(corpus)) {
    const got = ours.encode(text);
    const want = Array.from(oracle.encode(text));
    check(`${name}/${label}/encode`, `new Tokenizer(${name}).encode(<${label}>)`, { tiktoken: want.length }, { ours: got.length, firstDiff: got.findIndex((t, i) => t !== want[i]) }, sameJSON(got, want));
    check(`${name}/${label}/count`, `count(<${label}>)`, want.length, ours.count(text), ours.count(text) === want.length);
    check(`${name}/${label}/roundtrip`, `decode(encode(<${label}>))`, text, ours.decode(got), ours.decode(got) === text);
    check(`${name}/${label}/decode-oracle-ids`, `decode(<tiktoken ids for ${label}>)`, text, ours.decode(want), ours.decode(want) === text);
  }
  oracle.free();
}

// No tiktoken oracle for claude: round trip and count consistency only.
const claude = new Tokenizer(encoding.claude);
for (const [label, text] of Object.entries(corpus)) {
  const ids = claude.encode(text);
  check(`claude/${label}/roundtrip`, `decode(encode(<${label}>))`, text, claude.decode(ids), claude.decode(ids) === text);
  check(`claude/${label}/count`, `count(<${label}>) equals encode length`, ids.length, claude.count(text), claude.count(text) === ids.length);
}
check("claude/encodingName", "tokenizer.encodingName", "claude", claude.encodingName, claude.encodingName === "claude");

finish("encode-decode");
