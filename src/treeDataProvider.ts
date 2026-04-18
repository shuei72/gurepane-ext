import * as vscode from "vscode";
import type { NodeItem, Result, ResultItem, TreeNode } from "./types";

const OPEN_NODE_COMMAND = "gurepane.openNode";

// Keeps the panel tree in sync with the controller's current result list.
export class GurepaneTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(
    private readonly getResults: () => readonly Result[],
    private readonly getActiveResultId: () => string | undefined
  ) {}

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === "result") {
      return this.getResultTreeItem(element);
    }

    return this.getNodeTreeItem(element);
  }

  getParent(element: TreeNode): vscode.ProviderResult<TreeNode> {
    if (element.kind === "result") {
      return undefined;
    }

    const result = this.getResults().find((item) => item.id === element.resultId);
    return result ? { kind: "result", result } : undefined;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      return this.getResults().map((result) => ({
        kind: "result",
        result
      }));
    }

    if (element.kind === "node") {
      return [];
    }

    return element.result.nodes.map((node, nodeIndex) => ({
      kind: "node",
      resultId: element.result.id,
      nodeIndex,
      node
    }));
  }

  private getResultTreeItem(element: ResultItem): vscode.TreeItem {
    const isActive = element.result.id === this.getActiveResultId();
    const item = new vscode.TreeItem(element.result.query, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `result:${element.result.id}`;
    item.description = `${element.result.scopeLabel} | ${element.result.extensionFilter || "(all extensions)"} | ${element.result.nodes.length} node(s)`;
    item.tooltip = "";
    item.iconPath = new vscode.ThemeIcon(isActive ? "zoom-in" : "search");
    item.contextValue = "gurepaneResult";
    return item;
  }

  private getNodeTreeItem(element: NodeItem): vscode.TreeItem {
    const result = this.getResults().find((item) => item.id === element.resultId);
    const isCurrent = result?.currentNodeIndex === element.nodeIndex;
    const locationText = `${element.node.relativePath}:${element.node.line}: `;
    const labelText = `${locationText}${element.node.text}`;
    const item = new vscode.TreeItem(
      buildHighlightedLabel(labelText, locationText.length, element.node.highlights),
      vscode.TreeItemCollapsibleState.None
    );
    item.id = `node:${element.resultId}:${element.nodeIndex}:${element.node.relativePath}:${element.node.line}:${element.node.column}`;
    item.tooltip = "";
    item.iconPath = new vscode.ThemeIcon(isCurrent ? "arrow-right" : "list-selection");
    item.contextValue = "gurepaneNode";
    item.command = {
      command: OPEN_NODE_COMMAND,
      title: "Open Node",
      arguments: [element.resultId, element.nodeIndex]
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
