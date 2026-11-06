// Runtime configuration. Everything secret comes from the environment and
// never reaches the browser.

const list = (v) =>
  (v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};

export function loadConfig(env = process.env) {
  return {
    port: int(env.PORT, 8787),
    model: env.CHAT_MODEL || 'claude-opus-5-5',
    // Chat replies are short and conversational; low effort keeps latency down.
    effort: env.CHAT_EFFORT || 'low',
    maxTokens: int(env.CHAT_MAX_TOKENS, 8000),
    // Server-side refusal fallbacks (beta). Set to "false" to disable.
    fallbacks: env.CHAT_FALLBACKS !== 'false',
    // Origins allowed to call the API from a browser. Empty = same-origin + localhost only.
    allowedOrigins: list(env.ALLOWED_ORIGINS || 'https://publishpro.app,https://www.publishpro.app'),
    // Optional: where handoff requests are POSTed (Zapier, Make, Slack workflow, helpdesk...).
    supportWebhookUrl: env.SUPPORT_WEBHOOK_URL || '',
    supportWebhookSecret: env.SUPPORT_WEBHOOK_SECRET || '',
    supportEmail: env.SUPPORT_EMAIL || 'support@publishpro.app',
    rateLimitPerMinute: int(env.RATE_LIMIT_PER_MINUTE, 12),
    rateLimitPerDay: int(env.RATE_LIMIT_PER_DAY, 200),
    trustProxy: env.TRUST_PROXY === 'true',
    retrievalTopK: int(env.RETRIEVAL_TOP_K, 5),
  };
}

export const LIMITS = {
  maxMessages: 40, // history sent per request (older turns are trimmed)
  maxMessageChars: 2000, // per visitor message
  maxAssistantChars: 6000, // per prior assistant message
  maxTotalChars: 40000,
};
