// A local stand-in for POST /v1/messages that speaks Anthropic's streaming
// wire format. Used so the real SDK + server + widget can be tested end to end
// without network access or an API key. It records every request body.

import http from 'node:http';

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startStubAnthropic(script) {
  const requests = [];
  const failures = new Map(); // key -> remaining failures
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ url: req.url, headers: req.headers, body });
    const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
    const plan = script(text, body, { failures, requests }) || { text: 'OK.' };

    if (plan.status) {
      res.writeHead(plan.status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: plan.errorType || 'api_error', message: 'stub failure' } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse(res, 'message_start', {
      type: 'message_start',
      message: { id: 'msg_stub', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 } },
    });
    // Adaptive thinking block (display omitted -> empty text), as the real API sends.
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    sse(res, 'content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    const pieces = plan.text.match(/[\s\S]{1,9}/g) || [];
    for (const p of pieces) {
      if (res.destroyed) return;
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: p } });
      await sleep(plan.delay ?? 8);
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 1 });
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: plan.stopReason || 'end_turn', stop_sequence: null }, usage: { output_tokens: pieces.length } });
    sse(res, 'message_stop', { type: 'message_stop' });
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    failures,
    close: () => new Promise((r) => server.close(r)),
  };
}
