export const NDJSON_VERSION = 1;

export function toNdjson({ snapshot_at, source, players, names = {} }) {
  const lines = [JSON.stringify({ v: NDJSON_VERSION, snapshot_at, source })];
  for (const uuid in players) {
    const row = { u: uuid, c: players[uuid] };
    const nm = names[uuid];
    if (nm) row.n = typeof nm === 'string' ? nm : nm.name;
    lines.push(JSON.stringify(row));
  }
  return lines.join('\n') + '\n';
}

export async function readNdjson(stream, { onHeader, onPlayer, maxLineBytes = 4 << 20 }) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let header = null;
  let count = 0;

  const handle = (line) => {
    if (!line) return;
    if (line.length > maxLineBytes) throw new Error('line_too_large');
    const obj = JSON.parse(line);
    if (!header) {
      header = obj;
      if (header.v !== NDJSON_VERSION) throw new Error(`unsupported_version:${header.v}`);
      onHeader && onHeader(header);
    } else {
      count += 1;
      onPlayer(obj);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      handle(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
    }
    // a file with no newlines in it would otherwise buffer forever
    if (buf.length > maxLineBytes) throw new Error('line_too_large');
  }
  handle(buf.trim());
  return { header, count };
}

// Sniff the magic bytes. The shell client sets content-encoding, the browser
// uploader doesn't, and proxies in between do as they please. Reading the head
// means putting it back, hence rejoined.
export async function maybeGunzipStream(stream) {
  const reader = stream.getReader();
  const first = await reader.read();
  const head = first.value || new Uint8Array();
  const isGzip = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;

  const rejoined = new ReadableStream({
    start(c) { if (head.length) c.enqueue(head); if (first.done) c.close(); },
    async pull(c) {
      const { value, done } = await reader.read();
      if (done) c.close(); else c.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });

  return isGzip ? gunzipStream(rejoined) : rejoined;
}

export function gunzipStream(stream) {
  return stream.pipeThrough(new DecompressionStream('gzip'));
}
