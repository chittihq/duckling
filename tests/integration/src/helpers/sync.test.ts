import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DB_ID } from './config.js';

const { apiPostMock } = vi.hoisted(() => ({ apiPostMock: vi.fn() }));

vi.mock('./api.js', () => ({
  apiPost: apiPostMock,
}));

import { triggerTableSync } from './sync.js';

describe('triggerTableSync', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    apiPostMock.mockResolvedValue({ ok: true });
  });

  test('URL-encodes table name in sync path', async () => {
    const table = 'events/archive?year=2026#v1';

    await triggerTableSync(table);

    expect(apiPostMock).toHaveBeenCalledWith(`/sync/table/${encodeURIComponent(table)}?db=${DB_ID}`);
  });
});
