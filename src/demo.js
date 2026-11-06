// DEMO_MODE=true: a scripted stand-in for the Claude client so the full widget
// experience (streaming, chips, page cards, handoff) can be previewed without an
// API key. Answers are hand-written from the knowledge base and matched by keyword.
// Never enable this in production.

const REPLIES = [
  {
    match: /\b(person|human|real|team|talk to|refund|invoice|billing|account|login|bug|broken)\b/i,
    text: "That's one for the PublishPro team, since they can look into your account and files directly. Leave your email below and they'll pick it up with this conversation attached.\n[[handoff: Visitor asked for help from the team]]",
  },
  {
    match: /\b(cost|price|pricing|how much|subscription|monthly|pay|plans?|bundle)\b/i,
    text: "No subscription. You pay once per book: **eBook Express is $9** for a Kindle-ready EPUB, and Standard Book runs $29 to $89 depending on page count for the print-ready paperback PDF and cover files. Formatting and previewing are free, with no card needed.\n\nThe latest figures are on the [pricing page](https://publishpro.app/pricing).\n[[suggest: Do I need both plans? | How do bundles work? | Can I preview it for free?]]",
  },
  {
    match: /\b(first book|first-time|don'?t know how|written (a|my) book|what (do|should) i do)\b/i,
    text: "That's a big milestone. The next step is turning the manuscript into publish-ready files: a Kindle-ready EPUB for eBook stores and, if you want print, a paperback PDF.\n\nIs your book still in a Word document?\n[[suggest: It's in Word | I want both eBook and paperback | How much does it cost?]]",
  },
  {
    match: /\b(word|docx?|google docs?)\b/i,
    text: "Perfect. Upload the Word file and PublishPro formats it automatically:\n\n- detects chapters, front and back matter\n- builds a clickable table of contents\n- sets margins, gutter and bleed from your trim size\n\nYou can prepare both the eBook and the paperback from that same manuscript, and preview everything free before paying.\n[[suggest: Which trim size should I pick? | How much does it cost? | Can I start now?]]",
  },
  {
    match: /\b(both|ebook and paperback|kindle (and|&) (paperback|print)|paperback and (kindle|ebook))\b/i,
    text: "Yes. You upload the manuscript once, and PublishPro prepares both the Kindle-ready EPUB and the print-ready paperback from it, keeping the styling in sync. Each format is its own one-time plan (eBook Express and Standard Book).\n\nYou can see the full flow on [how it works](https://publishpro.app/how-it-works).\n[[suggest: How much are both? | Which platforms are supported?]]",
  },
  {
    match: /\b(platforms?|kdp|amazon|ingram\s?spark|apple|kobo|google play|barnes|draft2digital|lulu|bookbaby)\b/i,
    text: "PublishPro formats for Amazon KDP, IngramSpark, Apple Books, Kobo, Google Play Books, Barnes & Noble Press, Draft2Digital, Smashwords, BookBaby and Lulu. Print files are checked against KDP and IngramSpark requirements before you download, though each platform makes the final approval call.\n\nAre you planning an eBook, a paperback, or both?\n[[suggest: Both | Just the eBook | KDP or IngramSpark?]]",
  },
  {
    match: /\b(trim|margin|gutter|bleed|paperback|print|spine)\b/i,
    text: "Pick your trim size and PublishPro works out the margins and inside gutter from your page count, and updates them if the book grows. Bleed stays off for text-only books and switches on for edge-to-edge images. You get a PDF/X-1a interior plus a cover file sized to the exact spine.\n\nFor most novels, **5×8 or 6×9** are the usual choices.\n[[suggest: What's a gutter? | Do you size my cover? | How much is a paperback?]]",
  },
  {
    match: /\b(cover|design(er)?)\b/i,
    text: "Two options. If you already have artwork, PublishPro sizes it for print (spine, bleed, trim) and embeds it in your eBook. If you need a cover made, the in-house human designers create one from scratch, from $199 for an eBook cover or $299 for a full paperback wrap, with about three revision rounds.\n\nDetails are on [custom cover design](https://publishpro.app/product/book-cover-design).\n[[suggest: I already have a cover | What files will I get?]]",
  },
  {
    match: /\b(how does|how it works|work\b|process|steps?)\b/i,
    text: "You upload your Word manuscript, choose a trim size and print settings, and PublishPro formats the whole book in a few minutes: chapters, table of contents, margins and page flow. Then you pick a template, adjust the styling, preview it, and download your EPUB and print PDF.\n\nIt all runs in the browser, so there's nothing to install.\n[[suggest: Can I preview for free? | How much does it cost?]]",
  },
  {
    match: /\b(vellum|atticus|reedsy|kindle create|better than|compare)\b/i,
    text: "It depends on what you need. Vellum is a well-regarded formatter, but it runs only on a Mac. PublishPro works in any browser, checks files against KDP and IngramSpark requirements, and you pay per book.\n\nAre you mainly after eBook formatting or paperback production?\n[[suggest: eBook | Paperback | Both]]",
  },
  {
    match: /\b(kpf|mobi)\b/i,
    text: "PublishPro exports a Kindle-ready EPUB rather than KPF or MOBI. KDP accepts EPUB directly, so that's the file you upload for your Kindle edition.\n[[suggest: Does it work for KDP? | Can I also make a paperback?]]",
  },
  {
    match: /\b(free|try|preview|start)\b/i,
    text: "Yes. You can upload your manuscript, format it and preview the result free, without a credit card. You only pay when you're happy and want to download.\n\nWhen you're ready, you can [start formatting free](https://create.publishpro.app/auth/signup).\n[[suggest: How much does it cost? | What files do I get?]]",
  },
];

const FALLBACK =
  "Happy to help with that. In this preview I'm using scripted answers, so try asking about pricing, eBook or paperback formatting, platforms, covers, or how it works.\n[[suggest: How does PublishPro work? | How much does it cost? | Which platforms are supported?]]";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createDemoClient() {
  return {
    beta: {
      messages: {
        stream(params, opts = {}) {
          const last = [...params.messages].reverse().find((m) => m.role === 'user')?.content || '';
          const reply = (REPLIES.find((r) => r.match.test(last)) || { text: FALLBACK }).text;
          const pieces = reply.match(/[\s\S]{1,6}/g) || [];
          return {
            async *[Symbol.asyncIterator]() {
              await sleep(500); // feel of a real first-token delay
              for (const text of pieces) {
                if (opts.signal?.aborted) {
                  const e = new Error('aborted');
                  e.name = 'AbortError';
                  throw e;
                }
                yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
                await sleep(18);
              }
            },
            finalMessage: async () => ({ stop_reason: 'end_turn', model: 'demo', usage: {} }),
          };
        },
      },
    },
  };
}
