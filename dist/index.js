import { t as __commonJS } from "./chunk-DgxVxUia.js";

//#region \0@oxc-project+runtime@0.95.0/helpers/typeof.js
function _typeof(o) {
	"@babel/helpers - typeof";
	return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o$1) {
		return typeof o$1;
	} : function(o$1) {
		return o$1 && "function" == typeof Symbol && o$1.constructor === Symbol && o$1 !== Symbol.prototype ? "symbol" : typeof o$1;
	}, _typeof(o);
}

//#endregion
//#region \0@oxc-project+runtime@0.95.0/helpers/toPrimitive.js
function toPrimitive(t, r) {
	if ("object" != _typeof(t) || !t) return t;
	var e = t[Symbol.toPrimitive];
	if (void 0 !== e) {
		var i = e.call(t, r || "default");
		if ("object" != _typeof(i)) return i;
		throw new TypeError("@@toPrimitive must return a primitive value.");
	}
	return ("string" === r ? String : Number)(t);
}

//#endregion
//#region \0@oxc-project+runtime@0.95.0/helpers/toPropertyKey.js
function toPropertyKey(t) {
	var i = toPrimitive(t, "string");
	return "symbol" == _typeof(i) ? i : i + "";
}

//#endregion
//#region \0@oxc-project+runtime@0.95.0/helpers/defineProperty.js
function _defineProperty(e, r, t) {
	return (r = toPropertyKey(r)) in e ? Object.defineProperty(e, r, {
		value: t,
		enumerable: !0,
		configurable: !0,
		writable: !0
	}) : e[r] = t, e;
}

//#endregion
//#region src/tokenizer.ts
/**
* Ultra-optimized tokenizer for BPE encodings
*/
var Tokenizer = class {
	constructor(data, extendedSpecialTokens, mergeCacheSize = 1e5) {
		_defineProperty(this, "_name", void 0);
		_defineProperty(this, "patternRegex", void 0);
		_defineProperty(this, "specialTokensRegex", void 0);
		_defineProperty(this, "specialTokens", void 0);
		_defineProperty(this, "inverseSpecialTokens", void 0);
		_defineProperty(this, "stringRankEncoder", void 0);
		_defineProperty(this, "binaryRankEncoder", void 0);
		_defineProperty(this, "_decoder", void 0);
		_defineProperty(this, "_binaryFirstByteIndex", null);
		_defineProperty(this, "specialTokenKeys", void 0);
		_defineProperty(this, "hasSpecialTokens", void 0);
		_defineProperty(this, "mergeCache", void 0);
		_defineProperty(this, "mergeCacheSize", void 0);
		this._name = data.name;
		this.mergeCacheSize = mergeCacheSize;
		this.mergeCache = /* @__PURE__ */ new Map();
		this.stringRankEncoder = data.stringEncoder;
		this.binaryRankEncoder = data.binaryEncoder;
		this._decoder = data.decoder ?? null;
		this.patternRegex = new RegExp(data.pat_str, "ug");
		this.specialTokens = {
			...data.special_tokens,
			...extendedSpecialTokens
		};
		this.specialTokenKeys = Object.keys(this.specialTokens);
		this.hasSpecialTokens = this.specialTokenKeys.length > 0;
		this.specialTokensRegex = this.hasSpecialTokens ? new RegExp(this.specialTokenKeys.map(escapeRegex).join("|"), "g") : null;
		this.inverseSpecialTokens = {};
		for (const [text, rank] of Object.entries(this.specialTokens)) this.inverseSpecialTokens[rank] = textEncoder.encode(text);
	}
	/** Lazy first-byte index — built on first encode that needs binary lookup */
	get binaryFirstByteIndex() {
		if (this._binaryFirstByteIndex === null) {
			const idx = new Array(256).fill(null);
			for (let i = 0; i < this.binaryRankEncoder.length; i++) {
				const entry = this.binaryRankEncoder[i];
				const arr = entry[0];
				if (arr.length === 0) continue;
				const first = arr[0];
				if (idx[first] === null) idx[first] = [];
				idx[first].push(entry);
			}
			this._binaryFirstByteIndex = idx;
		}
		return this._binaryFirstByteIndex;
	}
	/** Lazy decoder — built from encoder on first decode() call */
	get decoder() {
		if (this._decoder === null) {
			const dec = {};
			for (const [str, rank] of Object.entries(this.stringRankEncoder)) dec[rank] = str;
			for (const [bytes, rank] of this.binaryRankEncoder) dec[rank] = bytes;
			this._decoder = dec;
		}
		return this._decoder;
	}
	/**
	* Add to LRU cache - simple approach matching gpt-tokenizer
	*/
	addToMergeCache(key, value) {
		if (this.mergeCache.size >= this.mergeCacheSize) {
			const firstKey = this.mergeCache.keys().next().value;
			this.mergeCache.delete(firstKey);
		}
		this.mergeCache.set(key, value);
	}
	/**
	* Encode a string piece using BPE with caching
	*/
	bytePairEncode(input) {
		const cached = this.mergeCache.get(input);
		if (cached !== void 0) return cached;
		const result = bytePairMerge(textEncoder.encode(input), this.stringRankEncoder, this.binaryFirstByteIndex);
		this.addToMergeCache(input, result);
		return result;
	}
	/**
	* Get encoding name
	*/
	get encodingName() {
		return this._name;
	}
	/**
	* Encode text to tokens (optimized hot path)
	*/
	encode(text, allowedSpecial = [], disallowedSpecial = "all") {
		if (!this.hasSpecialTokens || allowedSpecial === "all") return this.encodeOrdinary(text);
		const result = [];
		const allowedSet = new Set(allowedSpecial === "all" ? this.specialTokenKeys : allowedSpecial);
		const disallowedSet = new Set(disallowedSpecial === "all" ? this.specialTokenKeys.filter((x) => !allowedSet.has(x)) : disallowedSpecial);
		if (disallowedSet.size > 0) {
			const disallowedRegex = new RegExp([...disallowedSet].map(escapeRegex).join("|"), "g");
			const match = text.match(disallowedRegex);
			if (match) throw new Error(`Text contains disallowed special token: ${match[0]}`);
		}
		let start = 0;
		const specialRegex = this.specialTokensRegex;
		while (start < text.length) {
			let nextSpecial = null;
			let startFind = start;
			while (true) {
				specialRegex.lastIndex = startFind;
				nextSpecial = specialRegex.exec(text);
				if (!nextSpecial || allowedSet.has(nextSpecial[0])) break;
				startFind = nextSpecial.index + 1;
			}
			const end = nextSpecial?.index ?? text.length;
			this.encodeOrdinaryInto(text.substring(start, end), result);
			if (!nextSpecial) break;
			result.push(this.specialTokens[nextSpecial[0]]);
			start = nextSpecial.index + nextSpecial[0].length;
		}
		return result;
	}
	/**
	* Encode ordinary text (no special tokens) - ultra-optimized hot path
	*/
	encodeOrdinary(text) {
		if (text.length < 10) {
			const direct = this.stringRankEncoder[text];
			if (direct !== void 0) return [direct];
		}
		const result = [];
		const regex = this.patternRegex;
		regex.lastIndex = 0;
		let m;
		while ((m = regex.exec(text)) !== null) {
			const piece = m[0];
			const directRank = this.stringRankEncoder[piece];
			if (directRank !== void 0) {
				result.push(directRank);
				continue;
			}
			const cached = this.mergeCache.get(piece);
			if (cached !== void 0) {
				for (let i = 0; i < cached.length; i++) result.push(cached[i]);
				continue;
			}
			const tokens = bytePairMerge(textEncoder.encode(piece), this.stringRankEncoder, this.binaryFirstByteIndex);
			this.addToMergeCache(piece, tokens);
			for (let i = 0; i < tokens.length; i++) result.push(tokens[i]);
		}
		return result;
	}
	/**
	* Encode ordinary text into existing array (used by special token handling)
	*/
	encodeOrdinaryInto(text, result) {
		const regex = this.patternRegex;
		regex.lastIndex = 0;
		let m;
		while ((m = regex.exec(text)) !== null) {
			const piece = m[0];
			const directRank = this.stringRankEncoder[piece];
			if (directRank !== void 0) {
				result.push(directRank);
				continue;
			}
			const tokens = this.bytePairEncode(piece);
			for (let i = 0; i < tokens.length; i++) result.push(tokens[i]);
		}
	}
	/**
	* Decode tokens to text (optimized - handles strings directly)
	*/
	decode(tokens) {
		let result = "";
		let byteBuffer = null;
		let bufferSize = 0;
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			const value = this.decoder[token] ?? this.inverseSpecialTokens[token];
			if (value === void 0) continue;
			if (typeof value === "string") {
				if (byteBuffer !== null) {
					result += textDecoder.decode(byteBuffer.subarray(0, bufferSize));
					byteBuffer = null;
					bufferSize = 0;
				}
				result += value;
			} else {
				if (byteBuffer === null) byteBuffer = new Uint8Array(1024);
				if (bufferSize + value.length > byteBuffer.length) {
					const newBuffer = new Uint8Array(Math.max(byteBuffer.length * 2, bufferSize + value.length));
					newBuffer.set(byteBuffer.subarray(0, bufferSize));
					byteBuffer = newBuffer;
				}
				byteBuffer.set(value, bufferSize);
				bufferSize += value.length;
			}
		}
		if (byteBuffer !== null && bufferSize > 0) result += textDecoder.decode(byteBuffer.subarray(0, bufferSize));
		return result;
	}
	/**
	* Count tokens in text
	*/
	count(input) {
		return this.encode(input).length;
	}
};
const NO_RANK = 4294967295;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");
/**
* Fast UTF-8 validation without try/catch overhead
* Based on gpt-tokenizer's implementation
*/
function isValidUTF8(bytes) {
	let i = 0;
	while (i < bytes.length) {
		const byte1 = bytes[i];
		let numBytes = 0;
		let codePoint = 0;
		if (byte1 <= 127) {
			numBytes = 1;
			codePoint = byte1;
		} else if ((byte1 & 224) === 192) {
			numBytes = 2;
			codePoint = byte1 & 31;
			if (byte1 <= 193) return false;
		} else if ((byte1 & 240) === 224) {
			numBytes = 3;
			codePoint = byte1 & 15;
		} else if ((byte1 & 248) === 240) {
			numBytes = 4;
			codePoint = byte1 & 7;
			if (byte1 > 244) return false;
		} else return false;
		if (i + numBytes > bytes.length) return false;
		for (let j = 1; j < numBytes; j++) {
			const byte = bytes[i + j];
			if ((byte & 192) !== 128) return false;
			codePoint = codePoint << 6 | byte & 63;
		}
		if (numBytes === 2 && codePoint < 128) return false;
		if (numBytes === 3 && codePoint < 2048) return false;
		if (numBytes === 4 && codePoint < 65536) return false;
		if (codePoint >= 55296 && codePoint <= 57343) return false;
		if (codePoint > 1114111) return false;
		i += numBytes;
	}
	return true;
}
/**
* Try to convert bytes to UTF-8 string (optimized, no try/catch)
*/
function tryBytesToString(bytes) {
	if (!isValidUTF8(bytes)) return;
	return textDecoder.decode(bytes);
}
/**
* Binary search on sorted byte array pairs
*/
function binarySearchBytes(sortedArray, key) {
	let low = 0;
	let high = sortedArray.length - 1;
	while (low <= high) {
		const mid = low + high >>> 1;
		const midKey = sortedArray[mid][0];
		let cmp = 0;
		const maxLen = Math.min(midKey.length, key.length);
		for (let i = 0; i < maxLen; i++) {
			cmp = midKey[i] - key[i];
			if (cmp !== 0) break;
		}
		if (cmp === 0) cmp = midKey.length - key.length;
		if (cmp === 0) return sortedArray[mid][1];
		if (cmp < 0) low = mid + 1;
		else high = mid - 1;
	}
	return -1;
}
/**
* Escape regex special characters
*/
function escapeRegex(str) {
	return str.replace(/[\\^$*+?.()|[\]{}]/g, "\\$&");
}
/**
* Hyper-optimized BPE merge
* Matches gpt-tokenizer's approach exactly but with our optimizations
*/
function bytePairMerge(piece, stringRanks, binaryFirstByteIndex) {
	const len = piece.length;
	const getRankForSlice = (slice) => {
		const asString = tryBytesToString(slice);
		if (asString !== void 0) {
			const rank = stringRanks[asString];
			if (rank !== void 0) return rank;
		}
		const bucket = binaryFirstByteIndex[slice[0]];
		if (bucket !== null) {
			const rank = binarySearchBytes(bucket, slice);
			if (rank !== -1) return rank;
		}
		return NO_RANK;
	};
	const starts = [];
	const ranks = [];
	const getRank = (startIndex, pairStart, pairEnd) => {
		if (pairStart === void 0) pairStart = starts[startIndex];
		if (pairEnd === void 0) pairEnd = starts[startIndex + 2];
		if (pairEnd === void 0) return NO_RANK;
		return getRankForSlice(piece.subarray(pairStart, pairEnd));
	};
	for (let i = 0; i <= len; i++) {
		starts[i] = i;
		if (i < len - 1) ranks[i] = getRank(i, i, i + 2);
		else ranks[i] = NO_RANK;
	}
	while (starts.length > 1) {
		let minRank = NO_RANK;
		let minIdx = -1;
		const ranksLen = ranks.length - 1;
		for (let i = 0; i < ranksLen; i++) {
			const rank = ranks[i];
			if (rank < minRank) {
				minRank = rank;
				minIdx = i;
			}
		}
		if (minRank === NO_RANK || minIdx === -1) break;
		starts.splice(minIdx + 1, 1);
		ranks.splice(minIdx, 1);
		ranks[minIdx] = getRank(minIdx);
		if (minIdx > 0) ranks[minIdx - 1] = getRank(minIdx - 1);
	}
	const output = [];
	for (let i = 0; i < starts.length - 1; i++) {
		const pairStart = starts[i];
		const pairEnd = starts[i + 1];
		const rank = getRankForSlice(piece.subarray(pairStart, pairEnd));
		if (rank !== NO_RANK) output.push(rank);
	}
	return output;
}

//#endregion
//#region src/models.json
var require_models = /* @__PURE__ */ __commonJS({ "src/models.json": ((exports, module) => {
	module.exports = {
		"anthropic/claude-3-haiku": {
			"encoding": "claude",
			"tokens": {
				"contentMultiplier": 1.1,
				"baseOverhead": 6,
				"perMessage": 2,
				"toolsExist": 317,
				"perTool": 53,
				"perDesc": 5,
				"perFirstProp": 13,
				"perAdditionalProp": 12,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 12,
				"perArrayOfObjects": 13
			},
			"name": "Claude 3 Haiku",
			"contextWindow": 2e5,
			"maxTokens": 4096,
			"pricing": {
				"input": 25e-8,
				"output": 125e-8,
				"input_cache_read": 3e-8,
				"input_cache_write": 3e-7
			}
		},
		"anthropic/claude-3-opus": {
			"encoding": "claude",
			"tokens": {
				"contentMultiplier": 1.1,
				"baseOverhead": 6,
				"perMessage": 2,
				"toolsExist": 586,
				"perTool": 53,
				"perDesc": 5,
				"perFirstProp": 13,
				"perAdditionalProp": 12,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 12,
				"perArrayOfObjects": 13
			},
			"name": "Claude 3 Opus",
			"contextWindow": 2e5,
			"maxTokens": 4096,
			"pricing": {
				"input": 15e-6,
				"output": 75e-6,
				"input_cache_read": 15e-7,
				"input_cache_write": 1875e-8
			}
		},
		"anthropic/claude-3.5-haiku": {
			"encoding": "claude",
			"tokens": {
				"contentMultiplier": 1.1,
				"baseOverhead": 6,
				"perMessage": 2,
				"toolsExist": 317,
				"perTool": 53,
				"perDesc": 5,
				"perFirstProp": 13,
				"perAdditionalProp": 12,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 12,
				"perArrayOfObjects": 13
			},
			"name": "Claude 3.5 Haiku",
			"contextWindow": 2e5,
			"maxTokens": 8192,
			"pricing": {
				"input": 8e-7,
				"output": 4e-6,
				"input_cache_read": 8e-8,
				"input_cache_write": 1e-6
			}
		},
		"anthropic/claude-3.5-sonnet": {
			"encoding": "claude",
			"tokens": {
				"contentMultiplier": 1.1,
				"baseOverhead": 6,
				"perMessage": 2,
				"toolsExist": 366,
				"perTool": 53,
				"perDesc": 5,
				"perFirstProp": 13,
				"perAdditionalProp": 12,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 12,
				"perArrayOfObjects": 13
			},
			"name": "Claude 3.5 Sonnet",
			"contextWindow": 2e5,
			"maxTokens": 8192,
			"pricing": {
				"input": 3e-6,
				"output": 15e-6,
				"input_cache_read": 3e-7,
				"input_cache_write": 375e-8
			}
		},
		"anthropic/claude-3.5-sonnet-20240620": {
			"encoding": "claude",
			"tokens": {
				"contentMultiplier": 1.1,
				"baseOverhead": 6,
				"perMessage": 2,
				"toolsExist": 347,
				"perTool": 53,
				"perDesc": 5,
				"perFirstProp": 13,
				"perAdditionalProp": 12,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 12,
				"perArrayOfObjects": 13
			},
			"name": "Claude 3.5 Sonnet (2024-06-20)",
			"contextWindow": 2e5,
			"maxTokens": 8192,
			"pricing": {
				"input": 3e-6,
				"output": 15e-6
			}
		},
		"anthropic/claude-3.7-sonnet": {
			"encoding": "claude",
			"tokens": {
				"contentMultiplier": 1.1,
				"baseOverhead": 6,
				"perMessage": 2,
				"toolsExist": 366,
				"perTool": 53,
				"perDesc": 5,
				"perFirstProp": 13,
				"perAdditionalProp": 12,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 12,
				"perArrayOfObjects": 13
			},
			"name": "Claude 3.7 Sonnet",
			"contextWindow": 2e5,
			"maxTokens": 64e3,
			"pricing": {
				"input": 3e-6,
				"output": 15e-6,
				"input_cache_read": 3e-7,
				"input_cache_write": 375e-8
			}
		},
		"anthropic/claude-opus-4": {
			"encoding": "claude",
			"tokens": {
				"contentMultiplier": 1.1,
				"baseOverhead": 6,
				"perMessage": 2,
				"toolsExist": 366,
				"perTool": 53,
				"perDesc": 5,
				"perFirstProp": 13,
				"perAdditionalProp": 12,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 12,
				"perArrayOfObjects": 13
			},
			"name": "Claude Opus 4",
			"contextWindow": 2e5,
			"maxTokens": 32e3,
			"pricing": {
				"input": 15e-6,
				"output": 75e-6,
				"input_cache_read": 15e-7,
				"input_cache_write": 1875e-8
			}
		},
		"anthropic/claude-opus-4.1": {
			"encoding": "claude",
			"tokens": {
				"contentMultiplier": 1.1,
				"baseOverhead": 6,
				"perMessage": 2,
				"toolsExist": 366,
				"perTool": 53,
				"perDesc": 5,
				"perFirstProp": 13,
				"perAdditionalProp": 12,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 12,
				"perArrayOfObjects": 13
			},
			"name": "Claude Opus 4.1",
			"contextWindow": 2e5,
			"maxTokens": 32e3,
			"pricing": {
				"input": 15e-6,
				"output": 75e-6,
				"input_cache_read": 15e-7,
				"input_cache_write": 1875e-8
			}
		},
		"anthropic/claude-sonnet-4": {
			"encoding": "claude",
			"tokens": {
				"contentMultiplier": 1.1,
				"baseOverhead": 6,
				"perMessage": 2,
				"toolsExist": 366,
				"perTool": 53,
				"perDesc": 5,
				"perFirstProp": 13,
				"perAdditionalProp": 12,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 12,
				"perArrayOfObjects": 13
			},
			"name": "Claude Sonnet 4",
			"contextWindow": 2e5,
			"maxTokens": 64e3,
			"pricing": {
				"input": 3e-6,
				"output": 15e-6,
				"input_cache_read": 3e-7,
				"input_cache_write": 375e-8
			}
		},
		"anthropic/claude-sonnet-4.5": {
			"encoding": "claude",
			"tokens": {
				"contentMultiplier": 1.1,
				"baseOverhead": 6,
				"perMessage": 2,
				"toolsExist": 549,
				"perTool": 53,
				"perDesc": 5,
				"perFirstProp": 13,
				"perAdditionalProp": 12,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 12,
				"perArrayOfObjects": 13
			},
			"name": "Claude Sonnet 4.5",
			"contextWindow": 2e5,
			"maxTokens": 64e3,
			"pricing": {
				"input": 3e-6,
				"output": 15e-6,
				"input_cache_read": 3e-7,
				"input_cache_write": 375e-8
			}
		},
		"openai/gpt-4-turbo": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 6,
				"perMessage": 3,
				"toolsExist": 16,
				"perTool": 6,
				"perDesc": 2,
				"perFirstProp": 5,
				"perAdditionalProp": 3,
				"perPropDesc": 3,
				"perEnum": 7,
				"perNestedObject": -3,
				"perArrayOfObjects": 1
			},
			"name": "GPT-4 Turbo",
			"contextWindow": 128e3,
			"maxTokens": 4096,
			"pricing": {
				"input": 1e-5,
				"output": 3e-5
			}
		},
		"openai/gpt-4.1": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 6,
				"perMessage": 3,
				"toolsExist": 16,
				"perTool": 6,
				"perDesc": 1,
				"perFirstProp": 5,
				"perAdditionalProp": 3,
				"perPropDesc": 2,
				"perEnum": 7,
				"perNestedObject": -3,
				"perArrayOfObjects": 1
			},
			"name": "GPT-4.1",
			"contextWindow": 1047576,
			"maxTokens": 32768,
			"pricing": {
				"input": 2e-6,
				"output": 8e-6,
				"input_cache_read": 5e-7,
				"input_cache_write": 0
			}
		},
		"openai/gpt-4.1-mini": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 6,
				"perMessage": 3,
				"toolsExist": 16,
				"perTool": 6,
				"perDesc": 1,
				"perFirstProp": 5,
				"perAdditionalProp": 3,
				"perPropDesc": 2,
				"perEnum": 7,
				"perNestedObject": -3,
				"perArrayOfObjects": 1
			},
			"name": "GPT-4.1 mini",
			"contextWindow": 1047576,
			"maxTokens": 32768,
			"pricing": {
				"input": 4e-7,
				"output": 16e-7,
				"input_cache_read": 1e-7,
				"input_cache_write": 0
			}
		},
		"openai/gpt-4o": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 6,
				"perMessage": 3,
				"toolsExist": 16,
				"perTool": 6,
				"perDesc": 1,
				"perFirstProp": 5,
				"perAdditionalProp": 3,
				"perPropDesc": 2,
				"perEnum": 7,
				"perNestedObject": -3,
				"perArrayOfObjects": 1
			},
			"name": "GPT-4o",
			"contextWindow": 128e3,
			"maxTokens": 16384,
			"pricing": {
				"input": 25e-7,
				"output": 1e-5,
				"input_cache_read": 125e-8,
				"input_cache_write": 0
			}
		},
		"openai/gpt-4o-mini": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 6,
				"perMessage": 3,
				"toolsExist": 16,
				"perTool": 6,
				"perDesc": 1,
				"perFirstProp": 5,
				"perAdditionalProp": 3,
				"perPropDesc": 2,
				"perEnum": 7,
				"perNestedObject": -3,
				"perArrayOfObjects": 1
			},
			"name": "GPT-4o mini",
			"contextWindow": 128e3,
			"maxTokens": 16384,
			"pricing": {
				"input": 15e-8,
				"output": 6e-7,
				"input_cache_read": 75e-9,
				"input_cache_write": 0
			}
		},
		"openai/gpt-5": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 5,
				"perMessage": 4,
				"toolsExist": 24,
				"perTool": 6,
				"perDesc": 2,
				"perFirstProp": 5,
				"perAdditionalProp": 3,
				"perPropDesc": 2,
				"perEnum": 7,
				"perNestedObject": -3,
				"perArrayOfObjects": 1
			},
			"name": "GPT-5",
			"contextWindow": 4e5,
			"maxTokens": 128e3,
			"pricing": {
				"input": 125e-8,
				"output": 1e-5,
				"input_cache_read": 13e-8,
				"input_cache_write": 0
			}
		},
		"openai/gpt-5-mini": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 5,
				"perMessage": 4,
				"toolsExist": 21,
				"perTool": 6,
				"perDesc": 2,
				"perFirstProp": 5,
				"perAdditionalProp": 3,
				"perPropDesc": 2,
				"perEnum": 7,
				"perNestedObject": -3,
				"perArrayOfObjects": 1
			},
			"name": "GPT-5 mini",
			"contextWindow": 4e5,
			"maxTokens": 128e3,
			"pricing": {
				"input": 25e-8,
				"output": 2e-6,
				"input_cache_read": 3e-8,
				"input_cache_write": 0
			}
		},
		"openai/gpt-5-nano": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 5,
				"perMessage": 4,
				"toolsExist": 21,
				"perTool": 6,
				"perDesc": 2,
				"perFirstProp": 5,
				"perAdditionalProp": 3,
				"perPropDesc": 2,
				"perEnum": 7,
				"perNestedObject": -3,
				"perArrayOfObjects": 1
			},
			"name": "GPT-5 nano",
			"contextWindow": 4e5,
			"maxTokens": 128e3,
			"pricing": {
				"input": 5e-8,
				"output": 4e-7,
				"input_cache_read": 1e-8,
				"input_cache_write": 0
			}
		},
		"openai/gpt-oss-120b": {
			"encoding": "p50k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 66,
				"perMessage": 4,
				"toolsExist": 40,
				"perTool": 9,
				"perDesc": 1,
				"perFirstProp": 3,
				"perAdditionalProp": 3,
				"perPropDesc": 1,
				"perEnum": 6,
				"perNestedObject": 11,
				"perArrayOfObjects": 9
			},
			"name": "gpt-oss-120b",
			"contextWindow": 131072,
			"maxTokens": 131072,
			"pricing": {
				"input": 1e-7,
				"output": 5e-7
			}
		},
		"openai/gpt-oss-20b": {
			"encoding": "p50k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 68,
				"perMessage": 4,
				"toolsExist": 38,
				"perTool": 9,
				"perDesc": -1,
				"perFirstProp": 3,
				"perAdditionalProp": 3,
				"perPropDesc": 1,
				"perEnum": 6,
				"perNestedObject": 11,
				"perArrayOfObjects": 9
			},
			"name": "gpt-oss-20b",
			"contextWindow": 128e3,
			"maxTokens": 8192,
			"pricing": {
				"input": 7e-8,
				"output": 3e-7
			}
		},
		"openai/o1": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 5,
				"perMessage": 3,
				"toolsExist": 19,
				"perTool": 6,
				"perDesc": -28,
				"perFirstProp": 5,
				"perAdditionalProp": 3,
				"perPropDesc": 2,
				"perEnum": 7,
				"perNestedObject": -3,
				"perArrayOfObjects": 1
			},
			"name": "o1",
			"contextWindow": 2e5,
			"maxTokens": 1e5,
			"pricing": {
				"input": 15e-6,
				"output": 6e-5,
				"input_cache_read": 75e-7,
				"input_cache_write": 0
			}
		},
		"openai/o3": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 5,
				"perMessage": 4,
				"toolsExist": 19,
				"perTool": 6,
				"perDesc": 1,
				"perFirstProp": 5,
				"perAdditionalProp": 3,
				"perPropDesc": 2,
				"perEnum": 7,
				"perNestedObject": -3,
				"perArrayOfObjects": 1
			},
			"name": "o3",
			"contextWindow": 2e5,
			"maxTokens": 1e5,
			"pricing": {
				"input": 2e-6,
				"output": 8e-6,
				"input_cache_read": 5e-7,
				"input_cache_write": 0
			}
		},
		"openai/o3-mini": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 5,
				"perMessage": 3,
				"toolsExist": 19,
				"perTool": 6,
				"perDesc": 1,
				"perFirstProp": 5,
				"perAdditionalProp": 3,
				"perPropDesc": 2,
				"perEnum": 7,
				"perNestedObject": -3,
				"perArrayOfObjects": 1
			},
			"name": "o3-mini",
			"contextWindow": 2e5,
			"maxTokens": 1e5,
			"pricing": {
				"input": 11e-7,
				"output": 44e-7,
				"input_cache_read": 55e-8,
				"input_cache_write": 0
			}
		},
		"openai/o4-mini": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 5,
				"perMessage": 4,
				"toolsExist": 19,
				"perTool": 6,
				"perDesc": 1,
				"perFirstProp": 5,
				"perAdditionalProp": 3,
				"perPropDesc": 2,
				"perEnum": 7,
				"perNestedObject": -3,
				"perArrayOfObjects": 1
			},
			"name": "o4-mini",
			"contextWindow": 2e5,
			"maxTokens": 1e5,
			"pricing": {
				"input": 11e-7,
				"output": 44e-7,
				"input_cache_read": 275e-9,
				"input_cache_write": 0
			}
		},
		"xai/grok-2": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 5,
				"perMessage": 3,
				"toolsExist": 107,
				"perTool": 35,
				"perDesc": 3,
				"perFirstProp": 8,
				"perAdditionalProp": 7,
				"perPropDesc": 3,
				"perEnum": 6,
				"perNestedObject": 9,
				"perArrayOfObjects": 10
			},
			"name": "Grok 2",
			"contextWindow": 131072,
			"maxTokens": 4e3,
			"pricing": {
				"input": 2e-6,
				"output": 1e-5
			}
		},
		"xai/grok-2-vision": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 5,
				"perMessage": 3,
				"toolsExist": 107,
				"perTool": 35,
				"perDesc": 3,
				"perFirstProp": 8,
				"perAdditionalProp": 7,
				"perPropDesc": 3,
				"perEnum": 6,
				"perNestedObject": 9,
				"perArrayOfObjects": 10
			},
			"name": "Grok 2 Vision",
			"contextWindow": 32768,
			"maxTokens": 32768,
			"pricing": {
				"input": 2e-6,
				"output": 1e-5
			}
		},
		"xai/grok-3": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 5,
				"perMessage": 3,
				"toolsExist": 240,
				"perTool": 32,
				"perDesc": 3,
				"perFirstProp": 9,
				"perAdditionalProp": 7,
				"perPropDesc": 3,
				"perEnum": 6,
				"perNestedObject": 7,
				"perArrayOfObjects": 8
			},
			"name": "Grok 3 Beta",
			"contextWindow": 131072,
			"maxTokens": 131072,
			"pricing": {
				"input": 3e-6,
				"output": 15e-6
			}
		},
		"xai/grok-3-fast": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 5,
				"perMessage": 3,
				"toolsExist": 240,
				"perTool": 32,
				"perDesc": 3,
				"perFirstProp": 9,
				"perAdditionalProp": 7,
				"perPropDesc": 3,
				"perEnum": 6,
				"perNestedObject": 7,
				"perArrayOfObjects": 8
			},
			"name": "Grok 3 Fast Beta",
			"contextWindow": 131072,
			"maxTokens": 131072,
			"pricing": {
				"input": 5e-6,
				"output": 25e-6
			}
		},
		"xai/grok-3-mini": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 6,
				"perMessage": 3,
				"toolsExist": 262,
				"perTool": 32,
				"perDesc": 3,
				"perFirstProp": 9,
				"perAdditionalProp": 7,
				"perPropDesc": 3,
				"perEnum": 6,
				"perNestedObject": 7,
				"perArrayOfObjects": 8
			},
			"name": "Grok 3 Mini Beta",
			"contextWindow": 131072,
			"maxTokens": 131072,
			"pricing": {
				"input": 3e-7,
				"output": 5e-7
			}
		},
		"xai/grok-3-mini-fast": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 6,
				"perMessage": 3,
				"toolsExist": 262,
				"perTool": 32,
				"perDesc": 3,
				"perFirstProp": 9,
				"perAdditionalProp": 7,
				"perPropDesc": 3,
				"perEnum": 6,
				"perNestedObject": 7,
				"perArrayOfObjects": 8
			},
			"name": "Grok 3 Mini Fast Beta",
			"contextWindow": 131072,
			"maxTokens": 131072,
			"pricing": {
				"input": 6e-7,
				"output": 4e-6
			}
		},
		"xai/grok-4": {
			"encoding": "p50k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 683,
				"perMessage": 3,
				"toolsExist": 187,
				"perTool": 32,
				"perDesc": 3,
				"perFirstProp": 9,
				"perAdditionalProp": 7,
				"perPropDesc": 3,
				"perEnum": 6,
				"perNestedObject": 7,
				"perArrayOfObjects": 8
			},
			"name": "Grok 4",
			"contextWindow": 256e3,
			"maxTokens": 256e3,
			"pricing": {
				"input": 3e-6,
				"output": 15e-6
			}
		},
		"xai/grok-4-fast-non-reasoning": {
			"encoding": "p50k_base",
			"tokens": {
				"contentMultiplier": 1.99,
				"baseOverhead": 167,
				"perMessage": 3,
				"toolsExist": 185,
				"perTool": 32,
				"perDesc": 3,
				"perFirstProp": 9,
				"perAdditionalProp": 7,
				"perPropDesc": 3,
				"perEnum": 6,
				"perNestedObject": 7,
				"perArrayOfObjects": 8
			},
			"name": "Grok 4 Fast Non-Reasoning",
			"contextWindow": 2e6,
			"maxTokens": 256e3,
			"pricing": {
				"input": 2e-7,
				"output": 5e-7,
				"input_cache_read": 5e-8
			}
		},
		"xai/grok-4-fast-reasoning": {
			"encoding": "p50k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 155,
				"perMessage": 3,
				"toolsExist": 186,
				"perTool": 32,
				"perDesc": 3,
				"perFirstProp": 9,
				"perAdditionalProp": 7,
				"perPropDesc": 3,
				"perEnum": 6,
				"perNestedObject": 7,
				"perArrayOfObjects": 8
			},
			"name": "Grok 4 Fast Reasoning",
			"contextWindow": 2e6,
			"maxTokens": 256e3,
			"pricing": {
				"input": 2e-7,
				"output": 5e-7,
				"input_cache_read": 5e-8
			}
		},
		"xai/grok-code-fast-1": {
			"encoding": "p50k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 203,
				"perMessage": 61,
				"toolsExist": 167,
				"perTool": 37,
				"perDesc": 3,
				"perFirstProp": 9,
				"perAdditionalProp": 7,
				"perPropDesc": 3,
				"perEnum": 6,
				"perNestedObject": 7,
				"perArrayOfObjects": 8
			},
			"name": "Grok Code Fast 1",
			"contextWindow": 256e3,
			"maxTokens": 256e3,
			"pricing": {
				"input": 2e-7,
				"output": 15e-7,
				"input_cache_read": 2e-8
			}
		},
		"alibaba/qwen-3-14b": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 7,
				"perMessage": 4,
				"toolsExist": 138,
				"perTool": 56,
				"perDesc": 0,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 9,
				"perArrayOfObjects": 11
			},
			"name": "Qwen3-14B",
			"contextWindow": 40960,
			"maxTokens": 16384,
			"pricing": {
				"input": 6e-8,
				"output": 24e-8
			}
		},
		"alibaba/qwen-3-235b": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 7,
				"perMessage": 4,
				"toolsExist": 142,
				"perTool": 60,
				"perDesc": 0,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 10,
				"perArrayOfObjects": 11
			},
			"name": "Qwen3 235B A22B Instruct 2507",
			"contextWindow": 40960,
			"maxTokens": 16384,
			"pricing": {
				"input": 13e-8,
				"output": 6e-7
			}
		},
		"alibaba/qwen-3-30b": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 7,
				"perMessage": 4,
				"toolsExist": 138,
				"perTool": 56,
				"perDesc": 0,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 9,
				"perArrayOfObjects": 11
			},
			"name": "Qwen3-30B-A3B",
			"contextWindow": 40960,
			"maxTokens": 16384,
			"pricing": {
				"input": 8e-8,
				"output": 29e-8
			}
		},
		"alibaba/qwen-3-32b": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 7,
				"perMessage": 4,
				"toolsExist": 137,
				"perTool": 55,
				"perDesc": 1,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 10,
				"perArrayOfObjects": 11
			},
			"name": "Qwen 3.32B",
			"contextWindow": 40960,
			"maxTokens": 16384,
			"pricing": {
				"input": 1e-7,
				"output": 3e-7
			}
		},
		"alibaba/qwen3-coder": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 7,
				"perMessage": 4,
				"toolsExist": 229,
				"perTool": 24,
				"perDesc": -1,
				"perFirstProp": 27,
				"perAdditionalProp": 22,
				"perPropDesc": 6,
				"perEnum": 12,
				"perNestedObject": -9,
				"perArrayOfObjects": -16
			},
			"name": "Qwen3 Coder 480B A35B Instruct",
			"contextWindow": 262144,
			"maxTokens": 66536,
			"pricing": {
				"input": 38e-8,
				"output": 153e-8
			}
		},
		"alibaba/qwen3-coder-plus": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 7,
				"perMessage": 4,
				"toolsExist": 260,
				"perTool": 52,
				"perDesc": -1,
				"perFirstProp": 27,
				"perAdditionalProp": 22,
				"perPropDesc": 6,
				"perEnum": 12,
				"perNestedObject": -9,
				"perArrayOfObjects": -15
			},
			"name": "Qwen3 Coder Plus",
			"contextWindow": 1e6,
			"maxTokens": 65536,
			"pricing": {
				"input": 1e-6,
				"output": 5e-6
			}
		},
		"alibaba/qwen3-max": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 7,
				"perMessage": 4,
				"toolsExist": 245,
				"perTool": 56,
				"perDesc": 0,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 10,
				"perArrayOfObjects": 11
			},
			"name": "Qwen3 Max",
			"contextWindow": 262144,
			"maxTokens": 32768,
			"pricing": {
				"input": 12e-7,
				"output": 6e-6,
				"input_cache_read": 24e-8
			}
		},
		"alibaba/qwen3-next-80b-a3b-instruct": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 7,
				"perMessage": 4,
				"toolsExist": 138,
				"perTool": 56,
				"perDesc": 0,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 10,
				"perArrayOfObjects": 11
			},
			"name": "Qwen3 Next 80B A3B Instruct",
			"contextWindow": 65536,
			"maxTokens": 65536,
			"pricing": {
				"input": 15e-8,
				"output": 15e-7
			}
		},
		"alibaba/qwen3-next-80b-a3b-thinking": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 9,
				"perMessage": 4,
				"toolsExist": 133,
				"perTool": 51,
				"perDesc": 0,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 9,
				"perArrayOfObjects": 11
			},
			"name": "Qwen3 Next 80B A3B Thinking",
			"contextWindow": 65536,
			"maxTokens": 65536,
			"pricing": {
				"input": 15e-8,
				"output": 15e-7
			}
		},
		"alibaba/qwen3-vl-instruct": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 7,
				"perMessage": 4,
				"toolsExist": 137,
				"perTool": 55,
				"perDesc": 1,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 10,
				"perArrayOfObjects": 11
			},
			"name": "Qwen3 VL 235B A22B Instruct",
			"contextWindow": 131072,
			"maxTokens": 129024,
			"pricing": {
				"input": 7e-7,
				"output": 28e-7
			}
		},
		"amazon/nova-lite": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": -1,
				"perMessage": 2,
				"toolsExist": 394,
				"perTool": 41,
				"perDesc": 5,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 10,
				"perArrayOfObjects": 11
			},
			"name": "Nova Lite",
			"contextWindow": 3e5,
			"maxTokens": 8192,
			"pricing": {
				"input": 6e-8,
				"output": 24e-8
			}
		},
		"amazon/nova-micro": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": -1,
				"perMessage": 2,
				"toolsExist": 394,
				"perTool": 41,
				"perDesc": 5,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 10,
				"perArrayOfObjects": 11
			},
			"name": "Nova Micro",
			"contextWindow": 128e3,
			"maxTokens": 8192,
			"pricing": {
				"input": 35e-9,
				"output": 14e-8
			}
		},
		"amazon/nova-pro": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": -1,
				"perMessage": 2,
				"toolsExist": 394,
				"perTool": 41,
				"perDesc": 5,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 10,
				"perArrayOfObjects": 11
			},
			"name": "Nova Pro",
			"contextWindow": 3e5,
			"maxTokens": 8192,
			"pricing": {
				"input": 8e-7,
				"output": 32e-7
			}
		},
		"deepseek/deepseek-v3": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 5,
				"perMessage": 1,
				"toolsExist": 149,
				"perTool": 71,
				"perDesc": 0,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 10,
				"perArrayOfObjects": 11
			},
			"name": "DeepSeek V3 0324",
			"contextWindow": 163840,
			"maxTokens": 16384,
			"pricing": {
				"input": 77e-8,
				"output": 77e-8
			}
		},
		"deepseek/deepseek-v3.1": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 7,
				"perMessage": 3,
				"toolsExist": 143,
				"perTool": 71,
				"perDesc": 0,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 10,
				"perArrayOfObjects": 11
			},
			"name": "DeepSeek-V3.1",
			"contextWindow": 163840,
			"maxTokens": 128e3,
			"pricing": {
				"input": 3e-7,
				"output": 1e-6
			}
		},
		"deepseek/deepseek-v3.1-terminus": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 4,
				"perMessage": 1,
				"toolsExist": 144,
				"perTool": 43,
				"perDesc": 0,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 10,
				"perArrayOfObjects": 11
			},
			"name": "DeepSeek V3.1 Terminus",
			"contextWindow": 131072,
			"maxTokens": 65536,
			"pricing": {
				"input": 27e-8,
				"output": 1e-6
			}
		},
		"deepseek/deepseek-v3.2-exp": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 3,
				"perMessage": 1,
				"toolsExist": 142,
				"perTool": 42,
				"perDesc": 0,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 9,
				"perArrayOfObjects": 10
			},
			"name": "DeepSeek V3.2 Exp",
			"contextWindow": 163840,
			"maxTokens": 163840,
			"pricing": {
				"input": 27e-8,
				"output": 4e-7
			}
		},
		"deepseek/deepseek-v3.2-exp-thinking": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 3,
				"perMessage": 1,
				"toolsExist": 142,
				"perTool": 42,
				"perDesc": 0,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 9,
				"perArrayOfObjects": 10
			},
			"name": "DeepSeek V3.2 Exp Thinking",
			"contextWindow": 163840,
			"maxTokens": 8192,
			"pricing": {
				"input": 28e-8,
				"output": 42e-8,
				"input_cache_read": 28e-9
			}
		},
		"meituan/longcat-flash-chat": {
			"encoding": "claude",
			"tokens": {
				"contentMultiplier": 1.1,
				"baseOverhead": 9,
				"perMessage": 4,
				"toolsExist": 173,
				"perTool": 42,
				"perDesc": -1,
				"perFirstProp": 8,
				"perAdditionalProp": 8,
				"perPropDesc": -59,
				"perEnum": -3,
				"perNestedObject": 146,
				"perArrayOfObjects": 84
			},
			"name": "LongCat Flash Chat",
			"contextWindow": 128e3,
			"maxTokens": 8192,
			"pricing": {
				"input": 0,
				"output": 0
			}
		},
		"meta/llama-3.1-8b": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 14,
				"perMessage": 4,
				"toolsExist": 193,
				"perTool": 47,
				"perDesc": 1,
				"perFirstProp": 8,
				"perAdditionalProp": 7,
				"perPropDesc": 3,
				"perEnum": 5,
				"perNestedObject": 9,
				"perArrayOfObjects": 10
			},
			"name": "Llama 3.1 8B Instruct",
			"contextWindow": 131e3,
			"maxTokens": 131072,
			"pricing": {
				"input": 5e-8,
				"output": 8e-8
			}
		},
		"meta/llama-4-scout": {
			"encoding": "claude",
			"tokens": {
				"contentMultiplier": 1.1,
				"baseOverhead": 34,
				"perMessage": 4,
				"toolsExist": 532,
				"perTool": 40,
				"perDesc": 1,
				"perFirstProp": 40,
				"perAdditionalProp": 17,
				"perPropDesc": 6,
				"perEnum": 16,
				"perNestedObject": -9,
				"perArrayOfObjects": -8
			},
			"name": "Llama 4 Scout 17B Instruct",
			"contextWindow": 131072,
			"maxTokens": 8192,
			"pricing": {
				"input": 8e-8,
				"output": 3e-7
			}
		},
		"mistral/codestral": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 2,
				"perMessage": 1,
				"toolsExist": 60,
				"perTool": 57,
				"perDesc": 1,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 9,
				"perArrayOfObjects": 11
			},
			"name": "Mistral Codestral",
			"contextWindow": 128e3,
			"maxTokens": 4e3,
			"pricing": {
				"input": 3e-7,
				"output": 9e-7
			}
		},
		"mistral/devstral-small": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 2,
				"perMessage": 1,
				"toolsExist": 60,
				"perTool": 57,
				"perDesc": 1,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 9,
				"perArrayOfObjects": 11
			},
			"name": "Devstral Small",
			"contextWindow": 128e3,
			"maxTokens": 64e3,
			"pricing": {
				"input": 1e-7,
				"output": 3e-7
			}
		},
		"mistral/magistral-medium": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 2,
				"perMessage": 1,
				"toolsExist": 60,
				"perTool": 57,
				"perDesc": 1,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 9,
				"perArrayOfObjects": 11
			},
			"name": "Magistral Medium 2509",
			"contextWindow": 128e3,
			"maxTokens": 64e3,
			"pricing": {
				"input": 2e-6,
				"output": 5e-6
			}
		},
		"mistral/magistral-small": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 2,
				"perMessage": 1,
				"toolsExist": 60,
				"perTool": 57,
				"perDesc": 1,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 9,
				"perArrayOfObjects": 11
			},
			"name": "Magistral Small 2509",
			"contextWindow": 128e3,
			"maxTokens": 64e3,
			"pricing": {
				"input": 5e-7,
				"output": 15e-7
			}
		},
		"moonshotai/kimi-k2": {
			"encoding": "claude",
			"tokens": {
				"contentMultiplier": 1.1,
				"baseOverhead": 24,
				"perMessage": 3,
				"toolsExist": 67,
				"perTool": 54,
				"perDesc": 1,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 10,
				"perArrayOfObjects": 11
			},
			"name": "Kimi K2",
			"contextWindow": 131072,
			"maxTokens": 16384,
			"pricing": {
				"input": 5e-7,
				"output": 2e-6
			}
		},
		"moonshotai/kimi-k2-0905": {
			"encoding": "claude",
			"tokens": {
				"contentMultiplier": 1.1,
				"baseOverhead": 24,
				"perMessage": 3,
				"toolsExist": 67,
				"perTool": 54,
				"perDesc": 1,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 10,
				"perArrayOfObjects": 11
			},
			"name": "Kimi K2 0905",
			"contextWindow": 131072,
			"maxTokens": 16384,
			"pricing": {
				"input": 6e-7,
				"output": 25e-7
			}
		},
		"moonshotai/kimi-k2-turbo": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 6,
				"perMessage": 3,
				"toolsExist": 48,
				"perTool": 40,
				"perDesc": 3,
				"perFirstProp": 8,
				"perAdditionalProp": 7,
				"perPropDesc": 3,
				"perEnum": 5,
				"perNestedObject": 9,
				"perArrayOfObjects": 10
			},
			"name": "Kimi K2 Turbo",
			"contextWindow": 256e3,
			"maxTokens": 16384,
			"pricing": {
				"input": 24e-7,
				"output": 1e-5
			}
		},
		"stealth/sonoma-dusk-alpha": {
			"encoding": "p50k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 167,
				"perMessage": 3,
				"toolsExist": 185,
				"perTool": 32,
				"perDesc": 3,
				"perFirstProp": 9,
				"perAdditionalProp": 7,
				"perPropDesc": 3,
				"perEnum": 6,
				"perNestedObject": 7,
				"perArrayOfObjects": 8
			},
			"name": "Sonoma Dusk Alpha",
			"contextWindow": 2e6,
			"maxTokens": 131072,
			"pricing": {
				"input": 2e-7,
				"output": 5e-7,
				"input_cache_read": 5e-8
			}
		},
		"stealth/sonoma-sky-alpha": {
			"encoding": "p50k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 155,
				"perMessage": 3,
				"toolsExist": 186,
				"perTool": 32,
				"perDesc": 3,
				"perFirstProp": 9,
				"perAdditionalProp": 7,
				"perPropDesc": 3,
				"perEnum": 6,
				"perNestedObject": 7,
				"perArrayOfObjects": 8
			},
			"name": "Sonoma Sky Alpha",
			"contextWindow": 2e6,
			"maxTokens": 131072,
			"pricing": {
				"input": 2e-7,
				"output": 5e-7,
				"input_cache_read": 5e-8
			}
		},
		"vercel/v0-1.0-md": {
			"encoding": "p50k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 2216,
				"perMessage": 2,
				"toolsExist": 351,
				"perTool": 37,
				"perDesc": 5,
				"perFirstProp": 9,
				"perAdditionalProp": 12,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 16,
				"perArrayOfObjects": 17
			},
			"name": "v0-1.0-md",
			"contextWindow": 128e3,
			"maxTokens": 32e3,
			"pricing": {
				"input": 3e-6,
				"output": 15e-6
			}
		},
		"vercel/v0-1.5-md": {
			"encoding": "p50k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 2216,
				"perMessage": 2,
				"toolsExist": 351,
				"perTool": 37,
				"perDesc": 5,
				"perFirstProp": 9,
				"perAdditionalProp": 12,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 16,
				"perArrayOfObjects": 17
			},
			"name": "v0-1.5-md",
			"contextWindow": 128e3,
			"maxTokens": 32768,
			"pricing": {
				"input": 3e-6,
				"output": 15e-6
			}
		},
		"zai/glm-4.5": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 9,
				"perMessage": 3,
				"toolsExist": 127,
				"perTool": 28,
				"perDesc": 1,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 10,
				"perArrayOfObjects": 11
			},
			"name": "GLM-4.5",
			"contextWindow": 131072,
			"maxTokens": 131072,
			"pricing": {
				"input": 6e-7,
				"output": 22e-7
			}
		},
		"zai/glm-4.5-air": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 4,
				"perMessage": 3,
				"toolsExist": 128,
				"perTool": 28,
				"perDesc": 1,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 9,
				"perArrayOfObjects": 11
			},
			"name": "GLM 4.5 Air",
			"contextWindow": 128e3,
			"maxTokens": 96e3,
			"pricing": {
				"input": 2e-7,
				"output": 11e-7
			}
		},
		"zai/glm-4.5v": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 9,
				"perMessage": 3,
				"toolsExist": 133,
				"perTool": 33,
				"perDesc": 1,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 10,
				"perArrayOfObjects": 11
			},
			"name": "GLM 4.5V",
			"contextWindow": 65536,
			"maxTokens": 66e3,
			"pricing": {
				"input": 6e-7,
				"output": 18e-7
			}
		},
		"meta/llama-3.3-70b": {
			"encoding": "claude",
			"tokens": {
				"contentMultiplier": 1.1,
				"baseOverhead": 34,
				"perMessage": 4,
				"toolsExist": 173,
				"perTool": 47,
				"perDesc": 1,
				"perFirstProp": 8,
				"perAdditionalProp": 7,
				"perPropDesc": 3,
				"perEnum": 5,
				"perNestedObject": 9,
				"perArrayOfObjects": 10
			},
			"name": "Llama 3.3 70B Instruct",
			"contextWindow": 128e3,
			"maxTokens": 8192,
			"pricing": {
				"input": 72e-8,
				"output": 72e-8
			}
		},
		"mistral/mistral-large": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 2,
				"perMessage": 1,
				"toolsExist": 60,
				"perTool": 57,
				"perDesc": 1,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 9,
				"perArrayOfObjects": 11
			},
			"name": "Mistral Large",
			"contextWindow": 32e3,
			"maxTokens": 4e3,
			"pricing": {
				"input": 2e-6,
				"output": 6e-6
			}
		},
		"mistral/mistral-medium": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 2,
				"perMessage": 1,
				"toolsExist": 60,
				"perTool": 57,
				"perDesc": 1,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 9,
				"perArrayOfObjects": 11
			},
			"name": "Mistral Medium 3.1",
			"contextWindow": 128e3,
			"maxTokens": 64e3,
			"pricing": {
				"input": 4e-7,
				"output": 2e-6
			}
		},
		"mistral/mistral-small": {
			"encoding": "cl100k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 2,
				"perMessage": 1,
				"toolsExist": 60,
				"perTool": 57,
				"perDesc": 1,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 9,
				"perArrayOfObjects": 11
			},
			"name": "Mistral Small",
			"contextWindow": 32e3,
			"maxTokens": 4e3,
			"pricing": {
				"input": 1e-7,
				"output": 3e-7
			}
		},
		"mistral/pixtral-large": {
			"encoding": "claude",
			"tokens": {
				"contentMultiplier": 1.1,
				"baseOverhead": 2,
				"perMessage": 1,
				"toolsExist": 63,
				"perTool": 60,
				"perDesc": 1,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 10,
				"perArrayOfObjects": 11
			},
			"name": "Pixtral Large",
			"contextWindow": 128e3,
			"maxTokens": 4e3,
			"pricing": {
				"input": 2e-6,
				"output": 6e-6
			}
		},
		"openai/gpt-5-codex": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 5,
				"perMessage": 4,
				"toolsExist": 24,
				"perTool": 6,
				"perDesc": 2,
				"perFirstProp": 5,
				"perAdditionalProp": 3,
				"perPropDesc": 2,
				"perEnum": 7,
				"perNestedObject": -3,
				"perArrayOfObjects": 1
			},
			"name": "GPT-5-Codex",
			"contextWindow": 4e5,
			"maxTokens": 128e3,
			"pricing": {
				"input": 125e-8,
				"output": 1e-5,
				"input_cache_read": 13e-8,
				"input_cache_write": 0
			}
		},
		"openai/gpt-5-pro": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 5,
				"perMessage": 4,
				"toolsExist": 24,
				"perTool": 6,
				"perDesc": 2,
				"perFirstProp": 5,
				"perAdditionalProp": 3,
				"perPropDesc": 2,
				"perEnum": 7,
				"perNestedObject": -3,
				"perArrayOfObjects": 1
			},
			"name": "GPT-5 pro",
			"contextWindow": 4e5,
			"maxTokens": 272e3,
			"pricing": {
				"input": 15e-6,
				"output": 12e-5
			}
		},
		"google/gemini-2.0-flash": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1.08,
				"baseOverhead": -1,
				"perMessage": -1,
				"toolsExist": 0,
				"perTool": 0,
				"perDesc": 0,
				"perFirstProp": 3,
				"perAdditionalProp": 2,
				"perPropDesc": 0,
				"perEnum": 0,
				"perNestedObject": -1,
				"perArrayOfObjects": 0
			},
			"name": "Gemini 2.0 Flash",
			"contextWindow": 1e6,
			"maxTokens": 8192,
			"pricing": {
				"input": 1e-7,
				"output": 4e-7,
				"input_cache_read": 25e-9
			}
		},
		"google/gemini-2.0-flash-lite": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1.08,
				"baseOverhead": -1,
				"perMessage": -1,
				"toolsExist": 0,
				"perTool": 0,
				"perDesc": 0,
				"perFirstProp": 3,
				"perAdditionalProp": 2,
				"perPropDesc": 0,
				"perEnum": 0,
				"perNestedObject": -1,
				"perArrayOfObjects": 0
			},
			"name": "Gemini 2.0 Flash Lite",
			"contextWindow": 1048576,
			"maxTokens": 8192,
			"pricing": {
				"input": 75e-9,
				"output": 3e-7
			}
		},
		"google/gemini-2.5-flash": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1.08,
				"baseOverhead": -1,
				"perMessage": -1,
				"toolsExist": 0,
				"perTool": 0,
				"perDesc": 0,
				"perFirstProp": 3,
				"perAdditionalProp": 2,
				"perPropDesc": 0,
				"perEnum": 0,
				"perNestedObject": -1,
				"perArrayOfObjects": 0
			},
			"name": "Gemini 2.5 Flash",
			"contextWindow": 1e6,
			"maxTokens": 64e3,
			"pricing": {
				"input": 3e-7,
				"output": 25e-7,
				"input_cache_read": 3e-8
			}
		},
		"google/gemini-2.5-flash-lite": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1.08,
				"baseOverhead": -1,
				"perMessage": -1,
				"toolsExist": 0,
				"perTool": 0,
				"perDesc": 0,
				"perFirstProp": 3,
				"perAdditionalProp": 2,
				"perPropDesc": 0,
				"perEnum": 0,
				"perNestedObject": -1,
				"perArrayOfObjects": 0
			},
			"name": "Gemini 2.5 Flash Lite",
			"contextWindow": 1048576,
			"maxTokens": 65536,
			"pricing": {
				"input": 1e-7,
				"output": 4e-7,
				"input_cache_read": 1e-8
			}
		},
		"google/gemini-2.5-flash-lite-preview-09-2025": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1.11,
				"baseOverhead": 0,
				"perMessage": 0,
				"toolsExist": 18,
				"perTool": 18,
				"perDesc": 0,
				"perFirstProp": 10,
				"perAdditionalProp": 10,
				"perPropDesc": -1,
				"perEnum": 5,
				"perNestedObject": 29,
				"perArrayOfObjects": 29
			},
			"name": "Gemini 2.5 Flash Lite Preview 09-2025",
			"contextWindow": 1048576,
			"maxTokens": 65536,
			"pricing": {
				"input": 1e-7,
				"output": 4e-7
			}
		},
		"google/gemini-2.5-flash-preview-09-2025": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1.11,
				"baseOverhead": 0,
				"perMessage": 0,
				"toolsExist": 18,
				"perTool": 18,
				"perDesc": 0,
				"perFirstProp": 10,
				"perAdditionalProp": 10,
				"perPropDesc": -1,
				"perEnum": 5,
				"perNestedObject": 29,
				"perArrayOfObjects": 29
			},
			"name": "Gemini 2.5 Flash Preview 09-2025",
			"contextWindow": 1e6,
			"maxTokens": 65536,
			"pricing": {
				"input": 3e-7,
				"output": 25e-7,
				"input_cache_read": 3e-8
			}
		},
		"google/gemini-2.5-pro": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1.08,
				"baseOverhead": -1,
				"perMessage": -1,
				"toolsExist": 0,
				"perTool": 0,
				"perDesc": 0,
				"perFirstProp": 3,
				"perAdditionalProp": 2,
				"perPropDesc": 0,
				"perEnum": 0,
				"perNestedObject": -1,
				"perArrayOfObjects": 0
			},
			"name": "Gemini 2.5 Pro",
			"contextWindow": 1048576,
			"maxTokens": 65536,
			"pricing": {
				"input": 125e-8,
				"output": 1e-5,
				"input_cache_read": 125e-9
			}
		},
		"deepseek/deepseek-r1": {
			"encoding": "o200k_base",
			"tokens": {
				"contentMultiplier": 1,
				"baseOverhead": 4,
				"perMessage": 1,
				"toolsExist": -3,
				"perTool": -1,
				"perDesc": -1,
				"perFirstProp": -1,
				"perAdditionalProp": -1,
				"perPropDesc": -1,
				"perEnum": -3,
				"perNestedObject": 0,
				"perArrayOfObjects": 1
			},
			"name": "DeepSeek-R1",
			"contextWindow": 16e4,
			"maxTokens": 16384,
			"pricing": {
				"input": 5e-7,
				"output": 215e-8,
				"input_cache_read": 4e-7
			}
		},
		"anthropic/claude-haiku-4.5": {
			"encoding": "claude",
			"tokens": {
				"baseOverhead": 6,
				"perMessage": 2,
				"toolsExist": 549,
				"perTool": 53,
				"perDesc": 5,
				"perFirstProp": 13,
				"perAdditionalProp": 12,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 12,
				"perArrayOfObjects": 13,
				"contentMultiplier": 1.1
			},
			"name": "Claude Haiku 4.5",
			"contextWindow": 2e5,
			"maxTokens": 64e3,
			"pricing": {
				"input": 1e-6,
				"output": 5e-6,
				"input_cache_read": 1e-7,
				"input_cache_write": 125e-8
			}
		},
		"minimax/minimax-m2": {
			"encoding": "claude",
			"tokens": {
				"baseOverhead": 40,
				"perMessage": 4,
				"toolsExist": 147,
				"perTool": 51,
				"perDesc": 1,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 10,
				"perArrayOfObjects": 11,
				"contentMultiplier": 1.1
			},
			"name": "MiniMax M2",
			"contextWindow": 262114,
			"maxTokens": 262114,
			"pricing": {
				"input": 27e-8,
				"output": 115e-8
			}
		},
		"moonshotai/kimi-k2-thinking": {
			"encoding": "o200k_base",
			"tokens": {
				"baseOverhead": 6,
				"perMessage": 4,
				"toolsExist": 33,
				"perTool": 17,
				"perDesc": 2,
				"perFirstProp": 4,
				"perAdditionalProp": 4,
				"perPropDesc": 3,
				"perEnum": 6,
				"perNestedObject": 9,
				"perArrayOfObjects": 11,
				"contentMultiplier": 1
			},
			"name": "Kimi K2 Thinking",
			"contextWindow": 262114,
			"maxTokens": 262114,
			"pricing": {
				"input": 6e-7,
				"output": 25e-7
			}
		},
		"moonshotai/kimi-k2-thinking-turbo": {
			"encoding": "o200k_base",
			"tokens": {
				"baseOverhead": 6,
				"perMessage": 4,
				"toolsExist": 33,
				"perTool": 17,
				"perDesc": 2,
				"perFirstProp": 4,
				"perAdditionalProp": 4,
				"perPropDesc": 3,
				"perEnum": 6,
				"perNestedObject": 9,
				"perArrayOfObjects": 11,
				"contentMultiplier": 1
			},
			"name": "Kimi K2 Thinking Turbo",
			"contextWindow": 262114,
			"maxTokens": 262114,
			"pricing": {
				"input": 115e-8,
				"output": 8e-6,
				"input_cache_read": 15e-8
			}
		},
		"openai/gpt-5-chat": {
			"encoding": "o200k_base",
			"tokens": {
				"baseOverhead": 6,
				"perMessage": 3,
				"toolsExist": 16,
				"perTool": 6,
				"perDesc": 1,
				"perFirstProp": 5,
				"perAdditionalProp": 3,
				"perPropDesc": 2,
				"perEnum": 7,
				"perNestedObject": -3,
				"perArrayOfObjects": 1,
				"contentMultiplier": 1
			},
			"name": "GPT-5 Chat",
			"contextWindow": 128e3,
			"maxTokens": 16384,
			"pricing": {
				"input": 125e-8,
				"output": 1e-5,
				"input_cache_read": 125e-9
			}
		},
		"openai/gpt-oss-safeguard-20b": {
			"encoding": "p50k_base",
			"tokens": {
				"baseOverhead": 70,
				"perMessage": 4,
				"toolsExist": 42,
				"perTool": 15,
				"perDesc": 1,
				"perFirstProp": 3,
				"perAdditionalProp": 3,
				"perPropDesc": 1,
				"perEnum": 6,
				"perNestedObject": 19,
				"perArrayOfObjects": 17,
				"contentMultiplier": 1
			},
			"name": "gpt-oss-safeguard-20b",
			"contextWindow": 131072,
			"maxTokens": 65536,
			"pricing": {
				"input": 75e-9,
				"output": 3e-7,
				"input_cache_read": 37e-9
			}
		},
		"alibaba/qwen3-235b-a22b-thinking": {
			"encoding": "cl100k_base",
			"tokens": {
				"baseOverhead": 7,
				"perMessage": 4,
				"toolsExist": 138,
				"perTool": 56,
				"perDesc": 0,
				"perFirstProp": 14,
				"perAdditionalProp": 11,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 9,
				"perArrayOfObjects": 11,
				"contentMultiplier": 1
			},
			"name": "Qwen3 235B A22B Thinking 2507",
			"contextWindow": 262114,
			"maxTokens": 262114,
			"pricing": {
				"input": 3e-7,
				"output": 29e-7
			}
		},
		"anthropic/claude-opus-4.5": {
			"encoding": "claude",
			"tokens": {
				"baseOverhead": 6,
				"perMessage": 2,
				"toolsExist": 549,
				"perTool": 53,
				"perDesc": 5,
				"perFirstProp": 13,
				"perAdditionalProp": 12,
				"perPropDesc": 5,
				"perEnum": 9,
				"perNestedObject": 12,
				"perArrayOfObjects": 13,
				"contentMultiplier": 1.1
			},
			"name": "Claude Opus 4.5",
			"contextWindow": 2e5,
			"maxTokens": 64e3,
			"pricing": {
				"input": 5e-6,
				"output": 25e-6,
				"input_cache_read": 5e-7,
				"input_cache_write": 625e-8
			}
		},
		"google/gemini-3-pro-preview": {
			"encoding": "o200k_base",
			"tokens": {
				"baseOverhead": -1,
				"perMessage": -1,
				"toolsExist": 0,
				"perTool": 0,
				"perDesc": 0,
				"perFirstProp": 3,
				"perAdditionalProp": 2,
				"perPropDesc": 0,
				"perEnum": 0,
				"perNestedObject": -1,
				"perArrayOfObjects": 0,
				"contentMultiplier": 1.08
			},
			"name": "Gemini 3 Pro Preview",
			"contextWindow": 1e6,
			"maxTokens": 64e3,
			"pricing": {
				"input": 2e-6,
				"output": 12e-6,
				"input_cache_read": 2e-7
			}
		},
		"prime-intellect/intellect-3": {
			"encoding": "cl100k_base",
			"tokens": {
				"baseOverhead": 8,
				"perMessage": 4,
				"toolsExist": 267,
				"perTool": 51,
				"perDesc": -1,
				"perFirstProp": 27,
				"perAdditionalProp": 22,
				"perPropDesc": 6,
				"perEnum": 12,
				"perNestedObject": -9,
				"perArrayOfObjects": -16,
				"contentMultiplier": 1
			},
			"name": "INTELLECT 3",
			"contextWindow": 131072,
			"maxTokens": 131072,
			"pricing": {
				"input": 2e-7,
				"output": 11e-7
			}
		},
		"xai/grok-4.1-fast-non-reasoning": {
			"encoding": "p50k_base",
			"tokens": {
				"baseOverhead": 167,
				"perMessage": 3,
				"toolsExist": 186,
				"perTool": 32,
				"perDesc": 3,
				"perFirstProp": 9,
				"perAdditionalProp": 7,
				"perPropDesc": 3,
				"perEnum": 6,
				"perNestedObject": 7,
				"perArrayOfObjects": 8,
				"contentMultiplier": 1
			},
			"name": "Grok 4.1 Fast Non-Reasoning",
			"contextWindow": 2e6,
			"maxTokens": 2e6,
			"pricing": {
				"input": 2e-7,
				"output": 5e-7,
				"input_cache_read": 5e-8
			}
		},
		"xai/grok-4.1-fast-reasoning": {
			"encoding": "p50k_base",
			"tokens": {
				"baseOverhead": 155,
				"perMessage": 3,
				"toolsExist": 186,
				"perTool": 32,
				"perDesc": 3,
				"perFirstProp": 9,
				"perAdditionalProp": 7,
				"perPropDesc": 3,
				"perEnum": 6,
				"perNestedObject": 7,
				"perArrayOfObjects": 8,
				"contentMultiplier": 1
			},
			"name": "Grok 4.1 Fast Reasoning",
			"contextWindow": 2e6,
			"maxTokens": 2e6,
			"pricing": {
				"input": 2e-7,
				"output": 5e-7,
				"input_cache_read": 5e-8
			}
		},
		"openai/gpt-5.1-codex": {
			"encoding": "o200k_base",
			"tokens": {
				"baseOverhead": 5,
				"perMessage": 4,
				"toolsExist": 103,
				"perTool": 6,
				"perDesc": 2,
				"perFirstProp": 5,
				"perAdditionalProp": 3,
				"perPropDesc": 2,
				"perEnum": 7,
				"perNestedObject": -3,
				"perArrayOfObjects": 1,
				"contentMultiplier": 1
			},
			"name": "GPT-5.1-Codex",
			"contextWindow": 4e5,
			"maxTokens": 128e3,
			"pricing": {
				"input": 125e-8,
				"output": 1e-5,
				"input_cache_read": 125e-9
			}
		},
		"openai/gpt-5.1-instant": {
			"encoding": "o200k_base",
			"tokens": {
				"baseOverhead": 5,
				"perMessage": 4,
				"toolsExist": 103,
				"perTool": 6,
				"perDesc": 2,
				"perFirstProp": 5,
				"perAdditionalProp": 3,
				"perPropDesc": 2,
				"perEnum": 7,
				"perNestedObject": -3,
				"perArrayOfObjects": 1,
				"contentMultiplier": 1
			},
			"name": "GPT-5.1 Instant",
			"contextWindow": 128e3,
			"maxTokens": 16384,
			"pricing": {
				"input": 125e-8,
				"output": 1e-5,
				"input_cache_read": 125e-9
			}
		},
		"openai/gpt-5.1-thinking": {
			"encoding": "o200k_base",
			"tokens": {
				"baseOverhead": 5,
				"perMessage": 4,
				"toolsExist": 103,
				"perTool": 6,
				"perDesc": 2,
				"perFirstProp": 5,
				"perAdditionalProp": 3,
				"perPropDesc": 2,
				"perEnum": 7,
				"perNestedObject": -3,
				"perArrayOfObjects": 1,
				"contentMultiplier": 1
			},
			"name": "GPT 5.1 Thinking",
			"contextWindow": 4e5,
			"maxTokens": 128e3,
			"pricing": {
				"input": 125e-8,
				"output": 1e-5,
				"input_cache_read": 125e-9
			}
		},
		"openai/gpt-5.1-codex-mini": {
			"encoding": "o200k_base",
			"tokens": {
				"baseOverhead": 5,
				"perMessage": 4,
				"toolsExist": 21,
				"perTool": 6,
				"perDesc": 2,
				"perFirstProp": 5,
				"perAdditionalProp": 3,
				"perPropDesc": 2,
				"perEnum": 7,
				"perNestedObject": -3,
				"perArrayOfObjects": 1,
				"contentMultiplier": 1
			},
			"name": "GPT-5.1 Codex mini",
			"contextWindow": 4e5,
			"maxTokens": 128e3,
			"pricing": {
				"input": 25e-8,
				"output": 2e-6,
				"input_cache_read": 25e-9
			}
		}
	};
}) });

//#endregion
//#region src/index.ts
var src_default = Tokenizer;
let _modelsJson;
function getModelsJson() {
	if (_modelsJson === void 0) _modelsJson = require_models();
	return _modelsJson;
}
const models = new Proxy({}, {
	get(_, key) {
		return getModelsJson()[key];
	},
	has(_, key) {
		return key in getModelsJson();
	},
	ownKeys() {
		return Reflect.ownKeys(getModelsJson());
	},
	getOwnPropertyDescriptor(_, key) {
		const m = getModelsJson();
		if (key in m) return {
			configurable: true,
			enumerable: true,
			value: m[key]
		};
	}
});

//#endregion
export { Tokenizer, src_default as default, models };
//# sourceMappingURL=index.js.map