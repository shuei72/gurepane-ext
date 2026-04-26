import * as path from "path";
import * as vscode from "vscode";
import type { FileItem, NodeItem, Result, ResultItem, TreeNode } from "./types";
import { findRootPath } from "./utils";

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

    if (element.kind === "file") {
      return this.getFileTreeItem(element);
    }

    if (element.kind === "node") {
      return this.getNodeTreeItem(element);
    }

    throw new Error(`Unsupported tree item kind: ${(element as any).kind}`);
  }

  getParent(element: TreeNode): vscode.ProviderResult<TreeNode> {
    if (element.kind === "result") {
      return undefined;
    }

    if (element.kind === "file") {
      const result = this.getResults().find((item) => item.id === element.resultId);
      return result ? { kind: "result", result } : undefined;
    }

    if (element.kind === "node") {
      const result = this.getResults().find(r => r.id === element.resultId);
      const nodeCount = result?.nodes.filter(n => n.filePath === element.node.filePath).length ?? 0;
      const rootPath = result ? findRootPath(element.node.filePath, result.folderPaths) : undefined;
      return {
        kind: "file",
        resultId: element.resultId,
        relativePath: element.node.relativePath,
        filePath: element.node.filePath,
        nodeCount,
        rootPath
      };
    }
    return undefined;
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

    if (element.kind === "result") {
      // ファイルパスでグループ化して FileItem を返す（ヒット件数も計算）
      const fileStats = new Map<string, { relativePath: string; count: number; rootPath?: string }>();
      for (const node of element.result.nodes) {
        const stats = fileStats.get(node.filePath) || { 
          relativePath: node.relativePath, 
          count: 0,
          rootPath: findRootPath(node.filePath, element.result.folderPaths)
        };
        stats.count++;
        fileStats.set(node.filePath, stats);
      }
      return Array.from(fileStats.entries()).map(([filePath, stats]) => ({
        kind: "file",
        resultId: element.result.id,
        relativePath: stats.relativePath,
        filePath,
        nodeCount: stats.count,
        rootPath: stats.rootPath
      }));
    }

    if (element.kind === "file") {
      const result = this.getResults().find((r) => r.id === element.resultId);
      if (!result) return [];

      return result.nodes
        .map((node, nodeIndex) => ({ node, nodeIndex }))
        .filter(({ node }) => node.filePath === element.filePath)
        .map(({ node, nodeIndex }) => ({
          kind: "node",
          resultId: element.resultId,
          nodeIndex,
          node
        }));
    }

    return [];
  }

  private getResultTreeItem(element: ResultItem): vscode.TreeItem {
    const isActive = element.result.id === this.getActiveResultId();
    const item = new vscode.TreeItem(element.result.query, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `result:${element.result.id}`;
    const suffix = element.result.isExternal ? " (External)" : "";
    item.description = `${element.result.scopeLabel}${suffix} | ${element.result.extensionFilter || "(all extensions)"} | ${element.result.nodes.length} node(s)`;
    item.tooltip = "";
    item.iconPath = new vscode.ThemeIcon(isActive ? "zoom-in" : "search");
    item.contextValue = "gurepaneResult";
    return item;
  }

  private getFileTreeItem(element: FileItem): vscode.TreeItem {
    const item = new vscode.TreeItem(element.relativePath, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `file:${element.resultId}:${element.filePath}`;
    item.resourceUri = vscode.Uri.file(element.filePath);

    const result = this.getResults().find(r => r.id === element.resultId);
    let description = `${element.nodeCount} node(s)`;
    if (result && element.rootPath) {
      const rootName = path.basename(element.rootPath) || element.rootPath;
      description = `[${rootName}] ${description}`;
    }

    item.description = description;
    item.iconPath = vscode.ThemeIcon.File;
    item.contextValue = "gurepaneFile";
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
