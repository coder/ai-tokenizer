declare namespace p50k_base_d_exports {
  export { binaryEncoder, name, pat_str, special_tokens, stringEncoder };
}
/**
 * P50K_BASE encoding
 * Auto-generated - DO NOT EDIT
 *
 * Optimized dual-storage format:
 * - String tokens: 49,936 (JSON.parse for fast init)
 * - Binary tokens: 344 (binary search)
 * - Total tokens: 50,280
 * - Pattern: 's|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+
 * - Special tokens: 1
 */
declare const name = "p50k_base";
declare const pat_str = "'s|'t|'re|'ve|'m|'ll|'d| ?\\p{L}+| ?\\p{N}+| ?[^\\s\\p{L}\\p{N}]+|\\s+(?!\\S)|\\s+";
declare const special_tokens: Record<string, number>;
declare const stringEncoder: Record<string, number>;
declare const binaryEncoder: Array<[Uint8Array, number]>;
//#endregion
export { special_tokens as a, pat_str as i, name as n, stringEncoder as o, p50k_base_d_exports as r, binaryEncoder as t };