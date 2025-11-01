import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import DuckDBConnection from '../database/duckdb';
import config from '../config';
import logger from '../logger';

interface QueryMessage {
  id: string;
  type: 'query' | 'ping' | 'auth';
  sql?: string;
  params?: any[];
  apiKey?: string;
}

interface QueryResponse {
  id: string;
  success: boolean;
  result?: any[];
  error?: string;
  duration?: number;
}

export class WebSocketService {
  private wss: WebSocketServer;
  private duckdb: DuckDBConnection;
  private clients: Set<WebSocket> = new Set();
  private authenticatedClients: Set<WebSocket> = new Set();
  private static instance: WebSocketService;

  private constructor() {
    this.duckdb = DuckDBConnection.getInstance();
  }

  static getInstance(): WebSocketService {
    if (!WebSocketService.instance) {
      WebSocketService.instance = new WebSocketService();
    }
    return WebSocketService.instance;
  }

  /**
   * Initialize WebSocket server
   */
  initialize(server: Server): void {
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      // Performance optimizations
      perMessageDeflate: false, // Disable compression for speed
      clientTracking: true,
      maxPayload: 10 * 1024 * 1024 // 10MB max message
    });

    this.wss.on('connection', this.handleConnection.bind(this));

    logger.info('WebSocket service initialized', {
      path: '/ws',
      maxPayload: '10MB'
    });
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket): void {
    this.clients.add(ws);

    logger.info('WebSocket client connected', {
      totalClients: this.clients.size
    });

    // Send welcome message
    this.sendMessage(ws, {
      id: 'welcome',
      success: true,
      result: [{
        message: 'Connected to DuckDB WebSocket server',
        architecture: 'parquet',
        version: '1.0.0'
      }]
    });

    // Handle messages
    ws.on('message', (data: Buffer) => {
      this.handleMessage(ws, data).catch(error => {
        logger.error('Error handling WebSocket message:', error);
      });
    });

    // Handle connection close
    ws.on('close', () => {
      this.clients.delete(ws);
      this.authenticatedClients.delete(ws);
      logger.info('WebSocket client disconnected', {
        totalClients: this.clients.size,
        totalAuthenticated: this.authenticatedClients.size
      });
    });

    // Handle errors
    ws.on('error', (error) => {
      logger.error('WebSocket error:', error);
      this.clients.delete(ws);
      this.authenticatedClients.delete(ws);
    });

    // Setup heartbeat
    this.setupHeartbeat(ws);
  }

  /**
   * Handle incoming message
   */
  private async handleMessage(ws: WebSocket, data: Buffer): Promise<void> {
    const startTime = Date.now();
    let message: QueryMessage | undefined;

    try {
      message = JSON.parse(data.toString());

      // Handle authentication
      if (message.type === 'auth') {
        if (!message.apiKey) {
          this.sendMessage(ws, {
            id: message.id,
            success: false,
            error: 'API key is required'
          });
          return;
        }

        // Validate API key
        if (config.auth.apiKey && message.apiKey === config.auth.apiKey) {
          this.authenticatedClients.add(ws);
          this.sendMessage(ws, {
            id: message.id,
            success: true,
            result: [{ authenticated: true, message: 'Authentication successful' }]
          });
          logger.info('WebSocket client authenticated', { totalAuthenticated: this.authenticatedClients.size });
        } else {
          this.sendMessage(ws, {
            id: message.id,
            success: false,
            error: 'Invalid API key'
          });
          ws.close(1008, 'Invalid API key');
        }
        return;
      }

      // Check authentication for non-auth messages
      if (!this.authenticatedClients.has(ws)) {
        this.sendMessage(ws, {
          id: message.id,
          success: false,
          error: 'Not authenticated. Send auth message with valid API key first.'
        });
        return;
      }

      if (message.type === 'ping') {
        this.sendMessage(ws, {
          id: message.id,
          success: true,
          result: [{ pong: true, timestamp: new Date().toISOString() }]
        });
        return;
      }

      if (message.type === 'query') {
        if (!message.sql) {
          this.sendMessage(ws, {
            id: message.id,
            success: false,
            error: 'SQL query is required'
          });
          return;
        }

        // Execute query
        const result = await this.duckdb.query(message.sql, message.params);

        // Serialize BigInt values
        const serializedResult = this.serializeBigInt(result);

        const duration = Date.now() - startTime;

        this.sendMessage(ws, {
          id: message.id,
          success: true,
          result: serializedResult,
          duration
        });

        logger.debug('WebSocket query executed', {
          queryId: message.id,
          duration,
          rows: result.length
        });
      }
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error('WebSocket query failed:', error);

      this.sendMessage(ws, {
        id: message?.id || 'parse-error',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        duration
      });
    }
  }

  /**
   * Send message to client
   */
  private sendMessage(ws: WebSocket, response: QueryResponse): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(response));
    }
  }

  /**
   * Setup heartbeat to keep connection alive
   */
  private setupHeartbeat(ws: WebSocket): void {
    let isAlive = true;

    ws.on('pong', () => {
      isAlive = true;
    });

    const interval = setInterval(() => {
      if (!isAlive) {
        ws.terminate();
        clearInterval(interval);
        return;
      }

      isAlive = false;
      ws.ping();
    }, 30000); // 30 seconds

    ws.on('close', () => clearInterval(interval));
  }

  /**
   * Serialize BigInt values for JSON
   */
  private serializeBigInt(obj: any): any {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj === 'bigint') {
      return obj.toString();
    }

    if (obj instanceof Date) {
      return obj.toISOString();
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.serializeBigInt(item));
    }

    if (typeof obj === 'object') {
      const serialized: any = {};
      for (const [key, value] of Object.entries(obj)) {
        serialized[key] = this.serializeBigInt(value);
      }
      return serialized;
    }

    return obj;
  }

  /**
   * Broadcast message to all connected clients
   */
  broadcast(message: any): void {
    const data = JSON.stringify(message);

    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }

  /**
   * Get connection stats
   */
  getStats() {
    return {
      connectedClients: this.clients.size,
      serverRunning: this.wss !== undefined
    };
  }

  /**
   * Close all connections
   */
  close(): void {
    this.clients.forEach(client => client.close());
    this.wss?.close();
    logger.info('WebSocket service closed');
  }
}

export default WebSocketService;
