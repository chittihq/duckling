import { afterEach, describe, expect, test } from 'vitest';
import * as http from 'http';
import * as net from 'net';
import { createPortMultiplexer } from '../portMultiplexer';
import { MySQLProtocolServer } from '../mysqlProtocolServer';

const DETECTION_TIMEOUT_MS = 40;

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' }, () => resolve(socket));
    socket.once('error', reject);
  });
}

function collect(socket: net.Socket, ms: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    socket.on('data', (c) => chunks.push(c));
    setTimeout(() => resolve(Buffer.concat(chunks)), ms);
  });
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()!();
  }
});

describe('shared-port multiplexer', () => {
  test('HTTP detection: data-first connection routes to the HTTP server with no bytes lost', async () => {
    const httpServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`echo:${req.url}`);
    });

    const mux = createPortMultiplexer(
      {
        handleHttpSocket: (socket) => httpServer.emit('connection', socket),
        handleMysqlSocket: () => false,
      },
      DETECTION_TIMEOUT_MS
    );
    const port = await listen(mux);
    cleanups.push(() => closeServer(mux));

    const socket = await connect(port);
    cleanups.push(() => void socket.destroy());
    socket.write('GET /probe HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');

    const response = (await collect(socket, 300)).toString();
    expect(response).toContain('200 OK');
    // The request line was consumed during detection and unshifted back —
    // a mangled handoff would 400 or hang, not echo the path.
    expect(response).toContain('echo:/probe');
  });

  test('MySQL detection: silent connection goes to the MySQL handler after the timeout', async () => {
    let mysqlSocket: net.Socket | null = null;
    const mux = createPortMultiplexer(
      {
        handleHttpSocket: () => {
          throw new Error('should not classify as HTTP');
        },
        handleMysqlSocket: (socket) => {
          mysqlSocket = socket;
          return true;
        },
      },
      DETECTION_TIMEOUT_MS
    );
    const port = await listen(mux);
    cleanups.push(() => closeServer(mux));

    const socket = await connect(port);
    cleanups.push(() => void socket.destroy());
    await new Promise((r) => setTimeout(r, DETECTION_TIMEOUT_MS * 3));

    expect(mysqlSocket).not.toBeNull();
    expect(socket.destroyed).toBe(false);
  });

  test('WebSocket upgrade counts as HTTP (client sends first)', async () => {
    const httpServer = http.createServer();
    let upgraded = false;
    httpServer.on('upgrade', (req, socket) => {
      upgraded = true;
      socket.end('HTTP/1.1 101 Switching Protocols\r\n\r\n');
    });

    const mux = createPortMultiplexer(
      {
        handleHttpSocket: (socket) => httpServer.emit('connection', socket),
        handleMysqlSocket: () => false,
      },
      DETECTION_TIMEOUT_MS
    );
    const port = await listen(mux);
    cleanups.push(() => closeServer(mux));

    const socket = await connect(port);
    cleanups.push(() => void socket.destroy());
    socket.write(
      'GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
    );

    const response = (await collect(socket, 300)).toString();
    expect(upgraded).toBe(true);
    expect(response).toContain('101');
  });

  test('silence with no MySQL backend available destroys the socket', async () => {
    const mux = createPortMultiplexer(
      {
        handleHttpSocket: () => {
          throw new Error('should not classify as HTTP');
        },
        handleMysqlSocket: () => false,
      },
      DETECTION_TIMEOUT_MS
    );
    const port = await listen(mux);
    cleanups.push(() => closeServer(mux));

    const socket = await connect(port);
    const closed = new Promise<void>((r) => socket.once('close', () => r()));
    await closed;
    expect(socket.destroyed).toBe(true);
  });

  test('client close during detection: no handler is invoked', async () => {
    let httpCalls = 0;
    let mysqlCalls = 0;
    const mux = createPortMultiplexer(
      {
        handleHttpSocket: () => {
          httpCalls++;
        },
        handleMysqlSocket: () => {
          mysqlCalls++;
          return true;
        },
      },
      DETECTION_TIMEOUT_MS
    );
    const port = await listen(mux);
    cleanups.push(() => closeServer(mux));

    const socket = await connect(port);
    socket.destroy();
    await new Promise((r) => setTimeout(r, DETECTION_TIMEOUT_MS * 3));

    expect(httpCalls).toBe(0);
    expect(mysqlCalls).toBe(0);
  });

  test('graceful stop: multiplexer close() releases the port', async () => {
    const mux = createPortMultiplexer(
      { handleHttpSocket: () => {}, handleMysqlSocket: () => false },
      DETECTION_TIMEOUT_MS
    );
    const port = await listen(mux);
    await closeServer(mux);

    // The port is free again: a fresh listener binds without EADDRINUSE.
    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', () => resolve());
    });
    await closeServer(probe);
  });
});

describe('shared-port MySQLProtocolServer', () => {
  test('start() in shared mode does not listen; injected socket receives the MySQL greeting', async () => {
    const protocolServer = new MySQLProtocolServer({ sharedMode: true });
    await protocolServer.start();
    cleanups.push(() => protocolServer.stop());

    // Wire it behind a real multiplexer, exactly as server.ts does.
    const mux = createPortMultiplexer(
      {
        handleHttpSocket: () => {},
        handleMysqlSocket: (socket) => protocolServer.injectSocket(socket),
      },
      DETECTION_TIMEOUT_MS
    );
    const port = await listen(mux);
    cleanups.push(() => closeServer(mux));

    const socket = await connect(port);
    cleanups.push(() => void socket.destroy());
    // Say nothing — a MySQL client waits for the server greeting.
    const greeting = await collect(socket, DETECTION_TIMEOUT_MS * 6);

    // MySQL handshake-v10 greeting: 3-byte length, sequence 0, protocol 0x0a.
    expect(greeting.length).toBeGreaterThan(5);
    expect(greeting[3]).toBe(0); // sequence id
    expect(greeting[4]).toBe(0x0a); // protocol version 10
  });

  test('injectSocket() before start() refuses the socket', () => {
    const protocolServer = new MySQLProtocolServer({ sharedMode: true });
    const fake = new net.Socket();
    expect(protocolServer.injectSocket(fake)).toBe(false);
  });
});
