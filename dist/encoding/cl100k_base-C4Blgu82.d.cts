declare namespace cl100k_base_d_exports {
  export { binaryEncoder, name, pat_str, special_tokens, stringEncoder };
}
/**
 * CL100K_BASE encoding
 * Auto-generated - DO NOT EDIT
 *
 * Optimized dual-storage format:
 * - String tokens: 99,475 (JSON.parse for fast init)
 * - Binary tokens: 781 (binary search)
 * - Total tokens: 100,256
 * - Pattern: (?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+
 * - Special tokens: 5
 */
declare const name = "cl100k_base";
declare const pat_str = "(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+";
declare const special_tokens: Record<string, number>;
declare const stringEncoder: Record<string, number>;
declare const binaryEncoder: Array<[Uint8Array, number]>;
//#endregion
export { special_tokens as a, pat_str as i, cl100k_base_d_exports as n, stringEncoder as o, name as r, binaryEncoder as t };