import { looksLegacy, normalizeCounters } from './legacy.js';

const INITIAL_CAPACITY = 1 << 16;

// CSR, like a sparse matrix. Counters go in two flat typed arrays and
// rowStart[p]..rowStart[p+1] is player p's slice. Object-per-player measured
// 133 MB on a 3k-player server and a Worker gets 128 MB total.
export class CounterStore {
  constructor() {
    this.keys = [];
    this._keyId = new Map();
    this.uuids = [];
    this.rowStart = [0];
    this._idx = new Int32Array(INITIAL_CAPACITY);
    this._val = new Float64Array(INITIAL_CAPACITY);
    this._n = 0;
    this.idx = null;
    this.val = null;
    this.frozen = false;
  }

  _grow() {
    const cap = this._idx.length * 2;
    const idx = new Int32Array(cap); idx.set(this._idx); this._idx = idx;
    const val = new Float64Array(cap); val.set(this._val); this._val = val;
  }

  intern(key) {
    let id = this._keyId.get(key);
    if (id === undefined) {
      id = this.keys.length;
      this.keys.push(key);
      this._keyId.set(key, id);
    }
    return id;
  }

  addPlayer(uuid, counters) {
    if (this.frozen) throw new Error('store is frozen');
    if (looksLegacy(counters)) {
      if (!this._legacyKeys) this._legacyKeys = new Map();
      counters = normalizeCounters(counters, this._legacyKeys);
    }
    let n = 0;
    for (const k in counters) {
      const v = counters[k];
      // zero and absent mean the same thing here, and there are a lot of zeros
      if (typeof v !== 'number' || !isFinite(v) || v === 0) continue;
      if (this._n === this._idx.length) this._grow();
      this._idx[this._n] = this.intern(k);
      this._val[this._n] = v;
      this._n += 1;
      n += 1;
    }
    if (!n) return false;
    this.uuids.push(uuid);
    this.rowStart.push(this._n);
    return true;
  }

  // doubling can leave half the buffer empty; hand it back before awards run
  freeze() {
    if (this.frozen) return this;
    this.idx = this._idx.slice(0, this._n);
    this._idx = null;
    this.val = this._val.slice(0, this._n);
    this._val = null;
    this.frozen = true;
    return this;
  }

  get playerCount() { return this.uuids.length; }

  forEachCounter(p, fn) {
    const s = this.rowStart[p], e = this.rowStart[p + 1];
    for (let i = s; i < e; i++) fn(this.idx[i], this.val[i]);
  }

  get(p, keyId) {
    if (keyId === undefined) return 0;
    const s = this.rowStart[p], e = this.rowStart[p + 1];
    for (let i = s; i < e; i++) if (this.idx[i] === keyId) return this.val[i];
    return 0;
  }

  keyIdOf(key) { return this._keyId.get(key); }

  sumPrefix(p, prefixIds) {
    let t = 0;
    const s = this.rowStart[p], e = this.rowStart[p + 1];
    for (let i = s; i < e; i++) if (prefixIds.has(this.idx[i])) t += this.val[i];
    return t;
  }

  idsWithPrefix(prefix) {
    const out = new Set();
    for (let i = 0; i < this.keys.length; i++) {
      if (this.keys[i].startsWith(prefix)) out.add(i);
    }
    return out;
  }

  topWithin(p, prefix, n) {
    const rows = [];
    const s = this.rowStart[p], e = this.rowStart[p + 1];
    for (let i = s; i < e; i++) {
      const k = this.keys[this.idx[i]];
      if (k.startsWith(prefix)) rows.push([k.slice(prefix.length), this.val[i]]);
    }
    rows.sort((a, b) => b[1] - a[1]);
    return rows.slice(0, n).map(([id, count]) => ({ id, count }));
  }

  approxBytes() {
    return (this.idx ? this.idx.byteLength + this.val.byteLength : 0) +
           this.keys.reduce((s, k) => s + k.length * 2 + 24, 0) +
           this.uuids.length * 60;
  }
}

export function storeFromPayload(payload) {
  const store = new CounterStore();
  const players = payload.players || {};
  for (const uuid in players) {
    store.addPlayer(uuid, players[uuid]);
    // drop each one as it goes in or we hold both copies at once
    players[uuid] = null;
  }
  return store.freeze();
}
