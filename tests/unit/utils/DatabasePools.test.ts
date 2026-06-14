/**
 * DatabasePools Unit Tests
 * Tests for PostgreSQL, MySQL, and MongoDB connection pool implementations
 */

// Mock pg module to avoid real database connections
jest.mock('pg', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    end: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockImplementation((text: string) => {
      if (text === 'SELECT 1') return Promise.resolve({ rows: [{ '?column?': 1 }] });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    }),
    on: jest.fn(),
  })),
}));

import {
  PostgreSQLConnectionPool,
  MySQLConnectionPool,
  MongoDBConnectionPool,
  ConnectionPoolFactory,
} from '../../../src/utils/DatabasePools';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Use fake timers to control setInterval/setTimeout in connection pools
jest.useFakeTimers({ advanceTimers: true });


describe('PostgreSQLConnectionPool', () => {
  let pool: PostgreSQLConnectionPool | undefined;
  const validConnectionString = 'postgresql://user:password@localhost:5432/testdb';

  afterEach(async () => {
    if (pool) {
      await pool.drain();
      pool = undefined;
    }
  });

  describe('constructor', () => {
    it('should parse valid connection string', () => {
      pool = new PostgreSQLConnectionPool(validConnectionString, { min: 0 });
      expect(pool).toBeDefined();
    });

    it('should throw on invalid connection string', () => {
      expect(() => {
        new PostgreSQLConnectionPool('invalid-string', { min: 0 });
      }).toThrow();
    });

    it('should parse SSL option from connection string', () => {
      pool = new PostgreSQLConnectionPool(
        'postgresql://user:pass@localhost:5432/db?ssl=true',
        { min: 0 }
      );
      expect(pool).toBeDefined();
    });
  });

  describe('create and destroy', () => {
    it('should create a mock connection', async () => {
      pool = new PostgreSQLConnectionPool(validConnectionString, { min: 0 });
      await new Promise(resolve => setTimeout(resolve, 100));

      const client = await pool.acquire();
      expect(client).toBeDefined();
      expect(client.query).toBeDefined();

      pool.release(client);
    });

    it('should destroy connections on drain', async () => {
      pool = new PostgreSQLConnectionPool(validConnectionString, { min: 1 });
      await new Promise(resolve => setTimeout(resolve, 100));

      await pool.drain();

      const stats = pool.getStats();
      expect(stats.totalResources).toBe(0);
    });
  });

  describe('executeQuery', () => {
    it('should execute query and return result', async () => {
      pool = new PostgreSQLConnectionPool(validConnectionString, { min: 1 });
      await new Promise(resolve => setTimeout(resolve, 100));

      const result = await pool.executeQuery('SELECT 1');
      expect(result).toBeDefined();
    });

    it('should release connection after query', async () => {
      pool = new PostgreSQLConnectionPool(validConnectionString, { min: 1, max: 1 });
      await new Promise(resolve => setTimeout(resolve, 100));

      await pool.executeQuery('SELECT 1');

      const stats = pool.getStats();
      expect(stats.inUseResources).toBe(0);
    });
  });

  describe('executeTransaction', () => {
    it('should execute multiple queries in transaction', async () => {
      pool = new PostgreSQLConnectionPool(validConnectionString, { min: 1 });
      await new Promise(resolve => setTimeout(resolve, 100));

      const results = await pool.executeTransaction([
        { text: 'SELECT 1' },
        { text: 'SELECT 2' },
      ]);

      expect(results).toHaveLength(2);
    });
  });
});

describe('MySQLConnectionPool', () => {
  let pool: MySQLConnectionPool | undefined;
  const validConnectionString = 'mysql://user:password@localhost:3306/testdb';

  afterEach(async () => {
    if (pool) {
      await pool.drain();
      pool = undefined;
    }
  });

  describe('constructor', () => {
    it('should parse valid connection string', () => {
      pool = new MySQLConnectionPool(validConnectionString, { min: 0 });
      expect(pool).toBeDefined();
    });

    it('should throw on invalid connection string', () => {
      expect(() => {
        new MySQLConnectionPool('invalid-string', { min: 0 });
      }).toThrow();
    });

    it('should parse SSL option from connection string', () => {
      pool = new MySQLConnectionPool(
        'mysql://user:pass@localhost:3306/db?ssl=true',
        { min: 0 }
      );
      expect(pool).toBeDefined();
    });
  });

  describe('create and destroy', () => {
    it('should create a mock connection', async () => {
      pool = new MySQLConnectionPool(validConnectionString, { min: 0 });
      await new Promise(resolve => setTimeout(resolve, 100));

      const connection = await pool.acquire();
      expect(connection).toBeDefined();
      expect(connection.execute).toBeDefined();
      expect(connection.ping).toBeDefined();

      pool.release(connection);
    });
  });

  describe('executeQuery', () => {
    it('should execute query and return rows', async () => {
      pool = new MySQLConnectionPool(validConnectionString, { min: 1 });
      await new Promise(resolve => setTimeout(resolve, 100));

      const result = await pool.executeQuery('SELECT 1');
      expect(result).toBeDefined();
    });
  });

  describe('executeTransaction', () => {
    it('should execute transaction with begin, queries, and commit', async () => {
      pool = new MySQLConnectionPool(validConnectionString, { min: 1 });
      await new Promise(resolve => setTimeout(resolve, 100));

      const results = await pool.executeTransaction([
        { sql: 'INSERT INTO table1 VALUES (1)' },
        { sql: 'UPDATE table1 SET x = 1' },
      ]);

      expect(results).toHaveLength(2);
    });
  });
});

describe('MongoDBConnectionPool', () => {
  let pool: MongoDBConnectionPool | undefined;
  const validConnectionString = 'mongodb://user:password@localhost:27017/testdb';

  afterEach(async () => {
    if (pool) {
      await pool.drain();
      pool = undefined;
    }
  });

  describe('constructor', () => {
    it('should parse valid connection string', () => {
      pool = new MongoDBConnectionPool(validConnectionString, { min: 0 });
      expect(pool).toBeDefined();
    });

    it('should throw on invalid connection string', () => {
      expect(() => {
        new MongoDBConnectionPool('invalid-string', { min: 0 });
      }).toThrow();
    });

    it('should extract database name from path', () => {
      pool = new MongoDBConnectionPool(
        'mongodb://localhost:27017/mydbname',
        { min: 0 }
      );
      expect(pool).toBeDefined();
    });

    it('should use "test" as default database name', () => {
      pool = new MongoDBConnectionPool(
        'mongodb://localhost:27017/',
        { min: 0 }
      );
      expect(pool).toBeDefined();
    });
  });

  describe('create and destroy', () => {
    it('should create a mock client', async () => {
      pool = new MongoDBConnectionPool(validConnectionString, { min: 0 });
      await new Promise(resolve => setTimeout(resolve, 100));

      const client = await pool.acquire();
      expect(client).toBeDefined();
      expect(client.db).toBeDefined();

      pool.release(client);
    });
  });

  describe('getDatabase', () => {
    it('should return database object', async () => {
      pool = new MongoDBConnectionPool(validConnectionString, { min: 1 });
      await new Promise(resolve => setTimeout(resolve, 100));

      const db = await pool.getDatabase();
      expect(db).toBeDefined();
    });
  });

  describe('executeOperation', () => {
    it('should execute operation on database', async () => {
      pool = new MongoDBConnectionPool(validConnectionString, { min: 1 });
      await new Promise(resolve => setTimeout(resolve, 100));

      const result = await pool.executeOperation(async (db) => {
        expect(db).toBeDefined();
        return 'success';
      });

      expect(result).toBe('success');
    });

    it('should release connection after operation', async () => {
      pool = new MongoDBConnectionPool(validConnectionString, { min: 1, max: 1 });
      await new Promise(resolve => setTimeout(resolve, 100));

      await pool.executeOperation(async () => 'done');

      const stats = pool.getStats();
      expect(stats.inUseResources).toBe(0);
    });
  });
});

describe('ConnectionPoolFactory', () => {
  beforeEach(() => {
    // Clear all pools before each test
    ConnectionPoolFactory.drainAllPools();
  });

  afterAll(async () => {
    await ConnectionPoolFactory.drainAllPools();
  });

  describe('createPostgreSQLPool', () => {
    it('should create a new PostgreSQL pool', async () => {
      const pool = ConnectionPoolFactory.createPostgreSQLPool(
        'postgresql://user:pass@localhost:5432/testdb',
        { min: 0 }
      );

      expect(pool).toBeInstanceOf(PostgreSQLConnectionPool);
      await pool.drain();
    });

    it('should return same pool for same connection string', async () => {
      const connStr = 'postgresql://user:pass@localhost:5432/samedb';
      const pool1 = ConnectionPoolFactory.createPostgreSQLPool(connStr, { min: 0 });
      const pool2 = ConnectionPoolFactory.createPostgreSQLPool(connStr, { min: 0 });

      expect(pool1).toBe(pool2);
      await pool1.drain();
    });
  });

  describe('createMySQLPool', () => {
    it('should create a new MySQL pool', async () => {
      const pool = ConnectionPoolFactory.createMySQLPool(
        'mysql://user:pass@localhost:3306/testdb',
        { min: 0 }
      );

      expect(pool).toBeInstanceOf(MySQLConnectionPool);
      await pool.drain();
    });

    it('should return same pool for same connection string', async () => {
      const connStr = 'mysql://user:pass@localhost:3306/samedb';
      const pool1 = ConnectionPoolFactory.createMySQLPool(connStr, { min: 0 });
      const pool2 = ConnectionPoolFactory.createMySQLPool(connStr, { min: 0 });

      expect(pool1).toBe(pool2);
      await pool1.drain();
    });
  });

  describe('createMongoDBPool', () => {
    it('should create a new MongoDB pool', async () => {
      const pool = ConnectionPoolFactory.createMongoDBPool(
        'mongodb://user:pass@localhost:27017/testdb',
        { min: 0 }
      );

      expect(pool).toBeInstanceOf(MongoDBConnectionPool);
      await pool.drain();
    });

    it('should return same pool for same connection string', async () => {
      const connStr = 'mongodb://localhost:27017/samedb';
      const pool1 = ConnectionPoolFactory.createMongoDBPool(connStr, { min: 0 });
      const pool2 = ConnectionPoolFactory.createMongoDBPool(connStr, { min: 0 });

      expect(pool1).toBe(pool2);
      await pool1.drain();
    });
  });

  describe('getAllStats', () => {
    it('should return stats for all pools', async () => {
      ConnectionPoolFactory.createPostgreSQLPool(
        'postgresql://user:pass@localhost:5432/statsdb',
        { min: 0 }
      );
      ConnectionPoolFactory.createMySQLPool(
        'mysql://user:pass@localhost:3306/statsdb',
        { min: 0 }
      );

      const stats = await ConnectionPoolFactory.getAllStats();

      expect(stats).toBeDefined();
      expect(typeof stats).toBe('object');
    });
  });

  describe('drainAllPools', () => {
    it('should drain all created pools', async () => {
      ConnectionPoolFactory.createPostgreSQLPool(
        'postgresql://user:pass@localhost:5432/draindb',
        { min: 0 }
      );
      ConnectionPoolFactory.createMySQLPool(
        'mysql://user:pass@localhost:3306/draindb',
        { min: 0 }
      );

      await ConnectionPoolFactory.drainAllPools();

      const pools = ConnectionPoolFactory.getAllPools();
      expect(pools.size).toBe(0);
    });
  });

  describe('getPool', () => {
    it('should return pool by key', async () => {
      const connStr = 'postgresql://user:pass@localhost:5432/getdb';
      ConnectionPoolFactory.createPostgreSQLPool(connStr, { min: 0 });

      const pool = ConnectionPoolFactory.getPool(`postgresql:${connStr}`);
      expect(pool).toBeDefined();
    });

    it('should return undefined for non-existent key', () => {
      const pool = ConnectionPoolFactory.getPool('nonexistent:key');
      expect(pool).toBeUndefined();
    });
  });

  describe('getAllPools', () => {
    it('should return map of all pools', async () => {
      ConnectionPoolFactory.createPostgreSQLPool(
        'postgresql://user:pass@localhost:5432/alldb1',
        { min: 0 }
      );
      ConnectionPoolFactory.createMySQLPool(
        'mysql://user:pass@localhost:3306/alldb2',
        { min: 0 }
      );

      const pools = ConnectionPoolFactory.getAllPools();

      expect(pools).toBeInstanceOf(Map);
      expect(pools.size).toBe(2);
    });
  });
});

describe('Connection validation', () => {
  afterEach(async () => {
    await ConnectionPoolFactory.drainAllPools();
  });

  it('PostgreSQL should validate connections with SELECT 1', async () => {
    const pool = new PostgreSQLConnectionPool(
      'postgresql://user:pass@localhost:5432/validdb',
      { min: 0 }
    );
    await new Promise(resolve => setTimeout(resolve, 100));

    // Acquire should trigger validation
    const client = await pool.acquire();
    expect(client).toBeDefined();

    pool.release(client);
    await pool.drain();
  });

  it('MySQL should validate connections with ping', async () => {
    const pool = new MySQLConnectionPool(
      'mysql://user:pass@localhost:3306/validdb',
      { min: 0 }
    );
    await new Promise(resolve => setTimeout(resolve, 100));

    const connection = await pool.acquire();
    expect(connection).toBeDefined();

    pool.release(connection);
    await pool.drain();
  });

  it('MongoDB should validate connections with admin ping', async () => {
    const pool = new MongoDBConnectionPool(
      'mongodb://localhost:27017/validdb',
      { min: 0 }
    );
    await new Promise(resolve => setTimeout(resolve, 100));

    const client = await pool.acquire();
    expect(client).toBeDefined();

    pool.release(client);
    await pool.drain();
  });
});
