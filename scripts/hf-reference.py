"""
Token ids from the Hugging Face `tokenizers` library, the reference for the
llama4 and gemma4 encodings.

Usage:
  uvx --with tokenizers python scripts/hf-reference.py \
    <tokenizer.json> <samples.jsonl> <ids.jsonl> [--special]

samples.jsonl holds one JSON string per line. ids.jsonl gets one JSON array
of token ids per line. A special-token string in a sample is ordinary text,
because the added tokens are dropped before loading. `--special` keeps them,
so they encode to their own id.
"""

import json
import sys

import tokenizers


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    keep_special = "--special" in sys.argv[1:]
    tokenizer_path, samples_path, ids_path = args

    with open(tokenizer_path, encoding="utf-8") as f:
        spec = json.load(f)
    if not keep_special:
        spec["added_tokens"] = []
    tokenizer = tokenizers.Tokenizer.from_str(json.dumps(spec))

    with open(samples_path, encoding="utf-8") as f:
        samples = [json.loads(line) for line in f]
    encodings = tokenizer.encode_batch(samples, add_special_tokens=False)
    with open(ids_path, "w", encoding="utf-8") as f:
        for encoding in encodings:
            f.write(json.dumps(encoding.ids, separators=(",", ":")) + "\n")
    print(f"tokenizers {tokenizers.__version__}: {len(samples)} samples")


main()
