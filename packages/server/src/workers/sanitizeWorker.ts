/**
 * Sanitize Worker
 *
 * Worker thread entry point for CPU-heavy row sanitization.
 * Receives raw row batches + column type map from the main thread,
 * runs sanitizeValue() per cell, and returns clean arrays ready for
 * batch insertion.
 *
 * Communication protocol (via parentPort):
 *   Main → Worker: { id, rows: Record<string,any>[], columns: string[], columnTypes: Record<string,string> }
 *   Worker → Main: { id, rows: any[][] }       // sanitized column-ordered arrays
 *   Worker → Main: { id, error: string }        // on failure
 */

import { parentPort } from 'worker_threads';

if (!parentPort) {
  throw new Error('sanitizeWorker must be run as a worker thread');
}

interface SanitizeRequest {
  id: number;
  rows: Record<string, any>[];
  columns: string[];
  columnTypes: Record<string, string>;
}

/**
 * Sanitize a single value based on its MySQL column type.
 * This is a standalone copy of the sanitization logic from
 * SequentialAppenderService and CDCService, optimized for worker context
 * (no class instance, no logger dependency).
 */
function sanitizeValue(value: any, columnType: string): any {
  if (value === undefined) return null;

  const lowerType = columnType.toLowerCase();

  // JSON columns — stringify objects/arrays
  if (lowerType.includes('json')) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }

  // Timestamp / datetime / date — reject invalid values
  if (lowerType.includes('timestamp') || lowerType.includes('datetime') || lowerType === 'date') {
    if (value === '0000-00-00 00:00:00' || value === '0000-00-00' || value === null) return null;
    if (typeof value === 'string' && (value.includes('undefined') || value.trim() === '')) return null;
    if (value instanceof Date && value.getTime() === 0) return null;
  }

  // Time columns (not datetime/timestamp) — reject hours >= 24
  if (lowerType.includes('time') && !lowerType.includes('datetime') && !lowerType.includes('timestamp')) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
      const timeMatch = value.match(/^(\d+):(\d+):(\d+)/);
      if (timeMatch) {
        const hours = parseInt(timeMatch[1], 10);
        if (hours >= 24) return null;
      }
    }
  }

  // Date objects from binlog — convert to ISO string
  if (value instanceof Date) {
    if (isNaN(value.getTime()) || value.getFullYear() === 0) return null;
    return value.toISOString();
  }

  // Buffer (BLOB) — keep as-is (structured clone supports ArrayBuffer)
  if (value instanceof Uint8Array) return value;

  // BigInt — convert to string
  if (typeof value === 'bigint') return value.toString();

  // Objects (other than Date/Buffer) — JSON.stringify
  if (value !== null && typeof value === 'object') return JSON.stringify(value);

  return value;
}

/**
 * Process a batch: sanitize all values and return column-ordered arrays.
 */
function processBatch(req: SanitizeRequest): any[][] {
  const { rows, columns, columnTypes } = req;
  const result: any[][] = new Array(rows.length);

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const sanitized = new Array(columns.length);
    for (let c = 0; c < columns.length; c++) {
      const col = columns[c];
      sanitized[c] = sanitizeValue(row[col], columnTypes[col] || '');
    }
    result[r] = sanitized;
  }

  return result;
}

// Listen for messages from the main thread
parentPort.on('message', (msg: SanitizeRequest) => {
  try {
    const sanitizedRows = processBatch(msg);
    parentPort!.postMessage({ id: msg.id, rows: sanitizedRows });
  } catch (err: any) {
    parentPort!.postMessage({ id: msg.id, error: err.message || String(err) });
  }
});
