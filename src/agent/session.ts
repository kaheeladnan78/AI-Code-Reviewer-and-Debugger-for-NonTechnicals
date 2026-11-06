// The agent loop: fix the bug (with approval for every edit and command), then explain it.
// Talks to the outside world only through AgentCallbacks.
import OpenAI from "openai";
import { exec } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { structuredPatch } from "diff";
import { relative, resolve, sep } from "node:path";
import { changesFromSnapshots, changesSinceLastCommit, listProjectFiles } from "../changes.js";
import { analyzeChanges, openProblems, renderReport } from "../impact.js";
import { explain } from "../explain.js";
import { enclosingFunction, listFunctions } from "../functions.js";
import { parseFile } from "../parse.js";
import { assessEdit } from "./risk.js";
import type { AgentCallbacks, EditProposal, Usage } from "./types.js";

const MAX_STEPS = 30;
const MAX_TOOL_OUTPUT = 20_000;

const SYSTEM = `You are a debugging agent working in a user's project folder. The user is not a programmer.
Reproduce the failure first if you can, form a hypothesis before editing, make the smallest fix,
and re-run to confirm it works.

You may be given an impact report of the user's recent changes: which functions changed, whether their
definition line (their "contract": inputs and outputs) changed, and every place that calls them.
Callers marked PROBLEM are very likely the bug. Use the report to guide you.

The user approves every edit and command. If they reject one, don't retry the same thing: ask what they'd
prefer, or try a different approach.

After you've made your edits, ALWAYS call check_impact. It analyses your own changes the same way.
If it reports problems (for example, you changed a function's inputs and some callers weren't updated),
fix them and call check_impact again. Only finish once it reports no problems.
Finish with a short summary of the root cause and what you changed.

If the user only asks a question, answer it in plain English without editing anything.`;

const TOOLS: OpenAI.Responses.FunctionTool[] = [
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
    description: "Read a project file. For big files, pass start_line and end_line (1-based) to read just part of it.",
    strict: false,
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } },
      required: ["path"],
    },
  },
  {
    type: "function",
    name: "edit_file",
    description: "Replace an exact string in a file (must match exactly once). The user must approve it.",
    strict: false,
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    type: "function",
    name: "run_command",
    description: "Run a shell command in the project folder (tests, the script). The user must approve it.",
    strict: false,
    parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
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

type AppliedEdit = EditProposal & { undone: boolean };

export type SessionOptions = {
  root: string;
  client: OpenAI;
  model: string;
  callbacks: AgentCallbacks;
};

// API errors in plain words instead of a stack trace
export function friendlyError(e: any): string {
  if (e?.name === "AbortError" || e?.constructor?.name === "APIUserAbortError") return "Stopped.";
  if (e?.code === "credit_balance_exhausted" || e?.code === "insufficient_quota") {
    return "Your OpenAI account is out of credits. Add credits at https://platform.openai.com/settings/organization/billing/ and try again.";
  }
  if (e?.status === 401) return "The OpenAI API key isn't valid. Set a new one and try again.";
  if (e instanceof OpenAI.APIConnectionError) {
    return "Can't reach OpenAI. Check your internet connection (try turning Wi-Fi off and on), then send your message again.";
  }
  if (e?.status === 429) return "OpenAI is limiting requests right now. Wait a minute and try again.";
  return e?.message ?? String(e);
}

/**
 * The streaming helper adds convenience fields (parsed_arguments, parsed) that the API
 * rejects if we send them back, so strip them before reusing output as input.
 */
function toInputItems(output: OpenAI.Responses.ResponseOutputItem[]): OpenAI.Responses.ResponseInputItem[] {
  return output.map((item: any) => {
    const { parsed_arguments, ...rest } = item;
    if (rest.type === "message" && Array.isArray(rest.content)) {
      rest.content = rest.content.map(({ parsed, ...part }: any) => part);
    }
    return rest as OpenAI.Responses.ResponseInputItem;
  });
}

const truncate = (text: string) =>
  text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n… (output cut off)` : text;

export class AgentSession {
  private readonly root: string;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly cb: AgentCallbacks;

  private history: OpenAI.Responses.ResponseInputItem[] = [];
  private edits = new Map<string, AppliedEdit>();
  private nextId = 1;
  private lastCauseReport: string | null = null;
  private totals: Usage = { input: 0, output: 0, total: 0 };
  private abort: AbortController | null = null;

  constructor(opts: SessionOptions) {
    this.root = resolve(opts.root);
    this.client = opts.client;
    this.model = opts.model;
    this.cb = opts.callbacks;
  }

  get running(): boolean {
    return this.abort !== null;
  }

  /** Stop the current run. Pending approvals should be resolved as "rejected" by the UI. */
  stop(): void {
    this.abort?.abort();
  }

  /** Put a file back exactly as it was before one edit */
  undoEdit(id: string): { ok: boolean; message: string } {
    const edit = this.edits.get(id);
    if (!edit) return { ok: false, message: "That edit wasn't found." };
    if (edit.undone) return { ok: false, message: "That edit was already undone." };
    const file = this.safePath(edit.path);
    let current: string;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      return { ok: false, message: `${edit.path} can't be read anymore.` };
    }
    if (current !== edit.after) {
      return {
        ok: false,
        message: `${edit.path} has changed since this edit (by a later edit or by you). Undo the newer changes first.`,
      };
    }
    writeFileSync(file, edit.before);
    edit.undone = true;
    return { ok: true, message: `Undone. ${edit.path} is back to how it was before this edit.` };
  }

  /** IDs of applied edits that haven't been undone, newest first */
  activeEditIds(): string[] {
    return [...this.edits.values()].filter((e) => !e.undone).map((e) => e.id).reverse();
  }

  async run(prompt: string): Promise<void> {
    if (this.abort) throw new Error("Already running");
    const abort = new AbortController();
    this.abort = abort;
    const originals = new Map<string, string>(); // this run's "before" snapshot, for the explanation
    const runEditIds: string[] = [];
    let agentSummary = "";

    try {
      // Steps 1–7 on the user's own recent changes
      let causeReport: string | null = null;
      try {
        const recent = changesSinceLastCommit(this.root);
        if (recent?.length) {
          const report = analyzeChanges(this.root, recent);
          causeReport = renderReport(report);
          const contracts = report.functionChanges.filter((f) => f.contractChanged).length;
          const problems = openProblems(report);
          this.cb.activity({
            kind: "analyze",
            title: `Reviewed your recent changes: ${recent.length} file(s), ${report.functionChanges.length} function(s), ${contracts} contract change(s)`,
            detail: [
              ...report.functionChanges.map(
                (f) => `${f.contractChanged ? "⚠ " : ""}${f.name} (${f.file}, line ${(f.after ?? f.before)!.startLine}): ${f.status}${f.contractChanged ? ", definition changed" : ""}`
              ),
              ...problems.map((p) => `Problem: ${p}`),
            ].join("\n"),
          });
        } else if (recent?.length === 0) {
          this.cb.activity({ kind: "analyze", title: "No code changes since your last commit" });
        } else if (recent === null) {
          this.cb.message("status", "This project doesn't use git yet, so I can't see your recent changes. I'll work from your message.");
        }
      } catch (e: any) {
        this.cb.message("status", `Couldn't analyse recent changes (${e.message}). Continuing anyway.`);
      }

      // Only resend the report when it changed, to save tokens on follow-up questions
      const includeReport = causeReport && causeReport !== this.lastCauseReport;
      if (includeReport) this.lastCauseReport = causeReport;
      this.history.push({
        role: "user",
        content: includeReport ? `${prompt}\n\n# Impact report of my recent changes\n${causeReport}` : prompt,
      });

      // The fix
      for (let step = 0; step < MAX_STEPS; step++) {
        if (abort.signal.aborted) break;
        const response = await this.streamResponse(abort.signal);
        this.addUsage(response.usage);

        // Output items go back in as input for the next turn
        this.history.push(...toInputItems(response.output));
        if (response.output_text) agentSummary = response.output_text;

        const calls = response.output.filter(
          (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call"
        );
        if (calls.length === 0) break;
        if (step === MAX_STEPS - 1) this.cb.message("status", "Stopped after the maximum number of steps.");

        for (const call of calls) {
          let args: any = {};
          try {
            args = JSON.parse(call.arguments || "{}");
          } catch {
            // leave args empty; the tool reports what's missing
          }
          const output = abort.signal.aborted
            ? "The user stopped the run."
            : await this.runTool(call.name, args, originals, runEditIds, abort.signal);
          this.history.push({ type: "function_call_output", call_id: call.call_id, output: truncate(output) });
        }
      }

      // Steps 8–9: explain the fix
      const fixChanges = changesFromSnapshots(this.root, originals);
      if (!fixChanges.length || abort.signal.aborted) return;

      this.cb.message("status", "Writing your explanation…");
      const fixReport = analyzeChanges(this.root, fixChanges);
      const { explanation, usage } = await explain(
        this.client,
        this.model,
        { bugDescription: prompt, causeReport, fixReport: renderReport(fixReport), agentSummary },
        abort.signal
      );
      this.addUsage(usage);
      this.cb.fixExplained({
        explanation,
        files: fixChanges.map((c) => c.path),
        editIds: runEditIds,
        openProblems: openProblems(fixReport),
      });
    } catch (e) {
      const text = friendlyError(e);
      this.cb.message(text === "Stopped." ? "status" : "error", text);
      // Keep history valid: every tool call needs an answer before the next request
      this.repairHistory();
    } finally {
      this.abort = null;
    }
  }

  /** One model turn, streaming its text to the UI word by word as it's written */
  private async streamResponse(signal: AbortSignal): Promise<OpenAI.Responses.Response> {
    const stream = this.client.responses.stream(
      { model: this.model, instructions: SYSTEM, tools: TOOLS, input: this.history, reasoning: { effort: "medium" } },
      { signal }
    );
    const texts = new Map<string, string>(); // message id → text so far
    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        texts.set(event.item_id, (texts.get(event.item_id) ?? "") + event.delta);
        this.cb.assistantDelta(event.item_id, event.delta);
      } else if (event.type === "response.output_item.done" && event.item.type === "message") {
        const full = event.item.content
          .map((part) => (part.type === "output_text" ? part.text : ""))
          .join("");
        if (full || texts.has(event.item.id)) this.cb.assistantDone(event.item.id, full || texts.get(event.item.id)!);
        texts.delete(event.item.id);
      }
    }
    const response = await stream.finalResponse();
    // A message whose "done" event never arrived (e.g. the stream ended early): close it anyway
    for (const [id, text] of texts) this.cb.assistantDone(id, text);
    return response;
  }

  private addUsage(usage?: OpenAI.Responses.ResponseUsage) {
    if (!usage) return;
    this.totals = {
      input: this.totals.input + usage.input_tokens,
      output: this.totals.output + usage.output_tokens,
      total: this.totals.total + usage.total_tokens,
    };
    this.cb.usage({ ...this.totals });
  }

  private repairHistory() {
    const answered = new Set(
      this.history.filter((i: any) => i.type === "function_call_output").map((i: any) => i.call_id)
    );
    for (const item of [...this.history] as any[]) {
      if (item.type === "function_call" && !answered.has(item.call_id)) {
        this.history.push({ type: "function_call_output", call_id: item.call_id, output: "The run was stopped." });
      }
    }
  }

  // Keep file access inside the project folder
  private safePath(p: string): string {
    const full = resolve(this.root, p);
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new Error("Path is outside the project folder");
    return full;
  }

  private async runTool(
    name: string,
    args: any,
    originals: Map<string, string>,
    runEditIds: string[],
    signal: AbortSignal
  ): Promise<string> {
    try {
      if (name === "list_files") {
        const files = listProjectFiles(this.root);
        this.cb.activity({ kind: "list", title: `Listed ${files.length} code file(s)`, detail: files.join("\n") });
        return files.join("\n") || "(no code files found)";
      }

      if (name === "read_file") {
        const file = this.safePath(args.path);
        const path = relative(this.root, file).split(sep).join("/");
        const lines = readFileSync(file, "utf8").split("\n");
        const start = Math.max(1, Number(args.start_line) || 1);
        const end = Math.min(lines.length, Number(args.end_line) || lines.length);
        const whole = start === 1 && end === lines.length;
        this.cb.activity({
          kind: "read",
          title: whole ? `Read ${path} (${lines.length} lines)` : `Read ${path} lines ${start}–${end}`,
          path,
          line: start,
        });
        const text = lines.slice(start - 1, end).join("\n");
        return whole ? text : `(lines ${start}–${end} of ${lines.length})\n${text}`;
      }

      if (name === "edit_file") {
        if (typeof args.old_string !== "string" || typeof args.new_string !== "string") {
          return "ERROR: old_string and new_string are required";
        }
        const file = this.safePath(args.path);
        const path = relative(this.root, file).split(sep).join("/");
        const before = readFileSync(file, "utf8");
        const count = before.split(args.old_string).length - 1;
        if (count !== 1) return `ERROR: old_string matched ${count} times, need exactly 1`;

        const after = before.replace(args.old_string, () => args.new_string);
        const parsed = parseFile(path, before);
        const fn = parsed ? enclosingFunction(listFunctions(parsed), before.indexOf(args.old_string)) : undefined;
        const proposal: EditProposal = {
          id: `edit-${this.nextId++}`,
          path,
          functionName: fn?.name ?? null,
          risk: assessEdit(this.root, path, before, after),
          before,
          after,
          hunks: structuredPatch(path, path, before, after, "", "", { context: 2 }).hunks.map((h) => ({
            oldStart: h.oldStart,
            newStart: h.newStart,
            lines: h.lines.filter((l) => !l.startsWith("\\")), // drop "\ No newline at end of file"
          })),
        };

        const approved = await this.cb.approveEdit(proposal);
        if (signal.aborted) return "The user stopped the run.";
        if (!approved) return "The user rejected this edit. Don't retry the same change.";

        // The user may have edited the file while deciding
        if (readFileSync(file, "utf8") !== before) {
          this.cb.editFailed(proposal, "the file changed while waiting for approval, so I'll look at it again");
          return "ERROR: the file changed while waiting for approval. Read it again and redo the edit.";
        }
        writeFileSync(file, after);
        if (!originals.has(path)) originals.set(path, before);
        this.edits.set(proposal.id, { ...proposal, undone: false });
        runEditIds.push(proposal.id);
        this.cb.editApplied(proposal);
        return `ok. ${fn ? `Change is inside function "${fn.name}" (starts line ${fn.startLine})` : "Change is outside any function"}`;
      }

      if (name === "run_command") {
        if (typeof args.cmd !== "string" || !args.cmd.trim()) return "ERROR: cmd is required";
        const id = `cmd-${this.nextId++}`;
        const approved = await this.cb.approveCommand({ id, cmd: args.cmd });
        if (signal.aborted) return "The user stopped the run.";
        if (!approved) return "The user declined to run this command.";
        const result = await new Promise<{ ok: boolean; output: string }>((done) => {
          exec(args.cmd, { cwd: this.root, timeout: 60_000, maxBuffer: 5_000_000, signal }, (err, stdout, stderr) => {
            done({ ok: !err, output: `${stdout}${stderr}${err && !stdout && !stderr ? err.message : ""}` });
          });
        });
        this.cb.commandFinished(id, result.ok, result.output);
        return result.ok ? result.output || "(no output)" : `FAILED:\n${result.output}`;
      }

      if (name === "check_impact") {
        const changes = changesFromSnapshots(this.root, originals);
        if (!changes.length) return "You haven't changed any files yet.";
        const report = analyzeChanges(this.root, changes);
        const problems = openProblems(report);
        this.cb.activity({
          kind: "check",
          title: problems.length
            ? `Checked impact: ${problems.length} problem(s) still to fix`
            : `Checked impact: ${report.functionChanges.length} function(s) changed, nothing else breaks`,
          detail: [
            ...report.functionChanges.map((f) => `${f.name} (${f.file}): ${f.contractChanged ? "definition changed" : "only the inside changed"}`),
            ...report.impacts.flatMap((i) =>
              i.calls.map((c) => `Caller ${c.file}:${c.line}${c.problem ? `: ${c.problem}` : ": OK"}`)
            ),
          ].join("\n"),
        });
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
}
