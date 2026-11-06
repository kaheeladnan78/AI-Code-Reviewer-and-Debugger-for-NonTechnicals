// How risky is a proposed edit? Analysed before anything is written, using the same
// change → signature → callers pipeline as the impact report.
import { analyzeChanges, openProblems } from "../impact.js";
import type { Risk, RiskLevel } from "./types.js";

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

export function assessEdit(root: string, path: string, before: string, after: string): Risk {
  const report = analyzeChanges(root, [{ path, before, after }], new Map([[path, after]]));
  let level: RiskLevel = "low";
  const reasons: string[] = [];
  const raise = (to: RiskLevel, reason: string) => {
    if (RANK[to] > RANK[level]) level = to;
    reasons.push(reason);
  };

  for (const e of report.syntaxErrors) raise("high", `Leaves a syntax error, so the file can't run: ${e.message}`);

  const broken = openProblems(report).filter((p) => !p.includes("syntax error"));
  if (broken.length) {
    raise("high", `Would break ${broken.length} place(s) that use this code: ${broken.slice(0, 3).join("; ")}${broken.length > 3 ? "…" : ""}`);
  }

  for (const fc of report.functionChanges) {
    if (fc.status === "removed") {
      raise("medium", `Removes the function "${fc.name}".`);
    } else if (fc.contractChanged) {
      const what = fc.signatureChanges.filter((s) => s.breaking).map((s) => s.description);
      raise("medium", `Changes the definition (contract) of "${fc.name}": ${what.join(" ")}`);
    } else if (fc.status === "added") {
      raise("low", `Adds a new function "${fc.name}".`);
    }
  }

  const possible = report.impacts.flatMap((i) => i.calls.filter((c) => c.certainty === "possible" && c.problem));
  if (possible.length) raise("medium", `May affect ${possible.length} other call(s) with the same method name.`);

  // A syntax error hides where functions are, so edits can look "outside" them
  if (report.topLevelEdits.length && !report.syntaxErrors.length) {
    raise("medium", "Changes code outside any function (it runs as soon as the file loads, e.g. imports or settings).");
  }

  if (!reasons.length) {
    const names = report.functionChanges.map((f) => `"${f.name}"`).join(", ");
    reasons.push(`Only changes the inside of ${names || "the code"}. Other code uses it the same way as before.`);
  }

  return { level, reasons };
}
