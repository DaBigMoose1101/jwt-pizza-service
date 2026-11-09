const EventEmitter = require('events');

jest.mock('../config.js', () => ({
  metrics: { source: 'test', endpointUrl: 'http://metrics.test', accountId: '1', apiKey: 'key' },
}));

const metrics = require('../metrics.js');

function fakeRequest(req, statusCode, ...middlewares) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  const next = jest.fn();
  middlewares.forEach((middleware) => middleware(req, res, next));
  res.emit('finish');
  return next;
}

function sentMetric(body, name, attributes = {}) {
  const all = body.resourceMetrics[0].scopeMetrics[0].metrics;
  return all.find((m) => {
    if (m.name !== name) return false;
    const point = (m.sum ?? m.gauge).dataPoints[0];
    return Object.entries(attributes).every(([key, value]) => point.attributes.some((a) => a.key === key && a.value.stringValue === value));
  });
}

function value(metric) {
  const point = (metric.sum ?? metric.gauge).dataPoints[0];
  return point.asInt ?? point.asDouble;
}

let timer;

beforeEach(() => {
  jest.useFakeTimers();
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
});

afterEach(() => {
  clearInterval(timer);
  jest.useRealTimers();
});

test('records requests, auth, pizzas and sends them to Grafana', () => {
  const user = { id: 7 };
  const { requestTracker, authTracker, pizzaTracker } = metrics;

  expect(fakeRequest({ method: 'GET', path: '/menu' }, 200, requestTracker, pizzaTracker)).toHaveBeenCalledTimes(2);
  fakeRequest({ method: 'PUT', path: '/' }, 200, requestTracker, authTracker);
  fakeRequest({ method: 'PUT', path: '/' }, 404, requestTracker, authTracker);
  fakeRequest({ method: 'POST', path: '/', user, body: { items: [{ price: 0.05 }, { price: 0.01 }] } }, 200, requestTracker, pizzaTracker);
  fakeRequest({ method: 'POST', path: '/', user, body: { items: [{ price: 0.05 }] } }, 500, requestTracker, pizzaTracker);

  timer = metrics.sendMetricsPeriodically(1000);
  jest.advanceTimersByTime(1000);

  expect(global.fetch).toHaveBeenCalledTimes(1);
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toBe('http://metrics.test');
  expect(options.headers.Authorization).toBe('Bearer 1:key');
  const body = JSON.parse(options.body);

  expect(value(sentMetric(body, 'http_requests', { method: 'total' }))).toBe(5);
  expect(value(sentMetric(body, 'http_requests', { method: 'GET' }))).toBe(1);
  expect(value(sentMetric(body, 'http_requests', { method: 'PUT' }))).toBe(2);
  expect(value(sentMetric(body, 'http_requests', { method: 'POST' }))).toBe(2);
  expect(value(sentMetric(body, 'auth_attempts', { status: 'success' }))).toBe(1);
  expect(value(sentMetric(body, 'auth_attempts', { status: 'failure' }))).toBe(1);
  expect(value(sentMetric(body, 'active_users'))).toBe(1);
  expect(value(sentMetric(body, 'pizzas_sold'))).toBe(2);
  expect(value(sentMetric(body, 'pizza_creation_failures'))).toBe(1);
  expect(value(sentMetric(body, 'revenue'))).toBeCloseTo(0.06);
  expect(value(sentMetric(body, 'latency', { type: 'service' }))).toBeGreaterThanOrEqual(0);
  expect(value(sentMetric(body, 'latency', { type: 'pizza' }))).toBeGreaterThanOrEqual(0);
  expect(typeof value(sentMetric(body, 'cpu_usage'))).toBe('number');
  expect(typeof value(sentMetric(body, 'memory_usage'))).toBe('number');
  expect(sentMetric(body, 'http_requests', { source: 'test' })).toBeDefined();
  expect(body.resourceMetrics[0].scopeMetrics[0].metrics.find((m) => m.name === 'pizzas_sold').sum.isMonotonic).toBe(true);

  // Logging out removes the user from the active user count, and latency resets each window.
  fakeRequest({ method: 'DELETE', path: '/', user }, 200, requestTracker, authTracker);
  jest.advanceTimersByTime(1000);
  const secondBody = JSON.parse(global.fetch.mock.calls[1][1].body);
  expect(value(sentMetric(secondBody, 'active_users'))).toBe(0);
  expect(value(sentMetric(secondBody, 'latency', { type: 'pizza' }))).toBe(0);
});

test('active users expire after five minutes of inactivity', () => {
  const res = new EventEmitter();
  res.statusCode = 200;
  metrics.requestTracker({ method: 'GET', user: { id: 42 } }, res, jest.fn());
  res.emit('finish');

  timer = metrics.sendMetricsPeriodically(6 * 60 * 1000);
  jest.advanceTimersByTime(6 * 60 * 1000);

  const body = JSON.parse(global.fetch.mock.calls[0][1].body);
  expect(value(sentMetric(body, 'active_users'))).toBe(0);
});

test('logs errors when Grafana rejects the metrics', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

  timer = metrics.sendMetricsPeriodically(1000);
  jest.advanceTimersByTime(1000);
  await jest.runAllTicks();
  await Promise.resolve();
  await Promise.resolve();

  expect(consoleError).toHaveBeenCalledWith('Error pushing metrics:', expect.any(Error));
  consoleError.mockRestore();
});

test('logs errors thrown while sending metrics', () => {
  global.fetch = jest.fn(() => {
    throw new Error('network down');
  });
  const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});

  timer = metrics.sendMetricsPeriodically(1000);
  jest.advanceTimersByTime(1000);

  expect(consoleLog).toHaveBeenCalledWith('Error sending metrics', expect.any(Error));
  consoleLog.mockRestore();
});
