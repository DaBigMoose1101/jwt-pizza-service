const express = require('express');
const request = require('supertest');

jest.mock('../config.js', () => ({
  logging: { source: 'test-service', endpointUrl: 'http://logs.test', accountId: '1', apiKey: 'key' },
}));

const logger = require('../logger.js');

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.c2lnbmF0dXJl';

// Returns every log entry sent to Grafana as { labels, data }.
function sentLogs() {
  return global.fetch.mock.calls
    .filter(([url]) => url === 'http://logs.test')
    .map(([, options]) => {
      const stream = JSON.parse(options.body).streams[0];
      return { labels: stream.stream, timestamp: stream.values[0][0], data: JSON.parse(stream.values[0][1]) };
    });
}

function logsOfType(type) {
  return sentLogs().filter((l) => l.labels.type === type);
}

function testApp(user) {
  const app = express();
  app.use(express.json());
  app.use(logger.httpLogger);
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  app.post('/login', (req, res) => res.json({ user: { id: 1 }, token: JWT }));
  app.get('/db', (req, res) => {
    setImmediate(() => {
      logger.dbLogger('SELECT * FROM menu');
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
  logger.enabled = false;
  jest.restoreAllMocks();
});

test('is disabled under test by default and sends nothing', () => {
  logger.enabled = false;
  logger.dbLogger('SELECT 1');
  expect(global.fetch).not.toHaveBeenCalled();
});

test('sends Loki formatted entries with credentials', () => {
  logger.log('info', 'db', { sql: 'SELECT 1' });
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toBe('http://logs.test');
  expect(options.method).toBe('POST');
  expect(options.headers.Authorization).toBe('Bearer 1:key');
  const [log] = sentLogs();
  expect(log.labels).toEqual({ component: 'test-service', level: 'info', type: 'db' });
  expect(log.timestamp).toMatch(/^\d{19}$/);
  expect(log.data).toEqual({ sql: 'SELECT 1' });
});

test('sanitizes confidential keys and values', () => {
  const sanitized = JSON.parse(
    logger.sanitize({
      reqBody: { email: 'a@jwt.com', password: 'secret' },
      resBody: { token: JWT, nested: [{ apiKey: 'k', jwt: 'j' }] },
      header: `Bearer ${JWT}`,
      sql: "UPDATE user SET password='$2b$10$hash', email='a@jwt.com' WHERE id=1",
      note: `token is ${JWT}`,
      missing: { password: null },
    })
  );
  expect(sanitized.reqBody).toEqual({ email: 'a@jwt.com', password: '*****' });
  expect(sanitized.resBody).toEqual({ token: '*****', nested: [{ apiKey: '*****', jwt: '*****' }] });
  expect(sanitized.header).toBe('Bearer *****');
  expect(sanitized.sql).toBe("UPDATE user SET password='*****', email='a@jwt.com' WHERE id=1");
  expect(sanitized.note).toBe('token is *****');
  expect(sanitized.missing).toEqual({ password: null });
});

test('logs HTTP requests with sanitized bodies', async () => {
  await request(testApp(null)).post('/login').set('Authorization', `Bearer ${JWT}`).send({ email: 'a@jwt.com', password: 'admin' });
  const [log] = logsOfType('http');
  expect(log.labels.level).toBe('info');
  expect(log.data).toEqual({
    userId: null,
    authorized: true,
    method: 'POST',
    path: '/login',
    statusCode: 200,
    reqBody: { email: 'a@jwt.com', password: '*****' },
    resBody: { user: { id: 1 }, token: '*****' },
  });
});

test('logs DB queries with the authenticated user and non-JSON responses', async () => {
  await request(testApp({ id: 42 })).get('/db');
  expect(logsOfType('db')[0].data).toEqual({ userId: 42, sql: 'SELECT * FROM menu' });
  const [http] = logsOfType('http');
  expect(http.data).toMatchObject({ userId: 42, authorized: false, resBody: 'plain text' });
});

test('uses warn and error levels for failures and logs exceptions', async () => {
  const app = testApp({ id: 3 });
  await request(app).get('/missing');
  await request(app).get('/boom');
  expect(logsOfType('http').map((l) => l.labels.level)).toEqual(['warn', 'error']);
  const [exception] = logsOfType('exception');
  expect(exception.labels.level).toBe('error');
  expect(exception.data).toMatchObject({ userId: 3, method: 'GET', path: '/boom', statusCode: 500, message: 'kaboom' });
  expect(exception.data.stack).toContain('kaboom');
});

test('logs handled errors below 500 as warnings', () => {
  const next = jest.fn();
  const err = Object.assign(new Error('unknown user'), { statusCode: 404 });
  logger.errorLogger(err, { method: 'PUT', originalUrl: '/api/auth' }, {}, next);
  expect(next).toHaveBeenCalledWith(err);
  const [log] = logsOfType('exception');
  expect(log.labels.level).toBe('warn');
  expect(log.data.userId).toBeNull();
});

test('logs factory requests and returns the original response', async () => {
  const factoryRes = { ok: true, status: 200, clone: () => ({ text: async () => JSON.stringify({ jwt: JWT, reportUrl: 'http://report' }) }) };
  global.fetch.mockImplementation(async (url) => (url === 'http://factory' ? factoryRes : { ok: true }));
  const options = { method: 'POST', headers: { authorization: 'Bearer factory-key' }, body: JSON.stringify({ diner: { id: 1 }, order: { id: 5 } }) };

  const res = await logger.factoryFetch('http://factory', options);

  expect(res).toBe(factoryRes);
  expect(global.fetch).toHaveBeenCalledWith('http://factory', options);
  const [log] = logsOfType('factory');
  expect(log.labels.level).toBe('info');
  expect(log.data).toEqual({
    userId: null,
    url: 'http://factory',
    method: 'POST',
    reqBody: { diner: { id: 1 }, order: { id: 5 } },
    statusCode: 200,
    resBody: { jwt: '*****', reportUrl: 'http://report' },
  });
  expect(JSON.stringify(log)).not.toContain('factory-key');
});

test('logs failed factory responses without a readable body', async () => {
  global.fetch.mockImplementation(async (url) => (url === 'http://factory' ? { ok: false, status: 500 } : { ok: true }));
  await logger.factoryFetch('http://factory');
  const [log] = logsOfType('factory');
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
  expect(logsOfType('factory')[0].data.error).toBe('network down');
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
  await logger.log('info', 'db', {});
  global.fetch.mockRejectedValueOnce(new Error('offline'));
  await logger.log('info', 'db', {});
  expect(consoleError).toHaveBeenCalledWith('Failed to send log to Grafana: HTTP 401');
  expect(consoleError).toHaveBeenCalledWith('Failed to send log to Grafana:', 'offline');
});

test('logs process-level exceptions before exiting', async () => {
  const handlers = {};
  jest.spyOn(process, 'on').mockImplementation((event, handler) => (handlers[event] = handler));
  const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });

  try {
    logger.handleProcessErrors();
    handlers.uncaughtException(new Error('crash'));
    handlers.unhandledRejection('rejected');
    await new Promise(setImmediate);
    expect(exit).toHaveBeenCalledWith(1);

    // The fallback timer exits even if the log never reaches Grafana.
    exit.mockClear();
    jest.runAllTimers();
    expect(exit).toHaveBeenCalledWith(1);
  } finally {
    jest.useRealTimers();
  }

  const logs = logsOfType('exception').map((l) => l.data);
  expect(logs[0]).toMatchObject({ type: 'uncaughtException', message: 'crash' });
  expect(logs[1]).toMatchObject({ type: 'unhandledRejection', message: 'rejected' });
});
