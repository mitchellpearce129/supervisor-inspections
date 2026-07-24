/* ============================================================================
 * docgen.js — on-device OpenDocument (.odt) generation, no dependencies.
 * Classic script: exposes window.CHDoc.buildOdt(model) -> Promise<Blob>.
 *
 * An .odt is a ZIP of XML parts + embedded images. We hand-roll a minimal
 * STORE-only ZIP writer (no compression — valid for ODT, and the mimetype
 * part must be first and stored) so the whole thing runs client-side with no
 * library. Photos/signatures are embedded under Pictures/ and referenced from
 * content.xml.
 *
 * model = {
 *   title, contract: { number, address, client, stage, supervisor, inspectionType, date },
 *   questions: [ { text, answer, comment, photos: [Blob] } ],
 *   signatures: [ { label, name, blob: Blob } ]
 * }
 * ==========================================================================*/
(function () {
  'use strict';

  var enc = new TextEncoder();

  // ---- CRC32 ---------------------------------------------------------------
  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---- minimal STORE-only ZIP ---------------------------------------------
  function zipStore(entries) {
    var chunks = [], offset = 0, central = [];
    function push(u8) { chunks.push(u8); offset += u8.length; }
    entries.forEach(function (e) {
      var name = enc.encode(e.name), data = e.bytes, crc = crc32(data), at = offset;
      var h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0, true);
      h.setUint16(8, 0, true); h.setUint16(10, 0, true); h.setUint16(12, 0, true);
      h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      push(new Uint8Array(h.buffer)); push(name); push(data);
      central.push({ name: name, crc: crc, size: data.length, at: at });
    });
    var cdStart = offset;
    central.forEach(function (c) {
      var h = new DataView(new ArrayBuffer(46));
      h.setUint32(0, 0x02014b50, true); h.setUint16(4, 20, true); h.setUint16(6, 20, true);
      h.setUint16(8, 0, true); h.setUint16(10, 0, true); h.setUint16(12, 0, true); h.setUint16(14, 0, true);
      h.setUint32(16, c.crc, true); h.setUint32(20, c.size, true); h.setUint32(24, c.size, true);
      h.setUint16(28, c.name.length, true); h.setUint16(30, 0, true); h.setUint16(32, 0, true);
      h.setUint16(34, 0, true); h.setUint16(36, 0, true); h.setUint32(38, 0, true); h.setUint32(42, c.at, true);
      push(new Uint8Array(h.buffer)); push(c.name);
    });
    var e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(4, 0, true); e.setUint16(6, 0, true);
    e.setUint16(8, central.length, true); e.setUint16(10, central.length, true);
    e.setUint32(12, offset - cdStart, true); e.setUint32(16, cdStart, true); e.setUint16(20, 0, true);
    push(new Uint8Array(e.buffer));
    var total = chunks.reduce(function (a, c) { return a + c.length; }, 0), out = new Uint8Array(total), p = 0;
    chunks.forEach(function (c) { out.set(c, p); p += c.length; });
    return out;
  }

  // ---- helpers -------------------------------------------------------------
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function cm(n) { return n.toFixed(2) + 'cm'; }
  function bytesOf(blob) { return blob.arrayBuffer().then(function (ab) { return new Uint8Array(ab); }); }
  function dims(blob, maxW, defW, defH) {
    if (!self.createImageBitmap) return Promise.resolve({ w: maxW, h: maxW * defH / defW });
    return createImageBitmap(blob).then(function (b) {
      var w = b.width, h = b.height; if (b.close) b.close();
      return { w: maxW, h: maxW * (h / w || defH / defW) };
    }).catch(function () { return { w: maxW, h: maxW * defH / defW }; });
  }

  var NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
    'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
    'xmlns:xlink="http://www.w3.org/1999/xlink"';

  // ---- build the .odt ------------------------------------------------------
  function buildOdt(model) {
    var pics = [];     // { path, bytes }
    var frameSeq = 0;

    // Register an image blob → returns a Promise<content-xml frame string>.
    function frame(blob, maxW, defW, defH) {
      var idx = pics.length + 1, path = 'Pictures/img' + idx + '.jpg';
      return Promise.all([bytesOf(blob), dims(blob, maxW, defW, defH)]).then(function (r) {
        pics.push({ path: path, bytes: r[0] });
        frameSeq++;
        return '<text:p><draw:frame draw:name="f' + frameSeq + '" text:anchor-type="as-char" svg:width="' +
          cm(r[1].w) + '" svg:height="' + cm(r[1].h) + '"><draw:image xlink:href="' + path +
          '" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></text:p>';
    });
    }

    var c = model.contract || {};
    var bodyParts = [];
    bodyParts.push('<text:h text:outline-level="1">' + esc(model.title || 'Inspection') + '</text:h>');
    [['Contract', c.number], ['Address', c.address], ['Client', c.client], ['Stage', c.stage],
     ['Inspection', c.inspectionType], ['Supervisor', c.supervisor], ['Date', c.date]].forEach(function (kv) {
      if (kv[1]) bodyParts.push('<text:p>' + esc(kv[0]) + ': ' + esc(kv[1]) + '</text:p>');
    });

    // Build questions sequentially so image indices stay ordered.
    var chain = Promise.resolve();
    if (model.logo) { chain = chain.then(function () { return frame(model.logo, 5, 3, 1); }).then(function (fr) { bodyParts.unshift(fr); }); }
    // Location map + defect list at the top (Kerb & Footpath-style reports).
    if (model.locationMap) { chain = chain.then(function () { return frame(model.locationMap, 16, 4, 3); }).then(function (fr) { bodyParts.push(fr); }); }
    // PCI floor plan with numbered defect pins (numbers match the schedule below).
    if (model.planImage) { chain = chain.then(function () { bodyParts.push('<text:h text:outline-level="2">Floor Plan</text:h>'); return frame(model.planImage, 12, 3, 4); }).then(function (fr) { bodyParts.push(fr); }); }
    if (model.defects) {
      chain = chain.then(function () {
        bodyParts.push('<text:h text:outline-level="2">Defect Locations</text:h>');
        model.defects.forEach(function (d) {
          bodyParts.push('<text:p>' + esc(d.n + '. ' + d.text + ' — ' + d.lat.toFixed(6) + ', ' + d.lon.toFixed(6) + ' (±' + Math.round(d.acc) + 'm)  ' + d.link) + '</text:p>');
        });
      });
    }
    // PCI defect schedule (grouped by area).
    if (model.defectSchedule) {
      model.defectSchedule.forEach(function (grp) {
        chain = chain.then(function () {
          bodyParts.push('<text:h text:outline-level="2">' + esc(grp.area) + '</text:h>');
          var pc = Promise.resolve();
          grp.defects.forEach(function (d) {
            pc = pc.then(function () {
              bodyParts.push('<text:p>' + esc(d.n + '. Issue: ' + (d.category || '-') + (d.pin ? '  (plan pin ' + d.n + ')' : '')) + '</text:p>');
              if (d.comment) bodyParts.push('<text:p>Comment: ' + esc(d.comment) + '</text:p>');
            });
            (d.photos || []).forEach(function (ph) { pc = pc.then(function () { return frame(ph, 8, 4, 3); }).then(function (fr) { bodyParts.push(fr); }); });
          });
          return pc;
        });
      });
    }
    (model.questions || []).forEach(function (q, qi) {
      chain = chain.then(function () {
        bodyParts.push('<text:h text:outline-level="2">' + esc((qi + 1) + '. ' + q.text) + '</text:h>');
        bodyParts.push('<text:p>Response: ' + esc(q.answer) + '</text:p>');
        if (q.comment) bodyParts.push('<text:p>Comment: ' + esc(q.comment) + '</text:p>');
        var pc = Promise.resolve();
        (q.photos || []).forEach(function (ph) {
          pc = pc.then(function () { return frame(ph, 8, 4, 3); }).then(function (fr) { bodyParts.push(fr); });
        });
        return pc;
      });
    });

    // Signatures.
    chain = chain.then(function () {
      if (model.instructions) String(model.instructions).split(/\n+/).forEach(function (para) { if (para.trim()) bodyParts.push('<text:p>' + esc(para.trim()) + '</text:p>'); });
      bodyParts.push('<text:h text:outline-level="2">Sign-off</text:h>');
      var sc = Promise.resolve();
      (model.signatures || []).forEach(function (s) {
        sc = sc.then(function () {
          bodyParts.push('<text:p>' + esc(s.label) + ': ' + esc(s.name) + '</text:p>');
          if (s.blob) return frame(s.blob, 7, 3, 1).then(function (fr) { bodyParts.push(fr); });
        });
      });
      return sc;
    });

    return chain.then(function () {
      var content = '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<office:document-content ' + NS + ' office:version="1.2"><office:body><office:text>' +
        bodyParts.join('') + '</office:text></office:body></office:document-content>';

      var styles = '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2">' +
        '<office:styles/><office:automatic-styles/><office:master-styles/></office:document-styles>';

      var manEntries = ['<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>',
        '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>',
        '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>'];
      pics.forEach(function (p) { manEntries.push('<manifest:file-entry manifest:full-path="' + p.path + '" manifest:media-type="image/jpeg"/>'); });
      var manifest = '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">' +
        manEntries.join('') + '</manifest:manifest>';

      var entries = [
        { name: 'mimetype', bytes: enc.encode('application/vnd.oasis.opendocument.text') },
        { name: 'content.xml', bytes: enc.encode(content) },
        { name: 'styles.xml', bytes: enc.encode(styles) },
        { name: 'META-INF/manifest.xml', bytes: enc.encode(manifest) }
      ];
      pics.forEach(function (p) { entries.push({ name: p.path, bytes: p.bytes }); });

      return new Blob([zipStore(entries)], { type: 'application/vnd.oasis.opendocument.text' });
    });
  }

  window.CHDoc = { buildOdt: buildOdt, _zipStore: zipStore, _crc32: crc32 };
})();
