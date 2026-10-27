import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { BudgetError, HaltError, createBudget, createClient } from '../lib/client.mjs';
import { SafetyError } from '../lib/safety.mjs';

const TOKEN = `ghu_${'q'.repeat(36)}`;
let server;
let origin;
let hits;

before(async () => {
  server = http.createServer((req, res) => {
    hits.push({ path: req.url, auth: req.headers.authorization ?? null });
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/landing' });
      return res.end();
    }
    if (req.url === '/unauthorized') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"message":"Bad credentials"}');
    }
    if (req.url === '/limited') {
      res.writeHead(403, { 'x-ratelimit-remaining': '0', 'retry-after': '60' });
      return res.end('{}');
    }
    if (req.url === '/boom') {
      res.writeHead(500);
      return res.end('{}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const make = (overrides = {}) => {
  hits = [];
  return createClient({
    token: TOKEN,
    origin,
    allowedOrigins: [origin],
    budget: createBudget(20),
    delayMs: 0,
    ...overrides,
  });
};

describe('client', () => {
  it('sends the token only as a Bearer header and parses JSON', async () => {
    const client = make();
    const res = await client.get('/ok');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    assert.equal(hits[0].auth, `Bearer ${TOKEN}`);
    assert.equal('text' in res, false);
  });

  it('never follows redirects', async () => {
    const client = make();
    const res = await client.get('/redirect');
    assert.equal(res.status, 302);
    assert.deepEqual(
      hits.map((h) => h.path),
      ['/redirect'],
    );
  });

  it('halts permanently after a 401 and sends nothing further', async () => {
    const client = make();
    const res = await client.get('/unauthorized');
    assert.equal(res.status, 401);
    await assert.rejects(client.get('/ok'), HaltError);
    assert.equal(hits.length, 1);
    assert.match(client.haltReason, /401/);
  });

  it('halts on a rate-limit response', async () => {
    const client = make();
    await client.get('/limited');
    await assert.rejects(client.get('/ok'), HaltError);
  });

  it('does not retry server errors', async () => {
    const client = make();
    const res = await client.get('/boom');
    assert.equal(res.status, 500);
    assert.equal(hits.length, 1);
  });

  it('enforces the request budget across clients', async () => {
    hits = [];
    const budget = createBudget(2);
    const options = { origin, allowedOrigins: [origin], budget, delayMs: 0 };
    const a = createClient({ ...options, token: TOKEN });
    const b = createClient({ ...options, token: null });
    await a.get('/ok');
    await b.get('/ok');
    await assert.rejects(a.get('/ok'), BudgetError);
    assert.equal(hits.length, 2);
  });

  it('rejects forbidden requests before touching the network', async () => {
    const client = make();
    await assert.rejects(client.options('/ok'), SafetyError); // OPTIONS with credentials
    await assert.rejects(client.get('//evil.example/x'), SafetyError);
    await assert.rejects(
      client.get('/ok', { headers: { Authorization: 'Bearer other' } }),
      SafetyError,
    );
    await assert.rejects(client.graphql('mutation { x }'), SafetyError);
    assert.equal(hits.length, 0);
  });

  it('refuses origins that are not allow-listed', async () => {
    hits = [];
    const client = createClient({
      token: TOKEN,
      origin,
      allowedOrigins: ['https://api.github.com'],
      budget: createBudget(5),
      delayMs: 0,
    });
    await assert.rejects(client.get('/ok'), SafetyError);
    assert.equal(hits.length, 0);
  });
});
