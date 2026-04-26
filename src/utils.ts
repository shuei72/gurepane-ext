import { existsSync, readdirSync, statSync } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { Node, Result } from "./types";

// Prefer workspace-relative paths so result labels stay compact.
export function getRelativePath(uri: vscode.Uri): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return path.basename(uri.fsPath);
  }

  const relative = path.relative(workspaceFolder.uri.fsPath, uri.fsPath).replace(/\\/g, "/");
  return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1
    ? `${workspaceFolder.name}/${relative}`
    : relative;
}

// Used by the folder prompt's `.. ` shortcut.
export function removeLastFolderSegment(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!normalized) {
    return "";
  }

  const root = path.posix.parse(normalized).root;
  if (normalized === root) {
    return normalized;
  }

  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex < 0) {
    return "";
  }

  return normalized.slice(0, slashIndex) || root;
}

export function isDirectory(targetPath: string): boolean {
  if (!existsSync(targetPath)) {
    return false;
  }

  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

export function findRootPath(filePath: string, roots: string[]): string | undefined {
  const normalizedFile = filePath.replace(/\\/g, "/").toLowerCase();
  const sortedRoots = [...roots]
    .filter(r => r.trim().length > 0)
    .sort((a, b) => b.length - a.length);

  for (const r of sortedRoots) {
    const normalizedRoot = r.replace(/\\/g, "/").toLowerCase();
    const rootWithSlash = normalizedRoot.endsWith("/") ? normalizedRoot : normalizedRoot + "/";
    if (normalizedFile === normalizedRoot || normalizedFile.startsWith(rootWithSlash)) {
      return r;
    }
  }
  return undefined;
}

// Recursively collect descendant folders so Quick Pick can match by any path segment.
export function getDescendantDirectories(targetPath: string): string[] {
  if (!isDirectory(targetPath)) {
    return [];
  }

  const directories: string[] = [];
  const stack = [targetPath];

  try {
    while (stack.length > 0) {
      const currentPath = stack.pop();
      if (!currentPath) {
        continue;
      }

      for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }

        const childPath = path.join(currentPath, entry.name);
        directories.push(childPath);
        stack.push(childPath);
      }
    }

    return directories;
  } catch {
    return [];
  }
}

export function buildResultExportFileName(result: Result, extension = "tsv"): string {
  const normalizedQuery = result.query.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 40) || "search";
  return `gurepane-${normalizedQuery}.${extension}`;
}

export function buildDefaultExportUri(fileName: string): vscode.Uri {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    return vscode.Uri.joinPath(workspaceFolder.uri, fileName);
  }

  return vscode.Uri.file(path.join(process.cwd(), fileName));
}

export function serializeResultAsTsv(result: Result): string {
  const header = ["File", "Line", "Column", "Match", "Text", "Full Path"].join("\t");
  const rows = [header];

  for (const node of result.nodes) {
    const rootPath = findRootPath(node.filePath, result.folderPaths) || "";
    const rootName = path.basename(rootPath) || rootPath;
    const displayPath = rootName ? `[${rootName}] ${node.relativePath}` : node.relativePath;

    rows.push([
      normalizeTsvField(displayPath),
      String(node.line),
      String(node.column),
      getMatchedText(node),
      normalizeTsvField(node.text),
      normalizeTsvField(node.filePath)
    ].join("\t"));
  }

  return `${rows.join("\r\n")}\r\n`;
}

export function serializeResultAsCsv(result: Result): string {
  const header = ["File", "Line", "Column", "Match", "Text", "Full Path"].map(escapeCsvField).join(",");
  const rows = [header];

  for (const node of result.nodes) {
    const rootPath = findRootPath(node.filePath, result.folderPaths) || "";
    const rootName = path.basename(rootPath) || rootPath;
    const displayPath = rootName ? `[${rootName}] ${node.relativePath}` : node.relativePath;

    rows.push([
      displayPath,
      String(node.line),
      String(node.column),
      getMatchedText(node),
      node.text,
      node.filePath
    ].map(escapeCsvField).join(","));
  }

  return `${rows.join("\r\n")}\r\n`;
}

function getMatchedText(node: Node): string {
  const [firstHighlight] = node.highlights;
  if (!firstHighlight) {
    return "";
  }

  const [start, end] = firstHighlight;
  return normalizeTsvField(node.text.slice(start, end));
}

function normalizeTsvField(value: string): string {
  return value.replace(/\t/g, " ").replace(/\r?\n/g, " ");
}

function escapeCsvField(value: string): string {
  const normalized = value.replace(/\r?\n/g, " ");
  if (!/[",\r\n]/.test(normalized)) {
    return normalized;
  }

  return `"${normalized.replace(/"/g, "\"\"")}"`;
}
