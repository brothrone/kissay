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
    let bytes = new Uint8Array(buf);
    let converted = null;
    if (HwpConvert.isOldHwp(bytes)) {
      // 예전 한글 파일(.hwp)은 브라우저 안에서 HWPX로 바꾼 뒤 연다(파일은 어디로도 보내지 않음).
      toast('예전 한글 파일(.hwp)이라 hwpx로 바꾸고 있어요… 처음 한 번은 조금 걸려요.');
      converted = await HwpConvert.toHwpx(buf, fileName);
      buf = converted.bytes;
      bytes = new Uint8Array(buf);
      fileName = fileName.replace(/\.hwp$/i, '') + '.hwpx';
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
    return { converted };
  }

  async function openFile(file) {
    if (!file) return;
    try {
      const { converted } = await openArrayBuffer(await file.arrayBuffer(), file.name);
      if (converted) {
        const lossNote = converted.loss.length ? ' 바꾸면서 모양이 조금 달라질 수 있는 곳이 ' + converted.loss.length + '군데 있어요. 저장한 뒤 한글에서 한 번 확인해 주세요.' : '';
        const lockNote = converted.unlocked ? ' 저장한 파일에는 암호가 걸리지 않아요.' : '';
        toast('예전 한글 파일을 hwpx로 바꿔서 열었어요. 저장하면 hwpx 파일로 저장돼요.' + lossNote + lockNote);
      } else {
        toast('일지를 열었어요. 오른쪽에 이번 주 메모를 적어 주세요.');
      }
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
  const ai = { mode: 'off', reason: '', needsCode: false, trial: null, remote: null, ackNoNames: false, snapshot: null, aiUnits: new Set(), busy: false };
  const NAMES_KEY = 'kissay.childNames';
  function refreshNamesCount() {
    const names = NameMask.parseNames($('aiNames').value);
    const c = $('namesCount');
    c.textContent = names.length ? names.length + '명' : '이름 없음';
    c.classList.toggle('empty', !names.length);
    renderKidList(names);
  }
  // 메모장 이름표: 이번 주 평가 아이면 요일을 붙인다. 누르면 지금 쓰는 칸에 이름이 들어간다.
  function renderKidList(names) {
    const list = $('kidList');
    if (!list) return;
    list.textContent = '';
    $('kidEmpty').hidden = names.length > 0;
    let dayOf = {};
    try {
      const cur = (typeof featured !== 'undefined' && featured[weekKey()]) || {};
      for (const d of Object.keys(cur)) if (cur[d]) dayOf[cur[d]] = (dayOf[cur[d]] || '') + d;
    } catch (e) { dayOf = {}; }
    for (const n of names) {
      const li = el('li');
      const b = el('button', null, n);
      b.type = 'button';
      b.title = '눌러서 지금 쓰는 칸에 넣기';
      if (dayOf[n]) b.appendChild(el('i', null, dayOf[n]));
      b.addEventListener('mousedown', (e) => e.preventDefault()); // 쓰던 칸의 커서를 잃지 않게
      b.addEventListener('click', () => insertName(n));
      li.appendChild(b);
      list.appendChild(li);
    }
  }
  const NAME_TARGETS = '.day input, #aiMemo, #chatInput, .cell-editor';
  let lastTextField = null;
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t && t.matches && t.matches(NAME_TARGETS)) lastTextField = t;
  });
  function insertName(name) {
    const active = document.activeElement;
    let t = active && active.matches && active.matches(NAME_TARGETS) ? active
      : (lastTextField && document.body.contains(lastTextField) ? lastTextField : null);
    if (!t) t = !$('paneChat').hidden ? $('chatInput') : document.querySelector('.day .kid');
    if (!t) return;
    const start = t.selectionStart != null ? t.selectionStart : t.value.length;
    const end = t.selectionEnd != null ? t.selectionEnd : t.value.length;
    t.value = t.value.slice(0, start) + name + t.value.slice(end);
    t.focus();
    const pos = start + name.length;
    try { t.setSelectionRange(pos, pos); } catch (e) { /* 일부 입력칸은 지원 안 함 */ }
    t.dispatchEvent(new Event('input', { bubbles: true }));
  }
  try { $('aiNames').value = localStorage.getItem(NAMES_KEY) || ''; } catch (e) { /* 저장소를 못 쓰는 브라우저 */ }
  if (!$('aiNames').value.trim()) $('namesBox').open = true;
  refreshNamesCount();
  $('aiNames').addEventListener('input', () => {
    ai.ackNoNames = false; $('aiWarn').hidden = true;
    refreshNamesCount();
    try { localStorage.setItem(NAMES_KEY, $('aiNames').value); } catch (e) { /* 무시 */ }
    renderDays();
  });

  function setAiState(mode, reason) {
    ai.mode = mode;
    ai.reason = reason || '';
    $('aiState').textContent = { api: '켜짐', mock: '연습 모드', off: '꺼짐' }[mode] || '꺼짐';
    $('aiState').title = ai.reason;
    renderUsage();
  }
  /* 어디로 보낼지
     - 'server': 이 화면을 띄운 일지 도우미 서버(serve.py, 서버 주인의 키)
     - 'trial' : 무료체험 서버(하루 횟수 제한)
     - 'direct': 내 API 키로 브라우저에서 바로
     선생님이 고른 쪽(무료체험/내 API 키)을 따르고, 고를 수 없으면 가능한 쪽으로 간다. */
  const TRIAL_API_DEFAULT = 'https://api.essay.win/v1/trial/journal';
  // 개발용: 이 컴퓨터(localhost)에서 열었을 때만 ?trialApi= 로 다른 체험 서버를 시험할 수 있다.
  const TRIAL_API = (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).get('trialApi')) || TRIAL_API_DEFAULT;
  const MODE_KEY = 'kissay.useMode';
  function getPref() { try { return localStorage.getItem(MODE_KEY) || ''; } catch (e) { return ''; } }
  function setPref(v) { try { localStorage.setItem(MODE_KEY, v); } catch (e) { /* 무시 */ } }
  function sharedRoute() {
    if (ai.mode === 'api' || ai.mode === 'mock') return 'server';
    if (ai.remote && !inArtifact) return 'trial';
    return null;
  }
  function route() {
    const hasKey = !inArtifact && !!ClaudeDirect.getKey();
    const shared = sharedRoute();
    const pref = getPref() || (hasKey ? 'key' : 'shared');
    if (pref === 'key' && hasKey) return 'direct';
    if (shared) return shared;
    return hasKey ? 'direct' : null;
  }
  async function loadRemoteTrial() {
    ai.remote = null;
    if (inArtifact) return;
    try {
      const r = await fetch(TRIAL_API + '/status', { cache: 'no-store' });
      if (!r.ok) return;
      const s = await r.json();
      if (!s || typeof s !== 'object' || !('limit' in s)) return;
      ai.remote = { limit: s.limit, capped: !!s.capped };
      // limit 이 숫자가 아니면(null) 사람마다 횟수 제한이 없는 것이라 남은 횟수 줄을 보이지 않는다.
      ai.trial = typeof s.limit === 'number' ? { limit: s.limit, remaining: s.capped ? 0 : Math.max(0, +s.remaining || 0) } : null;
    } catch (e) { /* 체험 서버가 없거나 이 주소를 허용하지 않음: 내 API 키만 쓴다 */ }
  }
  function refreshAiButton() {
    $('aiRun').disabled = ai.busy || !state.doc || !route();
  }
  function openKeyBox() {
    if (inArtifact) return;
    $('keyBox').hidden = false;
    $('keyBox').open = true;
  }
  function renderUsage() {
    const r = route();
    const shared = sharedRoute();
    const sw = $('modeSwitch');
    sw.hidden = !shared || inArtifact;
    if (!sw.hidden) {
      $('modeShared').textContent = ai.trial ? '무료체험' : '일지 도우미';
      $('modeShared').classList.toggle('on', r === shared);
      $('modeKey').classList.toggle('on', r === 'direct');
      $('modeShared').setAttribute('aria-pressed', String(r === shared));
      $('modeKey').setAttribute('aria-pressed', String(r === 'direct'));
    }
    $('keyBox').hidden = inArtifact;
    $('keyClear').hidden = !ClaudeDirect.getKey();
    const u = $('usage');
    u.textContent = '';
    u.className = 'usage' + (r === 'direct' ? ' mine' : '');
    if (r === 'direct') {
      u.append(el('b', null, '내 API 키'), document.createTextNode('로 쓰고 있어요. 횟수 제한이 없어요.'));
      u.hidden = false;
    } else if ((r === 'server' || r === 'trial') && ai.trial) {
      if (ai.trial.remaining > 0) {
        u.append(document.createTextNode('오늘 무료체험 '), el('b', null, ai.trial.remaining + '/' + ai.trial.limit + '번'),
          document.createTextNode(' 남았어요. 다 쓰면 내 API 키로 계속 쓸 수 있어요.'));
      } else {
        u.append(document.createTextNode('오늘 무료체험 '), el('b', null, ai.trial.limit + '번'),
          document.createTextNode('을 다 썼어요. 내일 다시 쓰거나, 아래에 내 API 키를 넣으면 바로 이어서 쓸 수 있어요.'));
      }
      u.hidden = false;
      if (!ai.trial.remaining) openKeyBox();
    } else u.hidden = true;
    let msg = '';
    if (r === 'trial' && ai.remote && ai.remote.capped) msg = '오늘은 무료체험을 쓰는 분이 많아 마감됐어요. 내 API 키를 넣으면 바로 쓸 수 있어요.';
    else if (r === 'server' && ai.mode === 'mock') msg = '지금은 연습 모드예요. 글을 새로 쓰지 않고 예시만 넣어요.';
    else if (!r) {
      msg = inArtifact ? ai.reason : '아래 "내 API 키로 쓰기"에 키를 넣으면 이 주소에서도 자동으로 채울 수 있어요. 칸을 직접 고치고 저장하는 건 그대로 할 수 있어요.';
      if (!inArtifact) openKeyBox();
    }
    $('aiReason').textContent = msg;
    $('aiReason').hidden = !msg;
    $('chatPrivacy').textContent = r === 'direct'
      ? '부탁과 일지 글은 내 API 키로 Claude(Anthropic)에 바로 전달돼요. 아이 이름은 가려서 보내요.'
      : '부탁과 일지 글은 아이 이름을 가려서 전달돼요. 서버에는 남지 않아요.';
    $('privacy').textContent = r === 'direct'
      ? '채우기를 누르면 메모와 일지 글이 내 API 키로 Claude(Anthropic)에 바로 전달돼요. 아이 이름은 가려서 보내요.'
      : r === 'trial'
        ? '채우기를 누르면 메모와 일지 글이 무료체험 서버를 거쳐 Claude로 전달돼요. 서버에는 남지 않고, 아이 이름은 가려서 보내요.'
        : '채우기를 누르면 메모와 일지 글이 자동 작성 서비스로 전달돼요. 아이 이름은 가려서 보내요.';
    $('aiCodeField').hidden = !(ai.needsCode && r === 'server');
    refreshAiButton();
  }

  // 자동 채우기 호출(일지 채우기 'draft', 월안 정리 'plan')
  async function callAuto(kind, payload) {
    const r = route();
    if (r === 'direct') {
      const key = ClaudeDirect.getKey();
      if (kind === 'draft') return ClaudeDirect.draft(key, payload.form, payload.memo);
      if (kind === 'chat') return ClaudeDirect.chat(key, payload.form, payload.memo, payload.messages);
      return ClaudeDirect.readPlan(key, payload);
    }
    if (r === 'trial') {
      if (kind === 'plan' && (payload.files || []).length > 10) {
        throw new Error('무료체험에서는 월안 파일을 10개까지 올릴 수 있어요. 나눠서 올리거나 내 API 키를 써 주세요.');
      }
      let res;
      let data = null;
      try {
        res = await fetch(TRIAL_API + '/' + kind, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      } catch (e) {
        throw new Error('무료체험 서버에 연결하지 못했어요. 잠시 뒤 다시 해 주세요.');
      }
      try { data = await res.json(); } catch (e) { /* 아래에서 처리 */ }
      if (data && typeof data.remaining === 'number' && ai.trial) ai.trial.remaining = Math.max(0, data.remaining);
      if (res.status === 404 && kind === 'chat') {
        openKeyBox();
        throw new Error('부탁하기는 무료체험에서 곧 쓸 수 있어요. 지금은 내 API 키를 넣으면 바로 쓸 수 있어요.');
      }
      if (!res.ok || !data || data.ok === false) {
        if (data && (data.code === 'IP_LIMIT' || data.code === 'DAILY_CAP')) {
          if (ai.trial) ai.trial.remaining = 0;
          if (data.code === 'DAILY_CAP' && ai.remote) ai.remote.capped = true;
          openKeyBox();
        }
        renderUsage();
        throw new Error((data && data.error) || (kind === 'draft' ? '채우지 못했어요. 잠시 뒤 다시 눌러 주세요.' : '월안을 읽지 못했어요. 잠시 뒤 다시 해 주세요.'));
      }
      renderUsage();
      return data;
    }
    if (r !== 'server') {
      openKeyBox();
      throw new Error('API 키를 넣으면 바로 쓸 수 있어요.');
    }
    if (ai.needsCode && !/^\d{6}$/.test($('aiCode').value.trim())) {
      $('aiCode').focus();
      throw new Error('연결 번호 6자리를 넣어 주세요.');
    }
    const headers = { 'Content-Type': 'application/json' };
    if (ai.needsCode) headers['X-Access-Code'] = $('aiCode').value.trim();
    const res = await fetch('/api/' + kind, { method: 'POST', headers, body: JSON.stringify(payload) });
    let data = null;
    try { data = await res.json(); } catch (e) { /* 아래에서 처리 */ }
    if (data && data.trial) { ai.trial = data.trial; renderUsage(); }
    if (!res.ok || !data) {
      if (data && data.code === 'trial_used_up') openKeyBox();
      throw new Error((data && data.error) || (kind === 'draft' ? '채우지 못했어요. 잠시 뒤 다시 눌러 주세요.' : '월안을 읽지 못했어요. 잠시 뒤 다시 해 주세요.'));
    }
    return data;
  }

  $('keySave').addEventListener('click', () => {
    const v = $('apiKey').value.trim();
    if (!ClaudeDirect.looksLikeKey(v)) { toast('API 키는 sk-ant-로 시작해요. 다시 확인해 주세요.', true); return; }
    if (!ClaudeDirect.setKey(v)) { toast('이 브라우저에서는 키를 저장할 수 없어요.', true); return; }
    $('apiKey').value = '';
    $('keyBox').open = false;
    setPref('key');
    toast('키를 저장했어요. 이제 횟수 제한 없이 쓸 수 있어요.');
    renderUsage();
    ClaudeDirect.loadSdk().catch(() => {});
  });
  $('apiKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('keySave').click(); } });
  function chooseMode(mode) {
    setPref(mode);
    if (mode === 'key' && !ClaudeDirect.getKey()) { openKeyBox(); $('apiKey').focus(); }
    renderUsage();
  }
  $('modeShared').addEventListener('click', () => chooseMode('shared'));
  $('modeKey').addEventListener('click', () => chooseMode('key'));
  $('keyClear').addEventListener('click', () => {
    setPref('shared');
    ClaudeDirect.clearKey();
    toast('저장한 키를 지웠어요.');
    renderUsage();
  });

  async function loadAiStatus() {
    if (inArtifact) {
      setAiState('off', '이 화면에서는 자동으로 채우기를 쓸 수 없어요. 일지 도우미 주소로 들어와 주세요. 칸을 직접 고치고 저장하는 건 그대로 할 수 있어요.');
      return;
    }
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      if (r.status === 404) {
        // 서버 없이 화면만 올린 곳(GitHub Pages 등): 무료체험 서버를 확인한다
        await loadRemoteTrial();
        setAiState('off', '');
        return;
      }
      if (!r.ok) throw new Error();
      const s = await r.json();
      ai.needsCode = !!s.needsCode;
      ai.trial = s.trial || null;
      setAiState(s.mode, s.mode === 'off' ? '자동으로 채우기 준비가 아직 안 됐어요. 일지 도우미를 설치한 분께 알려 주세요. 칸을 직접 고치고 저장하는 건 그대로 할 수 있어요.' : s.reason);
    } catch (e) {
      await loadRemoteTrial();
      setAiState('off', '');
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
    const memo = composeMemo();
    if (!memo) { toast('월안을 불러오거나 요일별 활동을 적어 주세요.', true); return; }
    const names = NameMask.parseNames($('aiNames').value);
    if (!names.length && !ai.ackNoNames) { ai.ackNoNames = true; $('aiWarn').hidden = false; $('namesBox').open = true; return; }
    $('aiWarn').hidden = true;

    const corpus = allUnits().map((u) => u.lines.join('\n')).join('\n') + '\n' + memo;
    const masker = NameMask.createMasker(names, corpus);
    const payload = { form: buildForm(masker), memo: masker.mask(memo) };

    ai.busy = true; refreshAiButton();
    const btn = $('aiRun');
    const started = Date.now();
    const tick = setInterval(() => { btn.textContent = '일지를 채우고 있어요… ' + Math.round((Date.now() - started) / 1000) + '초'; }, 500);
    btn.textContent = '일지를 채우고 있어요…';
    $('aiProgress').hidden = false;
    try {
      const data = await callAuto('draft', payload);

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

  /* ---------- 월안(교육계획안) ---------- */
  const PLAN_KEY = 'kissay.plan';
  const DAYS = ['월', '화', '수', '목', '금'];
  const plan = { weeks: [], notes: [], index: 0, busy: false };
  let lastDayInput = null;

  function loadSavedPlan() {
    try {
      const v = JSON.parse(localStorage.getItem(PLAN_KEY) || 'null');
      if (v && Array.isArray(v.weeks) && v.weeks.length) { plan.weeks = v.weeks; plan.notes = Array.isArray(v.notes) ? v.notes : []; }
    } catch (e) { /* 저장소를 못 쓰는 브라우저 */ }
  }
  function savePlan() {
    try { localStorage.setItem(PLAN_KEY, JSON.stringify({ weeks: plan.weeks, notes: plan.notes, savedAt: Date.now() })); } catch (e) { /* 무시 */ }
  }
  function currentWeek() { return plan.weeks[plan.index] || null; }
  const md = (s) => { const x = /(\d+)\s*\.\s*(\d+)/.exec(s || ''); return x ? (+x[1]) * 100 + (+x[2]) : null; };

  // 오늘이 들어 있는 주, 없으면 다가오는 주를 고른다.
  function pickDefaultWeek() {
    const now = new Date();
    const today = (now.getMonth() + 1) * 100 + now.getDate();
    let idx = plan.weeks.findIndex((w) => { const a = md(w.start), b = md(w.end); return a != null && b != null && a <= today && today <= b + 2; });
    if (idx < 0) idx = plan.weeks.findIndex((w) => { const a = md(w.start); return a != null && a > today; });
    plan.index = idx < 0 ? 0 : idx;
  }

  function chip(text, cls, day) {
    const b = el('button', 'chip' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    b.title = '눌러서 활동 칸에 넣기';
    b.addEventListener('click', () => insertActivity(text, day));
    return b;
  }
  function insertActivity(text, day) {
    const input = day ? document.querySelector('.day[data-day="' + day + '"] .act') : (lastDayInput || document.querySelector('.day .act'));
    if (!input) return;
    const v = input.value.trim();
    input.value = v ? v + ', ' + text : text;
    input.focus();
    lastDayInput = input;
  }

  /* 평가 아이: 요일마다 겹치지 않게, 이전 주에 덜 나온 아이부터 */
  const FEATURED_KEY = 'kissay.featured'; // { 주 키: { 월: '민서', ... } }, '' = 반 전체
  let featured = {};
  try { featured = JSON.parse(localStorage.getItem(FEATURED_KEY) || '{}') || {}; } catch (e) { featured = {}; }
  function saveFeatured() { try { localStorage.setItem(FEATURED_KEY, JSON.stringify(featured)); } catch (e) { /* 무시 */ } }
  function weekKey() { const w = currentWeek(); return w ? w.label + '|' + (w.start || '') : 'manual'; }
  function classNames() { return NameMask.parseNames($('aiNames').value); }
  function usageCounts(exceptKey) {
    const c = {};
    for (const k of Object.keys(featured)) {
      if (k === exceptKey) continue;
      for (const n of Object.values(featured[k] || {})) if (n) c[n] = (c[n] || 0) + 1;
    }
    return c;
  }
  function byLeastUsed(names, counts) {
    return names.slice().sort((a, b) => (counts[a] || 0) - (counts[b] || 0) || names.indexOf(a) - names.indexOf(b));
  }
  function ensureAssignment() {
    const names = classNames();
    const key = weekKey();
    const cur = featured[key] = featured[key] || {};
    if (!names.length) return cur;
    const counts = usageCounts(key);
    const used = new Set(DAYS.map((d) => cur[d]).filter((n) => n && names.includes(n)));
    let changed = false;
    for (const day of DAYS) {
      if (cur[day] === '' || (cur[day] && names.includes(cur[day]))) continue;
      const pick = byLeastUsed(names.filter((n) => !used.has(n)), counts)[0] || '';
      cur[day] = pick;
      if (pick) used.add(pick);
      changed = true;
    }
    if (changed) saveFeatured();
    return cur;
  }
  function cycleKid(day) {
    const names = classNames();
    if (!names.length) { $('namesBox').open = true; toast('우리 반 아이 이름을 먼저 적어 주세요.'); return; }
    const key = weekKey();
    const cur = featured[key] = featured[key] || {};
    const others = new Set(DAYS.filter((d) => d !== day).map((d) => cur[d]).filter(Boolean));
    const options = [...byLeastUsed(names.filter((n) => !others.has(n)), usageCounts(key)), ''];
    const i = options.indexOf(cur[day] === undefined ? '' : cur[day]);
    cur[day] = options[(i + 1) % options.length];
    saveFeatured();
    renderDays();
    refreshNamesCount();
  }

  function renderDays() {
    const box = $('days');
    const prev = {};
    box.querySelectorAll('.day').forEach((d) => { prev[d.dataset.day] = { act: d.querySelector('.act').value, kid: d.querySelector('.kid').value }; });
    box.textContent = '';
    const w = currentWeek();
    const hasNames = classNames().length > 0;
    const assign = hasNames ? ensureAssignment() : {};
    DAYS.forEach((day, i) => {
      const info = w && (w.days || []).find((x) => x.day === day);
      const row = el('div', 'day');
      row.dataset.day = day;
      const head = el('div', 'day-head');
      head.appendChild(el('b', null, day));
      if (info && info.date) head.appendChild(el('span', null, info.date));
      const act = el('input', 'act');
      act.type = 'text';
      act.placeholder = i === 0 ? '오늘 한 활동 (예: 나사 돌리기, 블록수업 왕관)' : '오늘 한 활동';
      act.setAttribute('aria-label', day + '요일 활동');
      act.value = (prev[day] || {}).act || '';
      act.addEventListener('focus', () => { lastDayInput = act; });
      const kid = el('input', 'kid');
      kid.type = 'text';
      kid.placeholder = hasNames ? '평가 아이 모습 (선택) 예: 나사를 끝까지 돌려 뚜껑을 닫음' : '아이 모습 (선택) 예: 민서 - 나사를 끝까지 돌림';
      kid.setAttribute('aria-label', day + '요일 아이 모습');
      kid.value = (prev[day] || {}).kid || '';
      row.append(head, act);
      const items = info ? (info.items || []).filter((it) => it.activity && it.activity.trim() && it.activity.trim() !== '*') : [];
      if (items.length || hasNames) {
        const cr = el('div', 'chip-row');
        if (hasNames) {
          const who = assign[day] || '';
          const pick = el('button', 'kid-pick' + (who ? '' : ' none'));
          pick.type = 'button';
          pick.title = '눌러서 다른 아이로 바꾸기';
          pick.setAttribute('aria-label', day + '요일 평가 아이: ' + (who || '반 전체') + '. 눌러서 바꾸기');
          pick.append(document.createTextNode('평가 아이'), el('b', null, who || '반 전체'), document.createTextNode('↻'));
          pick.addEventListener('click', () => cycleKid(day));
          cr.appendChild(pick);
        }
        items.slice(0, 4).forEach((it) => cr.appendChild(chip(it.category ? it.category + ': ' + it.activity : it.activity, 'day-chip', day)));
        row.appendChild(cr);
      }
      row.appendChild(kid);
      box.appendChild(row);
    });
    renderKidList(classNames()); // 메모장 이름표의 요일 표시도 맞춘다
  }

  function renderPlan() {
    const has = plan.weeks.length > 0;
    $('planEmpty').hidden = has || plan.busy;
    $('planLoading').hidden = !plan.busy;
    $('planReady').hidden = !has || plan.busy;
    if (has) {
      const sel = $('weekSelect');
      sel.textContent = '';
      plan.weeks.forEach((w, i) => {
        const o = el('option', null, w.label + (w.start ? ' (' + w.start + '~' + w.end + ')' : ''));
        o.value = String(i);
        sel.appendChild(o);
      });
      sel.value = String(plan.index);
      const w = currentWeek();
      const sum = $('weekSum');
      sum.textContent = '';
      const title = [w.theme, w.subtheme].filter(Boolean).join(' / ');
      if (title) sum.appendChild(el('b', null, title));
      (w.goals || []).forEach((g) => sum.appendChild(el('span', null, 'ㆍ ' + String(g).replace(/^[ㆍ·\-\s]+/, ''))));
      const chips = $('weekChips');
      chips.textContent = '';
      [...(w.free_play || []), ...(w.areas || []).map((a) => a.activity)].filter(Boolean).slice(0, 16)
        .forEach((t) => chips.appendChild(chip(t)));
      const notes = $('planNotes');
      notes.textContent = '';
      plan.notes.forEach((n) => notes.appendChild(el('li', null, n)));
      notes.hidden = !plan.notes.length;
    }
    renderDays();
  }

  // 일지 채우기에 보낼 메모: 고른 주의 월안 + 요일별 활동 + 더 적을 말
  function composeMemo() {
    const parts = [];
    const w = currentWeek();
    if (w) {
      const L = ['[이번 주 월안]'];
      L.push('시기: ' + w.label + (w.start ? ' (' + w.start + '~' + w.end + ')' : ''));
      if (w.theme || w.subtheme) L.push('놀이주제: ' + [w.theme, w.subtheme].filter(Boolean).join(' / '));
      if ((w.goals || []).length) L.push('기대되는 우리: ' + w.goals.join(' / '));
      if ((w.free_play || []).length) L.push('자유놀이 교구: ' + w.free_play.join(' / '));
      if ((w.areas || []).length) L.push('영역별 놀이: ' + w.areas.map((a) => a.name + ' - ' + a.activity).join('; '));
      (w.days || []).forEach((d) => {
        const it = (d.items || []).map((i) => i.category + ' - ' + i.activity).join('; ');
        if (it) L.push(d.day + '(' + d.date + '): ' + it);
      });
      if ((w.weekly || []).length) L.push('한 주 공통: ' + w.weekly.map((x) => x.category + ' - ' + x.activity).join('; '));
      parts.push(L.join('\n'));
    }
    const rows = Array.from(document.querySelectorAll('#days .day'));
    const anyDay = rows.some((r) => r.querySelector('.act').value.trim() || r.querySelector('.kid').value.trim()) || classNames().length > 0;
    if (w || anyDay) {
      const D = rows.map((r) => {
        const day = r.dataset.day;
        const info = w && (w.days || []).find((x) => x.day === day);
        const act = r.querySelector('.act').value.trim();
        const kid = r.querySelector('.kid').value.trim();
        const who = classNames().length ? (featured[weekKey()] || {})[day] : '';
        return day + (info && info.date ? '(' + info.date + ')' : '') + ': 활동: ' + (act || '(비워 둠)')
          + (who ? ' / 평가 아이: ' + who : '') + (kid ? ' / 아이 모습: ' + kid : '');
      });
      parts.push('[요일별 활동]\n' + D.join('\n'));
    }
    const extra = $('aiMemo').value.trim();
    if (extra) parts.push('[더 적을 말]\n' + extra);
    return parts.join('\n\n');
  }

  async function blobToBase64(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }
  // 사진은 긴 변 2000px 이하 JPEG로 줄여서 보낸다.
  async function imageToJpeg(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('사진을 열지 못했어요: ' + file.name));
        i.src = url;
      });
      const k = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
      return { mediaType: 'image/jpeg', data: await blobToBase64(blob) };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  // 한글(.hwpx) 월안은 표를 글로 풀어서 보낸다(사진보다 정확하고 가볍다).
  async function hwpxToText(buf) {
    const zip = await JSZip.loadAsync(buf);
    const hpf = zip.file('Contents/content.hpf');
    const paths = E.sectionPathsFromManifest(hpf ? await hpf.async('string') : '', Object.keys(zip.files));
    const dec = new TextDecoder('utf-8');
    const out = [];
    const walk = (blocks) => {
      for (const b of blocks) {
        if (b.type === 'table') {
          out.push('[표]');
          for (const row of b.rows) out.push(row.map((c) => (c.blocks.length ? '(안쪽 표)' : c.unit.origLines.join(' ').trim())).join(' | '));
          for (const row of b.rows) for (const c of row) if (c.blocks.length) walk(c.blocks);
        } else if (b.type === 'text') out.push(b.unit.origLines.join('\n'));
        else if (b.type === 'readonly') out.push(b.text);
      }
    };
    for (const p of paths) {
      const f = zip.file(p);
      if (f) walk(E.parseSection(dec.decode(await f.async('uint8array')), 0).blocks);
    }
    return out.join('\n');
  }
  async function readPlanFiles(files) {
    const payload = { files: [], text: '' };
    for (const f of files) {
      const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
      const name = f.name.toLowerCase();
      if (HwpConvert.isOldHwp(head)) {
        const conv = await HwpConvert.toHwpx(await f.arrayBuffer(), f.name);
        payload.text += (payload.text ? '\n\n' : '') + await hwpxToText(conv.bytes);
      } else if (name.endsWith('.hwpx') || (head[0] === 0x50 && head[1] === 0x4b)) payload.text += (payload.text ? '\n\n' : '') + await hwpxToText(await f.arrayBuffer());
      else if (name.endsWith('.pdf') || f.type === 'application/pdf') payload.files.push({ mediaType: 'application/pdf', data: await blobToBase64(f) });
      else if ((f.type || '').startsWith('image/') || /\.(jpe?g|png|webp|gif)$/i.test(name)) payload.files.push(await imageToJpeg(f));
      else throw new Error('PDF, 사진, 한글(.hwp, .hwpx) 파일만 올릴 수 있어요: ' + f.name);
    }
    return payload;
  }

  async function loadPlan(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length || plan.busy) return;
    if (!route()) { openKeyBox(); toast(inArtifact ? '이 화면에서는 월안을 읽을 수 없어요. 일지 도우미 주소로 들어와 주세요.' : 'API 키를 넣으면 월안도 읽을 수 있어요.', true); return; }
    plan.busy = true;
    renderPlan();
    const t0 = Date.now();
    const tick = setInterval(() => {
      $('planLoadingText').textContent = '월안을 읽고 있어요… ' + Math.round((Date.now() - t0) / 1000) + '초 (1~2분 걸릴 수 있어요)';
    }, 500);
    try {
      const payload = await readPlanFiles(files);
      const data = await callAuto('plan', payload);
      plan.weeks = data.weeks || [];
      plan.notes = data.notes || [];
      pickDefaultWeek();
      savePlan();
      toast(plan.weeks.length + '주 계획을 정리했어요. 몇째 주인지 확인해 주세요.');
    } catch (err) {
      console.error(err);
      toast(err.message || String(err), true);
    } finally {
      clearInterval(tick);
      plan.busy = false;
      $('planLoadingText').textContent = '월안을 읽고 있어요…';
      renderPlan();
    }
  }

  $('planInput').addEventListener('change', (e) => { loadPlan(e.target.files); e.target.value = ''; });
  $('planReload').addEventListener('click', () => $('planInput').click());
  $('weekSelect').addEventListener('change', (e) => { plan.index = +e.target.value; renderPlan(); });
  loadSavedPlan();
  if (plan.weeks.length) pickDefaultWeek();
  renderPlan();

  /* ---------- 오른쪽 탭 ---------- */
  function showTab(which) {
    const chat = which === 'chat';
    $('paneFill').hidden = chat;
    $('paneChat').hidden = !chat;
    $('tabFill').setAttribute('aria-selected', String(!chat));
    $('tabChat').setAttribute('aria-selected', String(chat));
    if (chat) setTimeout(() => $('chatInput').focus(), 0);
  }
  $('tabFill').addEventListener('click', () => showTab('fill'));
  $('tabChat').addEventListener('click', () => showTab('chat'));

  /* ---------- 내 메모(나만 보는 메모, 이 브라우저에만) ---------- */
  const MEMO_KEY = 'kissay.teacherMemo';
  try { $('teacherMemo').value = localStorage.getItem(MEMO_KEY) || ''; } catch (e) { /* 무시 */ }
  $('teacherMemo').addEventListener('input', () => { try { localStorage.setItem(MEMO_KEY, $('teacherMemo').value); } catch (e) { /* 무시 */ } });
  refreshNamesCount();

  /* ---------- 부탁하기(대화) ---------- */
  const chatState = { history: [], busy: false, ackNoNames: false };
  const SUGGEST = [
    '수요일 평가를 조금 더 자세히 써 줘',
    '놀이지원을 짧게 줄여 줘',
    '맞춤법이랑 띄어쓰기 봐 줘',
    '금요일 평가 아이를 다른 아이로 바꿔 줘',
    '이번 주 평가 문장이 서로 비슷하지 않게 다듬어 줘',
  ];
  function chatScroll() { const log = $('chatLog'); log.scrollTop = log.scrollHeight; }
  function bubble(kind, text) {
    const b = el('div', 'bubble ' + kind, text);
    $('chatLog').appendChild(b);
    chatScroll();
    return b;
  }
  function chatHello() {
    $('chatLog').textContent = '';
    bubble('bot', '안녕하세요! 일지에서 고치고 싶은 걸 편하게 말해 주세요. 요일이나 칸 이름을 같이 알려 주시면 더 정확해요.');
    const box = $('chatSuggest');
    box.textContent = '';
    SUGGEST.forEach((t) => {
      const c = el('button', 'chip', t);
      c.type = 'button';
      c.addEventListener('click', () => { $('chatInput').value = t; sendChat(); });
      box.appendChild(c);
    });
    box.hidden = false;
  }
  function cellLabel(u) {
    const entry = state.unitEls.get(u.id);
    const label = entry && entry.el.dataset.label;
    const head = headerOf(u);
    return [label, head].filter(Boolean).join(' · ') || '칸';
  }
  // 같은 열의 머리글(놀이 활동, 놀이지원 등)을 찾는다
  function headerOf(u) {
    if (u.kind !== 'cell') return '';
    // 위쪽에서 같은 열·같은 폭으로 시작하는 짧은 칸만 머리글로 본다(예: 놀이 활동, 놀이지원)
    const cand = allUnits().filter((x) => x.kind === 'cell' && x.table === u.table && x.row < u.row && x.col === u.col
      && (x.colSpan || 1) === (u.colSpan || 1) && x.lines.join('').trim().length <= 16 && x.lines.join('').trim().length > 0);
    const h = cand.sort((a, b) => b.row - a.row)[0];
    return h ? h.origLines.join(' ').trim() : '';
  }

  // 무료체험 서버는 12개까지 받으므로 최근 대화만, 사용자 말로 시작하게 보낸다.
  function recentTurns(history) {
    const out = history.slice(-12);
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
  }

  async function sendChat() {
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text || chatState.busy) return;
    if (!state.doc) { bubble('bot err', '먼저 왼쪽 위 [다른 파일 열기]나 첫 화면에서 일지 파일을 열어 주세요.'); return; }
    if (!route()) { openKeyBox(); bubble('bot err', '아래 "내 API 키로 쓰기"에 키를 넣으면 바로 부탁할 수 있어요.'); return; }
    const names = NameMask.parseNames($('aiNames').value);
    if (!names.length && !chatState.ackNoNames) {
      chatState.ackNoNames = true;
      bubble('bot err', '왼쪽 메모장에 우리 반 아이 이름을 적어 두시면 이름을 가려서 보내요. 이름 없이 보내려면 한 번 더 보내기를 눌러 주세요.');
      return;
    }
    if (state.editing) commitEdit();
    input.value = '';
    $('chatSuggest').hidden = true;
    bubble('me', text);
    chatState.history.push({ role: 'user', content: text });
    const wait = el('div', 'bubble bot');
    const dots = el('span', 'typing');
    dots.append(el('i'), el('i'), el('i'));
    wait.appendChild(dots);
    $('chatLog').appendChild(wait);
    chatScroll();
    chatState.busy = true;
    $('chatSend').disabled = true;

    const memo = composeMemo();
    const corpus = allUnits().map((u) => u.lines.join('\n')).join('\n') + '\n' + memo + '\n' + chatState.history.map((m) => m.content).join('\n');
    const masker = NameMask.createMasker(names, corpus);
    const payload = {
      form: buildForm(masker),
      memo: masker.mask(memo),
      messages: recentTurns(chatState.history).map((m) => ({ role: m.role, content: masker.mask(m.content) })),
    };
    try {
      const data = await callAuto('chat', payload);
      wait.remove();
      const reply = masker.unmask(String(data.reply || ''));
      const units = unitById();
      const snap = new Map();
      const changed = [];
      for (const c of data.cells || []) {
        const u = units.get(c.id);
        if (!u || !u.editable) continue;
        snap.set(u.id, u.lines.slice());
        u.lines = (c.lines || []).map((l) => E.cleanText(masker.unmask(l)));
        if (!u.lines.length) u.lines = [''];
        ai.aiUnits.add(u.id);
        rerenderUnit(u);
        changed.push(u);
      }
      if (changed.length) { updateSummary(); $('report').hidden = true; }
      const b = bubble('bot', reply);
      chatState.history.push({ role: 'assistant', content: reply });
      if (changed.length) {
        const ul = el('ul', 'edits');
        for (const u of changed) {
          const li = el('li');
          const btn = el('button', null, cellLabel(u) + ' — ' + u.lines.join(' ').slice(0, 40));
          btn.type = 'button';
          btn.title = '눌러서 일지에서 보기';
          btn.addEventListener('click', () => {
            const entry = state.unitEls.get(u.id);
            if (!entry) return;
            entry.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            entry.el.classList.remove('flash'); void entry.el.offsetWidth; entry.el.classList.add('flash');
          });
          li.appendChild(btn);
          ul.appendChild(li);
        }
        b.appendChild(ul);
        const undo = el('button', 'link-btn undo', '이번에 고친 것 되돌리기');
        undo.type = 'button';
        undo.addEventListener('click', () => {
          for (const [id, lines] of snap) {
            const u = units.get(id);
            if (!u) continue;
            u.lines = lines.slice();
            ai.aiUnits.delete(id); // 되돌린 칸은 '자동으로 채운 곳' 표시도 지운다
            rerenderUnit(u);
          }
          updateSummary();
          undo.remove();
          bubble('bot', '방금 고친 ' + snap.size + '곳을 되돌렸어요.');
          chatState.history.push({ role: 'assistant', content: '(선생님이 방금 고친 내용을 되돌렸어요.)' });
        });
        b.appendChild(undo);
        chatScroll();
      }
    } catch (err) {
      wait.remove();
      chatState.history.pop(); // 실패한 부탁은 대화 기록에서 뺀다
      bubble('bot err', err.message || String(err));
    } finally {
      chatState.busy = false;
      $('chatSend').disabled = false;
    }
  }
  $('chatSend').addEventListener('click', sendChat);
  $('chatInput').addEventListener('keydown', (e) => {
    // 한글을 조합하는 중의 Enter는 보내지 않는다
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendChat(); }
  });
  $('chatInput').addEventListener('input', () => {
    const t = $('chatInput');
    t.style.height = 'auto';
    t.style.height = Math.min(140, t.scrollHeight) + 'px';
  });
  $('chatClear').addEventListener('click', () => { chatState.history = []; chatHello(); });
  chatHello();

  /* ---------- 개발용: ?dev 패널, 로컬 서버의 샘플 자동 열기, 검증용 훅 ---------- */
  if (/[?&]dev\b/.test(location.search)) $('devTools').hidden = false;
  window.__hwpxApp = { state, openArrayBuffer, exportBlob, startEdit, commitEdit, plan, composeMemo, renderPlan, readPlanFiles, route, featured: () => featured, sendChat, showTab };
  if (!inArtifact && /[?&]sample\b/.test(location.search)) {
    fetch('/__sample.hwpx').then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('샘플 없음'))))
      .then((b) => openArrayBuffer(b, decodeURIComponent((location.search.match(/name=([^&]+)/) || [])[1] || 'sample.hwpx')))
      .catch((e) => toast(e.message, true));
  }
})();
