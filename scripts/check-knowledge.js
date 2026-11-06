// Maintenance check for the knowledge base. Run after editing /knowledge:
//   npm run check:knowledge            -> structure + stale-date check
//   npm run check:knowledge -- --live  -> also verifies every publishpro.app URL still resolves
import fs from 'node:fs';
import path from 'node:path';
import { loadKnowledge, KNOWLEDGE_DIR } from '../src/knowledge.js';

const STALE_DAYS = 90;
const kb = loadKnowledge();
const problems = [];
const urls = new Set();

for (const sub of ['core', 'topics']) {
  for (const f of fs.readdirSync(path.join(KNOWLEDGE_DIR, sub)).filter((x) => x.endsWith('.md'))) {
    const raw = fs.readFileSync(path.join(KNOWLEDGE_DIR, sub, f), 'utf8');
    if (!raw.startsWith('---')) problems.push(`${sub}/${f}: missing front matter`);
    for (const k of ['id', 'title', 'source', 'verified']) if (!new RegExp(`^${k}:`, 'm').test(raw)) problems.push(`${sub}/${f}: missing "${k}"`);
    const v = raw.match(/^verified:\s*(\d{4}-\d{2}-\d{2})/m);
    if (v && (Date.now() - Date.parse(v[1])) / 86_400_000 > STALE_DAYS) problems.push(`${sub}/${f}: verified ${v[1]}, older than ${STALE_DAYS} days; re-check against the website`);
    for (const m of raw.matchAll(/https:\/\/(?:www\.|create\.)?publishpro\.app[^\s|)>"]*/g)) urls.add(m[0].replace(/[.,;:]$/, ''));
  }
}

const ids = kb.chunks.map((c) => c.id);
for (const id of ids) if (ids.indexOf(id) !== ids.lastIndexOf(id)) problems.push(`duplicate section id ${id}`);
for (const c of kb.chunks) if (c.text.length > 2500) problems.push(`${c.id}: section is long (${c.text.length} chars); consider splitting`);

if (process.argv.includes('--live')) {
  for (const u of urls) {
    try {
      const r = await fetch(u, { method: 'GET', redirect: 'follow' });
      if (!r.ok) problems.push(`URL ${u} -> HTTP ${r.status}`);
    } catch (e) {
      problems.push(`URL ${u} -> ${e.message}`);
    }
  }
}

console.log(`${kb.core.length} core files, ${kb.chunks.length} retrievable sections, ${urls.size} PublishPro URLs referenced.`);
if (problems.length) {
  console.log(problems.map((p) => '- ' + p).join('\n'));
  process.exit(1);
}
console.log('Knowledge base OK.');
