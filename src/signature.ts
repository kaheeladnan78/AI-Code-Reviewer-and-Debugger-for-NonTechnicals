// Step 5: compare a function's old and new signature to spot "contract" changes.
// A contract is the promise a function makes to its callers: what inputs it needs and what it gives back.
import { type FnInfo, requiredCount } from "./functions.js";

export type SignatureChange = {
  breaking: boolean; // can this break code that calls the function?
  description: string; // plain English
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function compareSignatures(before: FnInfo, after: FnInfo): SignatureChange[] {
  const changes: SignatureChange[] = [];
  const add = (breaking: boolean, description: string) => changes.push({ breaking, description });

  const reqBefore = requiredCount(before);
  const reqAfter = requiredCount(after);
  if (reqAfter > reqBefore) {
    const added = after.params.slice(before.params.length).filter((p) => p.required).map((p) => `"${p.name}"`);
    const which = added.length ? ` (new: ${added.join(", ")})` : "";
    add(true, `now needs at least ${plural(reqAfter, "input")}${which}, before it needed ${reqBefore}. Callers passing fewer will be missing values.`);
  } else if (reqAfter < reqBefore) {
    add(false, `now needs only ${plural(reqAfter, "required input")} (before: ${reqBefore}).`);
  }

  const total = (fn: FnInfo) => fn.params.filter((p) => !p.rest).length;
  const restBefore = before.params.some((p) => p.rest);
  const restAfter = after.params.some((p) => p.rest);
  if (total(after) < total(before) && !restAfter) {
    add(true, `accepts fewer inputs now (${total(after)} instead of ${total(before)}). Extra values callers pass will be ignored or land in the wrong place.`);
  }
  if (restBefore && !restAfter) add(true, `no longer accepts "any number of" extra inputs (the ...rest parameter was removed).`);
  if (!restBefore && restAfter) add(false, `now accepts any number of extra inputs (a ...rest parameter was added).`);

  const shared = Math.min(before.params.length, after.params.length);
  let reorderReported = false;
  for (let i = 0; i < shared; i++) {
    const a = before.params[i];
    const b = after.params[i];
    const position = `input #${i + 1}`;

    if (a.name !== b.name) {
      // Renaming a plain parameter doesn't affect callers; renaming a { destructured } key does
      if (a.keys || b.keys) {
        add(true, `${position} expects different named fields: ${a.name} → ${b.name}.`);
      } else if (before.params.some((p) => p.name === b.name)) {
        if (!reorderReported) {
          const order = (fn: FnInfo) => fn.params.map((p) => p.name).join(", ");
          add(true, `inputs were reordered: (${order(before)}) → (${order(after)}). Callers pass values by position, so they may now be swapped.`);
          reorderReported = true;
        }
      } else {
        add(false, `${position} renamed from "${a.name}" to "${b.name}" (callers are unaffected).`);
      }
    } else if (a.keys && b.keys && a.keys.join() !== b.keys.join()) {
      add(true, `${position} expects different named fields: { ${a.keys.join(", ")} } → { ${b.keys.join(", ")} }.`);
    }

    if ((a.type ?? "") !== (b.type ?? "")) {
      add(true, `${position} ("${b.name}") changed type: ${a.type ?? "(none)"} → ${b.type ?? "(none)"}.`);
    }
    if (a.hasDefault && !b.hasDefault && b.required) add(true, `${position} ("${b.name}") lost its default value, so callers must now pass it.`);
  }

  for (const p of after.params.slice(shared)) {
    if (!p.rest && !p.required) add(false, `new optional input "${p.name}" was added.`);
  }
  for (const p of before.params.slice(shared)) {
    if (!p.rest) add(true, `input "${p.name}" was removed.`);
  }

  if (before.async !== after.async) {
    add(
      true,
      after.async
        ? `became async: it now returns a Promise (a "result that arrives later"). Callers must use await to get the actual value.`
        : `is no longer async: callers using await or .then() on it may behave differently.`
    );
  }
  if (before.generator !== after.generator) add(true, `changed whether it is a generator function.`);
  if ((before.returnType ?? "") !== (after.returnType ?? "")) {
    add(true, `return type changed: ${before.returnType ?? "(none)"} → ${after.returnType ?? "(none)"}.`);
  }

  return changes;
}
