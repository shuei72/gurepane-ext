import { execFile } from "child_process";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import {
  buildExtensionArgs,
  buildQueryModeArgs,
  formatError,
  inferQueryCaseModeFromRaw,
  inferQueryModeFromRaw,
  inferWholeWordFromRaw,
  isRipgrepNoResults,
  normalizeExtensionFilter,
  parseQueryInput,
  parseRipgrepOutput
} from "./searchUtils";
import { GurepaneTreeDataProvider } from "./treeDataProvider";
import type { Node, NodeItem, ParsedQuery, Result, ResultItem, TreeNode } from "./types";
import {
  buildDefaultExportUri,
  buildResultExportFileName,
  getDescendantDirectories,
  isDirectory,
  serializeResultAsCsv,
  serializeResultAsTsv
} from "./utils";

const SEARCH_COMMAND = "gurepane.search";
const SELECT_RESULT_COMMAND = "gurepane.selectResult";
const CHANGE_RESULT_QUERY_COMMAND = "gurepane.changeResultQuery";
const DELETE_RESULT_COMMAND = "gurepane.deleteResult";
const DELETE_NODE_COMMAND = "gurepane.deleteNode";
const COPY_NODE_COMMAND = "gurepane.copyNode";
const SAVE_RESULT_AS_CSV_COMMAND = "gurepane.saveResultAsCsv";
const SAVE_RESULT_AS_TSV_COMMAND = "gurepane.saveResultAsTsv";
const NEXT_NODE_COMMAND = "gurepane.nextNode";
const PREVIOUS_NODE_COMMAND = "gurepane.previousNode";
const OPEN_NODE_COMMAND = "gurepane.openNode";
const REVEAL_CURRENT_NODE_COMMAND = "gurepane.revealCurrentNode";
const REFRESH_COMMAND = "gurepane.refreshResult";
const VIEW_ID = "gurepane.results";
const OUTPUT_CHANNEL_NAME = "Gurepane";
const DEFAULT_RG_COMMAND = "rg";
const DEFAULT_ES_COMMAND = "es.exe";
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_FOLDER_CANDIDATES = 200;
const HISTORY_LIMIT = 10;
const QUERY_HISTORY_KEY = "gurepane.queryHistory";
const FOLDER_HISTORY_KEY = "gurepane.folderHistory";
const EXTENSION_HISTORY_KEY = "gurepane.extensionHistory";
const QUERY_MODE_DELIMITER = ">";
const EXEC_FILE = promisify(execFile);

type FolderCandidateItem = vscode.QuickPickItem & {
  readonly filterText?: string;
  readonly targetPath: string;
};

class GurepaneController {
  private readonly outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  private readonly results: Result[] = [];
  private readonly provider = new GurepaneTreeDataProvider(
    () => this.results,
    () => this.activeResultId
  );
  private treeView: vscode.TreeView<TreeNode> | undefined;
  private activeResultId: string | undefined;
  private lastFolderPath = "";
  private extensionContext: vscode.ExtensionContext | undefined;

  register(context: vscode.ExtensionContext): void {
    this.extensionContext = context;
    this.treeView = vscode.window.createTreeView(VIEW_ID, {
      treeDataProvider: this.provider,
      showCollapseAll: false
    });

    context.subscriptions.push(
      this.outputChannel,
      this.treeView,
      vscode.commands.registerCommand(SEARCH_COMMAND, async () => {
        await this.search();
      }),
      vscode.commands.registerCommand(SELECT_RESULT_COMMAND, async () => {
        await this.selectResult();
      }),
      vscode.commands.registerCommand(CHANGE_RESULT_QUERY_COMMAND, async (item?: ResultItem) => {
        await this.changeResultQuery(item);
      }),
      vscode.commands.registerCommand(DELETE_RESULT_COMMAND, async (item?: ResultItem) => {
        await this.deleteResult(item?.result.id);
      }),
      vscode.commands.registerCommand(DELETE_NODE_COMMAND, async (item?: NodeItem) => {
        await this.deleteNode(item);
      }),
      vscode.commands.registerCommand(COPY_NODE_COMMAND, async (item?: NodeItem) => {
        await this.copyNode(item);
      }),
      vscode.commands.registerCommand(SAVE_RESULT_AS_CSV_COMMAND, async (item?: ResultItem) => {
        await this.saveResultAsCsv(item?.result.id);
      }),
      vscode.commands.registerCommand(SAVE_RESULT_AS_TSV_COMMAND, async (item?: ResultItem) => {
        await this.saveResultAsTsv(item?.result.id);
      }),
      vscode.commands.registerCommand(NEXT_NODE_COMMAND, async () => {
        await this.jump(1);
      }),
      vscode.commands.registerCommand(PREVIOUS_NODE_COMMAND, async () => {
        await this.jump(-1);
      }),
      vscode.commands.registerCommand(OPEN_NODE_COMMAND, async (resultId?: string, nodeIndex?: number) => {
        if (typeof resultId !== "string" || typeof nodeIndex !== "number") {
          return;
        }

        await this.openNode(resultId, nodeIndex, true);
      }),
      vscode.commands.registerCommand(REVEAL_CURRENT_NODE_COMMAND, async (item?: ResultItem) => {
        await this.revealCurrentNodeCommand(item);
      }),
      vscode.commands.registerCommand(REFRESH_COMMAND, async (item?: ResultItem) => {
        await this.refreshResult(item);
      })
    );
  }

  private async search(): Promise<void> {
    const query = await this.promptQuery();
    if (!query) {
      return;
    }

    const folderPath = await this.promptSearchFolder();
    if (folderPath === undefined) {
      return;
    }

    const extensionFilter = await this.promptExtensionFilter();
    if (extensionFilter === undefined) {
      return;
    }

    await this.rememberHistory(QUERY_HISTORY_KEY, query.raw);
    await this.rememberHistory(FOLDER_HISTORY_KEY, folderPath);
    await this.rememberHistory(EXTENSION_HISTORY_KEY, extensionFilter);
    await this.runSearch(query, folderPath, extensionFilter);
  }

  private async refreshResult(item?: ResultItem): Promise<void> {
    const result = item?.result ?? this.getActiveResult();
    if (!result) {
      void vscode.window.showInformationMessage("Run search first.");
      return;
    }

    await this.runSearch(
      {
        raw: result.rawQuery,
        pattern: result.query,
        mode: inferQueryModeFromRaw(result.rawQuery),
        wholeWord: inferWholeWordFromRaw(result.rawQuery),
        caseMode: inferQueryCaseModeFromRaw(result.rawQuery)
      },
      result.scopeLabel === "workspace" ? "" : result.scopeLabel,
      result.extensionFilter,
      result.id
    );
  }

  private async revealCurrentNodeCommand(item?: ResultItem): Promise<void> {
    const result = item?.result ?? this.getActiveResult();
    if (!result) {
      void vscode.window.showInformationMessage("Run search first.");
      return;
    }

    if (result.currentNodeIndex < 0) {
      void vscode.window.showInformationMessage("No current node to reveal.");
      return;
    }

    await this.openNode(result.id, result.currentNodeIndex, true);
  }

  private async selectResult(): Promise<void> {
    if (this.results.length === 0) {
      void vscode.window.showInformationMessage("No results to switch.");
      return;
    }

    const picked = await vscode.window.showQuickPick(
      this.results.map((result) => ({
        label: result.query,
        description: result.scopeLabel,
        detail: `${result.extensionFilter || "(all extensions)"} • ${result.nodes.length} node(s) • ${new Date(result.createdAt).toLocaleString()}`,
        resultId: result.id
      })),
      {
        placeHolder: "Choose result"
      }
    );

    if (!picked) {
      return;
    }

    this.activeResultId = picked.resultId;
    this.provider.refresh();
    await this.focusPanel();

    const result = this.getActiveResult();
    if (result && result.currentNodeIndex >= 0) {
      await this.revealCurrentNode(result);
    }
  }

  private async changeResultQuery(item?: ResultItem): Promise<void> {
    const result = item?.result ?? this.getActiveResult();
    if (!result) {
      void vscode.window.showInformationMessage("No result to reuse.");
      return;
    }

    const query = await this.promptQuery(result.rawQuery);
    if (!query) {
      return;
    }

    await this.rememberHistory(QUERY_HISTORY_KEY, query.raw);
    await this.runSearch(
      query,
      result.scopeLabel === "workspace" ? "" : result.scopeLabel,
      result.extensionFilter
    );
  }

  private async deleteResult(resultId?: string): Promise<void> {
    const resolvedResultId = resultId ?? this.activeResultId;
    if (!resolvedResultId) {
      void vscode.window.showInformationMessage("No result to delete.");
      return;
    }

    const index = this.results.findIndex((result) => result.id === resolvedResultId);
    if (index < 0) {
      return;
    }

    this.results.splice(index, 1);
    if (this.activeResultId === resolvedResultId) {
      this.activeResultId = this.results[Math.max(0, index - 1)]?.id;
    }

    this.provider.refresh();
  }

  private async deleteNode(item?: NodeItem): Promise<void> {
    if (!item) {
      return;
    }

    const result = this.results.find((candidate) => candidate.id === item.resultId);
    if (!result) {
      return;
    }

    result.nodes.splice(item.nodeIndex, 1);
    if (result.nodes.length === 0) {
      await this.deleteResult(result.id);
      return;
    }

    if (result.currentNodeIndex >= result.nodes.length) {
      result.currentNodeIndex = result.nodes.length - 1;
    }
    if (result.currentNodeIndex > item.nodeIndex) {
      result.currentNodeIndex -= 1;
    }

    this.activeResultId = result.id;
    this.provider.refresh();
  }

  private async copyNode(item?: NodeItem): Promise<void> {
    if (!item) {
      return;
    }

    const content = `${item.node.filePath}:${item.node.line}\n${item.node.text}`;
    await vscode.env.clipboard.writeText(content);
    void vscode.window.showInformationMessage("Node copied.");
  }

  private async saveResultAsTsv(resultId?: string): Promise<void> {
    const result = this.results.find((item) => item.id === (resultId ?? this.activeResultId));
    if (!result) {
      void vscode.window.showInformationMessage("No result to save.");
      return;
    }

    const defaultFileName = buildResultExportFileName(result);
    const targetUri = await vscode.window.showSaveDialog({
      defaultUri: buildDefaultExportUri(defaultFileName),
      filters: {
        TSV: ["tsv"]
      },
      saveLabel: "Save as TSV"
    });
    if (!targetUri) {
      return;
    }

    const content = serializeResultAsTsv(result);
    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, "utf8"));
    void vscode.window.showInformationMessage(`Saved TSV: ${targetUri.fsPath}`);
  }

  private async saveResultAsCsv(resultId?: string): Promise<void> {
    const result = this.results.find((item) => item.id === (resultId ?? this.activeResultId));
    if (!result) {
      void vscode.window.showInformationMessage("No result to save.");
      return;
    }

    const defaultFileName = buildResultExportFileName(result, "csv");
    const targetUri = await vscode.window.showSaveDialog({
      defaultUri: buildDefaultExportUri(defaultFileName),
      filters: {
        CSV: ["csv"]
      },
      saveLabel: "Save as CSV"
    });
    if (!targetUri) {
      return;
    }

    const content = serializeResultAsCsv(result);
    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, "utf8"));
    void vscode.window.showInformationMessage(`Saved CSV: ${targetUri.fsPath}`);
  }

  private async runSearch(
    query: ParsedQuery,
    folderPath: string,
    extensionFilter: string,
    replaceResultId?: string
  ): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      void vscode.window.showWarningMessage("Open a workspace first.");
      return;
    }

    const rgCommand = this.resolveRgCommand();
    const targets = this.resolveSearchTargets(folderPath, workspaceFolders);

    if (targets.length === 0) {
      void vscode.window.showWarningMessage("No searchable folder was resolved.");
      return;
    }

    const args = [
      "--json",
      "--color",
      "never",
      ...buildQueryModeArgs(query),
      ...buildExtensionArgs(extensionFilter),
      query.pattern,
      ...targets
    ];
    this.log(`Running: ${rgCommand} ${args.join(" ")}`);

    let stdout = "";
    let stderr = "";
    try {
      const result = await EXEC_FILE(rgCommand, args, {
        windowsHide: true,
        maxBuffer: MAX_BUFFER
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      if (isRipgrepNoResults(error)) {
        this.addResult(query, folderPath, extensionFilter, [], replaceResultId);
        await this.focusPanel();
        void vscode.window.showInformationMessage(`No matches for "${query.raw}".`);
        return;
      }

      const message = formatError(error);
      this.log(`ripgrep failed: ${message}`);
      void vscode.window.showErrorMessage(`Ripgrep failed: ${message}`);
      return;
    }

    if (stderr.trim().length > 0) {
      this.log(stderr.trim());
    }

    const nodes = parseRipgrepOutput(stdout);
    const result = this.addResult(query, folderPath, extensionFilter, nodes, replaceResultId);
    await this.focusPanel();
    if (result.currentNodeIndex >= 0) {
      await this.openNode(result.id, result.currentNodeIndex, false);
      await this.revealCurrentNode(result);
    }
    void vscode.window.showInformationMessage(`Found ${nodes.length} node(s) for "${query.raw}".`);
  }

  private addResult(
    query: ParsedQuery,
    folderPath: string,
    extensionFilter: string,
    nodes: Node[],
    replaceResultId?: string
  ): Result {
    const result: Result = {
      id: replaceResultId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      query: query.pattern,
      rawQuery: query.raw,
      scopeLabel: folderPath.trim().length > 0 ? folderPath : "workspace",
      extensionFilter,
      createdAt: Date.now(),
      nodes,
      currentNodeIndex: nodes.length > 0 ? 0 : -1
    };

    if (replaceResultId) {
      const index = this.results.findIndex((item) => item.id === replaceResultId);
      if (index >= 0) {
        this.results.splice(index, 1, result);
      } else {
        this.results.push(result);
      }
    } else {
      this.results.push(result);
    }

    this.activeResultId = result.id;
    this.provider.refresh();
    return result;
  }

  private async promptExtensionFilter(): Promise<string | undefined> {
    const selected = await this.pickHistoryValue({
      historyKey: EXTENSION_HISTORY_KEY,
      placeHolder: "Recent extensions",
      createNewLabel: "Enter extensions",
      emptyLabel: "(all extensions)",
      iconId: "symbol-string"
    });
    const initialValue = selected ?? "";

    const value = await this.showEditableInputBox({
      prompt: "Extensions",
      placeHolder: "Example: ts,tsx,js (empty = all files)",
      value: initialValue
    });
    if (value === undefined) {
      return undefined;
    }

    return normalizeExtensionFilter(value);
  }

  private async promptSearchFolder(): Promise<string | undefined> {
    const selected = await this.pickHistoryValue({
      historyKey: FOLDER_HISTORY_KEY,
      placeHolder: "Recent folders",
      createNewLabel: "Enter folder",
      emptyLabel: "Workspace",
      iconId: "folder"
    });
    const initialValue = selected ?? "";
    const picked = await this.pickFolderCandidate(initialValue);
    if (picked === undefined) {
      return undefined;
    }

    this.lastFolderPath = picked;
    return picked;
  }

  private async promptQuery(initialValue = ""): Promise<ParsedQuery | undefined> {
    const selected = await this.pickHistoryValue({
      historyKey: QUERY_HISTORY_KEY,
      placeHolder: "Recent keywords",
      createNewLabel: "Enter keyword",
      iconId: "symbol-text"
    });
    const nextInitialValue = selected ?? initialValue;

    const value = await this.showEditableInputBox({
      prompt: "Search text",
      placeHolder: `Default is regex smart case. Use t${QUERY_MODE_DELIMITER} for literal text; b word, r regex, c ignore case, C case sensitive, s smart case`,
      value: nextInitialValue
    });
    if (value === undefined) {
      return undefined;
    }

    return parseQueryInput(value);
  }

  private getActiveResult(): Result | undefined {
    return this.results.find((result) => result.id === this.activeResultId) ?? this.results.at(-1);
  }

  private async jump(offset: number): Promise<void> {
    const result = this.getActiveResult();
    if (!result || result.nodes.length === 0) {
      void vscode.window.showInformationMessage("No results to navigate.");
      return;
    }

    const length = result.nodes.length;
    const current = result.currentNodeIndex >= 0 ? result.currentNodeIndex : 0;
    result.currentNodeIndex = (current + offset + length) % length;
    await this.openNode(result.id, result.currentNodeIndex, false);
    this.provider.refresh();
    await this.revealCurrentNode(result);
  }

  private async openNode(resultId: string, nodeIndex: number, reveal: boolean): Promise<void> {
    const result = this.results.find((item) => item.id === resultId);
    if (!result) {
      return;
    }

    const node = result.nodes[nodeIndex];
    if (!node) {
      return;
    }

    this.activeResultId = resultId;
    result.currentNodeIndex = nodeIndex;
    await this.openNodeDocument(node);
    this.provider.refresh();
    if (reveal) {
      await this.revealCurrentNode(result);
    }
  }

  private async revealCurrentNode(result: Result): Promise<void> {
    if (!this.treeView || result.currentNodeIndex < 0) {
      return;
    }

    const node = result.nodes[result.currentNodeIndex];
    if (!node) {
      return;
    }

    await this.treeView.reveal(
      {
        kind: "node",
        resultId: result.id,
        nodeIndex: result.currentNodeIndex,
        node
      },
      {
        focus: false,
        select: true,
        expand: true
      }
    );
  }

  private async openNodeDocument(node: Node): Promise<void> {
    const document = await vscode.workspace.openTextDocument(node.uri);
    const position = new vscode.Position(
      Math.max(node.line - 1, 0),
      Math.max(node.column - 1, 0)
    );
    const selection = new vscode.Selection(position, position);
    const editor = await vscode.window.showTextDocument(document, {
      preview: false
    });

    editor.selection = selection;
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }

  private async focusPanel(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.gurepane");
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    this.provider.refresh();
  }

  private resolveSearchTargets(
    folderPath: string,
    workspaceFolders: readonly vscode.WorkspaceFolder[]
  ): string[] {
    const fileWorkspaceFolders = workspaceFolders.filter((folder) => folder.uri.scheme === "file");
    if (folderPath.trim().length === 0) {
      return fileWorkspaceFolders.map((folder) => folder.uri.fsPath);
    }

    if (path.isAbsolute(folderPath)) {
      return isDirectory(folderPath) ? [folderPath] : [];
    }

    return fileWorkspaceFolders
      .map((folder) => path.join(folder.uri.fsPath, folderPath))
      .filter((candidate, index, all) => isDirectory(candidate) && all.indexOf(candidate) === index);
  }

  private getCurrentEditorFolderPath(): string | undefined {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || document.uri.scheme !== "file") {
      return undefined;
    }

    return path.dirname(document.uri.fsPath).replace(/\\/g, "/");
  }

  private async pickFolderCandidate(initialValue: string): Promise<string | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders?.filter((folder) => folder.uri.scheme === "file") ?? [];
    if (workspaceFolders.length === 0) {
      return undefined;
    }

    return await new Promise<string | undefined>((resolve) => {
      const quickPick = vscode.window.createQuickPick<FolderCandidateItem>();
      let accepted = false;
      let disposed = false;

      quickPick.title = "Choose a folder";
      quickPick.placeholder = "Type a folder name or path to search Everything";
      quickPick.matchOnDescription = true;
      quickPick.matchOnDetail = true;
      quickPick.canSelectMany = false;
      quickPick.value = initialValue.trim();

      const setCandidates = async (rawQuery: string) => {
        const query = rawQuery.trim();
        quickPick.busy = true;

        try {
          const candidates = query.length > 0
            ? await this.getFolderCandidatesFromEverything(query, workspaceFolders)
            : this.getInitialFolderCandidates(workspaceFolders);

          if (disposed) {
            return;
          }

          const preferredItem = this.pickBestFolderCandidate(query, candidates);
          quickPick.selectedItems = [];
          quickPick.items = candidates;
          quickPick.activeItems = preferredItem ? [preferredItem] : [];
        } finally {
          if (!disposed) {
            quickPick.busy = false;
          }
        }
      };

      const valueChangeDisposable = quickPick.onDidChangeValue((value) => {
        void setCandidates(value);
      });

      const acceptDisposable = quickPick.onDidAccept(() => {
        accepted = true;
        const picked = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
        cleanup();
        resolve(picked?.targetPath);
      });

      const hideDisposable = quickPick.onDidHide(() => {
        if (accepted) {
          return;
        }

        cleanup();
        resolve(undefined);
      });

      const cleanup = () => {
        disposed = true;
        valueChangeDisposable.dispose();
        acceptDisposable.dispose();
        hideDisposable.dispose();
        quickPick.dispose();
      };

      void setCandidates(quickPick.value);
      quickPick.show();
    });
  }

  private getInitialFolderCandidates(
    workspaceFolders: readonly vscode.WorkspaceFolder[]
  ): FolderCandidateItem[] {
    return workspaceFolders.map((folder) => {
      const targetPath = this.normalizeFolderPath(folder.uri.fsPath);
      return {
        label: folder.name,
        description: targetPath,
        targetPath
      };
    });
  }

  private getFolderCandidatesFromFilesystem(
    query: string,
    workspaceFolders: readonly vscode.WorkspaceFolder[]
  ): FolderCandidateItem[] {
    const seen = new Set<string>();
    const candidates: FolderCandidateItem[] = [];

    this.log(`Filesystem fallback query="${query}"`);

    for (const folder of workspaceFolders) {
      const rootPath = this.normalizeFolderPath(folder.uri.fsPath);
      if (!seen.has(rootPath)) {
        seen.add(rootPath);
        candidates.push({
          label: folder.name,
          description: rootPath,
          targetPath: rootPath
        });
      }

      for (const childPath of getDescendantDirectories(folder.uri.fsPath)) {
        const normalizedChildPath = this.normalizeFolderPath(childPath);
        if (seen.has(normalizedChildPath)) {
          continue;
        }

        seen.add(normalizedChildPath);
        candidates.push({
          label: path.basename(normalizedChildPath),
          description: normalizedChildPath,
          targetPath: normalizedChildPath
        });
      }
    }

    return candidates;
  }

  private pickBestFolderCandidate(query: string, candidates: FolderCandidateItem[]): FolderCandidateItem | undefined {
    if (candidates.length === 0) {
      return undefined;
    }

    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
      return candidates[0];
    }

    return (
      candidates.find((candidate) => (candidate.description ?? "").toLowerCase() === normalizedQuery) ??
      candidates.find((candidate) => (candidate.description ?? "").toLowerCase().includes(normalizedQuery)) ??
      candidates[0]
    );
  }

  private async getFolderCandidatesFromEverything(
    query: string,
    workspaceFolders: readonly vscode.WorkspaceFolder[]
  ): Promise<FolderCandidateItem[]> {
    const esCommand = this.resolveEsCommand();
    const searchTerms = this.getEverythingSearchTerms(query);
    const seen = new Set<string>();
    const candidates: FolderCandidateItem[] = [];
    const args = ["/ad", "-p", "-s", "-n", String(MAX_FOLDER_CANDIDATES), ...searchTerms];

    this.log(`Everything search command=${esCommand} args=${args.map((arg) => JSON.stringify(arg)).join(" ")}`);

    try {
      if (searchTerms.length === 0) {
        this.log("Everything search skipped because there are no search terms.");
        return this.getFolderCandidatesFromFilesystem(query, workspaceFolders);
      }

      const result = await EXEC_FILE(
        esCommand,
        args,
        {
          windowsHide: true,
          maxBuffer: MAX_BUFFER
        }
      );

      const stdoutLines = result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
      this.log(`Everything stdout lines=${stdoutLines.length} stderrLength=${result.stderr.trim().length}`);
      this.log(`Everything stdout sample=${stdoutLines.slice(0, 10).join(" | ")}`);

      for (const normalizedPath of this.parseEverythingFolderOutput(result.stdout)) {
        if (seen.has(normalizedPath)) {
          continue;
        }

        if (!this.isWithinWorkspaceFolders(normalizedPath, workspaceFolders)) {
          continue;
        }

        seen.add(normalizedPath);
        candidates.push({
          label: path.basename(normalizedPath),
          description: normalizedPath,
          targetPath: normalizedPath
        });
      }

      this.log(`Everything candidates kept=${candidates.length}`);
    } catch (error) {
      this.log(`Everything search failed: ${formatError(error)}`);
      return this.getFolderCandidatesFromFilesystem(query, workspaceFolders);
    }

    return candidates.sort((left, right) =>
      left.label.localeCompare(right.label) || (left.description ?? "").localeCompare(right.description ?? "")
    );
  }

  private parseEverythingFolderOutput(stdout: string): string[] {
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        if (line.startsWith('"') && line.endsWith('"')) {
          return line.slice(1, -1).replace(/""/g, '"');
        }

        return line;
      })
      .map((line) => this.normalizeFolderPath(line.replace(/\r$/, "")));
  }

  private resolveRgCommand(): string {
    const configured = vscode.workspace.getConfiguration("gurepane").get<string>("rgPath", "").trim();
    return configured.length > 0 ? configured : DEFAULT_RG_COMMAND;
  }

  private resolveEsCommand(): string {
    const configured = vscode.workspace.getConfiguration("gurepane").get<string>("esPath", "").trim();
    return configured.length > 0 ? configured : DEFAULT_ES_COMMAND;
  }

  private getEverythingSearchTerms(value: string): string[] {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return [];
    }

    const terms = trimmed.split(/\s+/).filter((term) => term.length > 0);
    return terms;
  }

  private normalizeFolderPath(value: string): string {
    return value.replace(/\\/g, "/");
  }

  private isWithinWorkspaceFolders(
    candidatePath: string,
    workspaceFolders: readonly vscode.WorkspaceFolder[]
  ): boolean {
    const normalizedCandidate = candidatePath.toLowerCase();
    return workspaceFolders.some((folder) => {
      const root = this.normalizeFolderPath(folder.uri.fsPath).toLowerCase();
      return normalizedCandidate === root || normalizedCandidate.startsWith(`${root}/`);
    });
  }

  private async pickHistoryValue(options: {
    historyKey: string;
    placeHolder: string;
    createNewLabel: string;
    emptyLabel?: string;
    iconId: string;
  }): Promise<string | undefined> {
    const history = this.getHistory(options.historyKey);
    if (history.length === 0) {
      return undefined;
    }

    await vscode.commands.executeCommand("setContext", "gurepaneHistoryPickerVisible", true);
    try {
      const picked = await vscode.window.showQuickPick(
        [
          {
            label: `$(${options.iconId}) ${options.createNewLabel}`,
            value: undefined as string | undefined
          },
          ...history.map((value) => ({
            label: value.length > 0 ? value : (options.emptyLabel ?? "(empty)"),
            description: value.length === 0 ? "recent" : undefined,
            value
          }))
        ],
        {
          placeHolder: options.placeHolder
        }
      );

      return picked?.value;
    } finally {
      await vscode.commands.executeCommand("setContext", "gurepaneHistoryPickerVisible", false);
    }
  }

  private getHistory(key: string): string[] {
    return this.extensionContext?.globalState.get<string[]>(key, []) ?? [];
  }

  private async rememberHistory(key: string, value: string): Promise<void> {
    const history = this.getHistory(key);
    const nextHistory = [value, ...history.filter((item) => item !== value)].slice(0, HISTORY_LIMIT);
    await this.extensionContext?.globalState.update(key, nextHistory);
  }

  private async showEditableInputBox(options: {
    prompt: string;
    placeHolder: string;
    value: string;
  }): Promise<string | undefined> {
    return await new Promise<string | undefined>((resolve) => {
      const inputBox = vscode.window.createInputBox();
      let accepted = false;

      inputBox.prompt = options.prompt;
      inputBox.placeholder = options.placeHolder;
      inputBox.value = options.value;

      const acceptDisposable = inputBox.onDidAccept(() => {
        accepted = true;
        const value = inputBox.value;
        cleanup();
        resolve(value);
      });

      const hideDisposable = inputBox.onDidHide(() => {
        if (accepted) {
          return;
        }

        cleanup();
        resolve(undefined);
      });

      function cleanup(): void {
        acceptDisposable.dispose();
        hideDisposable.dispose();
        inputBox.dispose();
      }

      inputBox.show();
      inputBox.valueSelection = [options.value.length, options.value.length];
    });
  }

  private log(message: string): void {
    this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  new GurepaneController().register(context);
}

export function deactivate(): void {}
