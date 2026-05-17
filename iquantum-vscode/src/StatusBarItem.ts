import type { ServerStreamFrame } from "@iquantum/protocol";
import * as vscode from "vscode";

export class IquantumStatusBarItem implements vscode.Disposable {
  readonly #item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );

  constructor() {
    this.#item.text = "$(brain) iquantum: idle";
    this.#item.command = "iquantum.openChat";
  }

  show(): void {
    this.#item.show();
  }

  handleFrame(frame: ServerStreamFrame): void {
    if (frame.type === "phase_change") {
      this.#item.text = `$(sync~spin) iquantum: ${frame.phase}…`;
    } else if (frame.type === "done") {
      this.#item.text = "$(brain) iquantum: idle";
    }
  }

  dispose(): void {
    this.#item.dispose();
  }
}
