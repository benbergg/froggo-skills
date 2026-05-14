'use strict';
// Minimal HTTP server imitating the Zentao v1 REST surface needed by
// collect.js. Routes are matched by (method + pathname + sorted query).
// Per-route injection (status / delay / body override) lets a single
// scenario reproduce 503-retry, partial-failure, oversize, etc., without
// authoring a parallel set of fixture files.
//
// Used by tests/e2e/run-e2e-tests.js. Not used in production.

const http = require('node:http');

// Canonicalize query string so ?a=1&b=2 and ?b=2&a=1 hash identically.
function normalizeQuery(searchParams) {
  const parts = [];
  const keys = [...searchParams.keys()].sort();
  for (const k of keys) {
    const vals = searchParams.getAll(k).slice().sort();
    for (const v of vals) parts.push(`${k}=${v}`);
  }
  return parts.join('&');
}

function routeKey(method, pathname, query) {
  return query ? `${method} ${pathname}?${query}` : `${method} ${pathname}`;
}

// scenario = {
//   routes:  Map<key, body | (req) => body>     200 OK
//   inject:  Map<key, { status?, delay?, body? }> per-route override
//   delayMs: number                             baseline latency for all routes
// }
function startMockServer(scenario = {}) {
  const calls = [];
  const routes = scenario.routes || {};
  const inject = scenario.inject || {};
  const baselineDelay = scenario.delayMs || 0;

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://placeholder');
    const q = normalizeQuery(u.searchParams);
    const key = routeKey(req.method, u.pathname, q);
    calls.push(key);

    const inj = inject[key];
    if (inj && inj.delay) await sleep(inj.delay);
    else if (baselineDelay) await sleep(baselineDelay);

    if (inj && inj.status) {
      res.statusCode = inj.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(typeof inj.body === 'string' ? inj.body : JSON.stringify(inj.body || { error: `injected ${inj.status}` }));
      return;
    }

    const body = routes[key];
    if (body === undefined) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'no fixture for route', key }));
      return;
    }

    const payload = typeof body === 'function' ? body(req) : body;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
    server.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { startMockServer, routeKey, normalizeQuery };
