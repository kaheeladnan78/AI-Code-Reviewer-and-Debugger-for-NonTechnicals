// Step 1: find which files and lines changed
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createTwoFilesPatch, structuredPatch } from "diff";
import { isCodeFile } from "./parse.js";

export type FileChange = {
  path: string; // relative to the project root, with "/" separators
  before: string; // "" if the file is new
  after: string; // "" if the file was deleted
};

export type ChangedLines = {
  added: number[]; // line numbers in the new version
  removed: number[]; // line numbers in the old version
};

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 50_000_000 });
}

export function isGitRepo(root: string): boolean {
  try {
    return git(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Changes since the last commit: what the user edited that may have caused the bug.
 * Returns null if this isn't a git project or there are no commits yet.
 */
export function changesSinceLastCommit(root: string): FileChange[] | null {
  if (!isGitRepo(root)) return null;
  try {
    git(root, ["rev-parse", "HEAD"]);
  } catch {
    return null; // no commits yet, so nothing to compare against
  }
  const prefix = git(root, ["rev-parse", "--show-prefix"]).trim(); // when root is a subfolder of the repo
  const tracked = git(root, ["diff", "--name-only", "--relative", "HEAD"]).split("\n");
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]).split("\n");

  const paths = [...new Set([...tracked, ...untracked])].filter((p) => p && isCodeFile(p));
  return paths.map((path) => {
    let before = "";
    try {
      before = git(root, ["show", `HEAD:${prefix}${path}`]);
    } catch {
      // new file
    }
    return { path, before, after: readOrEmpty(join(root, path)) };
  });
}

/** Changes compared to saved copies of files (used for the agent's own fix) */
export function changesFromSnapshots(root: string, originals: Map<string, string>): FileChange[] {
  const out: FileChange[] = [];
  for (const [path, before] of originals) {
    const after = readOrEmpty(join(root, path));
    if (after !== before) out.push({ path, before, after });
  }
  return out;
}

export function changedLines(change: FileChange): ChangedLines {
  const patch = structuredPatch(change.path, change.path, change.before, change.after, "", "", { context: 0 });
  const added: number[] = [];
  const removed: number[] = [];
  for (const hunk of patch.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added.push(newLine++);
      else if (line.startsWith("-")) removed.push(oldLine++);
      else if (!line.startsWith("\\")) {
        oldLine++;
        newLine++;
      }
    }
  }
  return { added, removed };
}

/** A standard "git diff" style view of the change */
export function unifiedDiff(changes: FileChange[]): string {
  return changes
    .map((c) =>
      createTwoFilesPatch(c.before ? `a/${c.path}` : "/dev/null", c.after ? `b/${c.path}` : "/dev/null", c.before, c.after, "", "", {
        context: 3,
      })
        .split("\n")
        .filter((line) => !line.startsWith("====")) // drop the separator line jsdiff adds
        .join("\n")
    )
    .join("\n");
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", ".next", ".git", "vendor"]);

/** Every code file in the project (respects .gitignore when the project uses git) */
export function listProjectFiles(root: string): string[] {
  if (isGitRepo(root)) {
    return git(root, ["ls-files", "--cached", "--others", "--exclude-standard"])
      .split("\n")
      .filter((p) => p && isCodeFile(p) && existsSync(join(root, p)) && !p.split("/").some((part) => SKIP_DIRS.has(part)));
  }
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) visit(full);
      else if (isCodeFile(entry) && stat.size < 1_000_000) files.push(relative(root, full).split(sep).join("/"));
    }
  };
  visit(root);
  return files;
}
