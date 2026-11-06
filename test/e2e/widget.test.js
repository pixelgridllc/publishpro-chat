// End-to-end: real widget in Chromium -> real server -> real Anthropic SDK -> stub model API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import Anthropic from '@anthropic-ai/sdk';
import { createApp } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { startStubAnthropic } from '../helpers/stub-anthropic.js';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const SHOTS = path.resolve('test-results');
fs.mkdirSync(SHOTS, { recursive: true });

const REPLIES = {
  'How do I format my first book?':
    "That's a big milestone. The next step is getting the manuscript into publish-ready files: a Kindle-ready EPUB and, if you want print, a paperback PDF.\n\nIs it still in a Word document? If so, you can see the whole process on [how it works](https://publishpro.app/how-it-works).\n\n[[suggest: It's in Word | I want an eBook and paperback | How much does it cost?]]",
  "It's in Word":
    'Perfect. Upload the Word file and PublishPro formats it automatically:\n\n- detects chapters, front and back matter\n- builds the table of contents\n- sets **margins, gutter and bleed** from your trim size\n\nYou can preview it free before paying.\n[[suggest: Can I do both from one file? | Which trim size should I pick?]]',
  '#handoff': "That one needs the team, since they can look at your invoice directly.\n[[handoff: Visitor needs help with an invoice / billing question]]",
};

let stub, appServer, appUrl, hookServer, browser;
const hookCalls = [];

before(async () => {
  stub = await startStubAnthropic((text, body, { failures }) => {
    if (text.includes('#fail')) {
      const left = failures.get(text) ?? 1;
      if (left > 0) {
        failures.set(text, left - 1);
        return { status: 500 };
      }
      return { text: 'Back again. What would you like to know?' };
    }
    if (text.includes('#slow')) return { text: 'This is a long answer that streams slowly. '.repeat(12), delay: 60 };
    return { text: REPLIES[text] || `You asked: ${text}. Happy to help with that.` };
  });
  hookServer = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    hookCalls.push(body);
    res.writeHead(body.email.includes('fail') ? 500 : 200).end('{}');
  });
  await new Promise((r) => hookServer.listen(0, '127.0.0.1', r));
  const config = { ...loadConfig({}), supportWebhookUrl: `http://127.0.0.1:${hookServer.address().port}/hook`, rateLimitPerMinute: 1000, rateLimitPerDay: 10000 };
  const client = new Anthropic({ apiKey: 'test-key', baseURL: stub.url, maxRetries: 0 });
  appServer = http.createServer(createApp({ config, client, logger: { log() {} } }));
  await new Promise((r) => appServer.listen(0, '127.0.0.1', r));
  appUrl = `http://127.0.0.1:${appServer.address().port}`;
  // Proxy only so Google Fonts load for screenshots; loopback is not proxied.
  browser = await chromium.launch(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } } : {});
});

after(async () => {
  await browser?.close();
  await new Promise((r) => appServer.close(r));
  await new Promise((r) => hookServer.close(r));
  await stub.close();
});

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, ...opts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.errors = errors;
  return page;
}
const w = (page) => page.locator('#publishpro-chat'); // shadow DOM is pierced by Playwright locators

async function openChat(page, url = appUrl + '/') {
  await page.goto(url);
  await w(page).locator('.launcher').click();
  await w(page).locator('.panel').waitFor({ state: 'visible' });
}
async function waitIdle(page) {
  await w(page).locator('.send[aria-label="Send message"]').waitFor();
}

test('welcome screen: brand, heading, contextual starters, placeholder, no robotic labels', async () => {
  const page = await newPage();
  await page.goto(appUrl + '/');
  const launcher = w(page).locator('.launcher');
  assert.equal(await launcher.innerText(), 'Ask about your book');
  assert.equal(await launcher.getAttribute('aria-expanded'), 'false');
  await launcher.click();
  assert.equal(await launcher.getAttribute('aria-expanded'), 'true');
  assert.equal(await w(page).locator('.welcome h2').innerText(), 'Let’s get your book ready for publishing.');
  assert.match(await w(page).locator('.welcome p').first().innerText(), /formatting your first book or preparing multiple titles/);
  const starters = await w(page).locator('.starter').allInnerTexts();
  assert.deepEqual(starters, [
    'How do I format my first book?',
    'Create an eBook and paperback',
    'How does PublishPro work?',
    'Which publishing platforms are supported?',
    'Tell me about paperback formatting',
    'I need help with book cover design',
  ]);
  assert.equal(await w(page).locator('textarea').getAttribute('placeholder'), 'Ask anything about formatting or publishing your book...');
  assert.equal(await w(page).locator('.send').isDisabled(), true);
  const allText = await w(page).locator('.panel').innerText();
  assert.doesNotMatch(allText, /\b(AI|bot|chatbot|virtual|assistant)\b/i);
  // Input is focused on open
  assert.equal(await page.evaluate(() => document.querySelector('#publishpro-chat').shadowRoot.activeElement?.id), 'pp-input');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-welcome.png') });
  assert.deepEqual(page.errors, []);
});

test('starter -> streamed answer with link card and suggestions; markers hidden; correct API request', async () => {
  const page = await newPage();
  await openChat(page);
  const before = stub.requests.length;
  await w(page).locator('.starter', { hasText: 'How do I format my first book?' }).click();
  // Typing indicator appears before the first token
  await w(page).locator('.msg.user', { hasText: 'How do I format my first book?' }).waitFor();
  await waitIdle(page);
  const answer = w(page).locator('.msg.assistant').last();
  const text = await answer.locator('.md').innerText();
  assert.match(text, /That's a big milestone/);
  assert.doesNotMatch(text, /\[\[|suggest:/);
  const link = answer.locator('.md a', { hasText: 'how it works' });
  assert.equal(await link.getAttribute('href'), 'https://publishpro.app/how-it-works');
  assert.equal(await answer.locator('.card .c-n').innerText(), 'How it works');
  assert.deepEqual(await w(page).locator('.chip').allInnerTexts(), ["It's in Word", 'I want an eBook and paperback', 'How much does it cost?']);
  assert.equal(await w(page).locator('.welcome').isVisible(), false);
  assert.equal(await w(page).locator('.reset').isVisible(), true);

  const req = stub.requests[before];
  assert.equal(req.url.startsWith('/v1/messages'), true);
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.equal(req.body.stream, true);
  assert.equal(req.body.fallbacks, 'default');
  assert.match(req.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.deepEqual(req.body.output_config, { effort: 'low' });
  assert.equal(req.body.system[0].cache_control.type, 'ephemeral');
  assert.match(req.body.system[0].text, /Who you are/);
  assert.match(req.body.system[1].text, /currently on this page of publishpro.app: \//);
  assert.ok(req.headers['x-api-key'] === 'test-key' || req.headers.authorization === 'Bearer test-key', 'API key sent server-side');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-answer.png') });
  assert.deepEqual(page.errors, []);
});

test('multi-turn: history and visitor profile are carried into the next request; copy works', async () => {
  const page = await newPage();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openChat(page);
  await w(page).locator('.starter').first().click();
  await waitIdle(page);
  const before = stub.requests.length;
  await w(page).locator('.chip', { hasText: "It's in Word" }).click();
  await waitIdle(page);
  const req = stub.requests[before];
  assert.deepEqual(req.body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.doesNotMatch(req.body.messages[1].content, /\[\[suggest/, 'markers are not echoed back as history');
  assert.match(req.body.system[1].text, /Manuscript file: Word document/);
  const last = w(page).locator('.msg.assistant').last();
  assert.equal(await last.locator('li').count(), 3);
  assert.equal(await last.locator('strong').innerText(), 'margins, gutter and bleed');
  await last.locator('.act', { hasText: 'Copy' }).click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^Perfect\. Upload the Word file/);
  await last.locator('.act', { hasText: 'Copied' }).waitFor();
});

test('keyboard: Shift+Enter adds a line, Enter sends, Escape closes and returns focus', async () => {
  const page = await newPage();
  await openChat(page);
  const input = w(page).locator('textarea');
  await input.type('line one');
  await input.press('Shift+Enter');
  await input.type('line two');
  assert.equal(await input.inputValue(), 'line one\nline two');
  await input.press('Enter');
  await waitIdle(page);
  assert.equal(await w(page).locator('.msg.user').innerText(), 'line one\nline two');
  assert.equal(await input.inputValue(), '');
  await input.press('Escape');
  assert.equal(await w(page).locator('.panel').isHidden(), true);
  assert.equal(await page.evaluate(() => document.querySelector('#publishpro-chat').shadowRoot.activeElement?.className), 'launcher');
});

test('error state with retry recovers', async () => {
  const page = await newPage();
  await openChat(page);
  const input = w(page).locator('textarea');
  await input.fill('Please answer #fail');
  await input.press('Enter');
  const err = w(page).locator('.error');
  await err.waitFor();
  assert.match(await err.innerText(), /Couldn't get an answer just now/);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-error.png') });
  await err.locator('button', { hasText: 'Try again' }).click();
  await waitIdle(page);
  assert.equal(await w(page).locator('.error').count(), 0);
  assert.match(await w(page).locator('.msg.assistant').last().innerText(), /Back again/);
  assert.equal(await w(page).locator('.msg.user').count(), 1, 'retry does not duplicate the question');
});

test('stop button halts a streaming answer', async () => {
  const page = await newPage();
  await openChat(page);
  await w(page).locator('textarea').fill('Tell me everything #slow');
  await w(page).locator('textarea').press('Enter');
  const stopBtn = w(page).locator('.send[aria-label="Stop generating"]');
  await stopBtn.waitFor();
  await w(page).locator('.msg.assistant .md', { hasText: 'long answer' }).waitFor();
  await stopBtn.click();
  await waitIdle(page);
  const text = await w(page).locator('.msg.assistant .md').last().innerText();
  assert.ok(text.endsWith('…'));
  assert.ok(text.length < 'This is a long answer that streams slowly. '.repeat(12).length);
});

test('handoff: model-triggered form validates email and only confirms after webhook accepts it', async () => {
  const page = await newPage();
  await openChat(page);
  await w(page).locator('textarea').fill('#handoff');
  await w(page).locator('textarea').press('Enter');
  const form = w(page).locator('.handoff form');
  await form.waitFor();
  assert.equal(await form.locator('textarea').inputValue(), '');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-handoff.png') });
  await form.locator('input[name=name]').fill('Maya');
  await form.locator('input[name=email]').fill('not-an-email');
  await form.locator('button[type=submit]').click();
  assert.match(await form.locator('.f-err').innerText(), /valid email/);
  const n = hookCalls.length;
  await form.locator('input[name=email]').fill('maya@example.com');
  await form.locator('button[type=submit]').click();
  await w(page).locator('.handoff h3', { hasText: 'Sent to the PublishPro team' }).waitFor();
  assert.match(await w(page).locator('.handoff').innerText(), /reply to maya@example.com/);
  const call = hookCalls[n];
  assert.equal(call.email, 'maya@example.com');
  assert.equal(call.name, 'Maya');
  assert.equal(call.reason, 'Visitor needs help with an invoice / billing question');
  assert.match(call.transcriptText, /Visitor: #handoff/);
  assert.match(call.transcriptText, /PublishPro: That one needs the team/);
});

test('handoff: webhook failure falls back to an honest email path (no false confirmation)', async () => {
  const page = await newPage();
  await openChat(page);
  await w(page).locator('.human').click();
  const form = w(page).locator('.handoff form');
  await form.locator('input[name=email]').fill('fail@example.com');
  await form.locator('button[type=submit]').click();
  await w(page).locator('.handoff h3', { hasText: 'email instead' }).waitFor();
  assert.equal(await w(page).locator('.handoff', { hasText: 'Sent to' }).count(), 0);
  assert.match(await w(page).locator('.handoff a.btn').getAttribute('href'), /^mailto:support@publishpro\.app\?subject=/);
});

test('existing Tawk.to live chat: launcher hidden on load, live handoff passes context', async () => {
  const page = await newPage();
  await page.addInitScript(() => {
    window.__tawk = [];
    window.Tawk_API = {
      getStatus: () => 'online',
      hideWidget: () => window.__tawk.push('hide'),
      showWidget: () => window.__tawk.push('show'),
      maximize: () => window.__tawk.push('max'),
      setAttributes: (a, cb) => { window.__tawk.push(['attrs', a]); cb && cb(); },
      addEvent: (n, m, cb) => { window.__tawk.push(['event', n, m]); cb && cb(); },
    };
  });
  await openChat(page);
  assert.deepEqual(await page.evaluate(() => window.__tawk), ['hide']);
  await w(page).locator('textarea').fill('I need a person, I have 30 books for our agency');
  await w(page).locator('textarea').press('Enter');
  await waitIdle(page);
  await w(page).locator('.human').click();
  await w(page).locator('.handoff input[name=email]').fill('ops@agency.example');
  await w(page).locator('.handoff button', { hasText: 'Chat with the team now' }).click();
  await w(page).locator('.handoff h3', { hasText: 'Live chat opened' }).waitFor();
  const calls = await page.evaluate(() => window.__tawk);
  const attrs = calls.find((c) => c[0] === 'attrs')[1];
  assert.equal(attrs.email, 'ops@agency.example');
  assert.match(attrs['chat-summary'], /visitorType: business/);
  assert.ok(attrs['chat-summary'].length <= 255);
  assert.ok(calls.some((c) => c[0] === 'event' && c[1] === 'publishing-assistant-handoff'));
  assert.ok(calls.includes('show') && calls.includes('max'));
});

test('conversation persists across page navigation; reset starts fresh', async () => {
  const page = await newPage();
  await openChat(page);
  await w(page).locator('textarea').fill('Remember me');
  await w(page).locator('textarea').press('Enter');
  await waitIdle(page);
  await page.reload();
  await w(page).locator('.panel').waitFor({ state: 'visible' }); // reopens on desktop after navigation
  assert.equal(await w(page).locator('.msg.user').innerText(), 'Remember me');
  await w(page).locator('.reset').click();
  assert.equal(await w(page).locator('.msg').count(), 0);
  assert.equal(await w(page).locator('.welcome').isVisible(), true);
});

test('contextual starters on the pricing page', async () => {
  const page = await newPage();
  const html = fs.readFileSync(path.resolve('public/demo.html'), 'utf8');
  await page.route(appUrl + '/pricing', (r) => r.fulfill({ contentType: 'text/html', body: html }));
  await openChat(page, appUrl + '/pricing');
  assert.equal(await w(page).locator('.starter').first().innerText(), 'Is it a subscription or a one-time payment?');
  const before = stub.requests.length;
  await w(page).locator('.starter').first().click();
  await waitIdle(page);
  assert.match(stub.requests[before].body.system[1].text, /currently on this page of publishpro.app: \/pricing/);
});

test('mobile: full-screen panel, 16px input, no horizontal scroll, close control reachable', async () => {
  const page = await newPage({ ...devices['iPhone 13'] });
  await page.goto(appUrl + '/');
  await w(page).locator('.launcher').tap();
  const panel = w(page).locator('.panel');
  await panel.waitFor();
  const box = await panel.boundingBox();
  const vp = page.viewportSize();
  assert.equal(Math.round(box.width), vp.width);
  assert.ok(Math.abs(box.height - vp.height) <= 1, `panel height ${box.height} vs viewport ${vp.height}`);
  assert.equal(await w(page).locator('textarea').evaluate((el) => getComputedStyle(el).fontSize), '16px');
  assert.equal(await w(page).locator('.launcher').isVisible(), false);
  assert.equal(await panel.getAttribute('aria-modal'), 'true');
  await page.screenshot({ path: path.join(SHOTS, 'mobile-welcome.png') });
  await w(page).locator('.starter').nth(1).tap();
  await waitIdle(page);
  const overflow = await w(page).locator('.body').evaluate((el) => el.scrollWidth - el.clientWidth);
  assert.equal(overflow, 0);
  await page.screenshot({ path: path.join(SHOTS, 'mobile-answer.png') });
  await w(page).locator('.close').tap();
  assert.equal(await panel.isHidden(), true);
  assert.equal(await page.evaluate(() => document.documentElement.style.overflow), '');
});

test('greeting teaser appears once and opens the chat', async () => {
  const page = await newPage();
  await page.clock.install();
  await page.goto(appUrl + '/');
  await page.clock.runFor(8500);
  const teaser = w(page).locator('.teaser');
  await teaser.waitFor();
  assert.match(await teaser.innerText(), /Getting a book ready for publishing\?/);
  await teaser.locator('.t-open').click();
  assert.equal(await w(page).locator('.panel').isVisible(), true);
  assert.equal(await teaser.isHidden(), true);
});
