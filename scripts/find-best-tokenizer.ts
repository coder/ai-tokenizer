import { streamText } from "ai"
import Tokenizer from "../src/tokenizer"
import * as o200k from "../src/encoding/o200k_base"
import * as cl100k from "../src/encoding/cl100k_base"
import * as p50k from "../src/encoding/p50k_base"
import * as claude from "../src/encoding/claude"

// Test messages to compare - using diverse content types for more accurate differentiation
// We include various content types to test how different tokenizers handle:
// - Standard English text
// - Code snippets (Python, JavaScript)
// - Non-English languages (Chinese, Japanese, Korean, Arabic, Cyrillic)
// - Special characters, emojis, symbols
// - Technical/scientific content
// - Mixed content types
const testMessages = [
    { 
        role: "user" as const, 
        content: "Hello, how are you? I'm working on a project and need some help understanding how tokenization works in large language models. Can you explain the differences between various tokenization algorithms?" 
    },
    { 
        role: "user" as const, 
        content: "Write a Python function:\n```python\ndef fibonacci(n: int) -> int:\n    if n <= 1:\n        return n\n    return fibonacci(n-1) + fibonacci(n-2)\n```\nThis is a recursive implementation with O(2^n) time complexity. Can you optimize it using dynamic programming?" 
    },
    { 
        role: "user" as const, 
        content: "你好！我想学习中文。日本語も勉強しています。한국어는 어렵습니다. Мне нравится изучать языки. مرحبا بك في عالم اللغات المتعددة. Learning multiple languages helps understand different cultures and perspectives." 
    },
    { 
        role: "user" as const, 
        content: "Explain quantum computing: ψ(x) = Ae^(ikx) + Be^(-ikx), where ℏω = E. The Schrödinger equation describes quantum states: iℏ∂ψ/∂t = Ĥψ. This relates to superposition and entanglement, fundamental concepts in quantum mechanics that enable quantum computers to solve certain problems exponentially faster." 
    },
    { 
        role: "user" as const, 
        content: "Emojis and symbols test: 🚀 🎉 🔥 💯 ⭐ 🌟 ✨ 🎨 🎭 🎪 • ◦ ○ ● ▪ ▫ ■ □ ▲ △ ▼ ▽ ◆ ◇ ← → ↑ ↓ ↔ ⇒ ≈ ≠ ≤ ≥ ± ∞ ∑ ∏ √ ∫ These special characters often tokenize very differently across tokenizers!" 
    },
    { 
        role: "user" as const, 
        content: "const fetchData = async () => { const response = await fetch('https://api.example.com/data'); const json = await response.json(); return json; }; // JavaScript async/await with arrow functions, template literals `${variable}`, and modern ES6+ syntax including destructuring {a, b, c} and spread operators [...array]." 
    },
    { 
        role: "user" as const, 
        content: "Technical terms: Kubernetes, microservices, Docker, PostgreSQL, MongoDB, GraphQL, REST API, OAuth2, JWT, WebSocket, gRPC, Protocol Buffers, Apache Kafka, Redis, Elasticsearch, Terraform, CI/CD pipelines, Infrastructure-as-Code, serverless architecture, edge computing, machine learning pipelines." 
    },
    { 
        role: "user" as const, 
        content: "Numbers and identifiers: 1234567890, 0x1A2B3C4D, 192.168.1.1, UUID: 550e8400-e29b-41d4-a716-446655440000, API_KEY_2024_v3, user_id_42, $price = 19.99, discount = 15%, tax = 8.5%, total = $23.69, timestamp: 2024-01-15T10:30:45.123Z" 
    },
    { 
        role: "user" as const, 
        content: "Mixed content: The café serves crème brûlée 🍮, naïve résumé writing, Zürich's coöperation, façade maintenance. Special quotes: \"English\", \"French\", \"German\", \"Japanese\". Math: ∀x ∈ ℝ, ∃y ∈ such that x < y. Currency: $100 €85 £75 ¥10,000 ₹5,000 ₽3,000" 
    },
    { 
        role: "user" as const, 
        content: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat." 
    },
]

// Longer test messages for better multiplier detection (systematic errors show up more in longer content)
const longTestMessages = [
    {
        role: "user" as const,
        content: "The quick brown fox jumps over the lazy dog. ".repeat(50) + "This longer content helps detect systematic tokenization biases that only become apparent at scale."
    },
    {
        role: "user" as const,
        content: "In computer science, a binary search tree (BST) is a node-based binary tree data structure that maintains sorted order. Each node contains a key and associated values. ".repeat(20) + "Understanding data structures is fundamental to efficient algorithm design."
    },
    {
        role: "user" as const,
        content: "Machine learning models require large amounts of training data to generalize well. The quality of the data is often more important than the quantity. ".repeat(30) + "Data preprocessing and feature engineering are critical steps in the ML pipeline."
    },
]

const tokenizers = {
    "o200k_base": new Tokenizer(o200k),
    "cl100k_base": new Tokenizer(cl100k),
    "p50k_base": new Tokenizer(p50k),
    "claude": new Tokenizer(claude),
}

export interface TokenizerResult {
    encoding: string
    multiplier: number
    avgDiff: number
}

export async function findBestTokenizer(model: string, verbose = true): Promise<TokenizerResult> {
    if (verbose) {
        console.log(`🔍 Finding best tokenizer for: ${model}\n`)
    }

    // Track performance across all tests
    const tokenizerScores: Record<string, number[]> = {}
    const tokenizerRatios: Record<string, number[]> = {} // Track actual/predicted ratios for multiplier
    const tokenizerRatiosLongOnly: Record<string, number[]> = {} // Only long messages for better multiplier estimate
    for (const name of Object.keys(tokenizers)) {
        tokenizerScores[name] = []
        tokenizerRatios[name] = []
        tokenizerRatiosLongOnly[name] = []
    }

    // ===================================================================================
    // Test each tokenizer against actual API results (in parallel for speed)
    // ===================================================================================
    // Combine regular and long test messages for comprehensive testing
    const allTestMessages = [...testMessages, ...longTestMessages]
    
    if (verbose) {
        console.log(`\n📝 Testing tokenizers against actual API results\n`)
        console.log(`This sends each message to the API and compares the actual token count`)
        console.log(`with what each tokenizer predicts. We'll also calculate the optimal`)
        console.log(`multiplier to correct for systematic under/over-counting.\n`)
        console.log(`Running ${allTestMessages.length} API calls in parallel for faster results...\n`)
    }

    // Start all API calls in parallel
    const apiCalls = allTestMessages.map(async (message) => {
        const result = streamText({
            model,
            messages: [message],
            maxOutputTokens: 16, // Small output since we only care about input tokens
        })
        await result.consumeStream() // Wait for stream to complete
        const usage = await result.usage // Get token usage stats
        return { message, actualTokens: usage.inputTokens! }
    })

    // Wait for all API calls to complete
    const results = await Promise.all(apiCalls)

    // Process results sequentially for clean logging
    for (const { message, actualTokens } of results) {
        const preview = message.content.substring(0, 60) + (message.content.length > 60 ? '...' : '')
        if (verbose) {
            console.log(`\nTesting: "${preview}"`)
            console.log(`  Actual tokens from API: ${actualTokens}`)
            console.log(`  Tokenizer predictions:`)
        }
        
        const scores: Array<{ name: string; tokens: number; diff: number; ratio: number }> = []
        
        // Test each tokenizer's prediction
        // Note: We're comparing pure content tokens (no overhead) to get the content multiplier
        // The overhead is handled separately by baseOverhead and perMessage in the config
        for (const [name, tokenizer] of Object.entries(tokenizers)) {
            const contentTokens = tokenizer.encode(message.content).length
            const roleTokens = tokenizer.encode(message.role).length
            
            // Estimate overhead: most models have baseOverhead (3-7) + perMessage (1-5) + roleTokens
            // We'll use a conservative estimate of 8 tokens overhead for ratio calculation
            const estimatedOverhead = 8
            const estimatedContent = actualTokens - roleTokens - estimatedOverhead
            
            const diff = Math.abs(actualTokens - (contentTokens + roleTokens + estimatedOverhead))
            // Calculate ratio based on content tokens only (excludes overhead)
            const ratio = contentTokens > 0 && estimatedContent > 0 ? estimatedContent / contentTokens : 1.0
            
            scores.push({ name, tokens: contentTokens, diff, ratio })
            if (verbose) {
                console.log(`    ${name.padEnd(15)}: ${contentTokens} content tokens (diff: ${diff >= 0 ? '+' : ''}${actualTokens - (contentTokens + roleTokens + estimatedOverhead)}, ratio: ${ratio.toFixed(3)})`)
            }
        }
        
        // Find the best tokenizer for this message
        const best = scores.sort((a, b) => a.diff - b.diff)[0]
        if (verbose) {
            console.log(`  → Best for this message: ${best!.name}`)
        }
        
        // Track scores and ratios for final summary
        for (const score of scores) {
            const scoreArray = tokenizerScores[score.name]
            const ratioArray = tokenizerRatios[score.name]
            const ratioLongArray = tokenizerRatiosLongOnly[score.name]
            if (scoreArray && ratioArray && ratioLongArray) {
                scoreArray.push(score.diff)
                ratioArray.push(score.ratio)
                // Only use long messages (>400 tokens) for multiplier - overhead is proportionally smaller
                if (score.tokens > 400) {
                    ratioLongArray.push(score.ratio)
                }
            }
        }
    }

    // ===================================================================================
    // FINAL SUMMARY: Determine the best tokenizer overall and calculate multiplier
    // ===================================================================================
    if (verbose) {
        console.log(`\n\n🏆 FINAL RESULTS\n`)
        console.log(`Average absolute difference and optimal multiplier across all tests:\n`)
    }

    // Calculate average scores and multipliers
    const averages = Object.entries(tokenizerScores)
        .map(([name, diffs]) => {
            const ratiosLong = tokenizerRatiosLongOnly[name]!
            const avgDiff = diffs.reduce((sum, d) => sum + d, 0) / diffs.length
            // Use long messages only for multiplier calculation (more accurate due to lower overhead proportion)
            const avgRatio = ratiosLong.length > 0 
                ? ratiosLong.reduce((sum, r) => sum + r, 0) / ratiosLong.length
                : 1.0  // Fallback if no long messages
            return {
                name,
                avgDiff,
                avgRatio,
                longSamples: ratiosLong.length
            }
        })
        .sort((a, b) => a.avgDiff - b.avgDiff)

    if (verbose) {
        for (const { name, avgDiff, avgRatio, longSamples } of averages) {
            console.log(`  ${name.padEnd(15)}: ${avgDiff.toFixed(2)} avg diff, ${avgRatio.toFixed(4)}x multiplier (${longSamples} long samples)`)
        }
    }

    // Determine overall best
    const best = averages[0]
    if (!best) {
        throw new Error(`No tokenizer results found`)
    }

    // Round multiplier to 2 decimal places, but only include if significantly different from 1.0
    const multiplier = Math.round(best.avgRatio * 100) / 100
    const finalMultiplier = Math.abs(multiplier - 1.0) < 0.03 ? 1.0 : multiplier

    if (verbose) {
        console.log(`\n${'='.repeat(70)}`)
        console.log(`✨ RECOMMENDATION FOR ${model}:`)
        console.log(`${'='.repeat(70)}`)
        console.log(`\n🎯 Best tokenizer: ${best.name}`)
        console.log(`   Average difference: ${best.avgDiff.toFixed(2)} tokens`)
        console.log(`   Content multiplier: ${finalMultiplier}${finalMultiplier !== 1.0 ? ` (from ${best.longSamples} long messages)` : ''}`)
        console.log(`\n   Use this tokenizer${finalMultiplier !== 1.0 ? ' with ' + finalMultiplier + 'x multiplier' : ''} for most accurate token counting.`)
        if (best.longSamples < 2) {
            console.log(`\n   ⚠️  Note: Multiplier based on only ${best.longSamples} long message(s). Add more long test messages for better accuracy.`)
        }
        console.log(`\n${'='.repeat(70)}\n`)
    }

    return {
        encoding: best.name,
        multiplier: finalMultiplier,
        avgDiff: best.avgDiff
    }
}

// CLI usage
if (import.meta.main) {
    if (!process.env.AI_GATEWAY_API_KEY) {
        throw new Error("AI_GATEWAY_API_KEY is not set")
    }

    const model = process.argv[2]
    if (!model) {
        throw new Error("model must be specified as the first argument")
    }

    await findBestTokenizer(model, true)
}

