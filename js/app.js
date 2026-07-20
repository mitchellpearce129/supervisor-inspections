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

  // One shared getUserMedia feed powers the capture screen's live inset.
  var activeStream = null;
  function stopCamera() {
    if (activeStream) { activeStream.getTracks().forEach(function (t) { t.stop(); }); activeStream = null; }
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
        var r = await api.bulkCacheAllTemplates(function (done, total) { syncStatus.textContent = 'Syncing templates… ' + done + '/' + total; });
        templatesSyncedThisSession = true;
        syncStatus.textContent = '✓ ' + r.cached + '/' + r.total + ' templates + doc categories cached for offline';
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
    Object.keys(capture.answers).forEach(function (qid) {
      var a = capture.answers[qid];
      answers[qid] = {
        value: a.value, comment: a.comment || '', nextSeq: a.nextSeq || 1,
        // Store the photo BLOB (durable); the object URL is recreated on resume.
        photos: (a.photos || []).map(function (p) { return { seq: p.seq, label: p.label, name: p.name, source: p.source, blob: p.blob }; })
      };
    });
    return { draftId: draftId, masterContractId: job.masterContractId, contractNumber: job.contractNumber, address: job.address, inspTemplateId: config.inspTemplateId, name: config.name, inst: capture.inst || null, updatedAt: Date.now(), answers: answers };
  }
  function rehydrateDraft(draft) {
    var capture = { answers: {}, _resumedAt: draft.updatedAt, inst: draft.inst || null };
    Object.keys(draft.answers || {}).forEach(function (qid) {
      var a = draft.answers[qid];
      capture.answers[qid] = {
        value: a.value, comment: a.comment || '', nextSeq: a.nextSeq || ((a.photos ? a.photos.length : 0) + 1),
        photos: (a.photos || []).map(function (p) { return { seq: p.seq, label: p.label, name: p.name, source: p.source, blob: p.blob, url: URL.createObjectURL(p.blob) }; })
      };
    });
    return capture;
  }

  function ContractInspectionsScreen(job) {
    var wrap = el('div', { class: 'joblist' }, [el('p', { class: 'muted', text: 'Loading inspections…' })]);

    function renderList(items, pendingRecs) {
      clear(wrap);
      if (pendingRecs && pendingRecs.length) {
        wrap.appendChild(el('h3', { class: 'cat-head', text: 'Waiting to upload' }));
        pendingRecs.forEach(function (r) {
          var left = r.items.filter(function (x) { return !x.done; }).length;
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
  function valueLabel(rt, value) {
    if (value == null || value === '') return 'Not answered';
    if (rt.kind === 'choice') { var o = (rt.options || []).filter(function (x) { return Number(x.value) === Number(value); })[0]; return o ? o.label : String(value); }
    return String(value);
  }

  // ---- Capture -------------------------------------------------------------
  function CaptureScreen(job, config, existing, inst) {
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
      return new Promise(function (resolve) {
        canvas.toBlob(function (b) { resolve(b ? { blob: b, url: URL.createObjectURL(b) } : null); }, 'image/jpeg', 0.85);
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
        if (f) addPhoto(f.blob, f.url, 'camera'); else fileInput.click();
      });
    } });
    var libBtn = el('button', { class: 'btn-lib', text: 'Library', onClick: function () { fileInput.click(); } });
    node.appendChild(el('div', { class: 'field' }, [photoLabel, thumbs, el('div', { class: 'photo-actions' }, [captureBtn, libBtn]), fileInput]));

    function addPhoto(blob, url, source) {
      var seq = ans.nextSeq || (ans.photos.length + 1);
      ans.nextSeq = seq + 1;
      var shortQ = String(q.text || '').replace(/^\s*\d+\.\s*/, '').slice(0, 60);
      var label = ctx.contractNo + ' - ' + shortQ + ' (' + seq + ')';
      ans.photos.push({ blob: blob, url: url, source: source, seq: seq, label: label, name: sanitizeName(label) + '.jpg' });
      renderThumbs(); updateStates(); ctx.onChange();
    }
    function renderThumbs() {
      clear(thumbs);
      ans.photos.forEach(function (p, i) {
        thumbs.appendChild(el('div', { class: 'thumb', title: p.label }, [
          el('img', { src: p.url, alt: p.label }),
          el('span', { class: 'seq', text: '(' + p.seq + ')' }),
          el('button', { class: 'thumb-x', text: '×', onClick: function () { URL.revokeObjectURL(p.url); ans.photos.splice(i, 1); renderThumbs(); updateStates(); ctx.onChange(); } })
        ]));
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
        (ans.photos && ans.photos.length) ? el('div', { class: 'thumbs' }, ans.photos.map(function (p) { return el('img', { class: 'thumb-sm', src: p.url, alt: p.name }); })) : null
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
    var questions = config.questions.slice().sort(byOrder).map(function (q) {
      var a = capture.answers[q.id] || {};
      return { text: q.text, answer: valueLabel(rtOf(q), a.value), comment: (a.comment || '').trim(), photos: (a.photos || []).map(function (p) { return p.blob; }) };
    });
    var signatures = [{ label: 'Supervisor', name: sig.supName, blob: sig.supBlob }];
    if (sig.cliBlob) signatures.push({ label: 'Client', name: sig.cliName, blob: sig.cliBlob });
    return {
      title: config.name,
      logo: sig.logo || null,
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
        var model = buildDocModel(job, config, capture, { supName: supName.value.trim(), supBlob: supBlob, cliName: cliName.value.trim(), cliBlob: cliBlob, logo: logoBlob });
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
      topBar('Finalise', { onBack: function () { ReviewScreen(job, config, capture); } }),
      el('p', { class: 'subtle', text: config.name + ' · ' + job.contractNumber }),
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
    config.questions.slice().sort(byOrder).forEach(function (q) {
      var a = capture.answers[q.id] || {};
      (a.photos || []).forEach(function (p) {
        items.push({ key: 'p' + q.id + '_' + p.seq, type: 'Photo', blob: p.blob, filename: p.name, title: p.label, description: '', categoryId: CFG.docCategories.inspectionPhotos });
      });
    });
    return items;
  }

  // A finalised inspection persisted for upload (survives reload/offline).
  function buildPendingRecord(job, config, capture, docs) {
    var items = buildUploadItems(job, config, capture, docs).map(function (it) {
      return { key: it.key, type: it.type, blob: it.blob, filename: it.filename, title: it.title, description: it.description, categoryId: it.categoryId, done: false, idFile: null };
    });
    var inst = capture.inst || {};
    return {
      id: draftIdFor(job, config.inspTemplateId),
      masterContractId: job.masterContractId, contractId: job.contractId,
      contractNumber: job.contractNumber, address: job.address,
      inspTemplateId: config.inspTemplateId, name: config.name,
      inspRequiredId: inst.inspRequiredId || null, taskId: inst.taskId || null,
      createdAt: Date.now(), complete: false, items: items
    };
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
    if (rec.items.every(function (x) { return x.done; })) {
      rec.complete = true;
      if (window.CHStore && CHStore.available) { await CHStore.pendingDelete(rec.id).catch(function () {}); await CHStore.deleteDraft(rec.id).catch(function () {}); }
      return 'complete';
    }
    if (window.CHStore && CHStore.available) await CHStore.pendingPut(rec).catch(function () {});
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
    var summary = el('div', { class: 'subtle' });
    var actionBtn = el('button', { class: 'btn btn-primary', text: 'Upload to ClickHome' });
    function paint(it, st) {
      var s = rowEls[it.key]; if (!s) return;
      if (st === 'going') { s.textContent = 'uploading…'; s.className = 'up-status up-going'; }
      else if (st === 'ok' || st === 'done') { s.textContent = '✓ uploaded' + (it.idFile ? ' (fileId ' + it.idFile + ')' : ''); s.className = 'up-status up-ok'; }
      else if (st === 'fail') { s.textContent = '✗ failed'; s.className = 'up-status up-fail'; }
      else if (st === 'auth') { s.textContent = 'session expired'; s.className = 'up-status up-fail'; }
    }
    async function run() {
      actionBtn.disabled = true; actionBtn.textContent = 'Uploading…'; summary.textContent = '';
      var res = await drainRecord(rec, paint);
      if (res === 'complete') { summary.textContent = '✓ All files uploaded — cleared from this device.'; actionBtn.style.display = 'none'; }
      else if (res === 'auth') { summary.textContent = 'Session expired — sign in again, then Retry. Nothing was lost.'; actionBtn.disabled = false; actionBtn.textContent = 'Retry'; }
      else { summary.textContent = 'Some files still pending (likely connectivity). Saved on this device — Retry when back online.'; actionBtn.disabled = false; actionBtn.textContent = 'Retry failed'; }
    }
    actionBtn.addEventListener('click', run);
    mount(el('div', { class: 'screen' }, [
      topBar('Upload', { onBack: backFn || function () { JobListScreen(); } }),
      el('p', { class: 'subtle', text: rec.name + ' · ' + rec.contractNumber + ' · ' + rec.items.length + ' file(s)' }),
      listEl, actionBtn, summary,
      el('p', { class: 'muted', text: 'Files stay on this device until each upload is confirmed — nothing is lost if the connection drops.' })
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
        var left = r.items.filter(function (x) { return !x.done; }).length;
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
