// VS Code entry point: registers the sidebar chat, the diff document provider and commands.
import * as vscode from "vscode";
import { loadParser } from "./oxcShim.js";
import { ChatViewProvider, ProposalDocs } from "./chatView.js";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await loadParser();

  const docs = new ProposalDocs();
  const chat = new ChatViewProvider(context, docs);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ProposalDocs.scheme, docs),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat, {
      webviewOptions: { retainContextWhenHidden: true }, // keep the chat when the sidebar is hidden
    }),
    vscode.commands.registerCommand("aiDebugger.setApiKey", () => chat.setApiKey()),
    vscode.commands.registerCommand("aiDebugger.newChat", () => chat.newChat())
  );
}

export function deactivate(): void {}
