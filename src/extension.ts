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
import type { FileItem, Node, NodeItem, ParsedQuery, Result, ResultItem, TreeNode } from "./types";
import {
  buildDefaultExportUri,
  buildResultExportFileName,
  getDescendantDirectories,
  isDirectory,
  findRootPath,
  removeLastFolderSegment,
  serializeResultAsCsv,
  serializeResultAsTsv
} from "./utils";

const SEARCH_COMMAND = "gurepane.search";
const SELECT_RESULT_COMMAND = "gurepane.selectResult";
const CHANGE_RESULT_QUERY_COMMAND = "gurepane.changeResultQuery";
const DELETE_RESULT_COMMAND = "gurepane.deleteResult";
const DELETE_FILE_GROUP_COMMAND = "gurepane.deleteFileGroup";
const DELETE_NODE_COMMAND = "gurepane.deleteNode";
const COPY_NODE_COMMAND = "gurepane.copyNode";
const SAVE_RESULT_AS_CSV_COMMAND = "gurepane.saveResultAsCsv";
const SAVE_RESULT_AS_TSV_COMMAND = "gurepane.saveResultAsTsv";
const NEXT_NODE_COMMAND = "gurepane.nextNode";
const PREVIOUS_NODE_COMMAND = "gurepane.previousNode";
const OPEN_NODE_COMMAND = "gurepane.openNode";
const REVEAL_CURRENT_NODE_COMMAND = "gurepane.revealCurrentNode";
const REFRESH_COMMAND = "gurepane.refreshResult";
const FOLDER_PICKER_UP_COMMAND = "gurepane.folderPickerUp";
const FOLDER_PICKER_ACCEPT_COMMAND = "gurepane.folderPickerAccept";
const FOLDER_PICKER_ADD_TARGET_COMMAND = "gurepane.folderPickerAddTarget";
const FOLDER_PICKER_ADD_TARGET_NO_TRANSITION_COMMAND = "gurepane.folderPickerAddTargetNoTransition";
const VIEW_ID = "gurepane.results";
const OUTPUT_CHANNEL_NAME = "Gurepane";
const DEFAULT_RG_COMMAND = "rg";
const DEFAULT_ES_COMMAND = "es.exe";
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_FOLDER_CANDIDATES = 200;
const PROCEED_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("search"),
  tooltip: "Proceed to Search"
};
const HISTORY_LIMIT = 10;
const QUERY_HISTORY_KEY = "gurepane.queryHistory";
const FOLDER_HISTORY_KEY = "gurepane.folderHistory";
const EXTENSION_HISTORY_KEY = "gurepane.extensionHistory";
const QUERY_MODE_DELIMITER = ">";
const EXEC_FILE = promisify(execFile);

type FolderPromptItem = vscode.QuickPickItem & {
  readonly targetPath: string;
  isSelectionItem?: boolean;
};

type FolderCandidateItem = vscode.QuickPickItem & {
  readonly filterText?: string;
  readonly targetPath: string;
  isSelectionItem?: boolean;
};

type FolderPickerItem = FolderPromptItem | FolderCandidateItem | vscode.QuickPickItem;

class GurepaneController {
  private readonly outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  private readonly results: Result[] = [];
  private readonly provider = new GurepaneTreeDataProvider(
    () => this.results,
    () => this.activeResultId
  );
  private treeView: vscode.TreeView<TreeNode> | undefined;
  private activeResultId: string | undefined;
  private extensionContext: vscode.ExtensionContext | undefined;
  private activeFolderQuickPick: vscode.QuickPick<FolderPickerItem> | undefined;
  private folderPickerResolve?: (value: string | undefined, finalize: boolean, back: boolean, addCurrent: boolean) => void | Promise<void>;

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
      vscode.commands.registerCommand(DELETE_FILE_GROUP_COMMAND, async (item?: FileItem) => {
        await this.deleteFileGroup(item);
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
      }),
      vscode.commands.registerCommand(FOLDER_PICKER_UP_COMMAND, () => {
        if (this.activeFolderQuickPick) {
          this.activeFolderQuickPick.value = removeLastFolderSegment(this.activeFolderQuickPick.value);
        }
      }),
      vscode.commands.registerCommand(FOLDER_PICKER_ACCEPT_COMMAND, () => {
        if (this.activeFolderQuickPick && this.folderPickerResolve) {
          const picked = this.activeFolderQuickPick.selectedItems[0] ?? this.activeFolderQuickPick.activeItems[0];
          const rawValue = this.activeFolderQuickPick.value.trim();
          const targetPath = this.getFolderPickerTargetPath(picked, rawValue);
          void this.folderPickerResolve?.(undefined, true, false, false);
        }
      }),
      vscode.commands.registerCommand(FOLDER_PICKER_ADD_TARGET_COMMAND, () => {
        if (this.activeFolderQuickPick && this.folderPickerResolve) {
          const picked = this.activeFolderQuickPick.selectedItems[0] ?? this.activeFolderQuickPick.activeItems[0];
          const rawValue = this.activeFolderQuickPick.value.trim();
          const targetPath = this.getFolderPickerTargetPath(picked, rawValue);
          const isStage2 = this.activeFolderQuickPick.step && this.activeFolderQuickPick.step > 1;

          if (targetPath === undefined) {
            // Empty input + Shift+Enter = Proceed to extensions if selections exist
            void this.folderPickerResolve?.(undefined, true, false, false);
          } else {
            // Stage 1: Add and stay. Stage 2: Add and return to Stage 1.
            void this.folderPickerResolve?.(targetPath, false, !!isStage2, true);
          }
        }
      }),
      vscode.commands.registerCommand(FOLDER_PICKER_ADD_TARGET_NO_TRANSITION_COMMAND, () => {
        if (this.activeFolderQuickPick && this.folderPickerResolve) {
          const picked = this.activeFolderQuickPick.selectedItems[0] ?? this.activeFolderQuickPick.activeItems[0];
          const rawValue = this.activeFolderQuickPick.value.trim();
          const targetPath = this.getFolderPickerTargetPath(picked, rawValue);

          if (targetPath !== undefined) {
            // Always pass back=false to stay in the current picker stage
            void this.folderPickerResolve?.(targetPath, false, false, true);
          }
        }
      })
    );
  }

  private async search(): Promise<void> {
    const query = await this.promptQuery();
    if (!query) {
      return;
    }

    const folderPaths = await this.promptSearchFolder();
    if (folderPaths === undefined || folderPaths.length === 0) {
      return;
    }

    const extensionFilter = await this.promptExtensionFilter();
    if (extensionFilter === undefined) {
      return;
    }

    await this.rememberHistory(QUERY_HISTORY_KEY, query.raw);
    for (const folderPath of folderPaths) {
      await this.rememberHistory(FOLDER_HISTORY_KEY, folderPath);
    }
    await this.rememberHistory(EXTENSION_HISTORY_KEY, extensionFilter);
    await this.runSearch(query, folderPaths, extensionFilter);
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
      result.folderPaths,
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
      result.folderPaths,
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
      this.activeResultId = (this.results[index] ?? this.results[index - 1])?.id;
    }

    this.provider.refresh();

    const activeResult = this.getActiveResult();
    if (activeResult) {
      if (activeResult.currentNodeIndex >= 0) {
        await this.revealCurrentNode(activeResult);
      } else {
        await this.treeView?.reveal({ kind: "result", result: activeResult }, { focus: true, select: true });
      }
    }
  }

  private async deleteFileGroup(item?: FileItem): Promise<void> {
    if (!item) {
      return;
    }

    const result = this.results.find((candidate) => candidate.id === item.resultId);
    if (!result) {
      return;
    }

    const matchingIndices: number[] = [];
    result.nodes.forEach((node, nodeIndex) => {
      if (node.relativePath === item.relativePath) {
        matchingIndices.push(nodeIndex);
      }
    });

    if (matchingIndices.length === 0) {
      return;
    }

    const firstRemovedIndex = matchingIndices[0];
    const lastRemovedIndex = matchingIndices[matchingIndices.length - 1];
    const removedCount = matchingIndices.length;
    const currentIndex = result.currentNodeIndex;
    const currentNodeWasRemoved = currentIndex >= firstRemovedIndex && currentIndex <= lastRemovedIndex;

    for (const nodeIndex of [...matchingIndices].reverse()) {
      result.nodes.splice(nodeIndex, 1);
    }

    if (result.nodes.length === 0) {
      await this.deleteResult(result.id);
      return;
    }

    if (currentNodeWasRemoved) {
      result.currentNodeIndex = Math.min(firstRemovedIndex, result.nodes.length - 1);
    } else if (currentIndex > lastRemovedIndex) {
      result.currentNodeIndex = currentIndex - removedCount;
    }

    this.activeResultId = result.id;
    this.provider.refresh();
    await this.revealCurrentNode(result);
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
    await this.revealCurrentNode(result);
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
    folderPaths: string[],
    extensionFilter: string,
    replaceResultId?: string
  ): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      void vscode.window.showWarningMessage("Open a workspace first.");
      return;
    }

    const rgCommand = this.resolveRgCommand();
    const targets = this.resolveSearchTargets(folderPaths, workspaceFolders);
    const excludePatterns = this.resolveExcludePatterns();

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
      ...excludePatterns.flatMap((p) => ["-g", `!${p}`]),
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
        this.addResult(query, folderPaths, extensionFilter, [], replaceResultId);
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
    const result = this.addResult(query, folderPaths, extensionFilter, nodes, replaceResultId);
    await this.focusPanel();
    if (result.currentNodeIndex >= 0) {
      await this.openNode(result.id, result.currentNodeIndex, false);
      await this.revealCurrentNode(result);
    }
    void vscode.window.showInformationMessage(`Found ${nodes.length} node(s) for "${query.raw}".`);
  }

  private addResult(
    query: ParsedQuery,
    folderPaths: string[],
    extensionFilter: string,
    nodes: Node[],
    replaceResultId?: string
  ): Result {
    const folderPathsNormalized = folderPaths.map(p => this.normalizeFolderPath(p));
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const isExternal = folderPathsNormalized.some(p => p.trim().length > 0 && !workspaceFolders.some((folder) => {
      const root = this.normalizeFolderPath(folder.uri.fsPath).toLowerCase();
      const target = p.toLowerCase();
      return target === root || target.startsWith(`${root}/`);
    }));

    const result: Result = {
      id: replaceResultId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      query: query.pattern,
      rawQuery: query.raw,
      folderPaths: folderPathsNormalized,
      scopeLabel: folderPathsNormalized.length === 0 || (folderPathsNormalized.length === 1 && folderPathsNormalized[0].trim() === "")
        ? "workspace"
        : folderPathsNormalized.join(", "),
      extensionFilter,
      createdAt: Date.now(),
      isExternal,
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

  private async promptSearchFolder(): Promise<string[] | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders?.filter((folder) => folder.uri.scheme === "file") ?? [];
    const firstWorkspacePath = workspaceFolders.length > 0 ? this.normalizeFolderPath(workspaceFolders[0].uri.fsPath) : "";
    const currentFolderPath = this.getCurrentEditorFolderPath();
    const selectedPaths = new Set<string>();
    let initialStage2Value = "";

    return await new Promise<string[] | undefined>((resolve) => {
      const showStage1 = () => {
        const quickPick = vscode.window.createQuickPick<FolderPickerItem>();
        quickPick.placeholder = "Choose folder source";
        quickPick.step = 1;
        quickPick.totalSteps = 2;
        let isTransitioning = false;

        this.activeFolderQuickPick = quickPick;
        this.folderPickerResolve = async (val, finalize, back, addCurrent) => {
          if (addCurrent && val !== undefined) {
            const pathToAdd = (val === "" && firstWorkspacePath) ? firstWorkspacePath : val;
            if (pathToAdd !== "") {
              selectedPaths.add(pathToAdd);
              quickPick.value = "";
              updateItems();
            }
          }

          if (finalize) {
            if (val === undefined && selectedPaths.size > 0) {
              isTransitioning = true;
              quickPick.hide();
              resolve(Array.from(selectedPaths));
              return;
            }

            isTransitioning = true;
            quickPick.hide();
            const startValue = (val === "" && firstWorkspacePath) ? firstWorkspacePath : (val ?? initialStage2Value);
            const result = await this.pickFolderCandidate(startValue, selectedPaths);
            if (result === "BACK") {
              initialStage2Value = ""; // 戻ってきたときは入力をクリア
              showStage1();
            } else {
              resolve(result);
            }
          } else if (val !== undefined) {
            // Shift + Enter: [Workspace] の場合はルートパスを、それ以外はそのパスを追加する
            const pathToAdd = (val === "" && firstWorkspacePath) ? firstWorkspacePath : val;
            if (pathToAdd !== "") {
              selectedPaths.add(pathToAdd);
            }

            quickPick.value = "";
            quickPick.title = `Choose folder source (${selectedPaths.size} selected)`;
            quickPick.placeholder = `Selected: ${Array.from(selectedPaths).join(", ")}`;
            updateItems();
          }
        }

        void vscode.commands.executeCommand("setContext", "gurepaneFolderPickerActive", true);

        const updateItems = () => {
          quickPick.buttons = selectedPaths.size > 0 ? [PROCEED_BUTTON] : [];
          const history = this.getHistory(FOLDER_HISTORY_KEY);
          const selectedItems: FolderPromptItem[] = Array.from(selectedPaths).map(p => ({
            label: `$(check) ${path.basename(p) || p}`,
            description: p,
            targetPath: p,
            isSelectionItem: true,
            buttons: [
              {
                iconPath: new vscode.ThemeIcon("trash"),
                tooltip: "Remove from selection"
              }
            ]
          }));

          quickPick.items = [
            ...(currentFolderPath
              ? [{
                  label: "[Current Folder]",
                  description: currentFolderPath,
                  targetPath: currentFolderPath
                }]
              : []),
            {
              label: "[Workspace]",
              description: firstWorkspacePath || "Search whole workspace",
              targetPath: ""
            },
            ...history.map((value) => ({
              label: value.length > 0 ? value : "(empty)",
              description: value.length === 0 ? "workspace" : undefined,
              targetPath: value,
              buttons: [
                {
                  iconPath: new vscode.ThemeIcon("close"),
                  tooltip: "Remove from history"
                }
              ]
            })),
            ...this.buildSelectedFolderSection(selectedPaths)
          ];
        };

        updateItems();

        const buttonDisposable = quickPick.onDidTriggerButton((button) => {
          if (button === PROCEED_BUTTON) {
            void this.folderPickerResolve?.(undefined, true, false, false);
          }
        });

        const triggerDisposable = quickPick.onDidTriggerItemButton(async (e) => {
          const item = e.item as FolderPromptItem;
          if (item.isSelectionItem) {
            selectedPaths.delete(item.targetPath);
            if (selectedPaths.size > 0) {
              quickPick.title = `Choose folder source (${selectedPaths.size} selected)`;
              quickPick.placeholder = `Selected: ${Array.from(selectedPaths).join(", ")}`;
            } else {
              quickPick.title = "";
              quickPick.placeholder = "Choose folder source";
            }
          } else if ("targetPath" in e.item) {
            const targetPath = e.item.targetPath;
            const history = this.getHistory(FOLDER_HISTORY_KEY);
            const nextHistory = history.filter((v) => v !== targetPath);
            await this.extensionContext?.globalState.update(FOLDER_HISTORY_KEY, nextHistory);
          }
          updateItems();
        });

        const acceptDisposable = quickPick.onDidAccept(async () => {
          const picked = quickPick.selectedItems[0];
          if (!picked) {
            if (quickPick.value.trim() === "" && selectedPaths.size > 0) {
              void this.folderPickerResolve?.(undefined, true, false, false);
            }
            return;
          }
          const targetPath = this.getFolderPickerTargetPath(picked, quickPick.value);
          if (targetPath === undefined) {
            return;
          }
          void this.folderPickerResolve?.(targetPath, true, false, false);
        });

        const hideDisposable = quickPick.onDidHide(() => {
          if (!isTransitioning) {
            void vscode.commands.executeCommand("setContext", "gurepaneFolderPickerActive", false);
            this.activeFolderQuickPick = undefined;
            this.folderPickerResolve = undefined;
            resolve(undefined);
          }

          buttonDisposable.dispose();
          triggerDisposable.dispose();
          acceptDisposable.dispose();
          hideDisposable.dispose();
          quickPick.dispose();
        });

        quickPick.show();
      };

      showStage1();
    });
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

    const nodeCount = result.nodes.filter(n => n.filePath === node.filePath).length;
    const rootPath = findRootPath(node.filePath, result.folderPaths);
    const fileItem: FileItem = {
      kind: "file",
      resultId: result.id,
      relativePath: node.relativePath,
      filePath: node.filePath,
      nodeCount,
      rootPath
    };
    const nodeItem: NodeItem = {
      kind: "node",
      resultId: result.id,
      nodeIndex: result.currentNodeIndex,
      node
    };

    await this.treeView.reveal(
      {
        kind: "result",
        result
      },
      {
        focus: false,
        select: false,
        expand: true
      }
    );

    await this.treeView.reveal(fileItem, {
      focus: false,
      select: false,
      expand: true
    });

    await this.treeView.reveal(nodeItem, {
      focus: true,
      select: true,
      expand: false
    });
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
    folderPaths: string[],
    workspaceFolders: readonly vscode.WorkspaceFolder[]
  ): string[] {
    const fileWorkspaceFolders = workspaceFolders.filter((folder) => folder.uri.scheme === "file");
    if (folderPaths.length === 0 || (folderPaths.length === 1 && folderPaths[0].trim().length === 0)) {
      return fileWorkspaceFolders.map((folder) => folder.uri.fsPath);
    }

    const resolved = new Set<string>();
    for (const p of folderPaths) {
      const trimmed = p.trim();
      if (!trimmed) continue;

      if (path.isAbsolute(trimmed)) {
        if (isDirectory(trimmed)) resolved.add(trimmed);
      } else {
        for (const ws of fileWorkspaceFolders) {
          const candidate = path.join(ws.uri.fsPath, trimmed);
          if (isDirectory(candidate)) resolved.add(candidate);
        }
      }
    }
    return Array.from(resolved);
  }

  private getCurrentEditorFolderPath(): string | undefined {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || document.uri.scheme !== "file") {
      return undefined;
    }

    return path.dirname(document.uri.fsPath).replace(/\\/g, "/");
  }

  private resolveRgCommand(): string {
    const configured = vscode.workspace.getConfiguration("gurepane").get<string>("rgPath", "").trim();
    return configured.length > 0 ? configured : DEFAULT_RG_COMMAND;
  }

  private buildSelectedFolderSection(selectedPaths: Set<string>): FolderPickerItem[] {
    if (selectedPaths.size === 0) {
      return [];
    }

    const selectedItems: FolderPickerItem[] = Array.from(selectedPaths).map((p) => ({
      label: `$(check) ${path.basename(p) || p}`,
      description: p,
      targetPath: p,
      alwaysShow: true,
      isSelectionItem: true,
      buttons: [
        {
          iconPath: new vscode.ThemeIcon("trash"),
          tooltip: "Remove from selection"
        }
      ]
    }));

    return [
      { label: "Selected Folders", kind: vscode.QuickPickItemKind.Separator },
      ...selectedItems
    ];
  }

  private appendSelectedFolderSection(
    items: FolderCandidateItem[],
    selectedPaths: Set<string>
  ): FolderPickerItem[] {
    return [...items, ...this.buildSelectedFolderSection(selectedPaths)];
  }

  private resolveEsCommand(): string {
    const configured = vscode.workspace.getConfiguration("gurepane").get<string>("esPath", "").trim();
    return configured.length > 0 ? configured : DEFAULT_ES_COMMAND;
  }

  private resolveUseEs(): boolean {
    return vscode.workspace.getConfiguration("gurepane").get<boolean>("useEs", true);
  }

  private resolveExcludePatterns(): string[] {
    return vscode.workspace.getConfiguration("gurepane").get<string[]>("excludePatterns", ["node_modules", ".git"]);
  }

  private getFolderPickerTargetPath(
    picked: FolderPickerItem | undefined,
    rawValue: string
  ): string | undefined {
    if (picked && "targetPath" in picked) {
      return picked.targetPath;
    }

    const trimmed = rawValue.trim();
    return trimmed.length > 0 ? this.normalizeFolderPath(trimmed) : undefined;
  }

  private async pickFolderCandidate(initialValue: string, selectedPaths: Set<string> = new Set()): Promise<string[] | "BACK" | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders?.filter((folder) => folder.uri.scheme === "file") ?? [];
    if (workspaceFolders.length === 0) {
      return undefined;
    }

    const useEs = this.resolveUseEs();
    const esCommand = this.resolveEsCommand();
    const esAvailable = useEs
      ? await EXEC_FILE(esCommand, ["-h"], { windowsHide: true }).then(() => true).catch(() => false)
      : false;

    if (!esAvailable && initialValue === "") {
      const currentFolder = this.getCurrentEditorFolderPath();
      const defaultUri = currentFolder ? vscode.Uri.file(currentFolder) : workspaceFolders[0]?.uri;

      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: true,
        openLabel: "Select Folder to Search",
        defaultUri
      });
      const picked = selected ? selected.map(uri => this.normalizeFolderPath(uri.fsPath)) : [];
      picked.forEach(p => selectedPaths.add(p));
      return selectedPaths.size > 0 ? Array.from(selectedPaths) : undefined;
    }

    return await new Promise<string[] | "BACK" | undefined>(async (resolve) => {
      const quickPick = vscode.window.createQuickPick<FolderPickerItem>();
      let acceptedValue: string[] | "BACK" | undefined = undefined;
      let lastRequestId = 0;
      let disposed = false;

      quickPick.title = "Choose a folder";
      quickPick.placeholder = "Type a folder name or path to search Everything";
      quickPick.step = 2;
      quickPick.totalSteps = 2;
      quickPick.matchOnDescription = true;
      quickPick.matchOnDetail = true;
      quickPick.canSelectMany = false;
      const history = this.getHistory(FOLDER_HISTORY_KEY);

      this.activeFolderQuickPick = quickPick;

      const updateHeader = () => {
        const buttons: vscode.QuickInputButton[] = [vscode.QuickInputButtons.Back];
        if (selectedPaths.size > 0) {
          buttons.push(PROCEED_BUTTON);
        }
        quickPick.buttons = buttons;

        if (selectedPaths.size > 0) {
          quickPick.title = `Choose folders (${selectedPaths.size} selected)`;
          quickPick.placeholder = `Selected: ${Array.from(selectedPaths).join(", ")}`;
        } else {
          quickPick.title = "Choose a folder";
          quickPick.placeholder = "Type a folder name or path to search Everything";
        }
      };

      updateHeader();

      this.folderPickerResolve = (val, finalize, back, addCurrent) => {
        if (addCurrent && val) {
          selectedPaths.add(val);
        }

        if (back) {
          acceptedValue = "BACK";
          quickPick.hide();
        } else if (finalize) {
          acceptedValue = selectedPaths.size > 0 ? Array.from(selectedPaths) : undefined;
          quickPick.hide();
        } else {
          quickPick.value = "";
          updateHeader();
          void setCandidates("");
        }
      };
      await vscode.commands.executeCommand("setContext", "gurepaneFolderPickerActive", true);

      const buttonDisposable = quickPick.onDidTriggerButton(button => {
        if (button === vscode.QuickInputButtons.Back) {
          void this.folderPickerResolve?.(undefined, false, true, false);
        } else if (button === PROCEED_BUTTON) {
          void this.folderPickerResolve?.(undefined, true, false, false);
        }
      });

      const setCandidates = async (rawQuery: string) => {
        const query = rawQuery.trim();
        const requestId = ++lastRequestId;
        quickPick.busy = true;

        try {
          let baseCandidates: FolderCandidateItem[] = query.length > 0
            ? await this.getFolderCandidatesFromEverything(query, workspaceFolders, history)
            : this.getInitialFolderCandidates(workspaceFolders);

          if (disposed || requestId !== lastRequestId) {
            return;
          }

          if (query.includes("\\")) {
            baseCandidates = baseCandidates.map((c) => ({
              ...c,
              description: c.description?.replace(/\//g, "\\")
            }));
          }

          const candidates: FolderPickerItem[] = this.appendSelectedFolderSection(baseCandidates, selectedPaths);

          const preferredItem = this.pickBestFolderCandidate(query, baseCandidates);
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

      const triggerDisposable = quickPick.onDidTriggerItemButton((e) => {
        const item = e.item as FolderCandidateItem;
        if (item.isSelectionItem) {
          selectedPaths.delete(item.targetPath);
          updateHeader();
          void setCandidates(quickPick.value);
        }
      });

      const acceptDisposable = quickPick.onDidAccept(() => {
        const picked = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
        const currentValue = this.normalizeFolderPath(quickPick.value.trim());

        if (picked && "targetPath" in picked) {
          // 入力内容と候補が完全に一致している状態で Enter が押されたら確定とする
          if (currentValue === picked.targetPath) {
            void this.folderPickerResolve?.(picked.targetPath, true, false, true);
          } else {
            // それ以外（補完目的）なら入力欄に反映する
            quickPick.value = picked.targetPath;
            quickPick.activeItems = [];
          }
        } else if (currentValue.length > 0) {
          // 候補がない（Everythingの結果が空）場合でも、入力があればそのパスで確定する
          void this.folderPickerResolve?.(currentValue, true, false, true);
        } else if (selectedPaths.size > 0) {
          void this.folderPickerResolve?.(undefined, true, false, false);
        }
      });

      const hideDisposable = quickPick.onDidHide(() => {
        cleanup();
        resolve(acceptedValue);
      });

      const cleanup = () => {
        disposed = true;
        this.activeFolderQuickPick = undefined;
        this.folderPickerResolve = undefined;
        void vscode.commands.executeCommand("setContext", "gurepaneFolderPickerActive", false);
        valueChangeDisposable.dispose();
        buttonDisposable.dispose();
        triggerDisposable.dispose();
        acceptDisposable.dispose();
        hideDisposable.dispose();
        quickPick.dispose();
      };

      const startValue = initialValue.trim();
      void setCandidates(startValue);
      quickPick.show();
      quickPick.value = startValue;
    });
  }

  private getInitialFolderCandidates(
    workspaceFolders: readonly vscode.WorkspaceFolder[]
  ): FolderCandidateItem[] {
    const history = this.getHistory(FOLDER_HISTORY_KEY);
    return workspaceFolders.map((folder) => {
      const targetPath = this.normalizeFolderPath(folder.uri.fsPath);
      const isInHistory = history.includes(targetPath);
      return {
        label: `${isInHistory ? "$(history)" : "$(folder)"} ${folder.name}`,
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

    const normalizedQuery = query.trim().toLowerCase().replace(/\\/g, "/");
    const queryTerms = normalizedQuery.split(/\s+/).filter(t => t.length > 0);

    if (queryTerms.length === 0) {
      return candidates[0];
    }

    return (
      candidates.find((candidate) => (candidate.description ?? "").toLowerCase() === normalizedQuery) ||
      candidates.find((candidate) => {
        const desc = (candidate.description ?? "").toLowerCase();
        return queryTerms.every(term => desc.includes(term));
      })
    );
  }

  private async getFolderCandidatesFromEverything(
    query: string,
    workspaceFolders: readonly vscode.WorkspaceFolder[],
    history: string[]
  ): Promise<FolderCandidateItem[]> {
    if (!this.resolveUseEs()) {
      return [];
    }

    const isAbsolutePathQuery = path.isAbsolute(query);
    const esCommand = this.resolveEsCommand();
    const excludePatterns = this.resolveExcludePatterns();
    const workspacePaths = workspaceFolders.map(f => this.normalizeFolderPath(f.uri.fsPath).toLowerCase());

    // Everything (es.exe) は Windows 形式の \ を期待するため変換して渡す
    const searchTerms = (isAbsolutePathQuery ? [query] : this.getEverythingSearchTerms(query))
      .map(term => term.replace(/\//g, "\\"));
    const esExcludeTerms = excludePatterns.map((p) => `!${p}`);
    const seen = new Set<string>();
    const candidates: FolderCandidateItem[] = [];
    const args = ["/ad", "-p", "-sort-path", "-n", String(MAX_FOLDER_CANDIDATES), ...searchTerms, ...esExcludeTerms];

    this.log(`Everything search command=${esCommand} args=${args.map((arg) => JSON.stringify(arg)).join(" ")}`);

    try {
      if (searchTerms.length === 0) {
        this.log("Everything search skipped because there are no search terms.");
        return [];
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

        // 絶対パス入力、または入力クエリ自体にパス区切りやスペースが含まれる場合は
        // ユーザーが場所を特定しようとしていると判断し、ワークスペース外でも候補に含める
        if (
          !isAbsolutePathQuery &&
          !query.includes("/") &&
          !query.includes("\\") &&
          !query.includes(" ") &&
          !this.isWithinAllowedRoots(normalizedPath, workspaceFolders, history)
        ) {
          continue;
        }

        const isWorkspace = workspacePaths.some(ws => normalizedPath.toLowerCase().startsWith(ws));
        const isHistory = history.includes(normalizedPath);
        let icon = "$(file-directory)";
        if (isWorkspace) icon = "$(folder)";
        if (isHistory) icon = "$(history)";

        seen.add(normalizedPath);
        candidates.push({
          label: `${icon} ${path.basename(normalizedPath)}`,
          description: normalizedPath,
          targetPath: normalizedPath
        });
      }

      this.log(`Everything candidates kept=${candidates.length}`);
    } catch (error) {
      this.log(`Everything search failed: ${formatError(error)}`);
      return [];
    }

    return candidates.sort((left, right) => {
      // 1. ワークスペース内を最優先
      const leftInWs = workspacePaths.some(ws => left.targetPath.toLowerCase().startsWith(ws));
      const rightInWs = workspacePaths.some(ws => right.targetPath.toLowerCase().startsWith(ws));
      if (leftInWs !== rightInWs) return leftInWs ? -1 : 1;

      // 2. パスの短さ（浅い階層）を優先
      return left.targetPath.length - right.targetPath.length || left.targetPath.localeCompare(right.targetPath);
    });
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

  private isWithinAllowedRoots(
    candidatePath: string,
    workspaceFolders: readonly vscode.WorkspaceFolder[],
    history: string[]
  ): boolean {
    const normalizedCandidate = candidatePath.toLowerCase();

    // 1. ワークスペース内かチェック
    const isInWorkspace = workspaceFolders.some((folder) => {
      const root = this.normalizeFolderPath(folder.uri.fsPath).toLowerCase();
      return normalizedCandidate === root || normalizedCandidate.startsWith(`${root}/`);
    });

    if (isInWorkspace) {
      return true;
    }

    // 2. 過去の検索履歴（絶対パス）に含まれるフォルダ配下かチェック
    return history.some((historyPath) => {
      if (!historyPath || !path.isAbsolute(historyPath)) {
        return false;
      }
      const root = this.normalizeFolderPath(historyPath).toLowerCase();
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
    return await new Promise<string | undefined>((resolve) => {
      const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { value?: string }>();
      quickPick.placeholder = options.placeHolder;
      let accepted = false;

      const updateItems = () => {
        const currentHistory = this.getHistory(options.historyKey);
        quickPick.items = [
          {
            label: `$(${options.iconId}) ${options.createNewLabel}`,
            value: undefined
          },
          ...currentHistory.map((value) => ({
            label: value.length > 0 ? value : (options.emptyLabel ?? "(empty)"),
            description: value.length === 0 ? "recent" : undefined,
            value,
            buttons: [
              {
                iconPath: new vscode.ThemeIcon("close"),
                tooltip: "Remove from history"
              }
            ]
          }))
        ];
      };

      updateItems();

      const triggerDisposable = quickPick.onDidTriggerItemButton(async (e) => {
        const history = this.getHistory(options.historyKey);
        const nextHistory = history.filter((v) => v !== e.item.value);
        await this.extensionContext?.globalState.update(options.historyKey, nextHistory);

        const updatedHistory = this.getHistory(options.historyKey);
        if (updatedHistory.length === 0) {
          quickPick.hide();
        } else {
          updateItems();
        }
      });

      const acceptDisposable = quickPick.onDidAccept(() => {
        const picked = quickPick.selectedItems[0];
        accepted = true;
        quickPick.hide();
        resolve(picked?.value);
      });

      const hideDisposable = quickPick.onDidHide(() => {
        void vscode.commands.executeCommand("setContext", "gurepaneHistoryPickerVisible", false);
        if (!accepted) {
          resolve(undefined);
        }
        triggerDisposable.dispose();
        acceptDisposable.dispose();
        hideDisposable.dispose();
        quickPick.dispose();
      });

      quickPick.show();
    });
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
      // show の直後に selection を設定することで全選択を回避し末尾にカーソルを置く
      if (options.value.length > 0) {
        inputBox.valueSelection = [options.value.length, options.value.length];
      }
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
