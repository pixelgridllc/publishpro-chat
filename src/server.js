// Minimal, dependency-free HTTP server:
//   POST /api/chat     -> streams a reply as Server-Sent Events
//   POST /api/handoff  -> forwards a "talk to the team" request
//   GET  /api/health
//   GET  /widget.js    -> the embeddable chat widget
//   GET  /             -> local preview page
// The Anthropic API key stays on the server (ANTHROPIC_API_KEY).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from './config.js';
import { loadKnowledge } from './knowledge.js';
import { loadPromptParts, buildStableSystem } from './prompt.js';
import { runChatTurn, RequestError } from './chat.js';
import { validateHandoff, deliverHandoff } from './handoff.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(here, '..', 'public');

export function createRateLimiter({ perMinute, perDay }) {
  const hits = new Map();
  return (key, now = Date.now()) => {
    const h = (hits.get(key) || []).filter((t) => now - t < 86_400_000);
    const lastMinute = h.filter((t) => now - t < 60_000).length;
    if (lastMinute >= perMinute || h.length >= perDay) {
      hits.set(key, h);
      return false;
    }
    h.push(now);
    hits.set(key, h);
    if (hits.size > 50_000) hits.clear(); // crude memory guard
    return true;
  };
}

function readJson(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new RequestError('Request too large', 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new RequestError('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function isLocalOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

export function createApp({ config = loadConfig(), client, kb = loadKnowledge(), promptParts = loadPromptParts(), logger = console } = {}) {
  const anthropic = client || new Anthropic({ maxRetries: 2, timeout: 60_000 });
  const stableSystem = buildStableSystem(promptParts, kb);
  const allow = createRateLimiter({ perMinute: config.rateLimitPerMinute, perDay: config.rateLimitPerDay });
  const widgetPath = path.join(PUBLIC_DIR, 'widget.js');

  const log = (o) => logger.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

  function cors(req, res) {
    const origin = req.headers.origin;
    if (!origin) return true;
    const self = `http://${req.headers.host}`;
    const ok = config.allowedOrigins.includes(origin) || isLocalOrigin(origin) || origin === self || origin === self.replace('http:', 'https:');
    if (ok) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-max-age', '600');
    }
    return ok;
  }

  const clientKey = (req) =>
    (config.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function handleChat(req, res) {
    if (!allow(`chat:${clientKey(req)}`)) {
      return json(res, 429, { error: { code: 'rate_limited', retryable: true, message: "You're sending messages quickly. Give it a moment and try again." } });
    }
    const body = await readJson(req);
    const id = crypto.randomUUID().slice(0, 8);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    const send = (event, data) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15000);
    try {
      await runChatTurn({ client: anthropic, config, stableSystem, kb, body, send, signal: controller.signal, log: (o) => log({ route: 'chat', id, ...o }) });
    } catch (err) {
      // Validation errors after headers were sent go out as an SSE error event.
      send('error', { code: 'bad_request', retryable: false, message: err instanceof RequestError ? err.message : 'Something went wrong.' });
      if (!(err instanceof RequestError)) log({ route: 'chat', id, ok: false, error: err?.message });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }

  async function handleHandoff(req, res) {
    if (!allow(`handoff:${clientKey(req)}`)) return json(res, 429, { error: { message: 'Too many requests' } });
    const data = validateHandoff(await readJson(req));
    const result = await deliverHandoff(data, config);
    log({ route: 'handoff', delivered: result.delivered, channel: result.channel, reason: result.reason });
    return json(res, 200, { ...result, supportEmail: config.supportEmail });
  }

  return async function app(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      const corsOk = cors(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(corsOk ? 204 : 403);
        return res.end();
      }
      if (url.pathname.startsWith('/api/') && !corsOk) return json(res, 403, { error: { message: 'Origin not allowed' } });

      if (req.method === 'POST' && url.pathname === '/api/chat') return await handleChat(req, res);
      if (req.method === 'POST' && url.pathname === '/api/handoff') return await handleHandoff(req, res);
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, model: config.model, chunks: kb.chunks.length });
      if (req.method === 'GET' && url.pathname === '/widget.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' });
        return fs.createReadStream(widgetPath).pipe(res);
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/demo')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return fs.createReadStream(path.join(PUBLIC_DIR, 'demo.html')).pipe(res);
      }
      return json(res, 404, { error: { message: 'Not found' } });
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof RequestError) return json(res, err.status, { error: { message: err.message } });
      log({ route: url.pathname, ok: false, error: err?.message });
      return json(res, 500, { error: { message: 'Server error' } });
    }
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const config = loadConfig();
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn('Warning: ANTHROPIC_API_KEY is not set; chat requests will fail until it is.');
  }
  const server = http.createServer(createApp({ config }));
  server.listen(config.port, () => console.log(`PublishPro chat listening on http://localhost:${config.port}`));
}
