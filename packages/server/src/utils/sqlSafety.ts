const READ_ONLY_MYSQL_QUERY_REGEX = /^(select|show|describe|desc|explain)\b/i;

export function isReadOnlyMySQLQuery(sql: string): boolean {
  if (typeof sql !== 'string') {
    return false;
  }

  const normalizedQuery = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/#.*$/gm, ' ')
    .trim()
    .replace(/;+$/, '')
    .trim();

  if (!normalizedQuery) {
    return false;
  }

  if (normalizedQuery.includes(';')) {
    return false;
  }

  return READ_ONLY_MYSQL_QUERY_REGEX.test(normalizedQuery);
}
