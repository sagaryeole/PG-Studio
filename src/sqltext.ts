/**
 * A small scanner for SQL typed into the editor. It does not parse SQL; it
 * only knows where strings, quoted identifiers and comments start and end,
 * so it can tell how many statements there are, which keyword starts them,
 * and where the last real token ends.
 *
 * It is a convenience for clear error messages. The guarantees come from
 * how the query is sent (see sql.ts): one statement over the extended
 * protocol, inside a subquery, in a read-only transaction.
 */

export interface ScannedSql {
  /** Statements that contain something other than whitespace and comments. */
  statements: number;
  /** The text up to the end of the last real token (no trailing `;` or comments). */
  body: string;
  /** Lower-cased words at the start of the statement, e.g. ["explain", "analyze", "select"]. */
  words: string[];
  /** Offset in `body` just after `words` (only meaningful for a leading EXPLAIN). */
  wordsEnd: number[];
  /** True when the first token after the leading words is "(". */
  parenAfter: boolean[];
}

const isWordStart = (ch: string): boolean => /[A-Za-z_\u0080-￿]/.test(ch);
const isWordChar = (ch: string): boolean => /[A-Za-z0-9_$\u0080-￿]/.test(ch);

export function scanSql(text: string): ScannedSql {
  let statements = 0;
  let inStatement = false; // seen a real token since the last top-level ";"
  let lastEnd = 0; // end of the last real token, excluding ";"
  const words: string[] = [];
  const wordsEnd: number[] = [];
  const parenAfter: boolean[] = [];
  let collecting = true; // still reading the leading keywords of the first statement

  const token = (start: number, end: number, word: string | null): void => {
    if (!inStatement) {
      inStatement = true;
      statements++;
    }
    lastEnd = end;
    if (statements !== 1 || !collecting) return;
    if (word !== null && words.length < 6) {
      words.push(word.toLowerCase());
      wordsEnd.push(end);
      parenAfter.push(false);
      return;
    }
    if (word === null && text[start] === "(" && words.length) parenAfter[parenAfter.length - 1] = true;
    collecting = false;
  };

  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    const next = text[i + 1] ?? "";

    if (/\s/.test(ch)) {
      i++;
    } else if (ch === "-" && next === "-") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
    } else if (ch === "/" && next === "*") {
      // Block comments nest in Postgres.
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
    } else if (ch === ";") {
      inStatement = false;
      collecting = false;
      i++;
    } else if (ch === "'" || ((ch === "E" || ch === "e") && next === "'" && !isWordChar(text[i - 1] ?? " "))) {
      const start = i;
      const backslash = ch !== "'";
      i += backslash ? 2 : 1;
      while (i < n) {
        if (backslash && text[i] === "\\") i += 2;
        else if (text[i] === "'" && text[i + 1] === "'") i += 2;
        else if (text[i] === "'") {
          i++;
          break;
        } else i++;
      }
      token(start, Math.min(i, n), null);
    } else if (ch === '"') {
      const start = i;
      i++;
      while (i < n) {
        if (text[i] === '"' && text[i + 1] === '"') i += 2;
        else if (text[i] === '"') {
          i++;
          break;
        } else i++;
      }
      token(start, Math.min(i, n), null);
    } else if (ch === "$" && /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.test(text.slice(i, i + 64))) {
      // Dollar-quoted string: $$...$$ or $tag$...$tag$ ($1 is a parameter, not a quote).
      const start = i;
      const tag = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(text.slice(i, i + 64))![0];
      const close = text.indexOf(tag, i + tag.length);
      i = close === -1 ? n : close + tag.length;
      token(start, i, null);
    } else if (isWordStart(ch)) {
      const start = i;
      while (i < n && isWordChar(text[i]!)) i++;
      token(start, i, text.slice(start, i));
    } else {
      token(i, i + 1, null);
      i++;
    }
  }

  return { statements, body: text.slice(0, lastEnd), words, wordsEnd, parenAfter };
}

export type SqlMode = "run" | "explain" | "analyze";

export interface PreparedSql {
  /** The query to wrap, without a leading EXPLAIN or trailing ";". */
  body: string;
  /** Where `body` starts in the text the user typed, to map error positions back. */
  offset: number;
  mode: SqlMode;
  verbose: boolean;
}

const QUERY_STARTS = new Set(["select", "with", "values", "table"]);

/**
 * Check that the editor text is one read query and split off a typed EXPLAIN.
 * Throws an Error with a message meant for the user.
 */
export function prepareSql(text: string, requested: SqlMode): PreparedSql {
  const s = scanSql(text);
  if (s.statements === 0) throw new Error("Type a query first.");
  if (s.statements > 1) throw new Error("Run one statement at a time. Select the one you want, or remove the others.");

  let mode = requested;
  let verbose = false;
  let k = 0;
  if (s.words[0] === "explain") {
    if (s.parenAfter[0]) {
      throw new Error("Use EXPLAIN, EXPLAIN ANALYZE or the Explain buttons; options in parentheses aren't supported here.");
    }
    k = 1;
    if (s.words[k] === "analyze" || s.words[k] === "analyse") {
      mode = "analyze";
      k++;
    } else if (mode === "run") mode = "explain";
    if (s.words[k] === "verbose") {
      verbose = true;
      k++;
    }
  }

  const first = s.words[k];
  const startsWithParen = k === 0 && s.words.length === 0; // e.g. "(SELECT 1) UNION (SELECT 2)"
  if (!startsWithParen && (first === undefined || !QUERY_STARTS.has(first))) {
    const what = first ? first.toUpperCase() : "this statement";
    throw new Error(
      `${what} can't run here. The SQL editor only runs read queries: SELECT, WITH … SELECT, VALUES and TABLE.`,
    );
  }

  const offset = k === 0 ? 0 : s.wordsEnd[k - 1]!;
  return { body: s.body.slice(offset), offset, mode, verbose };
}
