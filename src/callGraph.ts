// Step 4: scan every project file and build a map of who calls what
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { type AstNode, type ParsedFile, lineOf, parseFile, walk } from "./parse.js";
import { type FnInfo, enclosingFunction, listFunctions, memberPath } from "./functions.js";

type ImportBinding = { from: string | null; imported: string }; // imported: "default", "*", or a name
type ExportBinding = { local?: string; from?: string | null; imported?: string };

export type CallSite = {
  file: string;
  line: number;
  callee: string; // as written: "calculateTotal", "utils.format", "new Cart"
  calleeId: string | null; // the function it resolves to ("src/cart.ts#calculateTotal"), if known
  methodName?: string; // for obj.method() calls we can't resolve exactly
  argCount: number | null; // null when it uses ...spread
  awaited: boolean; // wrapped in await, or followed by .then()
  callerId: string | null; // the function this call sits inside (null = top level)
  start: number;
  end: number;
};

export type FileIndex = {
  path: string;
  parsed: ParsedFile;
  functions: FnInfo[];
  imports: Map<string, ImportBinding>;
  exports: Map<string, ExportBinding>;
  starExports: (string | null)[];
};

export type CallGraph = {
  files: Map<string, FileIndex>;
  calls: CallSite[];
  callersOf(id: string): CallSite[];
  possibleCallersOf(fn: FnInfo): CallSite[];
};

// Turn "./cart.js" into a real project file such as "src/cart.ts"
function resolveModule(fromFile: string, spec: string, known: Set<string>): string | null {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null; // a package like "openai", not our code
  const base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".gs"];
  const candidates = [base, ...exts.map((e) => base + e), ...exts.map((e) => `${base}/index${e}`)];
  // TypeScript lets you write "./cart.js" for cart.ts
  const swap: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };
  for (const [from, tos] of Object.entries(swap)) {
    if (base.endsWith(from)) for (const to of tos) candidates.push(base.slice(0, -from.length) + to);
  }
  return candidates.find((c) => known.has(c)) ?? null;
}

function stringArg(node: AstNode | undefined): string | undefined {
  return node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

function isRequire(node: AstNode | undefined): string | undefined {
  if (node?.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "require") {
    return stringArg(node.arguments[0]);
  }
  return undefined;
}

function indexFile(parsed: ParsedFile, known: Set<string>): FileIndex {
  const path = parsed.path;
  const imports = new Map<string, ImportBinding>();
  const exports = new Map<string, ExportBinding>();
  const starExports: (string | null)[] = [];
  const nameOf = (n: AstNode | undefined) => (n?.type === "Identifier" ? n.name : stringArg(n));

  walk(parsed.program, (node, ancestors) => {
    const parent = ancestors[ancestors.length - 1];

    // import { a as b } from "./x"   |   import x from "./x"   |   import * as ns from "./x"
    if (node.type === "ImportDeclaration" && node.importKind !== "type") {
      const from = resolveModule(path, node.source.value, known);
      for (const s of node.specifiers) {
        if (s.importKind === "type") continue;
        if (s.type === "ImportSpecifier") imports.set(s.local.name, { from, imported: nameOf(s.imported) ?? s.local.name });
        if (s.type === "ImportDefaultSpecifier") imports.set(s.local.name, { from, imported: "default" });
        if (s.type === "ImportNamespaceSpecifier") imports.set(s.local.name, { from, imported: "*" });
      }
    }

    // const x = require("./x")   |   const { a, b: c } = require("./x")
    if (node.type === "VariableDeclarator") {
      const spec = isRequire(node.init);
      if (spec) {
        const from = resolveModule(path, spec, known);
        if (node.id.type === "Identifier") imports.set(node.id.name, { from, imported: "*" });
        if (node.id.type === "ObjectPattern") {
          for (const prop of node.id.properties) {
            if (prop.type === "Property" && prop.value?.type === "Identifier") {
              imports.set(prop.value.name, { from, imported: nameOf(prop.key) ?? prop.value.name });
            }
          }
        }
      }
    }

    // export function f / export const f / export class C
    if (node.type === "ExportNamedDeclaration" && node.exportKind !== "type") {
      const d = node.declaration;
      if (d?.id?.name) exports.set(d.id.name, { local: d.id.name });
      if (d?.type === "VariableDeclaration") {
        for (const v of d.declarations) if (v.id?.type === "Identifier") exports.set(v.id.name, { local: v.id.name });
      }
      // export { a, b as c }   |   export { a } from "./x"
      const from = node.source ? resolveModule(path, node.source.value, known) : undefined;
      for (const s of node.specifiers ?? []) {
        const exported = nameOf(s.exported)!;
        const local = nameOf(s.local)!;
        exports.set(exported, node.source ? { from, imported: local } : { local });
      }
    }
    if (node.type === "ExportAllDeclaration" && !node.exported) {
      starExports.push(resolveModule(path, node.source.value, known));
    }
    if (node.type === "ExportDefaultDeclaration") {
      const d = node.declaration;
      if (d.type === "Identifier") exports.set("default", { local: d.name });
      else if (d.id?.name) exports.set("default", { local: d.id.name });
      else exports.set("default", { local: "default" });
    }

    // CommonJS: module.exports = x  |  module.exports = { a, b }  |  exports.a = ...
    if (node.type === "AssignmentExpression" && parent?.type === "ExpressionStatement") {
      const target = memberPath(node.left)?.join(".");
      if (target === "module.exports") {
        if (node.right.type === "Identifier") exports.set("default", { local: node.right.name });
        if (node.right.type === "ObjectExpression") {
          for (const prop of node.right.properties) {
            const key = nameOf(prop.key);
            if (prop.type === "Property" && key) {
              exports.set(key, { local: prop.value?.type === "Identifier" ? prop.value.name : key });
            }
          }
        }
        if (/Function/.test(node.right.type)) exports.set("default", { local: "default" });
      } else if (target?.startsWith("exports.") || target?.startsWith("module.exports.")) {
        const key = target.split(".").pop()!;
        exports.set(key, { local: node.right.type === "Identifier" ? node.right.name : key });
      }
    }
  });

  return { path, parsed, functions: listFunctions(parsed), imports, exports, starExports };
}

export function buildCallGraph(root: string, files: string[], overrides = new Map<string, string>()): CallGraph {
  const known = new Set(files);
  const index = new Map<string, FileIndex>();
  for (const path of files) {
    let code: string;
    try {
      code = overrides.get(path) ?? readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    const parsed = parseFile(path, code);
    if (parsed) index.set(path, indexFile(parsed, known));
  }

  // Follow an exported name to the file and local name where it's actually defined
  const resolveExport = (file: string | null, name: string, depth = 0): { file: string; name: string } | null => {
    if (!file || depth > 10) return null;
    const fi = index.get(file);
    if (!fi) return null;
    const exp = fi.exports.get(name);
    if (exp?.local) return resolveLocal(file, exp.local, depth + 1);
    if (exp && "from" in exp) return resolveExport(exp.from ?? null, exp.imported!, depth + 1);
    for (const star of fi.starExports) {
      const hit = resolveExport(star, name, depth + 1);
      if (hit) return hit;
    }
    return name === "default" ? null : { file, name }; // e.g. exports.foo = function foo() {}
  };

  // A name used in a file → where it's defined (follows imports)
  const resolveLocal = (file: string, name: string, depth = 0): { file: string; name: string } | null => {
    const fi = index.get(file);
    if (!fi) return null;
    const imp = fi.imports.get(name);
    if (imp) return imp.imported === "*" ? null : resolveExport(imp.from, imp.imported, depth + 1);
    return { file, name };
  };

  const fnIdFor = (target: { file: string; name: string } | null, isNew: boolean): string | null => {
    if (!target) return null;
    const fi = index.get(target.file);
    if (isNew) return `${target.file}#${target.name}.constructor`;
    // A function stored under a different variable name, e.g. module.exports = { total: calcTotal }
    if (fi && !fi.functions.some((f) => f.name === target.name)) {
      const viaExport = fi.exports.get(target.name)?.local;
      if (viaExport && viaExport !== target.name) return `${target.file}#${viaExport}`;
    }
    return `${target.file}#${target.name}`;
  };

  const calls: CallSite[] = [];
  for (const fi of index.values()) {
    const { parsed, functions } = fi;
    walk(parsed.program, (node, ancestors) => {
      if (node.type !== "CallExpression" && node.type !== "NewExpression") return;
      if (isRequire(node)) return;
      const isNew = node.type === "NewExpression";
      const callee = node.callee;
      const path = memberPath(callee);
      if (!path) return; // e.g. getHandler()() — can't tell statically

      let calleeId: string | null = null;
      let methodName: string | undefined;

      if (path.length === 1) {
        calleeId = fnIdFor(resolveLocal(fi.path, path[0]), isNew);
      } else if (path[0] === "this" && path.length === 2) {
        // this.method() inside a class
        const caller = enclosingFunction(functions, node.start);
        const cls = caller?.name.includes(".") ? caller.name.split(".")[0] : undefined;
        if (cls) calleeId = `${fi.path}#${cls}.${path[1]}`;
        else methodName = path[1];
      } else if (path.length === 2) {
        const imp = fi.imports.get(path[0]);
        if (imp?.imported === "*") {
          calleeId = fnIdFor(resolveExport(imp.from, path[1]), isNew); // ns.fn() or required.fn()
        } else if (!imp && functions.some((f) => f.name === `${path[0]}.${path[1]}`)) {
          calleeId = `${fi.path}#${path[0]}.${path[1]}`; // utils.format() with utils defined here
        } else {
          methodName = path[1]; // cart.addItem() — the object's class isn't known for sure
        }
      } else {
        methodName = path[path.length - 1];
      }

      const parent = ancestors[ancestors.length - 1];
      const grand = ancestors[ancestors.length - 2];
      const awaited =
        parent?.type === "AwaitExpression" ||
        (parent?.type === "MemberExpression" && ["then", "catch", "finally"].includes(parent.property?.name) && grand?.type === "CallExpression");

      calls.push({
        file: fi.path,
        line: lineOf(parsed, node.start),
        callee: (isNew ? "new " : "") + path.join("."),
        calleeId,
        methodName,
        argCount: node.arguments.some((a: AstNode) => a.type === "SpreadElement") ? null : node.arguments.length,
        awaited,
        callerId: enclosingFunction(functions, node.start)?.id ?? null,
        start: node.start,
        end: node.end,
      });
    });
  }

  return {
    files: index,
    calls,
    callersOf: (id) => calls.filter((c) => c.calleeId === id),
    // For class methods: obj.addItem() calls we couldn't tie to a class, matched by method name
    possibleCallersOf: (fn) => {
      if (!fn.name.includes(".")) return [];
      const method = fn.name.split(".").pop()!.replace(/@\d+$/, "");
      if (method === "constructor") return [];
      return calls.filter((c) => !c.calleeId && c.methodName === method);
    },
  };
}
