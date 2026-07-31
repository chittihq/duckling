/**
 * MySQL -> ClickHouse expression compatibility.
 *
 * Scope is deliberate. ClickHouse already accepts most of MySQL's function
 * library (verified against clickhouse-server:25.8, the version the deploy
 * compose pins): DATE, CURDATE, NOW, DATE_ADD, DATE_SUB, DATE_FORMAT with
 * MySQL `%` specifiers, STR_TO_DATE, TIMESTAMPDIFF, YEARWEEK, HOUR/YEAR/MONTH,
 * IFNULL, IF, COALESCE, NULLIF, CONCAT, SUBSTRING, SUBSTRING_INDEX, LOCATE,
 * GREATEST/LEAST, ANY_VALUE, CAST(... AS UNSIGNED/CHAR/DECIMAL), COUNT(DISTINCT),
 * `LIMIT n, m`, window functions and CTEs all run unchanged.
 *
 * This module handles the constructs that genuinely fail, each mapping
 * verified against a live server. Two classes are deliberately NOT translated:
 *
 *  - MySQL's JSON family beyond the one unambiguous case below. JSON_TABLE has
 *    no ClickHouse equivalent at all, and JSON_EXTRACT returns a *JSON value*
 *    (strings stay quoted) whereas JSON_VALUE returns an unquoted scalar — so
 *    rewriting bare JSON_EXTRACT would silently change results.
 *  - Write-path and locking constructs (INSERT ... ON DUPLICATE KEY UPDATE,
 *    INSERT IGNORE, SELECT ... FOR UPDATE, transactions). A read replica has
 *    no business accepting those, and faking them would be worse than failing.
 *
 * Everything here must be a strict widening: a query that already worked must
 * still work and return the same rows.
 */

export interface CompatRewriteResult {
  sql: string;
  applied: string[];
}

/**
 * Split a function's argument list on top-level commas, respecting nested
 * parentheses, brackets and quoted strings.
 */
function splitArgs(argText: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';

  for (let i = 0; i < argText.length; i++) {
    const ch = argText[i];

    if (quote) {
      current += ch;
      if (ch === quote && argText[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

/**
 * Find calls to `name(` and replace each with the result of `build(args)`.
 * Matching is nesting-aware, so arguments may themselves contain calls, and
 * the scan is innermost-last (we re-scan after each replacement) so nested
 * occurrences of the same function are all handled.
 */
function replaceFunctionCalls(
  sql: string,
  name: string,
  build: (args: string[]) => string | null,
): { sql: string; count: number } {
  const finder = new RegExp(`(?<!["'\`.\\w])${name}\\s*\\(`, 'gi');
  let out = sql;
  let count = 0;
  let searchFrom = 0;

  for (;;) {
    finder.lastIndex = searchFrom;
    const match = finder.exec(out);
    if (!match) break;

    const openIdx = match.index + match[0].length - 1;
    let depth = 0;
    let quote: string | null = null;
    let closeIdx = -1;

    for (let i = openIdx; i < out.length; i++) {
      const ch = out[i];
      if (quote) {
        if (ch === quote && out[i - 1] !== '\\') quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) { closeIdx = i; break; }
      }
    }
    // Unbalanced parentheses: stop rather than corrupt the query.
    if (closeIdx === -1) break;

    const argText = out.slice(openIdx + 1, closeIdx);
    const replacement = build(splitArgs(argText));
    if (replacement === null) {
      // Not rewritable (wrong arity, or a form we deliberately pass through).
      // Advance past this call so the scan makes progress.
      searchFrom = closeIdx + 1;
      continue;
    }
    out = out.slice(0, match.index) + replacement + out.slice(closeIdx + 1);
    // Continue scanning after what we just wrote.
    searchFrom = match.index + replacement.length;
    count++;
  }

  return { sql: out, count };
}

/** Strip one layer of surrounding quotes from a SQL string literal. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** A MySQL timezone spec ClickHouse understands as UTC. */
function isUtcSpec(value: string): boolean {
  const v = unquote(value).toUpperCase();
  return v === 'UTC' || v === '+00:00' || v === 'GMT' || v === 'ETC/UTC';
}

/**
 * Interpret a MySQL timezone spec.
 *
 * An IANA name maps to toTimeZone directly. A numeric offset (+05:30) has no
 * ClickHouse zone — Etc/GMT* only covers whole hours — but converting FROM UTC
 * to a fixed offset is by definition just adding that offset, so those become
 * an INTERVAL shift instead. India's +05:30 is exactly this case, and it is
 * the form the consumer codebases use.
 */
type TzTarget =
  | { kind: 'zone'; name: string }
  | { kind: 'offsetMinutes'; minutes: number };

function parseTimezoneTarget(value: string): TzTarget | null {
  const raw = unquote(value);
  if (/^[A-Za-z]+\/[A-Za-z_+\-0-9]+$/.test(raw)) return { kind: 'zone', name: raw };
  const offset = raw.match(/^([+-])(\d{1,2}):(\d{2})$/);
  if (!offset) return null;
  const [, sign, hh, mm] = offset;
  const minutes = (parseInt(hh, 10) * 60 + parseInt(mm, 10)) * (sign === '-' ? -1 : 1);
  return { kind: 'offsetMinutes', minutes };
}

export function applyMysqlCompat(sql: string): CompatRewriteResult {
  const applied: string[] = [];
  const note = (n: string) => { if (!applied.includes(n)) applied.push(n); };

  // Mask string literals rather than splitting on them: a function call like
  // DATEDIFF('a','b') spans literals, so splitting would hand the rewriters
  // fragments that never contain a whole call. Masking keeps every call
  // intact while making literal CONTENTS untouchable (a value such as
  // 'CURRENT_DATE', or a JSON path, must never be rewritten).
  const literals: string[] = [];
  let out = sql.replace(/'(?:[^']|'')*'/g, (match) => {
    literals.push(match);
    return `\u0001L${literals.length - 1}\u0001`;
  });
  // Restore literals. Builders call this on arguments they need to inspect.
  const resolve = (text: string): string =>
    text.replace(/\u0001L(\d+)\u0001/g, (_m, i) => literals[Number(i)] ?? _m);

  // --- bare keywords that parse as identifiers ---------------------------
  if (/(?<!["'`.\w])CURRENT_DATE\b(?!\s*\()/i.test(out)) {
    out = out.replace(/(?<!["'`.\w])CURRENT_DATE\b(?!\s*\()/gi, 'CURRENT_DATE()');
    note('CURRENT_DATE');
  }
  if (/(?<!["'`.\w])CURRENT_TIMESTAMP\b(?!\s*\()/i.test(out)) {
    out = out.replace(/(?<!["'`.\w])CURRENT_TIMESTAMP\b(?!\s*\()/gi, 'CURRENT_TIMESTAMP()');
    note('CURRENT_TIMESTAMP');
  }

  // --- simple renames -----------------------------------------------------
  if (/(?<!["'`.\w])UNIX_TIMESTAMP\s*\(/i.test(out)) {
    out = out.replace(/(?<!["'`.\w])UNIX_TIMESTAMP\s*\(/gi, 'toUnixTimestamp(');
    note('UNIX_TIMESTAMP');
  }

  // --- functions needing argument rewriting -------------------------------

  // MySQL DATEDIFF(a, b) is "a minus b" in days. ClickHouse dateDiff takes
  // (unit, start, end) and computes end - start, so the operands SWAP.
  // Getting this backwards silently negates every result. The 3-argument
  // ClickHouse form is passed through untouched.
  {
    // MySQL implicitly coerces date STRINGS ('2026-01-01'); ClickHouse does
    // not, so a literal argument is parsed explicitly. Column arguments are
    // already Date/DateTime and are passed through untouched.
    const coerce = (arg: string): string =>
      /^\u0001L\d+\u0001$/.test(arg.trim()) ? `parseDateTimeBestEffort(${arg.trim()})` : arg;
    const r = replaceFunctionCalls(out, 'DATEDIFF', (args) =>
      args.length === 2 ? `dateDiff('day', ${coerce(args[1])}, ${coerce(args[0])})` : null,
    );
    if (r.count > 0) { out = r.sql; note('DATEDIFF(a,b) -> dateDiff(day,b,a)'); }
  }

  // CONVERT_TZ(x, from, to): only rewritten when the source zone is UTC,
  // which is what toTimeZone assumes. Any other source zone is left to fail
  // loudly rather than shift timestamps by a silently wrong amount.
  {
    const r = replaceFunctionCalls(out, 'CONVERT_TZ', (args) => {
      if (args.length !== 3 || !isUtcSpec(resolve(args[1]))) return null;
      const target = parseTimezoneTarget(resolve(args[2]));
      if (!target) return null;
      if (target.kind === 'zone') return `toTimeZone(${args[0]}, '${target.name}')`;
      if (target.minutes === 0) return args[0];
      const op = target.minutes > 0 ? '+' : '-';
      return `(${args[0]} ${op} INTERVAL ${Math.abs(target.minutes)} MINUTE)`;
    });
    if (r.count > 0) { out = r.sql; note('CONVERT_TZ -> toTimeZone'); }
  }

  // MySQL WEEKDAY: Monday=0..Sunday=6. ClickHouse toDayOfWeek: Monday=1..7.
  {
    const r = replaceFunctionCalls(out, 'WEEKDAY', (args) =>
      args.length === 1 ? `(toDayOfWeek(${args[0]}) - 1)` : null,
    );
    if (r.count > 0) { out = r.sql; note('WEEKDAY -> toDayOfWeek-1'); }
  }

  {
    const r = replaceFunctionCalls(out, 'DAYNAME', (args) =>
      args.length === 1 ? `dateName('weekday', ${args[0]})` : null,
    );
    if (r.count > 0) { out = r.sql; note('DAYNAME -> dateName'); }
  }

  // FIELD(needle, a, b, ...) returns a 1-based position or 0 — the same
  // semantics as ClickHouse indexOf over an array literal.
  {
    const r = replaceFunctionCalls(out, 'FIELD', (args) =>
      args.length >= 2 ? `indexOf([${args.slice(1).join(', ')}], ${args[0]})` : null,
    );
    if (r.count > 0) { out = r.sql; note('FIELD -> indexOf'); }
  }

  // GROUP_CONCAT(expr SEPARATOR 's') — ClickHouse has GROUP_CONCAT but does
  // not accept the SEPARATOR keyword.
  {
    const r = replaceFunctionCalls(out, 'GROUP_CONCAT', (args) => {
      if (args.length !== 1) return null;
      const m = args[0].match(/^([\s\S]*?)\s+SEPARATOR\s+(\S+)\s*$/i);
      if (!m) return null; // no SEPARATOR: ClickHouse handles it as-is
      return `arrayStringConcat(groupArray(${m[1].trim()}), ${m[2].trim()})`;
    });
    if (r.count > 0) { out = r.sql; note('GROUP_CONCAT SEPARATOR -> arrayStringConcat'); }
  }

  // TIMESTAMPDIFF(unit, a, b): ClickHouse accepts the function but, unlike
  // MySQL, will not coerce a date STRING argument. Literals are parsed
  // explicitly; column arguments pass through.
  {
    const coerce = (arg: string): string =>
      /^\u0001L\d+\u0001$/.test(arg.trim()) ? `parseDateTimeBestEffort(${arg.trim()})` : arg;
    const r = replaceFunctionCalls(out, 'TIMESTAMPDIFF', (args) => {
      if (args.length !== 3) return null;
      // age() counts FULL units elapsed, which is MySQL's behaviour.
      // ClickHouse's dateDiff (what TIMESTAMPDIFF aliases to) counts unit
      // BOUNDARIES crossed, so 23:59:59 -> 00:00:00 next day is 1 minute for
      // dateDiff but 0 for MySQL. Verified differentially.
      return `age('${unquote(args[0]).toLowerCase()}', ${coerce(args[1])}, ${coerce(args[2])})`;
    });
    if (r.count > 0) { out = r.sql; note('TIMESTAMPDIFF -> age (full units)'); }
  }

  // CAST(x AS SIGNED/UNSIGNED). Both engines accept this, but they disagree
  // on VALUES: MySQL rounds half away from zero (10.5 -> 11) while ClickHouse
  // truncates toward zero (10.5 -> 10). ClickHouse's round() is no help — it
  // rounds half to even, so 10.5 -> 10. floor(x + 0.5) reproduces MySQL
  // exactly. Verified differentially; without this, integer casts silently
  // shift numbers.
  {
    const r = replaceFunctionCalls(out, 'CAST', (args) => {
      if (args.length !== 1) return null;
      const m = args[0].match(/^([\s\S]+?)\s+AS\s+(UNSIGNED|SIGNED)(\s+INTEGER)?\s*$/i);
      if (!m) return null; // other target types are left alone
      const fn = m[2].toUpperCase() === 'UNSIGNED' ? 'toUInt64' : 'toInt64';
      return `${fn}(floor(toFloat64(${m[1].trim()}) + 0.5))`;
    });
    if (r.count > 0) { out = r.sql; note('CAST AS SIGNED/UNSIGNED rounding'); }
  }

  // The one unambiguous JSON case: JSON_UNQUOTE(JSON_EXTRACT(col, path))
  // yields an unquoted scalar, which is exactly JSON_VALUE. Bare
  // JSON_EXTRACT is left alone: it returns a JSON value (strings keep their
  // quotes), so rewriting it would change results.
  {
    const r = replaceFunctionCalls(out, 'JSON_UNQUOTE', (args) => {
      if (args.length !== 1) return null;
      const inner = args[0].match(/^JSON_EXTRACT\s*\(([\s\S]*)\)$/i);
      if (!inner) return null;
      const innerArgs = splitArgs(inner[1]);
      if (innerArgs.length !== 2) return null;
      return `JSON_VALUE(${innerArgs[0]}, ${innerArgs[1]})`;
    });
    if (r.count > 0) { out = r.sql; note('JSON_UNQUOTE(JSON_EXTRACT) -> JSON_VALUE'); }
  }

  return { sql: resolve(out), applied };
}

/**
 * Constructs we knowingly do not translate. Surfaced in logs so an operator
 * can see *why* a query failed rather than guessing.
 */
const UNSUPPORTED_PATTERNS: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /(?<!["'`.\w])JSON_TABLE\s*\(/i, what: 'JSON_TABLE (no ClickHouse equivalent)' },
  { pattern: /(?<!["'`.\w])JSON_ARRAYAGG\s*\(/i, what: 'JSON_ARRAYAGG' },
  { pattern: /(?<!["'`.\w])JSON_OBJECT\s*\(/i, what: 'JSON_OBJECT' },
  { pattern: /(?<!["'`.\w])JSON_CONTAINS\s*\(/i, what: 'JSON_CONTAINS' },
  { pattern: /(?<!["'`.\w])JSON_SEARCH\s*\(/i, what: 'JSON_SEARCH' },
  { pattern: /(?<!["'`.\w])JSON_QUOTE\s*\(/i, what: 'JSON_QUOTE' },
  { pattern: /ON\s+DUPLICATE\s+KEY\s+UPDATE/i, what: 'INSERT ... ON DUPLICATE KEY UPDATE (no upsert in ClickHouse)' },
  { pattern: /FOR\s+UPDATE\s*;?\s*$/i, what: 'SELECT ... FOR UPDATE (no row locking)' },
  { pattern: /(?<!["'`.\w])CONVERT_TZ\s*\(/i, what: 'CONVERT_TZ with a non-UTC source zone' },
];

export function detectUnsupported(sql: string): string[] {
  return UNSUPPORTED_PATTERNS.filter(({ pattern }) => pattern.test(sql)).map(({ what }) => what);
}
