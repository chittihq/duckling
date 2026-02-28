import { parentPort } from 'worker_threads';

interface SanitizeRequest {
  id: number;
  rows: any[][];
  columnTypes: string[];
}

const sanitizeValue = (value: any, columnType: string): any => {
  if (value === undefined || value === null) return null;

  const lowerType = String(columnType || '').toLowerCase();

  if (lowerType.includes('json')) {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }

  if (lowerType.includes('timestamp') || lowerType.includes('datetime') || lowerType === 'date') {
    if (value === '0000-00-00 00:00:00' || value === '0000-00-00') return null;
    if (typeof value === 'string' && (value.includes('undefined') || value.trim() === '')) return null;
    if (value instanceof Date && (isNaN(value.getTime()) || value.getTime() === 0 || value.getFullYear() === 0)) return null;
  }

  if (lowerType.includes('time') && !lowerType.includes('datetime') && !lowerType.includes('timestamp')) {
    if (typeof value === 'string') {
      const timeMatch = value.match(/^(\d+):(\d+):(\d+)/);
      if (timeMatch) {
        const hours = parseInt(timeMatch[1], 10);
        if (hours >= 24) return null;
      }
    }
  }

  if (value instanceof Date) {
    if (isNaN(value.getTime()) || value.getFullYear() === 0) return null;
    return value.toISOString();
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'object' && !Buffer.isBuffer(value)) {
    return JSON.stringify(value);
  }

  return value;
};

parentPort?.on('message', (message: SanitizeRequest) => {
  const sanitizedRows = message.rows.map(row =>
    row.map((value, index) => sanitizeValue(value, message.columnTypes[index] || ''))
  );
  parentPort?.postMessage({ id: message.id, rows: sanitizedRows });
});

