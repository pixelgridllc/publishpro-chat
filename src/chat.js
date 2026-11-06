import Anthropic from '@anthropic-ai/sdk';
import { LIMITS } from './config.js';
import { retrieve, retrievalQuery } from './knowledge.js';
import { buildSystemBlocks, buildTurnContext } from './prompt.js';
import { extractProfile } from './profile.js';
import { createMarkerFilter } from './markers.js';

const FALLBACK_CAPABLE = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

export class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Validate and normalise the browser payload into Messages API turns.
 * The browser keeps the transcript; the server never trusts it for anything but conversation text.
 */
export function normaliseMessages(input) {
  if (!Array.isArray(input) || input.length === 0) throw new RequestError('messages must be a non-empty array');
  let msgs = input
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({
      role: m.role,
      content: m.content
        .replace(/\u0000/g, '')
        .trim()
        .slice(0, m.role === 'user' ? LIMITS.maxMessageChars : LIMITS.maxAssistantChars),
    }))
    .filter((m) => m.content.length > 0);

  // Merge consecutive same-role turns (e.g. a retried message) so roles alternate.
  const merged = [];
  for (const m of msgs) {
    const prev = merged.at(-1);
    if (prev && prev.role === m.role) prev.content += `\n\n${m.content}`;
    else merged.push({ ...m });
  }
  msgs = merged;

  // Keep the most recent turns within limits; history must start with the visitor.
  msgs = msgs.slice(-LIMITS.maxMessages);
  let total = msgs.reduce((n, m) => n + m.content.length, 0);
  while (msgs.length > 1 && total > LIMITS.maxTotalChars) total -= msgs.shift().content.length;
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();

  if (!msgs.length || msgs.at(-1).role !== 'user') throw new RequestError('the last message must be from the visitor');
  return msgs;
}

export function normalisePage(page) {
  if (!page || typeof page !== 'object') return null;
  const clean = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f<>"]/g, '').slice(0, n) : '');
  const p = { path: clean(page.path, 200), title: clean(page.title, 150) };
  return p.path ? p : null;
}

export function buildRequest({ config, stableSystem, kb, messages, page }) {
  const profile = extractProfile(messages);
  const retrieved = retrieve(kb, retrievalQuery(messages, page), config.retrievalTopK);
  const system = buildSystemBlocks(stableSystem, buildTurnContext({ retrieved, profile, page }));
  const params = {
    model: config.model,
    max_tokens: config.maxTokens,
    system,
    messages,
    output_config: { effort: config.effort },
  };
  if (config.fallbacks && FALLBACK_CAPABLE.has(config.model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  return { params, profile, retrieved };
}

/** Map SDK errors to something safe to show the visitor. */
export function describeError(err) {
  if (err instanceof Anthropic.APIUserAbortError) return { code: 'aborted', retryable: false, message: 'Stopped.' };
  if (err instanceof Anthropic.RateLimitError)
    return { code: 'busy', retryable: true, message: "We're a little busy right now. Give it a few seconds and try again." };
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    // No key configured at all: the SDK throws before sending anything.
    /resolve authentication method/i.test(err?.message || '')
  )
    return { code: 'config', retryable: false, message: "Chat isn't available right now. You can reach the team at support@publishpro.app." };
  if (err instanceof Anthropic.BadRequestError)
    return { code: 'bad_request', retryable: false, message: "Something went wrong with that message. Try starting a new conversation." };
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.InternalServerError || (err instanceof Anthropic.APIError && (err.status ?? 500) >= 500))
    return { code: 'unavailable', retryable: true, message: "Couldn't get an answer just now. Please try again." };
  return { code: 'unknown', retryable: true, message: "Couldn't get an answer just now. Please try again." };
}

const REFUSAL_TEXT =
  "I can't help with that one here, but I'm happy to help with anything about formatting or publishing your book. You can also reach the team at support@publishpro.app.";

/**
 * Run one chat turn, emitting events through `send(event, data)`:
 *   meta  {profile}            - what we know about the visitor (for the UI / handoff)
 *   delta {text}               - visible text to append
 *   reset {}                   - discard the partial answer (server-side fallback restarted it)
 *   done  {text, suggestions, handoff, stopReason}
 *   error {code, message, retryable}
 */
export async function runChatTurn({ client, config, stableSystem, kb, body, send, signal, log = () => {} }) {
  const messages = normaliseMessages(body?.messages);
  const page = normalisePage(body?.page);
  const { params, profile, retrieved } = buildRequest({ config, stableSystem, kb, messages, page });
  send('meta', { profile });

  const started = Date.now();
  const filter = createMarkerFilter();
  try {
    const stream = client.beta.messages.stream(params, { signal });
    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block?.type === 'fallback') {
        // The first model declined mid-answer and the fallback model is starting over.
        filter.reset();
        send('reset', {});
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const visible = filter.push(event.delta.text);
        if (visible) send('delta', { text: visible });
      }
    }
    const final = await stream.finalMessage();
    const { tail, suggestions, handoff } = filter.end();
    if (tail) send('delta', { text: tail });

    let text = filter.text;
    if (final.stop_reason === 'refusal') {
      send('reset', {});
      send('delta', { text: REFUSAL_TEXT });
      text = REFUSAL_TEXT;
    }
    send('done', { text, suggestions: final.stop_reason === 'refusal' ? [] : suggestions, handoff, stopReason: final.stop_reason });
    log({
      ok: true,
      ms: Date.now() - started,
      model: final.model,
      stop: final.stop_reason,
      retrieved: retrieved.map((r) => r.chunk.id),
      usage: final.usage && {
        in: final.usage.input_tokens,
        out: final.usage.output_tokens,
        cacheRead: final.usage.cache_read_input_tokens,
        cacheWrite: final.usage.cache_creation_input_tokens,
      },
    });
    return { text, suggestions, handoff, profile };
  } catch (err) {
    const info = describeError(err);
    log({ ok: false, ms: Date.now() - started, code: info.code, status: err?.status, error: err?.message });
    if (info.code !== 'aborted') send('error', info);
    return null;
  }
}
