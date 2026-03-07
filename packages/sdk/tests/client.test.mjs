import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

import { DucklingClient } from '../dist/index.mjs';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 1000, intervalMs = 10) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(intervalMs);
  }

  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

async function createServer(onConnection) {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  server.on('connection', onConnection);

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine WebSocket server port');
  }

  return {
    server,
    url: `ws://127.0.0.1:${address.port}/ws`
  };
}

async function closeServer(server) {
  for (const client of server.clients) {
    client.terminate();
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

test('invalid server messages do not crash clients without an error listener', async () => {
  const { server, url } = await createServer((socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());

      if (message.type === 'auth') {
        socket.send(JSON.stringify({ id: message.id, success: true, result: [] }));
        setTimeout(() => {
          socket.send('not-json');
        }, 10);
      }
    });
  });

  const client = new DucklingClient({
    url,
    apiKey: 'test-key',
    autoReconnect: false,
    autoPing: false
  });

  try {
    await client.connect();
    await delay(50);
    assert.equal(client.isConnected(), true);
  } finally {
    client.close();
    await closeServer(server);
  }
});

test('concurrent connect calls share a single handshake', async () => {
  let authMessageCount = 0;

  const { server, url } = await createServer((socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());

      if (message.type === 'auth') {
        authMessageCount += 1;
        setTimeout(() => {
          socket.send(JSON.stringify({ id: message.id, success: true, result: [] }));
        }, 20);
      }
    });
  });

  const client = new DucklingClient({
    url,
    apiKey: 'test-key',
    autoReconnect: false,
    autoPing: false
  });

  try {
    await Promise.all([client.connect(), client.connect(), client.connect()]);
    assert.equal(client.isConnected(), true);
    assert.equal(authMessageCount, 1);
  } finally {
    client.close();
    await closeServer(server);
  }
});

test('concurrent queries resolve correctly when responses arrive out of order', async () => {
  const pendingQueryIds = [];

  const { server, url } = await createServer((socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());

      if (message.type === 'auth') {
        socket.send(JSON.stringify({ id: message.id, success: true, result: [] }));
        return;
      }

      if (message.type === 'query') {
        pendingQueryIds.push(message.id);

        if (pendingQueryIds.length === 2) {
          socket.send(JSON.stringify({
            id: pendingQueryIds[1],
            success: true,
            result: [{ value: 'second' }]
          }));
          setTimeout(() => {
            socket.send(JSON.stringify({
              id: pendingQueryIds[0],
              success: true,
              result: [{ value: 'first' }]
            }));
          }, 10);
        }
      }
    });
  });

  const client = new DucklingClient({
    url,
    apiKey: 'test-key',
    autoReconnect: false,
    autoPing: false
  });

  try {
    await client.connect();

    const [first, second] = await Promise.all([
      client.query('SELECT first'),
      client.query('SELECT second')
    ]);

    assert.deepEqual(first, [{ value: 'first' }]);
    assert.deepEqual(second, [{ value: 'second' }]);
    assert.equal(client.getStats().pendingRequests, 0);
  } finally {
    client.close();
    await closeServer(server);
  }
});

test('ping failures tear down the socket and trigger reconnect', async () => {
  let connectionCount = 0;

  const { server, url } = await createServer((socket) => {
    connectionCount += 1;

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());

      if (message.type === 'auth') {
        socket.send(JSON.stringify({ id: message.id, success: true, result: [] }));
        return;
      }

      if (message.type === 'ping') {
        socket.send(JSON.stringify({ id: message.id, success: false, error: 'ping unhealthy' }));
      }
    });
  });

  const reconnectAttempts = [];
  const client = new DucklingClient({
    url,
    apiKey: 'test-key',
    autoReconnect: true,
    autoPing: true,
    pingInterval: 20,
    reconnectDelay: 10,
    maxReconnectAttempts: 2
  });

  client.on('reconnecting', (attempt) => {
    reconnectAttempts.push(attempt);
  });

  try {
    await client.connect();
    await waitFor(() => connectionCount >= 2, 1000);
    assert.ok(reconnectAttempts.includes(1));
  } finally {
    client.close();
    await closeServer(server);
  }
});

test('in-flight requests are rejected and cleaned up when the socket closes mid-query', async () => {
  const { server, url } = await createServer((socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());

      if (message.type === 'auth') {
        socket.send(JSON.stringify({ id: message.id, success: true, result: [] }));
        return;
      }

      if (message.type === 'query') {
        socket.close(1012, 'server restart');
      }
    });
  });

  const client = new DucklingClient({
    url,
    apiKey: 'test-key',
    autoReconnect: false,
    autoPing: false,
    requestTimeout: 1000
  });

  try {
    await client.connect();

    await assert.rejects(
      client.query('SELECT slow_operation'),
      /Connection closed/i
    );

    assert.equal(client.isConnected(), false);
    assert.equal(client.getStats().pendingRequests, 0);
  } finally {
    client.close();
    await closeServer(server);
  }
});

test('timed-out connect attempts clean up sockets and allow a later reconnect', async () => {
  const activeSockets = new Set();
  let connectionCount = 0;

  const { server, url } = await createServer((socket) => {
    connectionCount += 1;
    activeSockets.add(socket);
    socket.on('close', () => {
      activeSockets.delete(socket);
    });

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());

      if (message.type !== 'auth') {
        return;
      }

      if (connectionCount === 1) {
        return;
      }

      socket.send(JSON.stringify({ id: message.id, success: true, result: [] }));
    });
  });

  const client = new DucklingClient({
    url,
    apiKey: 'test-key',
    autoReconnect: false,
    autoPing: false,
    connectionTimeout: 50
  });

  try {
    await assert.rejects(client.connect(), /Connection timeout/);
    await waitFor(() => activeSockets.size === 0, 1000);
    assert.equal(client.getStats().pendingRequests, 0);

    await client.connect();
    assert.equal(client.isConnected(), true);
  } finally {
    client.close();
    await closeServer(server);
  }
});

test('manual close cancels a scheduled reconnect', async () => {
  let connectionCount = 0;

  const { server, url } = await createServer((socket) => {
    connectionCount += 1;

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());

      if (message.type === 'auth') {
        socket.send(JSON.stringify({ id: message.id, success: true, result: [] }));
        setTimeout(() => {
          socket.close(1012, 'restart');
        }, 5);
      }
    });
  });

  const reconnectAttempts = [];
  const client = new DucklingClient({
    url,
    apiKey: 'test-key',
    autoReconnect: true,
    autoPing: false,
    reconnectDelay: 50,
    maxReconnectAttempts: 3
  });

  client.on('reconnecting', (attempt) => {
    reconnectAttempts.push(attempt);
  });

  try {
    await client.connect();
    await waitFor(() => reconnectAttempts.length === 1, 1000);
    client.close();
    await delay(120);

    assert.equal(connectionCount, 1);
    assert.deepEqual(reconnectAttempts, [1]);
    assert.equal(client.isConnected(), false);
  } finally {
    client.close();
    await closeServer(server);
  }
});

test('request timeout uses config.requestTimeout instead of the hardcoded 30 seconds', async () => {
  const { server, url } = await createServer((socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());

      if (message.type === 'auth') {
        socket.send(JSON.stringify({ id: message.id, success: true, result: [] }));
      }
    });
  });

  const client = new DucklingClient({
    url,
    apiKey: 'test-key',
    autoReconnect: false,
    autoPing: false,
    requestTimeout: 40
  });

  try {
    await client.connect();

    const startedAt = Date.now();
    await assert.rejects(client.query('SELECT 1'), /Request timeout/);
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < 500, `expected request timeout to occur quickly, got ${elapsedMs}ms`);
    assert.equal(client.getStats().pendingRequests, 0);
  } finally {
    client.close();
    await closeServer(server);
  }
});

test('reconnectExhausted is emitted when auto-reconnect reaches the configured limit', async () => {
  let connectionCount = 0;

  const { server, url } = await createServer((socket) => {
    connectionCount += 1;

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());

      if (message.type === 'auth') {
        if (connectionCount === 1) {
          socket.send(JSON.stringify({ id: message.id, success: true, result: [] }));
          setTimeout(() => {
            socket.close(1013, 'try again later');
          }, 5);
        }
      }
    });
  });

  const exhaustedEvents = [];
  const client = new DucklingClient({
    url,
    apiKey: 'test-key',
    autoReconnect: true,
    autoPing: false,
    reconnectDelay: 10,
    maxReconnectAttempts: 1,
    connectionTimeout: 50
  });

  client.on('reconnectExhausted', (attempts, error) => {
    exhaustedEvents.push({ attempts, error });
  });

  try {
    await client.connect();
    await waitFor(() => exhaustedEvents.length === 1, 1000);

    assert.equal(connectionCount, 2);
    assert.equal(exhaustedEvents[0].attempts, 1);
    assert.match(exhaustedEvents[0].error.message, /Reconnect attempts exhausted/);
  } finally {
    client.close();
    await closeServer(server);
  }
});

test('manual connect resets the reconnect budget after a previously exhausted cycle', async () => {
  let connectionCount = 0;

  const { server, url } = await createServer((socket) => {
    connectionCount += 1;

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());

      if (message.type !== 'auth') {
        return;
      }

      if (connectionCount === 1) {
        socket.send(JSON.stringify({ id: message.id, success: true, result: [] }));
        setTimeout(() => {
          socket.close(1013, 'temporary failure');
        }, 5);
        return;
      }

      if (connectionCount >= 4) {
        socket.send(JSON.stringify({ id: message.id, success: true, result: [] }));
      }
    });
  });

  const reconnectAttempts = [];
  const exhaustedEvents = [];
  const client = new DucklingClient({
    url,
    apiKey: 'test-key',
    autoReconnect: true,
    autoPing: false,
    reconnectDelay: 10,
    maxReconnectAttempts: 1,
    connectionTimeout: 40
  });

  client.on('reconnecting', (attempt) => {
    reconnectAttempts.push(attempt);
  });
  client.on('reconnectExhausted', (attempts) => {
    exhaustedEvents.push(attempts);
  });

  try {
    await client.connect();
    await waitFor(() => exhaustedEvents.length === 1, 1000);

    await assert.rejects(client.connect(), /Connection timeout/);
    await waitFor(() => client.isConnected(), 1000);

    assert.ok(connectionCount >= 4);
    assert.deepEqual(reconnectAttempts, [1, 1]);
    assert.deepEqual(exhaustedEvents, [1]);
  } finally {
    client.close();
    await closeServer(server);
  }
});

test('close codes 1008 and 1011 do not trigger reconnect attempts', async () => {
  for (const closeCode of [1008, 1011]) {
    let connectionCount = 0;

    const { server, url } = await createServer((socket) => {
      connectionCount += 1;

      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());

        if (message.type === 'auth') {
          socket.send(JSON.stringify({ id: message.id, success: true, result: [] }));
          setTimeout(() => {
            socket.close(closeCode, `close-${closeCode}`);
          }, 5);
        }
      });
    });

    const reconnectAttempts = [];
    const exhaustedEvents = [];
    const client = new DucklingClient({
      url,
      apiKey: 'test-key',
      autoReconnect: true,
      autoPing: false,
      reconnectDelay: 10,
      maxReconnectAttempts: 2
    });

    client.on('reconnecting', (attempt) => {
      reconnectAttempts.push(attempt);
    });
    client.on('reconnectExhausted', (attempts) => {
      exhaustedEvents.push(attempts);
    });

    try {
      await client.connect();
      await delay(100);

      assert.equal(connectionCount, 1);
      assert.deepEqual(reconnectAttempts, []);
      assert.deepEqual(exhaustedEvents, []);
    } finally {
      client.close();
      await closeServer(server);
    }
  }
});

test('authentication failures do not trigger reconnect attempts', async () => {
  let connectionCount = 0;

  const { server, url } = await createServer((socket) => {
    connectionCount += 1;

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());

      if (message.type === 'auth') {
        socket.send(JSON.stringify({ id: message.id, success: false, error: 'Invalid API key' }));
        setTimeout(() => {
          socket.close(1008, 'invalid api key');
        }, 5);
      }
    });
  });

  const reconnectAttempts = [];
  const exhaustedEvents = [];
  const client = new DucklingClient({
    url,
    apiKey: 'wrong-key',
    autoReconnect: true,
    autoPing: false,
    reconnectDelay: 10,
    maxReconnectAttempts: 2
  });

  client.on('reconnecting', (attempt) => {
    reconnectAttempts.push(attempt);
  });
  client.on('reconnectExhausted', (attempts) => {
    exhaustedEvents.push(attempts);
  });

  try {
    await assert.rejects(client.connect(), /Authentication failed: Invalid API key/);
    await delay(100);

    assert.equal(connectionCount, 1);
    assert.deepEqual(reconnectAttempts, []);
    assert.deepEqual(exhaustedEvents, []);
  } finally {
    client.close();
    await closeServer(server);
  }
});
