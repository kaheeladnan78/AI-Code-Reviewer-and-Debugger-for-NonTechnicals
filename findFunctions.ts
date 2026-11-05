import * as acorn from "acorn";
import * as walk from "acorn-walk";

type FnHit = { name: string; start: number; end: number; line: number };

function parseCode(code: string): acorn.Node {
  // Try as an ES module first (supports import/export), then as a plain script (.gs files)
  try {
    return acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", locations: true });
  } catch {
    return acorn.parse(code, { ecmaVersion: "latest", sourceType: "script", locations: true });
  }
}

export function findEnclosingFunctions(
  code: string,
  changeStart: number,
  changeEnd: number
): FnHit[] {
  const ast = parseCode(code);
  const hits: FnHit[] = [];

  walk.ancestor(ast, {
    Function(node: any, _state: unknown, ancestors: any[]) {
      // Does this function contain the whole change?
      if (node.start > changeStart || node.end < changeEnd) return;

      // Work out a name (arrow functions and anonymous ones get it from their parent)
      const parent = ancestors[ancestors.length - 2];
      let name: string | undefined = node.id?.name;
      if (!name && parent?.type === "VariableDeclarator") name = parent.id?.name;
      if (!name && (parent?.type === "MethodDefinition" || parent?.type === "Property")) {
        name = parent.key?.name;
      }

      hits.push({
        name: name ?? "(anonymous function)",
        start: node.start,
        end: node.end,
        line: node.loc.start.line,
      });
    },
  });

  // Innermost function first (smallest range)
  return hits.sort((a, b) => a.end - a.start - (b.end - b.start));
}