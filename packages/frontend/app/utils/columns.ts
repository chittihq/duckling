/**
 * Build the ordered set of column names for a result set by unioning the keys
 * of every row — not just the first row.
 *
 * Object.keys(rows[0]) drops any column that is null/missing in the first row
 * but present later (#75). Insertion order is preserved: the first row's keys
 * come first, then any new keys in the order they first appear, for a stable
 * column order.
 *
 * Auto-imported by Nuxt from app/utils/.
 */
export function columnsFromRows(rows: unknown[]): string[] {
  const columns = new Set<string>()
  for (const row of rows) {
    if (row && typeof row === 'object') {
      for (const key of Object.keys(row as Record<string, unknown>)) columns.add(key)
    }
  }
  return Array.from(columns)
}
