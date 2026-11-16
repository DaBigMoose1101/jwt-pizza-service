const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const config = require('./config.js');

const MASK = '*****';
const FLUSH_INTERVAL_MS = 1000;
const MAX_BATCH_SIZE = 100;

// Values of these keys are always masked.
const SENSITIVE_KEY = /password|token|jwt|api_?key|authorization|secret|email/i;
// Confidential values that can appear inside any string (SQL, error messages, bodies).
const SENSITIVE_PATTERNS = [
  [/((?:password|email|name)\s*=\s*)'[^']*'/gi, `$1'${MASK}'`], // inline SQL values, e.g. UPDATE user SET email='...'
  [/eyJ[\w-]*\.[\w-]*\.[\w-]*/g, MASK], // JWTs
  [/(bearer\s+)\S+/gi, `$1${MASK}`], // bearer credentials
  [/[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+/g, MASK], // email addresses
];

// Holds the current request so DB and factory logs can name the request and authenticated user
// without the routers or database having to pass them along.
const requestContext = new AsyncLocalStorage();
const requestIds = new WeakMap();

function elapsedMs(start) {
  return Math.round(Number(process.hrtime.bigint() - start) / 1e4) / 100;
}

class Logger {
  constructor() {
    this.enabled = !!config.logging?.endpointUrl && process.env.NODE_ENV !== 'test';
    this.buffer = [];
    this.flushTimer = null;
    if (this.enabled) {
      this.handleProcessErrors();
    }
  }

  // Express middleware: logs every HTTP request/response and establishes the request context.
  httpLogger = (req, res, next) => {
    const start = process.hrtime.bigint();
    const requestId = randomUUID();
    requestIds.set(req, requestId);
    const send = res.send;
    res.send = (resBody) => {
      res.send = send;
      this.log(this.statusToLogLevel(res.statusCode), 'http', {
        requestId,
        userId: req.user?.id ?? null,
        authorized: !!req.headers.authorization,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: elapsedMs(start),
        reqBody: req.body,
        resBody: this.parseBody(resBody),
      });
      return res.send(resBody);
    };
    requestContext.run({ req, requestId }, next);
  };

  // Express error middleware: logs exceptions that reach the default error handler.
  errorLogger = (err, req, res, next) => {
    const statusCode = err.statusCode ?? 500;
    this.log(statusCode >= 500 ? 'error' : 'warn', 'exception', {
      requestId: requestIds.get(req) ?? null,
      userId: req.user?.id ?? null,
      method: req.method,
      path: req.originalUrl,
      statusCode,
      message: err.message,
      stack: err.stack,
    });
    next(err);
  };

  // Drop-in replacement for connection.execute(sql, params). Logs the SQL (never the params,
  // which carry password hashes and token signatures), its duration, and its outcome.
  dbExecute = async (connection, sql, params) => {
    if (!this.enabled) {
      return connection.execute(sql, params);
    }
    const start = process.hrtime.bigint();
    const logData = { requestId: this.currentRequestId(), userId: this.currentUserId(), sql };
    try {
      const result = await connection.execute(sql, params);
      this.log('info', 'db', { ...logData, durationMs: elapsedMs(start), ...this.resultSummary(result[0]) });
      return result;
    } catch (err) {
      this.log('error', 'db', { ...logData, durationMs: elapsedMs(start), error: err.message });
      throw err;
    }
  };

  // Drop-in replacement for fetch() when calling the pizza factory.
  factoryFetch = async (url, options = {}) => {
    if (!this.enabled) {
      return fetch(url, options);
    }
    const start = process.hrtime.bigint();
    const logData = {
      requestId: this.currentRequestId(),
      userId: this.currentUserId(),
      url,
      method: options.method ?? 'GET',
      reqBody: this.parseBody(options.body),
    };
    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      this.log('error', 'factory', { ...logData, durationMs: elapsedMs(start), error: err.message });
      throw err;
    }
    let resBody;
    try {
      resBody = this.parseBody(await res.clone().text());
    } catch {
      resBody = undefined;
    }
    this.log(res.ok ? 'info' : 'error', 'factory', { ...logData, statusCode: res.status, durationMs: elapsedMs(start), resBody });
    return res;
  };

  handleProcessErrors() {
    const logAndExit = (type) => (err) => {
      this.log('error', 'exception', { type, requestId: this.currentRequestId(), message: err?.message ?? String(err), stack: err?.stack });
      // Preserve Node's default crash behavior, but give the logs a moment to reach Grafana first.
      setTimeout(() => process.exit(1), 2000).unref();
      this.flush().finally(() => process.exit(1));
    };
    process.on('uncaughtException', logAndExit('uncaughtException'));
    process.on('unhandledRejection', logAndExit('unhandledRejection'));
  }

  // Buffers a log entry; entries are sent to Grafana in batches.
  log(level, type, logData) {
    if (!this.enabled) {
      return;
    }
    this.buffer.push({ labels: { component: config.logging.source, level, type }, value: [this.nowString(), this.sanitize(logData)] });
    if (this.buffer.length >= MAX_BATCH_SIZE) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
      this.flushTimer.unref();
    }
  }

  // Sends all buffered entries in one request, grouped into one Loki stream per label set.
  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.buffer.length === 0) {
      return Promise.resolve();
    }
    const streams = new Map();
    for (const { labels, value } of this.buffer) {
      const key = `${labels.level}|${labels.type}`;
      if (!streams.has(key)) {
        streams.set(key, { stream: labels, values: [] });
      }
      streams.get(key).values.push(value);
    }
    this.buffer = [];
    return this.sendLogToGrafana({ streams: [...streams.values()] });
  }

  currentRequestId() {
    return requestContext.getStore()?.requestId ?? null;
  }

  currentUserId() {
    return requestContext.getStore()?.req.user?.id ?? null;
  }

  resultSummary(rows) {
    return Array.isArray(rows) ? { rowCount: rows.length } : { affectedRows: rows?.affectedRows };
  }

  statusToLogLevel(statusCode) {
    if (statusCode >= 500) return 'error';
    if (statusCode >= 400) return 'warn';
    return 'info';
  }

  nowString() {
    return `${Date.now()}000000`;
  }

  parseBody(body) {
    if (typeof body === 'string') {
      try {
        return JSON.parse(body);
      } catch {
        return body;
      }
    }
    if (Buffer.isBuffer(body)) {
      return this.parseBody(body.toString());
    }
    return body;
  }

  // Serializes the log entry, masking confidential and personal fields and values.
  sanitize(logData) {
    return JSON.stringify(logData, function (key, value) {
      if (value === null || value === undefined) {
        return value;
      }
      // Mask secrets and emails, plus names on user-shaped objects (franchise/store names are kept).
      if (key && (SENSITIVE_KEY.test(key) || (key === 'name' && 'email' in this))) {
        return MASK;
      }
      if (typeof value === 'string') {
        return SENSITIVE_PATTERNS.reduce((s, [pattern, replacement]) => s.replace(pattern, replacement), value);
      }
      return value;
    });
  }

  sendLogToGrafana(event) {
    const { endpointUrl, accountId, apiKey } = config.logging;
    return fetch(endpointUrl, {
      method: 'POST',
      body: JSON.stringify(event),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accountId}:${apiKey}` },
    })
      .then((res) => {
        if (!res.ok) {
          console.error(`Failed to send logs to Grafana: HTTP ${res.status}`);
        }
      })
      .catch((err) => {
        console.error('Failed to send logs to Grafana:', err.message);
      });
  }
}

module.exports = new Logger();
