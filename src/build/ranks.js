import { RANK_METRICS, RANK_METRIC_KEYS } from './build.js';

// Vectors are positional, so the order of RANK_METRICS is the file format.
// Append only. The header carries the key list and readRanks rejects a file
// that disagrees with it.
export const RANKS_VERSION = 1;
export const ranksKey = (buildId) => `build/${buildId}/ranks.ndjson`;

export const MAX_TRACKED_PLAYERS = 100_000;

export const ranksHeader = (at) =>
  JSON.stringify({ v: RANKS_VERSION, metrics: RANK_METRIC_KEYS, at: at || null });

export const ranksLine = (uuid, vec) => `${uuid} ${vec.join(',')}\n`;

export async function readRanks(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const map = new Map();
  let buf = '';
  let header = null;
  let bad = false;

  const handle = (line) => {
    if (!line || bad) return;
    if (!header) {
      try { header = JSON.parse(line); } catch { bad = true; return; }
      if (header.v !== RANKS_VERSION) { bad = true; return; }
      const m = header.metrics;
      if (!Array.isArray(m) || m.length !== RANK_METRICS.length
          || m.some((k, i) => k !== RANK_METRIC_KEYS[i])) {
        bad = true;
      }
      return;
    }
    if (map.size >= MAX_TRACKED_PLAYERS) { bad = true; return; }
    const sp = line.indexOf(' ');
    if (sp <= 0) return;
    const uuid = line.slice(0, sp);
    const parts = line.slice(sp + 1).split(',');
    if (parts.length !== RANK_METRICS.length) return;
    const vec = new Array(parts.length);
    for (let i = 0; i < parts.length; i++) vec[i] = +parts[i] || 0;
    map.set(uuid, vec);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        handle(buf.slice(0, nl).trim());
        buf = buf.slice(nl + 1);
        if (bad) break;
      }
      if (bad) break;
    }
    if (!bad) handle(buf.trim());
  } catch {
    return null;
  } finally {
    reader.cancel().catch(() => {});
  }

  if (bad || !header || !map.size) return null;
  return { at: header.at || null, ranks: map };
}
