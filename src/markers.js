// Streams model text through to the visitor while holding back the trailing
// machine-readable markers ([[suggest: ...]] and [[handoff: ...]]).

const MARKER_RE = /\[\[\s*(suggest|handoff)\s*:?\s*([\s\S]*?)\]\]/gi;

export function createMarkerFilter() {
  let buffer = ''; // text not yet emitted
  let full = '';

  return {
    /** Feed a text delta; returns the part that is safe to show now. */
    push(text) {
      full += text;
      buffer += text;
      // Emit everything before a possible marker start ("[[", or a trailing "[").
      let cut = buffer.indexOf('[[');
      if (cut === -1) cut = buffer.endsWith('[') ? buffer.length - 1 : buffer.length;
      // Trailing whitespace is held too: it may only precede the markers.
      let out = buffer.slice(0, cut);
      const ws = out.match(/\s+$/);
      if (ws) out = out.slice(0, -ws[0].length);
      buffer = buffer.slice(out.length);
      return out;
    },
    /** Finish the stream: returns any held-back visible text plus parsed markers. */
    end() {
      const markers = parseMarkers(buffer);
      const tail = buffer.replace(MARKER_RE, '').replace(/\s+$/, '');
      // `tail` may start with whitespace that separates it from already-emitted text.
      buffer = '';
      return { tail, ...markers };
    },
    /** Reset (used when a server-side fallback restarts the answer). */
    reset() {
      buffer = '';
      full = '';
    },
    get text() {
      return stripMarkers(full);
    },
  };
}

export function parseMarkers(text) {
  let suggestions = [];
  let handoff = null;
  for (const m of text.matchAll(MARKER_RE)) {
    const kind = m[1].toLowerCase();
    const value = m[2].trim();
    if (kind === 'suggest') {
      suggestions = value
        .split('|')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter((s) => s && s.length <= 80)
        .slice(0, 3);
    } else if (kind === 'handoff') {
      handoff = { reason: value.slice(0, 300) || 'Visitor needs help from the team' };
    }
  }
  return { suggestions, handoff };
}

export function stripMarkers(text) {
  return text.replace(MARKER_RE, '').replace(/\s+$/, '');
}
