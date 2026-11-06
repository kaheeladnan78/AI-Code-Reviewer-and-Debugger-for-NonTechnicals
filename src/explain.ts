// Steps 8–9: send the evidence package to the AI and get back a plain-English explanation
// plus one coding concept the user can learn from this bug.
import OpenAI from "openai";

export type Explanation = {
  headline: string;
  what_went_wrong: string;
  what_change_caused_it: string;
  how_it_was_fixed: string;
  ripple_effects: string;
  concept: { name: string; explanation: string; analogy: string; in_your_code: string };
  key_terms: { term: string; meaning: string }[];
  check_your_understanding: string;
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "headline",
    "what_went_wrong",
    "what_change_caused_it",
    "how_it_was_fixed",
    "ripple_effects",
    "concept",
    "key_terms",
    "check_your_understanding",
  ],
  properties: {
    headline: { type: "string", description: "One sentence: what the bug was and that it's fixed." },
    what_went_wrong: { type: "string", description: "What the user would have seen go wrong, and why, in everyday language." },
    what_change_caused_it: { type: "string", description: "Which edit introduced the bug. Say 'unknown' if the evidence doesn't show it." },
    how_it_was_fixed: { type: "string", description: "What was changed to fix it, file by file, in plain words." },
    ripple_effects: {
      type: "string",
      description: "Which other files depend on the changed functions, and whether they were affected. Mention possible matches as uncertain.",
    },
    concept: {
      type: "object",
      additionalProperties: false,
      required: ["name", "explanation", "analogy", "in_your_code"],
      properties: {
        name: { type: "string", description: "A fundamental programming concept this bug teaches, e.g. 'Function contracts'." },
        explanation: { type: "string", description: "The concept explained for someone who has never coded." },
        analogy: { type: "string", description: "An everyday analogy (cooking, mail, shopping…)." },
        in_your_code: { type: "string", description: "Where this concept shows up in the user's code, quoting a short line." },
      },
    },
    key_terms: {
      type: "array",
      description: "2–5 technical words used above, each defined in one simple sentence.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["term", "meaning"],
        properties: { term: { type: "string" }, meaning: { type: "string" } },
      },
    },
    check_your_understanding: { type: "string", description: "One short question the user can answer to test what they learned." },
  },
} as const;

const INSTRUCTIONS = `You explain code changes to people who have never learned to program.
You are both a debugger and a teacher.

Rules:
- Use only the evidence provided. Never invent files, functions or behaviour. If something isn't shown, say you're not sure.
- Write in short, friendly sentences. Avoid jargon. When a technical word is needed, explain it right away.
- Refer to code by file name and line number, and quote at most one short line at a time.
- "Contract" means a function's definition line: what inputs it needs and what it returns. When a contract changed,
  explain who depended on it and what would break.
- Pick the single most useful programming concept this bug teaches, and connect it to the user's own code.`;

export type ExplainInput = {
  bugDescription: string;
  causeReport: string | null; // the user's own recent changes (from git)
  fixReport: string; // the agent's fix
  agentSummary: string; // what the fixing agent said it did
};

export async function explain(
  client: OpenAI,
  model: string,
  input: ExplainInput,
  signal?: AbortSignal
): Promise<{ explanation: Explanation; usage?: OpenAI.Responses.ResponseUsage }> {
  const evidence = [
    `# What the user asked for\n${input.bugDescription}`,
    `# The user's recent changes (since their last git commit)\n${input.causeReport ?? "Not available (the project isn't using git, or has no commits)."}`,
    `# The fix that was made\n${input.fixReport}`,
    `# The fixing agent's own notes\n${input.agentSummary || "(none)"}`,
  ].join("\n\n");

  const response = await client.responses.create(
    {
      model,
      instructions: INSTRUCTIONS,
      input: evidence,
      reasoning: { effort: "medium" },
      text: { format: { type: "json_schema", name: "explanation", strict: true, schema: SCHEMA as any } },
    },
    { signal }
  );
  return { explanation: JSON.parse(response.output_text) as Explanation, usage: response.usage };
}

export function formatExplanation(e: Explanation): string {
  const section = (title: string, body: string) => `\n${title}\n${"─".repeat(title.length)}\n${body}\n`;
  return [
    `\n✅ ${e.headline}`,
    section("What went wrong", e.what_went_wrong),
    section("What change caused it", e.what_change_caused_it),
    section("How it was fixed", e.how_it_was_fixed),
    section("Other code that depends on this", e.ripple_effects),
    section(
      `💡 Concept to learn: ${e.concept.name}`,
      `${e.concept.explanation}\n\nThink of it like this: ${e.concept.analogy}\n\nIn your code: ${e.concept.in_your_code}`
    ),
    section("Words to know", e.key_terms.map((t) => `• ${t.term}: ${t.meaning}`).join("\n")),
    section("Check your understanding", e.check_your_understanding),
  ].join("");
}
