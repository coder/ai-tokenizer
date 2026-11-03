"""Export the data that scripts/generate-claude-encodings.ts writes into src/.

Runs inside `uv run --with "ctok @ git+<repo>@<commit>"`. Prints one JSON
document on stdout:

  ctok     the installed ctok version and commit
  unicode  per-codepoint answers of ctok's own predicates (Unicode 15.1)
  escape   codepoints in the pieces that the generator writes as \\u escapes
  families one entry per requested ctok version (pieces, byte prefixes, scalars)

  python scripts/ctok-export.py --commit <sha> 3.0 4.8
"""

import argparse
import importlib
import importlib.metadata
import json
import sys
import unicodedata

from ctok.constants import BOW_G, CAPS_G, EOW_G, MARKER_GLYPHS, SHIFT_G
from ctok.engine import min_tile
from ctok.main import _family, _model, _vocabulary

# The module. ctok/__init__.py exports a function with the same name.
norm = importlib.import_module("ctok.normalize")

ap = argparse.ArgumentParser()
ap.add_argument("--commit", required=True)
ap.add_argument("versions", nargs="+")
args = ap.parse_args()

assert unicodedata.unidata_version == "15.1.0", unicodedata.unidata_version
direct_url = json.loads(importlib.metadata.distribution("ctok").read_text("direct_url.json"))
assert direct_url["vcs_info"]["commit_id"] == args.commit, direct_url

# The runtime reads one 16-bit fact word per BMP codepoint: the stream class in
# the low 3 bits and one bit per predicate below.
CLASSES = {norm.WORDY: 0, norm.HARD: 1, norm.DIGIT: 2, norm.PUNCT: 3, norm.SPACE: 4}
FLAGS = {
    name: 1 << (3 + i)
    for i, name in enumerate(
        ["strayMark", "marksLikePunct", "digitBorder", "nd", "no", "upper", "lower", "unlowerable"]
    )
}


def facts(c: str) -> int:
    cls = norm.classify(c)
    cat = unicodedata.category(c)
    word = CLASSES[cls]
    for name, on in (
        # _runs asks _stray_mark only of WORDY characters.
        ("strayMark", cls == norm.WORDY and norm._stray_mark(c)),
        ("marksLikePunct", norm._marks_like_punct(c)),
        ("digitBorder", norm._digit_border(c)),
        ("nd", cat == "Nd"),
        ("no", cat == "No"),
        ("upper", norm._is_upper(c)),
        ("lower", norm._is_lower(c)),
        # The per-character term of mark_case's `unlowerable`.
        (
            "unlowerable",
            (c in norm._NEW_CASED or cat[0] in ("L", "M"))
            and not norm._is_lower(c)
            and (not norm._is_upper(c) or norm._lower(c) == c),
        ),
    ):
        if on:
            word |= FLAGS[name]
    return word


words = [facts(chr(cp)) for cp in range(0x10000)]
fact_runs = []  # [last codepoint of run, fact word, ...]
for cp in range(1, 0x10001):
    if cp == 0x10000 or words[cp] != words[cp - 1]:
        fact_runs += [cp - 1, words[cp - 1]]

# mark_case never lowers U+0130 (it keeps it literal), and every other
# lowering is one codepoint, so the runtime map is codepoint to codepoint.
lower = []
for cp in range(0x10000):
    c = chr(cp)
    low = norm._lower(c)
    if low != c and cp != 0x130:
        assert len(low) == 1, (hex(cp), low)
        lower += [cp, ord(low)]

for cp in range(0x10000, 0x110000):
    c = chr(cp)
    assert norm.classify(c) == norm.HARD, hex(cp)
    assert not norm._marks_like_punct(c) and not norm._digit_border(c), hex(cp)

assigned = []  # inclusive [first, last, ...] of codepoints assigned in 15.1
start = None
for cp in range(0x110001):
    known = cp < 0x110000 and unicodedata.category(chr(cp)) != "Cn"
    if known and start is None:
        start = cp
    elif not known and start is not None:
        assigned += [start, cp - 1]
        start = None


def escaped(c: str) -> bool:
    """Invisible, line-breaking or marker codepoints, and U+FFFD, which reads as
    a broken file when written literally."""
    cat = unicodedata.category(c)
    return (
        cat in ("Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp")
        or (cat == "Zs" and c != " ")
        or 0xFE00 <= ord(c) <= 0xFE0F
        or 0xE0100 <= ord(c) <= 0xE01EF
        or c == "\ufffd"
    )


families = {}
escape = set()
for version in args.versions:
    key = _family(version)
    model = _model(key)
    pieces = sorted(model.vocab)
    prefixes = sorted(_vocabulary(key)["tokens"]["bytes_fallback"])

    assert all(pieces) and len(set(pieces)) == len(pieces)
    assert "\n" in model.vocab, "the frame tail tiles newlines over the vocabulary"
    for marker in (BOW_G, EOW_G, SHIFT_G):
        assert marker in model.vocab, (key, marker)
    assert (CAPS_G in model.vocab) == (model.allcaps_min is not None), key
    for p in prefixes:
        assert p == p.lower() and len(p) in (4, 6), (key, p)
        bytes.fromhex(p)

    # ctok's byte floor also holds the UTF-8 of every single-codepoint piece.
    # A proper slice of one codepoint's UTF-8 is never a whole codepoint, and
    # the floor only runs for codepoints that are not pieces, so those entries
    # never fire. Check that on every codepoint, then leave them out.
    assert model.bytes.tokens == set(prefixes) | {c.encode().hex() for c in model.unit_pieces}
    floor = set(prefixes)
    max_len = max(len(p) // 2 for p in prefixes)
    for cp in range(0x110000):
        c = chr(cp)
        if 0xD800 <= cp <= 0xDFFF or c in model.unit_pieces or c in MARKER_GLYPHS:
            continue
        bs = c.encode()
        _, spans = min_tile(
            len(bs), lambda j, i: 1 if i - j == 1 or bs[j:i].hex() in floor else None, max_len
        )
        assert [bs[j:i] for j, i in spans] == model.bytes.chunks(bs), hex(cp)

    escape.update(c for p in pieces for c in p if escaped(c))
    families[version] = {
        "family": key,
        "foldQuotes": model.fold_quotes,
        "allcapsMin": model.allcaps_min,
        "frameBow": model.frame_bow,
        "pieces": pieces,
        "bytePrefixes": prefixes,
        "maxPieceLength": max(map(len, pieces)),
    }

json.dump(
    {
        "ctok": {"version": importlib.metadata.version("ctok"), "commit": args.commit},
        "unicode": {
            "version": unicodedata.unidata_version,
            "classes": {name.upper(): value for name, value in CLASSES.items()},
            "flags": FLAGS,
            "facts": fact_runs,
            "lower": lower,
            "assigned": assigned,
        },
        "escape": sorted(ord(c) for c in escape),
        "families": families,
    },
    sys.stdout,
)
