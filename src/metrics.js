const config = require('./config');

const os = require('os');

const metricsConfig = config.metrics ?? {};
const ACTIVE_USER_WINDOW_MS = 5 * 60 * 1000;

// Metrics stored in memory
const httpRequests = { total: 0, GET: 0, PUT: 0, POST: 0, DELETE: 0 };
const authAttempts = { success: 0, failure: 0 };
const pizzas = { sold: 0, creationFailures: 0, revenue: 0 };
const activeUsers = new Map(); // userId -> last seen (ms)
const latency = { service: { sum: 0, count: 0 }, pizza: { sum: 0, count: 0 } };

function getCpuUsagePercentage() {
  const cpuUsage = os.loadavg()[0] / os.cpus().length;
  return Number((cpuUsage * 100).toFixed(2));
}

function getMemoryUsagePercentage() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const memoryUsage = (usedMemory / totalMemory) * 100;
  return Number(memoryUsage.toFixed(2));
}

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function isSuccess(res) {
  return res.statusCode >= 200 && res.statusCode < 300;
}

function recordLatency(type, ms) {
  latency[type].sum += ms;
  latency[type].count++;
}

// Middleware to track every request: method counts, latency, and active users
function requestTracker(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    httpRequests.total++;
    if (req.method in httpRequests) {
      httpRequests[req.method]++;
    }
    recordLatency('service', elapsedMs(start));
    // req.user is populated by setAuthUser later in the chain, so read it here at finish time.
    if (req.user) {
      activeUsers.set(req.user.id, Date.now());
    }
  });
  next();
}

// Middleware for the auth router: login/register outcomes and logout
function authTracker(req, res, next) {
  res.on('finish', () => {
    if (req.method === 'PUT' || req.method === 'POST') {
      authAttempts[isSuccess(res) ? 'success' : 'failure']++;
    } else if (req.method === 'DELETE' && isSuccess(res) && req.user) {
      // Runs after requestTracker's finish listener, so the user stays removed.
      activeUsers.delete(req.user.id);
    }
  });
  next();
}

// Middleware for the order router: pizza sales, revenue, failures, and creation latency
function pizzaTracker(req, res, next) {
  if (req.method !== 'POST' || req.path !== '/') {
    return next();
  }
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    recordLatency('pizza', elapsedMs(start));
    if (isSuccess(res)) {
      const items = req.body?.items ?? [];
      pizzas.sold += items.length;
      pizzas.revenue += items.reduce((total, item) => total + Number(item.price || 0), 0);
    } else {
      pizzas.creationFailures++;
    }
  });
  next();
}

function getActiveUserCount() {
  const cutoff = Date.now() - ACTIVE_USER_WINDOW_MS;
  for (const [userId, lastSeen] of activeUsers) {
    if (lastSeen < cutoff) {
      activeUsers.delete(userId);
    }
  }
  return activeUsers.size;
}

// Average latency over the reporting window, then reset the window
function takeAverageLatency(type) {
  const { sum, count } = latency[type];
  latency[type] = { sum: 0, count: 0 };
  return count ? sum / count : 0;
}

function buildMetrics() {
  const metrics = [];

  Object.keys(httpRequests).forEach((method) => {
    metrics.push(createMetric('http_requests', httpRequests[method], '1', 'sum', 'asInt', { method }));
  });

  Object.keys(authAttempts).forEach((status) => {
    metrics.push(createMetric('auth_attempts', authAttempts[status], '1', 'sum', 'asInt', { status }));
  });

  metrics.push(createMetric('active_users', getActiveUserCount(), '1', 'gauge', 'asInt', {}));

  metrics.push(createMetric('cpu_usage', getCpuUsagePercentage(), '%', 'gauge', 'asDouble', {}));
  metrics.push(createMetric('memory_usage', getMemoryUsagePercentage(), '%', 'gauge', 'asDouble', {}));

  metrics.push(createMetric('pizzas_sold', pizzas.sold, '1', 'sum', 'asInt', {}));
  metrics.push(createMetric('pizza_creation_failures', pizzas.creationFailures, '1', 'sum', 'asInt', {}));
  metrics.push(createMetric('revenue', pizzas.revenue, 'BTC', 'sum', 'asDouble', {}));

  metrics.push(createMetric('latency', takeAverageLatency('service'), 'ms', 'gauge', 'asDouble', { type: 'service' }));
  metrics.push(createMetric('latency', takeAverageLatency('pizza'), 'ms', 'gauge', 'asDouble', { type: 'pizza' }));

  return metrics;
}

// Periodically send metrics to Grafana
function sendMetricsPeriodically(period) {
  const timer = setInterval(() => {
    try {
      sendMetricToGrafana(buildMetrics());
    } catch (error) {
      console.log('Error sending metrics', error);
    }
  }, period);
  timer.unref();
  return timer;
}

function createMetric(metricName, metricValue, metricUnit, metricType, valueType, attributes) {
  attributes = { ...attributes, source: metricsConfig.source };

  const metric = {
    name: metricName,
    unit: metricUnit,
    [metricType]: {
      dataPoints: [
        {
          [valueType]: metricValue,
          timeUnixNano: Date.now() * 1000000,
          attributes: [],
        },
      ],
    },
  };

  Object.keys(attributes).forEach((key) => {
    metric[metricType].dataPoints[0].attributes.push({
      key: key,
      value: { stringValue: attributes[key] },
    });
  });

  if (metricType === 'sum') {
    metric[metricType].aggregationTemporality = 'AGGREGATION_TEMPORALITY_CUMULATIVE';
    metric[metricType].isMonotonic = true;
  }

  return metric;
}

function sendMetricToGrafana(metrics) {
  const body = {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics,
          },
        ],
      },
    ],
  };

  fetch(`${metricsConfig.endpointUrl}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${metricsConfig.accountId}:${metricsConfig.apiKey}`, 'Content-Type': 'application/json' },
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP status: ${response.status}`);
      }
    })
    .catch((error) => {
      console.error('Error pushing metrics:', error);
    });
}

module.exports = { requestTracker, authTracker, pizzaTracker, sendMetricsPeriodically };
