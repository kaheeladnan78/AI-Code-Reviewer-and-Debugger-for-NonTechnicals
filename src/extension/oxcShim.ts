// oxc-parser only ships as an ES module, but VS Code loads extensions as CommonJS.
// The extension bundle points "oxc-parser" at this file (see esbuild.mjs), and activate()
// loads the real parser with a dynamic import before anything parses code.
type Oxc = typeof import("oxc-parser");

let oxc: Oxc | undefined;

export async function loadParser(): Promise<void> {
  const name = "oxc-parser"; // a variable, so the bundler leaves this import alone
  oxc = (await import(name)) as Oxc;
}

export const parseSync: Oxc["parseSync"] = (...args) => {
  if (!oxc) throw new Error("Parser not loaded yet");
  return oxc.parseSync(...args);
};
