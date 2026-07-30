import * as net from 'net';
import logger from '../logger';

/**
 * TCP multiplexer that lets HTTP and the MySQL wire protocol share one port.
 *
 * The two protocols initiate differently, which makes first-byte detection
 * reliable:
 *   - HTTP (and WebSocket upgrades): the client sends first (`GET /...`).
 *   - MySQL: the SERVER sends first (the greeting packet) — the client
 *     connects and sits in silence waiting for it.
 *
 * So: accept, wait up to `detectionTimeoutMs` for data. Data → HTTP.
 * Silence → MySQL client waiting for a greeting.
 */

export interface PortMultiplexerTargets {
  /**
   * Receives sockets classified as HTTP. The first chunk has already been
   * unshifted back onto the (paused) socket; the callee typically does
   * `httpServer.emit('connection', socket)`. The multiplexer resumes the
   * socket on the next tick.
   */
  handleHttpSocket(socket: net.Socket): void;
  /**
   * Receives sockets classified as MySQL. Return false when the MySQL
   * backend is unavailable (the socket is then destroyed).
   */
  handleMysqlSocket(socket: net.Socket): boolean;
}

export function createPortMultiplexer(
  targets: PortMultiplexerTargets,
  detectionTimeoutMs: number
): net.Server {
  return net.createServer((socket) => {
    let settled = false;

    const onError = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
      }
    };

    const onClose = () => {
      settled = true;
      clearTimeout(timer);
    };

    const onFirstData = (chunk: Buffer) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.off('error', onError);
      socket.off('close', onClose);
      // Detection consumed bytes the HTTP parser needs: pause the stream,
      // push the chunk back, hand over, then resume once the new owner has
      // attached its listeners.
      socket.pause();
      socket.unshift(chunk);
      try {
        targets.handleHttpSocket(socket);
      } catch (err) {
        logger.error('Shared-port HTTP handoff failed:', err);
        socket.destroy();
        return;
      }
      process.nextTick(() => socket.resume());
    };

    const timer = setTimeout(() => {
      if (settled || socket.destroyed) {
        return;
      }
      settled = true;
      socket.off('data', onFirstData);
      socket.off('error', onError);
      socket.off('close', onClose);
      let accepted = false;
      try {
        accepted = targets.handleMysqlSocket(socket);
      } catch (err) {
        logger.error('Shared-port MySQL handoff failed:', err);
      }
      if (!accepted) {
        socket.destroy();
      }
    }, detectionTimeoutMs);

    socket.once('data', onFirstData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}
