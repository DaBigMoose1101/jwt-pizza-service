const { AsyncLocalStorage } = require('node:async_hooks');
const config = require('./config.js');

const MASK = '*****';
const SENSITIVE_KEY = /password|token|jwt|api_?key|authorization|secret/i;
const SENSITIVE_PATTERNS = [
  [/(password\s*=\s*)'[^']*'/gi, `$1'${MASK}'`], // inline SQL values, e.g. UPDATE user SET password='...'
  [/eyJ[\w-]*\.[\w-]*\.[\w-]*/g, MASK], // JWTs
  [/(bearer\s+)\S+/gi, `$1${MASK}`], // bearer credentials
];

// Holds the current express request so DB and factory logs can name the authenticated user
// without the routers or database having to pass it along.
const requestContext = new AsyncLocalStorage();

class Logger {
  constructor() {
    this.enabled = !!config.logging?.endpointUrl && process.env.NODE_ENV !== 'test';
    if (this.enabled) {
      this.handleProcessErrors();
    }
  }

  // Express middleware: logs every HTTP request/response and establishes the request context.
  httpLogger = (req, res, next) => {
    const send = res.send;
    res.send = (resBody) => {
      res.send = send;
      this.log(this.statusToLogLevel(res.statusCode), 'http', {
        userId: req.user?.id ?? null,
        authorized: !!req.headers.authorization,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        reqBody: req.body,
        resBody: this.parseBody(resBody),
      });
      return res.send(resBody);
    };
    requestContext.run({ req }, next);
  };

  // Express error middleware: logs exceptions that reach the default error handler.
  errorLogger = (err, req, res, next) => {
    const statusCode = err.statusCode ?? 500;
    this.log(statusCode >= 500 ? 'error' : 'warn', 'exception', {
      userId: req.user?.id ?? null,
      method: req.method,
      path: req.originalUrl,
      statusCode,
      message: err.message,
      stack: err.stack,
    });
    next(err);
  };

  dbLogger(sql) {
    this.log('info', 'db', { userId: this.currentUserId(), sql });
  }

  // Drop-in replacement for fetch() when calling the pizza factory.
  factoryFetch = async (url, options = {}) => {
    if (!this.enabled) {
      return fetch(url, options);
    }
    const logData = { userId: this.currentUserId(), url, method: options.method ?? 'GET', reqBody: this.parseBody(options.body) };
    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      this.log('error', 'factory', { ...logData, error: err.message });
      throw err;
    }
    let resBody;
    try {
      resBody = this.parseBody(await res.clone().text());
    } catch {
      resBody = undefined;
    }
    this.log(res.ok ? 'info' : 'error', 'factory', { ...logData, statusCode: res.status, resBody });
    return res;
  };

  handleProcessErrors() {
    const logAndExit = (type) => (err) => {
      const sent = this.log('error', 'exception', { type, message: err?.message ?? String(err), stack: err?.stack });
      // Preserve Node's default crash behavior, but give the log a moment to reach Grafana first.
      setTimeout(() => process.exit(1), 2000).unref();
      Promise.resolve(sent).finally(() => process.exit(1));
    };
    process.on('uncaughtException', logAndExit('uncaughtException'));
    process.on('unhandledRejection', logAndExit('unhandledRejection'));
  }

  log(level, type, logData) {
    if (!this.enabled) {
      return;
    }
    const labels = { component: config.logging.source, level, type };
    const values = [this.nowString(), this.sanitize(logData)];
    return this.sendLogToGrafana({ streams: [{ stream: labels, values: [values] }] });
  }

  currentUserId() {
    return requestContext.getStore()?.req.user?.id ?? null;
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

  // Serializes the log entry, masking confidential fields and values.
  sanitize(logData) {
    return JSON.stringify(logData, (key, value) => {
      if (key && SENSITIVE_KEY.test(key) && value !== null && value !== undefined) {
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
          console.error(`Failed to send log to Grafana: HTTP ${res.status}`);
        }
      })
      .catch((err) => {
        console.error('Failed to send log to Grafana:', err.message);
      });
  }
}

module.exports = new Logger();
