// Assembles the system prompt from separately maintained parts:
//   prompts/*.md          -> identity, conversation, accuracy, qualification, escalation, format
//   knowledge/core/*.md   -> always-on product knowledge
// Both are stable across requests, so they form one cached block.
// The per-turn block (retrieved knowledge, visitor profile, current page) comes after the cache breakpoint.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeProfile } from './profile.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROMPTS_DIR = path.resolve(here, '..', 'prompts');

export function loadPromptParts(dir = PROMPTS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim());
}

export function buildStableSystem(promptParts, kb) {
  const core = kb.core
    .map((d) => `<knowledge id="${d.meta.id}" title="${d.meta.title}" source="${d.meta.source}" verified="${d.meta.verified}">\n${d.body}\n</knowledge>`)
    .join('\n\n');
  return [
    ...promptParts,
    '# PublishPro knowledge (always available)\n\nThis is verified information from publishpro.app. It is your source of truth about PublishPro.\n\n' + core,
  ].join('\n\n');
}

export function buildTurnContext({ retrieved, profile, page, now = new Date() }) {
  const parts = [];
  parts.push(`Today's date: ${now.toISOString().slice(0, 10)}.`);
  if (page?.path) {
    parts.push(
      `The visitor is currently on this page of publishpro.app: ${page.path}${page.title ? ` ("${page.title}")` : ''}. Use it as context for what they may be interested in; don't mention it unless helpful.`,
    );
  }
  parts.push(`# What we know about this visitor so far\n(Picked up from their own messages. Don't ask again for anything listed here.)\n${describeProfile(profile)}`);
  if (retrieved.length) {
    const body = retrieved
      .map(
        ({ chunk }) =>
          `<knowledge title="${chunk.docTitle} — ${chunk.heading}" source="${chunk.source}">\n${chunk.note ? `(${chunk.note})\n` : ''}${chunk.text}\n</knowledge>`,
      )
      .join('\n\n');
    parts.push(`# Additional PublishPro knowledge relevant to this message\n\n${body}`);
  }
  return parts.join('\n\n');
}

/** System blocks for the Messages API: stable (cached) + per-turn. */
export function buildSystemBlocks(stableSystem, turnContext) {
  return [
    { type: 'text', text: stableSystem, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: turnContext },
  ];
}
