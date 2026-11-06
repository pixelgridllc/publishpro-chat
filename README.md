# PublishPro publishing chat

A conversational publishing consultant for publishpro.app: an embeddable chat widget plus a small streaming API that answers with Claude, grounded in a maintained PublishPro knowledge base.

```
publishpro.app (Framer)                 Chat service (Node, this repo)                    Claude API
┌───────────────────────┐  POST /api/chat (SSE)  ┌───────────────────────────────┐  stream  ┌──────────┐
│ widget.js (Shadow DOM)│ ─────────────────────▶ │ validate → profile → retrieve │ ───────▶ │ Messages │
│  welcome, chat, chips │ ◀───────────────────── │ → system prompt (cached) →    │ ◀─────── │   API    │
│  handoff card         │   delta/done/error     │ stream, strip markers         │          └──────────┘
│                       │  POST /api/handoff     │ handoff → SUPPORT_WEBHOOK_URL │
│  Tawk.to (existing) ◀─┼── live handoff ────────┴───────────────────────────────┘
└───────────────────────┘
```

## Quick start

```bash
npm install
```

```bash
cp .env.example .env   # then set ANTHROPIC_API_KEY
```

```bash
node --env-file=.env src/server.js
```

Open http://localhost:8787 for a local preview page.

No API key yet? Run `DEMO_MODE=true npm start` for a preview with scripted answers (written from the knowledge base). Everything else is the real widget and server. Never enable demo mode in production.

## Add it to publishpro.app (Framer)

Deploy the service (below), then in Framer go to **Site Settings → General → Custom Code → End of `<body>` tag** and add:

```html
<script src="https://chat.publishpro.app/widget.js" defer></script>
```

Replace the host with wherever you deploy. Then add the site's origins to `ALLOWED_ORIGINS`; the default is `https://publishpro.app,https://www.publishpro.app`.

Keep the existing Tawk.to snippet. The widget hides Tawk's own launcher, so there's only one chat button on the page, and opens Tawk when a visitor asks for a person. Add `data-hide-tawk="false"` to the script tag if you'd rather keep both launchers visible.

Other script-tag options: `data-api="https://…"` (API host, if different from the script host), `data-teaser="false"` (no greeting bubble), `data-load-fonts="false"`, `data-open="true"`. A page can also call `window.PublishProChat.open()`, `.ask("question")`, `.reset()` or `.close()`. For example, a "Questions? Ask us" button can call `PublishProChat.ask('How does PublishPro work?')`.

## Deploying

Any Node 20+ host that supports streaming responses works, such as Render, Railway, Fly.io, a VPS or a container. Run `npm start` with the environment variables from `.env.example`. Requirements:

- **No response buffering on `/api/chat`.** The server sends `X-Accel-Buffering: no`; check your proxy or CDN honours it.
- **`TRUST_PROXY=true`** when behind a load balancer, so per-visitor rate limits use the real IP.
- **One instance is fine.** The rate limiter is in memory; for several instances, move it to Redis or your edge.

Serverless platforms with streaming support also work. `createApp()` returns a plain `(req, res)` Node handler.

## How it works

| Piece | Where | Notes |
|---|---|---|
| Widget | `public/widget.js` | Dependency-free, Shadow DOM (immune to Framer CSS), about 1,000 lines. Session persistence (survives page navigation), keyed rendering, streaming, stop, retry, copy, contextual starters per page, model-suggested follow-ups, recommended-page cards, handoff card, mobile full-screen with visual-viewport keyboard handling, focus management, reduced motion. |
| Chat API | `src/chat.js`, `src/server.js` | Validates input, builds the request, streams Server-Sent Events. API key never leaves the server. |
| Prompt | `prompts/01…06-*.md` | Six separately editable sections: identity, conversation, accuracy, qualification and conversion, escalation, response format. |
| Knowledge | `knowledge/core/*.md` | Always in the prompt: company, pricing, platforms and formats, site URLs, "what we don't do". Prompt-cached. |
| | `knowledge/topics/*.md` | Split at each `## ` heading and retrieved per turn with BM25: eBook, paperback, cover, workflow, audiences, first-time authors, platforms, troubleshooting, policies, competitors, FAQ. |
| Visitor memory | `src/profile.js` | Facts the visitor stated (experience, manuscript format, formats, platforms, trim, page count, book type) are summarised into each turn so the model never re-asks. They're also passed to the team on handoff. Full history is sent too. |
| Markers | `src/markers.js` | The model ends replies with hidden `[[suggest: …]]` and `[[handoff: …]]` lines. The server strips them from the stream and turns them into chips or a handoff card. |
| Handoff | `src/handoff.js` + widget | 1) Team online in Tawk: "Chat with the team now" opens Tawk with name, email and a context summary attached. 2) Otherwise the email form posts to `SUPPORT_WEBHOOK_URL`, with an HMAC signature if a secret is set. 3) If that isn't configured or fails, Tawk's offline form, then a prefilled email to support@publishpro.app. The UI only says "sent" when delivery is confirmed. |

Model settings: `claude-opus-5-5`, adaptive thinking (the model default) at `effort: low`, which suits short conversational replies. Server-side refusal fallbacks (`fallbacks: "default"`) are on. All of this is configurable in `.env`.

### Why retrieval plus a cached core, not fine-tuning

The product facts change (prices, platforms, features), so they live in Markdown that anyone can edit, not in model weights. The most hallucination-prone facts (prices, formats, URLs, the things PublishPro doesn't do) are always in the prompt, while long-tail detail is retrieved per question. The core is about 6K tokens and prompt-cached, so it's cheap per turn. Fine-tuning would make updates slow, risk baking in stale prices, and isn't needed for tone, which the prompt sections control.

## Updating knowledge

1. Edit the relevant file in `knowledge/`. Keep one idea per `## ` section, and update the `verified:` date and `source:` URL.
2. Run `npm run check:knowledge` (add `-- --live` to check every PublishPro URL still resolves). It flags files not re-verified in 90 days.
3. Restart the service. Knowledge loads at startup.

Put a new fact in `knowledge/core/` only if a wrong answer about it would be costly. Everything else goes in `topics/`.

## Testing

```bash
npm test
```

Unit tests (13): retrieval, markers, memory, request shape, error mapping, handoff, rate limits.

```bash
npm run test:e2e
```

Browser tests (13, Chromium via Playwright): the real widget, server and Anthropic SDK against a local stub of the Messages streaming API. They cover welcome, starters, streaming, links and cards, multi-turn context, copy, keyboard, error and retry, stop, both handoff paths, Tawk live handoff, persistence and reset, contextual starters, mobile, and the teaser. Screenshots are written to `test-results/`.

```bash
npm run eval
```

The live-model evaluation needs `ANTHROPIC_API_KEY` and spends real tokens. It runs 20 scripted conversations (first-time author, KDP, pricing, subscription, both formats, Vellum, unknown integration, KPF, approval guarantee, IngramSpark, gutter and bleed, file formats, covers, ISBN, refund handoff, "am I talking to a person?", memory, off-topic, prompt injection, agency pricing). Each answer is checked against automatic rules: no invented URLs, no approval guarantees, no KPF claims, no robotic phrasing, required facts present. The full transcript is written to `eval-report.md` for a human read of tone.

## Security and privacy

- The API key exists only on the server. CORS is restricted to `ALLOWED_ORIGINS` (plus localhost).
- Per-IP limits default to 12 per minute and 200 per day. Message, history and body size caps apply.
- Prompt-injection resistance comes from the accuracy rules, and is tested in the eval.
- Logs record timing, token usage and cache hits, never message content.
- Conversations live in the visitor's `sessionStorage` and clear when the tab closes.
