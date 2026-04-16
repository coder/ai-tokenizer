# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.7] - 2026-04-16

### Added
- Lazy loading of models.json using Proxy pattern for improved initial load times
- On-demand decoder building for Tokenizer instances
- On-demand binary search index building for encoding operations

### Changed
- Models are now parsed only when first accessed, not at module load time
- Decoder is built on first `decode()` call instead of at Tokenizer construction
- Binary search index is built when first needed in encoding operations
- Encoding interface: `decoder` field is now optional (marked `@deprecated`)

### Improved
- Reduced module load time by deferring expensive JSON parsing
- Reduced Tokenizer instantiation overhead
- Reduced binary encoding file sizes by ~50-60% through optimization
- Better memory efficiency for applications that don't use all models

### Performance
- Module load time: Significant improvement when not immediately using tokenizers
- Tokenizer construction: Faster initialization for encoding-only workloads
- Memory: Lower initial footprint with lazy index building
- Installation: Smaller encoding binary files

### Compatibility
- ✅ Fully backward compatible
- ✅ Existing code requires no changes
- ✅ Optional pre-built decoders still supported for advanced use cases

## [1.0.6] - 2026-04-15

### Added
- Initial release with ultra-optimized BPE tokenizer
- Support for multiple encodings (cl100k_base, o200k_base, p50k_base, claude)
- AI SDK integration
- 5-7x faster than tiktoken WASM
