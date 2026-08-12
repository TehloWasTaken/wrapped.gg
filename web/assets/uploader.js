import { unzipSync, gunzipSync, gzipSync, strFromU8 } from '/assets/fflate.js';

const STAT_PATH = /(^|\/)stats\/[^/]+\.json$/i;
const UUID_JSON = /(^|\/)[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\.json$/i;
const USERCACHE = /(^|\/)usercache\.json$/i;
const IS_ADV    = /(^|\/)advancements\//i;
const wanted = (p) => STAT_PATH.test(p) || USERCACHE.test(p) || (UUID_JSON.test(p) && !IS_ADV.test(p));

const dec = new TextDecoder();
const strip = (s) => (s.startsWith('minecraft:') ? s.slice(10) : s);
const UUIDISH = /^[0-9a-fA-F-]{16,48}$/;

function countersOf(doc) {
  const out = {};
  const stats = doc && doc.stats;
  if (stats && typeof stats === 'object') {
    for (const cat in stats) {
      const cc = strip(cat);
      for (const k in stats[cat]) {
        const v = stats[cat][k];
        if (v) out[`${cc}/${strip(k)}`] = v;
      }
    }
    return out;
  }
  for (const k in doc) {
    if (!k.startsWith('stat.')) continue;
    const raw = doc[k];
    const v = typeof raw === 'number' ? raw : (raw && raw.value);
    if (typeof v === 'number' && v) out[k] = v;
  }
  return out;
}
const nf = (n) => Number(n).toLocaleString('en-US');
const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function readArchive(buf, name) {
  const bytes = new Uint8Array(buf);
  const out = new Map();

  if (/\.zip$/i.test(name)) {
    const files = unzipSync(bytes, { filter: (f) => wanted(f.name) });
    for (const [path, data] of Object.entries(files)) out.set(path, data);
    return out;
  }

  const tar = /\.gz$|\.tgz$/i.test(name) ? gunzipSync(bytes) : bytes;
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    const path = strFromU8(header.subarray(0, 100)).replace(/\0.*$/, '');
    if (!path) break;
    const size = parseInt(strFromU8(header.subarray(124, 136)).replace(/\0.*$/, '').trim(), 8) || 0;
    const type = String.fromCharCode(header[156]);
    off += 512;
    if ((type === '0' || type === '\0') && wanted(path)) out.set(path, tar.subarray(off, off + size));
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

const HTML = `
<div class="up-drop" data-el="drop" role="button" tabindex="0">
  <b data-el="dropTitle">Drop your stats file here</b>
  <small data-el="dropHint">or tap to choose &middot; .zip or .tar.gz</small>
  <input type="file" data-el="fileArchive" accept=".zip,.tar,.gz,.tgz,.tar.gz" hidden />
</div>

<p class="up-alt">
  <button type="button" class="linky" data-el="folderBtn">or choose the stats folder instead</button>
  <input type="file" data-el="fileFolder" webkitdirectory directory multiple hidden />
</p>

<div class="up-found" data-el="found" hidden></div>

<div data-el="problem" hidden></div>

<label class="field up-names" data-el="namesField">
  <span>usercache.json <em>(so players have names, not UUIDs)</em></span>
  <input type="file" data-el="fileNames" accept=".json,application/json" />
  <small data-el="namesHint">
    It sits in your server's main folder, next to <code>server.properties</code>.
    <a href="/docs#names" target="_blank" rel="noopener">Where is it?</a>
  </small>
</label>

<button class="btn lg primary block" data-el="go" disabled>Upload</button>

<div class="up-prog" data-el="prog" hidden>
  <div class="up-phase">
    <span data-el="phase">Working</span>
    <span data-el="pct" class="up-pct"></span>
  </div>
  <div class="up-bar"><i data-el="bar"></i></div>
  <div class="up-eta dim" data-el="eta"></div>
</div>

<div class="log" data-el="log" hidden role="log" aria-live="polite"></div>
`;

export function mountUploader(root, { getKey, onDone } = {}) {
  root.classList.add('uploader');
  root.innerHTML = HTML;
  const $ = (n) => root.querySelector(`[data-el="${n}"]`);

  let statsFiles = null, namesFile = null, namesCount = 0, busy = false;

  const log = (msg, cls = '') => {
    const el = $('log');
    el.hidden = false;
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  };

  const problem = (title, body, retry) => {
    hidePhase();
    const el = $('problem');
    el.hidden = false;
    el.className = 'note stop';
    el.innerHTML = `<b class="t">${title}</b>${body}` +
      (retry ? '<p><button type="button" class="btn sm" data-el="retry">Try again</button></p>' : '');
    if (retry) el.querySelector('[data-el="retry"]').addEventListener('click', () => {
      clearProblem();
      retry();
    });
  };
  const clearProblem = () => { $('problem').hidden = true; $('problem').innerHTML = ''; };

  const setPhase = (label, pct, eta) => {
    $('prog').hidden = false;
    $('phase').textContent = label;
    if (pct == null) {
      $('bar').classList.add('indef');
      $('pct').textContent = '';
    } else {
      $('bar').classList.remove('indef');
      $('bar').style.width = Math.max(2, Math.min(100, pct)) + '%';
      $('pct').textContent = Math.round(pct) + '%';
    }
    $('eta').textContent = eta || '';
  };
  const hidePhase = () => { $('prog').hidden = true; };

  function refresh() {
    const ready = !!(statsFiles && statsFiles.size) && !busy;
    $('go').disabled = !ready;
    $('go').textContent = statsFiles
      ? `Upload ${nf(statsFiles.size)} players`
      : 'Upload';

    const found = $('found');
    if (!statsFiles) { found.hidden = true; return; }
    found.hidden = false;
    found.className = 'note tip';
    found.innerHTML =
      `<b class="t">Found ${nf(statsFiles.size)} players</b>` +
      (namesFile
        ? `Names loaded${namesCount ? ` (${nf(namesCount)} of them)` : ''}. You are ready to go.`
        : 'Add <code>usercache.json</code> below so players can find themselves by name - ' +
          'without it every player is a row of letters and numbers.');
  }

  async function takeArchive(file) {
    clearProblem();
    log(`reading ${file.name} (${mb(file.size)})…`);
    let found;
    try {
      found = readArchive(await file.arrayBuffer(), file.name);
    } catch {
      problem('That file could not be opened',
        `<p>It is not a readable .zip or .tar.gz. Download it from your host again - ` +
        `a half-finished download looks exactly like this.</p>`);
      return;
    }

    const uc = [...found].find(([p]) => USERCACHE.test(p));
    if (uc) { takeNames(uc[1], 'inside the archive'); }

    let stats = new Map([...found].filter(([p]) => STAT_PATH.test(p)));
    if (!stats.size) {
      stats = new Map([...found].filter(([p]) => !USERCACHE.test(p)));
      if (stats.size) log('no stats/ folder inside - using the player files at the top level', 'warn');
    }

    if (!stats.size) {
      problem('No player stats in that file',
        `<p>Nothing inside it looks like a <code>stats</code> folder. The usual cause is ` +
        `zipping the wrong folder.</p>` +
        `<p>Open <code>world</code> in your host's file manager, tick the <b>stats</b> folder ` +
        `itself, and archive that. On Minecraft <b>26.X</b> and newer it is inside ` +
        `<code>world/players</code>; before that it is directly in <code>world</code>. ` +
        `<a href="/docs" target="_blank" rel="noopener">Show me where that is</a>.</p>`);
      return;
    }
    statsFiles = stats;
    log(`found ${nf(stats.size)} player files`, 'ok');
    refresh();
  }

  async function takeFolder(list) {
    clearProblem();
    const files = [...list].filter(f => /\.json$/i.test(f.name));
    if (!files.length) {
      problem('No .json files in that folder',
        `<p>That folder is empty or is not the <code>stats</code> folder. It should be full of ` +
        `files named after long strings of letters and numbers.</p>`);
      return;
    }
    log(`reading ${nf(files.length)} files…`);
    const map = new Map();
    for (const f of files) map.set(f.name, new Uint8Array(await f.arrayBuffer()));
    statsFiles = map;
    log(`found ${nf(map.size)} player files`, 'ok');
    refresh();
  }

  function takeNames(bytes, where) {
    try {
      const parsed = JSON.parse(dec.decode(bytes));
      namesCount = Array.isArray(parsed) ? parsed.filter(e => e && e.uuid && e.name).length : 0;
      if (!namesCount) throw new Error('empty');
      namesFile = bytes;
      log(`${nf(namesCount)} player names loaded${where ? ' ' + where : ''}`, 'ok');
    } catch {
      namesFile = null; namesCount = 0;
      problem('That usercache.json could not be read',
        `<p>It should be a file full of names and UUIDs. Make sure you picked ` +
        `<code>usercache.json</code> from your server's main folder and not something else.</p>`);
    }
    refresh();
  }

  const drop = $('drop'), fileArchive = $('fileArchive');
  drop.addEventListener('click', () => fileArchive.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileArchive.click(); }
  });
  fileArchive.addEventListener('change', () => {
    if (fileArchive.files.length) takeArchive(fileArchive.files[0]);
  });
  ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) takeArchive(e.dataTransfer.files[0]);
  });

  $('folderBtn').addEventListener('click', () => $('fileFolder').click());
  $('fileFolder').addEventListener('change', (e) => {
    if (e.target.files.length) takeFolder(e.target.files);
  });

  $('fileNames').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) takeNames(new Uint8Array(await f.arrayBuffer()), '');
  });

  $('go').addEventListener('click', async () => {
    const key = (getKey ? getKey() : '').trim();
    if (!key) {
      problem('No upload key yet',
        '<p>Pick which server this is for above, and the key fills itself in. ' +
        'If it stays empty, reload the page.</p>');
      return;
    }
    clearProblem();
    busy = true;
    refresh();
    $('go').textContent = 'Working…';

    const names = {};
    const byName = new Map();
    if (namesFile) {
      try {
        for (const e of JSON.parse(dec.decode(namesFile))) {
          if (e.uuid && e.name) { names[e.uuid] = e.name; byName.set(e.name.toLowerCase(), e.uuid); }
        }
      } catch {}
    } else {
      log('No usercache.json - players will show as UUIDs and cannot be looked up.', 'warn');
    }

    const total = statsFiles.size;
    const t0 = Date.now();
    setPhase(`Reading ${nf(total)} player files`, 0);

    const lines = [JSON.stringify({ v: 1, snapshot_at: Math.floor(Date.now() / 1000), source: 'browser' })];
    let n = 0, seen = 0, unmatched = 0;
    const every = Math.max(1, Math.floor(total / 50));
    for (const [path, bytes] of statsFiles) {
      if (seen % every === 0) {
        const frac = seen / total;
        const elapsed = (Date.now() - t0) / 1000;
        const left = frac > 0.05 ? Math.ceil(elapsed / frac - elapsed) : 0;
        setPhase(`Reading ${nf(total)} player files`, frac * 100,
                 left >= 1 ? `about ${left}s left` : '');
        await new Promise(r => setTimeout(r, 0));
      }
      seen++;
      const base = path.split('/').pop().replace(/\.json$/i, '');
      let uuid = base;
      if (!UUIDISH.test(base)) {
        uuid = byName.get(base.toLowerCase()) || '';
        if (!uuid) { unmatched++; continue; }
      }
      let doc;
      try { doc = JSON.parse(dec.decode(bytes)); } catch { continue; }
      const c = countersOf(doc);
      if (!Object.keys(c).length) continue;
      const row = { u: uuid, c };
      if (names[uuid]) row.n = names[uuid];
      lines.push(JSON.stringify(row));
      n++;
    }

    if (unmatched) {
      const msg = `${nf(unmatched)} file${unmatched === 1 ? ' is' : 's are'} named after a ` +
        'player, not a UUID - that is Minecraft 1.7.5 and older.';
      if (!n) {
        busy = false; refresh();
        problem('Those files are named after players, not UUIDs',
          `<p>${msg} Every page here is keyed on the account UUID, and the only file that ` +
          `maps a name to one is <code>usercache.json</code> - which those versions never ` +
          `wrote.</p><p>If this world has run on <b>1.7.6</b> or newer at any point, ` +
          `Minecraft renamed the files itself: upload the stats folder from that copy and ` +
          `everything works.</p>`);
        return;
      }
      log(msg + ' They were skipped.', 'warn');
    }

    if (!n) {
      busy = false; refresh();
      problem('Those files had no stats in them',
        `<p>They parsed, but none of them contained counters. If you picked the ` +
        `<code>advancements</code> folder by mistake, go back for the <code>stats</code> ` +
        `one next to it - <code>world/stats</code>, or <code>world/players/stats</code> ` +
        `on Minecraft 26.X and newer.</p>`);
      return;
    }

    setPhase('Compressing', 100);
    await new Promise(r => setTimeout(r, 0));
    const raw = new TextEncoder().encode(lines.join('\n') + '\n');
    const gz = gzipSync(raw, { level: 6 });
    log(`${nf(n)} players · ${mb(raw.length)} → ${mb(gz.length)} to send`, 'ok');

    const digest = await crypto.subtle.digest('SHA-256', gz);
    const idem = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');

    setPhase(`Uploading ${mb(gz.length)}`, null,
             'the only part that uses your connection');
    let out, res;
    try {
      res = await fetch('/v1/snapshots', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/x-ndjson',
          'idempotency-key': idem,
          'x-wrapped-source': 'browser',
        },
        body: gz,
      });
      out = await res.json().catch(() => ({}));
    } catch {
      busy = false; refresh();
      problem('Could not reach wrapped.gg',
        '<p>Your connection dropped, or something between you and us did. Nothing ' +
        'was lost: your files are still loaded here, so this just needs another go.</p>',
        () => $('go').click());
      return;
    }

    if (!res.ok) {
      busy = false; refresh();
      const detail = out.message ? `<p>${esc(out.message)}</p>` : '';
      if (res.status === 401 || res.status === 403) {
        problem('That key was not accepted',
          detail + '<p>Reload this page to get a fresh one. Keys stop working the ' +
          'moment they are revoked.</p>', () => location.reload());
      } else if (res.status === 413) {
        problem('That upload is too large',
          detail + '<p>Something other than the stats folder got included. Archive ' +
          'only the <code>stats</code> folder - <code>world/stats</code>, or ' +
          '<code>world/players/stats</code> on Minecraft 26.X and newer - and try that.</p>');
      } else if (res.status === 429) {
        problem('Too many uploads today',
          detail + '<p>This is an annual product and the limit is twelve a day. ' +
          'Try again tomorrow.</p>');
      } else if (res.status >= 500) {
        problem('Something broke on our side',
          detail + '<p>Nothing is wrong with your files. Give it a minute and try ' +
          'again; re-uploading identical data is free and safe.</p>',
          () => $('go').click());
      } else {
        problem('The upload was refused',
          detail || `<p>The server answered ${res.status} and said nothing useful.</p>`,
          () => $('go').click());
      }
      return;
    }

    log(out.duplicate ? 'Already uploaded - nothing changed.' : 'Uploaded. Building…', 'ok');
    await poll(out.snapshot_id, key, n);
  });

  async function poll(id, key, expected) {
    const started = Date.now();
    const LIMIT_MS = 10 * 60 * 1000;
    let last = null, sameSince = Date.now(), netFail = 0, warnedStall = false;

    const WORD = { queued: 'Waiting for a build slot', building: 'Crunching your stats' };

    setPhase('Building your Wrapped', null, 'usually a few seconds');

    while (Date.now() - started < LIMIT_MS) {
      await new Promise(r => setTimeout(r, 2000));

      let s;
      try {
        const res = await fetch(`/v1/snapshots/${id}`, { headers: { authorization: `Bearer ${key}` } });
        if (!res.ok) { netFail++; }
        else { s = await res.json(); netFail = 0; }
      } catch { netFail++; }

      if (!s) {
        if (netFail >= 6) {
          setPhase('Building your Wrapped', null,
            'cannot reach wrapped.gg to check on it, still trying. Your upload was accepted.');
        }
        continue;
      }

      const secs = Math.round((Date.now() - started) / 1000);
      if (s.state !== last) { last = s.state; sameSince = Date.now(); warnedStall = false; }
      const stuckFor = Math.round((Date.now() - sameSince) / 1000);

      if (s.state === 'ready') {
        setPhase('Done', 100, `${nf(s.players)} players are in it`);
        log(`Done. ${nf(s.players)} players built.`, 'ok');
        busy = false;
        $('go').textContent = 'Uploaded';
        if (onDone) onDone({ players: Number(s.players) || expected });
        return;
      }

      if (s.state === 'failed') {
        busy = false; refresh();
        problem('The build failed',
          `<p>${esc(s.error || 'Something went wrong on our side.')}</p>` +
          '<p>Uploading again is safe and usually fixes it.</p>',
          () => $('go').click());
        return;
      }

      if (stuckFor >= 120 && !warnedStall) {
        warnedStall = true;
        log(`Still "${s.state}" after ${secs}s. It may have stalled.`, 'warn');
      }

      setPhase('Building your Wrapped', null,
        `${WORD[s.state] || s.state} - ${secs}s elapsed` +
        (stuckFor >= 120 ? ', longer than this usually takes' : ''));
    }

    busy = false; refresh();
    problem('The build has not finished',
      '<p>Your upload was accepted, so nothing is lost, but it has not come back ' +
      'as ready after ten minutes.</p>' +
      '<p>Check <a href="/panel">the panel</a> in a few minutes. If it still says ' +
      'building, press Try again below - that restarts the build rather than ' +
      'creating a second one.</p>',
      () => $('go').click());
  }

  refresh();
  return {
    hideNames() { $('namesField').hidden = true; },
  };
}
