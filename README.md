# DebugWise

**An AI debugger that teaches.** DebugWise is a VS Code extension for people who build with code but never formally learned it. It finds and fixes bugs with your approval, then explains in plain English what went wrong and teaches the programming concept behind it, so each bug leaves you understanding your code a little better.

<p align="center">
  <img src="docs/screenshot.png" alt="DebugWise chat panel: an approved low-risk edit with an inline diff, a high-risk edit waiting for approval, a command card, and an explanation with an open Lesson block" width="620">
</p>

## Why

AI coding tools can fix bugs, but they leave non-programmers with a fixed file and no idea what happened. DebugWise is built around two goals:

1. **Debug safely.** Nothing changes without your approval, and every change shows its risk and can be undone.
2. **Teach.** Every fix ends with a short lesson tied to your own code: the concept, an everyday analogy, key terms and a question to check your understanding.

## What it does

- **Chat in the sidebar.** Describe a bug in your own words, e.g. "my total shows NaN".
- **Shows its work.** Activity rows show each file it reads (and which lines), files it lists and checks it runs. File names are clickable.
- **Edit cards with a risk level.** Before any file is written you see the function being changed, an inline diff and a **Low / Medium / High** risk rating with reasons, plus a button to open VS Code's side-by-side diff. The file is only written after you click **Approve**.
- **Command cards.** Known project checks such as tests can run automatically; any other command is shown exactly as it will run and waits for your approval.
- **Undo per edit.** Each applied edit has an **Undo this change** button.
- **A coding lesson after every fix,** in a collapsible block.
- **Streaming replies** and a **token meter** so you can see usage as you go.

## How it works

Rather than letting the AI wander the codebase, DebugWise first works out the facts itself, then gives the AI a grounded package to reason over.

```
your edits ─► 1. which lines changed (git diff)
             2–3. which functions they're in (parsed into an ESTree syntax tree)
             4. call graph: every place in the project that calls what
             5. did a function's definition line change? (a "contract" change)
             6. which callers a contract change could break
             7. impact snippet: changed code + affected callers, with line numbers
                       │
                       ▼
             8. AI agent fixes the bug (each edit, and any unrecognized command, needs your approval),
                and re-checks impact on its own edits until nothing is left broken
                       │
                       ▼
             9. AI explanation in plain English + a lesson
```

**Contract changes** are the heart of it. If a function goes from `calculateTotal(items)` to `calculateTotal(items, taxRate)`, every caller still passing one input is now broken, often in a different file from the one you edited. DebugWise finds those callers from the code itself before the AI is involved, flags proven mismatches (e.g. *"passes 1 input, but calculateTotal now needs 2"*) and uses the same check to rate the risk of each proposed edit.

Supports **JavaScript and TypeScript** (`.js .jsx .mjs .cjs .ts .tsx .mts .cts`, plus Google Apps Script `.gs`), including ES `import`/`export`, CommonJS `require`/`module.exports` and re-exports.

## Getting started

**You'll need:** VS Code 1.90 or newer, Node.js 20 or newer and an [OpenAI API key](https://platform.openai.com/api-keys).

```bash
git clone https://github.com/kaheeladnan78/AI-Code-Reviewer-and-Debugger-for-NonTechnicals.git
cd AI-Code-Reviewer-and-Debugger-for-NonTechnicals
npm install
npm run build
```

Then:

1. Open the folder in VS Code and press **F5**, or go to **Run and Debug**, pick **Run AI Debugger on demo folder** and click ▶. A second VS Code window opens with the extension loaded.
2. Click the **robot icon** in the left bar to open DebugWise.
3. Click the **key icon** at the top of the panel and paste your OpenAI API key. It's kept in VS Code's secure storage, never in your project.
4. Describe a bug.

To work on your own project, open its folder in that second window (**File → Open Folder…**). DebugWise works on whichever folder is open. It's easiest to test on a copy, or on a git branch.

**Settings:** `aiDebugger.model` chooses the OpenAI model (default `gpt-5.5`).

**Development scripts:** `npm run build` bundles the extension into `dist/`, `npm run watch` rebuilds on every change, and `npm run typecheck` runs the TypeScript check.

### Command-line version

The same agent also runs in a terminal, with y/n prompts in place of buttons:

```bash
echo "OPENAI_API_KEY=sk-..." > .env
npm run cli -- --dir path/to/project "describe the bug"
```

Leave out the description to have it check your changes since the last commit.

## Safety and limitations

- File edits are limited to the open project folder, each one needs approval, and an edit is refused if the file changed while waiting or has unsaved changes.
- Commands run with your user's permissions and stop after 60 seconds, so read each one before approving it. Undo reverses edits, not the side effects of commands.
- The call graph is built by reading code, not running it, so dynamically called functions can be missed. The AI can't see your running app; re-test fixes there.

See the [technical specification](docs/TECHNICAL_SPEC.md#approval-data-boundaries-and-undo) for the full safety model.

## Documentation

- [Product requirements (PRD)](docs/PRD.md): the problem, target users, goals and success measures, and the launch plan.
- [Technical specification](docs/TECHNICAL_SPEC.md): architecture, tools, static analysis and risk scoring, approvals and data handling, the lesson format, and evaluation.

## License

[ISC](LICENSE)
