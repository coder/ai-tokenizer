declare namespace claude_d_exports {
  export { binaryEncoder, name, pat_str, special_tokens, stringEncoder };
}
/**
 * CLAUDE encoding
 * Auto-generated - DO NOT EDIT
 *
 * Optimized dual-storage format:
 * - String tokens: 64,241 (JSON.parse for fast init)
 * - Binary tokens: 754 (binary search)
 * - Total tokens: 64,995
 * - Pattern: 's|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+
 * - Special tokens: 5
 */
declare const name = "claude";
declare const pat_str = "'s|'t|'re|'ve|'m|'ll|'d| ?\\p{L}+| ?\\p{N}+| ?[^\\s\\p{L}\\p{N}]+|\\s+(?!\\S)|\\s+";
declare const special_tokens: Record<string, number>;
declare const stringEncoder: Record<string, number>;
declare const binaryEncoder: Array<[Uint8Array, number]>;
//#endregion
export { special_tokens as a, pat_str as i, claude_d_exports as n, stringEncoder as o, name as r, binaryEncoder as t };