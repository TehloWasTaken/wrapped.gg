(function () {
  var current = document.currentScript ||
                document.querySelector('script[src*="/embed.js"]');
  var ORIGIN = 'https://wrapped.gg';
  try { ORIGIN = new URL(current.src, location.href).origin; } catch (e) {}

  var MIN_H = 380, MAX_H = 900, DEFAULT_H = 640;
  var frames = [];
  var open = null;
  var pushed = false;
  var scrollWas = '';

  function styles() {
    if (document.getElementById('wgg-embed-css')) return;
    var s = document.createElement('style');
    s.id = 'wgg-embed-css';
    s.textContent =
      '.wgg-frame{display:block;width:100%;border:0;background:#050403;' +
      'color-scheme:dark;transition:height .2s ease}' +
      '.wgg-frame.wgg-full{position:fixed;inset:0;width:100%;height:100%;' +
      'z-index:2147483000;transition:none}' +
      '.wgg-back{position:fixed;inset:0;z-index:2147482999;background:#050403}';
    document.head.appendChild(s);
  }

  function clamp(n) { return Math.max(MIN_H, Math.min(MAX_H, Math.round(n))); }

  function src(el) {
    var slug = (el.getAttribute('data-wrapped') || '').trim();
    if (!slug) return null;
    var player = (el.getAttribute('data-player') || '').trim();
    return ORIGIN + '/embed/' + encodeURIComponent(slug) +
           (player ? '/' + encodeURIComponent(player) : '');
  }

  function mount(el) {
    if (!el || el.getAttribute('data-wgg-mounted')) return null;
    var url = src(el);
    if (!url) return null;
    el.setAttribute('data-wgg-mounted', '1');
    styles();

    var fixed = parseInt(el.getAttribute('data-height'), 10);
    var frame = document.createElement('iframe');
    frame.className = 'wgg-frame';
    frame.src = url;
    frame.title = 'Wrapped';
    frame.loading = 'lazy';
    frame.setAttribute('allow', 'clipboard-write');
    frame.setAttribute('referrerpolicy', 'origin');
    frame.style.height = (fixed > 0 ? clamp(fixed) : DEFAULT_H) + 'px';

    el.appendChild(frame);
    frames.push({ el: el, frame: frame, fixed: fixed > 0 });
    return frame;
  }

  function expand(rec) {
    if (open || rec.el.getAttribute('data-expand') === 'off') return;
    open = rec;
    var back = document.createElement('div');
    back.className = 'wgg-back';
    back.id = 'wgg-back';
    document.body.appendChild(back);
    rec.was = rec.frame.style.height;
    rec.frame.classList.add('wgg-full');
    rec.frame.style.height = '100%';
    scrollWas = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    if (!pushed) {
      try { history.pushState({ wgg: 1 }, ''); pushed = true; } catch (e) {}
    }
  }

  function collapse(fromPop) {
    if (!open) return;
    open.frame.classList.remove('wgg-full');
    open.frame.style.height = open.was || DEFAULT_H + 'px';
    open = null;
    var back = document.getElementById('wgg-back');
    if (back) back.remove();
    document.documentElement.style.overflow = scrollWas;
    if (pushed && !fromPop) { pushed = false; try { history.back(); } catch (e) {} }
    else pushed = false;
  }

  window.addEventListener('popstate', function () { if (open) collapse(true); });

  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN) return;
    var d = e.data;
    if (!d || d.source !== 'wrapped.gg') return;

    var rec = null;
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].frame.contentWindow === e.source) { rec = frames[i]; break; }
    }
    if (!rec) return;

    if (d.type === 'ready') {
      if (d.name) rec.frame.title = d.name + ' - Wrapped';
      if (!rec.fixed && d.height) rec.frame.style.height = clamp(d.height) + 'px';
    } else if (d.type === 'open') {
      expand(rec);
    } else if (d.type === 'close') {
      collapse(false);
    }
  });

  function scan() {
    var nodes = document.querySelectorAll('[data-wrapped]:not([data-wgg-mounted])');
    for (var i = 0; i < nodes.length; i++) mount(nodes[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan);
  } else {
    scan();
  }

  window.wrappedgg = { mount: mount, scan: scan };
})();
