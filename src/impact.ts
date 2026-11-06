// Steps 3, 5, 6, 7: which functions changed, did their contract change, who calls them, and the
// "impact snippet": the code an AI needs to see to reason about the change without guessing.
import { type FileChange, changedLines, listProjectFiles, unifiedDiff } from "./changes.js";
import { type FnInfo, functionAtLine, listFunctions, requiredCount } from "./functions.js";
import { type SignatureChange, compareSignatures } from "./signature.js";
import { type CallGraph, type CallSite, buildCallGraph } from "./callGraph.js";
import { numberedLines, parseFile } from "./parse.js";

export type FunctionChange = {
  file: string;
  name: string;
  status: "modified" | "added" | "removed";
  before?: FnInfo;
  after?: FnInfo;
  signatureChanges: SignatureChange[];
  contractChanged: boolean; // at least one breaking signature change, or the function was removed
};

export type ImpactedCall = CallSite & {
  certainty: "exact" | "possible"; // "possible" = matched by method name only
  updated: boolean; // was this call line also edited in this change?
  problem?: string; // a mismatch we can prove from the code
};

export type Impact = { change: FunctionChange; calls: ImpactedCall[] };

export type ImpactReport = {
  files: FileChange[];
  diff: string;
  functionChanges: FunctionChange[];
  impacts: Impact[];
  topLevelEdits: { file: string; lines: number[] }[]; // edits outside any named function
  syntaxErrors: { file: string; message: string }[];
  graph: CallGraph;
};

/**
 * `overrides` lets us analyse a proposed edit before it's written: path → proposed file text.
 */
export function analyzeChanges(root: string, files: FileChange[], overrides = new Map<string, string>()): ImpactReport {
  const functionChanges: FunctionChange[] = [];
  const topLevelEdits: ImpactReport["topLevelEdits"] = [];
  const syntaxErrors: ImpactReport["syntaxErrors"] = [];
  const addedLinesByFile = new Map<string, Set<number>>();

  for (const change of files) {
    const beforeParsed = change.before ? parseFile(change.path, change.before) : null;
    const afterParsed = change.after ? parseFile(change.path, change.after) : null;
    for (const message of afterParsed?.errors ?? []) syntaxErrors.push({ file: change.path, message });

    const beforeFns = beforeParsed ? listFunctions(beforeParsed) : [];
    const afterFns = afterParsed ? listFunctions(afterParsed) : [];
    const { added, removed } = changedLines(change);
    addedLinesByFile.set(change.path, new Set(added));

    // Step 3: map each changed line to the function it sits inside
    const touched = new Set<string>();
    const loose: number[] = [];
    for (const line of added) {
      const fn = functionAtLine(afterFns, line);
      fn ? touched.add(fn.name) : loose.push(line);
    }
    for (const line of removed) {
      const fn = functionAtLine(beforeFns, line);
      fn ? touched.add(fn.name) : loose.push(line);
    }
    if (loose.length) topLevelEdits.push({ file: change.path, lines: [...new Set(loose)].sort((a, b) => a - b) });

    // With a syntax error, functions can look "missing" when they're only unreadable
    const unreadable = (afterParsed?.errors.length ?? 0) > 0;
    for (const name of touched) {
      const before = beforeFns.find((f) => f.name === name);
      const after = afterFns.find((f) => f.name === name);
      if (!after && unreadable) {
        functionChanges.push({ file: change.path, name, status: "modified", before, signatureChanges: [], contractChanged: false });
        continue;
      }
      const status = before && after ? "modified" : after ? "added" : "removed";
      // Step 5: did the definition line (the contract) change?
      const signatureChanges = before && after ? compareSignatures(before, after) : [];
      const contractChanged = status === "removed" || signatureChanges.some((s) => s.breaking);
      functionChanges.push({ file: change.path, name, status, before, after, signatureChanges, contractChanged });
    }
  }

  // Step 4: map the whole project (as it is now)
  const graph = buildCallGraph(root, listProjectFiles(root), overrides);

  // Step 6: find who calls each function whose contract changed
  const impacts: Impact[] = [];
  for (const change of functionChanges) {
    if (!change.contractChanged) continue;
    const id = `${change.file}#${change.name}`;
    const exact = graph.callersOf(id).map((c) => ({ ...c, certainty: "exact" as const }));
    const possible = change.after ? graph.possibleCallersOf(change.after).map((c) => ({ ...c, certainty: "possible" as const })) : [];
    const calls = [...exact, ...possible].map((c) => ({
      ...c,
      updated: addedLinesByFile.get(c.file)?.has(c.line) ?? false,
      problem: findProblem(c, change),
    }));
    impacts.push({ change, calls });
  }

  return { files, diff: unifiedDiff(files), functionChanges, impacts, topLevelEdits, syntaxErrors, graph };
}

// Mismatches we can prove just by reading the call
function findProblem(call: CallSite, change: FunctionChange): string | undefined {
  const fn = change.after;
  if (!fn) return `calls "${change.name}", which no longer exists`;
  const required = requiredCount(fn);
  const accepts = fn.params.some((p) => p.rest) ? Infinity : fn.params.length;
  if (call.argCount !== null && call.argCount < required) {
    return `passes ${call.argCount} input(s), but "${fn.name}" now needs at least ${required}`;
  }
  if (call.argCount !== null && call.argCount > accepts) {
    return `passes ${call.argCount} input(s), but "${fn.name}" now accepts only ${accepts}`;
  }
  if (fn.async && !change.before?.async && !call.awaited) {
    return `"${fn.name}" is now async, but this call doesn't await it, so it gets a Promise instead of the value`;
  }
  return undefined;
}

// ---------- Step 7: the impact snippet (text the AI reads) ----------

const MAX_FN_LINES = 60;

function fnSource(code: string, fn: FnInfo): string {
  const last = Math.min(fn.endLine, fn.startLine + MAX_FN_LINES - 1);
  const more = fn.endLine > last ? `\n     … (${fn.endLine - last} more lines)` : "";
  return numberedLines(code, fn.startLine, last) + more;
}

function callContext(report: ImpactReport, call: CallSite): string {
  const fi = report.graph.files.get(call.file);
  if (!fi) return "";
  const caller = fi.functions.find((f) => f.id === call.callerId);
  // Show the whole calling function if it's short, otherwise a window around the call
  if (caller && caller.endLine - caller.startLine <= 25) return numberedLines(fi.parsed.code, caller.startLine, caller.endLine);
  return numberedLines(fi.parsed.code, call.line - 5, call.line + 5);
}

export function renderReport(report: ImpactReport, opts: { includeDiff?: boolean; maxDiffLines?: number } = {}): string {
  const { includeDiff = true, maxDiffLines = 400 } = opts;
  if (report.files.length === 0) return "No code changes found.";
  const out: string[] = [];
  const fileByPath = new Map(report.files.map((f) => [f.path, f]));

  out.push("## Files changed");
  for (const f of report.files) {
    const { added, removed } = changedLines(f);
    const state = !f.before ? " (new file)" : !f.after ? " (deleted)" : "";
    out.push(`- ${f.path}${state}: ${added.length} line(s) added, ${removed.length} removed`);
  }

  if (report.syntaxErrors.length) {
    out.push("\n## Syntax errors (the code can't even be read)");
    for (const e of report.syntaxErrors) out.push(`- ${e.file}: ${e.message}`);
  }

  out.push("\n## Functions changed");
  if (!report.functionChanges.length) out.push("(none: edits were outside functions)");
  for (const fc of report.functionChanges) {
    const fn = fc.after ?? fc.before!;
    out.push(`\n### ${fc.name} (${fc.file}, line ${fn.startLine}) [${fc.status}]`);
    if (fc.before) out.push(`Definition before: ${fc.before.signatureText}`);
    if (fc.after) out.push(`Definition after:  ${fc.after.signatureText}`);
    if (fc.signatureChanges.length) {
      out.push(fc.contractChanged ? "CONTRACT CHANGED:" : "Signature changes (not breaking):");
      for (const s of fc.signatureChanges) out.push(`- ${s.breaking ? "[BREAKING] " : ""}${fc.name} ${s.description}`);
    } else if (fc.status === "modified" && !fc.after) {
      out.push("Can't read the new version of this function because the file has a syntax error (see above).");
    } else if (fc.status === "modified") {
      out.push("Contract unchanged: only the inside of the function changed.");
    }
    const code = fc.after ? fileByPath.get(fc.file)!.after : fileByPath.get(fc.file)!.before;
    const label = fc.after ? "now" : fc.status === "removed" ? "before it was removed" : "before the edit";
    out.push(`Code ${label}:\n${fnSource(code, fn)}`);
  }

  if (report.topLevelEdits.length) {
    out.push("\n## Edits outside any function");
    for (const t of report.topLevelEdits) out.push(`- ${t.file}: lines ${t.lines.join(", ")}`);
  }

  out.push("\n## Impacted code (callers of functions whose contract changed)");
  if (!report.impacts.length) out.push("(no contract changes, so no callers can break from the signature)");
  for (const { change, calls } of report.impacts) {
    const files = [...new Set(calls.map((c) => c.file))];
    out.push(`\n### Callers of ${change.name}: ${calls.length} call(s) in ${files.length} file(s)${files.length ? `: ${files.join(", ")}` : ""}`);
    if (!calls.length) out.push("(no callers found in the project)");
    for (const c of calls) {
      const caller = c.callerId ? c.callerId.split("#")[1] : "top-level code";
      const tags = [
        c.certainty === "possible" ? "POSSIBLE match (same method name, class not confirmed)" : "",
        c.updated ? "updated in this change" : "",
        c.problem ? `PROBLEM: ${c.problem}` : "",
      ].filter(Boolean);
      out.push(`- ${c.file}:${c.line} in ${caller}: ${c.callee}(…) with ${c.argCount ?? "unknown"} input(s)${tags.length ? ` [${tags.join("; ")}]` : ""}`);
      out.push(callContext(report, c));
    }
  }

  if (includeDiff) {
    const lines = report.diff.split("\n");
    const shown = lines.slice(0, maxDiffLines).join("\n");
    out.push(`\n## Diff\n\`\`\`diff\n${shown}${lines.length > maxDiffLines ? `\n… (${lines.length - maxDiffLines} more lines)` : ""}\n\`\`\``);
  }

  return out.join("\n");
}

/** Problems that still need fixing: callers that break, or code that won't parse */
export function openProblems(report: ImpactReport): string[] {
  const problems = report.syntaxErrors.map((e) => `${e.file}: syntax error: ${e.message}`);
  for (const { calls } of report.impacts) {
    for (const c of calls) if (c.problem && c.certainty === "exact") problems.push(`${c.file}:${c.line}: ${c.problem}`);
  }
  return problems;
}
