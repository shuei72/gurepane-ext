import * as vscode from "vscode";
import type { ParsedQuery, QueryCaseMode, QueryMode, SearchResult } from "./types";
import { getRelativePath } from "./utils";

const QUERY_MODE_DELIMITER = ">";

// Minimal shape we care about from `rg --json` match events.
type RipgrepJsonText = {
  readonly text?: string;
  readonly bytes?: string;
};

type RipgrepJsonSubmatch = {
  readonly start: number;
  readonly end: number;
  readonly line_number?: number;
};

type RipgrepJsonMatchEvent = {
  readonly type: "match";
  readonly data: {
    readonly path: {
      readonly text: string;
    };
    readonly lines: RipgrepJsonText;
    readonly line_number: number;
    readonly submatches: readonly RipgrepJsonSubmatch[];
  };
};

// Normalize user input like `.ts, tsx` into `ts,tsx`.
export function normalizeExtensionFilter(value: string): string {
  const extensions = value
    .split(",")
    .map((item) => item.trim().replace(/^\.+/, ""))
    .filter((item, index, all) => item.length > 0 && all.indexOf(item) === index);

  return extensions.join(",");
}

// Pass extension filters to ripgrep as repeated glob arguments.
export function buildExtensionArgs(extensionFilter: string): string[] {
  if (!extensionFilter) {
    return [];
  }

  return extensionFilter
    .split(",")
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0)
    .flatMap((extension) => ["-g", `*.${extension}`]);
}

// Parse prefixes such as `bt>` or `rC>` into explicit search flags.
export function parseQueryInput(value: string): ParsedQuery {
  const raw = value;
  const delimiterIndex = value.indexOf(QUERY_MODE_DELIMITER);
  if (delimiterIndex > 0) {
    const prefix = value.slice(0, delimiterIndex);
    const prefixFlags = parsePrefixFlags(prefix);

    return {
      raw,
      pattern: value.slice(delimiterIndex + 1),
      mode: prefixFlags.mode,
      wholeWord: prefixFlags.wholeWord,
      caseMode: prefixFlags.caseMode
    };
  }

  return {
    raw,
    pattern: value,
    mode: "regex",
    wholeWord: false,
    caseMode: "smart"
  };
}

export function inferQueryModeFromRaw(value: string): QueryMode {
  return parseQueryInput(value).mode;
}

export function inferWholeWordFromRaw(value: string): boolean {
  return parseQueryInput(value).wholeWord;
}

export function inferQueryCaseModeFromRaw(value: string): QueryCaseMode {
  return parseQueryInput(value).caseMode;
}

export function buildQueryModeArgs(query: ParsedQuery): string[] {
  return [
    ...(query.mode === "text" ? ["--fixed-strings"] : []),
    ...(query.wholeWord ? ["--word-regexp"] : []),
    ...(query.caseMode === "ignore" ? ["--ignore-case"] : []),
    ...(query.caseMode === "sensitive" ? ["--case-sensitive"] : []),
    ...(query.caseMode === "smart" ? ["--smart-case"] : [])
  ];
}

// Group by file path so we only need to sort file buckets, not every hit.
export function parseRipgrepOutput(stdout: string): SearchResult[] {
  const resultsByPath = new Map<string, SearchResult[]>();

  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      continue;
    }

    const parsed = parseRipgrepJsonLine(line);
    if (parsed) {
      for (const result of parsed) {
        const bucket = resultsByPath.get(result.relativePath) ?? [];
        bucket.push(result);
        resultsByPath.set(result.relativePath, bucket);
      }
    }
  }

  return [...resultsByPath.keys()]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((relativePath) => resultsByPath.get(relativePath) ?? []);
}

export function isRipgrepNoResults(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === 1;
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

// Within each flag group, the first matching prefix wins.
function parsePrefixFlags(prefix: string): {
  mode: QueryMode;
  wholeWord: boolean;
  caseMode: QueryCaseMode;
} {
  let mode: QueryMode = "regex";
  let modeResolved = false;
  let caseMode: QueryCaseMode = "smart";
  let caseResolved = false;
  let wholeWord = false;

  for (const character of prefix) {
    if (!modeResolved && character === "t") {
      mode = "text";
      modeResolved = true;
      continue;
    }

    if (!modeResolved && character === "r") {
      mode = "regex";
      modeResolved = true;
      continue;
    }

    if (!caseResolved && character === "c") {
      caseMode = "ignore";
      caseResolved = true;
      continue;
    }

    if (!caseResolved && character === "C") {
      caseMode = "sensitive";
      caseResolved = true;
      continue;
    }

    if (!caseResolved && character === "s") {
      caseMode = "smart";
      caseResolved = true;
      continue;
    }

    if (character === "b") {
      wholeWord = true;
    }
  }

  return {
    mode,
    wholeWord,
    caseMode
  };
}

function parseRipgrepJsonLine(line: string): SearchResult[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (!isRipgrepJsonMatchEvent(parsed)) {
    return undefined;
  }

  const filePath = parsed.data.path.text;
  const lineText = getRipgrepText(parsed.data.lines).replace(/\r?\n$/, "");
  const uri = vscode.Uri.file(filePath);
  const relativePath = getRelativePath(uri);

  return parsed.data.submatches.map((submatch) => {
    // ripgrep reports byte offsets, but the editor/highlight API expects UTF-16 indices.
    const startIndex = utf8ByteOffsetToUtf16Index(lineText, submatch.start);
    const endIndex = utf8ByteOffsetToUtf16Index(lineText, submatch.end);
    const lineNumber = submatch.line_number ?? parsed.data.line_number;
    const columnNumber = startIndex + 1;

    return {
      uri,
      filePath,
      relativePath,
      line: lineNumber,
      column: columnNumber,
      text: lineText,
      highlights: [[startIndex, endIndex]]
    } satisfies SearchResult;
  });
}

function getRipgrepText(value: { readonly text?: string; readonly bytes?: string }): string {
  if (typeof value.text === "string") {
    return value.text;
  }

  if (typeof value.bytes === "string") {
    return Buffer.from(value.bytes, "base64").toString("utf8");
  }

  return "";
}

// Convert a UTF-8 byte offset from ripgrep into a JS string index.
function utf8ByteOffsetToUtf16Index(text: string, byteOffset: number): number {
  if (byteOffset <= 0) {
    return 0;
  }

  let consumedBytes = 0;
  let utf16Index = 0;

  for (const character of text) {
    if (consumedBytes >= byteOffset) {
      break;
    }

    consumedBytes += Buffer.byteLength(character, "utf8");
    utf16Index += character.length;
  }

  return utf16Index;
}

function isRipgrepJsonMatchEvent(value: unknown): value is RipgrepJsonMatchEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RipgrepJsonMatchEvent>;
  return candidate.type === "match" && !!candidate.data;
}
