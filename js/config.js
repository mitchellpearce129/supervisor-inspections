/* ============================================================================
 * config.js — systems, endpoints, and shared constants.
 * Classic script (no modules): exposes window.CH_CONFIG.
 *
 * The supervisor picks a ClickHome system on the login screen BEFORE signing
 * in; that choice sets the API base + document-category ids + a per-system
 * cache namespace. The selection is remembered on-device.
 * ==========================================================================*/
(function () {
  'use strict';

  // One entry per business-unit ClickHome instance. Doc-category ids are
  // per-database, so they live here per system (TEST mirrors PROD). `null`
  // means "not yet confirmed for this system" — upload is blocked until known.
  // Report logo, BUNDLED as a local same-origin asset (assets/). Why local and
  // not the live CDN url: the report generators must fetch() the image bytes to
  // embed them, and the image hosts send NO Access-Control-Allow-Origin header,
  // so a cross-origin fetch() from the PWA origin is CORS-blocked on real
  // devices (and <img>+canvas taints the canvas the same way). Bundling also
  // means the logo renders offline — essential for an offline-first app.
  // Sources (downloaded 2026-07-17):
  //   HG  = chproductimages.homegroup.com.au/Logo/HGLogo20260617.png
  //         (HGWA Metro Prod RPRT.fnFileLocation('LOGOMAIN', NULL); shared by all HG WA)
  //   BPH = clickhome.blueprinthomes.com.au/BPH_Logo.jpg (host-root, env-independent)
  // HG VIC uses the SAME logo as HG WA (confirmed identical, 2026-07-17).
  // Refresh the bundled files if the source logos change.
  var HG_LOGO = 'assets/logo-hg.png';
  var BPH_LOGO = 'assets/logo-bph.jpg';

  var SYSTEMS = [
    { id: 'metro', label: 'HomeGroup WA Perth', host: 'https://clickhome.homegroup.com.au', test: '/ClickHome3WebServiceMetroTest', prod: '/ClickHome3WebserviceMetro', docCategories: { inspections: 1062, inspectionPhotos: 9 }, logo: HG_LOGO },
    // Confirmed 2026-07-17 from each instance's tblDocCategories: Inspection
    // Photo = 9 everywhere; but only Metro has a dedicated "Inspection Reports"
    // (1062). SW/GS/VIC/BPH have only a generic "Reports" (8) — used here as an
    // interim report home; consider adding a dedicated "Inspection Reports"
    // category per instance for consistency + clean close-out.
    { id: 'sw', label: 'HomeGroup WA Bunbury', host: 'https://clickhome.homegroup.com.au', test: '/ClickHome3WebServiceSWTest', prod: '/ClickHome3WebServiceSW', docCategories: { inspections: 8, inspectionPhotos: 9 }, logo: HG_LOGO },
    { id: 'gs', label: 'HomeGroup WA Albany', host: 'https://clickhome.homegroup.com.au', test: '/ClickHome3WebServiceGSTest', prod: '/ClickHome3WebServiceGS', docCategories: { inspections: 8, inspectionPhotos: 9 }, logo: HG_LOGO },
    { id: 'vic', label: 'HomeGroup VIC Melbourne', host: 'https://chvic.homegroup.com.au', test: '/ClickHome3WebServiceVicTest', prod: '/ClickHome3WebServiceVic', docCategories: { inspections: 8, inspectionPhotos: 9 }, logo: HG_LOGO },
    { id: 'bph', label: 'BluePrint Homes WA Perth', host: 'https://clickhome.blueprinthomes.com.au', test: '/ClickHome3WebServiceBPHTest', prod: '/ClickHome3WebserviceBlueprint', docCategories: { inspections: 8, inspectionPhotos: 9 }, logo: BPH_LOGO }
  ];

  // Flat, selectable options: each system × {TEST, PROD}.
  var OPTIONS = [];
  SYSTEMS.forEach(function (s) {
    OPTIONS.push({ key: s.id + ':test', label: s.label + ' (TEST)', apiBase: s.host + s.test, systemId: s.id + '-test', docCategories: s.docCategories, logo: s.logo });
    OPTIONS.push({ key: s.id + ':prod', label: s.label + ' (PROD)', apiBase: s.host + s.prod, systemId: s.id + '-prod', docCategories: s.docCategories, logo: s.logo });
  });

  var CFG = {
    tokenHeader: 'ClickHomeApiToken',

    systems: SYSTEMS,
    options: OPTIONS,
    // Active selection — populated by selectSystem().
    activeKey: null, apiBase: null, label: '', systemId: null, docCategories: null, logo: null,

    selectSystem: function (key) {
      var o = null;
      for (var i = 0; i < OPTIONS.length; i++) { if (OPTIONS[i].key === key) { o = OPTIONS[i]; break; } }
      if (!o) return false;
      this.activeKey = o.key; this.apiBase = o.apiBase; this.label = o.label;
      this.systemId = o.systemId; this.docCategories = o.docCategories; this.logo = o.logo;
      try { localStorage.setItem('ch_system', key); } catch (e) { /* ignore */ }
      return true;
    },

    // Cache-key namespace so different systems don't share cached jobs/templates.
    ns: function (k) { return (this.systemId || 'none') + '|' + k; },

    // inResponseType -> capture widget + result values (client-defined enum,
    // consistent across instances). Pinned from the DB 'Test' template.
    responseTypes: {
      0: { label: 'Yes 1 No 0', kind: 'choice', options: [{ label: 'Yes', value: 1 }, { label: 'No', value: 0 }] },
      1: { label: 'From Zero To Ten', kind: 'number', min: 0, max: 10 },
      2: { label: 'From Zero To Thousand', kind: 'number', min: 0, max: 1000 },
      3: { label: 'Custom', kind: 'text' },
      4: { label: 'Yes 1 No 0 NA 2', kind: 'choice', options: [{ label: 'Yes', value: 1 }, { label: 'No', value: 0 }, { label: 'NA', value: 2 }] },
      // 6/7/8 are the area-based PCI types. The app does NOT reproduce the
      // question x area matrix — inspections whose items are any of these switch
      // to the free-form DEFECT-LOGGING capture mode (area + issue category +
      // comment + photo). See app.js isPciConfig()/DefectScreen.
      6: { label: 'PCI Phase 1', kind: 'pci' },
      7: { label: 'PCI Phase 2', kind: 'pci' },
      8: { label: 'Statutory', kind: 'pci' }
    },

    // Inspection types that get a GPS "location map + defect list" section at
    // the top of the report. Matched case-insensitively as a substring of the
    // inspection name (inspectionGroup) — aimed at Kerb & Footpath-style
    // reports where photo locations are the point. Empty array = never render.
    // Tune these terms once the exact template name is known.
    locationMapMatch: ['kerb', 'footpath'],

    // Config-fetch account for admin inspection-template reads (Option 3).
    // SECURITY: a client-side PWA CANNOT hide this — keep it least-privilege.
    // Paste the password at deploy; leave blank in source. (Per-system config
    // accounts may be needed once systems beyond Metro are enabled.)
    agent: { username: 'claude.agent', password: '01C3B070-8F21-EB11-96F9-00505690B206' }
  };

  // Restore the last-used system so the Super doesn't re-pick every launch.
  try { var last = localStorage.getItem('ch_system'); if (last) CFG.selectSystem(last); } catch (e) { /* ignore */ }

  window.CH_CONFIG = CFG;
})();
