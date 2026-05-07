import { describe, test, expect } from 'vitest';
import { clickhouseScalarStrict } from './helpers/clickhouse.js';
import { mysqlExec } from './helpers/mysql.js';
import { triggerTableSync } from './helpers/sync.js';
import { sleep } from './helpers/cdc.js';

describe('Suite 4: Single Table Sync', () => {
  let usersBefore: string;
  let eventsBefore: string;

  test('record baselines and insert product', async () => {
    usersBefore = await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM users_with_timestamps', 'cnt');
    eventsBefore = await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM events_append_only', 'cnt');

    // Sleep to ensure MySQL NOW() timestamps are after watermarks
    await sleep(2000);

    await mysqlExec(`
      INSERT INTO products_simple (id, name, price, quantity, updated_at) VALUES
        (6, 'Gadget F', 59.99, 25, NOW());
    `);

    await triggerTableSync('products_simple');
  });

  test('products count after single-table sync', async () => {
    expect(await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM products_simple', 'cnt')).toBe('6');
  });

  test('users count unchanged by single-table sync', async () => {
    const usersAfter = await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM users_with_timestamps', 'cnt');
    expect(usersAfter).toBe(usersBefore);
  });

  test('events count unchanged by single-table sync', async () => {
    const eventsAfter = await clickhouseScalarStrict('SELECT COUNT(*) AS cnt FROM events_append_only', 'cnt');
    expect(eventsAfter).toBe(eventsBefore);
  });

  test('Gadget F exists after single-table sync', async () => {
    expect(await clickhouseScalarStrict('SELECT name FROM products_simple WHERE id = 6', 'name')).toBe('Gadget F');
  });
});
