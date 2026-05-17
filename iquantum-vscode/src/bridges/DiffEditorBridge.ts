import { readFile } from "node:fs/promises";
import { applyPatch, parsePatch } from "diff";
import * as vscode from "vscode";
import type { DaemonProxy } from "../DaemonProxy";

export interface DiffPreviewFrame {
  type: "diff_preview";
  file: string;
  patch: string;
  requestId?: string;
}

export class DiffEditorBridge implements vscode.Disposable {
  readonly #content = new Map<string, string>();
  readonly #disposables: vscode.Disposable[] = [];
  #requestId: string | null = null;

  constructor(
    private readonly proxy: DaemonProxy,
    private readonly getSessionId: () => string | null,
    private readonly repoPath: string,
  ) {
    this.#disposables.push(
      vscode.workspace.registerTextDocumentContentProvider("iquantum-diff", {
        provideTextDocumentContent: (uri) =>
          this.#content.get(uri.toString()) ?? "",
      }),
      vscode.languages.registerCodeLensProvider(
        { scheme: "iquantum-diff" },
        {
          provideCodeLenses: () => [
            new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
              title: "✓ Apply",
              command: "iquantum.applyDiff",
            }),
            new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
              title: "✗ Reject",
              command: "iquantum.rejectDiff",
            }),
          ],
        },
      ),
    );
  }

  async handleDiffPreview(frame: DiffPreviewFrame): Promise<void> {
    const diskContent = await readFile(
      vscode.Uri.joinPath(vscode.Uri.file(this.repoPath), frame.file).fsPath,
      "utf8",
    ).catch(() => "");
    const parsed = parsePatch(frame.patch)[0];
    const forwardApplied = parsed
      ? applyPatch(diskContent, frame.patch)
      : false;
    const before =
      typeof forwardApplied === "string"
        ? diskContent
        : parsed
          ? applyPatch(diskContent, reversePatch(frame.patch)) || diskContent
          : diskContent;
    const after =
      typeof forwardApplied === "string" ? forwardApplied : diskContent;
    const beforeUri = vscode.Uri.parse(`iquantum-diff:before/${frame.file}`);
    const afterUri = vscode.Uri.parse(`iquantum-diff:after/${frame.file}`);
    this.#content.set(beforeUri.toString(), before);
    this.#content.set(afterUri.toString(), after);
    const adds = frame.patch
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const dels = frame.patch
      .split("\n")
      .filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    await vscode.commands.executeCommand(
      "vscode.diff",
      beforeUri,
      afterUri,
      `iquantum: ${frame.file} (+${adds} -${dels})`,
    );
  }

  async resolvePermission(requestId: string, approved: boolean): Promise<void> {
    const sessionId = this.getSessionId();
    if (sessionId)
      await this.proxy.postPermission(sessionId, requestId, approved);
  }

  setPendingRequest(requestId: string): void {
    this.#requestId = requestId;
  }

  async resolvePending(approved: boolean): Promise<void> {
    if (!this.#requestId) return;
    await this.resolvePermission(this.#requestId, approved);
    this.#requestId = null;
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  }

  dispose(): void {
    for (const disposable of this.#disposables) disposable.dispose();
  }
}

function reversePatch(patch: string): string {
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++")) return line.replace(/^\+\+\+/, "---");
      if (line.startsWith("---")) return line.replace(/^---/, "+++");
      if (line.startsWith("+")) return `-${line.slice(1)}`;
      if (line.startsWith("-")) return `+${line.slice(1)}`;
      return line;
    })
    .join("\n");
}
