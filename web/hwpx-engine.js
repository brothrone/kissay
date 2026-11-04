/*
 * hwpx-engine.js
 * HWPX(OWPML) 문서를 읽고, 표와 문단을 화면용 모델로 만들고, 고친 문단만 다시 써서 저장한다.
 * 원칙: 손대지 않은 XML은 원본 문자열 그대로 둔다. 고친 문단(<hp:p>)만 통째로 교체한다.
 * 브라우저(window.HwpxEngine)와 Node(require) 양쪽에서 동작한다. zip 처리는 호출하는 쪽 몫이다.
 */
(function (global) {
  'use strict';

  /* ---------- 위치 정보를 보존하는 작은 XML 파서 ---------- */

  const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function decodeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
      if (e[0] === '#') {
        const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
      }
      return ENTITY[e] !== undefined ? ENTITY[e] : m;
    });
  }

  function escapeText(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // XML 1.0에서 허용되지 않는 제어문자를 지운다. 탭은 공백 4칸으로 바꾼다.
  function cleanText(s) {
    return s
      .replace(/\t/g, '    ')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/[\r\n]/g, '');
  }

  function localName(name) {
    const i = name.indexOf(':');
    return i < 0 ? name : name.slice(i + 1);
  }

  function parseXml(src) {
    const root = { type: 'root', name: '#root', children: [], start: 0, end: src.length, parent: null };
    const stack = [root];
    const n = src.length;
    let i = 0;
    const top = () => stack[stack.length - 1];
    const pushText = (a, b, text) => {
      if (b > a) top().children.push({ type: 'text', start: a, end: b, text, parent: top() });
    };
    while (i < n) {
      const lt = src.indexOf('<', i);
      if (lt < 0) { pushText(i, n, decodeEntities(src.slice(i, n))); break; }
      if (lt > i) pushText(i, lt, decodeEntities(src.slice(i, lt)));
      if (src.startsWith('<?', lt)) { i = needEnd(src, '?>', lt) + 2; continue; }
      if (src.startsWith('<!--', lt)) { i = needEnd(src, '-->', lt) + 3; continue; }
      if (src.startsWith('<![CDATA[', lt)) {
        const e = needEnd(src, ']]>', lt);
        pushText(lt, e + 3, src.slice(lt + 9, e));
        i = e + 3; continue;
      }
      if (src.startsWith('<!', lt)) { i = needEnd(src, '>', lt) + 1; continue; }
      if (src[lt + 1] === '/') {
        const e = needEnd(src, '>', lt);
        const name = src.slice(lt + 2, e).trim();
        const el = stack.pop();
        if (!el || el.type !== 'el' || el.name !== name) {
          throw new Error('XML 닫는 태그가 맞지 않습니다: </' + name + '> (위치 ' + lt + ')');
        }
        el.closeStart = lt; el.end = e + 1;
        i = e + 1; continue;
      }
      // 여는 태그: 따옴표 안의 '>'는 건너뛴다
      let j = lt + 1, q = null;
      while (j < n) {
        const c = src[j];
        if (q) { if (c === q) q = null; }
        else if (c === '"' || c === "'") q = c;
        else if (c === '>') break;
        j++;
      }
      if (j >= n) throw new Error('XML 태그가 끝나지 않았습니다 (위치 ' + lt + ')');
      let body = src.slice(lt + 1, j);
      const selfClosing = body.endsWith('/');
      if (selfClosing) body = body.slice(0, -1);
      const nameMatch = /^[^\s/>]+/.exec(body);
      const name = nameMatch ? nameMatch[0] : '';
      const attrs = {};
      const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let m;
      re.lastIndex = name.length;
      while ((m = re.exec(body))) attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
      const el = { type: 'el', name, local: localName(name), attrs, start: lt, openEnd: j + 1, children: [], parent: top() };
      top().children.push(el);
      if (selfClosing) { el.selfClosing = true; el.closeStart = j + 1; el.end = j + 1; }
      else stack.push(el);
      i = j + 1;
    }
    if (stack.length !== 1) throw new Error('XML이 닫히지 않은 태그로 끝납니다: <' + top().name + '>');
    return root;
  }
  function needEnd(src, token, from) {
    const e = src.indexOf(token, from);
    if (e < 0) throw new Error('XML이 중간에 끊겼습니다 (위치 ' + from + ')');
    return e;
  }

  const els = (node) => node.children.filter((c) => c.type === 'el');
  const kids = (node, local) => node.children.filter((c) => c.type === 'el' && c.local === local);
  const kid = (node, local) => node.children.find((c) => c.type === 'el' && c.local === local) || null;
  function findAll(node, local, out = []) {
    for (const c of node.children) {
      if (c.type !== 'el') continue;
      if (c.local === local) out.push(c);
      findAll(c, local, out);
    }
    return out;
  }
  function findFirst(node, local) {
    for (const c of node.children) {
      if (c.type !== 'el') continue;
      if (c.local === local) return c;
      const f = findFirst(c, local);
      if (f) return f;
    }
    return null;
  }
  const num = (v, d = 0) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };

  /* ---------- header.xml: 글꼴, 글자 모양, 문단 모양, 테두리/배경 ---------- */

  function parseHeader(xml) {
    const root = parseXml(xml);
    const fonts = {};
    for (const ff of findAll(root, 'fontface')) {
      const lang = ff.attrs.lang || 'HANGUL';
      fonts[lang] = {};
      for (const f of kids(ff, 'font')) fonts[lang][f.attrs.id] = f.attrs.face || '';
    }
    const charPr = {};
    for (const c of findAll(root, 'charPr')) {
      const fr = kid(c, 'fontRef');
      const sp = kid(c, 'spacing');
      const ul = kid(c, 'underline');
      const so = kid(c, 'strikeout');
      charPr[c.attrs.id] = {
        size: num(c.attrs.height, 1000) / 100, // pt
        color: c.attrs.textColor || '#000000',
        shade: c.attrs.shadeColor && c.attrs.shadeColor !== 'none' ? c.attrs.shadeColor : null,
        bold: !!kid(c, 'bold'),
        italic: !!kid(c, 'italic'),
        underline: !!(ul && ul.attrs.type && ul.attrs.type !== 'NONE'),
        strike: !!(so && so.attrs.shape && so.attrs.shape !== 'NONE'),
        fontHangul: fr ? (fonts.HANGUL || {})[fr.attrs.hangul] || '' : '',
        fontLatin: fr ? (fonts.LATIN || {})[fr.attrs.latin] || '' : '',
        spacing: sp ? num(sp.attrs.hangul, 0) : 0, // 자간 %
      };
    }
    const paraPr = {};
    for (const p of findAll(root, 'paraPr')) {
      const al = kid(p, 'align');
      const pick = (local) => {
        const direct = kid(p, local);
        if (direct) return direct;
        const sw = kid(p, 'switch');
        if (!sw) return null;
        const def = kid(sw, 'default');
        return (def && kid(def, local)) || findFirst(sw, local);
      };
      const mg = pick('margin');
      const mv = (local) => { const e = mg && kid(mg, local); return e ? num(e.attrs.value, 0) : 0; };
      const ls = pick('lineSpacing');
      paraPr[p.attrs.id] = {
        align: al ? al.attrs.horizontal || 'JUSTIFY' : 'JUSTIFY',
        indent: mv('intent'), left: mv('left'), right: mv('right'), prev: mv('prev'), next: mv('next'),
        lineType: ls ? ls.attrs.type || 'PERCENT' : 'PERCENT',
        lineValue: ls ? num(ls.attrs.value, 160) : 160,
      };
    }
    const borderFill = {};
    for (const b of findAll(root, 'borderFill')) {
      const side = (local) => {
        const e = kid(b, local);
        return e ? { type: e.attrs.type || 'NONE', width: e.attrs.width || '0.12 mm', color: e.attrs.color || '#000000' } : null;
      };
      const wb = findFirst(b, 'winBrush');
      let fill = null;
      if (wb && wb.attrs.faceColor && wb.attrs.faceColor !== 'none') fill = wb.attrs.faceColor;
      borderFill[b.attrs.id] = {
        left: side('leftBorder'), right: side('rightBorder'), top: side('topBorder'), bottom: side('bottomBorder'),
        fill,
      };
    }
    return { fonts, charPr, paraPr, borderFill };
  }

  /* ---------- section*.xml: 문단, 표, 편집 단위 ---------- */

  // 문단이 '단순 문단'인지: run 안에 글자(t)만 있고, t 안에 다른 요소(탭, 줄바꿈 등)가 없어야 한다.
  function isSimpleParagraph(p) {
    for (const c of els(p)) {
      if (c.local === 'linesegarray') continue;
      if (c.local !== 'run') return false;
      for (const r of els(c)) {
        if (r.local !== 't') return false;
        if (els(r).length) return false;
      }
    }
    return true;
  }

  function paragraphText(p) {
    let s = '';
    for (const r of kids(p, 'run')) for (const t of kids(r, 't'))
      for (const c of t.children) if (c.type === 'text') s += c.text;
    return s;
  }

  function paragraphRuns(p) {
    const runs = [];
    for (const r of kids(p, 'run')) {
      let s = '';
      for (const t of kids(r, 't')) for (const c of t.children) if (c.type === 'text') s += c.text;
      runs.push({ charPr: r.attrs.charPrIDRef || '0', text: s });
    }
    return runs;
  }

  // 새 글을 넣을 때 쓸 글자 모양: 글자가 있는 첫 run, 없으면 첫 run
  function primaryCharPr(p) {
    const runs = kids(p, 'run');
    for (const r of runs) {
      for (const t of kids(r, 't')) if (t.children.some((c) => c.type === 'text' && c.text.length)) return r.attrs.charPrIDRef || '0';
    }
    return runs[0] ? runs[0].attrs.charPrIDRef || '0' : '0';
  }

  function paraModel(p) {
    return { paraPr: p.attrs.paraPrIDRef || '0', runs: paragraphRuns(p), primary: primaryCharPr(p) };
  }

  // 같은 수가 여러 칸에 걸친 크기(병합 셀)로부터 각 열(행)의 크기를 푼다.
  function solveSizes(count, items) {
    const w = new Array(count).fill(null);
    let changed = true, guard = 0;
    while (changed && guard++ < 200) {
      changed = false;
      for (const it of items) {
        let known = 0; const unknown = [];
        for (let k = it.start; k < it.start + it.span && k < count; k++) {
          if (w[k] == null) unknown.push(k); else known += w[k];
        }
        if (unknown.length === 1) { w[unknown[0]] = Math.max(0, it.size - known); changed = true; }
      }
    }
    for (const it of items) {
      let known = 0; const unknown = [];
      for (let k = it.start; k < it.start + it.span && k < count; k++) {
        if (w[k] == null) unknown.push(k); else known += w[k];
      }
      if (unknown.length) {
        const each = Math.max(0, it.size - known) / unknown.length;
        unknown.forEach((k) => (w[k] = each));
      }
    }
    return w.map((x) => (x == null ? 0 : x));
  }

  function parseSection(src, sectionIndex) {
    const tree = parseXml(src);
    const sec = els(tree)[0];
    if (!sec) throw new Error('본문(section)에 내용이 없습니다');
    const units = [];
    let tableCount = 0;
    let page = null;
    const secPr = findFirst(sec, 'secPr');
    if (secPr) {
      const pp = kid(secPr, 'pagePr');
      if (pp) {
        const mg = kid(pp, 'margin');
        let w = num(pp.attrs.width, 59528), h = num(pp.attrs.height, 84188);
        if (pp.attrs.landscape === 'NARROWLY') { const t = w; w = h; h = t; }
        page = {
          width: w, height: h,
          left: mg ? num(mg.attrs.left) : 5669, right: mg ? num(mg.attrs.right) : 5669,
          top: mg ? num(mg.attrs.top) + num(mg.attrs.header) : 4252,
          bottom: mg ? num(mg.attrs.bottom) + num(mg.attrs.footer) : 4252,
        };
      }
    }

    function makeUnit(kind, paras, extra) {
      const editable = paras.length > 0 && paras.every(isSimpleParagraph);
      const lines = paras.map(paragraphText);
      const u = Object.assign({
        id: 's' + sectionIndex + 'u' + units.length,
        section: sectionIndex,
        kind, paras, editable,
        origLines: lines.slice(), lines: lines.slice(),
        models: paras.map(paraModel),
      }, extra || {});
      units.push(u);
      return u;
    }

    function readTable(tbl) {
      tableCount++;
      const rowCnt = num(tbl.attrs.rowCnt, 0), colCnt = num(tbl.attrs.colCnt, 0);
      const sz = kid(tbl, 'sz');
      const inMargin = kid(tbl, 'inMargin');
      const tableInMargin = inMargin
        ? { left: num(inMargin.attrs.left), right: num(inMargin.attrs.right), top: num(inMargin.attrs.top), bottom: num(inMargin.attrs.bottom) }
        : { left: 510, right: 510, top: 141, bottom: 141 };
      const rows = [];
      const colItems = [], rowItems = [];
      for (const tr of kids(tbl, 'tr')) {
        const row = [];
        for (const tc of kids(tr, 'tc')) {
          const addr = kid(tc, 'cellAddr'), span = kid(tc, 'cellSpan'), csz = kid(tc, 'cellSz');
          const cm = kid(tc, 'cellMargin');
          const sub = kid(tc, 'subList');
          const cell = {
            row: addr ? num(addr.attrs.rowAddr) : 0, col: addr ? num(addr.attrs.colAddr) : 0,
            rowSpan: span ? num(span.attrs.rowSpan, 1) : 1, colSpan: span ? num(span.attrs.colSpan, 1) : 1,
            width: csz ? num(csz.attrs.width) : 0, height: csz ? num(csz.attrs.height) : 0,
            borderFill: tc.attrs.borderFillIDRef || tbl.attrs.borderFillIDRef || '',
            vertAlign: sub ? sub.attrs.vertAlign || 'CENTER' : 'CENTER',
            margin: tc.attrs.hasMargin === '1' && cm
              ? { left: num(cm.attrs.left), right: num(cm.attrs.right), top: num(cm.attrs.top), bottom: num(cm.attrs.bottom) }
              : tableInMargin,
            blocks: [],
            unit: null,
          };
          const paras = sub ? kids(sub, 'p') : [];
          // 칸 안에 표가 또 있으면(중첩 표) 그 칸 자체는 편집하지 않고, 안쪽 표의 칸을 편집한다.
          const nested = paras.some((p) => findFirst(p, 'tbl'));
          cell.unit = makeUnit('cell', paras, { table: tableCount, row: cell.row, col: cell.col, rowSpan: cell.rowSpan, colSpan: cell.colSpan });
          if (nested) {
            cell.unit.editable = false;
            cell.blocks = readBlocks(paras);
          }
          colItems.push({ start: cell.col, span: cell.colSpan, size: cell.width });
          rowItems.push({ start: cell.row, span: cell.rowSpan, size: cell.height });
          row.push(cell);
        }
        rows.push(row);
      }
      colItems.sort((a, b) => a.span - b.span);
      rowItems.sort((a, b) => a.span - b.span);
      return {
        type: 'table', index: tableCount, rowCnt, colCnt,
        width: sz ? num(sz.attrs.width) : 0,
        cellSpacing: num(tbl.attrs.cellSpacing, 0),
        colWidths: solveSizes(colCnt, colItems),
        rowHeights: solveSizes(rowCnt, rowItems),
        rows,
      };
    }

    // 문단 목록을 화면 블록(글 문단 묶음 / 표 / 기타 개체)으로 바꾼다.
    function readBlocks(paras) {
      const blocks = [];
      let pending = [];
      const flush = () => {
        if (pending.length) blocks.push({ type: 'text', unit: makeUnit('body', pending) });
        pending = [];
      };
      for (const p of paras) {
        if (isSimpleParagraph(p)) { pending.push(p); continue; }
        flush();
        const runs = kids(p, 'run');
        let textInP = '';
        for (const r of runs) {
          for (const c of els(r)) {
            if (c.local === 't') { for (const x of c.children) if (x.type === 'text') textInP += x.text; }
            else if (c.local === 'tbl') blocks.push(readTable(c));
            else if (c.local === 'pic' || c.local === 'container' || c.local === 'rect' || c.local === 'ellipse' || c.local === 'equation' || c.local === 'ole') blocks.push({ type: 'object', kind: c.local });
          }
        }
        if (textInP.trim()) blocks.push({ type: 'readonly', text: textInP, model: paraModel(p) });
      }
      flush();
      return blocks;
    }

    const blocks = readBlocks(kids(sec, 'p'));
    return { src, tree, units, blocks, page, tableCount };
  }

  /* ---------- 저장: 고친 편집 단위만 문단 단위로 교체 ---------- */

  function rebuildParagraph(src, p, text, opts) {
    const prefix = p.name.indexOf(':') >= 0 ? p.name.slice(0, p.name.indexOf(':') + 1) : '';
    let startTag = src.slice(p.start, p.openEnd);
    if (p.selfClosing) startTag = startTag.replace(/\s*\/>$/, '>');
    const cp = primaryCharPr(p);
    const clean = cleanText(text);
    let body = clean
      ? '<' + prefix + 'run charPrIDRef="' + cp + '"><' + prefix + 't>' + escapeText(clean) + '</' + prefix + 't></' + prefix + 'run>'
      : '<' + prefix + 'run charPrIDRef="' + cp + '"/>';
    if (opts && opts.lineseg === 'keep') {
      const ls = kid(p, 'linesegarray');
      if (ls) body += src.slice(ls.start, ls.end);
    }
    return startTag + body + '</' + p.name + '>';
  }

  function unitChanged(u) {
    if (u.lines.length !== u.origLines.length) return true;
    for (let i = 0; i < u.lines.length; i++) if (u.lines[i] !== u.origLines[i]) return true;
    return false;
  }

  // 화면 표시용: 현재 글 줄마다 문단 모양/글자 모양을 정한다.
  function currentModels(u) {
    const out = [];
    const m = u.models.length;
    const n = Math.max(1, u.lines.length);
    for (let i = 0; i < n; i++) {
      const line = u.lines[i] !== undefined ? u.lines[i] : '';
      if (i < m && line === u.origLines[i]) { out.push(u.models[i]); continue; }
      const base = u.models[Math.min(i, m - 1)] || { paraPr: '0', primary: '0' };
      out.push({ paraPr: base.paraPr, primary: base.primary, runs: [{ charPr: base.primary, text: line }], edited: true });
    }
    return out;
  }

  function serializeSection(section, opts) {
    const src = section.src;
    const splices = [];
    let rewritten = 0;
    for (const u of section.units) {
      if (!u.editable || !u.paras.length || !unitChanged(u)) continue;
      const P = u.paras;
      const n = Math.max(1, u.lines.length);
      const parts = [];
      for (let i = 0; i < n; i++) {
        const line = u.lines[i] !== undefined ? u.lines[i] : '';
        if (i < P.length && line === u.origLines[i]) parts.push(src.slice(P[i].start, P[i].end));
        else { parts.push(rebuildParagraph(src, P[Math.min(i, P.length - 1)], line, opts)); rewritten++; }
      }
      splices.push({ start: P[0].start, end: P[P.length - 1].end, text: parts.join('') });
    }
    if (!splices.length) return { xml: src, changed: false, rewritten: 0, splices: [] };
    splices.sort((a, b) => a.start - b.start);
    let out = '', pos = 0;
    for (const s of splices) {
      if (s.start < pos) throw new Error('편집 범위가 겹칩니다');
      out += src.slice(pos, s.start) + s.text;
      pos = s.end;
    }
    out += src.slice(pos);
    // 저장 전 자체 검사: 다시 파싱되어야 한다.
    parseXml(out);
    return { xml: out, changed: true, rewritten, splices };
  }

  /* ---------- 패키지(content.hpf)에서 본문 파일 순서 찾기 ---------- */

  function sectionPathsFromManifest(hpfXml, names) {
    const paths = [];
    try {
      const root = parseXml(hpfXml);
      const items = {};
      for (const it of findAll(root, 'item')) items[it.attrs.id] = it.attrs.href;
      for (const ref of findAll(root, 'itemref')) {
        const href = items[ref.attrs.idref];
        if (href && /section\d+\.xml$/i.test(href)) paths.push(href);
      }
    } catch (e) { /* 아래에서 이름으로 찾는다 */ }
    if (!paths.length) {
      names.filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
        .sort((a, b) => parseInt(a.match(/(\d+)\.xml$/)[1], 10) - parseInt(b.match(/(\d+)\.xml$/)[1], 10))
        .forEach((n) => paths.push(n));
    }
    return paths;
  }

  const api = {
    parseXml, parseHeader, parseSection, serializeSection, sectionPathsFromManifest,
    unitChanged, currentModels, isSimpleParagraph, paragraphText, cleanText,
    HWPUNIT_PER_PX: 75, // 1인치 = 7200 HWPUNIT, 화면 96px 기준
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.HwpxEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
