// Human handoff. The browser first tries PublishPro's existing Tawk.to live chat
// (client-side). This endpoint is the server-side path: it forwards the request to
// a configured webhook (helpdesk, Zapier/Make, Slack workflow, CRM...).
// It reports delivered:true ONLY when the webhook accepted it.

import crypto from 'node:crypto';
import { RequestError } from './chat.js';

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]{1,190}\.[a-z]{2,}$/i;

export function validateHandoff(body) {
  const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const email = str(body?.email, 254);
  if (!EMAIL_RE.test(email)) throw new RequestError('A valid email address is required');
  const transcript = Array.isArray(body?.transcript)
    ? body.transcript
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-30)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 3000) }))
    : [];
  const profile = body?.profile && typeof body.profile === 'object' ? Object.fromEntries(Object.entries(body.profile).slice(0, 20).map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 200)])) : {};
  return {
    name: str(body?.name, 120),
    email,
    message: str(body?.message, 2000),
    reason: str(body?.reason, 300),
    page: str(body?.page, 200),
    profile,
    transcript,
  };
}

export async function deliverHandoff(handoff, config, fetchImpl = fetch) {
  if (!config.supportWebhookUrl) return { delivered: false, channel: null, reason: 'not_configured' };
  const payload = JSON.stringify({
    type: 'publishpro.chat.handoff',
    createdAt: new Date().toISOString(),
    ...handoff,
    transcriptText: handoff.transcript.map((m) => `${m.role === 'user' ? 'Visitor' : 'PublishPro'}: ${m.content}`).join('\n\n'),
  });
  const headers = { 'content-type': 'application/json' };
  if (config.supportWebhookSecret) {
    headers['x-publishpro-signature'] = crypto.createHmac('sha256', config.supportWebhookSecret).update(payload).digest('hex');
  }
  try {
    const res = await fetchImpl(config.supportWebhookUrl, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(10000) });
    return res.ok ? { delivered: true, channel: 'webhook' } : { delivered: false, channel: 'webhook', reason: `status_${res.status}` };
  } catch (err) {
    return { delivered: false, channel: 'webhook', reason: err?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}
