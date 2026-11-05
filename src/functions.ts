// Steps 2–3: find every named function in a file, its definition line, and its signature
import { type AstNode, type ParsedFile, lineOf, walk } from "./parse.js";

export type Param = {
  text: string; // exactly as written, e.g. "taxRate: number = 0.2"
  name: string; // e.g. "taxRate" or "{ id, name }"
  required: boolean; // must a caller pass it?
  rest: boolean; // "...items"
  hasDefault: boolean;
  type?: string; // TypeScript type, if written
  keys?: string[]; // for "{ id, name }" style params: the property names the caller must supply
};

export type FnInfo = {
  id: string; // "src/cart.ts#Cart.addItem" — unique across the project
  file: string;
  name: string; // "calculateTotal", "Cart.addItem", "default"
  start: number;
  end: number;
  startLine: number; // the definition line
  endLine: number;
  bodyStartLine: number;
  signatureText: string; // the definition line(s), whitespace tidied
  params: Param[];
  async: boolean;
  generator: boolean;
  returnType?: string;
  isClass: boolean; // a class constructor ("Cart.constructor")
};

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function keyName(key: AstNode | undefined): string | undefined {
  if (!key) return undefined;
  if (key.type === "Identifier") return key.name;
  if (key.type === "PrivateIdentifier") return `#${key.name}`;
  if (key.type === "Literal") return String(key.value);
  return undefined;
}

// "module.exports.foo" → ["module","exports","foo"]
export function memberPath(node: AstNode | undefined): string[] | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier") return [node.name];
  if (node.type === "ThisExpression") return ["this"];
  if (node.type === "MemberExpression" && !node.computed) {
    const left = memberPath(node.object);
    const right = keyName(node.property);
    return left && right ? [...left, right] : undefined;
  }
  return undefined;
}

function className(ancestors: AstNode[]): string | undefined {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a.type === "ClassDeclaration" || a.type === "ClassExpression") {
      if (a.id?.name) return a.id.name;
      const parent = ancestors[i - 1];
      if (parent?.type === "VariableDeclarator") return parent.id?.name;
      return "(class)";
    }
  }
  return undefined;
}

// Work out a function's name from where it sits. Unnamed callbacks return undefined.
function nameFor(node: AstNode, ancestors: AstNode[]): { name: string; outer: AstNode } | undefined {
  const parent = ancestors[ancestors.length - 1];
  const grand = ancestors[ancestors.length - 2];

  if (node.type === "FunctionDeclaration" && node.id?.name) {
    return { name: node.id.name, outer: parent?.type?.startsWith("Export") ? parent : node };
  }
  if (!parent) return undefined;

  if (parent.type === "ExportDefaultDeclaration") return { name: "default", outer: parent };

  if (parent.type === "VariableDeclarator" && parent.id?.type === "Identifier") {
    // const add = (a, b) => ...   (include "export const" in the definition line)
    const decl = grand;
    const exp = ancestors[ancestors.length - 3];
    const outer = exp?.type === "ExportNamedDeclaration" ? exp : decl ?? parent;
    return { name: parent.id.name, outer };
  }

  if (parent.type === "MethodDefinition" || parent.type === "TSAbstractMethodDefinition") {
    const cls = className(ancestors) ?? "(class)";
    return { name: `${cls}.${keyName(parent.key) ?? "(computed)"}`, outer: parent };
  }

  if (parent.type === "PropertyDefinition") {
    const cls = className(ancestors) ?? "(class)";
    return { name: `${cls}.${keyName(parent.key) ?? "(computed)"}`, outer: parent };
  }

  if (parent.type === "Property" && parent.value === node) {
    const key = keyName(parent.key);
    if (!key) return undefined;
    // const utils = { format() {} }  →  "utils.format"
    const obj = grand;
    const holder = ancestors[ancestors.length - 3];
    if (obj?.type === "ObjectExpression" && holder?.type === "VariableDeclarator" && holder.id?.name) {
      return { name: `${holder.id.name}.${key}`, outer: parent };
    }
    return { name: key, outer: parent };
  }

  if (parent.type === "AssignmentExpression" && parent.right === node) {
    const path = memberPath(parent.left);
    if (!path) return undefined;
    // module.exports = function () {}  →  "default"
    if (path.join(".") === "module.exports") return { name: "default", outer: parent };
    // exports.foo = ... / module.exports.foo = ...  →  "foo"
    if (path[0] === "exports" && path.length === 2) return { name: path[1], outer: parent };
    if (path[0] === "module" && path[1] === "exports" && path.length === 3) return { name: path[2], outer: parent };
    return { name: path.join("."), outer: parent };
  }

  return undefined;
}

function readParam(p: AstNode, code: string): Param | undefined {
  let node = p;
  if (node.type === "TSParameterProperty") node = node.parameter; // constructor(private x: number)
  const text = code.slice(p.start, p.end);

  let rest = false;
  let hasDefault = false;
  let target = node;
  if (node.type === "RestElement") {
    rest = true;
    target = node.argument;
  } else if (node.type === "AssignmentPattern") {
    hasDefault = true;
    target = node.left;
  }
  if (target?.type === "Identifier" && target.name === "this") return undefined; // TS-only, callers never pass it

  const typeNode = node.typeAnnotation ?? target?.typeAnnotation;
  const nameEnd = typeNode ? typeNode.start : target.end;
  const name = code.slice(target.start, nameEnd).replace(/\?\s*$/, "").trim();
  const optional = !!(node.optional || target?.optional);

  let keys: string[] | undefined;
  if (target?.type === "ObjectPattern") {
    keys = target.properties
      .filter((prop: AstNode) => prop.type === "Property")
      .map((prop: AstNode) => keyName(prop.key) ?? "?");
  }

  return {
    text,
    name,
    required: !rest && !hasDefault && !optional,
    rest,
    hasDefault,
    type: typeNode?.typeAnnotation ? code.slice(typeNode.typeAnnotation.start, typeNode.typeAnnotation.end) : undefined,
    keys,
  };
}

export function listFunctions(file: ParsedFile): FnInfo[] {
  const { code } = file;
  const found: FnInfo[] = [];
  const seen = new Map<string, number>();

  walk(file.program, (node, ancestors) => {
    if (!FUNCTION_TYPES.has(node.type) || !node.body) return;
    const named = nameFor(node, ancestors);
    if (!named) return;

    let name = named.name;
    const isClass = name.endsWith(".constructor");
    // Two functions with the same name in one file: tell them apart by line
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count > 0) name = `${name}@${lineOf(file, node.start)}`;

    const start = named.outer.start;
    const end = Math.max(named.outer.end, node.end);
    const signatureText = code
      .slice(start, node.body.start)
      .replace(/\s+/g, " ")
      .replace(/\s*(=>)?\s*\{?\s*$/, (m) => (m.includes("=>") ? " =>" : ""))
      .trim();

    found.push({
      id: `${file.path}#${name}`,
      file: file.path,
      name,
      start,
      end,
      startLine: lineOf(file, start),
      endLine: lineOf(file, end),
      bodyStartLine: lineOf(file, node.body.start),
      signatureText,
      params: node.params.map((p: AstNode) => readParam(p, code)).filter(Boolean) as Param[],
      async: !!node.async,
      generator: !!node.generator,
      returnType: node.returnType?.typeAnnotation
        ? code.slice(node.returnType.typeAnnotation.start, node.returnType.typeAnnotation.end)
        : undefined,
      isClass,
    });
  });

  return found;
}

// The innermost named function that contains a character offset
export function enclosingFunction(fns: FnInfo[], offset: number): FnInfo | undefined {
  let best: FnInfo | undefined;
  for (const fn of fns) {
    if (fn.start <= offset && offset < fn.end && (!best || fn.end - fn.start < best.end - best.start)) best = fn;
  }
  return best;
}

// The innermost named function that contains a line
export function functionAtLine(fns: FnInfo[], line: number): FnInfo | undefined {
  let best: FnInfo | undefined;
  for (const fn of fns) {
    if (fn.startLine <= line && line <= fn.endLine && (!best || fn.endLine - fn.startLine < best.endLine - best.startLine)) {
      best = fn;
    }
  }
  return best;
}

export function requiredCount(fn: FnInfo): number {
  return fn.params.filter((p) => p.required).length;
}
