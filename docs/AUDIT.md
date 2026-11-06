# Research and audit (6 November 2026)

## 1. PublishPro: what the website actually says

Pages reviewed: home, features, how-it-works, pricing, the three product pages (eBook, paperback, cover design), the three solution pages (self-publishers, book designers, agencies), contact, blog index plus 20 articles, refund policy, privacy policy, and terms. The site is built on Framer; the app lives at create.publishpro.app.

Most important facts, now encoded in `knowledge/`:

- **Pricing is pay-once-per-book, not a subscription.** eBook Express is $9 (EPUB). Standard Book is $29 to $89 by page count (PDF/X-1a interior plus KDP and IngramSpark cover files, with 8 extra pages free). Bundles are $24 per paperback and $7.50 per eBook with 20 to 35% volume discounts and a one-year rollover. Custom covers are $199, $299, $399 or $49. Formatting and preview are free with no card. Source: the pricing page's structured data, dated 2026-10-08. The visible plan cards load in an iframe from create.publishpro.app/plans, so check those match.
- **Input is DOC/DOCX.** Google Docs is mentioned; the assistant tells people to download as .docx.
- **Outputs are a reflowable EPUB and a PDF/X-1a with CMYK, embedded fonts, and cover files.**
- **Platforms:** KDP, IngramSpark, Apple Books, Kobo, Google Play Books, Barnes & Noble Press, Draft2Digital, Smashwords, BookBaby and Lulu.
- **Brand promises:** a rule-based formatting engine (not AI), manuscripts are never used to train AI, authors own their work, and covers are human-designed.
- **Brand look:** cream `#fefaf3`, ink `#2f2c25`, brown `#603811`, orange `#f15a28`/`#ff3c00`, beige `#f1eadd`. Fonts are Marcellus (headings) and Manrope (text); buttons are dark ink with an 8 to 12px radius.

### Where the brief differs from the website

| Brief said | Website shows | What the assistant does |
|---|---|---|
| "KPF and print-ready PDF exports" | KPF appears only as a format Amazon accepts; outputs are EPUB and PDF/X-1a | Never claims KPF export; explains EPUB is what goes to KDP |
| "Subscription" pricing questions | "Is this a subscription? No. Pay once per book." Bundles can be monthly. | Explains pay-per-book and quotes published prices with the pricing link |
| Direct to pricing page rather than state prices | Prices are published on the site | Quotes published prices (not invented) and points to the page to confirm |
| Never promise approval | Site copy says "Zero rejections" and "Yes" to "Will my file pass on the first try?" | Says exports are checked against KDP and IngramSpark requirements; the platform decides. **Worth aligning the site copy too.** |
| Multi-device previews | eBook preview shows Kindle devices and EPUB readers | Phrased exactly that way |
| Book coaches | Not named on the site | Treated like ghostwriters; no special claims |

### Content inconsistencies spotted on the site (for the PublishPro team)

- The home FAQ says Word **and Google Docs** uploads; the pricing FAQ says DOC/DOCX only.
- The refund policy talks about subscriptions and monthly or annual tiers; the pricing FAQ says "not a subscription".
- The agencies page has an unexplained "Coming soon" label.
- The site's "Zero rejected files" and "first try" claims conflict with not guaranteeing approval.

## 2. The existing chatbot

The current chat is a **Tawk.to** widget (property `693a9ee5fc8f39198374aeef`, widget `1jul7rpab`), injected by a Framer custom-code snippet. There is no chatbot codebase. Greeting, any Tawk AI Assist configuration, knowledge, routing and lead capture all live in the Tawk dashboard, which couldn't be inspected from here. Tawk's runtime also refused to load in the headless test browser.

Limitations of that approach, compared with what the brief asks for:

- **Generic look.** The vendor widget doesn't match the brand's typography or visual language.
- **No grounding.** There's no PublishPro-specific knowledge base, prompt architecture or accuracy rules under PublishPro's control.
- **No context.** Nothing carries page awareness, visitor memory or conversion paths into PublishPro's pages.

What was kept, and why: Tawk remains the human channel. Agents keep their existing inbox, and visitors who ask for a person are handed into Tawk with their name, email and a context summary via Tawk's JavaScript API (`setAttributes`, `addEvent`, `maximize`). Tawk's launcher is hidden by default so there's one chat button.

To check in the Tawk dashboard:

- Whether an AI Assist bot is enabled. If so, disable it to avoid two automated voices.
- That the custom attribute key `chat-summary` is acceptable.
- That the "publishing-assistant-handoff" event appears in agent views.

## 3. Relume: what was taken (and what wasn't)

Relume's stylesheet CDN was blocked from this environment and its builder chat sits behind login, so the review drew on the homepage structure and copy. Patterns adopted:

- **Prompt-first welcome:** one strong heading, short reassurance, and a prominent composer.
- **Quiet example prompts** as the entry point, instead of menus.
- **Restrained chrome:** neutral surfaces, one primary action, generous spacing, no decorative gradients.
- **Guided next steps:** suggestion chips after each answer, and outcome-oriented cards.

None of Relume's branding, colours, fonts or copy were used. The visual identity is PublishPro's own.

## 4. Verification status

| Area | Status |
|---|---|
| Unit tests (13) | Pass |
| Browser end-to-end tests (13; real widget, server and SDK, stub model API) | Pass |
| Widget injected into live publishpro.app/pricing (desktop and iPhone 13) | Renders and works; CORS, styling isolation and contextual starters verified |
| **Real model answers** | **Not yet run.** No Anthropic API key was available in the build environment. Run `npm run eval` with a key before launch. |
| Real Tawk.to handoff | Tested against a stub of Tawk's JS API; verify once on the live site with an agent online and offline |
| Support webhook | Tested with a local webhook; needs a real `SUPPORT_WEBHOOK_URL` (helpdesk or Zapier) |
