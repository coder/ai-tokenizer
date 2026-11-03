/**
 * The conversations scripts/generate-accuracy.ts measures: one system message,
 * alternating user and assistant messages of mixed text, user messages with two
 * text blocks, and every 13th message a tool call with its result. The same
 * seed gives the same text, so a run can be repeated.
 */
import { tool, type ModelMessage } from "ai";
import { z } from "zod";

// Define tools for testing (with complex nested schemas)
export const tools = {
    analyzeData: tool({
        description: "Analyze dataset with comprehensive statistical insights and trend detection",
        inputSchema: z.object({
            query: z.string().describe("Analysis query"),
            filters: z.object({
                category: z.string().describe("Category filter"),
                dateRange: z.object({
                    start: z.string().describe("Start date ISO format"),
                    end: z.string().describe("End date ISO format"),
                }).describe("Date range for filtering"),
                tags: z.array(z.string()).describe("Tag filters"),
            }).describe("Data filters"),
            aggregation: z.enum(["sum", "avg", "min", "max", "count"]).describe("Aggregation method"),
        }),
    }),
};

// Diverse message templates for realistic testing
const messageTemplates = [
    "Hello! I need help analyzing customer data from Q{Q} {YEAR}. Can you provide insights on revenue trends, retention rates, and growth patterns?",
    "Write a {LANG} function to calculate {METRIC} with error handling and validation. Include proper type annotations and documentation.",
    "你好！{TOPIC}についての情報を教えてください。한국어로도説명できますか？ Пожалуйста, объясните на русском языке. شكراً لك على المساعدة.",
    "Explain quantum {CONCEPT}: ψ(x) = Ae^(ikx), where ℏω = E_{n}. The Schrödinger equation shows how {PARTICLE} behave at quantum scales.",
    "Emojis test 🚀 {EMOJI1} {EMOJI2} {EMOJI3} ⭐ ✨ • ○ ● ▪ ■ ← → ↔ ≈ ≠ ≤ ≥ ± ∞ ∑ √ special characters tokenize differently!",
    "const {FUNC} = async () => {{ const response = await fetch('{URL}'); const data = await response.json(); return data.{FIELD}; }}; // Modern {LANG} with async/await",
    "Technical: {TECH1}, {TECH2}, {TECH3}, microservices, Docker, PostgreSQL, GraphQL, REST API, OAuth2, JWT, WebSocket, gRPC, serverless, edge computing.",
    "Numbers: {NUM1}, 0x{HEX}, {IP}, UUID: {UUID}, API_KEY_{YEAR}_v{VER}, user_id_{ID}, $price = {PRICE}, discount = {PCT}%, timestamp: {TIMESTAMP}",
    "Mixed content: The café serves {FOOD} 🍮, naïve résumé, Zürich coöperation. Quotes: \"{QUOTE}\". Math: ∀x ∈ ℝ, ∃y. Currency: ${DOLLAR} €{EURO} £{POUND}",
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. {ACTION} tempor incididunt ut labore et dolore magna aliqua. {PHRASE} ad minim veniam.",
];

const replacements: Record<string, string[]> = {
    "{Q}": ["1", "2", "3", "4"],
    "{YEAR}": ["2023", "2024", "2025"],
    "{LANG}": ["Python", "JavaScript", "TypeScript", "Go", "Rust"],
    "{METRIC}": ["fibonacci", "factorial", "prime numbers", "sorting"],
    "{TOPIC}": ["機械学習", "人工知能", "データ分析"],
    "{CONCEPT}": ["entanglement", "superposition", "tunneling"],
    "{PARTICLE}": ["electrons", "photons", "quarks"],
    "{EMOJI1}": ["🎉", "🔥", "💯", "🌟"],
    "{EMOJI2}": ["🎨", "🎭", "🎪", "🎬"],
    "{EMOJI3}": ["⚡", "🌈", "🎯", "💡"],
    "{FUNC}": ["fetchData", "processData", "analyzeMetrics"],
    "{URL}": ["https://api.example.com/v1/data", "https://service.io/api/metrics"],
    "{FIELD}": ["results", "metrics", "analytics", "insights"],
    "{TECH1}": ["Kubernetes", "Redis", "Elasticsearch"],
    "{TECH2}": ["Kafka", "RabbitMQ", "NATS"],
    "{TECH3}": ["Terraform", "Ansible", "Jenkins"],
    "{NUM1}": ["1234567890", "9876543210"],
    "{HEX}": ["1A2B3C4D", "DEADBEEF"],
    "{IP}": ["192.168.1.1", "10.0.0.1"],
    "{UUID}": ["550e8400-e29b-41d4-a716-446655440000"],
    "{ID}": ["42", "1337", "9001"],
    "{VER}": ["2", "3", "4"],
    "{PRICE}": ["19.99", "29.99", "49.99"],
    "{PCT}": ["15", "20", "25"],
    "{TIMESTAMP}": ["2024-01-15T10:30:45Z", "2025-03-20T14:22:10Z"],
    "{FOOD}": ["crème brûlée", "café au lait", "pâté"],
    "{QUOTE}": ["Hello world", "Bonjour monde", "Hola mundo"],
    "{DOLLAR}": ["100", "250", "500"],
    "{EURO}": ["85", "200", "425"],
    "{POUND}": ["75", "175", "375"],
    "{ACTION}": ["Sed do eiusmod", "Duis aute irure", "Excepteur sint"],
    "{PHRASE}": ["Ut enim", "Quis nostrud", "Nisi ut"],
};

function fillTemplate(template: string, random: () => number): string {
    let result = template;
    for (const [placeholder, options] of Object.entries(replacements)) {
        if (result.includes(placeholder)) {
            const randomOption = options[Math.floor(random() * options.length)]!;
            result = result.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), randomOption);
        }
    }
    return result;
}


/** mulberry32: a small seeded generator of numbers in [0, 1). */
export function seeded(seed: number): () => number {
    let state = seed >>> 0
    return () => {
        state = (state + 0x6d2b79f5) >>> 0
        let t = Math.imul(state ^ (state >>> 15), 1 | state)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

/**
 * Messages until `count` says they reach about `targetTokens`. `toolCalls`
 * leaves out the tool calls, for a model that cannot take them.
 */
export function buildConversation(
    count: (messages: ModelMessage[]) => number,
    targetTokens: number,
    random: () => number,
    toolCalls = true
): ModelMessage[] {
    const messages: ModelMessage[] = [{
        role: "system",
        content: fillTemplate("You are an expert AI assistant specializing in {TECH1} and {TECH2}. Help users with detailed analysis and technical guidance.", random)
    }]
    let messageIdx = 0

    // Always add at least one user message first
    messages.push({ role: "user", content: fillTemplate(messageTemplates[0]!, random) })
    messageIdx++

    while (true) {
        if (count(messages) >= targetTokens * 0.9 && messages.length >= 2) break; // Stop at 90% with at least 2 messages

        const role = messageIdx % 2 === 0 ? "user" : "assistant"
        const template = messageTemplates[messageIdx % messageTemplates.length]!
        const content = fillTemplate(template, random)

        // Sometimes use array content with multiple text parts (more realistic)
        if (messageIdx % 7 === 0 && role === "user") {
            messages.push({
                role,
                content: [
                    { type: "text", text: content },
                    { type: "text", text: fillTemplate("Additionally, can you help with {TECH1}?", random) }
                ]
            })
        } else if (role === "assistant" && messageIdx % 13 === 3 && toolCalls) {
            // Include tool calls in some assistant messages
            const toolCallId = `call${messageIdx.toString().padStart(5, '0')}`
            messages.push({
                role,
                content: [
                    { type: "text", text: content },
                    {
                        type: "tool-call",
                        toolCallId,
                        toolName: "analyzeData",
                        input: {
                            query: fillTemplate("Q{Q} analysis", random),
                            filters: {
                                category: fillTemplate("{TECH1}", random),
                                dateRange: { start: "2024-01-01", end: "2024-12-31" },
                                tags: ["test"]
                            },
                            aggregation: "sum"
                        },
                    }
                ]
            })
            messageIdx++

            // Add corresponding tool result
            messages.push({
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        toolCallId,
                        toolName: "analyzeData",
                        output: {
                            type: "json",
                            value: {
                                status: "success",
                                message: fillTemplate("Analysis complete for {TECH1}. Found {NUM1} records.", random),
                                count: Math.floor(random() * 10000)
                            }
                        },
                    }
                ]
            })
        } else {
            // Regular string content
            messages.push({ role, content })
        }

        messageIdx++
    }
    return messages
}
