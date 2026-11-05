// Turns source code into an ESTree syntax tree (works for JavaScript and TypeScript)
import { parseSync } from "oxc-parser";
import { extname } from "node:path";

export const CODE_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".gs"];

export function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.includes(extname(path)) && !path.endsWith(".d.ts");
}

// ESTree nodes all have a type and a start/end character offset
export type AstNode = { type: string; start: number; end: number; [key: string]: any };

export type ParsedFile = {
  path: string;
  code: string;
  program: AstNode;
  errors: string[];
  lineStarts: number[];
};

function langFor(path: string): "js" | "jsx" | "ts" | "tsx" {
  const ext = extname(path);
  if (ext === ".tsx") return "tsx";
  if ([".ts", ".mts", ".cts"].includes(ext)) return "ts";
  if (ext === ".jsx") return "jsx";
  return "js"; // .js, .mjs, .cjs, .gs (Google Apps Script)
}

export function parseFile(path: string, code: string): ParsedFile | null {
  try {
    const result = parseSync(path, code, { lang: langFor(path) });
    const lineStarts = [0];
    for (let i = 0; i < code.length; i++) if (code[i] === "\n") lineStarts.push(i + 1);
    return {
      path,
      code,
      program: result.program as unknown as AstNode,
      errors: result.errors.map((e) => e.message),
      lineStarts,
    };
  } catch {
    return null;
  }
}

// Character offset → 1-based line number
export function lineOf(file: ParsedFile, offset: number): number {
  let lo = 0;
  let hi = file.lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (file.lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export function isNode(value: unknown): value is AstNode {
  return !!value && typeof value === "object" && typeof (value as any).type === "string";
}

// Visit every node, passing the chain of parent nodes (closest parent last)
export function walk(root: AstNode, enter: (node: AstNode, ancestors: AstNode[]) => void): void {
  const ancestors: AstNode[] = [];
  const visit = (node: AstNode) => {
    enter(node, ancestors);
    ancestors.push(node);
    for (const key in node) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) visit(child);
      } else if (isNode(value)) {
        visit(value);
      }
    }
    ancestors.pop();
  };
  visit(root);
}

// Source lines with line numbers, for showing code to the AI
export function numberedLines(code: string, fromLine: number, toLine: number): string {
  const lines = code.split("\n");
  const out: string[] = [];
  for (let n = Math.max(1, fromLine); n <= Math.min(lines.length, toLine); n++) {
    out.push(`${String(n).padStart(4)} | ${lines[n - 1]}`);
  }
  return out.join("\n");
}
