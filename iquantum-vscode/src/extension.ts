import { spawn } from "node:child_process";
import type { ServerStreamFrame } from "@iquantum/protocol";
import * as vscode from "vscode";
import { DiffEditorBridge } from "./bridges/DiffEditorBridge";
import { DaemonProxy } from "./DaemonProxy";
import { ChatPanel } from "./panels/ChatPanel";
import { PlanPanel } from "./panels/PlanPanel";
import { IquantumStatusBarItem } from "./StatusBarItem";

let socket: WebSocket | null = null;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const repoPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!repoPath) {
    void vscode.window.showInformationMessage("Open a folder to use iquantum");
    return;
  }

  const proxy = new DaemonProxy(DaemonProxy.detectPort());
  await ensureDaemon(proxy);
  let sessionId: string | null = null;
  const status = new IquantumStatusBarItem();
  const planPanel = new PlanPanel();
  const chatPanel = new ChatPanel(context.extensionUri, proxy, () => sessionId);
  const diffBridge = new DiffEditorBridge(proxy, () => sessionId, repoPath);

  const ensureSession = async () => {
    if (!sessionId) {
      const session = await proxy.createSession(repoPath, { mode: "piv" });
      sessionId = session.id;
      chatPanel.postSession(session.id);
      status.show();
      socket = proxy.openWebSocket(session.id);
      socket.onmessage = async (event) => {
        const frame = JSON.parse(String(event.data)) as ServerStreamFrame;
        chatPanel.postFrame(frame);
        status.handleFrame(frame);
        if (frame.type === "plan_ready") {
          const plan = await proxy.getPlan(session.id);
          planPanel.refresh(plan?.content ?? null);
          await vscode.commands.executeCommand("iquantum.showPlan");
        }
        if (frame.type === "diff_preview") {
          await diffBridge.handleDiffPreview(frame);
        }
        if (frame.type === "permission_request") {
          diffBridge.setPendingRequest(frame.requestId);
        }
      };
    }
    return sessionId;
  };

  context.subscriptions.push(
    status,
    diffBridge,
    vscode.window.registerWebviewViewProvider("iquantum.chat", chatPanel),
    vscode.window.registerTreeDataProvider("iquantum.plan", planPanel),
    vscode.commands.registerCommand("iquantum.openChat", async () => {
      await ensureSession();
      await vscode.commands.executeCommand("workbench.view.extension.iquantum");
    }),
    vscode.commands.registerCommand("iquantum.showPlan", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.iquantum");
    }),
    vscode.commands.registerCommand("iquantum.approvePlan", async () => {
      const id = await ensureSession();
      await proxy.approvePlan(id);
      void vscode.window.showInformationMessage(
        "Plan approved — implementing…",
      );
    }),
    vscode.commands.registerCommand("iquantum.rejectPlan", async () => {
      const id = await ensureSession();
      const feedback = await vscode.window.showInputBox({
        prompt: "Reason for rejection?",
      });
      if (feedback) await proxy.rejectPlan(id, feedback);
    }),
    vscode.commands.registerCommand("iquantum.applyDiff", async () => {
      await diffBridge.resolvePending(true);
    }),
    vscode.commands.registerCommand("iquantum.rejectDiff", async () => {
      await diffBridge.resolvePending(false);
    }),
  );
}

export function deactivate(): void {
  socket?.close();
  socket = null;
}

async function ensureDaemon(proxy: DaemonProxy): Promise<void> {
  try {
    await proxy.health();
  } catch {
    const autoStart = vscode.workspace
      .getConfiguration("iquantum")
      .get("autoStartDaemon", true);
    if (!autoStart) throw new Error("daemon did not start");
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "iquantum: starting daemon…",
        },
        async () => {
          spawn("iq", ["daemon", "start"], {
            detached: true,
            stdio: "ignore",
          }).unref();
          await proxy.waitForDaemon();
        },
      );
    } catch {
      await vscode.window.showErrorMessage(
        "Run `iq daemon start` in a terminal",
      );
      throw new Error("daemon did not start");
    }
  }
}
