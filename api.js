/* ============================================================================
 * api.js — thin ClickHome V2 web-service client
 * Classic script (no modules): exposes window.CHApi and window.CHState.
 *
 * Auth model (per Knowledge/Databases/ClickHome/ClickHome V2 Web Service API.md):
 *   POST {apiBase}/V2/Login  { username, password }
 *     -> token returned in the `ClickHomeApiToken` RESPONSE HEADER (not body)
 *     -> body is the CurrentUserModel (identity, roles, business units, security)
 *   Send that token as a `ClickHomeApiToken` REQUEST HEADER on every later call.
 *   Reads use the custom HTTP verb `SEARCH` + a JSON selection tree.
 *   `Accept: application/json` is REQUIRED or the WCF service returns XML.
 * ==========================================================================*/
(function () {
  'use strict';

  var CFG = window.CH_CONFIG;

  // ---- session state (in memory only; a reload re-authenticates) ----------
  var state = {
    token: null,
    user: null,
    get isAuthenticated() { return !!this.token; }
  };
  window.CHState = state;

  // Config-fetch account token (separate from the supervisor's session token).
  var agentToken = null;
  var INSP_TMPL_SELECTION = { businessUnit: {}, metaData: {}, inspPolicy: {}, areas: { list: { metaData: {} } }, questions: { list: { inspQuestionAreas: { list: { metaData: {} } }, resourceCode: {} } }, standardComments: { list: { metaData: {} } } };

  // ---- typed errors so the UI can distinguish causes ----------------------
  function AuthError(msg) { this.name = 'AuthError'; this.message = msg; }
  AuthError.prototype = Object.create(Error.prototype);

  function ApiError(msg, status) { this.name = 'ApiError'; this.message = msg; this.status = status; }
  ApiError.prototype = Object.create(Error.prototype);

  // ---- low-level request helper -------------------------------------------
  function authHeaders(extra) {
    var h = Object.assign({ 'Accept': 'application/json' }, extra || {});
    if (state.token) h[CFG.tokenHeader] = state.token;
    return h;
  }

  // A registered /V2 route that hits no data returns a clean 404; a *wrong*
  // route name returns a fast ~30ms 504. Surface that distinction for debugging.
  function describeStatus(status) {
    if (status === 504) return 'Unrecognised route (504) — check the endpoint path.';
    if (status === 401) return 'Not authenticated (401) — token missing or expired.';
    if (status === 403) return 'Forbidden (403) — the account lacks the required permission.';
    return 'Request failed (' + status + ').';
  }

  /**
   * Authenticate. On success, stashes token + CurrentUserModel on CHState.
   * Throws AuthError on bad credentials, ApiError on other failures, or a
   * plain Error if login succeeds but the token header is not readable
   * (the CORS expose-headers case — should not happen on HGWA Metro).
   */
  async function login(username, password) {
    var res;
    try {
      res = await fetch(CFG.apiBase + '/V2/Login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      });
    } catch (e) {
      // Network-layer failure (no connectivity, DNS, or a CORS block).
      throw new ApiError('Could not reach ClickHome — check your connection.', 0);
    }

    if (res.status === 401) throw new AuthError('Incorrect username or password.');
    if (!res.ok) throw new ApiError(describeStatus(res.status), res.status);

    var token = res.headers.get(CFG.tokenHeader);
    if (!token) {
      throw new Error(
        'Logged in, but the ' + CFG.tokenHeader + ' response header was not readable. ' +
        'This means the API did not expose it to this origin (CORS).'
      );
    }

    var user = null;
    try { user = await res.json(); } catch (e) { /* body optional for our needs */ }

    state.token = token;
    state.user = user;
    return user;
  }

  function logout() {
    state.token = null;
    state.user = null;
  }

  /**
   * Generic SEARCH read against a /V2 list-or-entity route.
   * @param {string} path   e.g. '/V2/Contracts/List'
   * @param {object} body   selection tree / criteria object
   */
  async function search(path, body) {
    if (!state.token) throw new AuthError('Not signed in.');
    var res;
    try {
      res = await fetch(CFG.apiBase + path, {
        method: 'SEARCH',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body || {})
      });
    } catch (e) {
      throw new ApiError('Network error calling ' + path, 0);
    }
    if (res.status === 401) { logout(); throw new AuthError('Session expired — please sign in again.'); }
    if (!res.ok) throw new ApiError(describeStatus(res.status), res.status);
    return res.json();
  }

  /** POST helper for write/lookup routes (creates, ByReference lookups, etc.). */
  async function post(path, body) {
    if (!state.token) throw new AuthError('Not signed in.');
    var res;
    try {
      res = await fetch(CFG.apiBase + path, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body || {})
      });
    } catch (e) {
      throw new ApiError('Network error calling ' + path, 0);
    }
    if (res.status === 401) { logout(); throw new AuthError('Session expired — please sign in again.'); }
    if (!res.ok) throw new ApiError(describeStatus(res.status), res.status);
    return res.json();
  }

  // -------------------------------------------------------------------------
  // Domain calls. Login is fully specified. The rest are stubs pending the
  // real request shapes captured from the SPA (job list, inspection types,
  // template config, file upload).
  // -------------------------------------------------------------------------

  /**
   * List the signed-in (or impersonated) supervisor's active CONSTRUCTION jobs.
   *
   * Captured from the SPA's job-list view (2026-07-16) then trimmed to just the
   * fields the list renders:
   *   SEARCH /V2/MasterContracts/List
   * Note there is NO supervisor filter in the criteria — the server scopes the
   * result to the *current* user, so this returns that supervisor's jobs.
   * jobTypes ['C'] = Construction; statuses ['A','F'] = the active set.
   *
   * Base scalars (masterContractId, contractNumber, lotAddress) and each
   * requested node's base scalars come back automatically; only nested nodes
   * listed here are expanded.
   */
  async function listMyConstructionJobs() {
    return search('/V2/MasterContracts/List', {
      criteria: {
        anyContract: { jobTypes: ['C'], statuses: ['A', 'F'], includeInactive: 'false' },
        includeInactive: 'false'
      },
      // IMPORTANT: `fast: true` (as the SPA sends) SUPPRESSES the stage lookup —
      // with it, constructionContract.stage comes back empty even though
      // fkidStage is populated on ~all jobs. So it is intentionally omitted.
      selection: {
        client: {},                                // clientTitle / letterTitle
        constructionContract: {                    // + base scalars incl. contractId
          stage: {},                               //   build stage: fkidStage -> tblStages.sgStageName (e.g. 'Tiler')
          summary: {},                             //   current construction milestone (e.g. 'Main Floor Tiling')
          supervisor: {},                          //   supervisor name
          template: {},                            //   fkidTemplate -> templateId (key for the inspection-types lookup)
          security: {}                             //   permission flags
        }
      },
      sorting: [{ sortBy: 'contractPriority', descending: true }],
      pagination: { skip: 0, take: 100 }
    });
  }

  /** Impersonate another user (admin capability). Returns their context/token. */
  async function impersonate(username) {
    return post('/V2/Impersonate', { username: username });
  }

  // -------------------------------------------------------------------------
  // Inspection config. Admin-gated in V2 (needs the config account), so for now
  // these read cached JSON under data/. Later they will authenticate the config
  // account and pull from AdminSetup, then cache the same shape — the UI does
  // not change.
  // -------------------------------------------------------------------------

  /** The inspection types available for a workflow template (task-linked). */
  async function getInspectionTypes(templateId) {
    var res = await fetch('data/inspection-types-' + templateId + '.json', { cache: 'no-store' });
    if (!res.ok) throw new ApiError('No cached inspection types for template ' + templateId, res.status);
    return res.json();
  }

  // ---- config-fetch account (admin AdminSetup reads) ----------------------
  async function agentLogin() {
    var cfg = CFG.agent || {};
    if (!cfg.password) throw new ApiError('Config account password not set (CFG.agent.password).', 0);
    var res;
    try { res = await fetch(CFG.apiBase + '/V2/Login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ username: cfg.username, password: cfg.password }) }); }
    catch (e) { throw new ApiError('Could not reach ClickHome (config login).', 0); }
    if (!res.ok) throw new ApiError('Config account login failed (' + res.status + ').', res.status);
    agentToken = res.headers.get(CFG.tokenHeader);
    if (!agentToken) throw new Error('Config login succeeded but token header not readable.');
    return agentToken;
  }

  async function adminReq(method, path, body) {
    if (!agentToken) await agentLogin();
    function once() {
      return fetch(CFG.apiBase + path, { method: method, headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'ClickHomeApiToken': agentToken }, body: body != null ? JSON.stringify(body) : undefined });
    }
    var res;
    try { res = await once(); } catch (e) { throw new ApiError('Network error (admin ' + path + ')', 0); }
    if (res.status === 401) { agentToken = null; await agentLogin(); res = await once(); }
    if (!res.ok) throw new ApiError(describeStatus(res.status), res.status);
    return res.json();
  }

  function mapInspTemplate(d) {
    var qs = ((d.questions && d.questions.list) || []).map(function (q) {
      return {
        id: q.inspQuestionId, text: q.question, responseType: q.responseType,
        failBelow: (q.failBelow == null ? -1 : q.failBelow),
        commentBelow: (q.commentBelow == null ? -1 : q.commentBelow),
        photoBelow: (q.photoBelow == null ? -1 : q.photoBelow),
        categoryId: (q.inspCategory && q.inspCategory.inspCategoryId) || 0,
        order: (q.metaData && q.metaData.customOrder) || 0
      };
    });
    var catIds = {}; qs.forEach(function (q) { catIds[q.categoryId] = true; });
    var multi = Object.keys(catIds).length > 1;
    var categories = Object.keys(catIds).map(function (id) { return { id: Number(id), name: multi ? ('Category ' + id) : 'Default' }; });
    return { inspTemplateId: d.inspTemplateId, name: (d.inspectionGroup || '').trim(), adHoc: !!d.adHoc, inspType: d.inspType, instructions: d.instructions || '', categories: categories, questions: qs };
  }

  /**
   * Full question config for one inspection template. Cache-first (offline);
   * else pulled live from AdminSetup as the config account and cached; a
   * bundled seed JSON is the final fallback (demo only).
   */
  async function getInspTemplateConfig(inspTemplateId) {
    if (window.CHStore && CHStore.available) {
      try { var c = await CHStore.cacheGet(CFG.ns('tmpl:' + inspTemplateId)); if (c && c.data) return c.data; } catch (e) { /* ignore */ }
    }
    try {
      var d = await adminReq('POST', '/V2/AdminSetup/InspTemplates/' + inspTemplateId, INSP_TMPL_SELECTION);
      var cfg = mapInspTemplate(d);
      if (window.CHStore && CHStore.available) CHStore.cachePut(CFG.ns('tmpl:' + inspTemplateId), cfg).catch(function () {});
      return cfg;
    } catch (e) {
      try { var res = await fetch('data/insp-template-' + inspTemplateId + '.json', { cache: 'no-store' }); if (res.ok) return res.json(); } catch (e2) { /* ignore */ }
      throw e;
    }
  }

  // Document categories (admin). Field names vary across the V2 surface, so
  // read them defensively.
  function catId(c) { return c.documentCategoryId != null ? c.documentCategoryId : (c.idDocumentCategory != null ? c.idDocumentCategory : c.id); }
  function catName(c) { return String(c.categoryName || c.name || c.sgCategoryName || '').trim(); }
  function catExtRef(c) { return String(c.extRef || (c.metaData && c.metaData.extRef) || c.sgStdExtRef || '').trim(); }

  async function listDocCategories() {
    var d = await adminReq('POST', '/V2/AdminSetup/DocCategories/List?name=DocCategory', { criteria: {}, selection: { businessUnit: {}, metaData: {}, security: {} }, sorting: [], pagination: { take: 200, skip: 0 } });
    return d.results || d.list || [];
  }

  /**
   * Resolve this system's inspection doc-category ids by name/ext-ref (so we
   * never hard-code per-instance ids), cache them per system, and apply to CFG.
   * Report doc prefers ext-ref 'INSPREPORT', else name 'Inspection Reports'.
   */
  async function refreshDocCategories() {
    var cats = await listDocCategories();
    function findId(pred) { for (var i = 0; i < cats.length; i++) { if (pred(cats[i])) return catId(cats[i]); } return null; }
    var reports = findId(function (c) { return catExtRef(c).toUpperCase() === 'INSPREPORT'; });
    if (reports == null) reports = findId(function (c) { return catName(c).toLowerCase() === 'inspection reports'; });
    var photo = findId(function (c) { return catName(c).toLowerCase() === 'inspection photo'; });
    var resolved = { inspections: reports, inspectionPhotos: photo };
    if (window.CHStore && CHStore.available && CFG.systemId) await CHStore.cachePut(CFG.ns('doccats'), resolved).catch(function () {});
    if (resolved.inspections != null && resolved.inspectionPhotos != null) CFG.docCategories = resolved;
    return resolved;
  }

  /** All inspection templates (metadata) for BU 0. */
  async function listAllInspTemplates() {
    var d = await adminReq('POST', '/V2/AdminSetup/InspTemplates/List?name=all', { criteria: { businessUnitRegions: { businessUnitIds: [0], includeChildBusinessUnits: true } }, selection: {}, sorting: [], pagination: { take: 200, skip: 0 } });
    return d.results || d.list || [];
  }

  /** Pull + cache every inspection template's question config (full offline). */
  async function bulkCacheAllTemplates(onProgress) {
    var list = await listAllInspTemplates();
    var ok = 0;
    for (var i = 0; i < list.length; i++) {
      var id = list[i].inspTemplateId;
      try {
        var d = await adminReq('POST', '/V2/AdminSetup/InspTemplates/' + id, INSP_TMPL_SELECTION);
        if (window.CHStore && CHStore.available) await CHStore.cachePut(CFG.ns('tmpl:' + id), mapInspTemplate(d)).catch(function () {});
        ok++;
      } catch (e) { /* skip this one */ }
      if (onProgress) onProgress(i + 1, list.length, ok);
    }
    return { total: list.length, cached: ok };
  }

  /**
   * The inspections actually generated on a job (tblInspRequireds) — done +
   * pending. Readable with the SUPERVISOR's own token (no admin account),
   * confirmed 2026-07-16. Inspections exist only once their linked task is
   * scheduled, so this naturally surfaces just what's relevant now.
   *
   * NOTE: completed rows carry a large base64 signature (sigBlob1) as a base
   * scalar we can't deselect — we simply don't map it; a lighter list variant
   * is a future optimisation.
   */
  async function getContractInspections(masterContractId) {
    var d = await search('/V2/MasterContracts/' + masterContractId + '?name=inspections', {
      constructionContract: { inspRequireds: { list: { template: {}, task: {} } } }
    });
    var cc = d.constructionContract || {};
    var list = (cc.inspRequireds && cc.inspRequireds.list) || [];
    var items = list.map(function (it) {
      var t = it.template || {}, tk = it.task || {};
      return {
        inspRequiredId: it.inspRequiredId,
        inspTemplateId: t.inspTemplateId,
        name: (t.inspectionGroup || tk.taskName || '').trim(),
        adHoc: !!t.adHoc,
        done: !!it.inspStatus,
        inspectedOn: it.inspectedOn || null,
        taskName: (tk.taskName || '').trim(),
        taskId: tk.taskId || null,
        taskOrder: tk.taskOrder || 0,
        taskStatus: tk.taskStatus || ''
      };
    }).sort(function (a, b) { return a.taskOrder - b.taskOrder; });
    return { contractNumber: d.contractNumber, inspections: items };
  }

  /**
   * Upload one file to a job (child contract). Multipart form-data, as the
   * supervisor (canAddDocs). Returns the new file id from the response.
   *   POST {api}/V2/Contracts/{contractId}/AddFile
   *   fields: description, documentCategoryId, title, fileData (binary)
   * Do NOT set Content-Type — the browser adds the multipart boundary.
   */
  async function addFile(contractId, opts) {
    if (!state.token) throw new AuthError('Not signed in.');
    // Category id: the upload item carries it as `categoryId` (documentCategoryId
    // is the older name — accept either). ClickHome's AddFile does int.Parse() on
    // this field, so a non-numeric value (undefined/null/'') yields a cryptic
    // 500 "Input string was not in a correct format." Validate up front instead.
    var catId = opts.categoryId != null ? opts.categoryId : opts.documentCategoryId;
    var catNum = Number(catId);
    if (!Number.isInteger(catNum) || catNum <= 0) {
      throw new ApiError('Upload blocked — invalid document category id (' + JSON.stringify(catId) + ') for ' + (opts.filename || 'file') + '.', 0);
    }
    var fd = new FormData();
    fd.append('description', opts.description || '');
    fd.append('documentCategoryId', String(catNum));
    fd.append('title', opts.title || '');
    fd.append('fileData', opts.blob, opts.filename);
    var res;
    try {
      res = await fetch(CFG.apiBase + '/V2/Contracts/' + contractId + '/AddFile', {
        method: 'POST', headers: authHeaders(), body: fd
      });
    } catch (e) {
      throw new ApiError('Network error uploading ' + (opts.filename || 'file'), 0);
    }
    if (res.status === 401) { logout(); throw new AuthError('Session expired — please sign in again.'); }
    if (!res.ok) throw new ApiError(describeStatus(res.status), res.status);
    var body = null; try { body = await res.json(); } catch (e) { /* some deployments return no body */ }
    var idFile = body && (body.fileId || body.idFile || body.id || (body.file && (body.file.fileId || body.file.idFile)));
    return { idFile: idFile, body: body };
  }

  window.CHApi = {
    AuthError: AuthError,
    ApiError: ApiError,
    login: login,
    logout: logout,
    search: search,
    post: post,
    impersonate: impersonate,
    listMyConstructionJobs: listMyConstructionJobs,
    getInspectionTypes: getInspectionTypes,
    getInspTemplateConfig: getInspTemplateConfig,
    getContractInspections: getContractInspections,
    addFile: addFile,
    listAllInspTemplates: listAllInspTemplates,
    bulkCacheAllTemplates: bulkCacheAllTemplates,
    refreshDocCategories: refreshDocCategories
  };
})();
