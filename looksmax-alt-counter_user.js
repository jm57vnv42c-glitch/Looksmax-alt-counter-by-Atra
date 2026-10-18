// ==UserScript==
// @name         Looksmax Alt Counter
// @namespace    looksmax-mod-tools
// @version      2.2.0
// @description  Kleines Kästchen neben jedem Usernamen: Anzahl nicht gebannter Alts aus dem Profil-Tab „Multiple accounts“. Rot = mindestens ein aktiver Alt.
// @match        https://looksmax.org/*
// @match        https://*.looksmax.org/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  Einstellungen
   * ------------------------------------------------------------------ */
  const VERSION = '2.2.0';
  const CFG = {
    altTTL: 3600e3,            // Alt-Liste pro User wird 1 h gecacht
    statusTTL: 12 * 3600e3,    // Status gebannt/gelöscht/... 12 h
    activeTTL: 15 * 60e3,      // „aktiv“ wird schon nach 15 min neu geprüft (frisch gebannt?)
    maxPages: 5,               // max. Seiten im Tab pro User
    concurrency: 2,            // gleichzeitige Requests
    gapMs: 300,                // Pause zwischen Requests
    tabId: 'multipleAccounts', // Tab im Profil: /members/name.123/#multipleAccounts
    entryPhrase: /potential multiple account/i,
    detectionDate: /detection date/i,
    bannedTitleRe: /^\s*banned\s*$/i,
    bannedNoticeRe: /\b(has been|is|was) banned\b|\bbanned (until|permanently)\b/i,
    unapprovedRe: /awaiting approval|pending approval|not (yet )?approved|unapproved|awaiting (email )?confirmation/i,
    notFoundRe: /requested member could not be found|member could not be found/i,
  };

  const NS = 'lmAltCounter:v2:';
  const LABEL = {
    active: 'aktiv',
    unapproved: 'nicht approved',
    deleted: 'gelöscht',
    banned: 'gebannt (zählt nicht)',
    rejected: 'abgelehnt (zählt nicht)',
    disabled: 'deaktiviert (zählt nicht)',
    error: 'Status unbekannt',
  };
  const COUNTED = new Set(['active', 'unapproved', 'deleted']);

  /* ------------------------------------------------------------------ *
   *  Speicher
   * ------------------------------------------------------------------ */
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(NS + k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) { /* voll/gesperrt */ } },
    del(k) { try { localStorage.removeItem(NS + k); } catch (e) { /* egal */ } },
  };
  const fresh = (rec, ttl) => rec && typeof rec.t === 'number' && Date.now() - rec.t < ttl;

  function prune() {
    try {
      const now = Date.now();
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (k.startsWith('lmAltCounter:v1:')) { keys.push([k, true]); continue; } // alte Version weg
        if (k.startsWith(NS + 'u:') || k.startsWith(NS + 's:')) keys.push([k, false]);
      }
      for (const [k, old] of keys) {
        if (old) { localStorage.removeItem(k); continue; }
        if (keys.length < 2000) continue;
        const v = JSON.parse(localStorage.getItem(k) || 'null');
        if (!v || now - v.t > CFG.statusTTL) localStorage.removeItem(k);
      }
    } catch (e) { /* egal */ }
  }

  /* ------------------------------------------------------------------ *
   *  Requests (gedrosselt)
   * ------------------------------------------------------------------ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const queue = [];
  let running = 0;
  let nextSlot = 0;

  function request(url, opts) {
    return new Promise((resolve, reject) => {
      queue.push({ url, opts, resolve, reject });
      pump();
    });
  }

  function pump() {
    while (running < CFG.concurrency && queue.length) runJob(queue.shift());
  }

  async function runJob(job) {
    running++;
    const wait = Math.max(0, nextSlot - Date.now());
    nextSlot = Date.now() + wait + CFG.gapMs;
    try {
      if (wait) await sleep(wait);
      const init = Object.assign({ credentials: 'include' }, job.opts || {});
      let res = await fetch(job.url, init);
      if (res.status === 429 || res.status === 503) {
        await sleep(4000);
        res = await fetch(job.url, init);
      }
      const text = await res.text();
      job.resolve({ status: res.status, ok: res.ok, text, url: res.url || job.url });
    } catch (e) {
      job.reject(e);
    } finally {
      running--;
      pump();
    }
  }

  const parseHTML = (html) => new DOMParser().parseFromString(html, 'text/html');

  function csrf() {
    return document.documentElement.getAttribute('data-csrf') ||
      (window.XF && window.XF.config && window.XF.config.csrf) || '';
  }

  // Lädt eine Seite so, wie XenForo es beim Antippen eines Tabs tut (Ajax/JSON)
  async function fetchXF(url) {
    const u = new URL(url, location.href);
    u.searchParams.set('_xfResponseType', 'json');
    u.searchParams.set('_xfWithData', '1');
    u.searchParams.set('_xfRequestUri', location.pathname + location.search);
    u.searchParams.set('_xfToken', csrf());
    const res = await request(u.href, {
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01' },
    });
    let html = res.text;
    let err = '';
    try {
      const j = JSON.parse(res.text);
      html = j.html ? (typeof j.html === 'string' ? j.html : (j.html.content || '')) : '';
      if (j.status === 'error' || (j.errors && j.errors.length)) err = [].concat(j.errors || []).join(' ');
    } catch (e) { /* war normales HTML */ }
    return { status: res.status, ok: res.ok && !err, err, url: res.url, doc: parseHTML(html || '') };
  }

  /* ------------------------------------------------------------------ *
   *  Hilfsfunktionen für XenForo
   * ------------------------------------------------------------------ */
  function linkUserId(a) {
    if (!a) return 0;
    const d = parseInt(a.getAttribute('data-user-id') || '', 10);
    if (d > 0) return d;
    const href = a.getAttribute('href') || '';
    const m = href.match(/\/members\/(?:[^/?#]*\.)?(\d+)\/?(?:[?#]|$)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  function memberLinks(scope) {
    return [...scope.querySelectorAll('a[href*="/members/"], a[data-user-id]')].filter((a) => linkUserId(a) > 0);
  }

  const cleanName = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function classTrail(a) {
    return [a.className || '', ...[...a.querySelectorAll('[class]')].map((x) => x.className)].join(' ');
  }

  /* ------------------------------------------------------------------ *
   *  Tab „Multiple accounts“ im Profil finden
   * ------------------------------------------------------------------ */
  function findTabPane(doc) {
    const tab = doc.querySelector('a[href$="#' + CFG.tabId + '"], [id="' + CFG.tabId + '"]');
    const id = (tab && tab.id) || CFG.tabId;
    return doc.querySelector('[aria-labelledby="' + id + '"]') ||
      [...doc.querySelectorAll('.tabPanes > li[data-href], [role="tabpanel"][data-href]')]
        .find((p) => /multi|alt/i.test(p.getAttribute('data-href') || ''));
  }

  // '/members/regulus.127459/multiple-accounts' -> '/members/{id}/multiple-accounts'
  function patternFrom(href, base) {
    try {
      const u = new URL(href, base);
      const m = u.pathname.match(/^(.*\/members\/)[^/]*?\.?(\d+)(\/.*)$/);
      return m ? m[1] + '{id}' + m[3] + u.search : null;
    } catch (e) { return null; }
  }

  function learnPattern(doc, base) {
    const pane = findTabPane(doc);
    const dh = pane && pane.getAttribute('data-href');
    const p = dh && patternFrom(dh, base);
    if (p) store.set('tab', { t: Date.now(), pattern: p });
    return p || null;
  }

  const getPattern = () => { const r = store.get('tab'); return r && r.pattern; };

  /* ------------------------------------------------------------------ *
   *  Einträge auslesen
   *  „On Login, X has the following potential multiple account(s):
   *     • Alt (Disabled)  [Ignore for future events]  Triggered detection methods …
   *   Detection date: …“
   * ------------------------------------------------------------------ */
  function markerText(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll('ul, ol, .button, .username, a[href*="/members/"]').forEach((x) => x.remove());
    const m = cleanName(c.textContent).match(/\(([^()]{2,40})\)/);
    return m ? m[1].trim() : '';
  }

  function mainMarker(a) {
    let t = '';
    for (let s = a.nextSibling; s && t.length < 120; s = s.nextSibling) {
      const x = s.textContent || '';
      t += x;
      if (/has the following/i.test(x)) break;
    }
    const m = t.split(/has the following/i)[0].match(/\(([^()]{2,40})\)/);
    return m ? m[1].trim() : '';
  }

  // Gibt zurück: [{ main: {id,name,href,marker}, alts: [{id,name,href,cls,marker,deleted}], html }]
  function parseEntries(scope) {
    const isDoc = scope.nodeType === 9;
    const doc = isDoc ? scope : scope.ownerDocument;
    const root = isDoc ? (doc.querySelector('.p-body-pageContent') || doc.querySelector('.p-body-main') || doc.body) : scope;
    if (!root) return [];
    const W = doc.defaultView || window;
    const NF = W.NodeFilter || NodeFilter;
    const walker = doc.createTreeWalker(root, NF.SHOW_TEXT);
    const starts = [];
    let n;
    while ((n = walker.nextNode())) {
      if (CFG.entryPhrase.test(n.nodeValue)) starts.push(n.parentElement);
    }

    const count = (el) => ((el.textContent || '').match(/potential multiple account/gi) || []).length;
    const entries = [];
    const seen = new Set();

    for (const start of starts) {
      let el = start;
      let best = start;
      while (el && el !== root.parentElement) {
        if (count(el) > 1) break;
        best = el;
        if (CFG.detectionDate.test(el.textContent) && el.querySelector('li, a[href*="/members/"]')) break;
        if (el === root) break;
        el = el.parentElement;
      }
      if (seen.has(best)) continue;
      seen.add(best);

      // Flache Struktur: nachfolgende Geschwister bis zum nächsten Eintrag mitnehmen
      const nodes = [best];
      if (!best.querySelector('li')) {
        let sib = best.nextElementSibling;
        while (sib && count(sib) === 0) { nodes.push(sib); sib = sib.nextElementSibling; }
      }
      const inEntry = (x) => nodes.some((nd) => nd === x || nd.contains(x));

      const entry = { main: null, alts: [], html: nodes.map((x) => x.outerHTML).join('\n') };

      const mainLink = memberLinks(best).find((a) => !a.closest('li') || !inEntry(a.closest('li')));
      if (mainLink) {
        entry.main = { id: linkUserId(mainLink), name: cleanName(mainLink.textContent), href: mainLink.href, cls: classTrail(mainLink), marker: mainMarker(mainLink) };
      }

      // nur oberste <li> = Alts (die inneren sind „Triggered detection methods“)
      const lis = nodes.flatMap((x) => (x.tagName === 'LI' ? [x] : [...x.querySelectorAll('li')]))
        .filter((li) => { const up = li.parentElement && li.parentElement.closest('li'); return !up || !inEntry(up); });

      if (lis.length) {
        for (const li of lis) {
          const a = memberLinks(li).find((x) => !x.classList.contains('button'));
          const marker = markerText(li);
          if (a) {
            entry.alts.push({ id: linkUserId(a), name: cleanName(a.textContent), href: a.href, cls: classTrail(a), marker });
          } else {
            const nameEl = li.querySelector('.username');
            let name = cleanName(nameEl ? nameEl.textContent : li.textContent);
            name = name.split(/\(|use for future events|ignore for future events|triggered detection/i)[0].trim();
            if (name) entry.alts.push({ id: 0, name, href: '', deleted: true, marker });
          }
        }
      } else {
        for (const a of nodes.flatMap((x) => memberLinks(x))) {
          if (a === mainLink || a.classList.contains('button')) continue;
          entry.alts.push({ id: linkUserId(a), name: cleanName(a.textContent), href: a.href, cls: classTrail(a), marker: '' });
        }
      }
      entries.push(entry);
    }
    return entries;
  }

  function nextPageUrl(doc, base) {
    const next = doc.querySelector('a.pageNav-jump--next, .pageNav-jump--next[href], a[rel="next"]');
    if (!next) return null;
    try { return new URL(next.getAttribute('href'), base).href; } catch (e) { return null; }
  }

  async function fetchTabPages(url, dbg) {
    const all = [];
    let next = url;
    for (let p = 0; p < CFG.maxPages && next; p++) {
      const r = await fetchXF(next);
      dbg.urls.push(next.replace(location.origin, '') + ' → ' + r.status + (r.err ? ' ' + r.err : ''));
      if (!r.ok) throw new Error('Tab lieferte ' + (r.err || 'HTTP ' + r.status));
      all.push(...parseEntries(r.doc));
      next = nextPageUrl(r.doc, location.href);
    }
    return all;
  }

  // Einträge für einen User: direkt über den gelernten Tab-Link, sonst erst Profil laden
  async function entriesFor(user, dbg) {
    let pattern = getPattern();
    if (!pattern) {
      const res = await request(location.origin + '/members/' + user.id + '/');
      dbg.urls.push('/members/' + user.id + '/ → ' + res.status);
      if (!res.ok) throw new Error('Profil lieferte HTTP ' + res.status);
      const doc = parseHTML(res.text);
      const pane = findTabPane(doc);
      if (!pane) { dbg.note = 'Kein „Multiple accounts“-Tab im Profil'; return []; }
      const inline = parseEntries(pane);
      if (inline.length) { dbg.note = 'Tab-Inhalt direkt im Profil'; return inline; }
      pattern = learnPattern(doc, res.url);
      if (!pattern) { dbg.note = 'Tab gefunden, aber ohne Link: ' + pane.outerHTML.slice(0, 300); return []; }
    }
    dbg.pattern = pattern;
    return fetchTabPages(location.origin + pattern.replace('{id}', user.id), dbg);
  }

  /* ------------------------------------------------------------------ *
   *  Alts eines Users sammeln
   * ------------------------------------------------------------------ */
  async function altsFor(user, dbg) {
    const rec = store.get('u:' + user.id);
    if (fresh(rec, CFG.altTTL)) { dbg.cached = true; return rec.alts; }

    const entries = await entriesFor(user, dbg);
    const alts = new Map();
    const add = (a) => {
      if (!a || a.id === user.id) return;
      const key = a.id ? 'id:' + a.id : 'del:' + a.name.toLowerCase();
      const old = alts.get(key);
      if (!old) alts.set(key, { id: a.id, name: a.name, href: a.href || '', deleted: !!a.deleted, cls: a.cls || '', marker: a.marker || '' });
      else if (!old.marker && a.marker) old.marker = a.marker;
    };
    let matched = 0;
    for (const e of entries) {
      const isMain = e.main && e.main.id === user.id;
      const isAlt = e.alts.some((a) => a.id === user.id);
      if (!isMain && !isAlt) continue;
      matched++;
      if (dbg.samples.length < 1 && e.html) dbg.samples.push(e.html.slice(0, 2500));
      e.alts.forEach(add);
      if (isAlt) add(e.main);
    }
    dbg.entriesParsed = entries.length;
    dbg.entriesMatched = matched;
    const list = [...alts.values()];
    store.set('u:' + user.id, { t: Date.now(), alts: list });
    return list;
  }

  /* ------------------------------------------------------------------ *
   *  Status eines Alts
   * ------------------------------------------------------------------ */
  function statusFromLog(alt) {
    const m = alt.marker || '';
    if (/banned/i.test(m)) return 'banned';
    if (/reject/i.test(m)) return 'rejected';
    if (/disabled/i.test(m)) return 'disabled';
    if (/deleted/i.test(m)) return 'deleted';
    if (/awaiting|approval|moderat|confirm|pending|unapproved/i.test(m)) return 'unapproved';
    if (alt.deleted || !alt.id) return 'deleted';
    if (/^deleted member\b/i.test(alt.name)) return 'deleted';
    if (/\busername--banned\b|\bis-banned\b/i.test(alt.cls || '') || hasBannedStyle(alt.cls)) return 'banned';
    return null;
  }

  const statusInflight = new Map();

  function statusOf(alt, dbg) {
    if (alt.id && isKnownBanned(alt.id)) return Promise.resolve('banned');
    const fromLog = statusFromLog(alt);
    if (fromLog) return Promise.resolve(fromLog);
    const rec = store.get('s:' + alt.id);
    if (rec && fresh(rec, rec.st === 'active' ? CFG.activeTTL : CFG.statusTTL)) return Promise.resolve(rec.st);
    if (statusInflight.has(alt.id)) return statusInflight.get(alt.id);

    // Kein Hinweis im Log → Profil ansehen (gebannt? wartet auf Freischaltung?)
    const p = (async () => {
      const url = alt.href || location.origin + '/members/' + alt.id + '/';
      try {
        const res = await request(url);
        let st;
        if (res.status === 404 || res.status === 410) st = 'deleted';
        else if (!res.ok) return 'error';
        else {
          const doc = parseHTML(res.text);
          st = classifyProfile(doc);
          if (dbg.profiles.length < 2) {
            const h = doc.querySelector('.memberHeader') || doc.querySelector('.p-body-main') || doc.body;
            dbg.profiles.push(alt.name + ' → ' + st + '\n' + (h ? h.outerHTML.slice(0, 1200) : ''));
          }
        }
        store.set('s:' + alt.id, { t: Date.now(), st });
        if (st === 'banned') markBanned(alt.id, true);
        return st;
      } catch (e) {
        return 'error';
      } finally {
        statusInflight.delete(alt.id);
      }
    })();
    statusInflight.set(alt.id, p);
    return p;
  }

  function classifyProfile(doc) {
    const header = doc.querySelector('.memberHeader');
    const main = doc.querySelector('.p-body-main') || doc.body;
    if (!header) {
      const err = doc.querySelector('.blockMessage--error, .p-body-main .blockMessage');
      if (err && CFG.notFoundRe.test(err.textContent)) return 'deleted';
      if (CFG.notFoundRe.test((main && main.textContent) || '')) return 'deleted';
    }
    const scope = header || main;
    const titles = [...scope.querySelectorAll('.userTitle, .userBanner, .memberHeader-blurb')].map((e) => cleanName(e.textContent));
    if (titles.some((t) => CFG.bannedTitleRe.test(t))) return 'banned';
    if (scope.querySelector('.username--banned, .userBanner--banned')) return 'banned';
    const nameEl = scope.querySelector('.memberHeader-name .username, .username');
    if (nameEl && hasBannedStyle(classTrail(nameEl))) return 'banned';
    const notices = [...doc.querySelectorAll('.memberHeader-banners, .blockMessage, .memberHeader-blurb')]
      .map((e) => e.textContent).join(' \n ');
    if (CFG.bannedNoticeRe.test(notices)) return 'banned';
    if (CFG.unapprovedRe.test(notices)) return 'unapproved';
    return 'active';
  }

  /* ---- Gebannte erkennen: looksmax streicht ihre Namen durch ---- */
  function styleTokens(el) {
    return [el, ...el.querySelectorAll('*')].flatMap((x) => [...x.classList]).filter((t) => /^username--/.test(t));
  }
  function isStruck(el) {
    return [el, ...el.querySelectorAll('*')].some((x) => {
      try { return /line-through/.test(getComputedStyle(x).textDecorationLine || getComputedStyle(x).textDecoration || ''); } catch (e) { return false; }
    });
  }
  // Merkt sich, welche Stil-Klassen und welche User-IDs auf looksmax durchgestrichen (= gebannt) sind
  function learnBanned(els) {
    const struck = new Set();
    const normal = new Set();
    let newlyBanned = false;
    let changed = false;
    for (const el of els) {
      const hit = isStruck(el);
      styleTokens(el).forEach((t) => (hit ? struck : normal).add(t));
      const id = parseInt(el.getAttribute('data-user-id'), 10);
      if (id > 0 && markBanned(id, hit, true)) { changed = true; if (hit) newlyBanned = true; }
    }
    if (changed) saveBannedIds();
    const rec = store.get('bannedCls') || { t: 0, list: [] };
    const set = new Set(rec.list);
    struck.forEach((t) => { if (!normal.has(t)) set.add(t); });
    normal.forEach((t) => set.delete(t));
    const list = [...set];
    if (list.join(' ') !== rec.list.join(' ')) store.set('bannedCls', { t: Date.now(), list });
    if (newlyBanned) refreshAll();
  }

  let bannedIds = null;
  function loadBannedIds() {
    if (!bannedIds) { const r = store.get('bannedIds'); bannedIds = (r && r.ids) || {}; }
    return bannedIds;
  }
  function saveBannedIds() {
    const ids = loadBannedIds();
    const keys = Object.keys(ids);
    if (keys.length > 5000) keys.slice(0, keys.length - 5000).forEach((k) => delete ids[k]);
    store.set('bannedIds', { t: Date.now(), ids });
  }
  // gibt true zurück, wenn sich etwas geändert hat
  function markBanned(id, banned, noSave) {
    const ids = loadBannedIds();
    const was = !!ids[id];
    if (was === !!banned) return false;
    if (banned) ids[id] = 1; else delete ids[id];
    if (!noSave) saveBannedIds();
    return true;
  }
  const isKnownBanned = (id) => !!loadBannedIds()[id];

  // Zahlen auf der Seite neu berechnen (aus dem Cache, ohne neue Abrufe für die Alt-Listen)
  let refreshTimer = null;
  function refreshAll() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      userInflight.clear();
      const seen = new Set();
      document.querySelectorAll('.lmac-box').forEach((b) => {
        if (!b._lmac || seen.has(b.dataset.uid)) return;
        seen.add(b.dataset.uid);
        load(b);
      });
    }, 200);
  }
  function hasBannedStyle(cls) {
    const rec = store.get('bannedCls');
    if (!rec || !rec.list.length) return false;
    const toks = new Set((cls || '').split(/\s+/));
    return rec.list.some((t) => toks.has(t));
  }

  /* ------------------------------------------------------------------ *
   *  Ergebnis pro User
   * ------------------------------------------------------------------ */
  const userInflight = new Map();
  const debugInfo = new Map();

  function resultFor(user) {
    if (userInflight.has(user.id)) return userInflight.get(user.id);
    const dbg = { user: user.name + ' (#' + user.id + ')', urls: [], samples: [], profiles: [] };
    debugInfo.set(user.id, dbg);
    const p = (async () => {
      const alts = await altsFor(user, dbg);
      const withStatus = await Promise.all(alts.map(async (a) => Object.assign({}, a, { st: await statusOf(a, dbg) })));
      const counted = withStatus.filter((a) => COUNTED.has(a.st));
      const active = withStatus.filter((a) => a.st === 'active').length;
      return { state: 'ok', count: counted.length, active, alts: withStatus };
    })().catch((e) => ({ state: 'error', error: String((e && e.message) || e) }));
    userInflight.set(user.id, p);
    p.then(() => setTimeout(() => userInflight.delete(user.id), 1000));
    return p;
  }

  /* ------------------------------------------------------------------ *
   *  Anzeige
   * ------------------------------------------------------------------ */
  const CSS = `
    .lmac-box{display:inline-block;min-width:9px;margin-left:4px;padding:0 3px;border:1px solid #6b6b6b;border-radius:3px;
      font:700 9px/12px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#9a9a9a;background:transparent;
      text-align:center;vertical-align:middle;cursor:pointer;text-decoration:none!important;-webkit-text-fill-color:currentColor;
      text-shadow:none!important;filter:none!important;animation:none!important;white-space:nowrap;user-select:none;-webkit-user-select:none}
    .lmac-box.lmac-red{color:#ff4d4d;border-color:#ff4d4d;background:rgba(255,77,77,.12)}
    .lmac-box.lmac-wait{opacity:.5}
    .lmac-pop{position:fixed;left:12px;right:12px;bottom:16px;z-index:2147483646;max-height:60vh;overflow:auto;
      background:#1d1d1f;color:#e8e8e8;border:1px solid #3a3a3c;border-radius:12px;padding:12px 14px;
      font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5)}
    .lmac-pop h4{margin:0 0 8px;font-size:14px;font-weight:700}
    .lmac-pop ul{margin:0 0 10px;padding:0;list-style:none}
    .lmac-pop li{display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px solid #2c2c2e}
    .lmac-pop li a{color:#7cb7ff}
    .lmac-pop .st-active{color:#ff4d4d;font-weight:700}
    .lmac-pop .st-banned,.lmac-pop .st-rejected,.lmac-pop .st-disabled{color:#777}
    .lmac-pop .lmac-btns{display:flex;gap:8px}
    .lmac-pop button{flex:1;background:#2c2c2e;color:#e8e8e8;border:1px solid #444;border-radius:8px;padding:7px 0;font-size:13px}
    .lmac-pop .lmac-x{position:absolute;top:6px;right:10px;background:none;border:0;color:#999;font-size:20px;padding:0;flex:none}
  `;

  function injectCSS() {
    if (document.getElementById('lmac-css')) return;
    const s = document.createElement('style');
    s.id = 'lmac-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function paint(box, r) {
    box.classList.remove('lmac-wait', 'lmac-red');
    if (r.state === 'ok') {
      box.textContent = String(r.count);
      if (r.active > 0) box.classList.add('lmac-red');
    } else {
      box.textContent = '?';
    }
  }

  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((list) => {
      for (const e of list) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        load(e.target);
      }
    }, { rootMargin: '300px 0px' })
    : null;

  function load(box) {
    const user = { id: +box.dataset.uid, name: box.dataset.uname };
    resultFor(user).then((r) => {
      document.querySelectorAll('.lmac-box[data-uid="' + user.id + '"]').forEach((b) => { b._lmac = r; paint(b, r); });
    });
  }

  function decorate(root) {
    const els = (root.matches && root.matches('.username[data-user-id]') ? [root] : [])
      .concat([...(root.querySelectorAll ? root.querySelectorAll('.username[data-user-id]') : [])]);
    const added = [];
    for (const el of els) {
      if (el.dataset.lmac) continue;
      if (el.closest('.lmac-pop')) continue;
      const parentUser = el.parentElement && el.parentElement.closest('.username[data-user-id]');
      if (parentUser) continue;
      const id = parseInt(el.getAttribute('data-user-id'), 10);
      const name = cleanName(el.textContent);
      if (!(id > 0) || !name) continue;
      el.dataset.lmac = '1';
      added.push(el);

      const box = document.createElement('span');
      box.className = 'lmac-box lmac-wait';
      box.textContent = '…';
      box.dataset.uid = String(id);
      box.dataset.uname = name;
      box.setAttribute('role', 'button');
      el.insertAdjacentElement('afterend', box);
      if (io) io.observe(box); else load(box);
    }
    if (added.length) learnBanned(added);
  }

  /* ---------------- Popup beim Antippen ---------------- */
  let pop = null;
  function closePop() { if (pop) { pop.remove(); pop = null; } }

  function openPop(box) {
    closePop();
    const r = box._lmac;
    const uid = +box.dataset.uid;
    pop = document.createElement('div');
    pop.className = 'lmac-pop';

    const x = document.createElement('button');
    x.className = 'lmac-x';
    x.textContent = '×';
    x.onclick = closePop;
    pop.appendChild(x);

    const h = document.createElement('h4');
    h.textContent = 'Alts von ' + box.dataset.uname;
    pop.appendChild(h);

    if (!r) {
      pop.appendChild(text('Lädt noch …'));
    } else if (r.state === 'error') {
      pop.appendChild(text('Fehler: ' + r.error));
    } else if (!r.alts.some((a) => COUNTED.has(a.st) || a.st === 'error')) {
      pop.appendChild(text('Keine Alts.'));
    } else {
      const ul = document.createElement('ul');
      const order = { active: 0, unapproved: 1, deleted: 2, error: 3, disabled: 4, rejected: 5, banned: 6 };
      r.alts.filter((a) => COUNTED.has(a.st) || a.st === 'error').sort((a, b) => order[a.st] - order[b.st]).forEach((a) => {
        const li = document.createElement('li');
        const left = a.href ? document.createElement('a') : document.createElement('span');
        if (a.href) left.href = a.href;
        left.textContent = a.name;
        const right = document.createElement('span');
        right.className = 'st-' + a.st;
        right.textContent = LABEL[a.st] || a.st;
        li.append(left, right);
        ul.appendChild(li);
      });
      pop.appendChild(ul);
    }

    const btns = document.createElement('div');
    btns.className = 'lmac-btns';
    const reload = document.createElement('button');
    reload.textContent = 'Neu laden';
    reload.onclick = () => {
      store.del('u:' + uid);
      if (r && r.alts) r.alts.forEach((a) => a.id && store.del('s:' + a.id));
      closePop();
      document.querySelectorAll('.lmac-box[data-uid="' + uid + '"]').forEach((b) => {
        b.classList.add('lmac-wait'); b.textContent = '…'; b._lmac = null;
      });
      const b0 = document.querySelector('.lmac-box[data-uid="' + uid + '"]');
      if (b0) load(b0);
    };
    const dbgBtn = document.createElement('button');
    dbgBtn.textContent = 'Debug kopieren';
    dbgBtn.onclick = () => copy(buildDebug(uid, r)).then((ok) => { dbgBtn.textContent = ok ? 'Kopiert ✓' : 'Kopieren fehlgeschlagen'; });
    btns.append(reload, dbgBtn);
    pop.appendChild(btns);

    document.body.appendChild(pop);
  }

  function text(s) { const p = document.createElement('div'); p.style.marginBottom = '10px'; p.textContent = s; return p; }

  function buildDebug(uid, r) {
    const d = debugInfo.get(uid) || {};
    const pane = findTabPane(document);
    return [
      'Looksmax Alt Counter ' + VERSION + ' – Debug',
      'Seite: ' + location.href,
      'User: ' + (d.user || uid),
      'Tab-Link: ' + JSON.stringify(store.get('tab')),
      'Ergebnis: ' + JSON.stringify(r && { state: r.state, count: r.count, active: r.active, error: r.error,
        alts: r.alts && r.alts.map((a) => [a.id, a.name, a.marker, a.st]) }),
      'Abrufe: ' + ((d.urls || []).join(' | ') || (d.cached ? '(aus Cache)' : '-')),
      'Hinweis: ' + (d.note || '-'),
      'Einträge gelesen/passend: ' + d.entriesParsed + '/' + d.entriesMatched,
      'Gebannt-Stile: ' + JSON.stringify(store.get('bannedCls')),
      'Tab auf dieser Seite: ' + (pane ? pane.outerHTML.slice(0, 400) : '(keiner)'),
      '--- Beispiel-Eintrag ---',
      (d.samples || [])[0] || '(keiner)',
      '--- Profile ---',
      (d.profiles || []).join('\n\n') || '-',
      'Browser: ' + navigator.userAgent,
    ].join('\n');
  }

  function copy(s) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(s).then(() => true, () => legacyCopy(s));
    }
    return Promise.resolve(legacyCopy(s));
  }
  function legacyCopy(s) {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  /* ------------------------------------------------------------------ *
   *  Start
   * ------------------------------------------------------------------ */
  function start() {
    injectCSS();
    prune();
    learnPattern(document, location.href); // falls man gerade auf einem Profil ist
    decorate(document.body);

    document.addEventListener('click', (e) => {
      const box = e.target.closest && e.target.closest('.lmac-box');
      if (box) {
        e.preventDefault();
        e.stopPropagation();
        openPop(box);
      } else if (pop && !e.target.closest('.lmac-pop')) {
        closePop();
      }
    }, true);

    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1 && !node.classList.contains('lmac-box')) decorate(node);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);

  if (window.__LMAC_TEST__) window.__LMAC__ = { parseEntries, findTabPane, patternFrom, resultFor };
})();
