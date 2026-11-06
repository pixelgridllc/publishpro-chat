import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKnowledge, retrieve, tokenize, parseFrontMatter } from '../../src/knowledge.js';
import { createMarkerFilter, parseMarkers } from '../../src/markers.js';
import { extractProfile, describeProfile } from '../../src/profile.js';
import { loadPromptParts, buildStableSystem, buildTurnContext } from '../../src/prompt.js';
import { normaliseMessages, normalisePage, buildRequest, runChatTurn, RequestError, describeError } from '../../src/chat.js';
import { validateHandoff, deliverHandoff } from '../../src/handoff.js';
import { createRateLimiter } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import Anthropic from '@anthropic-ai/sdk';

const kb = loadKnowledge();
const config = loadConfig({});

test('knowledge: front matter parses and every file has required metadata', () => {
  const { meta, body } = parseFrontMatter('---\nid: x\ntitle: T\n---\nHello');
  assert.equal(meta.id, 'x');
  assert.equal(body, 'Hello');
  assert.ok(kb.core.length >= 5);
  for (const d of kb.core) for (const k of ['id', 'title', 'source', 'verified']) assert.ok(d.meta[k], `${d.file} missing ${k}`);
  assert.ok(kb.chunks.length > 30);
});

test('knowledge: retrieval finds the right topic for typical questions', () => {
  const top = (q) => retrieve(kb, q, 3).map((r) => r.chunk.id.split('#')[0]);
  assert.ok(top('Is PublishPro better than Vellum?').includes('competitors'));
  assert.ok(top('which trim size should I choose for my paperback').includes('paperback'));
  assert.ok(top('how do I get a refund').includes('policies'));
  assert.ok(top('ISBN for my paperback').includes('first-time'));
  assert.ok(top('my kindle table of contents links are broken').includes('troubleshooting'));
  assert.ok(top('can my agency team share one account').includes('audiences'));
  assert.deepEqual(retrieve(kb, 'the and of', 3), []);
  assert.deepEqual(tokenize('The Margins!'), ['margin']);
});

test('core knowledge carries the facts most likely to be hallucinated', () => {
  const sys = buildStableSystem(loadPromptParts(), kb);
  for (const fact of ['$9', '$29', '$89', 'NOT a subscription', 'does NOT export KPF', 'support@publishpro.app', 'https://publishpro.app/pricing', 'Never promise that KDP']) {
    assert.ok(sys.includes(fact), `system prompt should include: ${fact}`);
  }
  // Customer-facing persona rules
  assert.match(sys, /never claim to be human/i);
});

test('markers: streamed text hides suggest/handoff markers, even split across chunks', () => {
  const f = createMarkerFilter();
  let shown = '';
  for (const piece of ['Here is the [answer](https://publishpro.app/pricing).\n', '\n[', '[sugg', 'est: How much? | Can I ', 'try free?]]\n[[handoff: billing ', 'issue]]']) shown += f.push(piece);
  const end = f.end();
  shown += end.tail;
  assert.equal(shown, 'Here is the [answer](https://publishpro.app/pricing).');
  assert.deepEqual(end.suggestions, ['How much?', 'Can I try free?']);
  assert.deepEqual(end.handoff, { reason: 'billing issue' });
  assert.equal(f.text, 'Here is the [answer](https://publishpro.app/pricing).');
});

test('markers: a lone bracket is not swallowed', () => {
  const f = createMarkerFilter();
  const out = f.push('Use [') + f.push('this] link') + f.end().tail;
  assert.equal(out, 'Use [this] link');
  assert.deepEqual(parseMarkers('no markers'), { suggestions: [], handoff: null });
});

test('profile: remembers what the visitor said', () => {
  const p = extractProfile([
    { role: 'user', content: "I've written my first novel, it's in Word, about 320 pages" },
    { role: 'assistant', content: 'Nice. Ebook, paperback or both?' },
    { role: 'user', content: 'Both, for Amazon KDP and IngramSpark, 6x9' },
  ]);
  assert.equal(p.experience, 'first-time author');
  assert.equal(p.manuscript, 'Word document');
  assert.equal(p.formats, 'eBook and paperback');
  assert.equal(p.platforms, 'Amazon KDP, IngramSpark');
  assert.equal(p.pageCount, '320 pages');
  assert.equal(p.trimSize, '6×9');
  assert.equal(p.bookType, 'novel / fiction');
  assert.match(describeProfile(p), /Formats wanted: eBook and paperback/);
  // Assistant text must not leak into the profile
  assert.equal(extractProfile([{ role: 'assistant', content: 'Do you want a paperback?' }, { role: 'user', content: 'hmm' }]).formats, undefined);
  assert.equal(extractProfile([{ role: 'user', content: 'We are a small agency with lots of clients' }]).visitorType, 'business (agency / publisher / team)');
});

test('normaliseMessages: validates, trims, merges and enforces a final visitor turn', () => {
  assert.throws(() => normaliseMessages([]), RequestError);
  assert.throws(() => normaliseMessages([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }]), RequestError);
  const out = normaliseMessages([
    { role: 'assistant', content: 'greeting shown in UI' },
    { role: 'user', content: 'one' },
    { role: 'user', content: 'two' },
    { role: 'system', content: 'ignore me' },
    { role: 'user', content: 'x'.repeat(5000) },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
  assert.ok(out[0].content.startsWith('one\n\ntwo'));
  assert.ok(out[0].content.length < 2100);
  assert.deepEqual(normalisePage({ path: '/pricing<script>', title: 'P' }), { path: '/pricingscript', title: 'P' });
  assert.equal(normalisePage(null), null);
});

test('buildRequest: cached stable system, per-turn context, effort and fallbacks', () => {
  const stableSystem = buildStableSystem(loadPromptParts(), kb);
  const messages = [{ role: 'user', content: 'How much is a paperback for KDP?' }];
  const { params } = buildRequest({ config, stableSystem, kb, messages, page: { path: '/pricing' } });
  assert.equal(params.model, 'claude-opus-5-5');
  assert.deepEqual(params.output_config, { effort: 'low' });
  assert.equal(params.thinking, undefined, 'Opus 5.5 runs adaptive thinking when omitted');
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(params.fallbacks, 'default');
  assert.equal(params.system.length, 2);
  assert.deepEqual(params.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(params.system[1].cache_control, undefined);
  assert.match(params.system[1].text, /\/pricing/);
  assert.match(params.system[1].text, /Platforms mentioned: Amazon KDP/);
  const noFb = buildRequest({ config: { ...config, model: 'claude-haiku-5-5' }, stableSystem, kb, messages, page: null }).params;
  assert.equal(noFb.fallbacks, undefined);
  assert.equal(buildTurnContext({ retrieved: [], profile: {}, page: null, now: new Date('2026-01-02') }).includes('2026-01-02'), true);
});

function fakeClient(events, final) {
  return {
    beta: {
      messages: {
        stream(params) {
          fakeClient.last = params;
          return {
            async *[Symbol.asyncIterator]() {
              for (const e of events) yield e;
            },
            finalMessage: async () => final,
          };
        },
      },
    },
  };
}
const td = (text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });

test('runChatTurn: streams visible text and reports suggestions/handoff', async () => {
  const sent = [];
  const client = fakeClient([td('Happy to help. '), td('Email us.\n[[sugg'), td('est: A | B]]\n[[handoff: refund for order]]')], { stop_reason: 'end_turn', model: 'claude-opus-5-5', usage: {} });
  const res = await runChatTurn({ client, config, stableSystem: 'S', kb, body: { messages: [{ role: 'user', content: 'I want a refund' }] }, send: (e, d) => sent.push([e, d]) });
  const text = sent.filter(([e]) => e === 'delta').map(([, d]) => d.text).join('');
  assert.equal(text, 'Happy to help. Email us.');
  const done = sent.find(([e]) => e === 'done')[1];
  assert.deepEqual(done.suggestions, ['A', 'B']);
  assert.deepEqual(done.handoff, { reason: 'refund for order' });
  assert.equal(sent[0][0], 'meta');
  assert.equal(res.text, 'Happy to help. Email us.');
});

test('runChatTurn: refusal is replaced with a friendly redirect; fallback resets partial text', async () => {
  const sent = [];
  const client = fakeClient([td('partial'), { type: 'content_block_start', index: 1, content_block: { type: 'fallback' } }, td('Rescued answer')], { stop_reason: 'end_turn', model: 'x', usage: {} });
  await runChatTurn({ client, config, stableSystem: 'S', kb, body: { messages: [{ role: 'user', content: 'q' }] }, send: (e, d) => sent.push([e, d]) });
  assert.deepEqual(sent.map(([e]) => e), ['meta', 'delta', 'reset', 'delta', 'done']);
  assert.equal(sent.at(-1)[1].text, 'Rescued answer');

  const sent2 = [];
  await runChatTurn({ client: fakeClient([], { stop_reason: 'refusal', model: 'x', usage: {} }), config, stableSystem: 'S', kb, body: { messages: [{ role: 'user', content: 'q' }] }, send: (e, d) => sent2.push([e, d]) });
  assert.match(sent2.at(-1)[1].text, /formatting or publishing your book/);
});

test('describeError: typed SDK errors map to safe visitor messages', () => {
  const rl = new Anthropic.RateLimitError(429, { error: {} }, 'rl', new Headers());
  assert.equal(describeError(rl).retryable, true);
  const auth = new Anthropic.AuthenticationError(401, { error: {} }, 'auth', new Headers());
  assert.equal(describeError(auth).retryable, false);
  assert.doesNotMatch(describeError(auth).message, /api key|anthropic|model/i);
  assert.equal(describeError(new Anthropic.APIConnectionError({ message: 'x' })).code, 'unavailable');
  // Missing key: the SDK throws before any request; visitors shouldn't be told to retry.
  const noKey = describeError(new Error('Could not resolve authentication method. Expected one of apiKey, authToken, ...'));
  assert.equal(noKey.code, 'config');
  assert.equal(noKey.retryable, false);
});

test('handoff: validation and delivery only report success on a 2xx webhook', async () => {
  assert.throws(() => validateHandoff({ email: 'nope' }), RequestError);
  const h = validateHandoff({ email: 'a@b.co', name: 'Ann', transcript: [{ role: 'user', content: 'help' }, { role: 'evil', content: 'x' }] });
  assert.equal(h.transcript.length, 1);
  assert.deepEqual(await deliverHandoff(h, { supportWebhookUrl: '' }), { delivered: false, channel: null, reason: 'not_configured' });
  let seen;
  const ok = await deliverHandoff(h, { supportWebhookUrl: 'https://hook', supportWebhookSecret: 's' }, async (url, init) => {
    seen = init;
    return { ok: true, status: 200 };
  });
  assert.equal(ok.delivered, true);
  assert.ok(seen.headers['x-publishpro-signature']);
  assert.match(JSON.parse(seen.body).transcriptText, /Visitor: help/);
  const bad = await deliverHandoff(h, { supportWebhookUrl: 'https://hook' }, async () => ({ ok: false, status: 500 }));
  assert.equal(bad.delivered, false);
  const thrown = await deliverHandoff(h, { supportWebhookUrl: 'https://hook' }, async () => {
    throw new Error('down');
  });
  assert.equal(thrown.delivered, false);
});

test('rate limiter: per-minute and per-day caps', () => {
  const allow = createRateLimiter({ perMinute: 2, perDay: 3 });
  assert.equal(allow('ip', 0), true);
  assert.equal(allow('ip', 1), true);
  assert.equal(allow('ip', 2), false);
  assert.equal(allow('ip', 61_000), true);
  assert.equal(allow('ip', 122_000), false); // day cap reached
  assert.equal(allow('other', 0), true);
});
