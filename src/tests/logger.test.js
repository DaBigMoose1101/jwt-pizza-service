const express = require('express');
const request = require('supertest');

jest.mock('../config.js', () => ({
  logging: { source: 'test-service', endpointUrl: 'http://logs.test', accountId: '1', apiKey: 'key' },
}));

const logger = require('../logger.js');

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.c2lnbmF0dXJl';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function grafanaCalls() {
  return global.fetch.mock.calls.filter(([url]) => url === 'http://logs.test');
}

// Flushes the logger and returns every entry sent to Grafana as { labels, timestamp, data }.
async function sentLogs() {
  await logger.flush();
  return grafanaCalls().flatMap(([, options]) =>
    JSON.parse(options.body).streams.flatMap((stream) => stream.values.map(([timestamp, line]) => ({ labels: stream.stream, timestamp, data: JSON.parse(line) })))
  );
}

async function logsOfType(type) {
  return (await sentLogs()).filter((l) => l.labels.type === type);
}

function fakeConnection(result) {
  return { execute: jest.fn(async () => (result instanceof Error ? Promise.reject(result) : [result, []])) };
}

function testApp(user) {
  const app = express();
  app.use(express.json());
  app.use(logger.httpLogger);
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  app.post('/login', (req, res) => res.json({ user: { id: 1, name: 'pizza diner', email: 'd@jwt.com' }, token: JWT }));
  app.get('/db', (req, res) => {
    setImmediate(async () => {
      await logger.dbExecute(fakeConnection([{ id: 1 }, { id: 2 }]), 'SELECT * FROM menu', []);
      res.send('plain text');
    });
  });
  app.get('/missing', (req, res) => res.status(404).send({ message: 'unknown' }));
  app.get('/boom', () => {
    throw new Error('kaboom');
  });
  app.use(logger.errorLogger);
  app.use((err, req, res, next) => {
    res.status(err.statusCode ?? 500).json({ message: err.message });
    next();
  });
  return app;
}

beforeEach(() => {
  logger.enabled = true;
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
});

afterEach(() => {
  clearTimeout(logger.flushTimer);
  logger.flushTimer = null;
  logger.buffer = [];
  logger.enabled = false;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('is disabled under test by default and sends nothing', async () => {
  logger.enabled = false;
  logger.log('info', 'db', { sql: 'SELECT 1' });
  await logger.flush();
  expect(global.fetch).not.toHaveBeenCalled();
});

test('sends Loki formatted entries with credentials', async () => {
  logger.log('info', 'db', { sql: 'SELECT 1' });
  const [log] = await sentLogs();
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toBe('http://logs.test');
  expect(options.method).toBe('POST');
  expect(options.headers.Authorization).toBe('Bearer 1:key');
  expect(log.labels).toEqual({ component: 'test-service', level: 'info', type: 'db' });
  expect(log.timestamp).toMatch(/^\d{19}$/);
  expect(log.data).toEqual({ sql: 'SELECT 1' });
});

test('batches entries into one request grouped by labels', async () => {
  logger.log('info', 'db', { n: 1 });
  logger.log('warn', 'http', { n: 2 });
  logger.log('info', 'db', { n: 3 });
  expect(global.fetch).not.toHaveBeenCalled();
  await logger.flush();

  expect(grafanaCalls()).toHaveLength(1);
  const { streams } = JSON.parse(grafanaCalls()[0][1].body);
  expect(streams).toHaveLength(2);
  expect(streams[0].stream.type).toBe('db');
  expect(streams[0].values.map(([, line]) => JSON.parse(line).n)).toEqual([1, 3]);
  expect(streams[1].stream).toMatchObject({ level: 'warn', type: 'http' });
});

test('flushes on a timer and when the batch is full', async () => {
  jest.useFakeTimers();
  logger.log('info', 'db', {});
  logger.log('info', 'db', {});
  expect(global.fetch).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1000);
  expect(grafanaCalls()).toHaveLength(1);

  for (let i = 0; i < 100; i++) {
    logger.log('info', 'db', { i });
  }
  expect(grafanaCalls()).toHaveLength(2);
  expect(logger.buffer).toHaveLength(0);
  await logger.flush();
  expect(grafanaCalls()).toHaveLength(2);
});

test('sanitizes secrets and personal data', () => {
  const sanitized = JSON.parse(
    logger.sanitize({
      reqBody: { name: 'pizza diner', email: 'a@jwt.com', password: 'secret' },
      resBody: { token: JWT, nested: [{ apiKey: 'k', jwt: 'j' }] },
      franchise: { name: 'pizzaPocket', admins: [{ id: 3, name: 'franchisee', email: 'f@jwt.com' }] },
      header: `Bearer ${JWT}`,
      sql: "UPDATE user SET password='$2b$10$hash', email='a@jwt.com', name='pizza diner' WHERE id=1",
      message: 'unknown user for franchise admin f@jwt.com provided',
      note: `token is ${JWT}`,
      missing: { password: null },
    })
  );
  expect(sanitized.reqBody).toEqual({ name: '*****', email: '*****', password: '*****' });
  expect(sanitized.resBody).toEqual({ token: '*****', nested: [{ apiKey: '*****', jwt: '*****' }] });
  expect(sanitized.franchise).toEqual({ name: 'pizzaPocket', admins: [{ id: 3, name: '*****', email: '*****' }] });
  expect(sanitized.header).toBe('Bearer *****');
  expect(sanitized.sql).toBe("UPDATE user SET password='*****', email='*****', name='*****' WHERE id=1");
  expect(sanitized.message).toBe('unknown user for franchise admin ***** provided');
  expect(sanitized.note).toBe('token is *****');
  expect(sanitized.missing).toEqual({ password: null });
});

test('logs HTTP requests with timing and sanitized bodies', async () => {
  await request(testApp(null)).post('/login').set('Authorization', `Bearer ${JWT}`).send({ email: 'a@jwt.com', password: 'admin' });
  const [log] = await logsOfType('http');
  expect(log.labels.level).toBe('info');
  expect(log.data.requestId).toMatch(UUID);
  expect(log.data.durationMs).toBeGreaterThanOrEqual(0);
  expect(log.data).toMatchObject({
    userId: null,
    authorized: true,
    method: 'POST',
    path: '/login',
    statusCode: 200,
    reqBody: { email: '*****', password: '*****' },
    resBody: { user: { id: 1, name: '*****', email: '*****' }, token: '*****' },
  });
});

test('correlates DB queries with their HTTP request and user', async () => {
  const app = testApp({ id: 42 });
  await Promise.all([request(app).get('/db'), request(app).get('/db')]);
  const db = await logsOfType('db');
  const http = await logsOfType('http');
  expect(db).toHaveLength(2);
  expect(new Set(http.map((l) => l.data.requestId)).size).toBe(2);
  expect(db.map((l) => l.data.requestId).sort()).toEqual(http.map((l) => l.data.requestId).sort());
  expect(db[0].data).toMatchObject({ userId: 42, sql: 'SELECT * FROM menu', rowCount: 2 });
  expect(http[0].data).toMatchObject({ userId: 42, authorized: false, resBody: 'plain text' });
});

test('logs DB writes and failed queries', async () => {
  const result = await logger.dbExecute(fakeConnection({ affectedRows: 3 }), 'DELETE FROM store WHERE id=?', [1]);
  expect(result[0]).toEqual({ affectedRows: 3 });
  const duplicate = new Error("Duplicate entry 'a@jwt.com' for key 'user.email'");
  await expect(logger.dbExecute(fakeConnection(duplicate), 'INSERT INTO user (email) VALUES (?)', ['a@jwt.com'])).rejects.toBe(duplicate);

  const [write, failure] = await logsOfType('db');
  expect(write.labels.level).toBe('info');
  expect(write.data).toMatchObject({ requestId: null, userId: null, sql: 'DELETE FROM store WHERE id=?', affectedRows: 3 });
  expect(failure.labels.level).toBe('error');
  expect(failure.data.error).toBe("Duplicate entry '*****' for key 'user.email'");
  expect(JSON.stringify(failure)).not.toContain('a@jwt.com');
});

test('dbExecute passes straight through when disabled', async () => {
  logger.enabled = false;
  const connection = fakeConnection([{ id: 1 }]);
  expect(await logger.dbExecute(connection, 'SELECT 1', [])).toEqual([[{ id: 1 }], []]);
  expect(connection.execute).toHaveBeenCalledWith('SELECT 1', []);
});

test('uses warn and error levels for failures and logs exceptions', async () => {
  const app = testApp({ id: 3 });
  await request(app).get('/missing');
  await request(app).get('/boom');
  const logs = await sentLogs();
  const http = logs.filter((l) => l.labels.type === 'http');
  const [exception] = logs.filter((l) => l.labels.type === 'exception');
  expect(http.map((l) => l.labels.level)).toEqual(['warn', 'error']);
  expect(exception.labels.level).toBe('error');
  expect(exception.data).toMatchObject({ userId: 3, method: 'GET', path: '/boom', statusCode: 500, message: 'kaboom', requestId: http[1].data.requestId });
  expect(exception.data.stack).toContain('kaboom');
});

test('logs handled errors below 500 as warnings', async () => {
  const next = jest.fn();
  const err = Object.assign(new Error('unknown user'), { statusCode: 404 });
  logger.errorLogger(err, { method: 'PUT', originalUrl: '/api/auth' }, {}, next);
  expect(next).toHaveBeenCalledWith(err);
  const [log] = await logsOfType('exception');
  expect(log.labels.level).toBe('warn');
  expect(log.data).toMatchObject({ userId: null, requestId: null });
});

test('logs factory requests and returns the original response', async () => {
  const factoryRes = { ok: true, status: 200, clone: () => ({ text: async () => JSON.stringify({ jwt: JWT, reportUrl: 'http://report' }) }) };
  global.fetch.mockImplementation(async (url) => (url === 'http://factory' ? factoryRes : { ok: true }));
  const diner = { id: 1, name: 'pizza diner', email: 'd@jwt.com' };
  const options = { method: 'POST', headers: { authorization: 'Bearer factory-key' }, body: JSON.stringify({ diner, order: { id: 5 } }) };

  const res = await logger.factoryFetch('http://factory', options);

  expect(res).toBe(factoryRes);
  expect(global.fetch).toHaveBeenCalledWith('http://factory', options);
  const [log] = await logsOfType('factory');
  expect(log.labels.level).toBe('info');
  expect(log.data).toMatchObject({
    requestId: null,
    userId: null,
    url: 'http://factory',
    method: 'POST',
    reqBody: { diner: { id: 1, name: '*****', email: '*****' }, order: { id: 5 } },
    statusCode: 200,
    resBody: { jwt: '*****', reportUrl: 'http://report' },
  });
  expect(log.data.durationMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(log)).not.toContain('factory-key');
});

test('logs failed factory responses without a readable body', async () => {
  global.fetch.mockImplementation(async (url) => (url === 'http://factory' ? { ok: false, status: 500 } : { ok: true }));
  await logger.factoryFetch('http://factory');
  const [log] = await logsOfType('factory');
  expect(log.labels.level).toBe('error');
  expect(log.data).toMatchObject({ method: 'GET', statusCode: 500 });
  expect(log.data).not.toHaveProperty('resBody');
});

test('logs and rethrows factory network errors', async () => {
  global.fetch.mockImplementation(async (url) => {
    if (url === 'http://factory') throw new Error('network down');
    return { ok: true };
  });
  await expect(logger.factoryFetch('http://factory', { method: 'POST' })).rejects.toThrow('network down');
  expect((await logsOfType('factory'))[0].data.error).toBe('network down');
});

test('factoryFetch passes straight through when disabled', async () => {
  logger.enabled = false;
  const factoryRes = { ok: true };
  global.fetch.mockResolvedValue(factoryRes);
  expect(await logger.factoryFetch('http://factory', { method: 'POST' })).toBe(factoryRes);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('reports Grafana failures without throwing', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  global.fetch.mockResolvedValueOnce({ ok: false, status: 401 });
  logger.log('info', 'db', {});
  await logger.flush();
  global.fetch.mockRejectedValueOnce(new Error('offline'));
  logger.log('info', 'db', {});
  await logger.flush();
  expect(consoleError).toHaveBeenCalledWith('Failed to send logs to Grafana: HTTP 401');
  expect(consoleError).toHaveBeenCalledWith('Failed to send logs to Grafana:', 'offline');
});

test('flushes process-level exceptions before exiting', async () => {
  const handlers = {};
  jest.spyOn(process, 'on').mockImplementation((event, handler) => (handlers[event] = handler));
  const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });

  logger.handleProcessErrors();
  handlers.uncaughtException(new Error('crash'));
  handlers.unhandledRejection('rejected');
  expect(grafanaCalls()).toHaveLength(2);
  await new Promise(setImmediate);
  expect(exit).toHaveBeenCalledWith(1);

  // The fallback timer exits even if the logs never reach Grafana.
  exit.mockClear();
  jest.runAllTimers();
  expect(exit).toHaveBeenCalledWith(1);

  const logs = (await sentLogs()).map((l) => l.data);
  expect(logs[0]).toMatchObject({ type: 'uncaughtException', message: 'crash' });
  expect(logs[1]).toMatchObject({ type: 'unhandledRejection', message: 'rejected' });
});
