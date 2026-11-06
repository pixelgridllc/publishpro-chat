// Lightweight visitor "memory": facts picked up from what the visitor has
// said, so the model never re-asks them and the UI/handoff can use them.
// The full transcript is also sent every turn; this is a compact summary on top.

const has = (text, re) => re.test(text);

const PLATFORMS = [
  ['Amazon KDP', /\b(kdp|amazon|kindle direct)\b/i],
  ['IngramSpark', /\bingram\s?spark|\bingram\b/i],
  ['Apple Books', /\bapple books?\b|\bibooks\b/i],
  ['Kobo', /\bkobo\b/i],
  ['Google Play Books', /\bgoogle play\b/i],
  ['Barnes & Noble Press', /\bbarnes|\bb&n\b|\bnook\b/i],
  ['Draft2Digital', /\bdraft2digital|\bd2d\b/i],
  ['Lulu', /\blulu\b/i],
  ['BookBaby', /\bbook\s?baby\b/i],
  ['Smashwords', /\bsmashwords\b/i],
];

const BOOK_TYPES = [
  ["children's book", /\b(children'?s|kids'?|picture book)\b/i],
  ['memoir', /\bmemoir\b/i],
  ['poetry', /\bpoe(try|ms?)\b/i],
  ['cookbook', /\bcook\s?book|recipes?\b/i],
  ['academic / textbook', /\b(academic|textbook|thesis|dissertation|footnotes?)\b/i],
  ['fantasy', /\bfantasy\b/i],
  ['romance', /\bromance\b/i],
  ['thriller / mystery', /\b(thriller|mystery|crime)\b/i],
  ['sci-fi', /\b(sci-?fi|science fiction)\b/i],
  ['graphic novel / comic', /\b(graphic novel|comic)\b/i],
  ['short stories', /\bshort stor(y|ies)\b/i],
  ['non-fiction', /\bnon-?fiction|self-help|business book|how-to book\b/i],
  ['novel / fiction', /\b(novel|fiction)\b/i],
];

export function extractProfile(messages) {
  const text = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n');
  const p = {};
  if (!text) return p;

  if (has(text, /\b(first|debut)\b[^.?!]{0,25}\b(book|novel|time|memoir)|first-time|never published|new (author|writer)|new to (this|publishing|self-publishing)/i))
    p.experience = 'first-time author';
  else if (has(text, /\b(my (last|previous|other) books?|already published|published (several|a few|\d+) books?|my (series|backlist))\b/i))
    p.experience = 'has published before';

  if (has(text, /\b(agency|agencies|our clients|my clients|publishing (house|company|business)|small press|imprint|our team)\b/i))
    p.visitorType = 'business (agency / publisher / team)';
  else if (has(text, /\b(i'?m a |as a )?(book )?(designer|formatter|typesetter)\b/i)) p.visitorType = 'book designer / formatter';
  else if (has(text, /\bghost\s?writ/i)) p.visitorType = 'ghostwriter';
  else if (has(text, /\bbook coach\b/i)) p.visitorType = 'book coach';

  if (has(text, /\b(google docs?)\b/i)) p.manuscript = 'Google Docs';
  else if (has(text, /\b(word|docx?|ms word|microsoft word)\b/i)) p.manuscript = 'Word document';
  else if (has(text, /\bscrivener\b/i)) p.manuscript = 'Scrivener';
  else if (has(text, /\bpdf\b/i) && has(text, /\b(my|have|in) (a )?pdf\b/i)) p.manuscript = 'PDF';

  if (has(text, /\b(finished|done|completed|wrote|written|ready)\b[^.?!]{0,30}\b(book|manuscript|draft|novel)\b|\b(book|manuscript|draft|novel)\b[^.?!]{0,20}\b(is|was) (finished|done|complete|ready)/i))
    p.manuscriptStatus = 'finished draft';
  else if (has(text, /\b(still writing|writing my|halfway|work in progress|not finished)\b/i)) p.manuscriptStatus = 'still writing';

  const EBOOK = /\b(e-?books?|kindle|epub|digital)\b/i;
  const PRINT = /\b(paperback|print|hardcover|hard cover|physical)\b/i;
  const ebook = has(text, EBOOK);
  const print = has(text, PRINT);
  // Short answers like "Both" or "Just the paperback" only make sense next to the question asked.
  let both = has(text, /\bboth\b/i) && (ebook || print);
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    if (m.role !== 'user' || prev?.role !== 'assistant' || m.content.length > 80) return;
    if (/\bboth\b/i.test(m.content) && EBOOK.test(prev.content) && PRINT.test(prev.content)) both = true;
  });
  if (both || (ebook && print)) p.formats = 'eBook and paperback';
  else if (ebook) p.formats = 'eBook';
  else if (print) p.formats = 'print (paperback)';

  const platforms = PLATFORMS.filter(([, re]) => re.test(text)).map(([n]) => n);
  if (platforms.length) p.platforms = platforms.join(', ');

  const type = BOOK_TYPES.find(([, re]) => re.test(text));
  if (type) p.bookType = type[0];

  const pages = text.match(/\b(\d{2,4})\s*(-|\s)?pages?\b/i);
  if (pages) p.pageCount = `${pages[1]} pages`;
  const words = text.match(/\b(\d{1,3}(?:[,.]\d{3})+|\d{2,3}\s?k)\s*words?\b/i);
  if (words) p.wordCount = `${words[1]} words`;
  const trim = text.match(/\b(\d{1,2}(?:\.\d{1,2})?)\s*(?:"|in(?:ch(?:es)?)?)?\s*[x×]\s*(\d{1,2}(?:\.\d{1,2})?)\b/);
  if (trim) p.trimSize = `${trim[1]}×${trim[2]}`;
  if (has(text, /\b(images?|illustrations?|photos?|pictures?|full[- ]colou?r)\b/i)) p.images = 'has images / illustrations';
  if (has(text, /\b(need|want|looking for)\b[^.?!]{0,20}\bcover\b|\bdon'?t have a cover\b|\bno cover\b/i)) p.cover = 'needs a cover';
  else if (has(text, /\b(have|got|already)\b[^.?!]{0,20}\bcover\b/i)) p.cover = 'already has a cover';

  return p;
}

const LABELS = {
  experience: 'Experience',
  visitorType: 'Visitor type',
  manuscript: 'Manuscript file',
  manuscriptStatus: 'Manuscript status',
  formats: 'Formats wanted',
  platforms: 'Platforms mentioned',
  bookType: 'Book type',
  pageCount: 'Page count',
  wordCount: 'Word count',
  trimSize: 'Trim size',
  images: 'Images',
  cover: 'Cover',
};

export function describeProfile(p) {
  const lines = Object.entries(p).map(([k, v]) => `- ${LABELS[k] || k}: ${v}`);
  return lines.length ? lines.join('\n') : '- Nothing yet.';
}
