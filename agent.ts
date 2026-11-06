// Terminal version of the debugger + educator. The VS Code extension uses the same AgentSession.
//
// Usage (run from this folder):
//   npx tsx --env-file=.env agent.ts --dir /path/to/your/project "describe the bug"
//   npx tsx --env-file=.env agent.ts --dir /path/to/your/project      (checks your recent changes)
import OpenAI from "openai";
import { resolve } from "node:path";
import * as readline from "node:readline/promises";
import { AgentSession } from "./src/agent/session.js";
import type { AgentCallbacks } from "./src/agent/types.js";
import { formatExplanation } from "./src/explain.js";

const MODEL = "gpt-5.5";

const argv = process.argv.slice(2);
const dirFlag = argv.indexOf("--dir");
const root = resolve(dirFlag >= 0 ? argv[dirFlag + 1] ?? "." : process.cwd());
const task = argv.filter((_, i) => i !== dirFlag && i !== dirFlag + 1).join(" ").trim();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const yes = async (question: string) => (await rl.question(`${question} (y/n) `)).trim().toLowerCase() === "y";
const RISK_ICON = { low: "🟢", medium: "🟡", high: "🔴" };

const streaming = new Set<string>(); // replies currently being printed
const callbacks: AgentCallbacks = {
  message: (role, text) => console.log(role === "error" ? `\n❌ ${text}` : `   ${text}`),
  assistantDelta: (id, delta) => {
    if (!streaming.has(id)) {
      streaming.add(id);
      process.stdout.write("\n");
    }
    process.stdout.write(delta);
  },
  assistantDone: (id, text) => {
    if (streaming.delete(id)) process.stdout.write("\n");
    else console.log(`\n${text}`); // nothing was streamed, so print it whole
  },
  activity: (step) => console.log(`   • ${step.title}`),
  approveEdit: (edit) => {
    console.log(`\n✏️  Proposed edit to ${edit.path}${edit.functionName ? ` (in ${edit.functionName})` : ""}`);
    for (const hunk of edit.hunks) {
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      for (const l of hunk.lines) {
        const n = l[0] === "-" ? oldLine++ : l[0] === "+" ? newLine++ : (oldLine++, newLine++);
        console.log(`   ${String(n).padStart(4)} ${l}`);
      }
    }
    console.log(`   Risk: ${RISK_ICON[edit.risk.level]} ${edit.risk.level}`);
    for (const r of edit.risk.reasons) console.log(`   - ${r}`);
    return yes("   Apply this edit?");
  },
  editApplied: (edit) => console.log(`   ✅ Edited ${edit.path}`),
  editFailed: (edit, reason) => console.log(`   Couldn't edit ${edit.path}: ${reason}`),
  approveCommand: (command) => yes(`\n▶️  Run "${command.cmd}"?`),
  commandFinished: (_id, ok) => console.log(ok ? "   Command finished." : "   Command failed."),
  fixExplained: (result) => {
    if (result.openProblems.length) {
      console.log(`\n⚠️  ${result.openProblems.length} possible problem(s) remain:`);
      for (const p of result.openProblems) console.log(`   - ${p}`);
    }
    console.log(formatExplanation(result.explanation));
  },
  usage: () => {},
};

let tokens = 0;
const session = new AgentSession({
  root,
  client: new OpenAI(), // reads OPENAI_API_KEY from the environment
  model: MODEL,
  callbacks: { ...callbacks, usage: (u) => (tokens = u.total) },
});

console.log(`\n🔎 Project: ${root}`);
await session.run(task || "Find and fix any bugs caused by my recent changes.");

const applied = session.activeEditIds();
if (applied.length && !(await yes("\nKeep these changes? (n = undo all)"))) {
  for (const id of applied) console.log(`   ${session.undoEdit(id).message}`);
}
console.log(`\nTokens used: ${tokens.toLocaleString()}`);
rl.close();
