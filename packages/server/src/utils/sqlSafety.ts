const READ_ONLY_MYSQL_QUERY_KEYWORDS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN']);

type ScanState = {
  inSingleQuote: boolean;
  inDoubleQuote: boolean;
  inBacktick: boolean;
  inLineComment: boolean;
  inBlockComment: boolean;
};

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f';
}

function skipWhitespaceAndComments(sql: string, start: number): number {
  let index = start;

  while (index < sql.length) {
    while (index < sql.length && isWhitespace(sql[index])) {
      index += 1;
    }

    if (index >= sql.length) {
      return index;
    }

    // -- comment
    if (sql[index] === '-' && sql[index + 1] === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') {
        index += 1;
      }
      continue;
    }

    // # comment
    if (sql[index] === '#') {
      index += 1;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') {
        index += 1;
      }
      continue;
    }

    // /* block comment */
    if (sql[index] === '/' && sql[index + 1] === '*') {
      index += 2;
      while (index + 1 < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) {
        index += 1;
      }

      if (index + 1 >= sql.length) {
        return sql.length;
      }

      index += 2;
      continue;
    }

    return index;
  }

  return index;
}

function readWord(sql: string, start: number): { word: string; nextIndex: number } | null {
  let index = start;
  while (index < sql.length && /[a-zA-Z]/.test(sql[index])) {
    index += 1;
  }

  if (index === start) {
    return null;
  }

  return {
    word: sql.slice(start, index).toUpperCase(),
    nextIndex: index
  };
}

function canIgnoreAfterSemicolon(sql: string, start: number): boolean {
  let index = skipWhitespaceAndComments(sql, start);

  // Allow repeated trailing semicolons with optional comments/whitespace between.
  while (index < sql.length && sql[index] === ';') {
    index = skipWhitespaceAndComments(sql, index + 1);
  }

  return index >= sql.length;
}

function hasNonTrailingSemicolon(sql: string): boolean {
  const state: ScanState = {
    inSingleQuote: false,
    inDoubleQuote: false,
    inBacktick: false,
    inLineComment: false,
    inBlockComment: false
  };

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (state.inLineComment) {
      if (char === '\n' || char === '\r') {
        state.inLineComment = false;
      }
      continue;
    }

    if (state.inBlockComment) {
      if (char === '*' && next === '/') {
        state.inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (state.inSingleQuote) {
      if (char === '\\') {
        index += 1;
        continue;
      }

      if (char === '\'' && next === '\'') {
        index += 1;
        continue;
      }

      if (char === '\'') {
        state.inSingleQuote = false;
      }
      continue;
    }

    if (state.inDoubleQuote) {
      if (char === '\\') {
        index += 1;
        continue;
      }

      if (char === '"') {
        state.inDoubleQuote = false;
      }
      continue;
    }

    if (state.inBacktick) {
      if (char === '`' && next === '`') {
        index += 1;
        continue;
      }

      if (char === '`') {
        state.inBacktick = false;
      }
      continue;
    }

    if (char === '-' && next === '-') {
      state.inLineComment = true;
      index += 1;
      continue;
    }

    if (char === '#') {
      state.inLineComment = true;
      continue;
    }

    if (char === '/' && next === '*') {
      state.inBlockComment = true;
      index += 1;
      continue;
    }

    if (char === '\'') {
      state.inSingleQuote = true;
      continue;
    }

    if (char === '"') {
      state.inDoubleQuote = true;
      continue;
    }

    if (char === '`') {
      state.inBacktick = true;
      continue;
    }

    if (char === ';' && !canIgnoreAfterSemicolon(sql, index + 1)) {
      return true;
    }
  }

  return false;
}

export function isReadOnlyMySQLQuery(sql: string): boolean {
  if (typeof sql !== 'string') {
    return false;
  }

  const firstTokenStart = skipWhitespaceAndComments(sql, 0);
  if (firstTokenStart >= sql.length) {
    return false;
  }

  const firstToken = readWord(sql, firstTokenStart);
  if (!firstToken) {
    return false;
  }

  if (!READ_ONLY_MYSQL_QUERY_KEYWORDS.has(firstToken.word)) {
    return false;
  }

  if (firstToken.word === 'EXPLAIN') {
    const secondTokenStart = skipWhitespaceAndComments(sql, firstToken.nextIndex);
    const secondToken = readWord(sql, secondTokenStart);
    if (secondToken?.word === 'ANALYZE') {
      return false;
    }
  }

  if (hasNonTrailingSemicolon(sql)) {
    return false;
  }

  return true;
}
