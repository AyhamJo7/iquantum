import type { ServerStreamFrame } from "@iquantum/protocol";
import * as vscode from "vscode";
import type { DaemonProxy } from "../DaemonProxy";

export class ChatPanel implements vscode.WebviewViewProvider {
  #view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly proxy: DaemonProxy,
    private readonly getSessionId: () => string | null,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.#view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.#getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(async (message) => {
      const sessionId = this.getSessionId();
      if (message.type === "submit" && sessionId) {
        await this.proxy.postMessage(sessionId, String(message.content));
      }
    });
  }

  postFrame(frame: ServerStreamFrame): void {
    void this.#view?.webview.postMessage({ type: "frame", frame });
  }

  postSession(sessionId: string): void {
    void this.#view?.webview.postMessage({ type: "session", sessionId });
  }

  #getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "index.js"),
    );
    return `<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
:root { --vscode-foreground: var(--vscode-editor-foreground); --vscode-background: var(--vscode-editor-background); --vscode-accent: var(--vscode-button-background); }
body { color: var(--vscode-foreground); background: var(--vscode-background); font-family: var(--vscode-font-family); }
</style>
</head>
<body><div id="root"></div><script nonce="${nonce}" src="${scriptUri}"></script></body>
</html>`;
  }
}
