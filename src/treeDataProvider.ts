import * as vscode from "vscode";
import type { ResultItem, SearchSession, SessionItem, TreeNode } from "./types";

const OPEN_RESULT_COMMAND = "gurepane.openResult";

// Keeps the panel tree in sync with the controller's current session list.
export class GurepaneTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(
    private readonly getSessions: () => readonly SearchSession[],
    private readonly getActiveSessionId: () => string | undefined
  ) {}

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === "session") {
      return this.getSessionTreeItem(element);
    }

    return this.getResultTreeItem(element);
  }

  getParent(element: TreeNode): vscode.ProviderResult<TreeNode> {
    if (element.kind === "session") {
      return undefined;
    }

    const session = this.getSessions().find((item) => item.id === element.sessionId);
    return session ? { kind: "session", session } : undefined;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      return this.getSessions().map((session) => ({
        kind: "session",
        session
      }));
    }

    if (element.kind === "result") {
      return [];
    }

    return element.session.results.map((result, resultIndex) => ({
      kind: "result",
      sessionId: element.session.id,
      resultIndex,
      result
    }));
  }

  private getSessionTreeItem(element: SessionItem): vscode.TreeItem {
    const isActive = element.session.id === this.getActiveSessionId();
    const item = new vscode.TreeItem(element.session.query, vscode.TreeItemCollapsibleState.Expanded);
    item.description = `${element.session.scopeLabel} | ${element.session.extensionFilter || "(all extensions)"} | ${element.session.results.length} result(s)`;
    item.tooltip = [
      element.session.query,
      element.session.scopeLabel,
      element.session.extensionFilter || "(all extensions)",
      `${element.session.results.length} result(s)`
    ].join("\n");
    item.iconPath = new vscode.ThemeIcon(isActive ? "zoom-in" : "search");
    item.contextValue = "gurepaneSession";
    return item;
  }

  private getResultTreeItem(element: ResultItem): vscode.TreeItem {
    const session = this.getSessions().find((item) => item.id === element.sessionId);
    const isCurrent = session?.currentIndex === element.resultIndex;
    const locationText = `${element.result.relativePath}:${element.result.line}: `;
    const labelText = `${locationText}${element.result.text}`;
    const item = new vscode.TreeItem(
      buildHighlightedLabel(labelText, locationText.length, element.result.highlights),
      vscode.TreeItemCollapsibleState.None
    );
    item.tooltip = `${element.result.filePath}:${element.result.line}:${element.result.column}\n${element.result.text}`;
    item.iconPath = new vscode.ThemeIcon(isCurrent ? "arrow-right" : "list-selection");
    item.contextValue = "gurepaneResult";
    item.command = {
      command: OPEN_RESULT_COMMAND,
      title: "Open Result",
      arguments: [element.sessionId, element.resultIndex]
    };
    return item;
  }
}

// VS Code highlights are relative to the full label, so shift match ranges by the location prefix length.
function buildHighlightedLabel(
  fullLabel: string,
  contentOffset: number,
  contentHighlights: ReadonlyArray<readonly [number, number]>
): vscode.TreeItemLabel {
  return {
    label: fullLabel,
    highlights: contentHighlights.map(([start, end]) => [start + contentOffset, end + contentOffset] as [number, number])
  };
}
