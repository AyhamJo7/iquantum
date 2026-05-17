import * as vscode from "vscode";

export class PlanItem extends vscode.TreeItem {
  constructor(
    label: string,
    readonly children: PlanItem[] = [],
  ) {
    super(
      label,
      children.length
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
  }
}

export class PlanPanel implements vscode.TreeDataProvider<PlanItem> {
  readonly #onDidChangeTreeData = new vscode.EventEmitter<
    PlanItem | undefined
  >();
  readonly onDidChangeTreeData = this.#onDidChangeTreeData.event;
  #planContent: string | null = null;

  getTreeItem(element: PlanItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: PlanItem): PlanItem[] {
    return element ? element.children : this.#parsePlan();
  }

  refresh(content: string | null): void {
    this.#planContent = content;
    this.#onDidChangeTreeData.fire(undefined);
  }

  #parsePlan(): PlanItem[] {
    if (!this.#planContent) return [];
    const lines = this.#planContent.split("\n");
    const items: PlanItem[] = [];
    let current: { label: string; children: PlanItem[] } | null = null;
    for (const line of lines) {
      const top = line.match(/^\s*\d+\.\s+(.*)$/);
      if (top?.[1]) {
        current = { label: top[1], children: [] };
        items.push(new PlanItem(current.label, current.children));
      } else if (current) {
        const child = line.match(/^\s*[-*]\s+(.*)$/)?.[1];
        if (child) current.children.push(new PlanItem(child));
      }
    }
    return items;
  }
}
