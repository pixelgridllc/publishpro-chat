/*!
 * PublishPro conversational publishing assistant — embeddable widget.
 * Usage:
 *   <script src="https://YOUR-CHAT-HOST/widget.js" defer></script>
 * Optional data attributes on the script tag:
 *   data-api="https://YOUR-CHAT-HOST"   API base (defaults to the script's origin)
 *   data-hide-tawk="false"               keep the Tawk.to launcher visible (default: hidden; Tawk is used for live handoff)
 *   data-teaser="false"                  disable the one-time greeting teaser
 *   data-load-fonts="false"              don't inject Manrope/Marcellus from Google Fonts
 *   data-open="true"                     open on load (previews)
 * Public API: window.PublishProChat.open() / .close() / .reset() / .ask(text)
 */
(function () {
  'use strict';
  if (window.PublishProChat && window.PublishProChat.__mounted) return;

  var script = document.currentScript || document.querySelector('script[src*="widget.js"]');
  var ds = (script && script.dataset) || {};
  var API = (ds.api || (script && script.src ? new URL(script.src, location.href).origin : location.origin)).replace(/\/$/, '');
  var HIDE_TAWK = ds.hideTawk !== 'false';
  var TEASER = ds.teaser !== 'false';
  var STORE_KEY = 'pp-chat-v1';
  var MAX_CHARS = 2000;

  // ---------------------------------------------------------------- content
  var PAGES = {
    '/': 'PublishPro home',
    '/how-it-works': 'How it works',
    '/features': 'Features',
    '/pricing': 'Pricing',
    '/product/ebook-formatting': 'eBook formatting',
    '/product/paperback-formatting': 'Paperback formatting',
    '/product/book-cover-design': 'Custom cover design',
    '/solutions/for-self-publishers': 'For self-publishers',
    '/solutions/for-book-designers': 'For book designers',
    '/solutions/for-agencies': 'For publishing agencies',
    '/contact-us': 'Contact us',
    '/blog': 'Blog',
    '/refund-policy': 'Refund policy',
    '/privacy-policy': 'Privacy policy',
    '/terms-and-conditions': 'Terms and conditions',
    '/auth/signup': 'Start formatting free',
    '/auth/login': 'Log in',
  };

  var STARTERS = {
    default: [
      'How do I format my first book?',
      'Create an eBook and paperback',
      'How does PublishPro work?',
      'Which publishing platforms are supported?',
      'Tell me about paperback formatting',
      'I need help with book cover design',
    ],
    '/pricing': [
      'Is it a subscription or a one-time payment?',
      'What does the paperback plan include?',
      'Do I need both plans for eBook and print?',
      'How do bundles work for several books?',
      'Can I try it before paying?',
    ],
    '/product/ebook-formatting': [
      'Can I upload my Word document?',
      'Will it work on Kindle and Apple Books?',
      'Create an eBook and paperback',
      'How much is an eBook?',
      'Can I add my own cover to the eBook?',
    ],
    '/product/paperback-formatting': [
      'Which trim size should I choose?',
      'How are margins and gutter worked out?',
      'Will my file meet KDP print requirements?',
      'Create an eBook and paperback',
      'Do you set up the cover spine too?',
    ],
    '/product/book-cover-design': [
      'How does the cover design process work?',
      'What files will I get?',
      'I already have a cover. Can you format it?',
      'How many revisions are included?',
    ],
    '/solutions/for-agencies': [
      'Can my whole team use one account?',
      'How do bundles and volume discounts work?',
      "Can we keep each client's house style?",
      'Does it integrate with our software?',
    ],
    '/solutions/for-book-designers': [
      'How much typographic control do I get?',
      'Does it handle full-bleed images?',
      'Can I use my own SVG ornaments?',
      'Do the eBook and print versions stay in sync?',
    ],
    '/how-it-works': [
      'How do I format my first book?',
      'Can I preview before paying?',
      'Create an eBook and paperback',
      'What files do I get at the end?',
    ],
  };

  var FOLLOWUPS = [
    'How much does it cost?',
    'Can I preview it for free?',
    'Which trim size should I pick?',
    'Can I make an eBook and paperback?',
    'Do you design covers?',
    'Will it work for KDP?',
  ];

  var GREETING = "Getting a book ready for publishing? Tell me a little about it and I'll help you figure out the next step.";

  // ------------------------------------------------------------------ state
  var state = load() || { messages: [], open: false, expanded: false, teaserSeen: false, updated: 0 };
  var streaming = null; // { controller, msg }
  var cache = {}; // message id -> { el, sig }
  var els = {};
  var renderQueued = false;

  function save() {
    try {
      state.updated = Date.now();
      var copy = JSON.parse(JSON.stringify(state));
      copy.messages = copy.messages.filter(function (m) { return !m.pending; }).slice(-60);
      sessionStorage.setItem(STORE_KEY, JSON.stringify(copy));
    } catch (e) { /* storage unavailable: chat still works for this page view */ }
  }
  function load() {
    try {
      var s = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
      if (s && Array.isArray(s.messages)) {
        s.messages.forEach(function (m) { if (m.streaming) { m.streaming = false; if (!m.content) m.error = { message: 'That answer was interrupted.', retryable: true }; } });
        return s;
      }
    } catch (e) {}
    return null;
  }
  function uid() { return Math.random().toString(36).slice(2, 10); }
  function currentPath() {
    var p = location.pathname.replace(/\/$/, '') || '/';
    return p;
  }
  function transcript() {
    return state.messages
      .filter(function (m) { return (m.role === 'user' || m.role === 'assistant') && m.content && !m.error && !m.local; })
      .map(function (m) { return { role: m.role, content: m.content }; });
  }

  // ------------------------------------------------------------------ fonts
  if (ds.loadFonts !== 'false' && !document.querySelector('link[data-pp-fonts]')) {
    var lf = document.createElement('link');
    lf.rel = 'stylesheet';
    lf.setAttribute('data-pp-fonts', '');
    lf.href = 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=Marcellus&display=swap';
    document.head.appendChild(lf);
  }

  // ------------------------------------------------------------------- styles
  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.pp{--bg:#fefaf3;--surface:#fff;--ink:#2f2c25;--ink2:rgba(47,44,37,.78);--muted:rgba(47,44,37,.6);--line:rgba(47,44,37,.12);--line2:rgba(47,44,37,.2);--beige:#f1eadd;--peach:#ffd0a1;--accent:#f15a28;--brown:#603811;--focus:#f15a28;',
    'font-family:Manrope,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}',
    'button,textarea,input{font:inherit;color:inherit}',
    'button{cursor:pointer;border:0;background:none;padding:0}',
    ':focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:6px}',
    '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',

    /* launcher */
    '.launcher{position:fixed;right:24px;bottom:24px;z-index:2;display:flex;align-items:center;gap:10px;height:52px;padding:0 20px 0 16px;border-radius:999px;background:var(--ink);color:#fefaf3;font-weight:600;font-size:15px;box-shadow:0 10px 30px rgba(47,44,37,.22),0 2px 6px rgba(47,44,37,.12);transition:transform .2s ease,box-shadow .2s ease}',
    '.launcher:hover{transform:translateY(-1px);box-shadow:0 14px 34px rgba(47,44,37,.26),0 2px 6px rgba(47,44,37,.12)}',
    '.launcher svg{width:20px;height:20px;flex:none}',
    '.launcher.is-open{width:52px;padding:0;justify-content:center}',
    '.launcher.is-open .l-label{display:none}',
    '.teaser{position:fixed;right:24px;bottom:88px;z-index:2;max-width:300px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px 38px 14px 16px;box-shadow:0 12px 32px rgba(47,44,37,.14);font-size:14px;color:var(--ink);animation:rise .35s ease both}',
    '.teaser button.t-open{text-align:left;display:block;width:100%}',
    '.teaser .t-x{position:absolute;top:8px;right:8px;width:26px;height:26px;border-radius:8px;display:grid;place-items:center;color:var(--muted)}',
    '.teaser .t-x:hover{background:var(--beige)}',

    /* panel */
    '.panel{position:fixed;right:24px;bottom:88px;z-index:3;width:400px;height:min(680px,calc(100vh - 112px));height:min(680px,calc(100dvh - 112px));display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--line);border-radius:18px;box-shadow:0 24px 60px rgba(47,44,37,.18),0 4px 14px rgba(47,44,37,.08);overflow:hidden;transform-origin:bottom right;animation:pop .22s cubic-bezier(.2,.8,.2,1) both}',
    '.panel[hidden]{display:none}',
    '.panel.is-expanded{width:min(720px,calc(100vw - 48px));height:calc(100vh - 112px);height:calc(100dvh - 112px)}',
    '@keyframes pop{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}',
    '@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',

    '.head{display:flex;align-items:center;gap:8px;padding:14px 12px 12px 20px;border-bottom:1px solid var(--line);background:var(--bg)}',
    '.brand{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.2}',
    '.brand .name{font-family:Marcellus,Georgia,serif;font-size:19px;letter-spacing:.005em}',
    '.brand .name b{font-weight:400;color:var(--accent)}',
    '.brand .sub{font-size:12.5px;color:var(--muted);margin-top:2px}',
    '.icon-btn{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;color:var(--ink2);transition:background .15s}',
    '.icon-btn:hover{background:var(--beige);color:var(--ink)}',
    '.icon-btn svg{width:18px;height:18px}',
    '.icon-btn[hidden]{display:none}',

    '.body{flex:1;overflow-y:auto;overscroll-behavior:contain;scroll-behavior:smooth;position:relative}',
    '.welcome{padding:28px 22px 12px}',
    '.welcome h2{font-family:Marcellus,Georgia,serif;font-weight:400;font-size:28px;line-height:1.18;margin:0 0 10px;letter-spacing:-.005em;color:var(--ink)}',
    '.welcome h2 em{font-style:normal;color:var(--accent)}',
    '.welcome p{margin:0 0 22px;color:var(--ink2);font-size:15px}',
    '.label{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 8px}',
    '.starters{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}',
    '.starter{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;text-align:left;padding:11px 14px;border:1px solid var(--line);border-radius:12px;background:var(--surface);font-weight:500;font-size:14.5px;transition:border-color .15s,background .15s,transform .15s}',
    '.starter:hover{border-color:var(--line2);background:#fffdf9}',
    '.starter svg{width:16px;height:16px;flex:none;color:var(--muted);transition:transform .15s,color .15s}',
    '.starter:hover svg{transform:translateX(2px);color:var(--accent)}',

    '.log{padding:18px 20px 8px;display:flex;flex-direction:column;gap:18px}',
    '.msg{max-width:100%}.msg.enter{animation:rise .25s ease both}',
    '.msg.user{align-self:flex-end;max-width:86%;background:var(--beige);border-radius:16px 16px 4px 16px;padding:10px 14px;white-space:pre-wrap;word-wrap:break-word}',
    '.msg.assistant{align-self:stretch}',
    '.msg.note{align-self:center;font-size:13px;color:var(--muted);text-align:center}',
    '.md p{margin:0 0 10px}.md p:last-child{margin-bottom:0}',
    '.md ul,.md ol{margin:0 0 10px;padding-left:20px}.md li{margin:3px 0}.md li::marker{color:var(--muted)}',
    '.md a{color:var(--brown);text-decoration:underline;text-decoration-color:rgba(96,56,17,.35);text-underline-offset:3px;font-weight:600}',
    '.md a:hover{text-decoration-color:var(--brown)}',
    '.md strong{font-weight:700}',
    '.caret{display:inline-block;width:7px;height:15px;margin-left:2px;vertical-align:-2px;background:var(--accent);border-radius:1px;animation:blink 1s steps(2) infinite}',
    '@keyframes blink{50%{opacity:0}}',
    '.typing{display:inline-flex;gap:5px;padding:6px 0}',
    '.typing i{width:7px;height:7px;border-radius:50%;background:var(--muted);animation:dot 1.2s infinite ease-in-out}',
    '.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}',
    '@keyframes dot{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}',

    '.card{display:flex;align-items:center;gap:12px;margin-top:12px;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:var(--surface);text-decoration:none;color:var(--ink);transition:border-color .15s}',
    '.card:hover{border-color:var(--line2)}',
    '.card .c-t{flex:1;min-width:0}',
    '.card .c-k{display:block;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600}',
    '.card .c-n{display:block;font-weight:600;font-size:14.5px}',
    '.card svg{width:16px;height:16px;color:var(--accent);flex:none}',

    '.actions{display:flex;gap:4px;margin-top:6px;opacity:.75}',
    '.msg.assistant:hover .actions,.actions:focus-within{opacity:1}',
    '.act{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border-radius:8px;font-size:12.5px;color:var(--muted)}',
    '.act:hover{background:var(--beige);color:var(--ink)}',
    '.act svg{width:14px;height:14px}',

    '.error{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border:1px solid rgba(241,90,40,.35);background:#fff6f1;border-radius:12px;font-size:14px}',
    '.error .e-t{flex:1;min-width:160px}',
    '.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:38px;padding:0 16px;border-radius:10px;font-weight:600;font-size:14px;transition:background .15s,opacity .15s}',
    '.btn.primary{background:var(--ink);color:#fefaf3}.btn.primary:hover{background:#1f1d18}',
    '.btn.ghost{background:var(--beige);color:var(--ink)}.btn.ghost:hover{background:#e9dfcd}',
    '.btn.small{height:32px;padding:0 12px;font-size:13px}',
    '.btn[disabled]{opacity:.5;cursor:default}',

    '.chips{display:flex;flex-wrap:wrap;gap:6px;padding:4px 20px 14px}',
    '.chip{padding:7px 12px;border-radius:999px;border:1px solid var(--line2);background:var(--surface);font-size:13.5px;font-weight:500;text-align:left;transition:border-color .15s,background .15s}',
    '.chip:hover{border-color:var(--ink);background:#fffdf9}',

    '.handoff{border:1px solid var(--line);background:var(--surface);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:10px}',
    '.handoff h3{margin:0;font-size:15px;font-weight:700}',
    '.handoff p{margin:0;color:var(--ink2);font-size:14px}',
    '.field{display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:600;color:var(--ink2)}',
    '.field input,.field textarea{font-weight:400;font-size:15px;color:var(--ink);border:1px solid var(--line2);border-radius:10px;padding:9px 11px;background:var(--bg);outline:none;resize:vertical}',
    '.field input:focus,.field textarea:focus{border-color:var(--ink)}',
    '.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
    '.f-err{color:#b3261e;font-size:13px}',

    '.jump{position:sticky;bottom:8px;margin:0 auto;display:none;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:999px;background:var(--ink);color:#fefaf3;font-size:12.5px;font-weight:600;box-shadow:0 4px 12px rgba(47,44,37,.2)}',
    '.jump.show{display:flex}',

    '.foot{padding:10px 14px 12px;border-top:1px solid var(--line);background:var(--bg)}',
    '.composer{display:flex;align-items:flex-end;gap:8px;padding:8px 8px 8px 14px;border:1px solid var(--line2);border-radius:14px;background:var(--surface);transition:border-color .15s,box-shadow .15s}',
    '.composer:focus-within{border-color:var(--ink);box-shadow:0 0 0 3px rgba(47,44,37,.06)}',
    '.composer textarea{flex:1;border:0;outline:none;resize:none;background:transparent;font-size:15px;line-height:1.45;padding:7px 0;max-height:140px;min-height:22px}',
    '.composer textarea::placeholder{color:var(--muted)}',
    '.send{width:38px;height:38px;flex:none;border-radius:10px;display:grid;place-items:center;background:var(--ink);color:#fefaf3;transition:background .15s,opacity .15s}',
    '.send:hover{background:#1f1d18}',
    '.send[disabled]{opacity:.35;cursor:default}',
    '.send svg{width:18px;height:18px}',
    '.meta{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px;font-size:12.5px;color:var(--muted);padding:0 4px}',
    '.meta button{color:var(--ink2);font-weight:600;text-decoration:underline;text-decoration-color:var(--line2);text-underline-offset:3px}',
    '.meta button:hover{color:var(--ink)}',
    '.count.warn{color:#b3261e}',

    '@media (max-width:640px){',
    '.launcher{right:16px;bottom:16px}',
    '.teaser{right:16px;bottom:80px;max-width:calc(100vw - 32px)}',
    '.panel,.panel.is-expanded{right:0;left:0;top:0;bottom:auto;width:100%;height:var(--vvh,100dvh);border-radius:0;border:0;transform:translateY(var(--vvt,0px));animation:none}',
    '.launcher.is-open{display:none}',
    '.expand{display:none}',
    '.welcome{padding:22px 18px 8px}.welcome h2{font-size:25px}',
    '.log{padding:16px 16px 8px}.chips{padding:4px 16px 12px}',
    '.composer textarea{font-size:16px}',
    '.foot{padding:8px 10px calc(10px + env(safe-area-inset-bottom))}',
    '}',
    '@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}',
  ].join('');

  // -------------------------------------------------------------------- icons
  var I = {
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>',
    shrink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M10 14l-7 7M14 10l7-7"/></svg>',
    reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  };

  // ----------------------------------------------------------------- markdown
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function linkAttrs(url) {
    var u;
    try { u = new URL(url, location.href); } catch (e) { return null; }
    if (!/^(https?:|mailto:)$/.test(u.protocol)) return null;
    var sameSite = /(^|\.)publishpro\.app$/.test(u.hostname) && u.hostname !== 'create.publishpro.app';
    var onSite = sameSite && (location.hostname === u.hostname || /publishpro\.app$/.test(location.hostname));
    return ' href="' + esc(u.href) + '"' + (onSite || u.protocol === 'mailto:' ? '' : ' target="_blank" rel="noopener noreferrer"');
  }
  function inline(text) {
    var slots = [];
    var hold = function (html) { slots.push(html); return '\u0000' + (slots.length - 1) + '\u0000'; };
    // links first (raw text), then escape everything else
    text = text.replace(/\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g, function (m, label, url) {
      var a = linkAttrs(url);
      return a ? hold('<a' + a + '>' + inlineFmt(esc(label)) + '</a>') : m;
    });
    text = text.replace(/\b(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g, function (m, url) {
      var a = linkAttrs(url);
      var shown = url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
      return a ? hold('<a' + a + '>' + esc(shown) + '</a>') : m;
    });
    text = text.replace(/([\w.+-]+@[\w-]+\.[\w.]+[a-z])/gi, function (m) { return hold('<a href="mailto:' + esc(m) + '">' + esc(m) + '</a>'); });
    var out = inlineFmt(esc(text));
    return out.replace(/\u0000(\d+)\u0000/g, function (m, i) { return slots[+i]; });
  }
  function inlineFmt(s) {
    return s
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(/`([^`\n]+)`/g, '<strong>$1</strong>');
  }
  function markdown(src) {
    var lines = String(src).replace(/\r/g, '').split('\n');
    var html = '';
    var para = [];
    var list = null; // {type, items}
    function flushPara() { if (para.length) { html += '<p>' + para.map(inline).join('<br>') + '</p>'; para = []; } }
    function flushList() { if (list) { html += '<' + list.type + '>' + list.items.map(function (i) { return '<li>' + inline(i) + '</li>'; }).join('') + '</' + list.type + '>'; list = null; } }
    lines.forEach(function (raw) {
      var line = raw.trim();
      var ul = line.match(/^[-*•]\s+(.*)$/);
      var ol = line.match(/^\d{1,2}[.)]\s+(.*)$/);
      var h = line.match(/^#{1,6}\s+(.*)$/);
      if (!line) { flushPara(); flushList(); return; }
      if (ul || ol) {
        flushPara();
        var type = ul ? 'ul' : 'ol';
        if (list && list.type !== type) flushList();
        if (!list) list = { type: type, items: [] };
        list.items.push((ul || ol)[1]);
        return;
      }
      if (list && /^\s{2,}/.test(raw)) { list.items[list.items.length - 1] += ' ' + line; return; }
      flushList();
      para.push(h ? '**' + h[1].replace(/\*\*/g, '') + '**' : line);
    });
    flushPara();
    flushList();
    return html;
  }
  function firstPageLink(text) {
    var re = /https?:\/\/(?:www\.|create\.)?publishpro\.app(\/[^\s)\]"'<>]*)?/g;
    var m;
    while ((m = re.exec(text))) {
      var p = (m[1] || '/').replace(/[.,;:!?]+$/, '').replace(/\/$/, '') || '/';
      if (PAGES[p] && p !== currentPath() && p !== '/') return { url: m[0].replace(/[.,;:!?]+$/, ''), title: PAGES[p], path: p };
    }
    return null;
  }

  // -------------------------------------------------------------------- mount
  var host = document.createElement('div');
  host.id = 'publishpro-chat';
  host.style.cssText = 'position:fixed;z-index:2147483000;inset:auto 0 0 auto;width:0;height:0';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' + CSS + '</style>' +
    '<div class="pp">' +
    '<div class="teaser" hidden role="status"><button class="t-open" type="button"></button><button class="t-x" type="button" aria-label="Dismiss">' + I.close + '</button></div>' +
    '<section class="panel" hidden role="dialog" aria-label="PublishPro publishing help" aria-modal="false">' +
    '<header class="head">' +
    '<div class="brand"><span class="name">Publish<b>Pro</b></span><span class="sub">Publishing help for your book</span></div>' +
    '<button class="icon-btn reset" type="button" aria-label="Start a new conversation" title="New conversation" hidden>' + I.reset + '</button>' +
    '<button class="icon-btn expand" type="button" aria-label="Expand chat" title="Expand">' + I.expand + '</button>' +
    '<button class="icon-btn close" type="button" aria-label="Close chat" title="Close">' + I.close + '</button>' +
    '</header>' +
    '<div class="body" tabindex="-1">' +
    '<div class="welcome">' +
    '<h2>Let’s get your book <em>ready for publishing.</em></h2>' +
    '<p>Whether you’re formatting your first book or preparing multiple titles, let’s figure out what you need.</p>' +
    '<p class="label" id="pp-starters-label">Popular questions</p>' +
    '<ul class="starters" aria-labelledby="pp-starters-label"></ul>' +
    '</div>' +
    '<div class="log" role="log" aria-label="Conversation"></div>' +
    '<div class="chips" role="group" aria-label="Suggested replies"></div>' +
    '<button class="jump" type="button">' + I.down + 'Latest</button>' +
    '</div>' +
    '<footer class="foot">' +
    '<form class="composer" novalidate>' +
    '<label class="sr" for="pp-input">Your message</label>' +
    '<textarea id="pp-input" rows="1" maxlength="' + MAX_CHARS + '" placeholder="Ask anything about formatting or publishing your book..." enterkeyhint="send"></textarea>' +
    '<button class="send" type="submit" aria-label="Send message" disabled>' + I.send + '</button>' +
    '</form>' +
    '<div class="meta"><button type="button" class="human">Talk to the team</button><span class="count" aria-live="polite"></span></div>' +
    '</footer>' +
    '<div class="sr" aria-live="polite" aria-atomic="true" id="pp-announce"></div>' +
    '</section>' +
    '<button class="launcher" type="button" aria-expanded="false" aria-controls="pp-panel">' + I.chat + '<span class="l-label">Ask about your book</span></button>' +
    '</div>';

  var $ = function (sel) { return root.querySelector(sel); };
  els = {
    panel: $('.panel'), launcher: $('.launcher'), teaser: $('.teaser'), body: $('.body'), welcome: $('.welcome'),
    starters: $('.starters'), log: $('.log'), chips: $('.chips'), jump: $('.jump'), form: $('.composer'),
    input: $('#pp-input'), send: $('.send'), reset: $('.reset'), expand: $('.expand'), close: $('.close'),
    human: $('.human'), count: $('.count'), announce: $('#pp-announce'),
  };
  els.panel.id = 'pp-panel';

  function mount() {
    if (!document.body) return setTimeout(mount, 30);
    document.body.appendChild(host);
    init();
  }

  // ------------------------------------------------------------------ render
  function renderStarters() {
    var list = STARTERS[currentPath()] || STARTERS.default;
    els.starters.innerHTML = '';
    list.forEach(function (q) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'starter';
      b.innerHTML = '<span>' + esc(q) + '</span>' + I.arrow;
      b.addEventListener('click', function () { ask(q); });
      li.appendChild(b);
      els.starters.appendChild(li);
    });
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () { renderQueued = false; render(); });
  }

  function render() {
    var hasMsgs = state.messages.length > 0;
    els.welcome.hidden = hasMsgs;
    els.reset.hidden = !hasMsgs;
    var stick = nearBottom();
    // Keyed render: only messages whose visible state changed are rebuilt, and only
    // brand-new messages get the entrance animation.
    var keep = {};
    state.messages.forEach(function (m, idx) {
      var isLast = idx === state.messages.length - 1;
      var sig = JSON.stringify([m.content, !!m.streaming, m.error && m.error.message, m.status, m.error ? isLast : 0]);
      var entry = cache[m.id];
      if (!entry || entry.sig !== sig) {
        var el = renderMessage(m, isLast);
        if (!entry) el.classList.add('enter');
        if (entry && entry.el.parentNode) entry.el.parentNode.replaceChild(el, entry.el);
        entry = cache[m.id] = { el: el, sig: sig };
      }
      keep[m.id] = true;
      var at = els.log.children[idx];
      if (at !== entry.el) els.log.insertBefore(entry.el, at || null);
    });
    Object.keys(cache).forEach(function (id) {
      if (!keep[id]) { if (cache[id].el.parentNode) cache[id].el.remove(); delete cache[id]; }
    });
    els.log.setAttribute('aria-busy', streaming ? 'true' : 'false');
    renderChips();
    updateComposer();
    if (stick) scrollToBottom();
    else updateJump();
  }

  function renderMessage(m, isLast) {
    var el = document.createElement('div');
    if (m.role === 'user') {
      el.className = 'msg user';
      el.textContent = m.content;
      return el;
    }
    if (m.role === 'note') {
      el.className = 'msg note';
      el.textContent = m.content;
      return el;
    }
    if (m.role === 'handoff') {
      el.className = 'msg assistant';
      el.appendChild(renderHandoff(m));
      return el;
    }
    el.className = 'msg assistant';
    if (m.error) {
      var err = document.createElement('div');
      err.className = 'error';
      err.setAttribute('role', 'alert');
      err.innerHTML = '<span class="e-t">' + esc(m.error.message) + '</span>';
      if (m.error.retryable && isLast) {
        var r = document.createElement('button');
        r.type = 'button';
        r.className = 'btn ghost small';
        r.innerHTML = I.retry + 'Try again';
        r.addEventListener('click', retry);
        err.appendChild(r);
      }
      if (m.content) {
        var partial = document.createElement('div');
        partial.className = 'md';
        partial.innerHTML = markdown(m.content);
        el.appendChild(partial);
      }
      el.appendChild(err);
      return el;
    }
    var md = document.createElement('div');
    md.className = 'md';
    if (!m.content && m.streaming) {
      md.innerHTML = '<span class="typing" aria-label="Writing a reply"><i></i><i></i><i></i></span>';
    } else {
      md.innerHTML = markdown(m.content) || '';
      if (m.streaming) {
        var last = md.lastElementChild || md;
        var target = last.tagName === 'UL' || last.tagName === 'OL' ? last.lastElementChild || last : last;
        target.insertAdjacentHTML('beforeend', '<span class="caret" aria-hidden="true"></span>');
      }
    }
    el.appendChild(md);
    if (!m.streaming && m.content) {
      var page = firstPageLink(m.content);
      if (page) {
        var a = document.createElement('a');
        a.className = 'card';
        a.innerHTML = '<span class="c-t"><span class="c-k">' + (page.path.indexOf('/auth/') === 0 ? 'Get started' : 'Recommended page') + '</span><span class="c-n">' + esc(page.title) + '</span></span>' + I.arrow;
        var attrs = linkAttrs(page.url);
        a.href = new URL(page.url).href;
        if (/target=/.test(attrs)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
        el.appendChild(a);
      }
      var actions = document.createElement('div');
      actions.className = 'actions';
      var copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'act';
      copy.innerHTML = I.copy + '<span>Copy</span>';
      copy.addEventListener('click', function () { copyText(m.content, copy); });
      actions.appendChild(copy);
      el.appendChild(actions);
    }
    return el;
  }

  function renderChips() {
    els.chips.innerHTML = '';
    var last = state.messages[state.messages.length - 1];
    if (streaming || !last || last.role !== 'assistant' || last.error || last.streaming) return;
    var asked = state.messages.filter(function (m) { return m.role === 'user'; }).map(function (m) { return m.content.toLowerCase(); });
    var list = (last.suggestions && last.suggestions.length ? last.suggestions : FOLLOWUPS)
      .filter(function (s) { return asked.indexOf(s.toLowerCase()) === -1; })
      .slice(0, 3);
    list.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = s;
      b.addEventListener('click', function () { ask(s); });
      els.chips.appendChild(b);
    });
  }

  function renderHandoff(m) {
    var box = document.createElement('div');
    box.className = 'handoff';
    if (m.status === 'sent') {
      box.innerHTML = '<h3>Sent to the PublishPro team</h3><p>' + esc(m.result || '') + '</p>';
      return box;
    }
    if (m.status === 'live') {
      box.innerHTML = '<h3>Live chat opened</h3><p>You’re now chatting with the PublishPro team in the chat window. We passed along what you’ve told us so far.</p>';
      return box;
    }
    if (m.status === 'failed') {
      var mail = mailtoLink(m);
      box.innerHTML = '<h3>Let’s use email instead</h3><p>We couldn’t send that automatically. Email the team at <a href="mailto:support@publishpro.app">support@publishpro.app</a> and they’ll pick it up from there. We’ve drafted the message with your conversation included.</p>';
      var row = document.createElement('div');
      row.className = 'row';
      var a = document.createElement('a');
      a.className = 'btn primary';
      a.href = mail;
      a.textContent = 'Open email draft';
      row.appendChild(a);
      box.appendChild(row);
      return box;
    }
    var live = tawkOnline();
    box.innerHTML =
      '<h3>Talk to the PublishPro team</h3>' +
      '<p>' + (live ? 'The team is online now, or leave your email and they’ll get back to you.' : 'Leave your email and the team will get back to you. They’ll see this conversation, so you won’t need to repeat yourself.') + '</p>';
    if (live) {
      var lr = document.createElement('div');
      lr.className = 'row';
      var lb = document.createElement('button');
      lb.type = 'button';
      lb.className = 'btn primary';
      lb.textContent = 'Chat with the team now';
      lb.addEventListener('click', function () { openLiveChat(m); });
      lr.appendChild(lb);
      box.appendChild(lr);
    }
    var form = document.createElement('form');
    form.noValidate = true;
    form.style.cssText = 'display:flex;flex-direction:column;gap:10px';
    form.innerHTML =
      '<label class="field">Name (optional)<input name="name" autocomplete="name" maxlength="120"></label>' +
      '<label class="field">Email<input name="email" type="email" autocomplete="email" required maxlength="254" inputmode="email"></label>' +
      '<label class="field">Anything the team should know? (optional)<textarea name="message" rows="3" maxlength="2000" placeholder="What happened, which platform, any error message"></textarea></label>' +
      '<div class="f-err" role="alert" hidden></div>' +
      '<div class="row"><button class="btn ' + (live ? 'ghost' : 'primary') + '" type="submit">Send to the team</button><button class="act cancel" type="button">Not now</button></div>';
    form.elements.message.value = m.note || '';
    form.elements.email.value = m.email || '';
    form.elements.name.value = m.name || '';
    form.addEventListener('input', function () {
      m.name = form.elements.name.value;
      m.email = form.elements.email.value;
      m.note = form.elements.message.value;
    });
    form.addEventListener('submit', function (e) { e.preventDefault(); submitHandoff(m, form); });
    form.querySelector('.cancel').addEventListener('click', function () {
      m.status = 'dismissed';
      state.messages = state.messages.filter(function (x) { return x !== m; });
      save();
      render();
    });
    box.appendChild(form);
    return box;
  }

  function updateComposer() {
    var v = els.input.value;
    var busy = !!streaming;
    els.send.disabled = !busy && !v.trim();
    els.send.innerHTML = busy ? I.stop : I.send;
    els.send.setAttribute('aria-label', busy ? 'Stop generating' : 'Send message');
    els.send.type = busy ? 'button' : 'submit';
    var n = v.length;
    els.count.textContent = n > MAX_CHARS - 300 ? n + ' / ' + MAX_CHARS : '';
    els.count.className = 'count' + (n >= MAX_CHARS ? ' warn' : '');
  }

  function autosize() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 140) + 'px';
  }

  function nearBottom() {
    var b = els.body;
    return b.scrollHeight - b.scrollTop - b.clientHeight < 80;
  }
  function scrollToBottom() {
    els.body.scrollTop = els.body.scrollHeight;
    updateJump();
  }
  function updateJump() {
    els.jump.classList.toggle('show', state.messages.length > 0 && !nearBottom());
  }

  function announce(text) {
    els.announce.textContent = '';
    setTimeout(function () { els.announce.textContent = text.length > 600 ? text.slice(0, 600) + '…' : text; }, 50);
  }

  function copyText(text, btn) {
    var done = function () {
      btn.innerHTML = I.check + '<span>Copied</span>';
      setTimeout(function () { btn.innerHTML = I.copy + '<span>Copy</span>'; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
    function fallback() {
      var t = document.createElement('textarea');
      t.value = text;
      t.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(t);
      t.select();
      try { document.execCommand('copy'); done(); } catch (e) {}
      t.remove();
    }
  }

  // --------------------------------------------------------------- open/close
  var isMobile = function () { return window.matchMedia('(max-width: 640px)').matches; };
  var savedOverflow = '';

  function open(opts) {
    hideTeaser(true);
    if (!els.panel.hidden) return;
    els.panel.hidden = false;
    els.panel.classList.toggle('is-expanded', !!state.expanded);
    els.expand.innerHTML = state.expanded ? I.shrink : I.expand;
    els.launcher.classList.add('is-open');
    els.launcher.innerHTML = I.close + '<span class="l-label">Close</span>';
    els.launcher.setAttribute('aria-expanded', 'true');
    els.launcher.setAttribute('aria-label', 'Close chat');
    if (isMobile()) {
      els.panel.setAttribute('aria-modal', 'true');
      savedOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      syncViewport();
    }
    state.open = true;
    save();
    render();
    autosize();
    if (state.messages.length) scrollToBottom();
    else els.body.scrollTop = 0;
    if (!(opts && opts.noFocus)) setTimeout(function () { els.input.focus({ preventScroll: true }); }, 30);
  }

  function close() {
    if (els.panel.hidden) return;
    els.panel.hidden = true;
    els.panel.setAttribute('aria-modal', 'false');
    els.launcher.classList.remove('is-open');
    els.launcher.innerHTML = I.chat + '<span class="l-label">Ask about your book</span>';
    els.launcher.setAttribute('aria-expanded', 'false');
    els.launcher.removeAttribute('aria-label');
    document.documentElement.style.overflow = savedOverflow;
    state.open = false;
    save();
    els.launcher.focus();
  }

  function syncViewport() {
    var vv = window.visualViewport;
    if (!vv || !isMobile()) { els.panel.style.removeProperty('--vvh'); els.panel.style.removeProperty('--vvt'); return; }
    els.panel.style.setProperty('--vvh', vv.height + 'px');
    els.panel.style.setProperty('--vvt', vv.offsetTop + 'px');
    if (nearBottom()) scrollToBottom();
  }

  function showTeaser() {
    if (!TEASER || state.teaserSeen || state.messages.length || !els.panel.hidden) return;
    els.teaser.querySelector('.t-open').textContent = GREETING;
    els.teaser.hidden = false;
  }
  function hideTeaser(seen) {
    els.teaser.hidden = true;
    if (seen) { state.teaserSeen = true; save(); }
  }

  // -------------------------------------------------------------- messaging
  function ask(text) {
    text = String(text || '').trim().slice(0, MAX_CHARS);
    if (!text || streaming) return;
    if (els.panel.hidden) open({ noFocus: true });
    // Drop a trailing error bubble: the new message supersedes it.
    var last = state.messages[state.messages.length - 1];
    if (last && last.role === 'assistant' && last.error && !last.content) state.messages.pop();
    state.messages.push({ id: uid(), role: 'user', content: text });
    els.input.value = '';
    autosize();
    send();
  }

  function retry() {
    var last = state.messages[state.messages.length - 1];
    if (last && last.role === 'assistant' && last.error) state.messages.pop();
    send();
  }

  function stop() {
    if (streaming) streaming.controller.abort();
  }

  function send() {
    var msg = { id: uid(), role: 'assistant', content: '', streaming: true };
    state.messages.push(msg);
    var controller = new AbortController();
    streaming = { controller: controller, msg: msg };
    render();
    scrollToBottom();

    var payload = { messages: transcript(), page: { path: currentPath(), title: document.title } };
    var timeout = setTimeout(function () { controller.abort('timeout'); }, 90000);

    fetch(API + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .then(function (res) {
        if (res.status === 429) return res.json().then(function (j) { throw { info: (j && j.error) || { message: 'Please wait a moment.', retryable: true } }; });
        if (!res.ok || !res.body) throw { info: { message: "Couldn't get an answer just now. Please try again.", retryable: true } };
        return readSSE(res.body, function (event, data) {
          if (event === 'delta') { msg.content += data.text; scheduleRender(); }
          else if (event === 'reset') { msg.content = ''; scheduleRender(); }
          else if (event === 'meta') { msg.profile = data.profile; }
          else if (event === 'done') {
            msg.suggestions = data.suggestions || [];
            if (data.handoff) msg.handoffReason = data.handoff.reason;
          } else if (event === 'error') { throw { info: data }; }
        });
      })
      .then(function () {
        if (!msg.content) throw { info: { message: "Couldn't get an answer just now. Please try again.", retryable: true } };
        finish();
        if (msg.handoffReason) startHandoff(msg.handoffReason);
        announce(msg.content);
      })
      .catch(function (err) {
        var aborted = controller.signal.aborted && controller.signal.reason !== 'timeout';
        if (aborted) {
          if (!msg.content) state.messages.splice(state.messages.indexOf(msg), 1);
          else msg.content += '…';
          finish();
          return;
        }
        var info = (err && err.info) || { message: navigator.onLine === false ? "You seem to be offline. Check your connection and try again." : "Couldn't get an answer just now. Please try again.", retryable: true };
        msg.error = { message: info.message, retryable: info.retryable !== false };
        finish();
        announce(info.message);
      });

    function finish() {
      clearTimeout(timeout);
      msg.streaming = false;
      streaming = null;
      save();
      render();
    }
  }

  function readSSE(body, onEvent) {
    var reader = body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return;
        buf += decoder.decode(r.value, { stream: true });
        var idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          var chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          var event = 'message';
          var data = '';
          chunk.split('\n').forEach(function (line) {
            if (line.indexOf('event:') === 0) event = line.slice(6).trim();
            else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
          });
          if (data) onEvent(event, JSON.parse(data));
        }
        return pump();
      });
    }
    return pump();
  }

  function reset() {
    stop();
    state.messages = [];
    save();
    els.input.value = '';
    autosize();
    render();
    els.body.scrollTop = 0;
    els.input.focus();
  }

  // ---------------------------------------------------------------- handoff
  function latestProfile() {
    for (var i = state.messages.length - 1; i >= 0; i--) if (state.messages[i].profile) return state.messages[i].profile;
    return {};
  }

  function startHandoff(reason) {
    var existing = state.messages.filter(function (m) { return m.role === 'handoff' && (!m.status || m.status === 'open'); })[0];
    if (existing) { scrollToBottom(); return; }
    state.messages.push({ id: uid(), role: 'handoff', status: 'open', reason: reason || '' });
    save();
    render();
    scrollToBottom();
  }

  function submitHandoff(m, form) {
    var errEl = form.querySelector('.f-err');
    var email = form.elements.email.value.trim();
    m.name = form.elements.name.value.trim();
    m.email = email;
    m.note = form.elements.message.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      errEl.textContent = 'Please enter a valid email address so the team can reply.';
      errEl.hidden = false;
      form.elements.email.focus();
      return;
    }
    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    fetch(API + '/api/handoff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: m.name, email: email, message: m.note, reason: m.reason, page: currentPath(), profile: latestProfile(), transcript: transcript() }),
    })
      .then(function (r) { return r.ok ? r.json() : { delivered: false }; })
      .catch(function () { return { delivered: false }; })
      .then(function (res) {
        if (res.delivered) {
          m.status = 'sent';
          m.result = 'Thanks' + (m.name ? ', ' + m.name : '') + '. The team has your message and this conversation, and they’ll reply to ' + email + '.';
        } else if (tawkReady()) {
          // Fall back to the site's existing Tawk.to channel (which also supports offline messages).
          openLiveChat(m);
          return;
        } else {
          m.status = 'failed';
        }
        save();
        render();
        announce(m.status === 'sent' ? m.result : 'We couldn’t send that automatically. You can email support@publishpro.app.');
      });
  }

  function handoffSummary(m) {
    var p = latestProfile();
    var facts = Object.keys(p).map(function (k) { return k + ': ' + p[k]; }).join('; ');
    return ((m.reason || 'Visitor asked to talk to the team') + (facts ? ' | ' + facts : '')).slice(0, 250);
  }

  function mailtoLink(m) {
    var lines = transcript().map(function (x) { return (x.role === 'user' ? 'Me: ' : 'PublishPro: ') + x.content; });
    var body = (m.note ? m.note + '\n\n' : '') + '--- Conversation so far ---\n' + lines.join('\n\n');
    return 'mailto:support@publishpro.app?subject=' + encodeURIComponent('Question about my book') + '&body=' + encodeURIComponent(body.slice(0, 1800));
  }

  // Tawk.to (PublishPro's existing live chat) — used for live human handoff.
  function tawk() { return window.Tawk_API && typeof window.Tawk_API.maximize === 'function' ? window.Tawk_API : null; }
  function tawkReady() { return !!tawk(); }
  function tawkOnline() {
    var t = tawk();
    try { return !!t && typeof t.getStatus === 'function' && t.getStatus() === 'online'; } catch (e) { return false; }
  }
  function openLiveChat(m) {
    var t = tawk();
    if (!t) { m.status = 'failed'; save(); render(); return; }
    var attrs = {};
    if (m.name) attrs.name = m.name;
    if (m.email) attrs.email = m.email;
    var go = function () {
      try {
        if (typeof t.addEvent === 'function') t.addEvent('publishing-assistant-handoff', { summary: handoffSummary(m), page: currentPath() }, function () {});
        if (typeof t.showWidget === 'function') t.showWidget();
        t.maximize();
        m.status = 'live';
      } catch (e) {
        m.status = 'failed';
      }
      save();
      render();
      if (m.status === 'live' && isMobile()) close();
    };
    if (Object.keys(attrs).length && typeof t.setAttributes === 'function') {
      attrs['chat-summary'] = handoffSummary(m);
      try { t.setAttributes(attrs, function () { go(); }); } catch (e) { go(); }
    } else go();
  }
  function setupTawk() {
    if (!HIDE_TAWK) return;
    window.Tawk_API = window.Tawk_API || {};
    var api = window.Tawk_API;
    var prev = api.onLoad;
    var hide = function () {
      // Keep a single launcher on the page; Tawk is revealed when a visitor asks for a person.
      var live = state.messages.some(function (m) { return m.role === 'handoff' && m.status === 'live'; });
      if (!live && typeof api.hideWidget === 'function') api.hideWidget();
    };
    api.onLoad = function () {
      try { if (typeof prev === 'function') prev(); } catch (e) {}
      hide();
    };
    if (typeof api.hideWidget === 'function') hide(); // Tawk already loaded
  }

  // ------------------------------------------------------------------ wiring
  function trapFocus(e) {
    if (e.key !== 'Tab' || els.panel.getAttribute('aria-modal') !== 'true') return;
    var f = Array.prototype.filter.call(els.panel.querySelectorAll('button, a[href], textarea, input'), function (x) { return !x.disabled && x.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0];
    var last = f[f.length - 1];
    var active = root.activeElement;
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  function init() {
    renderStarters();
    els.launcher.addEventListener('click', function () { els.panel.hidden ? open() : close(); });
    els.close.addEventListener('click', close);
    els.reset.addEventListener('click', reset);
    els.expand.addEventListener('click', function () {
      state.expanded = !state.expanded;
      els.panel.classList.toggle('is-expanded', state.expanded);
      els.expand.innerHTML = state.expanded ? I.shrink : I.expand;
      els.expand.setAttribute('aria-label', state.expanded ? 'Shrink chat' : 'Expand chat');
      save();
    });
    els.human.addEventListener('click', function () { startHandoff(''); });
    els.jump.addEventListener('click', scrollToBottom);
    els.body.addEventListener('scroll', updateJump, { passive: true });
    els.form.addEventListener('submit', function (e) { e.preventDefault(); ask(els.input.value); });
    els.send.addEventListener('click', function (e) { if (streaming) { e.preventDefault(); stop(); } });
    els.input.addEventListener('input', function () { autosize(); updateComposer(); });
    els.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        if (!streaming) ask(els.input.value);
      }
    });
    els.panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      trapFocus(e);
    });
    els.teaser.querySelector('.t-open').addEventListener('click', function () { open(); });
    els.teaser.querySelector('.t-x').addEventListener('click', function () { hideTeaser(true); });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncViewport);
      window.visualViewport.addEventListener('scroll', syncViewport);
    }
    window.addEventListener('resize', function () {
      if (!els.panel.hidden) {
        els.panel.setAttribute('aria-modal', isMobile() ? 'true' : 'false');
        syncViewport();
      }
    });
    setupTawk();
    render();

    var recent = Date.now() - (state.updated || 0) < 30 * 60 * 1000;
    if (ds.open === 'true') open({ noFocus: true });
    else if (state.open && recent && !isMobile()) open({ noFocus: true });
    else if (TEASER && !state.teaserSeen) setTimeout(showTeaser, 8000);
  }

  window.PublishProChat = {
    __mounted: true,
    open: function () { open(); },
    close: close,
    reset: reset,
    ask: function (t) { open({ noFocus: true }); ask(t); },
  };
  mount();
})();
