// The sidebar chat panel: turns agent callbacks into webview messages, and button clicks
// in the webview into approvals, diffs and undos.
import * as vscode from "vscode";
import OpenAI from "openai";
import { join, sep } from "node:path";
import { AgentSession } from "../agent/session.js";
import type { AgentCallbacks, EditProposal } from "../agent/types.js";

export const API_KEY_SECRET = "aiDebugger.openaiApiKey";
const MAX_COMMAND_OUTPUT = 4_000;

/** Serves in-memory file versions so VS Code's diff editor can show them */
export class ProposalDocs implements vscode.TextDocumentContentProvider {
  static readonly scheme = "ai-debugger";
  private docs = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.query) ?? "";
  }

  uriFor(key: string, path: string, content: string): vscode.Uri {
    this.docs.set(key, content);
    // Keeping the real file name gives the diff the right syntax colouring
    return vscode.Uri.from({ scheme: ProposalDocs.scheme, path: `/${path}`, query: key });
  }
}

type FromWebview =
  | { type: "prompt"; text: string }
  | { type: "approveEdit" | "rejectEdit" | "viewDiff" | "undoEdit"; id: string }
  | { type: "approveCommand" | "rejectCommand"; id: string }
  | { type: "openFile"; path: string; line?: number }
  | { type: "stop" | "setKey" };

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "aiDebugger.chat";

  private view?: vscode.WebviewView;
  private session?: AgentSession;
  private sessionRoot?: string;
  private pending = new Map<string, (approved: boolean) => void>();
  private proposals = new Map<string, EditProposal>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly docs: ProposalDocs
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m));
    this.postProject();
    this.context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.postProject()));
  }

  /** Show which folder the agent will work in, so it's clear before approving edits */
  private postProject(): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    this.post({ type: "project", name: folder?.name ?? null, path: folder?.uri.fsPath ?? null });
  }

  /** Start over: stop any run, forget history, clear the panel */
  newChat(): void {
    this.session?.stop();
    this.rejectAllPending();
    this.session = undefined;
    this.proposals.clear();
    this.post({ type: "clear" });
  }

  async setApiKey(): Promise<void> {
    // Accept a whole .env line or a quoted key, and keep just the key itself
    const clean = (value: string) =>
      value
        .trim()
        .replace(/^OPENAI_API_KEY\s*=\s*/, "")
        .replace(/^["']|["']$/g, "")
        .trim();
    const input = await vscode.window.showInputBox({
      title: "OpenAI API key",
      prompt: "Stored securely in VS Code's secret storage",
      password: true,
      ignoreFocusOut: true,
      placeHolder: "sk-...",
      validateInput: (value) => {
        const key = clean(value);
        if (!key || key.startsWith("sk-")) return undefined;
        if (key.startsWith("k-")) return 'This looks like it\'s missing the first letter: OpenAI keys start with "sk-".';
        return 'OpenAI keys start with "sk-". Check that you copied the whole key.';
      },
    });
    const key = input ? clean(input) : "";
    if (!key.startsWith("sk-")) return;
    await this.context.secrets.store(API_KEY_SECRET, key);
    this.session = undefined; // the next message uses the new key (chat history restarts)
    this.post({ type: "keySaved" });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private async onMessage(m: FromWebview): Promise<void> {
    switch (m.type) {
      case "prompt":
        return this.prompt(m.text);
      case "approveEdit":
        return this.approveEdit(m.id);
      case "rejectEdit":
        this.resolvePending(m.id, false);
        return this.post({ type: "editStatus", id: m.id, status: "rejected" });
      case "viewDiff":
        return this.showDiff(m.id);
      case "undoEdit": {
        const result = this.session?.undoEdit(m.id) ?? { ok: false, message: "This chat has ended, so the edit can't be undone here." };
        return this.post(
          result.ok
            ? { type: "editStatus", id: m.id, status: "undone", note: result.message }
            : { type: "editNotice", id: m.id, text: result.message }
        );
      }
      case "approveCommand":
        this.resolvePending(m.id, true);
        return this.post({ type: "commandStatus", id: m.id, status: "running" });
      case "rejectCommand":
        this.resolvePending(m.id, false);
        return this.post({ type: "commandStatus", id: m.id, status: "rejected" });
      case "stop":
        this.session?.stop();
        return this.rejectAllPending();
      case "setKey":
        return this.setApiKey();
      case "openFile":
        return this.openFile(m.path, m.line);
    }
  }

  private async openFile(path: string, line?: number): Promise<void> {
    const root = this.sessionRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    const full = join(root, path);
    if (!full.startsWith(root + sep)) return; // stay inside the project
    const position = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(full), {
        selection: new vscode.Range(position, position),
        preview: true,
      });
    } catch {
      this.post({ type: "message", role: "error", text: `Couldn't open ${path}.` });
    }
  }

  private async prompt(text: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      this.post({ type: "message", role: "error", text: "Open a project folder first (File → Open Folder…)." });
      return this.post({ type: "busy", busy: false });
    }
    if (this.session?.running) return;

    const session = await this.getSession(root);
    if (!session) return this.post({ type: "busy", busy: false });

    this.post({ type: "busy", busy: true });
    try {
      await session.run(text);
    } finally {
      this.post({ type: "busy", busy: false });
    }
  }

  private async getSession(root: string): Promise<AgentSession | undefined> {
    if (this.session && this.sessionRoot === root) return this.session;
    const apiKey = (await this.context.secrets.get(API_KEY_SECRET)) ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      this.post({ type: "needsKey" });
      return undefined;
    }
    const model = vscode.workspace.getConfiguration("aiDebugger").get<string>("model", "gpt-5.5");
    this.sessionRoot = root;
    this.session = new AgentSession({ root, client: new OpenAI({ apiKey }), model, callbacks: this.callbacks() });
    return this.session;
  }

  private callbacks(): AgentCallbacks {
    return {
      message: (role, text) => this.post({ type: "message", role, text }),
      assistantDelta: (id, delta) => this.post({ type: "assistantDelta", id, delta }),
      assistantDone: (id, text) => this.post({ type: "assistantDone", id, text }),
      activity: (step) => this.post({ type: "activity", ...step }),
      approveEdit: (edit) => {
        this.proposals.set(edit.id, edit);
        this.post({
          type: "editCard",
          id: edit.id,
          path: edit.path,
          functionName: edit.functionName,
          risk: edit.risk,
          hunks: edit.hunks,
        });
        return new Promise((resolve) => this.pending.set(edit.id, resolve));
      },
      editApplied: (edit) => this.post({ type: "editStatus", id: edit.id, status: "applied" }),
      editFailed: (edit, reason) => this.post({ type: "editStatus", id: edit.id, status: "failed", note: reason }),
      approveCommand: (command) => {
        this.post({ type: "commandCard", id: command.id, cmd: command.cmd });
        return new Promise((resolve) => this.pending.set(command.id, resolve));
      },
      commandFinished: (id, ok, output) => {
        const shown = output.length > MAX_COMMAND_OUTPUT ? `${output.slice(0, MAX_COMMAND_OUTPUT)}\n… (cut off)` : output;
        this.post({ type: "commandStatus", id, status: ok ? "done" : "failed", output: shown });
      },
      fixExplained: (result) => this.post({ type: "explanation", ...result }),
      usage: (usage) => this.post({ type: "usage", ...usage }),
    };
  }

  private async approveEdit(id: string): Promise<void> {
    const edit = this.proposals.get(id);
    if (!edit || !this.pending.has(id)) return;
    // Don't write over unsaved work in an open editor
    const full = join(this.sessionRoot ?? "", edit.path);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === full);
    if (doc?.isDirty) {
      return this.post({
        type: "editNotice",
        id,
        text: `${edit.path} has unsaved changes. Save it (Cmd+S / Ctrl+S), then click Approve again.`,
      });
    }
    this.resolvePending(id, true);
    this.post({ type: "editStatus", id, status: "applying" });
  }

  private async showDiff(id: string): Promise<void> {
    const edit = this.proposals.get(id);
    if (!edit) return;
    const left = this.docs.uriFor(`${id}-before`, edit.path, edit.before);
    const right = this.docs.uriFor(`${id}-after`, edit.path, edit.after);
    await vscode.commands.executeCommand("vscode.diff", left, right, `Proposed change: ${edit.path}`);
  }

  private resolvePending(id: string, approved: boolean): void {
    const resolve = this.pending.get(id);
    if (!resolve) return;
    this.pending.delete(id);
    resolve(approved);
  }

  private rejectAllPending(): void {
    for (const id of [...this.pending.keys()]) {
      this.resolvePending(id, false);
      this.post({ type: id.startsWith("cmd-") ? "commandStatus" : "editStatus", id, status: "rejected" });
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = Array.from({ length: 32 }, () => Math.random().toString(36)[2]).join("");
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, "main.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, "main.js"));
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="${css}">
  <title>AI Debugger</title>
</head>
<body>
  <main id="messages" aria-live="polite"></main>
  <footer>
    <div id="project" title="">No folder open</div>
    <form id="composer">
      <textarea id="input" rows="3" placeholder="Describe the bug, or ask a question…" aria-label="Message"></textarea>
      <div class="composer-actions">
        <button type="button" id="stop" class="secondary" hidden>Stop</button>
        <button type="submit" id="send">Send</button>
      </div>
    </form>
    <div id="meter" title="Tokens sent to and received from the AI in this chat">Tokens used: <span id="tokens">0</span></div>
  </footer>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
