// The agent never prints or prompts by itself. It reports everything through these callbacks,
// so the same loop can drive a terminal (agent.ts) or the VS Code chat panel.
import type { Explanation } from "../explain.js";

export type RiskLevel = "low" | "medium" | "high";

export type Risk = {
  level: RiskLevel;
  reasons: string[]; // plain English, e.g. "Would break 2 places that call calculateTotal"
};

/** One block of changed lines, with a little context around it */
export type DiffHunk = {
  oldStart: number;
  newStart: number;
  lines: string[]; // each starts with " " (unchanged), "-" (removed) or "+" (added)
};

export type EditProposal = {
  id: string;
  path: string; // relative to the project root
  functionName: string | null; // null = the edit is outside any function
  risk: Risk;
  before: string; // full file text before this edit
  after: string; // full file text after this edit
  hunks: DiffHunk[]; // just the changed lines, for showing inline
};

/** A step the agent took that doesn't need approval: reading, listing, checking */
export type Activity = {
  kind: "analyze" | "list" | "read" | "check";
  title: string; // e.g. "Read demo/math.js"
  path?: string; // a file the user can click to open
  line?: number; // where to open it
  detail?: string; // optional extra lines, shown collapsed
};

export type CommandProposal = {
  id: string;
  cmd: string; // the exact command that will run
};

export type Usage = { input: number; output: number; total: number };

export type FixResult = {
  explanation: Explanation;
  files: string[];
  editIds: string[]; // the edits this explanation covers
  openProblems: string[]; // anything check_impact still flags after the fix
};

export interface AgentCallbacks {
  /** A chat message: a progress update or an error */
  message(role: "status" | "error", text: string): void;
  /** The agent's reply as it's being written: called with each new piece of text */
  assistantDelta(id: string, delta: string): void;
  /** The agent's reply is complete (full text, in case any pieces were missed) */
  assistantDone(id: string, text: string): void;
  /** A step the agent took (read a file, listed files, checked impact) */
  activity(step: Activity): void;
  /** Ask the user to approve an edit. Resolve true to write the file. */
  approveEdit(edit: EditProposal): Promise<boolean>;
  /** The edit was written to disk */
  editApplied(edit: EditProposal): void;
  /** An approved edit couldn't be written */
  editFailed(edit: EditProposal, reason: string): void;
  /** Ask the user to approve a shell command. Resolve true to run it. */
  approveCommand(command: CommandProposal): Promise<boolean>;
  /** A command finished running */
  commandFinished(id: string, ok: boolean, output: string): void;
  /** The plain-English explanation of the fix, with its lesson */
  fixExplained(result: FixResult): void;
  /** Running token totals for this session */
  usage(usage: Usage): void;
}
