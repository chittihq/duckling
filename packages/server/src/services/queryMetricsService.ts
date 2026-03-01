import * as crypto from 'crypto';
import logger from '../logger';

interface ActiveQuery {
  sql: string;
  startedAt: Date;
  databaseId: string;
}

interface PatternStats {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  lastRun: Date;
}

const MAX_PATTERNS = 1000;

class QueryMetricsService {
  private static instance: QueryMetricsService;
  private activeQueries: Map<string, ActiveQuery> = new Map();
  private patternStats: Map<string, PatternStats> = new Map();
  private patternAccessOrder: string[] = []; // LRU tracking
  totalExecuted: number = 0;

  private constructor() {}

  static getInstance(): QueryMetricsService {
    if (!QueryMetricsService.instance) {
      QueryMetricsService.instance = new QueryMetricsService();
    }
    return QueryMetricsService.instance;
  }

  /**
   * Normalize SQL by stripping literal values so queries group meaningfully.
   * `WHERE id = 1` → `WHERE id = ?`
   */
  normalizeSql(sql: string): string {
    return sql
      // Replace quoted strings (single and double)
      .replace(/'[^']*'/g, '?')
      .replace(/"[^"]*"/g, '?')
      // Replace numbers (integers and decimals) not preceded by a word character (avoid column names)
      .replace(/\b\d+(\.\d+)?\b/g, '?')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim();
  }

  trackStart(id: string, sql: string, databaseId: string): void {
    this.activeQueries.set(id, {
      sql,
      startedAt: new Date(),
      databaseId,
    });
  }

  trackEnd(id: string, durationMs: number, _errorMessage?: string): void {
    const query = this.activeQueries.get(id);
    this.activeQueries.delete(id);
    this.totalExecuted++;

    if (!query) return;

    const pattern = this.normalizeSql(query.sql);

    const existing = this.patternStats.get(pattern);
    if (existing) {
      existing.count++;
      existing.totalMs += durationMs;
      existing.minMs = Math.min(existing.minMs, durationMs);
      existing.maxMs = Math.max(existing.maxMs, durationMs);
      existing.lastRun = new Date();
      // Move to end of access order (most recently used)
      const idx = this.patternAccessOrder.indexOf(pattern);
      if (idx !== -1) this.patternAccessOrder.splice(idx, 1);
      this.patternAccessOrder.push(pattern);
    } else {
      // Evict least recently used if at capacity
      if (this.patternStats.size >= MAX_PATTERNS) {
        const oldest = this.patternAccessOrder.shift();
        if (oldest) this.patternStats.delete(oldest);
      }
      this.patternStats.set(pattern, {
        count: 1,
        totalMs: durationMs,
        minMs: durationMs,
        maxMs: durationMs,
        lastRun: new Date(),
      });
      this.patternAccessOrder.push(pattern);
    }
  }

  getSnapshot() {
    const now = Date.now();
    const active = Array.from(this.activeQueries.entries()).map(([id, q]) => ({
      id,
      sql: q.sql.length > 200 ? q.sql.slice(0, 200) + '…' : q.sql,
      startedAt: q.startedAt.toISOString(),
      runningSec: parseFloat(((now - q.startedAt.getTime()) / 1000).toFixed(1)),
      databaseId: q.databaseId,
    }));

    const patterns = Array.from(this.patternStats.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 100) // Top 100 patterns only
      .map(([pattern, s]) => ({
        pattern: pattern.length > 200 ? pattern.slice(0, 200) + '…' : pattern,
        count: s.count,
        avgMs: Math.round(s.totalMs / s.count),
        minMs: s.minMs,
        maxMs: s.maxMs,
        lastRun: s.lastRun.toISOString(),
      }));

    return {
      active,
      totalExecuted: this.totalExecuted,
      patterns,
    };
  }
}

export default QueryMetricsService;
