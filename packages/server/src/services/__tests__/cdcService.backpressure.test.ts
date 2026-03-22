import { afterEach, describe, expect, test, vi } from 'vitest';

// Mock all heavy dependencies before importing CDCService
vi.mock('../../database/duckdb', () => ({
  default: {
    getInstance: vi.fn(() => ({
      run: vi.fn().mockResolvedValue(undefined),
      all: vi.fn().mockResolvedValue([]),
    })),
  },
}));

vi.mock('../../database/databaseConfig', () => ({
  DatabaseConfigManager: {
    getInstance: vi.fn(() => ({
      getDatabase: vi.fn(() => ({
        id: 'test-db',
        duckdbPath: '/tmp/test.db',
      })),
    })),
  },
}));

vi.mock('../../config', () => ({
  default: {
    cdc: {
      maxQueueSize: 100,
      sslRejectUnauthorized: true,
    },
  },
}));

vi.mock('../../logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@vlasky/zongji', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    })),
  };
});

vi.mock('../../workers/workerPool', () => ({
  WorkerPool: {
    getInstance: vi.fn(() => ({
      execute: vi.fn(),
    })),
  },
}));

import { CDCService } from '../cdcService';

// Helper to access private members for testing
function getPrivate(service: CDCService): any {
  return service as any;
}

describe('CDCService backpressure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up any instances
    CDCService.getAllInstances().clear();
  });

  function createService(): CDCService {
    const config = {
      databaseId: 'test-db',
      mysqlHost: 'localhost',
      mysqlPort: 3306,
      mysqlUser: 'root',
      mysqlPassword: 'password',
      mysqlDatabase: 'testdb',
    };
    return new (CDCService as any)(config);
  }

  describe('pauseBinlogStream', () => {
    test('returns true when connection.pause() is available', () => {
      const service = createService();
      const priv = getPrivate(service);
      priv.zongji = {
        connection: {
          pause: vi.fn(),
          resume: vi.fn(),
        },
      };

      const result = priv.pauseBinlogStream();
      expect(result).toBe(true);
      expect(priv.zongji.connection.pause).toHaveBeenCalled();
    });

    test('falls back to connection.stream.pause() when connection.pause is not a function', () => {
      const service = createService();
      const priv = getPrivate(service);
      priv.zongji = {
        connection: {
          // No pause/resume on connection itself
          stream: {
            pause: vi.fn(),
            resume: vi.fn(),
          },
        },
      };

      const result = priv.pauseBinlogStream();
      expect(result).toBe(true);
      expect(priv.zongji.connection.stream.pause).toHaveBeenCalled();
    });

    test('returns false when neither pause method is available', () => {
      const service = createService();
      const priv = getPrivate(service);
      priv.zongji = {
        connection: {
          // No pause, no stream
        },
      };

      const result = priv.pauseBinlogStream();
      expect(result).toBe(false);
    });

    test('returns false when zongji is null', () => {
      const service = createService();
      const priv = getPrivate(service);
      priv.zongji = null;

      const result = priv.pauseBinlogStream();
      expect(result).toBe(false);
    });

    test('returns false and logs warning when pause throws', () => {
      const service = createService();
      const priv = getPrivate(service);
      priv.zongji = {
        connection: {
          pause: vi.fn(() => { throw new Error('pause failed'); }),
        },
      };

      const result = priv.pauseBinlogStream();
      expect(result).toBe(false);
    });
  });

  describe('resumeBinlogStream', () => {
    test('calls connection.resume() when available', () => {
      const service = createService();
      const priv = getPrivate(service);
      priv.zongji = {
        connection: {
          pause: vi.fn(),
          resume: vi.fn(),
        },
      };

      priv.resumeBinlogStream();
      expect(priv.zongji.connection.resume).toHaveBeenCalled();
    });

    test('falls back to connection.stream.resume() when connection.resume is not a function', () => {
      const service = createService();
      const priv = getPrivate(service);
      priv.zongji = {
        connection: {
          stream: {
            pause: vi.fn(),
            resume: vi.fn(),
          },
        },
      };

      priv.resumeBinlogStream();
      expect(priv.zongji.connection.stream.resume).toHaveBeenCalled();
    });
  });

  describe('forceReconnectForBackpressure', () => {
    test('stops zongji, clears queue, resets state, and schedules reconnect', () => {
      const service = createService();
      const priv = getPrivate(service);
      const stopMock = vi.fn();
      priv.zongji = { stop: stopMock };
      priv.isRunning = true;
      priv.stats.isRunning = true;
      priv.isPaused = true;
      priv.eventQueue = new Array(200).fill(() => Promise.resolve());

      const reconnectSpy = vi.spyOn(priv, 'scheduleReconnect').mockImplementation(() => {});

      priv.forceReconnectForBackpressure();

      expect(stopMock).toHaveBeenCalled();
      expect(priv.zongji).toBeNull();
      expect(priv.isPaused).toBe(false);
      expect(priv.isRunning).toBe(false);
      expect(priv.stats.isRunning).toBe(false);
      expect(priv.eventQueue.length).toBe(0); // Queue must be cleared to prevent duplicates
      expect(reconnectSpy).toHaveBeenCalled();
    });

    test('handles zongji.stop() throwing an error gracefully', () => {
      const service = createService();
      const priv = getPrivate(service);
      priv.zongji = {
        stop: vi.fn(() => { throw new Error('stop failed'); }),
      };
      priv.isRunning = true;

      const reconnectSpy = vi.spyOn(priv, 'scheduleReconnect').mockImplementation(() => {});

      // Should not throw
      priv.forceReconnectForBackpressure();

      expect(priv.zongji).toBeNull();
      expect(reconnectSpy).toHaveBeenCalled();
    });
  });

  describe('backpressureAvailable flag', () => {
    test('defaults to false', () => {
      const service = createService();
      expect(getPrivate(service).backpressureAvailable).toBe(false);
    });

    test('is reset to false on start()', async () => {
      const service = createService();
      const priv = getPrivate(service);
      priv.backpressureAvailable = true;

      // Mock start dependencies
      priv.initPositionTable = vi.fn().mockResolvedValue(undefined);
      priv.getLastPosition = vi.fn().mockResolvedValue(null);
      priv.setupEventHandlers = vi.fn();
      const ZongJiMock = (await import('@vlasky/zongji')).default;
      (ZongJiMock as any).mockImplementation(() => ({
        on: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      }));

      await priv.start();
      expect(priv.backpressureAvailable).toBe(false);
    });
  });

  describe('critical queue limit in binlog handler', () => {
    test('setupEventHandlers registers binlog handler that triggers force reconnect at critical limit when backpressure unavailable', () => {
      const service = createService();
      const priv = getPrivate(service);

      // Set up a mock zongji that captures event handlers
      const handlers: Record<string, Function> = {};
      priv.zongji = {
        on: vi.fn((event: string, handler: Function) => {
          handlers[event] = handler;
        }),
        stop: vi.fn(),
        connection: {
          // No pause/resume — backpressure unavailable
        },
      };

      priv.backpressureAvailable = false;

      // Call setupEventHandlers to register handlers
      priv.setupEventHandlers();

      // Verify binlog handler was registered
      expect(handlers['binlog']).toBeDefined();

      // Fill queue to critical level (2× maxQueueSize = 200)
      priv.eventQueue = new Array(200).fill(() => Promise.resolve());

      // Spy on forceReconnectForBackpressure
      const forceSpy = vi.spyOn(priv, 'forceReconnectForBackpressure').mockImplementation(() => {});

      // Trigger binlog event
      const mockEvent = { getTypeName: () => 'WriteRows' };
      handlers['binlog'](mockEvent);

      expect(forceSpy).toHaveBeenCalled();
    });

    test('triggers force reconnect even when backpressure was probed as available (runtime failure)', () => {
      const service = createService();
      const priv = getPrivate(service);

      const handlers: Record<string, Function> = {};
      priv.zongji = {
        on: vi.fn((event: string, handler: Function) => {
          handlers[event] = handler;
        }),
        stop: vi.fn(),
        connection: {
          pause: vi.fn(),
          resume: vi.fn(),
        },
      };

      // Backpressure was probed as available, but queue still grew to critical
      // (e.g. pause succeeded but didn't actually stop data flow)
      priv.backpressureAvailable = true;

      priv.setupEventHandlers();

      // Fill queue to critical level (2× maxQueueSize = 200)
      priv.eventQueue = new Array(200).fill(() => Promise.resolve());

      const forceSpy = vi.spyOn(priv, 'forceReconnectForBackpressure').mockImplementation(() => {});

      const mockEvent = { getTypeName: () => 'WriteRows' };
      handlers['binlog'](mockEvent);

      // MUST force reconnect — if queue reached 2×, pause clearly didn't work
      expect(forceSpy).toHaveBeenCalled();
    });

    test('binlog handler does NOT force reconnect when queue is below critical limit', () => {
      const service = createService();
      const priv = getPrivate(service);

      const handlers: Record<string, Function> = {};
      priv.zongji = {
        on: vi.fn((event: string, handler: Function) => {
          handlers[event] = handler;
        }),
        stop: vi.fn(),
        connection: {},
      };

      priv.backpressureAvailable = false;

      priv.setupEventHandlers();

      // Fill queue to below critical level (< 200)
      priv.eventQueue = new Array(50).fill(() => Promise.resolve());

      const forceSpy = vi.spyOn(priv, 'forceReconnectForBackpressure').mockImplementation(() => {});

      const mockEvent = {
        getTypeName: () => 'WriteRows',
        tableMap: {},
        tableId: 1,
        nextPosition: 100,
      };
      handlers['binlog'](mockEvent);

      expect(forceSpy).not.toHaveBeenCalled();
    });

    test('soft pause block is skipped when backpressure is unavailable (no log spam)', () => {
      const service = createService();
      const priv = getPrivate(service);

      const handlers: Record<string, Function> = {};
      const pauseMock = vi.fn();
      priv.zongji = {
        on: vi.fn((event: string, handler: Function) => {
          handlers[event] = handler;
        }),
        stop: vi.fn(),
        connection: {},
      };

      priv.backpressureAvailable = false;
      priv.isPaused = false;

      priv.setupEventHandlers();

      // Fill queue above maxQueueSize but below critical
      priv.eventQueue = new Array(150).fill(() => Promise.resolve());

      // Spy to ensure pauseBinlogStream is never called
      const pauseSpy = vi.spyOn(priv, 'pauseBinlogStream');

      const mockEvent = {
        getTypeName: () => 'WriteRows',
        tableMap: {},
        tableId: 1,
        nextPosition: 100,
      };
      handlers['binlog'](mockEvent);

      // Should NOT attempt to pause since backpressure is unavailable
      expect(pauseSpy).not.toHaveBeenCalled();
      // isPaused should remain false
      expect(priv.isPaused).toBe(false);
    });

    test('runtime pause failure downgrades backpressureAvailable', () => {
      const service = createService();
      const priv = getPrivate(service);

      const handlers: Record<string, Function> = {};
      priv.zongji = {
        on: vi.fn((event: string, handler: Function) => {
          handlers[event] = handler;
        }),
        stop: vi.fn(),
        connection: {
          // connection has no pause/resume, but was initially probed via stream
          // Simulating stream.pause() breaking at runtime
        },
      };

      priv.backpressureAvailable = true; // Was probed as available

      priv.setupEventHandlers();

      // Fill queue above maxQueueSize
      priv.eventQueue = new Array(100).fill(() => Promise.resolve());

      const mockEvent = {
        getTypeName: () => 'WriteRows',
        tableMap: {},
        tableId: 1,
        nextPosition: 100,
      };
      handlers['binlog'](mockEvent);

      // pauseBinlogStream() returns false → backpressureAvailable should be downgraded
      expect(priv.backpressureAvailable).toBe(false);
      // isPaused should NOT be set since pause failed
      expect(priv.isPaused).toBe(false);
    });
  });

  describe('ready event sets backpressureAvailable', () => {
    test('sets backpressureAvailable=true when connection has pause/resume', () => {
      const service = createService();
      const priv = getPrivate(service);

      const handlers: Record<string, Function> = {};
      priv.zongji = {
        on: vi.fn((event: string, handler: Function) => {
          handlers[event] = handler;
        }),
        connection: {
          pause: vi.fn(),
          resume: vi.fn(),
        },
      };

      priv.setupEventHandlers();
      handlers['ready']();

      expect(priv.backpressureAvailable).toBe(true);
    });

    test('sets backpressureAvailable=true when only stream has pause/resume', () => {
      const service = createService();
      const priv = getPrivate(service);

      const handlers: Record<string, Function> = {};
      priv.zongji = {
        on: vi.fn((event: string, handler: Function) => {
          handlers[event] = handler;
        }),
        connection: {
          stream: {
            pause: vi.fn(),
            resume: vi.fn(),
          },
        },
      };

      priv.setupEventHandlers();
      handlers['ready']();

      expect(priv.backpressureAvailable).toBe(true);
    });

    test('sets backpressureAvailable=false when no pause/resume methods exist', () => {
      const service = createService();
      const priv = getPrivate(service);

      const handlers: Record<string, Function> = {};
      priv.zongji = {
        on: vi.fn((event: string, handler: Function) => {
          handlers[event] = handler;
        }),
        connection: {},
      };

      priv.setupEventHandlers();
      handlers['ready']();

      expect(priv.backpressureAvailable).toBe(false);
    });
  });

  describe('scheduleReconnect timer dedupe', () => {
    test('skips scheduling when a reconnect timer is already armed', () => {
      const service = createService();
      const priv = getPrivate(service);
      priv.isStopped = false;
      priv.reconnectAttempts = 0;

      // First call arms the timer
      priv.scheduleReconnect();
      expect(priv.reconnectTimeoutId).not.toBeNull();
      const firstTimerId = priv.reconnectTimeoutId;
      const firstAttempts = priv.reconnectAttempts;

      // Second call should be a no-op (timer already armed)
      priv.scheduleReconnect();
      expect(priv.reconnectTimeoutId).toBe(firstTimerId);
      expect(priv.reconnectAttempts).toBe(firstAttempts);

      // Cleanup
      clearTimeout(priv.reconnectTimeoutId);
      priv.reconnectTimeoutId = null;
    });

    test('allows scheduling after previous timer is cleared', () => {
      const service = createService();
      const priv = getPrivate(service);
      priv.isStopped = false;
      priv.reconnectAttempts = 0;

      // First call arms the timer
      priv.scheduleReconnect();
      expect(priv.reconnectTimeoutId).not.toBeNull();

      // Clear the timer (simulating stop() or timer firing)
      clearTimeout(priv.reconnectTimeoutId);
      priv.reconnectTimeoutId = null;

      // Now a second call should succeed
      priv.scheduleReconnect();
      expect(priv.reconnectTimeoutId).not.toBeNull();

      // Cleanup
      clearTimeout(priv.reconnectTimeoutId);
      priv.reconnectTimeoutId = null;
    });
  });
});
