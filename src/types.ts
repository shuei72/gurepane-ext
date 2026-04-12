import * as vscode from "vscode";

// A single ripgrep hit shown in the tree.
export type Node = {
  readonly uri: vscode.Uri;
  readonly filePath: string;
  readonly relativePath: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly highlights: ReadonlyArray<readonly [number, number]>;
};

// A top-level result set that groups hits from one search execution.
export type Result = {
  readonly id: string;
  readonly query: string;
  readonly rawQuery: string;
  readonly scopeLabel: string;
  readonly extensionFilter: string;
  readonly createdAt: number;
  readonly nodes: Node[];
  currentNodeIndex: number;
};

export type QueryMode = "regex" | "text";

export type QueryCaseMode = "smart" | "ignore" | "sensitive";

// Parsed form of the user's prefixed query syntax.
export type ParsedQuery = {
  readonly raw: string;
  readonly pattern: string;
  readonly mode: QueryMode;
  readonly wholeWord: boolean;
  readonly caseMode: QueryCaseMode;
};

// Tree nodes are either a result root or an individual node line.
export type ResultItem = {
  readonly kind: "result";
  readonly result: Result;
};

export type NodeItem = {
  readonly kind: "node";
  readonly resultId: string;
  readonly nodeIndex: number;
  readonly node: Node;
};

export type TreeNode = ResultItem | NodeItem;
