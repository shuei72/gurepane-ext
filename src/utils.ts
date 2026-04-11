import { existsSync, readdirSync, statSync } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { SearchResult, SearchSession } from "./types";

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

// Child folder completion only needs one level, so keep this intentionally shallow.
export function getImmediateChildDirectories(targetPath: string): string[] {
  if (!isDirectory(targetPath)) {
    return [];
  }

  try {
    return readdirSync(targetPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(targetPath, entry.name));
  } catch {
    return [];
  }
}

export function buildSessionExportFileName(session: SearchSession, extension = "tsv"): string {
  const normalizedQuery = session.query.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 40) || "search";
  return `gurepane-${normalizedQuery}.${extension}`;
}

export function buildDefaultExportUri(fileName: string): vscode.Uri {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    return vscode.Uri.joinPath(workspaceFolder.uri, fileName);
  }

  return vscode.Uri.file(path.join(process.cwd(), fileName));
}

export function serializeSessionAsTsv(session: SearchSession): string {
  const rows = [
    [
      normalizeTsvField(session.scopeLabel),
      normalizeTsvField(session.extensionFilter),
      "",
      normalizeTsvField(session.query),
      ""
    ].join("\t")
  ];

  for (const result of session.results) {
    rows.push([
      result.relativePath,
      String(result.line),
      String(result.column),
      getMatchedText(result),
      normalizeTsvField(result.text)
    ].join("\t"));
  }

  return `${rows.join("\r\n")}\r\n`;
}

export function serializeSessionAsCsv(session: SearchSession): string {
  const rows = [
    [
      session.scopeLabel,
      session.extensionFilter,
      "",
      session.query,
      ""
    ].map(escapeCsvField).join(",")
  ];

  for (const result of session.results) {
    rows.push([
      result.relativePath,
      String(result.line),
      String(result.column),
      getMatchedText(result),
      normalizeTsvField(result.text)
    ].map(escapeCsvField).join(","));
  }

  return `${rows.join("\r\n")}\r\n`;
}

function getMatchedText(result: SearchResult): string {
  const [firstHighlight] = result.highlights;
  if (!firstHighlight) {
    return "";
  }

  const [start, end] = firstHighlight;
  return normalizeTsvField(result.text.slice(start, end));
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
