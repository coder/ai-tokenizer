/** The ctok commit that src/encoding/claude_v3.ts and claude_v4_7.ts are ported from. */
export const CTOK_REPO = "https://github.com/sanderland/ctok";
export const CTOK_COMMIT = "8c43ffd3c7be467622a540f025516e49ef78d8b1";
/**
 * ctok leaves `regex` unpinned, and its \p{M} and \p{Alphabetic} tables decide
 * how ctok classifies codepoints that Unicode 15.1 leaves unassigned. This is
 * the version in ctok's uv.lock at CTOK_COMMIT.
 */
export const CTOK_REGEX = "2026.8.31";
