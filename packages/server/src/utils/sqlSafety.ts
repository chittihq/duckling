const READ_ONLY_MYSQL_QUERY_REGEX = /^(select|show|describe|desc|explain)\b/i;
const LEADING_SQL_COMMENT_REGEX = /^(?:\s|\/\*[\s\S]*?\*\/|--[^\n\r]*(?:\r?\n|$)|#[^\n\r]*(?:\r?\n|$))*/;

function hasNonTrailingSemicolon(query: string): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let escaped = false;

  for (let index = 0; index < query.length; index += 1) {
    const char = query[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if ((inSingleQuote || inDoubleQuote) && char === '\\') {
      escaped = true;
      continue;
    }

    if (!inDoubleQuote && !inBacktick && char === '\'') {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (!inSingleQuote && !inBacktick && char === '"') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && char === '`') {
      inBacktick = !inBacktick;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && !inBacktick && char === ';') {
      if (query.slice(index + 1).trim().length > 0) {
        return true;
      }
    }
  }

  return false;
}

export function isReadOnlyMySQLQuery(sql: string): boolean {
  if (typeof sql !== 'string') {
    return false;
  }

  const normalizedQuery = sql
    .replace(LEADING_SQL_COMMENT_REGEX, '')
    .trim()
    .replace(/;+$/, '')
    .trim();

  if (!normalizedQuery) {
    return false;
  }

  if (hasNonTrailingSemicolon(normalizedQuery)) {
    return false;
  }

  return READ_ONLY_MYSQL_QUERY_REGEX.test(normalizedQuery);
}
