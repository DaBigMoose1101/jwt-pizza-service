// Test doubles for the external modules used by src/database/database.js, so the real DB class
// can run in unit tests without a MySQL server.
//
// Usage (at the top of a test file, before anything requires the database):
//   jest.mock('mysql2/promise', () => require('./testUtils.js').createMockMysql());
//   jest.mock('bcrypt', () => require('./testUtils.js').mockBcrypt);

const mockBcrypt = {
  hash: async (password) => `hashed:${password}`,
  compare: async (password, hash) => hash === `hashed:${password}`,
};

// Returns a stand-in for the mysql2/promise module backed by in-memory tables.
// The tables are exposed as `tables` so tests can inspect what was written.
function createMockMysql() {
  const tables = { user: [], userRole: [], auth: [], menu: [], franchise: [], store: [], dinerOrder: [], orderItem: [] };
  const lastId = {};

  function insert(table, row) {
    const id = (lastId[table] = (lastId[table] ?? 0) + 1);
    tables[table].push({ id, ...row });
    return { insertId: id };
  }

  function remove(table, predicate) {
    const before = tables[table].length;
    tables[table] = tables[table].filter((row) => !predicate(row));
    return { affectedRows: before - tables[table].length };
  }

  function select(table, predicate, columns) {
    return tables[table].filter(predicate).map((row) => (columns ? Object.fromEntries(columns.map((c) => [c, row[c]])) : { ...row }));
  }

  function like(value, pattern) {
    const regex = pattern
      .split('%')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${regex}$`).test(value);
  }

  function storeRevenue(storeId) {
    const orderIds = tables.dinerOrder.filter((o) => o.storeId === storeId).map((o) => o.id);
    return tables.orderItem.filter((i) => orderIds.includes(i.orderId)).reduce((sum, i) => sum + i.price, 0);
  }

  // Each entry maps a statement issued by database.js to what MySQL would return for it.
  // Handlers receive the bound params and the regex match.
  const statements = [
    [/INFORMATION_SCHEMA\.SCHEMATA/, () => []],

    [/^SELECT \* FROM menu$/, () => select('menu', () => true)],
    [/^INSERT INTO menu /, ([title, description, image, price]) => insert('menu', { title, description, image, price })],

    [/^INSERT INTO user /, ([name, email, password]) => insert('user', { name, email, password })],
    [/^SELECT \* FROM user WHERE email=\?$/, ([email]) => select('user', (u) => u.email === email)],
    [/^SELECT id, name FROM user WHERE email=\?$/, ([email]) => select('user', (u) => u.email === email, ['id', 'name'])],
    [
      /^UPDATE user SET (.+) WHERE id=(\d+)$/,
      (params, [, assignments, id]) => {
        const user = tables.user.find((u) => u.id === Number(id));
        for (const [, column, value] of assignments.matchAll(/(\w+)='([^']*)'/g)) {
          user[column] = value;
        }
        return { affectedRows: 1 };
      },
    ],

    [/^INSERT INTO userRole /, ([userId, role, objectId]) => insert('userRole', { userId, role, objectId })],
    [/^SELECT \* FROM userRole WHERE userId=\?$/, ([userId]) => select('userRole', (r) => r.userId === userId)],
    [/^SELECT objectId FROM userRole WHERE role='franchisee' AND userId=\?$/, ([userId]) => select('userRole', (r) => r.role === 'franchisee' && r.userId === userId, ['objectId'])],
    [/^DELETE FROM userRole WHERE objectId=\?$/, ([objectId]) => remove('userRole', (r) => r.objectId === objectId)],

    [/^INSERT INTO auth /, ([token, userId]) => (tables.auth.some((a) => a.token === token) ? { affectedRows: 0 } : insert('auth', { token, userId }))],
    [/^SELECT userId FROM auth WHERE token=\?$/, ([token]) => select('auth', (a) => a.token === token, ['userId'])],
    [/^DELETE FROM auth WHERE token=\?$/, ([token]) => remove('auth', (a) => a.token === token)],

    [/^INSERT INTO franchise /, ([name]) => insert('franchise', { name })],
    [
      /^SELECT id, name FROM franchise WHERE name LIKE \? LIMIT (\d+) OFFSET (\d+)$/,
      ([pattern], [, limit, offset]) => select('franchise', (f) => like(f.name, pattern), ['id', 'name']).slice(Number(offset), Number(offset) + Number(limit)),
    ],
    [
      /^SELECT id, name FROM franchise WHERE id in \((.*)\)$/,
      (params, [, ids]) => {
        const idList = ids.split(',').map(Number);
        return select('franchise', (f) => idList.includes(f.id), ['id', 'name']);
      },
    ],
    [/^DELETE FROM franchise WHERE id=\?$/, ([id]) => remove('franchise', (f) => f.id === id)],
    [
      /^SELECT u\.id, u\.name, u\.email FROM userRole AS ur JOIN user AS u/,
      ([franchiseId]) =>
        tables.userRole
          .filter((r) => r.role === 'franchisee' && r.objectId === franchiseId)
          .map((r) => tables.user.find((u) => u.id === r.userId))
          .map(({ id, name, email }) => ({ id, name, email })),
    ],

    [/^INSERT INTO store /, ([franchiseId, name]) => insert('store', { franchiseId, name })],
    [/^SELECT id, name FROM store WHERE franchiseId=\?$/, ([franchiseId]) => select('store', (s) => s.franchiseId === franchiseId, ['id', 'name'])],
    [/^SELECT s\.id, s\.name, COALESCE/, ([franchiseId]) => select('store', (s) => s.franchiseId === franchiseId).map((s) => ({ id: s.id, name: s.name, totalRevenue: storeRevenue(s.id) }))],
    [/^DELETE FROM store WHERE franchiseId=\? AND id=\?$/, ([franchiseId, id]) => remove('store', (s) => s.franchiseId === franchiseId && s.id === id)],
    [/^DELETE FROM store WHERE franchiseId=\?$/, ([franchiseId]) => remove('store', (s) => s.franchiseId === franchiseId)],

    [/^INSERT INTO dinerOrder /, ([dinerId, franchiseId, storeId]) => insert('dinerOrder', { dinerId, franchiseId, storeId, date: new Date().toISOString() })],
    [
      /^SELECT id, franchiseId, storeId, date FROM dinerOrder WHERE dinerId=\? LIMIT (\d+),(\d+)$/,
      ([dinerId], [, offset, count]) => select('dinerOrder', (o) => o.dinerId === dinerId, ['id', 'franchiseId', 'storeId', 'date']).slice(Number(offset), Number(offset) + Number(count)),
    ],
    [/^INSERT INTO orderItem /, ([orderId, menuId, description, price]) => insert('orderItem', { orderId, menuId, description, price })],
    [/^SELECT id, menuId, description, price FROM orderItem WHERE orderId=\?$/, ([orderId]) => select('orderItem', (i) => i.orderId === orderId, ['id', 'menuId', 'description', 'price'])],

    // DB.getID(connection, key, value, table)
    [/^SELECT id FROM (\w+) WHERE (\w+)=\?$/, ([value], [, table, key]) => select(table, (row) => row[key] == value, ['id'])],
  ];

  const connection = {
    // Only used for USE / CREATE statements during initialization.
    query: async () => [[], []],
    execute: async (sql, params = []) => {
      for (const [pattern, handler] of statements) {
        const match = sql.match(pattern);
        if (match) {
          return [handler(params, match), []];
        }
      }
      throw new Error(`mock mysql: unrecognized SQL: ${sql}`);
    },
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    end: () => {},
  };

  return { createConnection: async () => connection, tables };
}

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);
}

module.exports = { createMockMysql, mockBcrypt, expectValidJwt };
