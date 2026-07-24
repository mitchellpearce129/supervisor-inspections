/* ============================================================================
 * pdfgen.js — on-device PDF generation, no dependencies.
 * Classic script: exposes window.CHPdf.buildPdf(model) -> Promise<Blob>.
 *
 * Hand-rolled minimal PDF 1.4: base-14 Helvetica text (no font embedding),
 * JPEG photos/signatures embedded as DCTDecode image XObjects, A4 pages with
 * top-down layout, word-wrap, and automatic pagination. Same `model` shape as
 * docgen.js (the ODT is the editable backup; this PDF is the primary output).
 * ==========================================================================*/
(function () {
  'use strict';
  var enc = new TextEncoder();
  var PW = 595.28, PH = 841.89, M = 50, CW = PW - 2 * M;

  // Base-14 Helvetica renders single-byte (WinAnsi/ASCII) text, but the content
  // stream is written as UTF-8 — so any non-ASCII char (en-dash, curly quotes,
  // accented letters, °, …) would appear as mojibake ("–" -> "â€"). Fold text
  // down to ASCII first: map common smart punctuation, strip accents via NFKD,
  // and replace anything still non-ASCII with '?'. (The ODT keeps full UTF-8.)
  function toAscii(s) {
    return String(s == null ? '' : s)
      .replace(/[\u2018\u2019\u201A\u2032\u2035]/g, "'")            // curly single quotes / primes -> '
      .replace(/[\u201C\u201D\u201E\u2033\u2036]/g, '"')            // curly double quotes / primes -> "
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-') // hyphens / en/em dash / minus -> -
      .replace(/\u2026/g, '...')                                       // ellipsis -> ...
      .replace(/[\u00A0\u2002\u2003\u2007\u2009\u200A\u202F]/g, ' ') // nbsp / thin spaces -> space
      .replace(/[\u2022\u00B7]/g, '*')                                // bullet / middot -> *
      .normalize('NFKD').replace(/[\u0300-\u036F]/g, '')              // strip accents: e-acute -> e
      .replace(/[^\x00-\x7F]/g, '?');                                 // any remaining non-ASCII -> ?
  }
  function escText(s) { return toAscii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }

  function wrap(text, maxChars) {
    var words = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().split(' ');
    var lines = [], cur = '';
    function flush() { if (cur !== '') { lines.push(cur); cur = ''; } }
    words.forEach(function (w) {
      while (w.length > maxChars) { flush(); lines.push(w.slice(0, maxChars)); w = w.slice(maxChars); }
      if (cur === '') cur = w;
      else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
      else { flush(); cur = w; }
    });
    flush();
    return lines.length ? lines : [''];
  }

  function dimsNat(blob, dw, dh) {
    if (!self.createImageBitmap) return Promise.resolve({ w: dw, h: dh });
    return createImageBitmap(blob).then(function (b) { var w = b.width, h = b.height; if (b.close) b.close(); return { w: w || dw, h: h || dh }; })
      .catch(function () { return { w: dw, h: dh }; });
  }

  function buildPdf(model) {
    var imgs = [], blocks = [];
    function regImg(blob, dw, dh) {
      return Promise.all([blob.arrayBuffer(), dimsNat(blob, dw, dh)]).then(function (r) {
        imgs.push({ bytes: new Uint8Array(r[0]), w: r[1].w, h: r[1].h }); return imgs.length - 1;
      });
    }

    var c = model.contract || {};
    blocks.push({ t: 'h1', text: model.title || 'Inspection' });
    [['Contract', c.number], ['Address', c.address], ['Client', c.client], ['Stage', c.stage],
     ['Inspection', c.inspectionType], ['Supervisor', c.supervisor], ['Date', c.date]].forEach(function (kv) {
      if (kv[1]) blocks.push({ t: 'p', text: kv[0] + ': ' + kv[1] });
    });

    var chain = Promise.resolve();
    if (model.logo) { chain = chain.then(function () { return regImg(model.logo, 900, 300); }).then(function (idx) { blocks.unshift({ t: 'img', idx: idx, frac: 0.4 }); }); }
    // Location map + defect list at the top (Kerb & Footpath-style reports).
    if (model.locationMap) { chain = chain.then(function () { return regImg(model.locationMap, 1000, 700); }).then(function (idx) { blocks.push({ t: 'img', idx: idx, frac: 0.92 }); }); }
    // PCI floor plan with numbered defect pins (numbers match the schedule below).
    if (model.planImage) { chain = chain.then(function () { blocks.push({ t: 'h2', text: 'Floor Plan' }); return regImg(model.planImage, 1000, 1600); }).then(function (idx) { blocks.push({ t: 'img', idx: idx, frac: 0.9 }); }); }
    if (model.defects) {
      chain = chain.then(function () {
        blocks.push({ t: 'h2', text: 'Defect Locations' });
        model.defects.forEach(function (d) {
          blocks.push({ t: 'p', text: d.n + '. ' + d.text + ' — ' + d.lat.toFixed(6) + ', ' + d.lon.toFixed(6) + ' (±' + Math.round(d.acc) + 'm)  ' + d.link });
        });
      });
    }
    // PCI defect schedule (grouped by area).
    if (model.defectSchedule) {
      model.defectSchedule.forEach(function (grp) {
        chain = chain.then(function () {
          blocks.push({ t: 'h2', text: grp.area });
          var pc = Promise.resolve();
          grp.defects.forEach(function (d) {
            pc = pc.then(function () {
              blocks.push({ t: 'p', text: d.n + '. Issue: ' + (d.category || '-') + (d.pin ? '  (plan pin ' + d.n + ')' : '') });
              if (d.comment) blocks.push({ t: 'p', text: 'Comment: ' + d.comment });
            });
            (d.photos || []).forEach(function (ph) { pc = pc.then(function () { return regImg(ph, 1000, 750); }).then(function (idx) { blocks.push({ t: 'img', idx: idx, frac: 0.6 }); }); });
          });
          return pc;
        });
      });
    }
    (model.questions || []).forEach(function (q, qi) {
      chain = chain.then(function () {
        blocks.push({ t: 'h2', text: (qi + 1) + '. ' + q.text });
        blocks.push({ t: 'p', text: 'Response: ' + q.answer });
        if (q.comment) blocks.push({ t: 'p', text: 'Comment: ' + q.comment });
        var pc = Promise.resolve();
        (q.photos || []).forEach(function (ph) { pc = pc.then(function () { return regImg(ph, 1000, 750); }).then(function (idx) { blocks.push({ t: 'img', idx: idx, frac: 0.6 }); }); });
        return pc;
      });
    });
    chain = chain.then(function () {
      if (model.instructions) String(model.instructions).split(/\n+/).forEach(function (para) { if (para.trim()) blocks.push({ t: 'p', text: para.trim() }); });
      blocks.push({ t: 'h2', text: 'Sign-off' });
      var sc = Promise.resolve();
      (model.signatures || []).forEach(function (s) {
        sc = sc.then(function () { blocks.push({ t: 'p', text: s.label + ': ' + s.name }); if (s.blob) return regImg(s.blob, 600, 200).then(function (idx) { blocks.push({ t: 'img', idx: idx, frac: 0.45 }); }); });
      });
      return sc;
    });

    return chain.then(function () {
      // ---- layout into page content streams ----
      var pages = [], ops = [], y = PH - M;
      function flush() { pages.push(ops.join('\n')); ops = []; y = PH - M; }
      function ensure(need) { if (y - need < M) flush(); }
      function textBlock(text, size, font) {
        var lh = size * 1.35, maxChars = Math.max(8, Math.floor(CW / (size * 0.52)));
        wrap(text, maxChars).forEach(function (line) {
          ensure(lh);
          ops.push('BT /' + font + ' ' + size + ' Tf 1 0 0 1 ' + M.toFixed(2) + ' ' + (y - size).toFixed(2) + ' Tm (' + escText(line) + ') Tj ET');
          y -= lh;
        });
        y -= size * 0.4;
      }
      function imgBlock(b) {
        var im = imgs[b.idx], dw = CW * b.frac, dh = dw * ((im.h / im.w) || 0.75);
        var maxH = PH - 2 * M; if (dh > maxH) { dh = maxH; dw = dh * (im.w / im.h); }
        ensure(dh + 6);
        ops.push('q ' + dw.toFixed(2) + ' 0 0 ' + dh.toFixed(2) + ' ' + M.toFixed(2) + ' ' + (y - dh).toFixed(2) + ' cm /Im' + b.idx + ' Do Q');
        y -= (dh + 8);
      }
      blocks.forEach(function (b) {
        if (b.t === 'h1') textBlock(b.text, 16, 'F2');
        else if (b.t === 'h2') textBlock(b.text, 12, 'F2');
        else if (b.t === 'p') textBlock(b.text, 10, 'F1');
        else if (b.t === 'img') imgBlock(b);
      });
      flush();

      // ---- assemble the PDF bytes ----
      var NI = imgs.length, NP = pages.length, nRes = 5 + NI;
      var kids = []; for (var i = 0; i < NP; i++) kids.push(nRes + 1 + 2 * i);
      var total = nRes + 2 * NP;
      var chunks = [], offset = 0, offsets = {};
      function put(s) { var u8 = (typeof s === 'string') ? enc.encode(s) : s; chunks.push(u8); offset += u8.length; }
      function startObj(n) { offsets[n] = offset; put(n + ' 0 obj\n'); }
      function endObj() { put('\nendobj\n'); }

      put('%PDF-1.4\n'); put(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));
      startObj(1); put('<< /Type /Catalog /Pages 2 0 R >>'); endObj();
      startObj(2); put('<< /Type /Pages /Kids [' + kids.map(function (k) { return ' ' + k + ' 0 R'; }).join('') + ' ] /Count ' + NP + ' >>'); endObj();
      startObj(3); put('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); endObj();
      startObj(4); put('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'); endObj();
      imgs.forEach(function (im, i) {
        startObj(5 + i);
        put('<< /Type /XObject /Subtype /Image /Width ' + im.w + ' /Height ' + im.h + ' /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /DCTDecode /Length ' + im.bytes.length + ' >>\nstream\n');
        put(im.bytes); put('\nendstream'); endObj();
      });
      var xobj = imgs.map(function (im, i) { return '/Im' + i + ' ' + (5 + i) + ' 0 R'; }).join(' ');
      startObj(nRes); put('<< /Font << /F1 3 0 R /F2 4 0 R >> /XObject << ' + xobj + ' >> >>'); endObj();
      for (var j = 0; j < NP; j++) {
        var pageN = nRes + 1 + 2 * j, contentN = nRes + 2 + 2 * j;
        startObj(pageN); put('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PW + ' ' + PH + '] /Resources ' + nRes + ' 0 R /Contents ' + contentN + ' 0 R >>'); endObj();
        var csb = enc.encode(pages[j]);
        startObj(contentN); put('<< /Length ' + csb.length + ' >>\nstream\n'); put(pages[j]); put('\nendstream'); endObj();
      }
      var xrefStart = offset;
      put('xref\n0 ' + (total + 1) + '\n'); put('0000000000 65535 f \n');
      for (var n = 1; n <= total; n++) put(String(offsets[n]).padStart(10, '0') + ' 00000 n \n');
      put('trailer\n<< /Size ' + (total + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF');

      var tot = chunks.reduce(function (a, cc) { return a + cc.length; }, 0), outb = new Uint8Array(tot), p = 0;
      chunks.forEach(function (cc) { outb.set(cc, p); p += cc.length; });
      return new Blob([outb], { type: 'application/pdf' });
    });
  }

  window.CHPdf = { buildPdf: buildPdf };
})();
