// Debugger + educator: fixes a bug in your project, then explains it in plain English
// and teaches the coding concept behind it.
//
// Usage (run from this folder):
//   npx tsx --env-file=.env agent.ts --dir /path/to/your/project "describe the bug"
//   npx tsx --env-file=.env agent.ts --dir /path/to/your/project      (checks your recent changes)
import OpenAI from "openai";
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import * as readline from "node:readline/promises";
import { changesFromSnapshots, changesSinceLastCommit, listProjectFiles } from "./src/changes.js";
import { analyzeChanges, openProblems, renderReport } from "./src/impact.js";
import { explain, formatExplanation } from "./src/explain.js";
import { enclosingFunction, listFunctions } from "./src/functions.js";
import { parseFile } from "./src/parse.js";

const MODEL = "gpt-5.5";
const MAX_STEPS = 30;
const MAX_TOOL_OUTPUT = 20_000;

const client = new OpenAI(); // reads OPENAI_API_KEY from the environment

// ---------- Command-line arguments ----------
const argv = process.argv.slice(2);
const dirFlag = argv.indexOf("--dir");
const ROOT = resolve(dirFlag >= 0 ? argv[dirFlag + 1] ?? "." : process.cwd());
const task = argv.filter((_, i) => i !== dirFlag && i !== dirFlag + 1).join(" ").trim();

const SYSTEM = `You are a debugging agent working in a user's project folder. The user is not a programmer.
Reproduce the failure first if you can, form a hypothesis before editing, make the smallest fix,
and re-run to confirm it works.

You are given an impact report of the user's recent changes: which functions changed, whether their
definition line (their "contract": inputs and outputs) changed, and every place that calls them.
Callers marked PROBLEM are very likely the bug. Use the report to guide you.

After you've made your edits, ALWAYS call check_impact. It analyses your own changes the same way.
If it reports problems (for example, you changed a function's inputs and some callers weren't updated),
fix them and call check_impact again. Only finish once it reports no problems.
Finish with a short summary of the root cause and what you changed.`;

const tools: OpenAI.Responses.FunctionTool[] = [
  {
    type: "function",
    name: "list_files",
    description: "List every code file in the project",
    strict: false,
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "read_file",
    description: "Read a project file",
    strict: false,
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    type: "function",
    name: "edit_file",
    description: "Replace an exact string in a file (must match exactly once)",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    type: "function",
    name: "run_command",
    description: "Run a shell command in the project folder (tests, the script) and return its output",
    strict: false,
    parameters: {
      type: "object",
      properties: { cmd: { type: "string" } },
      required: ["cmd"],
    },
  },
  {
    type: "function",
    name: "check_impact",
    description:
      "Analyse the edits you've made so far: changed functions, contract (signature) changes, and every caller that may now break",
    strict: false,
    parameters: { type: "object", properties: {} },
  },
];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// Keep file access inside the project folder
function safePath(p: string): string {
  const full = resolve(ROOT, p);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) {
    throw new Error("Path is outside the project folder");
  }
  return full;
}

const toProjectPath = (full: string) => relative(ROOT, full).split(sep).join("/");

// The original content of every file the agent edits, so we can diff (and undo) the fix
const originals = new Map<string, string>();

function truncate(text: string): string {
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n… (output cut off)` : text;
}

async function runTool(name: string, args: any): Promise<string> {
  try {
    if (name === "list_files") {
      return listProjectFiles(ROOT).join("\n") || "(no code files found)";
    }
    if (name === "read_file") {
      return readFileSync(safePath(args.path), "utf8");
    }
    if (name === "edit_file") {
      const file = safePath(args.path);
      const text = readFileSync(file, "utf8");
      const count = text.split(args.old_string).length - 1;
      if (count !== 1) return `ERROR: old_string matched ${count} times, need exactly 1`;

      const path = toProjectPath(file);
      if (!originals.has(path)) originals.set(path, text);

      // Work out which function the change is inside (before editing)
      const idx = text.indexOf(args.old_string);
      const parsed = parseFile(path, text);
      const fn = parsed ? enclosingFunction(listFunctions(parsed), idx) : undefined;
      const where = fn ? `Change is inside function "${fn.name}" (starts line ${fn.startLine})` : "Change is outside any function";

      writeFileSync(file, text.replace(args.old_string, () => args.new_string));
      console.log(`  ✏️  Edited ${path}${fn ? ` (in ${fn.name})` : ""}`);
      return `ok. ${where}`;
    }
    if (name === "run_command") {
      const answer = await rl.question(`Run "${args.cmd}"? (y/n) `);
      if (answer.trim().toLowerCase() !== "y") return "User declined to run this command";
      try {
        return execSync(args.cmd, { cwd: ROOT, encoding: "utf8", stdio: "pipe", timeout: 60_000 });
      } catch (e: any) {
        return `FAILED:\n${e.stdout ?? ""}${e.stderr ?? e.message}`;
      }
    }
    if (name === "check_impact") {
      const changes = changesFromSnapshots(ROOT, originals);
      if (!changes.length) return "You haven't changed any files yet.";
      const report = analyzeChanges(ROOT, changes);
      const problems = openProblems(report);
      const summary = problems.length
        ? `PROBLEMS STILL OPEN (${problems.length}):\n${problems.map((p) => `- ${p}`).join("\n")}`
        : "No problems found: every caller matches the current function definitions.";
      return `${summary}\n\n${renderReport(report)}`;
    }
    return `Unknown tool: ${name}`;
  } catch (e: any) {
    return `ERROR: ${e.message}`;
  }
}

// ---------- Step 1–7 on the user's own recent changes ----------
console.log(`\n🔎 Looking at your project: ${ROOT}`);
const recent = changesSinceLastCommit(ROOT);
let causeReport: string | null = null;
if (recent === null) {
  console.log("   (This project doesn't use git yet, so I can't see your recent changes. I'll work from your description.)");
} else if (recent.length === 0) {
  console.log("   No code changes since your last commit.");
} else {
  const report = analyzeChanges(ROOT, recent);
  causeReport = renderReport(report);
  const contracts = report.functionChanges.filter((f) => f.contractChanged).length;
  console.log(`   ${recent.length} file(s) changed, ${report.functionChanges.length} function(s) touched, ${contracts} contract change(s).`);
}

if (!task && !causeReport) {
  console.log('\nUsage: npx tsx --env-file=.env agent.ts --dir /path/to/project "describe the bug"');
  rl.close();
  process.exit(1);
}

const bugDescription = task || "Find and fix any bugs caused by my recent changes.";

// ---------- The fix ----------
console.log("\n🛠️  Working on a fix...");
const input: OpenAI.Responses.ResponseInputItem[] = [
  {
    role: "user",
    content: `${bugDescription}\n\n# Impact report of my recent changes\n${causeReport ?? "Not available."}`,
  },
];
let agentSummary = "";

// API errors in plain words instead of a stack trace
function friendlyError(e: any): string {
  if (e?.code === "credit_balance_exhausted" || e?.code === "insufficient_quota") {
    return "Your OpenAI account is out of credits. Add credits at https://platform.openai.com/settings/organization/billing/ and try again.";
  }
  if (e?.status === 401) return "The OpenAI API key isn't valid. Check OPENAI_API_KEY in your .env file.";
  if (e?.status === 429) return "OpenAI is limiting requests right now. Wait a minute and try again.";
  return e?.message ?? String(e);
}

for (let step = 0; step < MAX_STEPS; step++) {
  let response: OpenAI.Responses.Response;
  try {
    response = await client.responses.create({
      model: MODEL,
      instructions: SYSTEM,
      tools,
      input,
      reasoning: { effort: "medium" },
    });
  } catch (e) {
    console.log(`\n❌ Couldn't reach the AI: ${friendlyError(e)}`);
    break;
  }

  // Output items go back in as input; the types differ only on a "failed" status
  input.push(...(response.output as OpenAI.Responses.ResponseInputItem[]));
  if (response.output_text) agentSummary = response.output_text;

  const calls = response.output.filter(
    (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call"
  );
  if (calls.length === 0) break;
  if (step === MAX_STEPS - 1) console.log("   (Stopped after the maximum number of steps.)");

  for (const call of calls) {
    let args: unknown = {};
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {
      // leave args empty; the tool will report what's missing
    }
    const result = await runTool(call.name, args);
    input.push({ type: "function_call_output", call_id: call.call_id, output: truncate(result) });
  }
}

// ---------- Steps 8–9: explain the fix ----------
const fixChanges = changesFromSnapshots(ROOT, originals);
if (!fixChanges.length) {
  console.log("\nNo files were changed.");
  if (agentSummary) console.log(`\n${agentSummary}`);
  rl.close();
  process.exit(0);
}

const fixReport = analyzeChanges(ROOT, fixChanges);
const stillOpen = openProblems(fixReport);
console.log(`\n📦 Fix made in ${fixChanges.length} file(s): ${fixChanges.map((c) => c.path).join(", ")}`);
if (stillOpen.length) {
  console.log(`⚠️  ${stillOpen.length} possible problem(s) remain:\n${stillOpen.map((p) => `   - ${p}`).join("\n")}`);
}

console.log("\n📚 Writing your explanation...");
try {
  const explanation = await explain(client, MODEL, {
    bugDescription,
    causeReport,
    fixReport: renderReport(fixReport),
    agentSummary,
  });
  console.log(formatExplanation(explanation));
} catch (e: any) {
  console.log(`Couldn't write the explanation: ${friendlyError(e)}\n\nHere's what the agent said:\n${agentSummary}`);
}

// ---------- Keep or undo ----------
const keep = await rl.question("\nKeep these changes? (y = keep, n = undo) ");
if (keep.trim().toLowerCase() === "n") {
  for (const [path, text] of originals) writeFileSync(safePath(path), text);
  console.log("↩️  Changes undone. Your files are back to how they were.");
} else {
  console.log("👍 Changes kept.");
}

rl.close();
