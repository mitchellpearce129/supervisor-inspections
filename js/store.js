/* ============================================================================
 * store.js — on-device durable storage (IndexedDB). Three object stores:
 *   drafts  — in-progress captures (keyPath draftId), survive crash/reload.
 *   cache   — offline copies of the job list, per-job inspection lists, and
 *             template configs (keyPath key: 'joblist' | 'inspections:<id>' |
 *             'tmpl:<id>' | 'templates').
 *   pending — finalised inspections awaiting upload (keyPath id = draftId),
 *             holding the generated docs + photos until every file is confirmed.
 * ==========================================================================*/
(function () {
  'use strict';

  var DB_NAME = 'supervisor-inspections';
  var DB_VER = 2;
  var KEYPATH = { drafts: 'draftId', cache: 'key', pending: 'id' };
  var dbPromise = null;
  var available = !!(window.indexedDB);

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        var db = req.result;
        Object.keys(KEYPATH).forEach(function (s) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: KEYPATH[s] });
        });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function reqProm(request) { return new Promise(function (res, rej) { request.onsuccess = function () { res(request.result); }; request.onerror = function () { rej(request.error); }; }); }
  function withStore(store, mode, fn) { return open().then(function (db) { return fn(db.transaction(store, mode).objectStore(store)); }); }
  function put(store, val) { return withStore(store, 'readwrite', function (s) { return reqProm(s.put(val)); }); }
  function get(store, key) { return withStore(store, 'readonly', function (s) { return reqProm(s.get(key)); }); }
  function del(store, key) { return withStore(store, 'readwrite', function (s) { return reqProm(s.delete(key)); }); }
  function all(store) { return withStore(store, 'readonly', function (s) { return reqProm(s.getAll()); }); }

  window.CHStore = {
    available: available,
    // in-progress capture drafts
    putDraft: function (d) { return put('drafts', d); },
    getDraft: function (id) { return get('drafts', id); },
    deleteDraft: function (id) { return del('drafts', id); },
    allDrafts: function () { return all('drafts'); },
    // offline cache (job list, inspection lists, template configs)
    cachePut: function (key, data) { return put('cache', { key: key, data: data, updatedAt: Date.now() }); },
    cacheGet: function (key) { return get('cache', key); },
    // pending-upload queue
    pendingPut: function (r) { return put('pending', r); },
    pendingGet: function (id) { return get('pending', id); },
    pendingDelete: function (id) { return del('pending', id); },
    pendingAll: function () { return all('pending'); }
  };
})();
