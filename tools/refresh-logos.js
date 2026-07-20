/* ============================================================================
 * refresh-logos.js — re-download the bundled report logos into assets/.
 *
 * WHY THIS IS A BUILD-TIME STEP, NOT A RUNTIME SYNC:
 *   The report generators must read the logo's raw bytes to embed them in the
 *   PDF/ODT. The image hosts (chproductimages.homegroup.com.au, and the BPH
 *   host root) send NO Access-Control-Allow-Origin header, so a cross-origin
 *   fetch() from the PWA origin is CORS-blocked on real devices — the logo
 *   cannot be downloaded from the browser. There is also no ClickHome V2 API
 *   endpoint that serves the logo bytes (Files/List is per-contract documents
 *   only). So the logos are BUNDLED as local same-origin assets, and refreshed
 *   here whenever the source logos change (the HG logo filename is dated, so it
 *   rotates roughly yearly).
 *
 * If CORS is ever enabled on the image hosts, this could move to the in-app
 * "Sync for offline" step (download -> cache in IndexedDB -> fall back to the
 * bundled asset). Until then, run this and redeploy.
 *
 * USAGE:  node tools/refresh-logos.js
 * ==========================================================================*/
'use strict';
var https = require('https');
var fs = require('fs');
var path = require('path');

var ASSETS = path.join(__dirname, '..', 'assets');

// source url -> bundled filename. HG logo is shared by all HG systems
// (WA Metro / SW / GS + VIC — confirmed identical). BPH is taken from the
// host root (env-independent; the webservice-path variant 404s).
var LOGOS = [
  { url: 'https://chproductimages.homegroup.com.au/Logo/HGLogo20260617.png', file: 'logo-hg.png',  minBytes: 1000 },
  { url: 'https://clickhome.blueprinthomes.com.au/BPH_Logo.jpg',             file: 'logo-bph.jpg', minBytes: 1000 }
];

var PNG_SIG = [0x89, 0x50, 0x4e, 0x47];
var JPG_SIG = [0xff, 0xd8, 0xff];

function sigOk(buf, file) {
  var sig = /\.png$/i.test(file) ? PNG_SIG : JPG_SIG;
  for (var i = 0; i < sig.length; i++) { if (buf[i] !== sig[i]) return false; }
  return true;
}

function download(url) {
  return new Promise(function (resolve, reject) {
    https.get(url, function (res) {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve(Buffer.concat(chunks)); });
    }).on('error', reject);
  });
}

(async function () {
  if (!fs.existsSync(ASSETS)) fs.mkdirSync(ASSETS, { recursive: true });
  var failures = 0;
  for (var i = 0; i < LOGOS.length; i++) {
    var l = LOGOS[i];
    try {
      var buf = await download(l.url);
      if (buf.length < l.minBytes || !sigOk(buf, l.file)) {
        throw new Error('unexpected content (' + buf.length + ' bytes, bad signature) — refusing to overwrite ' + l.file);
      }
      fs.writeFileSync(path.join(ASSETS, l.file), buf);
      console.log('  OK  ' + l.file + '  (' + buf.length + ' bytes)  <- ' + l.url);
    } catch (e) {
      failures++;
      console.error('  FAIL ' + l.file + ': ' + e.message);
    }
  }
  console.log(failures ? ('\nDone with ' + failures + ' failure(s). Existing assets left untouched.') : '\nAll logos refreshed. Remember to redeploy (and bump the SW cache version in sw.js).');
  process.exit(failures ? 1 : 0);
})();
