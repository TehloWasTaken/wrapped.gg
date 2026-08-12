const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const FACE = { x: 8, y: 8 };
const TILE = 8;
const SCALE = 16;
const OUT = TILE * SCALE;

export async function headFromSkin(bytes) {
  const png = parse(bytes);
  if (!png) return null;
  const rgba = await pixels(png);
  if (!rgba) return null;
  const face = compose(rgba, png.width, png.height);
  if (!face) return null;
  return encode(upscale(face), OUT, OUT);
}

function parse(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 45) return null;
  for (let i = 0; i < SIG.length; i++) if (b[i] !== SIG[i]) return null;

  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 8;
  let head = null;
  const idat = [];

  while (off + 8 <= b.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
    const start = off + 8;
    if (start + len > b.length) return null;
    if (type === 'IHDR') {
      head = {
        width: view.getUint32(start),
        height: view.getUint32(start + 4),
        depth: b[start + 8],
        color: b[start + 9],
        interlace: b[start + 12],
      };
    } else if (type === 'IDAT') {
      idat.push(b.subarray(start, start + len));
    } else if (type === 'IEND') {
      break;
    }
    off = start + len + 4;
  }

  if (!head || !idat.length) return null;
  if (head.depth !== 8 || head.interlace !== 0) return null;
  if (head.color !== 6 && head.color !== 2) return null;
  if (head.width < FACE.x + TILE || head.height < FACE.y + TILE) return null;
  if (head.width > 1024 || head.height > 1024) return null;

  let total = 0;
  for (const part of idat) total += part.length;
  const data = new Uint8Array(total);
  let at = 0;
  for (const part of idat) { data.set(part, at); at += part.length; }
  return { ...head, data };
}

async function pixels(png) {
  const channels = png.color === 6 ? 4 : 3;
  const stride = png.width * channels;
  let raw;
  try {
    raw = new Uint8Array(await new Response(
      new Blob([png.data]).stream().pipeThrough(new DecompressionStream('deflate')),
    ).arrayBuffer());
  } catch { return null; }
  if (raw.length < (stride + 1) * png.height) return null;

  const out = new Uint8Array(stride * png.height);
  for (let y = 0; y < png.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) return null;
      row[i] = v & 255;
    }
  }
  if (channels === 4) return out;

  const rgba = new Uint8Array(png.width * png.height * 4);
  for (let i = 0, j = 0; i < out.length; i += 3, j += 4) {
    rgba[j] = out[i]; rgba[j + 1] = out[i + 1]; rgba[j + 2] = out[i + 2]; rgba[j + 3] = 255;
  }
  return rgba;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function compose(rgba, width, height) {
  const out = new Uint8Array(TILE * TILE * 4);
  let opaque = 0;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const d = (y * TILE + x) * 4;
      const s = ((FACE.y + y) * width + FACE.x + x) * 4;
      out[d] = rgba[s]; out[d + 1] = rgba[s + 1];
      out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3];
      if (out[d + 3] > 0) opaque++;
    }
  }
  return opaque ? out : null;
}

function upscale(face) {
  const out = new Uint8Array(OUT * OUT * 4);
  for (let y = 0; y < OUT; y++) {
    const sy = (y / SCALE) | 0;
    for (let x = 0; x < OUT; x++) {
      const s = (sy * TILE + ((x / SCALE) | 0)) * 4;
      const d = (y * OUT + x) * 4;
      out[d] = face[s]; out[d + 1] = face[s + 1];
      out[d + 2] = face[s + 2]; out[d + 3] = face[s + 3];
    }
  }
  return out;
}

async function encode(rgba, width, height) {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const deflated = new Uint8Array(await new Response(
    new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate')),
  ).arrayBuffer());

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const chunks = [chunk('IHDR', ihdr), chunk('IDAT', deflated), chunk('IEND', new Uint8Array(0))];
  let size = SIG.length;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  out.set(SIG, 0);
  let at = SIG.length;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

function chunk(type, body) {
  const out = new Uint8Array(body.length + 12);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  dv.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
