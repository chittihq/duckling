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
