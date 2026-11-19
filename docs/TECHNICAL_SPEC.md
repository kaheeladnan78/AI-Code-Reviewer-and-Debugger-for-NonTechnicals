# DebugWise Technical Specification

**Status** · Working prototype, last updated November 19, 2026. See the [PRD](PRD.md) for scope and pilot gates, and the [README](../README.md) for setup.

## Scope and entry points

| Surface | Entry point | Behavior |
|---|---|---|
| VS Code extension | `src/extension/extension.ts` and `chatView.ts` | Registers the sidebar, new chat, API key, and latest run log commands. Uses the first open workspace folder and requests a folder when none is open. |
| CLI | `agent.ts` | Runs the same session against the selected project directory with terminal approval prompts. With no description it asks the agent to check recent changes. |
| Evaluation | `evals/run.ts` | Runs the same session against fixture projects using test callbacks, or validates the fixtures without AI calls. |

The extension host is TypeScript bundled with esbuild. The sidebar is a vanilla HTML, CSS, and JavaScript webview in `media/`. The repository documents VS Code 1.90+ and Node.js 20+ for development. Its OpenAI Responses API client uses `gpt-5.5` by default with medium reasoning effort. The extension's `aiDebugger.model` setting selects the model for both debugging and lesson generation.

## Architecture and session lifecycle

1. The host creates an `AgentSession` (`src/agent/session.ts`) with a project root, model client, and `AgentCallbacks`. The extension reads the key from VS Code SecretStorage or, as a fallback, `OPENAI_API_KEY`. The CLI uses the environment.
2. The session compares the working tree to `HEAD` when a commit is available. It renders the diff, changed functions, likely affected callers, and concrete issues as context. Missing Git history or analysis failure leaves the conversational flow available. An identical recent-change report is omitted on follow-up turns because the session already holds it.
3. The Responses API receives the conversation history and tool definitions. Streaming deltas reach the sidebar or CLI through callbacks. Each model iteration can request multiple tools, which execute sequentially and return text to the conversation. A run stops when there are no tool calls, on cancellation or error, or at the 30-iteration limit. A separate model call may follow for the lesson.
4. Each applied edit records the first pre-edit version of its file for that run. The agent prompt tells the model to run `check_impact` after editing and address any reported problems. This instruction is prompt-driven. The engine can finish when the model returns no further calls, and unresolved problems are still surfaced in the final fix analysis.
5. If edits leave a net change and the run is not stopped, the host requests the structured lesson and passes the result, changed paths, applied edit IDs, and remaining static findings to the UI. If the lesson request fails, previously approved writes remain on disk.
6. Follow-ups reuse in-memory history and edit records for the active chat. Stop aborts the current run and the extension rejects pending approvals. New Chat clears the extension's active session and proposals. The local log is stored separately.

## Tool interface

| Tool | Parameters | Behavior |
|---|---|---|
| `list_files` | None | Lists supported code files from Git or a workspace walk, with common generated directories excluded. |
| `read_file` | `path`, optional `start_line` and `end_line` | Returns file text or an inclusive, one-based range and emits an activity event. |
| `edit_file` | `path`, `old_string`, `new_string`, `explanation` | Requires exactly one match in an existing file. Builds a before/after proposal, inline diff, risk grade, and function label when available. Writes only after approval and a stale-content check. |
| `run_command` | `cmd`, `explanation` | Classifies the command, optionally requests approval, then runs it in the project directory with an abort signal, a 60-second timeout, and a bounded output buffer. Returns combined output or a failure marker and shows a plain-English result in the UI. |
| `check_impact` | None | Compares the initial snapshots of edited files with disk, analyzes the current fix, and lists remaining parser issues and concrete caller mismatches. |

Tool errors are returned as text. Outputs sent back to the model are capped at 20,000 characters per call. The chat's command output preview and local log excerpts have smaller limits.

## Static analysis and risk

| Stage | Implementation |
|---|---|
| Identify changes | `changes.ts` reads tracked and eligible untracked changes relative to `HEAD`, or diffs the session's pre-edit snapshots against saved files. |
| Parse and locate code | `parse.ts` uses oxc-parser to produce ESTree. `functions.ts` locates and names functions, and maps changes to source ranges. Supported extensions are `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`, and `.gs`; TypeScript declaration files are excluded from discovery. |
| Compare signatures | `signature.ts` looks for changes such as new required inputs, ordering, defaults, rest parameters, types, async or generator status, and annotated return types. These are static compatibility signals. |
| Resolve callers | `callGraph.ts` follows statically resolvable calls, including ES modules, CommonJS, and re-exports. Same-name method matches are marked possible when the receiver cannot be resolved. Dynamic calls may be missed. |
| Generate findings | `impact.ts` renders changed functions, line-numbered evidence, and caller findings. Open problems include syntax errors and concrete mismatches at exact matches. |
| Score proposals | `risk.ts` runs the same analysis on the proposed version before writing. Syntax errors and concrete mismatches raise risk to High. Breaking signature signals, removals, possible mismatches, or top-level changes can raise it to Medium. The highest applicable level wins. |

HTML-embedded scripts fall outside normal analysis. Apps Script source can be parsed locally. Behavior that depends on Google-provided objects must be verified in the hosted environment. Static findings cover the analyzer's model of the code and may miss runtime regressions.

## Approval, data boundaries, and undo

- **Edit approval.** The extension shows the path, function, diff, explanation, and risk reasons before writing. It can open a side-by-side diff automatically using `aiDebugger.openDiffOnProposal`. Declining returns control to the agent without applying the proposal. Approval checks for unsaved editor content, and the engine checks that saved contents still match the preview immediately before writing.
- **Undo.** The active session remembers the exact before and after contents. Reverting a card requires the saved file to match the after version. If edits overlap, undo newer changes first. Undo does not reverse command effects.
- **Command approval.** The classifier uses command text and rules. It can automatically run project tests, checks, and some Node scripts. Those scripts run with the user's permissions and can have side effects. Treat classification as an interaction control. A pilot safety gate should separately verify the effects of automatic checks on representative projects.
- **Filesystem scope.** Direct file tools perform a workspace-relative lexical path check. The implementation does not canonicalize symlinks. Shell execution sets the working directory and runs with the user's permissions. Neither control provides process-level filesystem isolation.
- **Model and logs.** User prompts, analysis snippets, file reads, command results, and relevant history can reach OpenAI. The lesson sends the symptom, user-change report if available, fix report, agent summary, and step trace. The extension writes a local Markdown log per chat under VS Code extension storage. It can contain project paths, diffs, and excerpts of command output. The sidebar shows session tokens. It does not calculate spend.

## Explanation and lesson contract

The live conversation is prompted to state the symptom and cause before editing, the edit card explains the change, and the final reply gives check results and any manual verification still needed. Those messages are streamed free text. The lesson is a separate Responses API request using the schema in `src/explain.ts`.

| Required field | Meaning |
|---|---|
| `how_it_was_solved` | Ordered `did` and `why` pairs grounded in the recorded activity. The prompt requests three to seven steps. |
| `concept` | One concept with a name, explanation, everyday analogy, and short reference to the user's code. |
| `key_terms` | Terms with plain-English meanings. The prompt requests two to five. |
| `check_your_understanding` | One short question answerable from the lesson. |

The schema enforces fields and types. Factual accuracy and beginner readability still require review. The extension renders a collapsible **Coding lesson**, and the CLI prints the structured sections.

## Evaluation and acceptance

The repository includes ten small seeded JavaScript and TypeScript cases. Cases 03 and 09 cover the core recent-change analysis for a new required input and a renamed function. The offline verifier checks that the buggy fixture fails its grader, the reference fix passes, and expected analyzer findings appear for the applicable cases.

Model-backed runs use fresh temporary projects, auto-approve edit proposals, and by default decline commands that would require a user's approval. A run passes when the behavioral grader passes, protected files stay unchanged, there are no syntax errors in changed supported files, and a lesson is present. Scope drift and changed files without a recorded proposal are reported separately. The runner also records tokens, duration, risk, command decisions, remaining static issues, and the lesson concept. Presence of a lesson is distinct from lesson accuracy. The fixture runner does not exercise VS Code's approval UI.

| Check before the pilot | Evidence to collect |
|---|---|
| Edit lifecycle | In the sidebar, approve once, reject once, and verify that unsaved and stale files are protected. Verify undo on an unchanged file and refusal after an intervening saved change. |
| Command lifecycle | Verify a known check shows its result, a gated command stays pending until approval, and rejection or Stop releases the pending request. Inspect automatic-check side effects. |
| Explanation quality | Review live replies and lessons against files, outputs, and trace. Score accuracy, everyday language, appropriate uncertainty, and whether the check question is answerable. |
| Baseline and usability | Run each seeded case three times and report sample sizes and per-class outcomes. Test setup, first fix, and comprehension with at least five target builders. |

Expansion candidates include no-bug controls, symptoms that require manual verification, held-out variants, and real bugs from pilot use. A model-backed baseline, a scored comprehension study, and a key-free demo remain open release items.
