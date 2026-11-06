// Loads the PublishPro knowledge base from /knowledge and provides lexical
// (BM25) retrieval over it.
//
// knowledge/core/*.md   -> always included in the system prompt (cached)
// knowledge/topics/*.md -> split into "## " sections and retrieved per turn
//
// To update product knowledge, edit the Markdown files; no code changes needed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const KNOWLEDGE_DIR = path.resolve(here, '..', 'knowledge');

export function parseFrontMatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2].trim() };
}

function readDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({ file: f, ...parseFrontMatter(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

const STOP = new Set(
  'a an and are as at be but by can could do does for from had has have how i if in into is it its just me my of on or our so than that the their them then there these they this to too us was we what when where which who why will with would you your yours im ive id dont about any also get got need want like please thanks hi hey hello'.split(
    ' ',
  ),
);

export function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((t) => !STOP.has(t) && t.length > 1)
    .map((t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

function splitSections(doc) {
  const parts = doc.body.split(/^## /m);
  const intro = parts.shift().trim();
  const sections = parts.map((p) => {
    const nl = p.indexOf('\n');
    return { heading: p.slice(0, nl).trim(), text: p.slice(nl + 1).trim() };
  });
  if (intro) sections.unshift({ heading: 'Overview', text: intro });
  return sections;
}

export function loadKnowledge(dir = KNOWLEDGE_DIR) {
  const core = readDir(path.join(dir, 'core'));
  const topics = readDir(path.join(dir, 'topics'));

  const chunks = [];
  for (const doc of topics) {
    // A top-of-file note (e.g. "this is general advice") is attached to every chunk.
    const sections = splitSections(doc);
    const note = sections[0]?.heading === 'Overview' ? sections.shift().text : '';
    for (const s of sections) {
      const keywords = doc.meta.keywords || '';
      chunks.push({
        id: `${doc.meta.id || doc.file}#${s.heading}`,
        docTitle: doc.meta.title || doc.file,
        source: doc.meta.source || '',
        heading: s.heading,
        note,
        text: s.text,
        // Heading and file keywords count double: they're curated signals.
        tokens: tokenize(`${s.heading} ${s.heading} ${keywords} ${keywords} ${doc.meta.title || ''} ${s.text}`),
      });
    }
  }
  return { core, chunks, index: buildIndex(chunks) };
}

function buildIndex(chunks) {
  const df = new Map();
  let totalLen = 0;
  const tfs = chunks.map((c) => {
    const tf = new Map();
    for (const t of c.tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    totalLen += c.tokens.length;
    return tf;
  });
  return { df, tfs, avgLen: totalLen / Math.max(chunks.length, 1), n: chunks.length };
}

/** BM25 retrieval. Returns the top-k chunks with a positive score. */
export function retrieve(kb, query, k = 5) {
  const q = [...new Set(tokenize(query))];
  if (!q.length) return [];
  const { df, tfs, avgLen, n } = kb.index;
  const k1 = 1.2;
  const b = 0.75;
  const scored = kb.chunks.map((c, i) => {
    let score = 0;
    const tf = tfs[i];
    const len = c.tokens.length;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (n - df.get(t) + 0.5) / (df.get(t) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgLen)));
    }
    return { chunk: c, score };
  });
  return scored
    .filter((s) => s.score > 0.5)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, k);
}

/** Build a retrieval query from the latest visitor turns (recent context matters for follow-ups). */
export function retrievalQuery(messages, page) {
  const users = messages.filter((m) => m.role === 'user').map((m) => m.content);
  const last = users.at(-1) || '';
  const prev = users.slice(-3, -1).join(' ');
  // Repeat the latest turn so it dominates, while earlier turns resolve "it"/"that".
  return `${last} ${last} ${prev} ${page?.path ? page.path.replace(/[/-]/g, ' ') : ''}`;
}
