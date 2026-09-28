/**
 * bash-paths.ts — best-effort extraction of literal file paths a bash command
 * will write to (redirections, `tee`, and `sed -i`).
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

/** Skip a single-quoted span starting at `start` (the opening quote). */
function skipSingle(s: string, start: number): number {
  const end = s.indexOf("'", start + 1);
  return end === -1 ? s.length : end + 1;
}

/** Skip a double-quoted span starting at `start` (the opening quote). */
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

/** Read a shell word (quote removal + backslash unescaping) starting at `start`. */
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
        if (s[i] === "\\" && i + 1 < n && `"\\$` + "`".includes(s[i + 1])) {
          value += s[i + 1];
          i += 2;
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

/** Advance past a heredoc body ending at the delimiter line. */
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

function tokenize(cmd: string): Token[] {
  const tokens: Token[] = [];
  const n = cmd.length;
  let i = 0;
  const pending: { delim: string; stripTabs: boolean }[] = [];

  while (i < n) {
    const c = cmd[i];
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      tokens.push({ kind: "op", value: "\n" });
      i++;
      for (const h of pending) i = skipHeredocBody(cmd, i, h.delim, h.stripTabs);
      pending.length = 0;
      continue;
    }
    if (c === "#") {
      // A '#' at the start of a word begins a comment to end of line.
      while (i < n && cmd[i] !== "\n") i++;
      continue;
    }
    if (c === "<" && cmd[i + 1] === "<") {
      const stripTabs = cmd[i + 2] === "-";
      tokens.push({ kind: "op", value: stripTabs ? "<<-" : "<<" });
      i += stripTabs ? 3 : 2;
      while (i < n && (cmd[i] === " " || cmd[i] === "\t")) i++;
      const delim = readWord(cmd, i);
      i = delim.end;
      pending.push({ delim: delim.value, stripTabs });
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
    const w = readWord(cmd, i);
    i = w.end;
    const kind: Token["kind"] =
      !w.quoted && /^[0-9]+$/.test(w.value) && i < n && (cmd[i] === ">" || cmd[i] === "<") ? "io" : "word";
    tokens.push({ kind, value: w.value });
  }
  return tokens;
}

type Adder = (raw?: string) => void;

/** Parse the operands of `tee`. Returns the index of the last consumed token. */
function parseTee(tokens: Token[], start: number, add: Adder): number {
  let i = start;
  let endOfOptions = false;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === "op") return i - 1; // separators/redirections handled by caller
    if (t.kind === "io") return i - 1;
    const v = t.value;
    if (!endOfOptions) {
      if (v === "--") {
        endOfOptions = true;
        continue;
      }
      if (v.startsWith("-") && v !== "-") continue;
    }
    add(v);
  }
  return i - 1;
}

function parseSedShort(v: string): { inPlace: boolean; hasScript: boolean; consumesNext: boolean } {
  let inPlace = false;
  let hasScript = false;
  let consumesNext = false;
  for (let k = 1; k < v.length; k++) {
    const ch = v[k];
    if (ch === "i") {
      inPlace = true;
      break; // any trailing characters are the in-place backup suffix
    }
    if (ch === "e" || ch === "f") {
      hasScript = true;
      consumesNext = k === v.length - 1; // attached argument otherwise
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
    const t = tokens[i];
    if (t.kind === "op") return i - 1;
    if (t.kind === "io") return i - 1;
    const v = t.value;

    if (!endOfOptions && v === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && v.startsWith("--")) {
      if (v === "--in-place" || v.startsWith("--in-place=")) {
        inPlace = true;
        continue;
      }
      if (v === "--expression" || v === "--file") {
        hasScript = true;
        i++; // consume the script operand
        continue;
      }
      if (v.startsWith("--expression=") || v.startsWith("--file=")) {
        hasScript = true;
        continue;
      }
      continue;
    }
    if (!endOfOptions && v.startsWith("-") && v !== "-") {
      const r = parseSedShort(v);
      if (r.inPlace) inPlace = true;
      if (r.hasScript) hasScript = true;
      if (r.consumesNext) i++;
      // macOS/BSD `sed -i ''`: a separate empty argument is the backup suffix.
      if (r.inPlace && v === "-i") {
        const next = tokens[i + 1];
        if (next && next.kind === "word" && next.value === "") i++;
      }
      continue;
    }

    // Operand: the first one is the script unless -e/-f supplied it.
    if (!hasScript) hasScript = true;
    else if (inPlace) add(v);
  }
  return i - 1;
}

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
    if (/[$`*?{}[\]~]/.test(raw)) return; // dynamic / glob / expansion
    out.add(raw);
  };

  let expectCommand = true;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === "io") {
      expectCommand = false;
      continue;
    }
    if (t.kind === "op") {
      const v = t.value;
      if (v === ">" || v === ">>" || v === ">|" || v === "&>" || v === "&>>") {
        const next = tokens[i + 1];
        if (next && next.kind === "word") {
          add(next.value);
          i++;
        }
        expectCommand = false;
        continue;
      }
      if (v === ">&" || v === "<&") {
        const next = tokens[i + 1];
        if (next && next.kind === "word") {
          // fd duplication (`2>&1`, `>&-`) is not a path
          if (v === ">&" && !/^[0-9]*-?$/.test(next.value)) add(next.value);
          i++;
        }
        expectCommand = false;
        continue;
      }
      if (v === "<" || v === "<>") {
        const next = tokens[i + 1];
        if (next && next.kind === "word") i++; // input target: not a write
        continue;
      }
      if (v === "<<" || v === "<<-") continue; // heredoc: body already skipped
      if (SEPARATORS.has(v)) {
        expectCommand = true;
        continue;
      }
      continue;
    }

    // word
    if (expectCommand) {
      expectCommand = false;
      if (t.value === "tee") {
        i = parseTee(tokens, i + 1, add);
        continue;
      }
      if (t.value === "sed") {
        i = parseSed(tokens, i + 1, add);
        continue;
      }
    }
  }
  return [...out];
}
