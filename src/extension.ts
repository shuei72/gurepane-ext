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
import type { ParsedQuery, ResultItem, SearchResult, SearchSession, SessionItem, TreeNode } from "./types";
import {
  buildDefaultExportUri,
  buildSessionExportFileName,
  getImmediateChildDirectories,
  isDirectory,
  removeLastFolderSegment,
  serializeSessionAsCsv,
  serializeSessionAsTsv
} from "./utils";

const SEARCH_COMMAND = "gurepane.search";
const SELECT_SESSION_COMMAND = "gurepane.selectSession";
const CHANGE_SESSION_QUERY_COMMAND = "gurepane.changeSessionQuery";
const DELETE_SESSION_COMMAND = "gurepane.deleteSession";
const DELETE_RESULT_COMMAND = "gurepane.deleteResult";
const COPY_RESULT_COMMAND = "gurepane.copyResult";
const SAVE_SESSION_AS_CSV_COMMAND = "gurepane.saveSessionAsCsv";
const SAVE_SESSION_AS_TSV_COMMAND = "gurepane.saveSessionAsTsv";
const NEXT_COMMAND = "gurepane.nextResult";
const PREVIOUS_COMMAND = "gurepane.previousResult";
const OPEN_RESULT_COMMAND = "gurepane.openResult";
const REFRESH_COMMAND = "gurepane.refresh";
const VIEW_ID = "gurepane.results";
const OUTPUT_CHANNEL_NAME = "Gurepane";
const DEFAULT_RG_COMMAND = "rg";
const MAX_BUFFER = 64 * 1024 * 1024;
const HISTORY_LIMIT = 10;
const QUERY_HISTORY_KEY = "gurepane.queryHistory";
const FOLDER_HISTORY_KEY = "gurepane.folderHistory";
const EXTENSION_HISTORY_KEY = "gurepane.extensionHistory";
const QUERY_MODE_DELIMITER = ">";
const EXEC_FILE = promisify(execFile);

class GurepaneController {
  private readonly outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  private readonly sessions: SearchSession[] = [];
  private readonly provider = new GurepaneTreeDataProvider(
    () => this.sessions,
    () => this.activeSessionId
  );
  private treeView: vscode.TreeView<TreeNode> | undefined;
  private activeSessionId: string | undefined;
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
      vscode.commands.registerCommand(SELECT_SESSION_COMMAND, async () => {
        await this.selectSession();
      }),
      vscode.commands.registerCommand(CHANGE_SESSION_QUERY_COMMAND, async (item?: SessionItem) => {
        await this.changeSessionQuery(item);
      }),
      vscode.commands.registerCommand(DELETE_SESSION_COMMAND, async (item?: SessionItem) => {
        await this.deleteSession(item?.session.id);
      }),
      vscode.commands.registerCommand(DELETE_RESULT_COMMAND, async (item?: ResultItem) => {
        await this.deleteResult(item);
      }),
      vscode.commands.registerCommand(COPY_RESULT_COMMAND, async (item?: ResultItem) => {
        await this.copyResult(item);
      }),
      vscode.commands.registerCommand(SAVE_SESSION_AS_CSV_COMMAND, async (item?: SessionItem) => {
        await this.saveSessionAsCsv(item?.session.id);
      }),
      vscode.commands.registerCommand(SAVE_SESSION_AS_TSV_COMMAND, async (item?: SessionItem) => {
        await this.saveSessionAsTsv(item?.session.id);
      }),
      vscode.commands.registerCommand(NEXT_COMMAND, async () => {
        await this.jump(1);
      }),
      vscode.commands.registerCommand(PREVIOUS_COMMAND, async () => {
        await this.jump(-1);
      }),
      vscode.commands.registerCommand(OPEN_RESULT_COMMAND, async (sessionId?: string, resultIndex?: number) => {
        if (typeof sessionId !== "string" || typeof resultIndex !== "number") {
          return;
        }

        await this.openResult(sessionId, resultIndex, true);
      }),
      vscode.commands.registerCommand(REFRESH_COMMAND, async (item?: SessionItem) => {
        await this.refreshSearch(item);
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

  private async refreshSearch(item?: SessionItem): Promise<void> {
    const session = item?.session ?? this.getActiveSession();
    if (!session) {
      void vscode.window.showInformationMessage("Run Gurepane search first.");
      return;
    }

    await this.runSearch(
      {
        raw: session.rawQuery,
        pattern: session.query,
        mode: inferQueryModeFromRaw(session.rawQuery),
        wholeWord: inferWholeWordFromRaw(session.rawQuery),
        caseMode: inferQueryCaseModeFromRaw(session.rawQuery)
      },
      session.scopeLabel === "workspace" ? "" : session.scopeLabel,
      session.extensionFilter,
      session.id
    );
  }

  private async selectSession(): Promise<void> {
    if (this.sessions.length === 0) {
      void vscode.window.showInformationMessage("No Gurepane search results to switch.");
      return;
    }

    const picked = await vscode.window.showQuickPick(
      this.sessions.map((session) => ({
        label: session.query,
        description: session.scopeLabel,
        detail: `${session.extensionFilter || "(all extensions)"} • ${session.results.length} result(s) • ${new Date(session.createdAt).toLocaleString()}`,
        sessionId: session.id
      })),
      {
        placeHolder: "Choose a Gurepane search result set"
      }
    );

    if (!picked) {
      return;
    }

    this.activeSessionId = picked.sessionId;
    this.provider.refresh();
    await this.focusPanel();

    const session = this.getActiveSession();
    if (session && session.currentIndex >= 0) {
      await this.revealCurrentResult(session);
    }
  }

  private async changeSessionQuery(item?: SessionItem): Promise<void> {
    const session = item?.session ?? this.getActiveSession();
    if (!session) {
      void vscode.window.showInformationMessage("No Gurepane search result to reuse.");
      return;
    }

    const query = await this.promptQuery(session.rawQuery);
    if (!query) {
      return;
    }

    await this.rememberHistory(QUERY_HISTORY_KEY, query.raw);
    await this.runSearch(
      query,
      session.scopeLabel === "workspace" ? "" : session.scopeLabel,
      session.extensionFilter
    );
  }

  private async deleteSession(sessionId?: string): Promise<void> {
    const resolvedSessionId = sessionId ?? this.activeSessionId;
    if (!resolvedSessionId) {
      void vscode.window.showInformationMessage("No Gurepane search result to delete.");
      return;
    }

    const index = this.sessions.findIndex((session) => session.id === resolvedSessionId);
    if (index < 0) {
      return;
    }

    this.sessions.splice(index, 1);
    if (this.activeSessionId === resolvedSessionId) {
      this.activeSessionId = this.sessions[Math.max(0, index - 1)]?.id;
    }

    this.provider.refresh();
  }

  private async deleteResult(item?: ResultItem): Promise<void> {
    if (!item) {
      return;
    }

    const session = this.sessions.find((candidate) => candidate.id === item.sessionId);
    if (!session) {
      return;
    }

    session.results.splice(item.resultIndex, 1);
    if (session.results.length === 0) {
      await this.deleteSession(session.id);
      return;
    }

    if (session.currentIndex >= session.results.length) {
      session.currentIndex = session.results.length - 1;
    }
    if (session.currentIndex > item.resultIndex) {
      session.currentIndex -= 1;
    }

    this.activeSessionId = session.id;
    this.provider.refresh();
  }

  private async copyResult(item?: ResultItem): Promise<void> {
    if (!item) {
      return;
    }

    const content = `${item.result.filePath}:${item.result.line}\n${item.result.text}`;
    await vscode.env.clipboard.writeText(content);
    void vscode.window.showInformationMessage("Copied Gurepane result.");
  }

  private async saveSessionAsTsv(sessionId?: string): Promise<void> {
    const session = this.sessions.find((item) => item.id === (sessionId ?? this.activeSessionId));
    if (!session) {
      void vscode.window.showInformationMessage("No Gurepane search result to save.");
      return;
    }

    const defaultFileName = buildSessionExportFileName(session);
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

    const content = serializeSessionAsTsv(session);
    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, "utf8"));
    void vscode.window.showInformationMessage(`Saved Gurepane results as TSV: ${targetUri.fsPath}`);
  }

  private async saveSessionAsCsv(sessionId?: string): Promise<void> {
    const session = this.sessions.find((item) => item.id === (sessionId ?? this.activeSessionId));
    if (!session) {
      void vscode.window.showInformationMessage("No Gurepane search result to save.");
      return;
    }

    const defaultFileName = buildSessionExportFileName(session, "csv");
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

    const content = serializeSessionAsCsv(session);
    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, "utf8"));
    void vscode.window.showInformationMessage(`Saved Gurepane results as CSV: ${targetUri.fsPath}`);
  }

  private async runSearch(
    query: ParsedQuery,
    folderPath: string,
    extensionFilter: string,
    replaceSessionId?: string
  ): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      void vscode.window.showWarningMessage("Gurepane needs an open workspace.");
      return;
    }

    const rgCommand = this.resolveRgCommand();
    const targets = this.resolveSearchTargets(folderPath, workspaceFolders);

    if (targets.length === 0) {
      void vscode.window.showWarningMessage("No searchable folder was resolved for Gurepane.");
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
        this.addSession(query, folderPath, extensionFilter, [], replaceSessionId);
        await this.focusPanel();
        void vscode.window.showInformationMessage(`No matches for "${query.raw}".`);
        return;
      }

      const message = formatError(error);
      this.log(`ripgrep failed: ${message}`);
      void vscode.window.showErrorMessage(`Gurepane could not run ripgrep: ${message}`);
      return;
    }

    if (stderr.trim().length > 0) {
      this.log(stderr.trim());
    }

    const results = parseRipgrepOutput(stdout);
    const session = this.addSession(query, folderPath, extensionFilter, results, replaceSessionId);
    await this.focusPanel();
    if (session.currentIndex >= 0) {
      await this.openSearchResult(session.results[session.currentIndex]);
      await this.revealCurrentResult(session);
    }
    void vscode.window.showInformationMessage(`Gurepane found ${results.length} result(s) for "${query.raw}".`);
  }

  private addSession(
    query: ParsedQuery,
    folderPath: string,
    extensionFilter: string,
    results: SearchResult[],
    replaceSessionId?: string
  ): SearchSession {
    const session: SearchSession = {
      id: replaceSessionId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      query: query.pattern,
      rawQuery: query.raw,
      scopeLabel: folderPath.trim().length > 0 ? folderPath : "workspace",
      extensionFilter,
      createdAt: Date.now(),
      results,
      currentIndex: results.length > 0 ? 0 : -1
    };

    if (replaceSessionId) {
      const index = this.sessions.findIndex((item) => item.id === replaceSessionId);
      if (index >= 0) {
        this.sessions.splice(index, 1, session);
      } else {
        this.sessions.push(session);
      }
    } else {
      this.sessions.push(session);
    }

    this.activeSessionId = session.id;
    this.provider.refresh();
    return session;
  }

  private async promptExtensionFilter(): Promise<string | undefined> {
    const selected = await this.pickHistoryValue({
      historyKey: EXTENSION_HISTORY_KEY,
      placeHolder: "Choose recent extensions or enter new",
      createNewLabel: "Enter extensions",
      emptyLabel: "(all extensions)",
      iconId: "symbol-string"
    });
    const initialValue = selected ?? "";

    const value = await this.showEditableInputBox({
      prompt: "Extensions to search",
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
      placeHolder: "Choose recent folder or enter new",
      createNewLabel: "Enter folder",
      emptyLabel: "Workspace",
      iconId: "folder"
    });
    const initialValue = selected ?? "";

    return await new Promise<string | undefined>((resolve) => {
      const inputBox = vscode.window.createInputBox();
      let currentValue = initialValue;
      let handlingShortcut = false;
      let accepted = false;
      let pickingChildFolder = false;
      let suppressHideOnce = false;

      inputBox.prompt = "Search folder";
      inputBox.placeholder = "Empty = workspace, . = current folder, .. = up one level, @ = previous folder";
      inputBox.value = initialValue;
      inputBox.valueSelection = [initialValue.length, initialValue.length];

      const changeDisposable = inputBox.onDidChangeValue((value) => {
        if (handlingShortcut) {
          currentValue = value;
          return;
        }

        if (value.endsWith(". ") && !value.endsWith(".. ")) {
          const currentFolderPath = this.getCurrentEditorFolderPath();
          if (!currentFolderPath) {
            return;
          }

          handlingShortcut = true;
          inputBox.value = currentFolderPath;
          inputBox.valueSelection = [currentFolderPath.length, currentFolderPath.length];
          currentValue = currentFolderPath;
          handlingShortcut = false;
          return;
        }

        if (value.endsWith(".. ")) {
          const baseValue = value.slice(0, -3).trimEnd();
          const nextValue = removeLastFolderSegment(baseValue);
          handlingShortcut = true;
          inputBox.value = nextValue;
          inputBox.valueSelection = [nextValue.length, nextValue.length];
          currentValue = nextValue;
          handlingShortcut = false;
          return;
        }

        if (value.endsWith("@ ")) {
          const nextValue = this.lastFolderPath;
          handlingShortcut = true;
          inputBox.value = nextValue;
          inputBox.valueSelection = [nextValue.length, nextValue.length];
          currentValue = nextValue;
          handlingShortcut = false;
          return;
        }

        if (value.endsWith("/") || value.endsWith("\\")) {
          const baseValue = value.replace(/[\\/]+$/g, "");
          pickingChildFolder = true;
          suppressHideOnce = true;
          void this.pickChildFolder(baseValue).then((pickedPath) => {
            pickingChildFolder = false;
            if (pickedPath === undefined) {
              inputBox.show();
              return;
            }

            handlingShortcut = true;
            inputBox.value = pickedPath;
            inputBox.valueSelection = [pickedPath.length, pickedPath.length];
            currentValue = pickedPath;
            inputBox.show();
            handlingShortcut = false;
          });
          return;
        }

        currentValue = value;
      });

      const acceptDisposable = inputBox.onDidAccept(() => {
        accepted = true;
        const normalized = inputBox.value.trim();
        this.lastFolderPath = normalized;
        cleanup();
        resolve(normalized);
      });

      const hideDisposable = inputBox.onDidHide(() => {
        if (suppressHideOnce || pickingChildFolder) {
          suppressHideOnce = false;
          return;
        }

        if (accepted) {
          return;
        }

        cleanup();
        resolve(undefined);
      });

      function cleanup(): void {
        changeDisposable.dispose();
        acceptDisposable.dispose();
        hideDisposable.dispose();
        inputBox.dispose();
      }

      inputBox.show();
    });
  }

  private async promptQuery(initialValue = ""): Promise<ParsedQuery | undefined> {
    const selected = await this.pickHistoryValue({
      historyKey: QUERY_HISTORY_KEY,
      placeHolder: "Choose recent keyword or enter new",
      createNewLabel: "Enter keyword",
      iconId: "symbol-text"
    });
    const nextInitialValue = selected ?? initialValue;

    const value = await this.showEditableInputBox({
      prompt: "Search text for ripgrep",
      placeHolder: `Prefix before ${QUERY_MODE_DELIMITER}: b word, t text, r regex, c ignore case, C case sensitive, s smart case`,
      value: nextInitialValue
    });
    if (value === undefined) {
      return undefined;
    }

    return parseQueryInput(value);
  }

  private getActiveSession(): SearchSession | undefined {
    return this.sessions.find((session) => session.id === this.activeSessionId) ?? this.sessions.at(-1);
  }

  private async jump(offset: number): Promise<void> {
    const session = this.getActiveSession();
    if (!session || session.results.length === 0) {
      void vscode.window.showInformationMessage("No Gurepane results to navigate.");
      return;
    }

    const length = session.results.length;
    const current = session.currentIndex >= 0 ? session.currentIndex : 0;
    session.currentIndex = (current + offset + length) % length;
    await this.openSearchResult(session.results[session.currentIndex]);
    this.provider.refresh();
    await this.revealCurrentResult(session);
  }

  private async openResult(sessionId: string, resultIndex: number, reveal: boolean): Promise<void> {
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) {
      return;
    }

    const result = session.results[resultIndex];
    if (!result) {
      return;
    }

    this.activeSessionId = sessionId;
    session.currentIndex = resultIndex;
    await this.openSearchResult(result);
    this.provider.refresh();
    if (reveal) {
      await this.revealCurrentResult(session);
    }
  }

  private async revealCurrentResult(session: SearchSession): Promise<void> {
    if (!this.treeView || session.currentIndex < 0) {
      return;
    }

    const result = session.results[session.currentIndex];
    if (!result) {
      return;
    }

    await this.treeView.reveal(
      {
        kind: "result",
        sessionId: session.id,
        resultIndex: session.currentIndex,
        result
      },
      {
        focus: false,
        select: true,
        expand: true
      }
    );
  }

  private async openSearchResult(result: SearchResult): Promise<void> {
    const document = await vscode.workspace.openTextDocument(result.uri);
    const position = new vscode.Position(
      Math.max(result.line - 1, 0),
      Math.max(result.column - 1, 0)
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

  private async pickChildFolder(baseValue: string): Promise<string | undefined> {
    const candidates = this.getChildFolderCandidates(baseValue);
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage("No child folders found.");
      return undefined;
    }

    const picked = await vscode.window.showQuickPick(candidates, {
      placeHolder: "Choose a child folder"
    });

    return picked?.targetPath;
  }

  private getChildFolderCandidates(baseValue: string): Array<vscode.QuickPickItem & { readonly targetPath: string }> {
    const workspaceFolders = vscode.workspace.workspaceFolders?.filter((folder) => folder.uri.scheme === "file") ?? [];
    if (workspaceFolders.length === 0) {
      return [];
    }

    const seen = new Set<string>();
    const candidates: Array<vscode.QuickPickItem & { readonly targetPath: string }> = [];

    if (baseValue.trim().length === 0) {
      for (const folder of workspaceFolders) {
        const targetPath = folder.uri.fsPath.replace(/\\/g, "/");
        if (seen.has(targetPath)) {
          continue;
        }

        seen.add(targetPath);
        candidates.push({
          label: folder.name,
          description: targetPath,
          targetPath
        });
      }

      return candidates;
    }

    for (const parentPath of this.resolveSearchTargets(baseValue, workspaceFolders)) {
      for (const childPath of getImmediateChildDirectories(parentPath)) {
        const normalizedChildPath = childPath.replace(/\\/g, "/");
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

    return candidates.sort((left, right) =>
      left.label.localeCompare(right.label) || (left.description ?? "").localeCompare(right.description ?? "")
    );
  }

  private resolveRgCommand(): string {
    const configured = vscode.workspace.getConfiguration("gurepane").get<string>("rgPath", "").trim();
    return configured.length > 0 ? configured : DEFAULT_RG_COMMAND;
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
