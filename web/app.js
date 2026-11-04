/* app.js: 화면 그리기, 칸 편집, 저장 */
(function () {
  'use strict';
  const E = window.HwpxEngine;
  const $ = (id) => document.getElementById(id);
  const PX = (hu) => hu / E.HWPUNIT_PER_PX; // HWPUNIT → px
  const PT2PX = 96 / 72;

  const state = {
    doc: null,          // { fileName, zip, order, header, sectionPaths, sections, previewUrl }
    unitEls: new Map(), // unit.id → { unit, el }
    editing: null,      // { unit, el, textarea, before }
    zoom: 1,
    userZoom: false,   // 선생님이 직접 확대/축소를 누르면 자동 맞춤을 멈춘다
  };

  /* ---------- 공통 ---------- */
  let toastTimer = null;
  function toast(msg, isError) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('is-error', !!isError);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), isError ? 7000 : 3500);
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /* ---------- 서식 → CSS ---------- */
  const SERIF = /바탕|명조|궁서|Batang|Myeongjo|Times|serif/i;
  function fontStack(cp) {
    const face = cp.fontHangul || cp.fontLatin || '';
    const web = SERIF.test(face) ? '"Nanum Myeongjo", "Batang", serif' : '"Nanum Gothic", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
    return face ? '"' + face.replace(/"/g, '') + '", ' + web : web;
  }
  // 한글 자간(%)은 글자 폭 기준이다. 한글은 전각(1em), 숫자·영문은 대략 반각(0.5em)으로 보고 섞인 비율로 환산한다.
  function letterSpacingEm(spacing, text) {
    if (!spacing) return 0;
    let wide = 0, total = 0;
    for (const ch of text || '') { if (ch === ' ') continue; total++; if (/[\u1100-\u11FF\u3000-\u9FFF\uAC00-\uD7AF\uFF00-\uFFEF]/.test(ch)) wide++; }
    const ratio = total ? wide / total : 1;
    return (spacing / 100) * (ratio + (1 - ratio) * 0.5);
  }
  function applyChar(node, charId, text) {
    const cp = state.doc.header.charPr[charId];
    if (!cp) return;
    node.style.fontFamily = fontStack(cp);
    node.style.fontSize = (cp.size * PT2PX).toFixed(2) + 'px';
    node.style.color = cp.color;
    if (cp.bold) node.style.fontWeight = '700';
    if (cp.italic) node.style.fontStyle = 'italic';
    const deco = [cp.underline && 'underline', cp.strike && 'line-through'].filter(Boolean).join(' ');
    if (deco) node.style.textDecoration = deco;
    if (cp.shade) node.style.backgroundColor = cp.shade;
    if (cp.spacing) node.style.letterSpacing = letterSpacingEm(cp.spacing, text !== undefined ? text : node.textContent).toFixed(3) + 'em';
  }
  const ALIGN = { LEFT: 'left', RIGHT: 'right', CENTER: 'center', JUSTIFY: 'justify', DISTRIBUTE: 'justify', DISTRIBUTE_SPACE: 'justify' };
  function applyPara(node, paraId, charId) {
    const pp = state.doc.header.paraPr[paraId];
    if (!pp) return;
    node.style.textAlign = ALIGN[pp.align] || 'left';
    if (pp.align === 'DISTRIBUTE' || pp.align === 'DISTRIBUTE_SPACE') node.style.textAlignLast = 'justify';
    if (pp.left) node.style.marginLeft = PX(pp.left) + 'px';
    if (pp.right) node.style.marginRight = PX(pp.right) + 'px';
    if (pp.indent) node.style.textIndent = PX(pp.indent) + 'px';
    if (pp.prev) node.style.marginTop = PX(pp.prev) + 'px';
    if (pp.next) node.style.marginBottom = PX(pp.next) + 'px';
    const cp = state.doc.header.charPr[charId];
    if (pp.lineType === 'PERCENT') node.style.lineHeight = String(pp.lineValue / 100);
    else if (cp && pp.lineValue) node.style.lineHeight = Math.max(cp.size * PT2PX, PX(pp.lineValue)) + 'px';
  }
  const BORDER = { SOLID: 'solid', DASH: 'dashed', LONG_DASH: 'dashed', DASH_DOT: 'dashed', DASH_DOT_DOT: 'dashed', DOT: 'dotted', CIRCLE: 'dotted', DOUBLE_SLIM: 'double', SLIM_THICK: 'double', THICK_SLIM: 'double', SLIM_THICK_SLIM: 'double', WAVE: 'solid', DOUBLE_WAVE: 'double' };
  function borderCss(b) {
    if (!b || b.type === 'NONE') return 'none';
    const mm = parseFloat(b.width) || 0.12;
    let px = Math.max(1, Math.round(mm * (96 / 25.4) * 2) / 2);
    const style = BORDER[b.type] || 'solid';
    if (style === 'double') px = Math.max(3, px);
    return px + 'px ' + style + ' ' + (b.color || '#000');
  }

  /* ---------- 그리기 ---------- */
  function renderParas(container, unit) {
    container.textContent = '';
    const models = unit ? E.currentModels(unit) : [];
    for (const m of models) {
      const p = el('div', 'hw-para');
      applyPara(p, m.paraPr, m.primary);
      applyChar(p, m.primary);
      const runs = m.runs.length ? m.runs : [{ charPr: m.primary, text: '' }];
      let any = false;
      for (const r of runs) {
        if (!r.text) continue;
        const s = el('span', null, r.text);
        applyChar(s, r.charPr, r.text);
        p.appendChild(s);
        any = true;
      }
      if (!any) p.appendChild(document.createTextNode('​'));
      container.appendChild(p);
    }
  }

  function registerUnit(unit, node) {
    node.classList.add('unit');
    node.dataset.unit = unit.id;
    if (unit.editable) {
      node.classList.add('editable');
      node.tabIndex = 0;
      node.setAttribute('role', 'textbox');
      node.setAttribute('aria-multiline', 'true');
    } else {
      node.classList.add('locked');
      node.title = '이 칸은 그림이나 특별한 기능이 들어 있어서 여기서는 고칠 수 없어요. 저장해도 원래 모습 그대로예요.';
    }
    state.unitEls.set(unit.id, { unit, el: node });
    refreshUnitState(unit);
  }

  function renderBlocks(container, blocks) {
    for (const b of blocks) {
      if (b.type === 'table') container.appendChild(renderTable(b));
      else if (b.type === 'text') {
        const box = el('div', 'hw-body');
        renderParas(box, b.unit);
        registerUnit(b.unit, box);
        container.appendChild(box);
      } else if (b.type === 'readonly') {
        const p = el('div', 'hw-para hw-readonly', b.text);
        applyPara(p, b.model.paraPr, b.model.primary);
        applyChar(p, b.model.primary);
        container.appendChild(p);
      } else if (b.type === 'object') {
        const names = { pic: '그림', container: '묶음 개체', rect: '사각형', ellipse: '타원', equation: '수식', ole: 'OLE 개체' };
        container.appendChild(el('div', 'hw-object', '[' + (names[b.kind] || b.kind) + '은(는) 원래 모습 그대로 둬요]'));
      }
    }
  }

  function renderTable(t) {
    const table = el('table', 'hw-table');
    table.style.width = PX(t.width || t.colWidths.reduce((a, b) => a + b, 0)) + 'px';
    const cg = el('colgroup');
    for (const w of t.colWidths) { const c = el('col'); c.style.width = PX(w) + 'px'; cg.appendChild(c); }
    table.appendChild(cg);
    const tbody = el('tbody');
    const bf = state.doc.header.borderFill;
    const firstCols = t.rows.flat().filter((c) => c.col === 0);
    const rowLabel = (r) => {
      const c = firstCols.find((x) => r >= x.row && r < x.row + x.rowSpan);
      return c ? c.unit.origLines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 12) : '';
    };
    t.rows.forEach((row, ri) => {
      const tr = el('tr');
      const rIndex = row.length ? row[0].row : ri;
      if (t.rowHeights[rIndex]) tr.style.height = PX(t.rowHeights[rIndex]) + 'px';
      for (const c of row) {
        const td = el('td');
        if (c.colSpan > 1) td.colSpan = c.colSpan;
        if (c.rowSpan > 1) td.rowSpan = c.rowSpan;
        const f = bf[c.borderFill] || {};
        td.style.borderLeft = borderCss(f.left);
        td.style.borderRight = borderCss(f.right);
        td.style.borderTop = borderCss(f.top);
        td.style.borderBottom = borderCss(f.bottom);
        if (f.fill) td.style.backgroundColor = f.fill;
        td.style.verticalAlign = c.vertAlign === 'TOP' ? 'top' : c.vertAlign === 'BOTTOM' ? 'bottom' : 'middle';
        td.style.padding = [c.margin.top, c.margin.right, c.margin.bottom, c.margin.left].map((v) => PX(v) + 'px').join(' ');
        td.dataset.where = (c.row + 1) + '행 ' + (c.col + 1) + '열';
        td.dataset.label = c.col === 0 ? '' : rowLabel(c.row);
        td.dataset.table = String(t.index);
        if (c.blocks.length) renderBlocks(td, c.blocks);
        else renderParas(td, c.unit);
        registerUnit(c.unit, td);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function renderDocument() {
    const doc = state.doc;
    const pages = $('pages');
    pages.textContent = '';
    state.unitEls.clear();
    doc.sections.forEach((s, i) => {
      if (doc.sections.length > 1) pages.appendChild(el('div', 'page-label', '구역 ' + (i + 1)));
      const page = el('div', 'page');
      const pg = s.page || { width: 59528, height: 84188, left: 5669, right: 5669, top: 4252, bottom: 4252 };
      page.style.width = PX(pg.width) + 'px';
      page.style.minHeight = PX(pg.height) + 'px';
      page.style.padding = [pg.top, pg.right, pg.bottom, pg.left].map((v) => PX(v) + 'px').join(' ');
      page.style.zoom = String(state.zoom);
      renderBlocks(page, s.blocks);
      pages.appendChild(page);
    });
    $('dropzone').hidden = true;
    $('workspace').hidden = false;
    $('topActions').hidden = false;
    state.userZoom = false;
    fitZoom();
    updateSummary();
  }

  /* ---------- 상태 표시 ---------- */
  function allUnits() {
    return state.doc ? state.doc.sections.flatMap((s) => s.units) : [];
  }
  function refreshUnitState(unit) {
    const entry = state.unitEls.get(unit.id);
    if (entry) entry.el.classList.toggle('is-changed', E.unitChanged(unit));
  }
  function updateSummary() {
    const units = allUnits();
    const cells = units.filter((u) => u.kind === 'cell');
    const changed = units.filter((u) => u.editable && E.unitChanged(u));
    $('statTables').textContent = state.doc.sections.reduce((a, s) => a + s.tableCount, 0);
    $('statCells').textContent = cells.length;
    $('statEditable').textContent = cells.filter((u) => u.editable).length;
    $('statChanged').textContent = changed.length;
    $('resetBtn').disabled = changed.length === 0;
    $('saveBtn').disabled = false;
    $('saveBtn2').disabled = false;
    refreshAiButton();

    const list = $('changes');
    list.textContent = '';
    $('changesEmpty').hidden = changed.length > 0;
    for (const u of changed) {
      const entry = state.unitEls.get(u.id);
      const li = el('li');
      const b = el('button');
      b.type = 'button';
      const isAuto = ai.aiUnits.has(u.id);
      b.appendChild(el('span', 'tag' + (isAuto ? ' auto' : ''), isAuto ? '자동' : '직접'));
      const what = el('span', 'what');
      const label = entry && entry.el.dataset.label;
      if (label) what.appendChild(el('b', null, label));
      what.appendChild(document.createTextNode(u.lines.join(' ').trim() || '(빈 칸)'));
      b.appendChild(what);
      b.title = '눌러서 일지에서 찾아보기';
      b.addEventListener('click', () => {
        if (!entry) return;
        entry.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        entry.el.classList.remove('flash'); void entry.el.offsetWidth; entry.el.classList.add('flash');
      });
      li.appendChild(b);
      list.appendChild(li);
    }
  }

  /* ---------- 편집 ---------- */
  function startEdit(unitId) {
    const entry = state.unitEls.get(unitId);
    if (!entry || !entry.unit.editable) return;
    if (state.editing) commitEdit();
    const { unit, el: node } = entry;
    const target = node;
    const models = E.currentModels(unit);
    const first = models[0] || { paraPr: '0', primary: '0' };
    const ta = el('textarea', 'cell-editor');
    ta.value = unit.lines.join('\n');
    ta.setAttribute('aria-label', (node.dataset.where || '문단') + ' 편집');
    applyPara(ta, first.paraPr, first.primary);
    applyChar(ta, first.primary);
    ta.style.marginLeft = ta.style.marginRight = ta.style.marginTop = ta.style.marginBottom = '0';
    ta.style.textIndent = '0';
    const h = target.getBoundingClientRect().height / state.zoom;
    target.textContent = '';
    target.appendChild(ta);
    target.classList.add('is-editing');
    state.editing = { unit, el: target, textarea: ta, before: unit.lines.slice() };
    const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    ta.style.minHeight = Math.max(0, h - 4) + 'px';
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', onEditorKey);
    ta.addEventListener('blur', () => { if (state.editing && state.editing.textarea === ta) commitEdit(); });
    grow();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function finishEdit(lines) {
    const ed = state.editing;
    if (!ed) return;
    state.editing = null;
    ed.unit.lines = lines;
    ed.el.classList.remove('is-editing');
    if (ed.el.tagName === 'TD' || ed.el.classList.contains('hw-body')) renderParas(ed.el, ed.unit);
    refreshUnitState(ed.unit);
    updateSummary();
    $('report').hidden = true;
  }
  function commitEdit() {
    const ed = state.editing;
    if (!ed) return;
    const lines = ed.textarea.value.replace(/\r\n?/g, '\n').split('\n').map(E.cleanText);
    finishEdit(lines);
  }
  function cancelEdit() {
    const ed = state.editing;
    if (ed) finishEdit(ed.before);
  }

  function editableOrder() {
    return Array.from(document.querySelectorAll('.unit.editable'));
  }
  function onEditorKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      const node = state.editing && state.editing.el;
      cancelEdit();
      if (node) node.focus();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const node = state.editing.el;
      commitEdit();
      const order = editableOrder();
      const i = order.indexOf(node);
      const next = order[i + (e.shiftKey ? -1 : 1)];
      if (next) startEdit(next.dataset.unit);
    }
  }

  // 편집 중인 칸 밖을 누르면 바로 확정한다.
  document.addEventListener('pointerdown', (e) => {
    if (state.editing && !state.editing.el.contains(e.target)) commitEdit();
  }, true);
  document.addEventListener('click', (e) => {
    const node = e.target.closest && e.target.closest('.unit.editable');
    if (!node || (state.editing && state.editing.el === node)) return;
    // 중첩 표: 가장 안쪽 칸만
    startEdit(node.dataset.unit);
  });
  document.addEventListener('keydown', (e) => {
    if (state.editing) return;
    const node = document.activeElement;
    if (node && node.classList && node.classList.contains('editable') && (e.key === 'Enter' || e.key === 'F2')) {
      e.preventDefault();
      startEdit(node.dataset.unit);
    }
  });

  $('resetBtn').addEventListener('click', () => {
    if (state.editing) cancelEdit();
    for (const u of allUnits()) {
      if (!E.unitChanged(u)) continue;
      u.lines = u.origLines.slice();
      const entry = state.unitEls.get(u.id);
      if (entry && !entry.el.querySelector('table')) renderParas(entry.el, u);
      refreshUnitState(u);
    }
    clearAiMarks();
    updateSummary();
    $('report').hidden = true;
    toast('처음 열었을 때 모습으로 되돌렸어요.');
  });

  /* ---------- 확대/축소 ---------- */
  function setZoom(z) {
    state.zoom = Math.min(2, Math.max(0.5, Math.round(z * 100) / 100));
    $('zoomValue').textContent = Math.round(state.zoom * 100) + '%';
    document.querySelectorAll('.page').forEach((p) => (p.style.zoom = String(state.zoom)));
  }
  // 일지 종이가 화면 폭에 딱 맞게 크기를 정한다.
  function fitZoom() {
    if (!state.doc || state.userZoom) return;
    const box = $('docScroller');
    const page = document.querySelector('.page');
    if (!box || !page || !box.clientWidth) return;
    const pageW = page.offsetWidth; // zoom 적용 전 폭
    setZoom(Math.min(1.4, (box.clientWidth - 12) / pageW));
  }
  window.addEventListener('resize', () => fitZoom());
  $('zoomIn').addEventListener('click', () => { state.userZoom = true; setZoom(state.zoom + 0.1); });
  $('zoomOut').addEventListener('click', () => { state.userZoom = true; setZoom(state.zoom - 0.1); });

  /* ---------- 파일 열기 ---------- */
  async function openArrayBuffer(buf, fileName) {
    const bytes = new Uint8Array(buf);
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
      throw new Error('예전 한글 파일(.hwp)이에요. 한글에서 "다른 이름으로 저장"을 눌러 파일 형식을 HWPX로 바꾼 뒤 열어 주세요.');
    }
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new Error('한글 파일(.hwpx)이 아니에요. 한글에서 저장한 .hwpx 파일을 열어 주세요.');
    const zip = await JSZip.loadAsync(buf);
    const order = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    const mt = zip.file('mimetype');
    const mime = mt ? (await mt.async('string')).trim() : '';
    if (mime && mime !== 'application/hwp+zip') throw new Error('한글 파일(.hwpx)이 아니에요. 한글에서 저장한 .hwpx 파일을 열어 주세요.');
    if (!zip.file('Contents/header.xml')) throw new Error('파일이 손상된 것 같아요. 한글에서 다시 저장한 뒤 열어 주세요.');
    const manifest = zip.file('META-INF/manifest.xml');
    if (manifest && /encryption-data/i.test(await manifest.async('string'))) throw new Error('암호가 걸린 파일이에요. 한글에서 암호를 푼 뒤 열어 주세요.');

    const dec = new TextDecoder('utf-8', { ignoreBOM: true });
    const header = E.parseHeader(dec.decode(await zip.file('Contents/header.xml').async('uint8array')));
    const hpf = zip.file('Contents/content.hpf');
    const sectionPaths = E.sectionPathsFromManifest(hpf ? await hpf.async('string') : '', order);
    if (!sectionPaths.length) throw new Error('파일 안에서 일지 내용을 찾지 못했어요. 한글에서 다시 저장한 뒤 열어 주세요.');
    const sections = [];
    for (let i = 0; i < sectionPaths.length; i++) {
      const f = zip.file(sectionPaths[i]);
      if (!f) throw new Error('파일이 손상된 것 같아요. 한글에서 다시 저장한 뒤 열어 주세요.');
      sections.push(E.parseSection(dec.decode(await f.async('uint8array')), i));
    }
    let previewUrl = null;
    const prv = zip.file('Preview/PrvImage.png');
    if (prv) previewUrl = URL.createObjectURL(new Blob([await prv.async('uint8array')], { type: 'image/png' }));

    if (state.doc && state.doc.previewUrl) URL.revokeObjectURL(state.doc.previewUrl);
    state.doc = { fileName, zip, order, header, sectionPaths, sections, previewUrl };
    state.editing = null;
    $('fileName').textContent = fileName;
    $('fileName').title = fileName;
    $('previewImg').hidden = !previewUrl;
    $('previewEmpty').hidden = !!previewUrl;
    if (previewUrl) $('previewImg').src = previewUrl;
    else $('previewEmpty').textContent = '한글이 저장한 미리보기 이미지가 없어요.';
    $('report').hidden = true;
    clearAiMarks();
    renderDocument();
  }

  async function openFile(file) {
    if (!file) return;
    try {
      await openArrayBuffer(await file.arrayBuffer(), file.name);
      toast('일지를 열었어요. 오른쪽에 이번 주 메모를 적어 주세요.');
    } catch (err) {
      console.error(err);
      toast(err.message || String(err), true);
    }
  }
  $('fileInput').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });

  const dz = $('dropzone');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dz.classList.add('is-over'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dz.classList.remove('is-over'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; dz.classList.remove('is-over');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) openFile(f);
  });

  /* ---------- 저장 ---------- */
  function linesegMode() { return $('linesegKeep').checked ? 'keep' : 'strip'; }

  async function exportBlob() {
    if (state.editing) commitEdit();
    const doc = state.doc;
    const out = new JSZip();
    const enc = new TextEncoder();
    const report = { files: [], paragraphs: 0, units: 0 };
    for (const name of doc.order) {
      const entry = doc.zip.files[name];
      let data;
      const si = doc.sectionPaths.indexOf(name);
      if (si >= 0) {
        const r = E.serializeSection(doc.sections[si], { lineseg: linesegMode() });
        if (r.changed) {
          const parsed = new DOMParser().parseFromString(r.xml, 'application/xml');
          if (parsed.getElementsByTagName('parsererror').length) throw new Error('파일을 만드는 중에 문제가 생겨서 저장을 멈췄어요. 원본 파일은 그대로예요.');
          data = enc.encode(r.xml);
          report.files.push(name);
          report.paragraphs += r.rewritten;
          report.units += r.splices.length;
        }
      }
      if (!data) data = await entry.async('uint8array');
      const store = name === 'mimetype' || /\.(png|jpe?g|gif|bmp)$/i.test(name);
      out.file(name, data, { compression: store ? 'STORE' : 'DEFLATE', date: entry.date, createFolders: false, binary: true });
    }
    const blob = await out.generateAsync({ type: 'blob', mimeType: 'application/hwp+zip', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    return { blob, report };
  }

  function baseName() {
    return (state.doc.fileName || '문서.hwpx').replace(/\.hwpx$/i, '') + '_편집';
  }

  const inArtifact = !!(window.claude && typeof window.claude.use === 'function');
  let downloadsApi = null;
  if (inArtifact) {
    $('zipNote').hidden = false;
    window.claude.use('downloads').then((d) => { downloadsApi = d; }).catch(() => {});
  }

  async function doSave() {
    const btns = [$('saveBtn'), $('saveBtn2')];
    btns.forEach((b) => (b.disabled = true));
    try {
      const { blob, report } = await exportBlob();
      const rep = $('report');
      rep.textContent = report.files.length
        ? '다시 쓴 파일: ' + report.files.join(', ') + '\n바뀐 칸 ' + report.units + '곳, 다시 쓴 문단 ' + report.paragraphs + '개\n나머지 파일과 문단은 원본 그대로입니다.'
        : '바뀐 칸이 없어 원본과 같은 내용으로 저장했습니다.';
      rep.hidden = false;
      if (inArtifact) {
        if (!downloadsApi) downloadsApi = await window.claude.use('downloads');
        if (!downloadsApi) throw new Error('이 화면에서는 파일을 저장할 수 없어요.');
        try {
          await downloadsApi.save({ filename: baseName() + '.hwpx.zip', data: blob });
          toast('저장했어요. 파일 이름 끝의 .zip을 지우고 한글에서 열어 보세요.');
        } catch (err) {
          if (err && err.code === 'declined') toast('저장을 취소했어요.');
          else throw new Error('저장하지 못했어요. 다시 한번 눌러 주세요.');
        }
      } else {
        const url = URL.createObjectURL(blob);
        const a = el('a');
        a.href = url; a.download = baseName() + '.hwpx';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast('저장했어요. 내려받은 파일을 한글에서 열어 보세요.');
      }
    } catch (err) {
      console.error(err);
      toast(err.message || String(err), true);
    } finally {
      btns.forEach((b) => (b.disabled = !state.doc));
    }
  }
  $('saveBtn').addEventListener('click', doSave);
  $('saveBtn2').addEventListener('click', doSave);

  /* ---------- 이번 주 일지 자동으로 채우기 ---------- */
  const ai = { mode: 'off', needsCode: false, ackNoNames: false, snapshot: null, aiUnits: new Set(), busy: false };
  const NAMES_KEY = 'kissay.childNames';
  function refreshNamesCount() {
    const k = NameMask.parseNames($('aiNames').value).length;
    const c = $('namesCount');
    c.textContent = k ? k + '명 가림' : '이름 없음';
    c.classList.toggle('empty', !k);
  }
  try { $('aiNames').value = localStorage.getItem(NAMES_KEY) || ''; } catch (e) { /* 저장소를 못 쓰는 브라우저 */ }
  if (!$('aiNames').value.trim()) $('namesBox').open = true;
  refreshNamesCount();
  $('aiNames').addEventListener('input', () => {
    ai.ackNoNames = false; $('aiWarn').hidden = true;
    refreshNamesCount();
    try { localStorage.setItem(NAMES_KEY, $('aiNames').value); } catch (e) { /* 무시 */ }
  });

  function setAiState(mode, reason) {
    ai.mode = mode;
    $('aiState').textContent = { api: '켜짐', mock: '연습 모드', off: '꺼짐' }[mode] || '꺼짐';
    $('aiState').title = reason || '';
    const friendly = mode === 'mock' ? '지금은 연습 모드예요. 글을 새로 쓰지 않고 예시만 넣어요.'
      : mode === 'off' ? reason : '';
    $('aiReason').textContent = friendly || '';
    $('aiReason').hidden = !friendly;
    refreshAiButton();
  }
  function refreshAiButton() {
    $('aiRun').disabled = ai.busy || !state.doc || ai.mode === 'off';
  }

  async function loadAiStatus() {
    if (inArtifact) {
      setAiState('off', '이 화면에서는 자동으로 채우기를 쓸 수 없어요. 일지 도우미를 켠 컴퓨터의 주소로 들어와 주세요. 칸을 직접 고치고 저장하는 건 그대로 할 수 있어요.');
      return;
    }
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      if (r.status === 404) {
        // 서버 없이 화면만 올린 곳(GitHub Pages 등)
        setAiState('off', '이 주소에서는 자동으로 채우기를 쓸 수 없어요. 칸을 직접 고치고 한글 파일로 저장하는 건 그대로 할 수 있어요.');
        return;
      }
      if (!r.ok) throw new Error();
      const s = await r.json();
      ai.needsCode = !!s.needsCode;
      $('aiCodeField').hidden = !ai.needsCode;
      setAiState(s.mode, s.mode === 'off' ? '자동으로 채우기 준비가 아직 안 됐어요. 일지 도우미를 설치한 분께 알려 주세요. 칸을 직접 고치고 저장하는 건 그대로 할 수 있어요.' : s.reason);
    } catch (e) {
      setAiState('off', '일지 도우미와 연결되지 않았어요. 잠시 뒤 새로고침해 주세요. 칸을 직접 고치고 저장하는 건 그대로 할 수 있어요.');
    }
  }

  function clearAiMarks() {
    ai.aiUnits = new Set();
    ai.snapshot = null;
    document.querySelectorAll('.unit.is-ai').forEach((n) => n.classList.remove('is-ai'));
    $('aiUndo').hidden = true;
    $('aiResult').hidden = true;
  }

  function unitById() {
    const m = new Map();
    for (const u of allUnits()) m.set(u.id, u);
    return m;
  }

  function buildForm(masker) {
    const cells = [];
    for (const u of allUnits()) {
      if (u.kind !== 'cell' && u.kind !== 'body') continue;
      if (u.kind === 'cell' && !u.editable && !u.lines.join('').trim()) continue;
      cells.push({
        id: u.id,
        row: u.row || 0, col: u.col || 0, rowSpan: u.rowSpan || 1, colSpan: u.colSpan || 1,
        editable: !!u.editable,
        lines: u.lines.map((l) => masker.mask(l)),
      });
    }
    return { cells };
  }

  function rerenderUnit(u) {
    const entry = state.unitEls.get(u.id);
    if (!entry) return;
    entry.el.classList.toggle('is-ai', ai.aiUnits.has(u.id));
    if (!entry.el.querySelector('table')) renderParas(entry.el, u);
    refreshUnitState(u);
  }

  async function runAi() {
    if (!state.doc || ai.busy) return;
    if (state.editing) commitEdit();
    const memo = $('aiMemo').value.trim();
    if (!memo) { toast('이번 주 메모를 먼저 적어 주세요.', true); $('aiMemo').focus(); return; }
    if (ai.needsCode && !/^\d{6}$/.test($('aiCode').value.trim())) { toast('연결 번호 6자리를 넣어 주세요.', true); $('aiCode').focus(); return; }
    const names = NameMask.parseNames($('aiNames').value);
    if (!names.length && !ai.ackNoNames) { ai.ackNoNames = true; $('aiWarn').hidden = false; $('namesBox').open = true; return; }
    $('aiWarn').hidden = true;

    const corpus = allUnits().map((u) => u.lines.join('\n')).join('\n') + '\n' + memo;
    const masker = NameMask.createMasker(names, corpus);
    const payload = { form: buildForm(masker), memo: masker.mask(memo) };
    const headers = { 'Content-Type': 'application/json' };
    if (ai.needsCode) headers['X-Access-Code'] = $('aiCode').value.trim();

    ai.busy = true; refreshAiButton();
    const btn = $('aiRun');
    const started = Date.now();
    const tick = setInterval(() => { btn.textContent = '일지를 채우고 있어요… ' + Math.round((Date.now() - started) / 1000) + '초'; }, 500);
    btn.textContent = '일지를 채우고 있어요…';
    $('aiProgress').hidden = false;
    try {
      const r = await fetch('/api/draft', { method: 'POST', headers, body: JSON.stringify(payload) });
      let data = null;
      try { data = await r.json(); } catch (e) { /* 아래에서 처리 */ }
      if (!r.ok || !data) throw new Error((data && data.error) || '채우지 못했어요. 잠시 뒤 다시 눌러 주세요.');

      // 되돌릴 수 있게 현재 상태를 저장한 뒤 결과를 넣는다.
      const units = unitById();
      ai.snapshot = new Map(allUnits().map((u) => [u.id, u.lines.slice()]));
      const prevAi = new Set(ai.aiUnits);
      ai.aiUnits = new Set();
      let applied = 0;
      for (const c of data.cells || []) {
        const u = units.get(c.id);
        if (!u || !u.editable) continue;
        u.lines = (c.lines || []).map((l) => E.cleanText(masker.unmask(l)));
        if (!u.lines.length) u.lines = [''];
        ai.aiUnits.add(u.id);
        applied++;
      }
      for (const id of new Set([...prevAi, ...ai.aiUnits])) { const u = units.get(id); if (u) rerenderUnit(u); }
      updateSummary();
      $('report').hidden = true;

      const notes = (data.notes || []).map((n) => masker.unmask(n));
      $('aiSummary').textContent = applied
        ? applied + '곳을 채웠어요. 노란 점선 칸을 읽어 보고, 고칠 곳은 칸을 눌러 고쳐 주세요.'
        : '채울 곳을 찾지 못했어요. 메모를 조금 더 자세히 적어 주세요.';
      const list = $('aiNotes');
      list.textContent = '';
      for (const n of notes) list.appendChild(el('li', null, n));
      $('aiResult').hidden = false;
      $('aiUndo').hidden = !applied;
      toast(applied ? '다 채웠어요. 저장하기 전에 한 번 읽어 봐 주세요.' : '바뀐 곳이 없어요.');
    } catch (err) {
      console.error(err);
      toast(err.message || String(err), true);
    } finally {
      clearInterval(tick);
      $('aiProgress').hidden = true;
      btn.textContent = '이번 주 일지 채우기';
      ai.busy = false; refreshAiButton();
    }
  }

  function undoAi() {
    if (!ai.snapshot) return;
    if (state.editing) cancelEdit();
    const ids = new Set(ai.aiUnits);
    for (const u of allUnits()) {
      const prev = ai.snapshot.get(u.id);
      if (prev && ids.has(u.id)) u.lines = prev.slice();
    }
    ai.aiUnits = new Set();
    const units = unitById();
    for (const id of ids) { const u = units.get(id); if (u) rerenderUnit(u); }
    ai.snapshot = null;
    updateSummary();
    $('aiUndo').hidden = true;
    $('aiResult').hidden = true;
    toast('채운 내용을 되돌렸어요.');
  }

  $('aiRun').addEventListener('click', runAi);
  $('aiUndo').addEventListener('click', undoAi);
  loadAiStatus();

  /* ---------- 개발용: ?dev 패널, 로컬 서버의 샘플 자동 열기, 검증용 훅 ---------- */
  if (/[?&]dev\b/.test(location.search)) $('devTools').hidden = false;
  window.__hwpxApp = { state, openArrayBuffer, exportBlob, startEdit, commitEdit };
  if (!inArtifact && /[?&]sample\b/.test(location.search)) {
    fetch('/__sample.hwpx').then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('샘플 없음'))))
      .then((b) => openArrayBuffer(b, decodeURIComponent((location.search.match(/name=([^&]+)/) || [])[1] || 'sample.hwpx')))
      .catch((e) => toast(e.message, true));
  }
})();
