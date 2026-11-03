"""
Build fixtures/hf-corpus.json, the text samples for the llama4 and gemma4
fixture test. Run `bun scripts/compare-hf.ts fixture` afterwards to record
the reference token counts.

Usage:
  python3 scripts/build-hf-corpus.py

Real text comes from Wikipedia (fixed titles) and from source files on this
machine. Synthetic samples are repeated units and a seeded random mix of
Unicode. The output keeps the text, so the build does not need to repeat.
"""

import json
import os
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT = os.path.join(ROOT, "fixtures", "hf-corpus.json")
WIKI_CHARS = 2500
FILE_CHARS = 6000

WIKI_TITLES = {
    "en": ["Byte pair encoding", "Unicode", "Coffee", "Mount Everest"],
    "zh": ["北京市", "长城"],
    "ja": ["東京", "寿司"],
    "ko": ["서울특별시", "김치"],
    "ar": ["القاهرة"],
    "he": ["ירושלים"],
    "hi": ["भारत"],
    "bn": ["ঢাকা"],
    "ta": ["சென்னை"],
    "th": ["กรุงเทพมหานคร"],
    "my": ["ရန်ကုန်"],
    "km": ["ភ្នំពេញ"],
    "am": ["አዲስ_አበባ"],
    "ka": ["თბილისი"],
    "hy": ["Երևան"],
    "ru": ["Москва"],
    "uk": ["Київ"],
    "el": ["Αθήνα"],
    "fa": ["تهران"],
    "de": ["Berlin"],
    "fr": ["Paris"],
    "es": ["Madrid"],
    "pt": ["Lisboa"],
    "it": ["Roma"],
    "nl": ["Amsterdam"],
    "sv": ["Stockholm"],
    "pl": ["Warszawa"],
    "cs": ["Praha"],
    "hu": ["Budapest"],
    "fi": ["Helsinki"],
    "tr": ["İstanbul"],
    "vi": ["Hà_Nội"],
    "id": ["Jakarta"],
    "sw": ["Nairobi"],
}

GO_SRC = "/opt/mise/data/installs/go/1.26/src"
RUST_SRC = os.path.expanduser(
    "~/.rustup/toolchains/stable-user/lib/rustlib/src/rust/library"
)
LOCAL_FILES = [
    "README.md",
    "package.json",
    "tsconfig.json",
    "src/tokenizer.ts",
    "src/sdk.ts",
    "site/index.html",
    "site/style.css",
    "node_modules/ai/dist/index.d.ts",
    "node_modules/gpt-tokenizer/README.md",
    "/usr/include/stdio.h",
    "/usr/lib/python3.14/argparse.py",
    "/usr/lib/python3.14/json/decoder.py",
    GO_SRC + "/net/http/server.go",
    GO_SRC + "/sort/sort.go",
    RUST_SRC + "/core/src/option.rs",
    RUST_SRC + "/alloc/src/vec/mod.rs",
]

INLINE = {
    "sql": "SELECT u.id, u.name, COUNT(o.id) AS orders\nFROM users u\n  LEFT JOIN orders o ON o.user_id = u.id\nWHERE u.created_at >= '2024-01-01'\nGROUP BY u.id, u.name\nHAVING COUNT(o.id) > 5\nORDER BY orders DESC\nLIMIT 10;\n",
    "shell": "#!/usr/bin/env bash\nset -euo pipefail\nfor f in *.log; do\n  grep -c 'ERROR' \"$f\" | xargs printf '%s: %d\\n' \"$f\"\ndone\n",
    "yaml": "services:\n  web:\n    image: nginx:1.27\n    ports:\n      - \"8080:80\"\n    environment:\n      - KEY=value\n    healthcheck:\n      test: [\"CMD\", \"curl\", \"-f\", \"http://localhost\"]\n",
    "json": '{"id": 12345, "tags": ["a", "b"], "nested": {"ok": true, "pi": 3.14159, "none": null}, "text": "caf\\u00e9 \\ud83d\\ude00"}',
    "stack-trace": "Traceback (most recent call last):\n  File \"/app/main.py\", line 42, in <module>\n    result = compute(x, y)\n  File \"/app/lib.py\", line 7, in compute\n    return x / y\nZeroDivisionError: division by zero\n",
    "diff": "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,4 @@\n import x from \"x\";\n-const a = 1;\n+const a = 2;\n+const b = 3;\n",
    "csv": "id,name,score\n1,Alice,93.5\n2,\"Bob, Jr.\",88\n3,Carol,\n",
    "latex": "\\begin{equation}\n  \\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}\n\\end{equation}\n",
    "base64": "SGVsbG8sIHdvcmxkISBUaGlzIGlzIGEgYmFzZTY0IGVuY29kZWQgc3RyaW5nIHdpdGggcGFkZGluZz09",
    "uuids": "550e8400-e29b-41d4-a716-446655440000 6ba7b810-9dad-11d1-80b4-00c04fd430c8 f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "urls": "https://example.com/a/b?c=d&e=f#g http://[::1]:8080/path file:///C:/Users/x/y.txt mailto:a.b+c@example.co.uk",
    "minified-js": "!function(e,t){\"object\"==typeof exports?module.exports=t():e.x=t()}(this,function(){return function(e){var t={};function n(r){if(t[r])return t[r].exports}return n}([])});",
    "chat-markup": "<|turn>user\nWhat does <bos> mean?<turn|>\n<|turn>model\n<start_of_turn>x<end_of_turn><eos>",
    "llama-markup": "<|begin_of_text|><|header_start|>user<|header_end|>\n\nHi<|eot|><|header_start|>assistant<|header_end|>",
    "contractions": "I'm, you're, he's, she'll, we've, they'd, don't, I'M, WE'LL, x'ſ, x'K, ’s, 's, ‘s",
    "numbers": "0 1 12 123 1234 12345 123456789 3.14159 1,000,000 -42 +7 1e10 ٠١٢٣ １２３ ½ ² Ⅷ",
    "math": "∀x∈ℝ, ∃y: x² + y² = 1 ∧ ∑ᵢ₌₁ⁿ aᵢ ≤ ∫₀¹ f(x)dx ≈ π ≠ ∞",
    "mixed-scripts": "Hello 世界! こんにちは, 안녕하세요, Привет мир, مرحبا, שלום, สวัสดี, नमस्ते 🌍🚀",
    "emoji": "😀 👍🏽 👨‍👩‍👧‍👦 🏳️‍🌈 🇯🇵 🇺🇸 ❤️ ☺️ 1️⃣ #️⃣ 🧑‍💻 🤌🏿",
    "combining": "e\u0301 a\u0308\u0301\u0302 n\u0303 \u0915\u094d\u0937 \u0e01\u0e34\u0e49 \u1100\u1161\u11a8",
    "zalgo": "Z\u0351\u036b\u0343\u036a\u0302\u036b\u033d\u034f\u0334\u0319\u0324\u031e\u0349\u035a\u032f\u031e\u0320\u034dA\u036b\u0357\u0334\u0362\u0335\u031c\u0330\u0354L\u0368\u0367\u0369\u0358\u0320G\u0311\u0357\u030e\u0305\u035b\u0341\u0334\u033b\u0348\u034d\u0354\u0339O\u0342\u030c\u030c\u0358\u0328\u0335\u0339\u033b\u031d\u0333!\u033f\u030b\u0365\u0365\u0302\u0363\u0310\u0301\u0301\u035e\u035c\u0356\u032c\u0330\u0319\u0317",
    "invisibles": "a\u200bb\u200cc\u200dd\u2060e\ufeff f\u00adg\u202ah\u202ci\u2066j\u2069k",
    "whitespace-kinds": "a\u00a0b\u2000c\u2003d\u2009e\u200af\u202fg\u205fh\u3000i\u0085j\u2028k\u2029l\u000bm\u000cn\u001co",
    "controls": "\u0000\u0001\u0002\u0007\u0008\u001b[31m\u007f\u0080\u009f",
    "noncharacters": "\ufdd0\ufdef\ufffe\uffff\U0001fffe\U0010ffff",
    "private-use": "\ue000\uf8ff\U000f0000\U0010fffd",
    "unassigned": "\u0378\u0379\u0ffe\U0003fffd\U000e0001\U000e0020\U000e007f",
    "astral-cjk": "𠀀𠀁𪚥𫝀𰀀 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 𝕏 🀄 🂡",
    "lone-marks": "\u0301\u0308 \u0301a \u200d\u200d \ufe0f\ufe0f",
    "unicode-name-chars": "Ǆ ǅ ǆ ß ẞ İ ı ſ K Å ǰ ΐ ﬁ ﬃ ŉ",
    "rtl-marks": "abc \u202e def \u202c \u200f \u200e שלום \u200f.",
}

REPEATS = {
    "space": (" ", [1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 255, 256, 1000, 5000]),
    "tab": ("\t", [1, 2, 3, 4, 8, 16, 31, 32, 33, 64, 1000]),
    "newline": ("\n", [1, 2, 3, 4, 8, 16, 29, 30, 31, 32, 33, 64, 1000]),
    "crlf": ("\r\n", [1, 2, 5, 40, 500]),
    "space-newline": (" \n", [1, 3, 50, 500]),
    "newline-space": ("\n ", [1, 3, 50, 500]),
    "space-mark": ("▁", [1, 2, 3, 30, 31, 32, 100]),
    "word-space": ("word ", [1, 2, 50, 2000]),
    "word-double-space": ("word  ", [1, 2, 50, 2000]),
    "indent": ("\n    ", [1, 2, 20, 200]),
    "underscore": ("_", [1, 2, 3, 16, 17, 100, 5000]),
    "dash": ("-", [3, 80, 5000]),
    "equals": ("=", [3, 80, 5000]),
    "dot": (".", [3, 80, 5000]),
    "slash": ("/", [1, 3, 80, 5000]),
    "hash": ("#", [1, 3, 80]),
    "star": ("*", [1, 3, 80]),
    "letter-a": ("a", [1, 2, 3, 20, 100, 5000]),
    "capital-a": ("A", [1, 2, 3, 20, 100, 5000]),
    "ab": ("ab", [1, 2, 50, 5000]),
    "digit-0": ("0", [1, 2, 3, 4, 5, 10, 100, 5000]),
    "digits": ("1234567890", [1, 10, 500]),
    "box-line": ("─", [1, 40, 2500]),
    "han": ("日", [1, 2, 3, 100, 2500]),
    "emoji-face": ("😀", [1, 2, 50, 1500]),
    "zwj": ("\u200d", [1, 10, 1000]),
    "combining-acute": ("e\u0301", [1, 10, 1000]),
    "nbsp": ("\u00a0", [1, 5, 500]),
    "fffd": ("\ufffd", [1, 5, 500]),
    "ascii-mix": ("aB3_- ./\n", [1, 100, 3000]),
    "prose": ("The patient was stable. ", [1, 100, 2000]),
    "prose-cjk": ("今日は天気がいいですね。", [1, 100, 1000]),
    "html-tag": ("<div class=\"a\">x</div>\n", [1, 100, 1000]),
}

# Long inputs. A tokenizer built on pieces of text can slow down on long
# runs, so the llama4 test skips samples whose name starts with "long/".
LONG_REPEATS = {
    "underscore-200k": ("_", 200_000),
    "space-200k": (" ", 200_000),
    "newline-100k": ("\n", 100_000),
    "ab-100k": ("ab", 100_000),
    "letter-a-200k": ("a", 200_000),
    "space-mark-50k": ("x▁", 50_000),
    "han-100k": ("日", 100_000),
    "emoji-50k": ("😀", 50_000),
    "digits-100k": ("7", 100_000),
    "ascii-mix-60k": ("aB3_- ./\n", 60_000),
    "prose-500k": ("the patient was stable. ", 20_000),
    "cjk-prose-300k": ("今日は天気がいいですね。", 25_000),
}

# Texts with special-token strings from both families. Each encoding sees
# the other family's tokens as ordinary text.
SPECIAL_TEXTS = [
    "<bos>hello<eos>",
    "<|turn>user\nhi<turn|>\n<|turn>model\n",
    "a<|image|>b<|image>c<audio|>d<|audio>e<|video|>",
    "<pad><pad><unk><mask>",
    "<|tool_call>call:f{x:<|\"|>y<|\"|>}<tool_call|>",
    "<|channel>thought\n<channel|>answer",
    "<|begin_of_text|>hi<|end_of_text|>",
    "<|header_start|>user<|header_end|>\n\nHi<|eot|>",
    "<|fim_prefix|>a<|fim_suffix|>b<|fim_middle|>c",
    "<|python_start|>1+1<|python_end|><|python_tag|>",
    "<|reserved_special_token_0|> x <|reserved_special_token_9|>",
    "<|image|><|patch|><|tile_x_separator|><|image_end|>",
    "text <bos> and <|begin_of_text|> inside, then <",
    "<|begin_of_text|><|begin_of_text|>x<eos><eos>",
    "<<bos>> <|turn> <turn|>> <|<bos>|>",
]

# Code point ranges for the random samples: (first, last, weight).
FUZZ_RANGES = [
    (0x20, 0x7E, 30),
    (0x09, 0x0D, 4),
    (0x00A0, 0x024F, 6),
    (0x0370, 0x03FF, 3),
    (0x0400, 0x04FF, 3),
    (0x0590, 0x06FF, 3),
    (0x0900, 0x0DFF, 3),
    (0x0E00, 0x0E7F, 2),
    (0x1100, 0x11FF, 1),
    (0x2000, 0x206F, 4),
    (0x2190, 0x23FF, 2),
    (0x2500, 0x27BF, 2),
    (0x3000, 0x30FF, 4),
    (0x3400, 0x4DBF, 2),
    (0x4E00, 0x9FFF, 8),
    (0xAC00, 0xD7A3, 3),
    (0xE000, 0xF8FF, 1),
    (0xFE00, 0xFE0F, 1),
    (0xFF00, 0xFFEF, 1),
    (0xFFF0, 0xFFFF, 1),
    (0x1F300, 0x1FAFF, 6),
    (0x1F1E6, 0x1F1FF, 1),
    (0x20000, 0x2A6DF, 1),
    (0xE0000, 0xE007F, 1),
    (0xF0000, 0xF00FF, 1),
]

INVISIBLE = re.compile(
    "[\u007f-\u00a0\u00ad\u0600-\u0605\u061c\u06dd\u070f\u180e\u200b-\u200f"
    "\u2028-\u202f\u2060-\u206f\u3000\ufe00-\ufe0f\ufeff\ufff0-\uffff"
    "\ue000-\uf8ff\U000e0000-\U000e0fff\U000f0000-\U0010ffff]"
)


def fetch_wikipedia(lang: str, title: str) -> str:
    query = urllib.parse.urlencode(
        {
            "action": "query",
            "prop": "extracts",
            "explaintext": 1,
            "titles": title,
            "redirects": 1,
            "format": "json",
            "formatversion": 2,
        }
    )
    url = f"https://{lang}.wikipedia.org/w/api.php?{query}"
    cache = os.path.join(ROOT, ".cache", "wikipedia", f"{lang}-{title}.json")
    if os.path.exists(cache):
        with open(cache, encoding="utf-8") as f:
            return json.load(f)
    request = urllib.request.Request(url, headers={"User-Agent": "ai-tokenizer-corpus/1.0"})
    for attempt in range(8):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                extract = json.load(response)["query"]["pages"][0].get("extract", "")
            break
        except urllib.error.HTTPError as error:
            if error.code != 429:
                raise
            time.sleep(2**attempt)
    else:
        raise RuntimeError(f"Wikipedia kept answering 429 for {lang}:{title}")
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    with open(cache, "w", encoding="utf-8") as f:
        json.dump(extract, f, ensure_ascii=False)
    time.sleep(1)
    return extract


def head(text: str, limit: int) -> str:
    return text[:limit]


def escape(match: re.Match) -> str:
    """JSON escapes for invisible characters, so the file stays readable."""
    units = []
    for char in match.group():
        code = ord(char)
        if code < 0x10000:
            units.append(code)
        else:
            code -= 0x10000
            units += [0xD800 + (code >> 10), 0xDC00 + (code & 0x3FF)]
    return "".join(f"\\u{unit:04x}" for unit in units)


def build_fuzz(count: int) -> list[str]:
    rng = random.Random(20261103)
    population = []
    for first, last, weight in FUZZ_RANGES:
        population.extend([(first, last)] * weight)
    samples = []
    for _ in range(count):
        length = int(rng.expovariate(1 / 40)) + 1
        chars = []
        for _ in range(min(length, 400)):
            first, last = rng.choice(population)
            cp = rng.randint(first, last)
            if 0xD800 <= cp <= 0xDFFF:
                cp = 0x20
            chars.append(chr(cp))
            if rng.random() < 0.08:
                chars.append(rng.choice([" ", " ", "\n", "  ", "\t", "'s", "_"]))
        samples.append("".join(chars))
    return samples


def main() -> None:
    samples = []
    for lang, titles in WIKI_TITLES.items():
        for title in titles:
            text = head(fetch_wikipedia(lang, title), WIKI_CHARS)
            assert text, f"no extract for {lang}:{title}"
            samples.append({"name": f"wiki/{lang}/{title}", "text": text})

    for entry in LOCAL_FILES:
        path = entry if os.path.isabs(entry) else os.path.join(ROOT, entry)
        if not os.path.exists(path):
            print(f"skip missing {entry}")
            continue
        with open(path, encoding="utf-8", errors="strict") as f:
            text = head(f.read(), FILE_CHARS)
        samples.append({"name": f"file/{entry}", "text": text})

    for name, text in INLINE.items():
        samples.append({"name": f"inline/{name}", "text": text})
    for name, (unit, counts) in REPEATS.items():
        for times in counts:
            samples.append({"name": f"repeat/{name}-{times}", "unit": unit, "times": times})
    for name, (unit, times) in LONG_REPEATS.items():
        samples.append({"name": f"long/{name}", "unit": unit, "times": times})
    for edge in ["", " ", "a", "\n", "\u00e9", "\U0001f600", "\u0085", "\ufeff", "x\ufeff", "\ufeffx"]:
        samples.append({"name": f"edge/{edge.encode('unicode_escape').decode() or 'empty'}", "text": edge})
    for i, text in enumerate(build_fuzz(400)):
        samples.append({"name": f"fuzz/{i}", "text": text})

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    body = json.dumps(
        {"samples": samples, "special": SPECIAL_TEXTS},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    body = INVISIBLE.sub(escape, body)
    body = body.replace('},{"name"', '},\n{"name"')
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(body + "\n")
    print(f"{len(samples)} samples, {len(body)} bytes -> {OUT}")


main()
