/**
 * Best-effort extraction of the literal file paths a bash command will write to
 * (redirections, `tee`, and `sed -i`).
 *
 * This is deliberately NOT a shell interpreter. It is a small quote-, comment-
 * and heredoc-aware lexical scanner: it understands just enough shell syntax to
 * avoid treating characters inside quoted programs, comments and heredoc bodies
 * as shell operators, and to identify the operands of a few write-capable
 * commands.
 *
 * Dynamic targets (variables, command substitution, globs, process
 * substitution, fd duplication) are intentionally left unsupported.
 */

type Token = { kind: "word" | "op" | "io"; value: string };

const OP_CHARS = new Set([">", "<", "&", "|", ";", "(", ")"]);
const SEPARATORS = new Set(["|", "||", "&&", ";", ";;", ";&", "&", "\n", "(", ")"]);
const REDIRECT_OPS = new Set([">", ">>", ">|", "&>", "&>>", ">&", "<&", "<", "<>", "<<<", "<<", "<<-"]);

// ---------------------------------------------------------------------------
// Skipping quoted / nested spans
// ---------------------------------------------------------------------------

/** Skip a single-quoted span; `start` points at the opening quote. */
function skipSingle(s: string, start: number): number {
  const end = s.indexOf("'", start + 1);
  return end === -1 ? s.length : end + 1;
}

/** Skip a double-quoted span; `start` points at the opening quote. */
function skipDouble(s: string, start: number): number {
  const n = s.length;
  let i = start + 1;
  while (i < n) {
    const c = s[i];
    if (c === "\\" && i + 1 < n) {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i++;
  }
  return n;
}

/** Skip a balanced parenthesised span; `start` points at the opening `(`. */
function skipBalancedParens(s: string, start: number): number {
  const n = s.length;
  let depth = 0;
  let i = start;
  while (i < n) {
    const c = s[i];
    if (c === "'") {
      i = skipSingle(s, i);
      continue;
    }
    if (c === '"') {
      i = skipDouble(s, i);
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "(") {
      depth++;
      i++;
      continue;
    }
    if (c === ")") {
      depth--;
      i++;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return n;
}

/** Advance past a heredoc body, stopping after the delimiter line. */
function skipHeredocBody(s: string, start: number, delim: string, stripTabs: boolean): number {
  const n = s.length;
  let i = start;
  while (i <= n) {
    const nl = s.indexOf("\n", i);
    const lineEnd = nl === -1 ? n : nl;
    let line = s.slice(i, lineEnd);
    if (stripTabs) line = line.replace(/^\t+/, "");
    if (line === delim) return nl === -1 ? n : nl + 1;
    if (nl === -1) return n;
    i = nl + 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/** Recognize the shell operator starting at `i`, if any. */
function matchOperator(s: string, i: number): string | undefined {
  const c = s[i];
  const c2 = s[i + 1] ?? "";
  const c3 = s[i + 2] ?? "";
  switch (c) {
    case "&":
      if (c2 === "&") return "&&";
      if (c2 === ">") return c3 === ">" ? "&>>" : "&>";
      return "&";
    case ">":
      if (c2 === ">") return ">>";
      if (c2 === "&") return ">&";
      if (c2 === "|") return ">|";
      return ">";
    case "<":
      if (c2 === "&") return "<&";
      if (c2 === ">") return "<>";
      return "<";
    case "|":
      return c2 === "|" ? "||" : "|";
    case ";":
      if (c2 === ";") return ";;";
      if (c2 === "&") return ";&";
      return ";";
    case "(":
      return "(";
    case ")":
      return ")";
    default:
      return undefined;
  }
}

/** Read a shell word starting at `start`, doing quote removal and unescaping. */
function readWord(s: string, start: number): { value: string; end: number; quoted: boolean } {
  const n = s.length;
  let i = start;
  let value = "";
  let quoted = false;

  while (i < n) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n") break;

    if (c === "'") {
      quoted = true;
      const end = s.indexOf("'", i + 1);
      if (end === -1) {
        value += s.slice(i + 1);
        i = n;
      } else {
        value += s.slice(i + 1, end);
        i = end + 1;
      }
      continue;
    }

    if (c === '"') {
      quoted = true;
      i++;
      while (i < n && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < n) {
          const next = s[i + 1];
          // Inside double quotes only $ ` " \ retain the backslash escape.
          if (next === "$" || next === "`" || next === '"' || next === "\\") {
            value += next;
            i += 2;
          } else {
            value += s[i]; // keep the backslash before ordinary characters
            i++;
          }
        } else {
          value += s[i];
          i++;
        }
      }
      if (i < n) i++;
      continue;
    }

    if (c === "\\") {
      quoted = true;
      if (i + 1 < n) {
        value += s[i + 1];
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (c === "$") {
      quoted = true;
      if (s[i + 1] === "(") {
        const end = skipBalancedParens(s, i + 1);
        value += s.slice(i, end);
        i = end;
        continue;
      }
      if (s[i + 1] === "{") {
        const end = s.indexOf("}", i + 2);
        const e = end === -1 ? n : end + 1;
        value += s.slice(i, e);
        i = e;
        continue;
      }
      value += "$";
      i++;
      continue;
    }

    if (OP_CHARS.has(c)) break;
    value += c;
    i++;
  }

  return { value, end: i, quoted };
}

function tokenize(cmd: string): Token[] {
  const tokens: Token[] = [];
  const n = cmd.length;
  let i = 0;
  const pendingHeredocs: { delim: string; stripTabs: boolean }[] = [];

  while (i < n) {
    const c = cmd[i];

    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }

    if (c === "\n") {
      tokens.push({ kind: "op", value: "\n" });
      i++;
      for (const heredoc of pendingHeredocs) i = skipHeredocBody(cmd, i, heredoc.delim, heredoc.stripTabs);
      pendingHeredocs.length = 0;
      continue;
    }

    if (c === "#") {
      // A '#' at the start of a word begins a comment to end of line.
      while (i < n && cmd[i] !== "\n") i++;
      continue;
    }

    if (c === "<" && cmd[i + 1] === "<") {
      if (cmd[i + 2] === "<") {
        // here-string `<<<`: not a heredoc, no body to skip
        tokens.push({ kind: "op", value: "<<<" });
        i += 3;
        continue;
      }
      const stripTabs = cmd[i + 2] === "-";
      tokens.push({ kind: "op", value: stripTabs ? "<<-" : "<<" });
      i += stripTabs ? 3 : 2;
      while (i < n && (cmd[i] === " " || cmd[i] === "\t")) i++;
      const delim = readWord(cmd, i);
      i = delim.end;
      pendingHeredocs.push({ delim: delim.value, stripTabs });
      continue;
    }

    if ((c === ">" || c === "<") && cmd[i + 1] === "(") {
      // process substitution: not a filename
      i = skipBalancedParens(cmd, i + 1);
      continue;
    }

    const op = matchOperator(cmd, i);
    if (op) {
      tokens.push({ kind: "op", value: op });
      i += op.length;
      continue;
    }

    const word = readWord(cmd, i);
    i = word.end;
    const kind: Token["kind"] =
      !word.quoted && /^[0-9]+$/.test(word.value) && i < n && (cmd[i] === ">" || cmd[i] === "<")
        ? "io"
        : "word";
    tokens.push({ kind, value: word.value });
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Command-specific operand parsers
// ---------------------------------------------------------------------------

type Adder = (raw?: string) => void;

/**
 * Consume a redirection operator (and its target word when present), adding the
 * target only when it is an output filename. Returns the index of the last
 * consumed token.
 */
function processRedirect(tokens: Token[], i: number, add: Adder): number {
  const op = tokens[i].value;
  const next = tokens[i + 1];

  if (op === ">" || op === ">>" || op === ">|" || op === "&>" || op === "&>>") {
    if (next && next.kind === "word") {
      add(next.value);
      return i + 1;
    }
    return i;
  }

  if (op === ">&" || op === "<&") {
    if (next && next.kind === "word") {
      // fd duplication (`2>&1`, `>&-`) is not a path
      if (op === ">&" && !/^[0-9]*-?$/.test(next.value)) add(next.value);
      return i + 1;
    }
    return i;
  }

  // Input targets (plain `<`, `<>`, here-string `<<<`) are not write targets.
  if (op === "<" || op === "<>" || op === "<<<") {
    if (next && next.kind === "word") return i + 1;
    return i;
  }

  // Heredocs (`<<`, `<<-`) have no target word token; their body was already
  // skipped during tokenization.
  return i;
}

/** Parse the operands of `tee`. Returns the index of the last consumed token. */
function parseTee(tokens: Token[], start: number, add: Adder): number {
  let i = start;
  let endOfOptions = false;

  for (; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "io") continue; // fd number preceding a redirection

    if (token.kind === "op") {
      if (SEPARATORS.has(token.value)) return i - 1;
      if (REDIRECT_OPS.has(token.value)) {
        i = processRedirect(tokens, i, add);
        continue;
      }
      return i - 1;
    }

    const value = token.value;
    if (!endOfOptions) {
      if (value === "--") {
        endOfOptions = true;
        continue;
      }
      if (value.startsWith("-") && value !== "-") continue;
    }
    add(value);
  }

  return i - 1;
}

/** Decode a short `sed` flag cluster like `-i`, `-ne` or `-i.bak`. */
function parseSedShort(flag: string): { inPlace: boolean; hasScript: boolean; consumesNext: boolean } {
  let inPlace = false;
  let hasScript = false;
  let consumesNext = false;

  for (let k = 1; k < flag.length; k++) {
    const ch = flag[k];
    if (ch === "i") {
      inPlace = true;
      break; // any trailing characters are the in-place backup suffix
    }
    if (ch === "e" || ch === "f") {
      hasScript = true;
      consumesNext = k === flag.length - 1; // attached argument otherwise
      break;
    }
  }

  return { inPlace, hasScript, consumesNext };
}

/** Parse the operands of `sed`. Returns the index of the last consumed token. */
function parseSed(tokens: Token[], start: number, add: Adder): number {
  let i = start;
  let hasScript = false;
  let inPlace = false;
  let endOfOptions = false;

  for (; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "io") continue;

    if (token.kind === "op") {
      if (SEPARATORS.has(token.value)) return i - 1;
      if (REDIRECT_OPS.has(token.value)) {
        i = processRedirect(tokens, i, add);
        continue;
      }
      return i - 1;
    }

    const value = token.value;

    if (!endOfOptions && value === "--") {
      endOfOptions = true;
      continue;
    }

    if (!endOfOptions && value.startsWith("--")) {
      if (value === "--in-place" || value.startsWith("--in-place=")) {
        inPlace = true;
        continue;
      }
      if (value === "--expression" || value === "--file") {
        hasScript = true;
        i++; // consume the script operand
        continue;
      }
      if (value.startsWith("--expression=") || value.startsWith("--file=")) {
        hasScript = true;
        continue;
      }
      continue;
    }

    if (!endOfOptions && value.startsWith("-") && value !== "-") {
      const parsed = parseSedShort(value);
      if (parsed.inPlace) inPlace = true;
      if (parsed.hasScript) hasScript = true;
      if (parsed.consumesNext) i++;
      // macOS/BSD `sed -i ''`: a separate empty argument is the backup suffix.
      if (parsed.inPlace && value === "-i") {
        const next = tokens[i + 1];
        if (next && next.kind === "word" && next.value === "") i++;
      }
      continue;
    }

    // Operand: the first one is the script unless -e/-f supplied it.
    if (!hasScript) hasScript = true;
    else if (inPlace) add(value);
  }

  return i - 1;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Device sinks that discard whatever is written to them. Redirecting into
 * `/dev/null` never creates or modifies a file, so it is not a write target
 * (and must not be treated as one, or `2>/dev/null` blocks ordinary reads).
 */
const DISCARD_DEVICES = new Set(["/dev/null"]);

/**
 * Extract repo paths a bash command is expected to write. Only literal targets
 * are returned; dynamic expressions are ignored.
 */
export function bashPaths(cmd: string): string[] {
  const tokens = tokenize(cmd);
  const out = new Set<string>();

  const add: Adder = (raw) => {
    if (!raw) return;
    if (raw === "-" || raw.startsWith("-") || raw.startsWith("&")) return;
    if (DISCARD_DEVICES.has(raw)) return;
    if (/[$`*?{}[\]~]/.test(raw)) return; // dynamic / glob / expansion
    out.add(raw);
  };

  let expectCommand = true;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "io") continue; // fd number: never consumes command position

    if (token.kind === "op") {
      const op = token.value;
      if (REDIRECT_OPS.has(op)) {
        i = processRedirect(tokens, i, add); // redirections never consume command position
        continue;
      }
      if (SEPARATORS.has(op)) {
        expectCommand = true;
        continue;
      }
      continue;
    }

    if (expectCommand) {
      expectCommand = false;
      if (token.value === "tee") {
        i = parseTee(tokens, i + 1, add);
        continue;
      }
      if (token.value === "sed") {
        i = parseSed(tokens, i + 1, add);
        continue;
      }
    }
  }

  return [...out];
}
