/* ============================================================================
 * app.js — bootstrap, tiny screen router, screens.
 * Classic script (no modules): expects window.CH_CONFIG, window.CHApi.
 * ==========================================================================*/
(function () {
  'use strict';

  var CFG = window.CH_CONFIG;
  var api = window.CHApi;
  var state = window.CHState;
  var root = document.getElementById('app');
  var templatesSyncedThisSession = false;

  // ---- tiny DOM helper -----------------------------------------------------
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      } else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  // One shared getUserMedia feed + geolocation watch power the capture screen.
  var activeStream = null;
  var geoWatchId = null;
  var lastFix = null;   // most recent { lat, lon, acc } for stamping photos
  function stopCamera() {
    if (activeStream) { activeStream.getTracks().forEach(function (t) { t.stop(); }); activeStream = null; }
    if (geoWatchId != null && navigator.geolocation) { try { navigator.geolocation.clearWatch(geoWatchId); } catch (e) {} }
    geoWatchId = null; lastFix = null;
  }
  // Start watching position when the capture screen opens; cache the latest fix
  // so each shutter press stamps instantly (no per-photo GPS wait). Denial /
  // unavailability is silent — photos then stamp time only.
  function startGeo() {
    if (geoWatchId != null || !navigator.geolocation) return;
    try {
      geoWatchId = navigator.geolocation.watchPosition(
        function (p) { lastFix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }; },
        function () { /* denied / unavailable — leave lastFix as-is/null */ },
        { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
      );
    } catch (e) { /* ignore */ }
  }

  // ---- photo capture stamp (burned into the JPEG) --------------------------
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function stampTime(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
           pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function tzAbbrev(d) {
    try { var m = d.toLocaleTimeString('en-AU', { timeZoneName: 'short' }).match(/[A-Z]{2,5}$/); if (m) return m[0]; } catch (e) {}
    var off = -d.getTimezoneOffset() / 60; return 'GMT' + (off >= 0 ? '+' : '') + off;
  }
  function mapsLink(geo) { return 'https://www.google.com/maps?q=' + geo.lat.toFixed(6) + ',' + geo.lon.toFixed(6); }
  // Burn a bottom-strip stamp (time + position) onto a canvas already holding the frame.
  function burnStamp(canvas, timeStr, geo) {
    var cx = canvas.getContext('2d');
    var l1 = timeStr;
    var l2 = geo ? (geo.lat.toFixed(6) + ', ' + geo.lon.toFixed(6) + '  (±' + Math.round(geo.acc) + ' m)') : 'Location unavailable';
    var scale = Math.max(1, canvas.width / 1000);
    var fs = Math.round(22 * scale), pad = Math.round(10 * scale), band = fs * 2 + pad * 3;
    cx.save();
    cx.fillStyle = 'rgba(0,0,0,0.55)'; cx.fillRect(0, canvas.height - band, canvas.width, band);
    cx.fillStyle = '#fff'; cx.textBaseline = 'top';
    cx.font = 'bold ' + fs + 'px Helvetica, Arial, sans-serif';
    cx.fillText(l1, pad, canvas.height - band + pad);
    cx.font = fs + 'px Helvetica, Arial, sans-serif';
    cx.fillText(l2, pad, canvas.height - band + pad * 2 + fs);
    cx.restore();
  }

  // ---- Location map (OSM tiles; report "Defect Locations" section) ---------
  // Best-effort: needs connectivity at generation time. OSM tiles send
  // Access-Control-Allow-Origin:* so the bytes are fetchable + the canvas isn't
  // tainted (crossOrigin='anonymous'). Returns null on any failure/offline so
  // the report still generates (the defect list + per-photo links stand alone).
  function lon2tile(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
  function lat2tile(lat, z) { var r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z); }
  function loadTile(url) {
    return new Promise(function (resolve) {
      var im = new Image(); im.crossOrigin = 'anonymous';
      im.onload = function () { resolve(im); };
      im.onerror = function () { resolve(null); };
      im.src = url;
    });
  }
  // Whether this inspection type gets the location-map section.
  function matchesLocationMap(name) {
    var terms = CFG.locationMapMatch || [], n = String(name || '').toLowerCase();
    for (var i = 0; i < terms.length; i++) { if (n.indexOf(String(terms[i]).toLowerCase()) !== -1) return true; }
    return false;
  }
  // Ordered list of GPS-tagged photos across the inspection -> numbered pins.
  function geoPhotosOf(config, capture) {
    var out = [], n = 0;
    config.questions.slice().sort(byOrder).forEach(function (q) {
      var a = capture.answers[q.id] || {};
      (a.photos || []).forEach(function (p) {
        if (p.geo) { n++; out.push({ n: n, text: String(q.text || '').replace(/^\s*\d+\.\s*/, '').slice(0, 70), lat: p.geo.lat, lon: p.geo.lon, acc: p.geo.acc, link: mapsLink(p.geo) }); }
      });
    });
    return out;
  }
  // points: [{ n, lat, lon }] -> Promise<Blob|null> (stitched OSM map w/ pins).
  function buildLocationMap(points) {
    if (!points.length) return Promise.resolve(null);
    var TILE = 256, MAXT = 3;   // ≤3×3 tiles (≤768px, ≤9 fetches) — gentle on OSM
    var lats = points.map(function (p) { return p.lat; }), lons = points.map(function (p) { return p.lon; });
    var minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
    var minLon = Math.min.apply(null, lons), maxLon = Math.max.apply(null, lons);
    var padLat = Math.max((maxLat - minLat) * 0.15, 0.0015), padLon = Math.max((maxLon - minLon) * 0.15, 0.0015);
    minLat -= padLat; maxLat += padLat; minLon -= padLon; maxLon += padLon;
    // Highest zoom (≤18) whose FLOORED tile range fits within MAXT tiles/axis —
    // bounding the actual fetch count (fractional span alone can spill to +1 tile).
    var z = 18, tx0, tx1, ty0, ty1;
    for (; z >= 1; z--) {
      tx0 = Math.floor(lon2tile(minLon, z)); tx1 = Math.floor(lon2tile(maxLon, z));
      ty0 = Math.floor(lat2tile(maxLat, z)); ty1 = Math.floor(lat2tile(minLat, z));
      if ((tx1 - tx0 + 1) <= MAXT && (ty1 - ty0 + 1) <= MAXT) break;
    }
    var canvas = document.createElement('canvas');
    canvas.width = (tx1 - tx0 + 1) * TILE; canvas.height = (ty1 - ty0 + 1) * TILE;
    var cx = canvas.getContext('2d');
    cx.fillStyle = '#e8ecef'; cx.fillRect(0, 0, canvas.width, canvas.height);
    var jobs = [];
    for (var tx = tx0; tx <= tx1; tx++) {
      for (var ty = ty0; ty <= ty1; ty++) {
        (function (tx, ty) {
          jobs.push(loadTile('https://tile.openstreetmap.org/' + z + '/' + tx + '/' + ty + '.png').then(function (im) {
            if (im) cx.drawImage(im, (tx - tx0) * TILE, (ty - ty0) * TILE);
          }));
        })(tx, ty);
      }
    }
    return Promise.all(jobs).then(function () {
      points.forEach(function (p) {
        var px = (lon2tile(p.lon, z) - tx0) * TILE, py = (lat2tile(p.lat, z) - ty0) * TILE;
        cx.beginPath(); cx.arc(px, py, 13, 0, 2 * Math.PI); cx.fillStyle = '#d0021b'; cx.fill();
        cx.lineWidth = 2; cx.strokeStyle = '#fff'; cx.stroke();
        cx.fillStyle = '#fff'; cx.font = 'bold 15px Helvetica, Arial, sans-serif';
        cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillText(String(p.n), px, py);
      });
      var att = '© OpenStreetMap contributors';
      cx.font = '12px Helvetica, Arial, sans-serif';
      var w = cx.measureText(att).width + 10;
      cx.fillStyle = 'rgba(255,255,255,0.8)'; cx.fillRect(canvas.width - w, canvas.height - 18, w, 18);
      cx.fillStyle = '#333'; cx.textAlign = 'left'; cx.textBaseline = 'top'; cx.fillText(att, canvas.width - w + 5, canvas.height - 16);
      return new Promise(function (res) { canvas.toBlob(function (b) { res(b); }, 'image/jpeg', 0.85); });
    }).catch(function () { return null; });
  }

  // Navigating away from any screen tears the camera down; CaptureScreen restarts it.
  function mount(view) { stopCamera(); clear(root); root.appendChild(view); window.scrollTo(0, 0); }

  function sanitizeName(s) {
    return String(s).replace(/[^A-Za-z0-9 ()._-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  // Fetch the report logo and return it as a JPEG blob (white background).
  // Uses fetch->blob->createImageBitmap so the canvas isn't cross-origin tainted.
  // Returns null on any failure (no logo / offline / CORS) — the report just omits it.
  async function fetchLogoBlob(url) {
    if (!url) return null;
    try {
      var resp = await fetch(url, { mode: 'cors' });
      if (!resp.ok) return null;
      var bmp = await createImageBitmap(await resp.blob());
      var c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      return await new Promise(function (res) { c.toBlob(function (b) { res(b); }, 'image/jpeg', 0.92); });
    } catch (e) { return null; }
  }

  function pickName(u) {
    if (!u || typeof u !== 'object') return '';
    return u.fullName || u.userFullName || u.name ||
           [u.firstName, u.lastName].filter(Boolean).join(' ') ||
           u.userName || u.username || '';
  }

  // Normalise a MasterContracts/List row into the fields the UI needs.
  function mapJob(m) {
    var cc = m.constructionContract || {};
    var pc = m.preconstructionContract || {};
    var st = cc.stage || {};
    var tmpl = cc.template || {};
    // Build stage: fkidStage -> tblStages.sgStageName (e.g. 'Tiler').
    var stageName = st.stageName || st.name || st.description || (st.stageId ? 'Stage ' + st.stageId : '');
    var summary = (cc.summary && cc.summary.summary) || (pc.summary && pc.summary.summary) || '';
    return {
      raw: m,
      masterContractId: m.masterContractId,
      contractId: cc.contractId || null,          // construction child — inspections attach here
      contractNumber: m.contractNumber || cc.contractNumber || '',
      address: (m.lotAddress && m.lotAddress.address) || '',
      stage: stageName,                           // build stage (e.g. 'Tiler')
      summary: summary,                           // current construction milestone
      templateId: tmpl.templateId || null,        // key for the inspection-types lookup
      templateName: tmpl.templateName || tmpl.name || '',
      // What the card chip shows: prefer the real stage, else the milestone.
      badge: stageName || summary,
      client: (m.client && (m.client.letterTitle || m.client.clientTitle)) || '',
      supervisor: (cc.supervisor && cc.supervisor.fullName) || '',
      canAddInspection: !!(cc.security && cc.security.canAddInspection)
    };
  }

  // ---- Login screen --------------------------------------------------------
  function LoginScreen() {
    var errorBox = el('div', { class: 'error', role: 'alert' });
    var submitBtn = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Sign in' });

    var sysSelect = el('select', { id: 'system', name: 'system', class: 'sys-select', required: 'required' });
    sysSelect.appendChild(el('option', { value: '', disabled: 'disabled' }, ['Select ClickHome system…']));
    CFG.options.forEach(function (o) { sysSelect.appendChild(el('option', { value: o.key }, [o.label])); });
    sysSelect.value = CFG.activeKey || '';

    var userInput = el('input', {
      type: 'text', id: 'username', name: 'username', autocomplete: 'username',
      autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', required: 'required',
      placeholder: 'Username'
    });
    var passInput = el('input', {
      type: 'password', id: 'password', name: 'password', autocomplete: 'current-password',
      required: 'required', placeholder: 'Password'
    });

    function setBusy(busy) { submitBtn.disabled = busy; submitBtn.textContent = busy ? 'Signing in…' : 'Sign in'; }

    async function onSubmit(e) {
      e.preventDefault();
      errorBox.textContent = '';
      if (!sysSelect.value || !CFG.selectSystem(sysSelect.value)) { errorBox.textContent = 'Please select a ClickHome system.'; return; }
      setBusy(true);
      try {
        var user = await api.login(userInput.value.trim(), passInput.value);
        JobListScreen(user);
      } catch (err) {
        errorBox.textContent = err.message || 'Sign in failed.';
      } finally {
        setBusy(false);
      }
    }

    var form = el('form', { class: 'login-form', onSubmit: onSubmit, autocomplete: 'on' }, [
      el('label', { for: 'system', text: 'ClickHome system' }), sysSelect,
      el('label', { for: 'username', text: 'Username' }), userInput,
      el('label', { for: 'password', text: 'Password' }), passInput,
      errorBox, submitBtn
    ]);

    return el('div', { class: 'screen screen-login' }, [
      el('div', { class: 'brand' }, [
        el('div', { class: 'brand-mark', text: 'CH' }),
        el('h1', { text: 'Supervisor Inspections' })
      ]),
      form,
      el('p', { class: 'hint', text: 'Choose your system, then sign in with your ClickHome account. Your browser can save these credentials.' })
    ]);
  }

  // ---- shared top bar ------------------------------------------------------
  function topBar(title, opts) {
    opts = opts || {};
    var right = [];
    if (opts.onRefresh) right.push(el('button', { class: 'btn btn-link', text: '↻', title: 'Refresh', onClick: opts.onRefresh }));
    right.push(el('button', { class: 'btn btn-link', text: 'Sign out', onClick: function () { api.logout(); mount(LoginScreen()); } }));
    return el('header', { class: 'topbar' }, [
      opts.onBack ? el('button', { class: 'btn btn-link', text: '‹ Back', onClick: opts.onBack }) : el('span'),
      el('div', { class: 'topbar-title', text: title }),
      el('div', { class: 'topbar-actions' }, right)
    ]);
  }

  // ---- Job list ------------------------------------------------------------
  function JobListScreen() {
    var listWrap = el('div', { class: 'joblist' }, [el('p', { class: 'muted', text: 'Loading jobs…' })]);
    var uploadsBar = el('div', { class: 'uploads-bar' }); uploadsBar.style.display = 'none';
    var syncStatus = el('span', { class: 'sync-status' });
    var pendingCount = {};

    async function syncTemplates(manual) {
      if (!(window.CHStore && CHStore.available)) { if (manual) syncStatus.textContent = 'On-device storage unavailable.'; return; }
      if (!(CFG.agent && CFG.agent.password)) { if (manual) syncStatus.textContent = 'Set the config-account password in config.js to enable offline templates.'; return; }
      syncStatus.textContent = 'Syncing…';
      try {
        try { await api.refreshDocCategories(); } catch (e) { /* non-fatal — keep cached/config ids */ }
        try { await api.refreshPciLists(); } catch (e) { /* non-fatal — keep cached/seed PCI lists */ }
        var r = await api.bulkCacheAllTemplates(function (done, total) { syncStatus.textContent = 'Syncing templates… ' + done + '/' + total; });
        templatesSyncedThisSession = true;
        syncStatus.textContent = '✓ ' + r.cached + '/' + r.total + ' templates + doc categories + PCI lists cached for offline';
      } catch (e) { syncStatus.textContent = manual ? ('Sync failed: ' + (e.message || e)) : ''; }
    }

    function render(jobs) {
      clear(listWrap);
      if (!jobs || !jobs.length) { listWrap.appendChild(el('p', { class: 'muted', text: 'No active construction jobs assigned to you.' })); return; }
      jobs.forEach(function (j) {
        var n = pendingCount[j.masterContractId] || 0;
        listWrap.appendChild(el('button', { class: 'job-card', onClick: function () { JobScreen(j); } }, [
          el('div', { class: 'job-top' }, [
            el('span', { class: 'job-no', text: j.contractNumber || '(no number)' }),
            j.badge ? el('span', { class: 'job-stage', text: j.badge }) : null,
            n ? el('span', { class: 'up-badge', text: '⬆ ' + n }) : null
          ]),
          el('div', { class: 'job-addr', text: j.address || '—' }),
          j.client ? el('div', { class: 'job-client', text: j.client }) : null
        ]));
      });
    }

    async function refreshPending() {
      pendingCount = {}; var total = 0;
      if (window.CHStore && CHStore.available) {
        try { (await CHStore.pendingAll()).forEach(function (p) { if (!p.complete) { pendingCount[p.masterContractId] = (pendingCount[p.masterContractId] || 0) + 1; total++; } }); } catch (e) {}
      }
      clear(uploadsBar);
      if (total) {
        uploadsBar.style.display = '';
        uploadsBar.appendChild(el('button', { class: 'btn-warn', text: '⬆ ' + total + ' inspection' + (total > 1 ? 's' : '') + ' waiting to upload — review', onClick: function () { PendingScreen(); } }));
      } else { uploadsBar.style.display = 'none'; }
    }

    async function load() {
      await refreshPending();
      // Apply this system's resolved doc-category ids (cached from a prior sync)
      // so upload uses the right per-instance ids, even offline.
      if (window.CHStore && CHStore.available && CFG.systemId) { try { var dc = await CHStore.cacheGet(CFG.ns('doccats')); if (dc && dc.data && dc.data.inspections != null && dc.data.inspectionPhotos != null) CFG.docCategories = dc.data; } catch (e) {} }
      var cached = null;
      if (window.CHStore && CHStore.available) { try { cached = await CHStore.cacheGet(CFG.ns('joblist')); } catch (e) {} }
      if (cached && cached.data) render(cached.data);
      try {
        var data = await api.listMyConstructionJobs();
        var rows = ((data && data.results) || (Array.isArray(data) ? data : [])).map(mapJob);
        if (window.CHStore && CHStore.available) CHStore.cachePut(CFG.ns('joblist'), rows).catch(function () {});
        render(rows);
      } catch (err) {
        if (err && err.name === 'AuthError') { mount(LoginScreen()); return; }
        if (!(cached && cached.data)) { clear(listWrap); listWrap.appendChild(el('p', { class: 'error', text: 'Offline and no cached jobs yet: ' + (err.message || err) })); }
      }
      if (!templatesSyncedThisSession) syncTemplates(false);   // background pre-cache for offline
    }

    var view = el('div', { class: 'screen screen-jobs' }, [
      topBar('My Jobs', { onRefresh: load }),
      el('p', { class: 'subtle', text: (pickName(state.user) ? pickName(state.user) + ' · ' : '') + CFG.label }),
      el('div', { class: 'sync-row' }, [
        el('button', { class: 'btn-link-sm', text: '⟳ Sync for offline', onClick: function () { syncTemplates(true); } }),
        syncStatus
      ]),
      uploadsBar,
      listWrap
    ]);
    mount(view);
    load();
  }

  // ---- Single job (inspection types come next) -----------------------------
  function JobScreen(job) {
    var view = el('div', { class: 'screen screen-job' }, [
      topBar('Job', { onBack: function () { JobListScreen(); } }),
      el('div', { class: 'job-head' }, [
        el('h2', { text: job.contractNumber }),
        el('p', { class: 'job-addr', text: job.address || '—' }),
        job.client ? el('p', { class: 'subtle', text: job.client }) : null,
        job.stage ? el('p', { class: 'subtle', text: 'Stage: ' + job.stage }) : null,
        job.summary ? el('p', { class: 'subtle', text: 'Milestone: ' + job.summary }) : null,
        job.supervisor ? el('p', { class: 'subtle', text: 'Supervisor: ' + job.supervisor }) : null
      ]),
      el('div', { class: 'card' }, [
        el('h3', { text: 'Inspections' }),
        el('button', { class: 'btn btn-primary', text: 'Inspections',
          onClick: function () { ContractInspectionsScreen(job); } }),
        el('p', { class: 'subtle', text: 'master ' + job.masterContractId + ' · construction ' + job.contractId +
          (job.templateName ? ' · ' + job.templateName + ' (' + job.templateId + ')' : '') })
      ])
    ]);
    mount(view);
  }

  // ---- Inspections on a job (from inspRequireds; supervisor token) ---------
  function fmtDate(s) { return s ? String(s).slice(0, 10) : ''; }

  // ---- on-device draft (crash/offline safety net) --------------------------
  function draftIdFor(job, inspTemplateId) { return job.masterContractId + ':' + inspTemplateId; }
  function serializeDraft(draftId, job, config, capture) {
    var answers = {};
    Object.keys(capture.answers || {}).forEach(function (qid) {
      var a = capture.answers[qid];
      answers[qid] = {
        value: a.value, comment: a.comment || '', nextSeq: a.nextSeq || 1,
        // Store the photo BLOB (durable); the object URL is recreated on resume.
        photos: (a.photos || []).map(function (p) { return { seq: p.seq, label: p.label, name: p.name, source: p.source, blob: p.blob, geo: p.geo || null, when: p.when || null }; })
      };
    });
    // PCI defect-logging captures store `defects` instead of `answers`.
    var defects = (capture.defects || []).map(function (d) {
      return { id: d.id, areaId: d.areaId, area: d.area, categoryId: d.categoryId, category: d.category, comment: d.comment || '', nextSeq: d.nextSeq || 1,
        photos: (d.photos || []).map(function (p) { return { seq: p.seq, label: p.label, name: p.name, source: p.source, blob: p.blob, geo: p.geo || null, when: p.when || null }; }) };
    });
    return { draftId: draftId, masterContractId: job.masterContractId, contractNumber: job.contractNumber, address: job.address, inspTemplateId: config.inspTemplateId, name: config.name, inst: capture.inst || null, updatedAt: Date.now(), answers: answers, defects: defects };
  }
  function rehydrateDraft(draft) {
    var capture = { answers: {}, _resumedAt: draft.updatedAt, inst: draft.inst || null };
    Object.keys(draft.answers || {}).forEach(function (qid) {
      var a = draft.answers[qid];
      capture.answers[qid] = {
        value: a.value, comment: a.comment || '', nextSeq: a.nextSeq || ((a.photos ? a.photos.length : 0) + 1),
        photos: (a.photos || []).map(function (p) { return { seq: p.seq, label: p.label, name: p.name, source: p.source, blob: p.blob, url: URL.createObjectURL(p.blob), geo: p.geo || null, when: p.when || null }; })
      };
    });
    if (draft.defects && draft.defects.length) {
      capture.defects = draft.defects.map(function (d) {
        return { id: d.id, areaId: d.areaId, area: d.area, categoryId: d.categoryId, category: d.category, comment: d.comment || '', nextSeq: d.nextSeq || ((d.photos ? d.photos.length : 0) + 1),
          photos: (d.photos || []).map(function (p) { return { seq: p.seq, label: p.label, name: p.name, source: p.source, blob: p.blob, url: URL.createObjectURL(p.blob), geo: p.geo || null, when: p.when || null }; }) };
      });
    }
    return capture;
  }

  function ContractInspectionsScreen(job) {
    var wrap = el('div', { class: 'joblist' }, [el('p', { class: 'muted', text: 'Loading inspections…' })]);

    function renderList(items, pendingRecs) {
      clear(wrap);
      if (pendingRecs && pendingRecs.length) {
        wrap.appendChild(el('h3', { class: 'cat-head', text: 'Waiting to upload' }));
        pendingRecs.forEach(function (r) {
          var left = r.items.filter(function (x) { return !x.done; }).length + (r.defects ? r.defects.filter(function (x) { return !x.done; }).length : 0);
          wrap.appendChild(el('button', { class: 'job-card', onClick: function () { CommitScreen(r, function () { ContractInspectionsScreen(job); }); } }, [
            el('div', { class: 'job-top' }, [el('span', { class: 'job-no', text: r.name }), el('span', { class: 'up-badge', text: '⬆ ' + left + ' left' })]),
            el('div', { class: 'job-client', text: 'Tap to upload' })
          ]));
        });
      }
      var pend = items.filter(function (i) { return !i.done; });
      var done = items.filter(function (i) { return i.done; });
      if (pend.length) { wrap.appendChild(el('h3', { class: 'cat-head', text: 'Pending' })); pend.forEach(function (i) { wrap.appendChild(inspCard(job, i, true)); }); }
      if (done.length) { wrap.appendChild(el('h3', { class: 'cat-head', text: 'Completed' })); done.forEach(function (i) { wrap.appendChild(inspCard(job, i, false)); }); }
      if (!items.length && !(pendingRecs && pendingRecs.length)) wrap.appendChild(el('p', { class: 'muted', text: 'No inspections generated on this job yet.' }));
    }

    async function load() {
      var pendingRecs = [];
      if (window.CHStore && CHStore.available) { try { pendingRecs = (await CHStore.pendingAll()).filter(function (r) { return !r.complete && r.masterContractId === job.masterContractId; }); } catch (e) {} }
      var cacheKey = CFG.ns('inspections:' + job.masterContractId), cached = null;
      if (window.CHStore && CHStore.available) { try { cached = await CHStore.cacheGet(cacheKey); } catch (e) {} }
      if (cached && cached.data) renderList(cached.data, pendingRecs);
      try {
        var data = await api.getContractInspections(job.masterContractId);
        var items = data.inspections || [];
        if (window.CHStore && CHStore.available) CHStore.cachePut(cacheKey, items).catch(function () {});
        renderList(items, pendingRecs);
      } catch (e) {
        if (e && e.name === 'AuthError') { mount(LoginScreen()); return; }
        if (!(cached && cached.data)) { renderList([], pendingRecs); wrap.appendChild(el('p', { class: 'error', text: 'Offline — no cached inspections for this job yet.' })); }
      }
    }

    mount(el('div', { class: 'screen' }, [
      topBar('Inspections', { onBack: function () { JobListScreen(); }, onRefresh: load }),
      el('p', { class: 'subtle', text: job.contractNumber + ' · ' + (job.address || '') }),
      wrap
    ]));
    load();
  }

  function inspCard(job, i, actionable) {
    var children = [
      el('div', { class: 'job-top' }, [
        el('span', { class: 'job-no', text: i.name || i.taskName }),
        i.adHoc ? el('span', { class: 'job-stage', text: 'Ad-hoc' }) : null
      ]),
      el('div', { class: 'job-client', text: 'Task: ' + i.taskName }),
      i.done
        ? el('div', { class: 'subtle', text: '✓ Completed ' + fmtDate(i.inspectedOn) })
        : el('div', { class: 'subtle', text: 'Pending' })
    ];
    if (actionable) return el('button', { class: 'job-card', onClick: function () { openInspection(job, { inspTemplateId: i.inspTemplateId, name: i.name, inspRequiredId: i.inspRequiredId, taskId: i.taskId }); } }, children);
    return el('div', { class: 'job-card done' }, children);
  }

  async function openInspection(job, it) {
    var config;
    try {
      config = await api.getInspTemplateConfig(it.inspTemplateId);
    } catch (e) {
      mount(el('div', { class: 'screen' }, [
        topBar(it.name, { onBack: function () { ContractInspectionsScreen(job); } }),
        el('div', { class: 'card' }, [
          el('h3', { text: it.name }),
          el('p', { class: 'muted', text: 'This inspection’s question set isn’t cached yet (inspTemplate ' + it.inspTemplateId + '). Presite Safety (22) is wired for the demo; the rest populate once the admin config fetch is switched on.' })
        ])
      ]));
      return;
    }
    // Resume an in-progress draft for this inspection if one is saved on-device.
    var existing = null;
    if (window.CHStore && CHStore.available) {
      try { var draft = await CHStore.getDraft(draftIdFor(job, it.inspTemplateId)); if (draft) existing = rehydrateDraft(draft); } catch (e) { /* ignore */ }
    }
    CaptureScreen(job, config, existing, { inspRequiredId: it.inspRequiredId, taskId: it.taskId });
  }

  function byOrder(a, b) { return (a.order || 0) - (b.order || 0); }
  function rtOf(q) { return CFG.responseTypes[q.responseType] || { kind: 'unsupported', label: 'Type ' + q.responseType }; }
  // PCI = any item is an area-based type (6/7/8). These use the free-form
  // defect-logging capture mode instead of the flat question list.
  function isPciConfig(config) { return (config.questions || []).some(function (q) { return rtOf(q).kind === 'pci'; }); }
  function valueLabel(rt, value) {
    if (value == null || value === '') return 'Not answered';
    if (rt.kind === 'choice') { var o = (rt.options || []).filter(function (x) { return Number(x.value) === Number(value); })[0]; return o ? o.label : String(value); }
    return String(value);
  }

  // ---- Capture -------------------------------------------------------------
  function CaptureScreen(job, config, existing, inst) {
    if (isPciConfig(config)) return DefectScreen(job, config, existing, inst);   // area-based PCI -> defect logging
    var capture = existing || { answers: {} };
    if (inst && !capture.inst) capture.inst = inst;   // {inspRequiredId, taskId} — for close-out linking
    config.questions.forEach(function (q) { if (!capture.answers[q.id]) capture.answers[q.id] = { value: null, comment: '', photos: [], nextSeq: 1 }; });

    var resumed = !!(existing && existing._resumedAt);
    var draftId = draftIdFor(job, config.inspTemplateId);
    var canPersist = !!(window.CHStore && CHStore.available);
    var saveTimer = null;
    function hasContent() {
      return Object.keys(capture.answers).some(function (qid) {
        var a = capture.answers[qid];
        return (a.value != null && a.value !== '') || (a.comment && a.comment.trim()) || (a.photos && a.photos.length);
      });
    }
    function saveDraft() {
      if (!canPersist) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () { if (hasContent()) CHStore.putDraft(serializeDraft(draftId, job, config, capture)).catch(function () {}); }, 400);
    }

    // Shared live camera feed shown in a fixed inset; each question captures from it.
    var video = el('video', { autoplay: '', playsinline: '' }); video.muted = true;
    var camStatus = el('div', { class: 'cam-status', text: 'Starting camera…' });
    var pip = el('div', { class: 'cam-pip' }, [video, camStatus]);
    var canvas = document.createElement('canvas');
    function grabFrame() {
      if (!video.videoWidth) return Promise.resolve(null);
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      var now = new Date();
      var when = stampTime(now) + ' ' + tzAbbrev(now);
      var geo = lastFix ? { lat: lastFix.lat, lon: lastFix.lon, acc: lastFix.acc } : null;
      burnStamp(canvas, when, geo);
      return new Promise(function (resolve) {
        canvas.toBlob(function (b) { resolve(b ? { blob: b, url: URL.createObjectURL(b), geo: geo, when: when } : null); }, 'image/jpeg', 0.85);
      });
    }

    var controllers = [];
    var progress = el('span', { class: 'progress-count' });
    var reviewBtn = el('button', { class: 'btn btn-primary', text: 'Review', disabled: 'disabled',
      onClick: function () { ReviewScreen(job, config, capture); } });
    function refresh() {
      var done = controllers.filter(function (c) { return c.isComplete(); }).length;
      progress.textContent = done + ' / ' + controllers.length + ' complete';
      if (controllers.length && done === controllers.length) reviewBtn.removeAttribute('disabled');
      else reviewBtn.setAttribute('disabled', 'disabled');
      saveDraft();
    }

    var ctx = { onChange: refresh, contractNo: job.contractNumber, grabFrame: grabFrame };

    var body = el('div', { class: 'capture-body' });
    var qSorted = config.questions.slice().sort(byOrder);
    var cats = (config.categories && config.categories.length) ? config.categories : [{ id: null, name: '' }];
    cats.forEach(function (cat) {
      var qs = qSorted.filter(function (q) { return cat.id == null || q.categoryId === cat.id; });
      if (!qs.length) return;
      if (cat.name && cats.length > 1) body.appendChild(el('h3', { class: 'cat-head', text: cat.name }));
      qs.forEach(function (q) { var c = QuestionCard(q, capture.answers[q.id], ctx); controllers.push(c); body.appendChild(c.node); });
    });

    mount(el('div', { class: 'screen screen-capture' }, [
      topBar(config.name, { onBack: function () { ContractInspectionsScreen(job); } }),
      el('p', { class: 'subtle', text: job.contractNumber + ' · ' + (job.address || '') }),
      config.instructions ? el('p', { class: 'muted', text: config.instructions }) : null,
      body,
      el('div', { class: 'capture-foot' }, [
        el('div', { class: 'foot-left' }, [
          progress,
          canPersist ? el('span', { class: 'save-note', text: resumed ? 'Resumed saved draft · auto-saving' : 'Auto-saving on this device' }) : null
        ]),
        el('div', { class: 'foot-right' }, [
          canPersist ? el('button', { class: 'btn-lib', text: 'Discard', onClick: function () {
            if (!window.confirm('Discard this in-progress inspection? Photos and answers will be removed from this device.')) return;
            CHStore.deleteDraft(draftId).catch(function () {});
            CaptureScreen(job, config);
          } }) : null,
          reviewBtn
        ])
      ]),
      pip
    ]));
    refresh();
    startCamera(video, camStatus);
    startGeo();
  }

  // ---- PCI defect logging (area-based inspections; response types 6/7/8) ---
  // Free-form: a list of defects, each tagged with an Area + Issue Category +
  // comment + photo(s). No question x area matrix, no tblInspResults writes.
  function DefectScreen(job, config, existing, inst) {
    var capture = existing || {};
    if (!capture.defects) capture.defects = [];
    if (inst && !capture.inst) capture.inst = inst;
    var draftId = draftIdFor(job, config.inspTemplateId);
    var canPersist = !!(window.CHStore && CHStore.available);

    function saveDraft() {
      if (!canPersist) return;
      if (capture.defects.length) CHStore.putDraft(serializeDraft(draftId, job, config, capture)).catch(function () {});
    }

    var listWrap = el('div', { class: 'defect-list' });
    var finBtn = el('button', { class: 'btn btn-primary', text: 'Finalise →', onClick: function () { FinaliseScreen(job, config, capture); } });
    function updateFin() { if (capture.defects.length) finBtn.removeAttribute('disabled'); else finBtn.setAttribute('disabled', 'disabled'); }

    function renderList() {
      clear(listWrap);
      if (!capture.defects.length) listWrap.appendChild(el('p', { class: 'muted', text: 'No defects logged yet. Tap “+ Add defect”.' }));
      capture.defects.forEach(function (d, i) {
        listWrap.appendChild(el('div', { class: 'defect-row' }, [
          el('div', { class: 'defect-hd' }, [ el('span', { class: 'defect-area', text: d.area || '(no area)' }), el('span', { class: 'defect-cat', text: d.category || '(no category)' }) ]),
          (d.comment && d.comment.trim()) ? el('div', { class: 'subtle', text: d.comment }) : null,
          (d.photos && d.photos.length) ? el('div', { class: 'thumbs' }, d.photos.map(function (p) { return el('img', { class: 'thumb-sm', src: p.url, alt: p.name }); })) : null,
          el('div', { class: 'defect-actions' }, [
            el('button', { class: 'btn-lib', text: 'Edit', onClick: function () { DefectForm(job, config, capture, d, i); } }),
            el('button', { class: 'btn-lib', text: 'Remove', onClick: function () {
              (d.photos || []).forEach(function (p) { URL.revokeObjectURL(p.url); });
              capture.defects.splice(i, 1); saveDraft(); renderList(); updateFin();
            } })
          ])
        ]));
      });
    }
    renderList(); updateFin();

    mount(el('div', { class: 'screen screen-defects' }, [
      topBar(config.name, { onBack: function () { ContractInspectionsScreen(job); } }),
      el('p', { class: 'subtle', text: job.contractNumber + ' · ' + (job.address || '') }),
      el('p', { class: 'muted', text: 'Log each defect against a room/area and issue type, with a photo. ' + capture.defects.length + ' logged.' }),
      listWrap,
      el('div', { class: 'capture-foot' }, [
        el('button', { class: 'btn btn-capture', text: '+ Add defect', onClick: function () { DefectForm(job, config, capture, null, -1); } }),
        finBtn
      ])
    ]));
  }

  // Add / edit a single defect. Hosts the live camera so photos can be snapped
  // here (with the same GPS/time stamp + mark-up as the standard capture).
  function DefectForm(job, config, capture, existingDefect, idx) {
    var isNew = !existingDefect;
    var d = existingDefect || { id: 'd' + Date.now(), areaId: null, area: '', categoryId: null, category: '', comment: '', photos: [], nextSeq: 1 };
    var jobType = String(job.jobType || 'C').toUpperCase();
    var back = function () { DefectScreen(job, config, capture); };

    // live camera + geo (own inset, torn down on nav by mount())
    var video = el('video', { autoplay: '', playsinline: '' }); video.muted = true;
    var camStatus = el('div', { class: 'cam-status', text: 'Starting camera…' });
    var pip = el('div', { class: 'cam-pip' }, [video, camStatus]);
    var canvas = document.createElement('canvas');
    function grabFrame() {
      if (!video.videoWidth) return Promise.resolve(null);
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      var now = new Date(), when = stampTime(now) + ' ' + tzAbbrev(now);
      var geo = lastFix ? { lat: lastFix.lat, lon: lastFix.lon, acc: lastFix.acc } : null;
      burnStamp(canvas, when, geo);
      return new Promise(function (res) { canvas.toBlob(function (b) { res(b ? { blob: b, url: URL.createObjectURL(b), geo: geo, when: when } : null); }, 'image/jpeg', 0.85); });
    }

    // Area picker (grouped by room group) + Category picker (filtered by job type)
    var lists = { masterAreas: [], issueCategories: [] };
    var areaSel = document.createElement('select'); areaSel.className = 'fld';
    var catSel = document.createElement('select'); catSel.className = 'fld';
    function fillPickers() {
      areaSel.innerHTML = ''; catSel.innerHTML = '';
      areaSel.appendChild(new Option('— Select area —', ''));
      var groups = {};
      (lists.masterAreas || []).forEach(function (a) { (groups[a.group || 'Other'] = groups[a.group || 'Other'] || []).push(a); });
      Object.keys(groups).sort().forEach(function (g) {
        var og = document.createElement('optgroup'); og.label = g;
        groups[g].forEach(function (a) { var o = new Option(a.name, String(a.id)); og.appendChild(o); });
        areaSel.appendChild(og);
      });
      if (d.areaId != null) areaSel.value = String(d.areaId);
      catSel.appendChild(new Option('— Select issue category —', ''));
      (lists.issueCategories || []).filter(function (c) { return !c.jobType || c.jobType.toUpperCase() === jobType; })
        .forEach(function (c) { catSel.appendChild(new Option(c.name, String(c.id))); });
      if (d.categoryId != null) catSel.value = String(d.categoryId);
    }
    areaSel.addEventListener('change', function () { d.areaId = areaSel.value ? Number(areaSel.value) : null; d.area = areaSel.options[areaSel.selectedIndex] ? areaSel.options[areaSel.selectedIndex].text : ''; });
    catSel.addEventListener('change', function () { d.categoryId = catSel.value ? Number(catSel.value) : null; d.category = catSel.options[catSel.selectedIndex] ? catSel.options[catSel.selectedIndex].text : ''; });

    var commentTa = el('textarea', { class: 'comment-ta', rows: '3', placeholder: 'Describe the defect' });
    commentTa.value = d.comment || '';
    commentTa.addEventListener('input', function () { d.comment = commentTa.value; });

    // photos
    var thumbs = el('div', { class: 'thumbs' });
    var fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true }); fileInput.style.display = 'none';
    fileInput.addEventListener('change', function () { Array.prototype.forEach.call(fileInput.files, function (f) { addPhoto(f, URL.createObjectURL(f), 'library', null); }); fileInput.value = ''; });
    function addPhoto(blob, url, source, meta) {
      var seq = d.nextSeq || (d.photos.length + 1); d.nextSeq = seq + 1;
      var label = job.contractNumber + ' - ' + (d.area || 'Area') + ' - ' + (d.category || 'Defect') + ' (' + seq + ')';
      d.photos.push({ blob: blob, url: url, source: source, seq: seq, label: label, name: sanitizeName(label) + '.jpg', geo: (meta && meta.geo) || null, when: (meta && meta.when) || null });
      renderThumbs();
    }
    function renderThumbs() {
      clear(thumbs);
      d.photos.forEach(function (p, i) {
        var image = el('img', { src: p.url, alt: p.label });
        function edit() { PhotoMarkup(p, function (b, u) { URL.revokeObjectURL(p.url); p.blob = b; p.url = u; image.src = u; }); }
        image.addEventListener('click', edit);
        thumbs.appendChild(el('div', { class: 'thumb', title: p.label + ' — tap to mark up' }, [
          image, el('span', { class: 'seq', text: '(' + p.seq + ')' }),
          el('button', { class: 'thumb-edit', text: '✎', title: 'Mark up', onClick: edit }),
          el('button', { class: 'thumb-x', text: '×', onClick: function () { URL.revokeObjectURL(p.url); d.photos.splice(i, 1); renderThumbs(); } })
        ]));
      });
    }
    renderThumbs();

    var captureBtn = el('button', { class: 'btn btn-capture', text: '📷 Capture', onClick: function () {
      Promise.resolve(grabFrame()).then(function (f) { if (f) addPhoto(f.blob, f.url, 'camera', { geo: f.geo, when: f.when }); else fileInput.click(); });
    } });
    var status = el('div', { class: 'error' });
    var saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? 'Add defect' : 'Save defect', onClick: function () {
      if (!d.areaId) { status.textContent = 'Pick an area.'; return; }
      if (!d.categoryId) { status.textContent = 'Pick an issue category.'; return; }
      if (isNew) capture.defects.push(d);
      if (window.CHStore && CHStore.available) CHStore.putDraft(serializeDraft(draftIdFor(job, config.inspTemplateId), job, config, capture)).catch(function () {});
      back();
    } });

    mount(el('div', { class: 'screen screen-defect-form' }, [
      topBar(isNew ? 'Add defect' : 'Edit defect', { onBack: back }),
      el('p', { class: 'subtle', text: config.name + ' · ' + job.contractNumber }),
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: 'Area' }), areaSel]),
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: 'Issue category' }), catSel]),
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: 'Comment' }), commentTa]),
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: 'Photos' }), thumbs, el('div', { class: 'photo-actions' }, [captureBtn, el('button', { class: 'btn-lib', text: 'Library', onClick: function () { fileInput.click(); } })]), fileInput]),
      status,
      el('div', { class: 'capture-foot' }, [
        el('button', { class: 'btn-lib', text: 'Cancel', onClick: back }),
        saveBtn
      ]),
      pip
    ]));
    startCamera(video, camStatus); startGeo();
    api.loadPciLists().then(function (l) { lists = l || lists; fillPickers(); }).catch(function () { fillPickers(); });
  }

  function startCamera(video, statusEl) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { statusEl.textContent = 'No camera'; return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then(function (stream) {
        activeStream = stream; video.srcObject = stream;
        var p = video.play(); if (p && p.catch) p.catch(function () {});
        statusEl.textContent = '● Live'; statusEl.classList.add('live');
      })
      .catch(function () { statusEl.textContent = 'Camera blocked — use Library'; });
  }

  function QuestionCard(q, ans, ctx) {
    var rt = rtOf(q);
    var node = el('div', { class: 'q-card' });
    node.appendChild(el('div', { class: 'q-text', text: q.text }));

    var inputRow = el('div', { class: 'q-input' });
    var choiceBtns = {};
    if (rt.kind === 'choice') {
      rt.options.forEach(function (opt) {
        var b = el('button', { class: 'opt-btn', text: opt.label, onClick: function () { ans.value = opt.value; paintChoice(); updateStates(); ctx.onChange(); } });
        choiceBtns[opt.value] = b; inputRow.appendChild(b);
      });
    } else if (rt.kind === 'number') {
      var ni = el('input', { type: 'number', min: String(rt.min), max: String(rt.max), placeholder: rt.min + '–' + rt.max });
      if (ans.value != null) ni.value = ans.value;
      ni.addEventListener('input', function () { ans.value = ni.value === '' ? null : Number(ni.value); updateStates(); ctx.onChange(); });
      inputRow.appendChild(ni);
    } else if (rt.kind === 'text') {
      var ti = el('textarea', { rows: '2', placeholder: 'Enter response' });
      if (typeof ans.value === 'string') ti.value = ans.value;
      ti.addEventListener('input', function () { ans.value = ti.value; updateStates(); ctx.onChange(); });
      inputRow.appendChild(ti);
    } else {
      inputRow.appendChild(el('p', { class: 'muted', text: 'Response type "' + rt.label + '" isn’t supported in this version.' }));
    }
    node.appendChild(inputRow);

    var failBadge = el('div', { class: 'fail-badge', text: '⚠ Fail — needs attention' });
    failBadge.style.display = 'none'; node.appendChild(failBadge);

    var commentLabel = el('label', { class: 'field-label' });
    var commentTa = el('textarea', { class: 'comment-ta', rows: '2', placeholder: 'Comment' });
    commentTa.value = ans.comment || '';
    commentTa.addEventListener('input', function () { ans.comment = commentTa.value; updateStates(); ctx.onChange(); });
    node.appendChild(el('div', { class: 'field' }, [commentLabel, commentTa]));

    // Photos: one-tap live capture (primary) + library fallback. Auto-labeled
    // "<ContractNo> - <Question> (X)", X incrementing per capture on this task.
    var photoLabel = el('label', { class: 'field-label', text: 'Photos' });
    var thumbs = el('div', { class: 'thumbs' });
    var fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true });
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', function () {
      Array.prototype.forEach.call(fileInput.files, function (f) { addPhoto(f, URL.createObjectURL(f), 'library'); });
      fileInput.value = '';
    });
    var captureBtn = el('button', { class: 'btn btn-capture', text: '📷 Capture', onClick: function () {
      Promise.resolve(ctx.grabFrame ? ctx.grabFrame() : null).then(function (f) {
        if (f) addPhoto(f.blob, f.url, 'camera', { geo: f.geo, when: f.when }); else fileInput.click();
      });
    } });
    var libBtn = el('button', { class: 'btn-lib', text: 'Library', onClick: function () { fileInput.click(); } });
    node.appendChild(el('div', { class: 'field' }, [photoLabel, thumbs, el('div', { class: 'photo-actions' }, [captureBtn, libBtn]), fileInput]));

    function addPhoto(blob, url, source, meta) {
      var seq = ans.nextSeq || (ans.photos.length + 1);
      ans.nextSeq = seq + 1;
      var shortQ = String(q.text || '').replace(/^\s*\d+\.\s*/, '').slice(0, 60);
      var label = ctx.contractNo + ' - ' + shortQ + ' (' + seq + ')';
      ans.photos.push({ blob: blob, url: url, source: source, seq: seq, label: label, name: sanitizeName(label) + '.jpg',
        geo: (meta && meta.geo) || null, when: (meta && meta.when) || null });
      renderThumbs(); updateStates(); ctx.onChange();
    }
    function renderThumbs() {
      clear(thumbs);
      ans.photos.forEach(function (p, i) {
        var image = el('img', { src: p.url, alt: p.label });
        image.addEventListener('click', function () { openMarkup(p, function () { image.src = p.url; }); });
        thumbs.appendChild(el('div', { class: 'thumb', title: p.label + ' — tap to mark up' }, [
          image,
          el('span', { class: 'seq', text: '(' + p.seq + ')' }),
          el('button', { class: 'thumb-edit', text: '✎', title: 'Mark up', onClick: function () { openMarkup(p, function () { image.src = p.url; }); } }),
          el('button', { class: 'thumb-x', text: '×', onClick: function () { URL.revokeObjectURL(p.url); ans.photos.splice(i, 1); renderThumbs(); updateStates(); ctx.onChange(); } })
        ]));
      });
    }
    function openMarkup(p, after) {
      PhotoMarkup(p, function (blob, url) {
        URL.revokeObjectURL(p.url); p.blob = blob; p.url = url;
        if (after) after(); renderThumbs(); ctx.onChange();
      });
    }
    function paintChoice() { Object.keys(choiceBtns).forEach(function (v) { choiceBtns[v].classList.toggle('sel', Number(v) === Number(ans.value)); }); }
    function currentResult() { return (rt.kind === 'choice' || rt.kind === 'number') ? (ans.value == null ? null : Number(ans.value)) : null; }
    function req() {
      var v = currentResult(), r = { comment: false, photo: false, fail: false };
      if (v != null) {
        if (q.commentBelow >= 0 && v < q.commentBelow) r.comment = true;
        if (q.photoBelow >= 0 && v < q.photoBelow) r.photo = true;
        if (q.failBelow >= 0 && v < q.failBelow) r.fail = true;
      }
      return r;
    }
    function answered() {
      if (rt.kind === 'unsupported') return true;
      if (rt.kind === 'text') return typeof ans.value === 'string' && ans.value.trim() !== '';
      return ans.value != null;
    }
    function isComplete() {
      if (rt.kind === 'unsupported') return true;
      if (!answered()) return false;
      var r = req();
      if (r.comment && !(ans.comment || '').trim()) return false;
      if (r.photo && ans.photos.length === 0) return false;
      return true;
    }
    function updateStates() {
      var r = req();
      failBadge.style.display = r.fail ? '' : 'none';
      commentLabel.textContent = r.comment ? 'Comment (required)' : 'Comment (optional)';
      commentTa.classList.toggle('need', r.comment && !(ans.comment || '').trim());
      photoLabel.textContent = r.photo ? 'Photos (required)' : 'Photos (optional)';
      captureBtn.classList.toggle('need', r.photo && ans.photos.length === 0);
      node.classList.toggle('q-done', isComplete());
    }

    renderThumbs(); paintChoice(); updateStates();
    return { node: node, isComplete: isComplete };
  }

  // ---- Review (summary; sign + commit come next) ---------------------------
  function ReviewScreen(job, config, capture) {
    var body = el('div', { class: 'review-body' });
    config.questions.slice().sort(byOrder).forEach(function (q) {
      var ans = capture.answers[q.id] || {}; var rt = rtOf(q);
      body.appendChild(el('div', { class: 'review-row' }, [
        el('div', { class: 'q-text', text: q.text }),
        el('div', { class: 'review-ans', text: 'Answer: ' + valueLabel(rt, ans.value) }),
        (ans.comment && ans.comment.trim()) ? el('div', { class: 'subtle', text: 'Comment: ' + ans.comment }) : null,
        (ans.photos && ans.photos.length) ? el('div', { class: 'thumbs' }, ans.photos.map(function (p) {
          var im = el('img', { class: 'thumb-sm', src: p.url, alt: p.name, title: 'Tap to mark up' });
          im.addEventListener('click', function () {
            PhotoMarkup(p, function (blob, url) { URL.revokeObjectURL(p.url); p.blob = blob; p.url = url; ReviewScreen(job, config, capture); });
          });
          return im;
        })) : null
      ]));
    });
    var finaliseBtn = el('button', { class: 'btn btn-primary', text: 'Finalise →', onClick: function () { FinaliseScreen(job, config, capture); } });
    mount(el('div', { class: 'screen screen-review' }, [
      topBar('Review', { onBack: function () { CaptureScreen(job, config, capture); } }),
      el('p', { class: 'subtle', text: config.name + ' · ' + job.contractNumber }),
      body,
      el('div', { class: 'capture-foot' }, [
        el('span', { class: 'muted', text: 'Review answers, then sign off.' }),
        finaliseBtn
      ])
    ]));
  }

  // ---- Photo mark-up editor ------------------------------------------------
  // Full-screen overlay: annotate a captured photo (circle a crack, arrow to a
  // defect) with freehand strokes at the photo's NATIVE resolution, so the ink
  // stays crisp in the report. Save flattens the drawing into a new JPEG and
  // hands it back via onSave(blob, url) — the caller replaces the photo in place.
  function PhotoMarkup(photo, onSave) {
    var img = new Image();
    var canvas = el('canvas', { class: 'markup-canvas' });
    var cx = canvas.getContext('2d');
    var strokes = [], cur = null;
    var color = '#ff2d2d', width = 6;

    function drawStroke(s) {
      cx.strokeStyle = s.color; cx.lineWidth = s.width; cx.lineCap = 'round'; cx.lineJoin = 'round';
      cx.beginPath(); cx.moveTo(s.pts[0].x, s.pts[0].y);
      for (var i = 1; i < s.pts.length; i++) cx.lineTo(s.pts[i].x, s.pts[i].y);
      if (s.pts.length === 1) cx.lineTo(s.pts[0].x + 0.1, s.pts[0].y + 0.1); // a tap = a dot
      cx.stroke();
    }
    function redraw() { if (!canvas.width) return; cx.drawImage(img, 0, 0, canvas.width, canvas.height); strokes.forEach(drawStroke); }
    function pos(ev) {
      var r = canvas.getBoundingClientRect();
      return { x: (ev.clientX - r.left) * (canvas.width / r.width), y: (ev.clientY - r.top) * (canvas.height / r.height) };
    }
    function down(ev) { ev.preventDefault(); cur = { color: color, width: width, pts: [pos(ev)] }; strokes.push(cur); if (canvas.setPointerCapture && ev.pointerId != null) { try { canvas.setPointerCapture(ev.pointerId); } catch (e) {} } redraw(); }
    function move(ev) { if (!cur) return; ev.preventDefault(); cur.pts.push(pos(ev)); redraw(); }
    function up() { cur = null; }
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointerleave', up);

    img.onload = function () { canvas.width = img.naturalWidth || 1000; canvas.height = img.naturalHeight || 750; width = Math.max(4, Math.round(canvas.width / 200)); redraw(); };
    img.src = photo.url;

    var overlay = el('div', { class: 'markup-overlay' });
    function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }

    var swatches = [['#ff2d2d', 'red'], ['#ffd400', 'yellow'], ['#ffffff', 'white'], ['#111111', 'black']].map(function (c) {
      var b = el('button', { class: 'mk-swatch' + (c[0] === color ? ' sel' : ''), title: c[1] });
      b.style.background = c[0];
      b.addEventListener('click', function () { color = c[0]; swatches.forEach(function (x) { x.classList.remove('sel'); }); b.classList.add('sel'); });
      return b;
    });
    var wBtns = [['S', 0.5], ['M', 1], ['L', 2]].map(function (w) {
      var b = el('button', { class: 'mk-w' + (w[1] === 1 ? ' sel' : ''), text: w[0] });
      b.addEventListener('click', function () { width = Math.max(4, Math.round((canvas.width / 200) * w[1])); wBtns.forEach(function (x) { x.classList.remove('sel'); }); b.classList.add('sel'); });
      return b;
    });
    var saveBtn = el('button', { class: 'btn btn-primary', text: 'Save', onClick: function () {
      canvas.toBlob(function (b) { if (b) onSave(b, URL.createObjectURL(b)); close(); }, 'image/jpeg', 0.9);
    } });

    overlay.appendChild(el('div', { class: 'markup-stage' }, [canvas]));
    overlay.appendChild(el('div', { class: 'markup-bar' }, [
      el('div', { class: 'mk-group' }, swatches),
      el('div', { class: 'mk-group' }, wBtns),
      el('div', { class: 'mk-group' }, [
        el('button', { class: 'btn-lib', text: '↶ Undo', onClick: function () { strokes.pop(); redraw(); } }),
        el('button', { class: 'btn-lib', text: 'Clear', onClick: function () { strokes = []; redraw(); } })
      ]),
      el('div', { class: 'mk-group mk-right' }, [
        el('button', { class: 'btn-lib', text: 'Cancel', onClick: close }),
        saveBtn
      ])
    ]));
    document.body.appendChild(overlay);
  }

  // ---- Signature pad (canvas) ----------------------------------------------
  function SignaturePad() {
    var canvas = el('canvas', { class: 'sigpad' });
    canvas.width = 600; canvas.height = 200;
    var ctx = canvas.getContext('2d');
    function fillWhite() { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    fillWhite(); // opaque white bg so JPEG export (no alpha) shows ink, not black
    ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
    var drawing = false, empty = true, last = null;
    function pos(ev) {
      var r = canvas.getBoundingClientRect();
      return { x: (ev.clientX - r.left) * (canvas.width / r.width), y: (ev.clientY - r.top) * (canvas.height / r.height) };
    }
    function down(ev) { ev.preventDefault(); drawing = true; empty = false; last = pos(ev); if (canvas.setPointerCapture && ev.pointerId != null) { try { canvas.setPointerCapture(ev.pointerId); } catch (e) {} } }
    function move(ev) { if (!drawing) return; ev.preventDefault(); var p = pos(ev); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; }
    function up() { drawing = false; }
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointerleave', up);
    function clearPad() { ctx.clearRect(0, 0, canvas.width, canvas.height); fillWhite(); empty = true; }
    function getBlob() { return empty ? Promise.resolve(null) : new Promise(function (res) { canvas.toBlob(function (b) { res(b); }, 'image/jpeg', 0.92); }); }
    var node = el('div', { class: 'sigpad-wrap' }, [
      canvas,
      el('button', { class: 'btn-lib', text: 'Clear', onClick: clearPad })
    ]);
    return { node: node, getBlob: getBlob, isEmpty: function () { return empty; } };
  }

  function docStamp() {
    var d = new Date(); function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function buildDocModel(job, config, capture, sig) {
    var pci = isPciConfig(config);
    var questions = pci ? [] : config.questions.slice().sort(byOrder).map(function (q) {
      var a = capture.answers[q.id] || {};
      return { text: q.text, answer: valueLabel(rtOf(q), a.value), comment: (a.comment || '').trim(), photos: (a.photos || []).map(function (p) { return p.blob; }) };
    });
    // PCI: group the logged defects by area into a defect schedule.
    var defectSchedule = null;
    if (pci) {
      var byArea = {};
      (capture.defects || []).forEach(function (d) {
        var k = d.area || '(unspecified area)';
        (byArea[k] = byArea[k] || []).push({ category: d.category || '', comment: (d.comment || '').trim(), photos: (d.photos || []).map(function (p) { return p.blob; }) });
      });
      defectSchedule = Object.keys(byArea).sort().map(function (a) { return { area: a, defects: byArea[a] }; });
    }
    var signatures = [{ label: 'Supervisor', name: sig.supName, blob: sig.supBlob }];
    if (sig.cliBlob) signatures.push({ label: 'Client', name: sig.cliName, blob: sig.cliBlob });
    return {
      title: config.name,
      logo: sig.logo || null,
      instructions: (config.instructions && config.instructions.trim()) ? config.instructions.trim() : null,
      locationMap: sig.locationMap || null,
      defects: (sig.defects && sig.defects.length) ? sig.defects : null,
      defectSchedule: defectSchedule,
      contract: { number: job.contractNumber, address: job.address, client: job.client, stage: job.stage, inspectionType: config.name, supervisor: sig.supName, date: new Date().toISOString().slice(0, 10) },
      questions: questions, signatures: signatures
    };
  }

  // ---- Finalise: sign off + generate the document --------------------------
  function FinaliseScreen(job, config, capture) {
    var supName = el('input', { type: 'text', placeholder: 'Supervisor name' }); supName.value = pickName(state.user) || '';
    var supPad = SignaturePad();
    var cliName = el('input', { type: 'text', placeholder: 'Client name (optional)' });
    var cliPad = SignaturePad();
    var status = el('div', { class: 'error' });
    var out = el('div', { class: 'gen-out' });
    var genBtn = el('button', { class: 'btn btn-primary', text: 'Generate document' });

    genBtn.addEventListener('click', async function () {
      status.textContent = '';
      if (!supName.value.trim()) { status.textContent = 'Supervisor name is required.'; return; }
      if (supPad.isEmpty()) { status.textContent = 'Supervisor signature is required.'; return; }
      genBtn.disabled = true; genBtn.textContent = 'Generating…';
      try {
        var supBlob = await supPad.getBlob();
        var cliBlob = cliPad.isEmpty() ? null : await cliPad.getBlob();
        var logoBlob = await fetchLogoBlob(CFG.logo);   // null if none/unreachable
        // Location map + defect list — only for Kerb & Footpath-style reports
        // (CFG.locationMapMatch) that have GPS-tagged photos. Map is best-effort
        // (needs connectivity); the defect list stands alone if the map is null.
        var locationMap = null, defects = null;
        if (matchesLocationMap(config.name)) {
          var geoPts = geoPhotosOf(config, capture);
          if (geoPts.length) {
            defects = geoPts;
            if (navigator.onLine !== false) {
              genBtn.textContent = 'Building map…';
              try { locationMap = await buildLocationMap(geoPts); } catch (e) { locationMap = null; }
              genBtn.textContent = 'Generating…';
            }
          }
        }
        var model = buildDocModel(job, config, capture, { supName: supName.value.trim(), supBlob: supBlob, cliName: cliName.value.trim(), cliBlob: cliBlob, logo: logoBlob, locationMap: locationMap, defects: defects });
        var base = sanitizeName(config.name + ' ' + job.contractNumber + ' ' + docStamp());
        var pdf = await window.CHPdf.buildPdf(model);   // primary report
        var odt = await window.CHDoc.buildOdt(model);   // editable backup/source
        var docs = { pdf: { blob: pdf, filename: base + '.pdf' }, odt: { blob: odt, filename: base + '.odt' } };
        clear(out);
        out.appendChild(el('a', { class: 'btn-lib', href: URL.createObjectURL(pdf), download: docs.pdf.filename }, ['⬇ ' + docs.pdf.filename + ' (' + Math.round(pdf.size / 1024) + ' KB)']));
        out.appendChild(el('a', { class: 'btn-lib', href: URL.createObjectURL(odt), download: docs.odt.filename }, ['⬇ ' + docs.odt.filename + ' (editable backup)']));
        if (CFG.docCategories) {
          var rec = buildPendingRecord(job, config, capture, docs);
          if (window.CHStore && CHStore.available) await CHStore.pendingPut(rec).catch(function () {});   // queue it (survives offline/reload)
          out.appendChild(el('button', { class: 'btn btn-primary', text: 'Commit & upload →', onClick: function () { CommitScreen(rec, function () { FinaliseScreen(job, config, capture); }); } }));
          out.appendChild(el('p', { class: 'muted', text: 'Finalised and queued on this device. Commit uploads the PDF + ODT + every photo (retrying on failure). If you’re offline, it stays queued under this job — upload later from the job or the Uploads screen.' }));
        } else {
          out.appendChild(el('p', { class: 'muted', text: 'Upload isn’t configured for ' + CFG.label + ' yet (document category ids not set for this system). You can download the PDF/ODT above; uploading switches on once this system’s category ids are added.' }));
        }
      } catch (e) {
        status.textContent = 'Generation failed: ' + (e.message || e);
      } finally {
        genBtn.disabled = false; genBtn.textContent = 'Generate document';
      }
    });

    mount(el('div', { class: 'screen screen-finalise' }, [
      topBar('Finalise', { onBack: function () { if (isPciConfig(config)) DefectScreen(job, config, capture); else ReviewScreen(job, config, capture); } }),
      el('p', { class: 'subtle', text: config.name + ' · ' + job.contractNumber }),
      (config.instructions && config.instructions.trim()) ? el('div', { class: 'card instructions-card' }, [
        el('div', { class: 'instructions-text', text: config.instructions })
      ]) : null,
      el('div', { class: 'card' }, [
        el('h3', { text: 'Supervisor sign-off' }),
        el('label', { class: 'field-label', text: 'Name' }), supName,
        el('label', { class: 'field-label', text: 'Signature (required)' }), supPad.node
      ]),
      el('div', { class: 'card' }, [
        el('h3', { text: 'Client sign-off (optional)' }),
        el('label', { class: 'field-label', text: 'Name' }), cliName,
        el('label', { class: 'field-label', text: 'Signature' }), cliPad.node
      ]),
      status,
      genBtn,
      out
    ]));
  }

  // ---- Commit / pending-upload queue --------------------------------------
  function buildUploadItems(job, config, capture, docs) {
    // Close-out key stamped on the report so a hook/agent can link the uploaded
    // doc back to its inspection without an ExtRef field on AddFile.
    var inst = capture.inst || {};
    var key = 'inspTemplateId=' + config.inspTemplateId +
      (inst.inspRequiredId ? ' inspRequiredId=' + inst.inspRequiredId : '') +
      (inst.taskId ? ' taskId=' + inst.taskId : '');
    var items = [
      { key: 'pdf', type: 'Report (PDF)', blob: docs.pdf.blob, filename: docs.pdf.filename, title: docs.pdf.filename.replace(/\.pdf$/i, ''), description: 'Inspection: ' + config.name + ' | ' + key, categoryId: CFG.docCategories.inspections },
      { key: 'odt', type: 'Report source (ODT)', blob: docs.odt.blob, filename: docs.odt.filename, title: docs.odt.filename.replace(/\.odt$/i, '') + ' (source)', description: 'Editable source | ' + key, categoryId: CFG.docCategories.inspections }
    ];
    function photoDesc(parts, p) {
      if (p.when) parts.push('Taken ' + p.when);
      if (p.geo) parts.push('Location ' + p.geo.lat.toFixed(6) + ', ' + p.geo.lon.toFixed(6) + ' (±' + Math.round(p.geo.acc) + 'm) ' + mapsLink(p.geo));
      return parts.join(' | ');
    }
    if (isPciConfig(config)) {
      // PCI: photos attach to the created Issues (see buildDefectIssues), NOT the
      // contract. Only the report PDF+ODT upload to the contract here.
    } else {
      config.questions.slice().sort(byOrder).forEach(function (q) {
        var a = capture.answers[q.id] || {};
        (a.photos || []).forEach(function (p) {
          items.push({ key: 'p' + q.id + '_' + p.seq, type: 'Photo', blob: p.blob, filename: p.name, title: p.label, description: photoDesc([], p), categoryId: CFG.docCategories.inspectionPhotos });
        });
      });
    }
    return items;
  }

  // PCI issue-creation work list (created at finalise; each defect -> one ClickHome
  // Issue with its photos attached to the issue). Photo descriptions carry geo/Maps.
  function buildDefectIssues(job, config, capture) {
    return (capture.defects || []).map(function (d, di) {
      return {
        key: 'issue' + di, area: d.area, areaId: d.areaId, category: d.category, categoryId: d.categoryId,
        comment: d.comment || '', description: 'Resolve ' + (d.category || 'defect') + ' in ' + (d.area || 'area'),
        done: false, issueId: null,
        photos: (d.photos || []).map(function (p) {
          var parts = [];
          if (p.when) parts.push('Taken ' + p.when);
          if (p.geo) parts.push('Location ' + p.geo.lat.toFixed(6) + ', ' + p.geo.lon.toFixed(6) + ' (±' + Math.round(p.geo.acc) + 'm) ' + mapsLink(p.geo));
          return { blob: p.blob, filename: p.name, title: p.label, description: parts.join(' | '), done: false, idFile: null };
        })
      };
    });
  }

  // A finalised inspection persisted for upload (survives reload/offline).
  function buildPendingRecord(job, config, capture, docs) {
    var items = buildUploadItems(job, config, capture, docs).map(function (it) {
      return { key: it.key, type: it.type, blob: it.blob, filename: it.filename, title: it.title, description: it.description, categoryId: it.categoryId, done: false, idFile: null };
    });
    var inst = capture.inst || {};
    var rec = {
      id: draftIdFor(job, config.inspTemplateId),
      masterContractId: job.masterContractId, contractId: job.contractId,
      contractNumber: job.contractNumber, address: job.address,
      inspTemplateId: config.inspTemplateId, name: config.name,
      inspRequiredId: inst.inspRequiredId || null, taskId: inst.taskId || null,
      createdAt: Date.now(), complete: false, items: items
    };
    // PCI: also create a ClickHome Issue per defect (photos attach to the issue).
    if (isPciConfig(config)) rec.defects = buildDefectIssues(job, config, capture);
    return rec;
  }

  async function uploadWithRetry(contractId, item, attempts) {
    var lastErr;
    for (var i = 0; i < attempts; i++) {
      try { var r = await api.addFile(contractId, item); return { ok: true, idFile: r.idFile }; }
      catch (e) { if (e.name === 'AuthError') throw e; lastErr = e; await new Promise(function (res) { setTimeout(res, 500 * (i + 1)); }); }
    }
    return { ok: false, error: lastErr && lastErr.message };
  }

  // Upload every not-done item of a pending record, persisting progress after
  // each success. Returns 'complete' | 'partial' | 'auth'. On complete, clears
  // the record + the in-progress draft. onItem(item, state) drives the UI.
  async function drainRecord(rec, onItem) {
    for (var i = 0; i < rec.items.length; i++) {
      var it = rec.items[i];
      if (it.done) { if (onItem) onItem(it, 'done'); continue; }
      if (onItem) onItem(it, 'going');
      var r;
      try { r = await uploadWithRetry(rec.contractId, it, 3); }
      catch (e) { if (onItem) onItem(it, 'auth'); return 'auth'; }
      if (r.ok) { it.done = true; it.idFile = r.idFile || null; if (window.CHStore && CHStore.available) await CHStore.pendingPut(rec).catch(function () {}); if (onItem) onItem(it, 'ok'); }
      else { if (onItem) onItem(it, 'fail'); }
    }
    // PCI: create an Issue per defect (supervisor token) + attach its photos to
    // the issue. Idempotent — a stored issueId/photo.done is never redone on retry.
    async function persist() { if (window.CHStore && CHStore.available) await CHStore.pendingPut(rec).catch(function () {}); }
    if (rec.defects) {
      for (var j = 0; j < rec.defects.length; j++) {
        var df = rec.defects[j];
        if (df.done) { if (onItem) onItem(df, 'done'); continue; }
        if (onItem) onItem(df, 'going');
        if (!df.issueId) {
          try {
            var cr = await api.createIssue({ contractId: rec.contractId, masterAreaId: df.areaId, issueCategoryId: df.categoryId, body: df.comment, description: df.description });
            df.issueId = cr.issueId; await persist();
          } catch (e) {
            if (e.name === 'AuthError') { if (onItem) onItem(df, 'auth'); return 'auth'; }
            if (onItem) onItem(df, 'fail'); continue;
          }
        }
        var photosOk = true;
        for (var k = 0; k < df.photos.length; k++) {
          var ph = df.photos[k];
          if (ph.done) continue;
          try {
            var pr = await api.addFileToIssue(df.issueId, { blob: ph.blob, filename: ph.filename, title: ph.title, description: ph.description, categoryId: (CFG.docCategories && CFG.docCategories.inspectionPhotos) || 9, keyWords: 'PCI' });
            ph.done = true; ph.idFile = pr.idFile || null; await persist();
          } catch (e) {
            if (e.name === 'AuthError') { if (onItem) onItem(df, 'auth'); return 'auth'; }
            photosOk = false;
          }
        }
        if (photosOk && df.photos.every(function (x) { return x.done; })) { df.done = true; await persist(); if (onItem) onItem(df, 'ok'); }
        else if (onItem) onItem(df, 'fail');
      }
    }
    var itemsDone = rec.items.every(function (x) { return x.done; });
    var defectsDone = !rec.defects || rec.defects.every(function (x) { return x.done; });
    if (itemsDone && defectsDone) {
      rec.complete = true;
      if (window.CHStore && CHStore.available) { await CHStore.pendingDelete(rec.id).catch(function () {}); await CHStore.deleteDraft(rec.id).catch(function () {}); }
      return 'complete';
    }
    await persist();
    return 'partial';
  }

  function CommitScreen(rec, backFn) {
    var rowEls = {};
    var listEl = el('div', { class: 'up-list' });
    rec.items.forEach(function (it) {
      var status = el('span', { class: 'up-status' + (it.done ? ' up-ok' : ''), text: it.done ? '✓ uploaded' : 'queued' });
      rowEls[it.key] = status;
      listEl.appendChild(el('div', { class: 'up-row' }, [el('span', { class: 'up-name', text: (it.type.indexOf('Photo') === 0 ? '📷 ' : '📄 ') + it.title }), status]));
    });
    (rec.defects || []).forEach(function (df) {
      var np = df.photos ? df.photos.length : 0;
      var status = el('span', { class: 'up-status' + (df.done ? ' up-ok' : ''), text: df.done ? '✓ issue raised' : 'queued' });
      rowEls[df.key] = status;
      listEl.appendChild(el('div', { class: 'up-row' }, [el('span', { class: 'up-name', text: '⚠ ' + (df.area || 'Area') + ' — ' + (df.category || 'Defect') + ' (' + np + ' photo' + (np === 1 ? '' : 's') + ')' }), status]));
    });
    var summary = el('div', { class: 'subtle' });
    var actionBtn = el('button', { class: 'btn btn-primary', text: 'Upload to ClickHome' });
    function paint(it, st) {
      var s = rowEls[it.key]; if (!s) return;
      var isIssue = !!it.photos && it.area !== undefined;   // defect rows carry photos[] + area
      if (st === 'going') { s.textContent = isIssue ? (it.issueId ? 'attaching photos…' : 'raising issue…') : 'uploading…'; s.className = 'up-status up-going'; }
      else if (st === 'ok' || st === 'done') { s.textContent = isIssue ? ('✓ issue' + (it.issueId ? ' ' + it.issueId : '') + ' raised') : ('✓ uploaded' + (it.idFile ? ' (fileId ' + it.idFile + ')' : '')); s.className = 'up-status up-ok'; }
      else if (st === 'fail') { s.textContent = '✗ failed'; s.className = 'up-status up-fail'; }
      else if (st === 'auth') { s.textContent = 'session expired'; s.className = 'up-status up-fail'; }
    }
    async function run() {
      actionBtn.disabled = true; actionBtn.textContent = 'Uploading…'; summary.textContent = '';
      var res = await drainRecord(rec, paint);
      if (res === 'complete') { summary.textContent = '✓ Done — documents on the job' + (rec.defects && rec.defects.length ? ' and ' + rec.defects.length + ' issue(s) raised' : '') + '. Cleared from this device.'; actionBtn.style.display = 'none'; }
      else if (res === 'auth') { summary.textContent = 'Session expired — sign in again, then Retry. Nothing was lost.'; actionBtn.disabled = false; actionBtn.textContent = 'Retry'; }
      else { summary.textContent = 'Some items still pending (likely connectivity). Saved on this device — Retry when back online.'; actionBtn.disabled = false; actionBtn.textContent = 'Retry failed'; }
    }
    actionBtn.addEventListener('click', run);
    var count = rec.items.length + (rec.defects ? rec.defects.length : 0);
    mount(el('div', { class: 'screen' }, [
      topBar('Upload', { onBack: backFn || function () { JobListScreen(); } }),
      el('p', { class: 'subtle', text: rec.name + ' · ' + rec.contractNumber + ' · ' + count + ' item(s)' }),
      listEl, actionBtn, summary,
      el('p', { class: 'muted', text: 'Items stay on this device until each is confirmed — documents upload to the job, issues are raised in ClickHome. Nothing is lost if the connection drops.' })
    ]));
  }

  // ---- Pending uploads across all jobs + Retry all -------------------------
  function PendingScreen() {
    var wrap = el('div', { class: 'joblist' }, [el('p', { class: 'muted', text: 'Loading…' })]);
    var retryBtn = el('button', { class: 'btn btn-primary', text: 'Retry all' });
    async function load() {
      var recs = (window.CHStore && CHStore.available) ? await CHStore.pendingAll().catch(function () { return []; }) : [];
      recs = recs.filter(function (r) { return !r.complete; });
      clear(wrap);
      if (!recs.length) { wrap.appendChild(el('p', { class: 'muted', text: 'No inspections waiting to upload.' })); retryBtn.style.display = 'none'; return; }
      retryBtn.style.display = '';
      recs.forEach(function (r) {
        var left = r.items.filter(function (x) { return !x.done; }).length + (r.defects ? r.defects.filter(function (x) { return !x.done; }).length : 0);
        wrap.appendChild(el('button', { class: 'job-card', onClick: function () { CommitScreen(r, PendingScreen); } }, [
          el('div', { class: 'job-top' }, [el('span', { class: 'job-no', text: r.name }), el('span', { class: 'up-badge', text: '⬆ ' + left + ' left' })]),
          el('div', { class: 'job-client', text: r.contractNumber + ' · ' + (r.address || '') })
        ]));
      });
    }
    retryBtn.addEventListener('click', async function () {
      retryBtn.disabled = true; retryBtn.textContent = 'Uploading…';
      var recs = (window.CHStore && CHStore.available) ? await CHStore.pendingAll().catch(function () { return []; }) : [];
      for (var i = 0; i < recs.length; i++) { if (!recs[i].complete) { try { await drainRecord(recs[i]); } catch (e) { } } }
      retryBtn.disabled = false; retryBtn.textContent = 'Retry all';
      load();
    });
    mount(el('div', { class: 'screen' }, [
      topBar('Uploads', { onBack: function () { JobListScreen(); } }),
      el('p', { class: 'subtle', text: 'Inspections waiting to upload' }),
      retryBtn, wrap
    ]));
    load();
  }

  // ---- service worker (secure context only) --------------------------------
  function registerSW() {
    if ('serviceWorker' in navigator &&
        (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }

  // ---- boot ----------------------------------------------------------------
  mount(LoginScreen());
  registerSW();
})();
