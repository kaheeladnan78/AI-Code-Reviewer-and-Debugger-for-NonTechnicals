// Bundles the extension into one CommonJS file VS Code can load.
// Usage: node esbuild.mjs [--watch]
import * as esbuild from "esbuild";

const options = {
  entryPoints: ["src/extension/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "dist/extension.cjs",
  sourcemap: true,
  external: ["vscode"],
  // oxc-parser is an ES module with a native binary: load it at runtime instead of bundling it
  alias: { "oxc-parser": "./src/extension/oxcShim.ts" },
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
