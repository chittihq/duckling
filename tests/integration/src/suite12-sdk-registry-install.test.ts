import { beforeAll, describe, test } from 'vitest';

import {
  API_KEY,
  DB_ID,
  SDK_REGISTRY_VERSION,
  WS_URL,
} from './helpers/config.js';
import { runFreshRegistrySdkScenario } from './helpers/sdkRegistry.js';
import { triggerFullSync } from './helpers/sync.js';

const describeRegistry = SDK_REGISTRY_VERSION ? describe : describe.skip;

function quoted(value: string): string {
  return JSON.stringify(value);
}

describeRegistry('Suite 12: SDK Registry Install', () => {
  beforeAll(async () => {
    await triggerFullSync();
  });

  test('fresh npm install supports ESM auto-connect and ping', () => {
    runFreshRegistrySdkScenario('esm-live-query', {
      packageType: 'module',
      files: {
        'index.mjs': `
import assert from 'node:assert/strict';
import { DucklingClient } from '@chittihq/duckling';

const client = new DucklingClient({
  url: ${quoted(WS_URL)},
  apiKey: ${quoted(API_KEY)},
  databaseName: ${quoted(DB_ID)},
  autoReconnect: false,
  autoPing: false,
  requestTimeout: 5000,
});

try {
  const rows = await client.query('SELECT COUNT(*) AS count FROM users_with_timestamps');
  assert.equal(Number(rows[0].count), 5);
  assert.equal(await client.ping(), true);
} finally {
  client.close();
}
`,
      },
      commands: [{ command: 'node', args: ['index.mjs'] }],
    });
  });

  test('fresh npm install supports CommonJS batch and pagination use cases', () => {
    runFreshRegistrySdkScenario('cjs-batch-pagination', {
      packageType: 'commonjs',
      files: {
        'index.cjs': `
const assert = require('node:assert/strict');
const { DucklingClient } = require('@chittihq/duckling');

async function main() {
  const client = new DucklingClient({
    url: ${quoted(WS_URL)},
    apiKey: ${quoted(API_KEY)},
    databaseName: ${quoted(DB_ID)},
    autoReconnect: false,
    autoPing: false,
    requestTimeout: 5000,
  });

  try {
    await client.connect();

    const batch = await client.queryBatch([
      'SELECT COUNT(*) AS count FROM users_with_timestamps',
      'SELECT COUNT(*) AS count FROM products_simple',
    ]);
    assert.equal(Number(batch[0][0].count), 5);
    assert.equal(Number(batch[1][0].count), 4);

    const paginated = await client.queryPaginated(
      'SELECT id FROM users_with_timestamps ORDER BY id',
      { limit: 2, offset: 2 },
    );
    assert.deepEqual(paginated.data.map((row) => Number(row.id)), [3, 4]);
    assert.equal(paginated.pagination.hasMore, true);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`,
      },
      commands: [{ command: 'node', args: ['index.cjs'] }],
    });
  });

  test('fresh npm install supports TypeScript typechecking in a consumer project', () => {
    runFreshRegistrySdkScenario('typescript-consumer', {
      packageType: 'module',
      installPackages: ['typescript@^5.8.3'],
      files: {
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            noEmit: true,
          },
          include: ['index.ts'],
        }, null, 2),
        'index.ts': `
import { ConnectionState, ClickHouseError, ClickHouseErrorType, DucklingClient } from '@chittihq/duckling';

const client = new DucklingClient({
  url: ${quoted(WS_URL)},
  apiKey: ${quoted(API_KEY)},
  databaseName: ${quoted(DB_ID)},
});

client.on('reconnecting', (attempt) => {
  const typedAttempt: number = attempt;
  void typedAttempt;
});

const maybeError = new ClickHouseError(ClickHouseErrorType.CONNECTION_ERROR, 'boom');
const state: ConnectionState = ConnectionState.DISCONNECTED;

void client;
void maybeError;
void state;
`,
      },
      commands: [
        {
          command: 'node',
          args: ['./node_modules/typescript/bin/tsc', '--noEmit'],
        },
      ],
    });
  });

  test('fresh npm install surfaces typed auth failures from the published package', () => {
    runFreshRegistrySdkScenario('typed-auth-error', {
      packageType: 'module',
      files: {
        'index.mjs': `
import assert from 'node:assert/strict';
import { ClickHouseError, ClickHouseErrorType, DucklingClient } from '@chittihq/duckling';

const client = new DucklingClient({
  url: ${quoted(WS_URL)},
  apiKey: 'definitely-wrong',
  databaseName: ${quoted(DB_ID)},
  autoReconnect: false,
  autoPing: false,
  connectionTimeout: 5000,
});

try {
  await client.connect();
  throw new Error('Expected auth failure');
} catch (error) {
  assert.equal(error instanceof ClickHouseError, true);
  assert.equal(error.type, ClickHouseErrorType.AUTH_ERROR);
} finally {
  client.close();
}
`,
      },
      commands: [{ command: 'node', args: ['index.mjs'] }],
    });
  });
});
