// 사용법: node test/engine-test.cjs <압축 푼 hwpx 폴더> [결과 section0.xml 저장 경로]
const fs = require('fs');
const path = require('path');
const E = require('../web/hwpx-engine.js');

const dir = process.argv[2];
const outPath = process.argv[3];
const sec = fs.readFileSync(path.join(dir, 'Contents/section0.xml'), 'utf8');
const hdr = fs.readFileSync(path.join(dir, 'Contents/header.xml'), 'utf8');
let failed = 0;
const check = (name, ok, info) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) failed++; };

const header = E.parseHeader(hdr);
check('header: 글자 모양 읽기', Object.keys(header.charPr).length > 20, Object.keys(header.charPr).length + '개');
check('header: 파란 관찰 글씨(26번)', header.charPr['26'].color === '#0000FF' && header.charPr['26'].size === 8);
check('header: 제목 굵게(19번)', header.charPr['19'].bold && header.charPr['19'].size === 22);
check('header: 배경색(11번)', header.borderFill['11'].fill === '#FFF7CC');

const s = E.parseSection(sec, 0);
const tables = s.blocks.filter((b) => b.type === 'table');
check('표 1개', tables.length === 1);
const t = tables[0];
check('표 14행 9열', t.rowCnt === 14 && t.colCnt === 9);
const cells = t.rows.flat();
check('칸 43개', cells.length === 43);
check('모든 칸 편집 가능', cells.every((c) => c.unit.editable), cells.filter((c) => !c.unit.editable).length + '개 잠김');
const colSum = t.colWidths.reduce((a, b) => a + b, 0);
check('열 너비 합 = 표 너비', Math.abs(colSum - t.width) < 5, colSum + ' / ' + t.width);
check('열 너비 모두 양수', t.colWidths.every((w) => w > 0), t.colWidths.map(Math.round).join(','));

// 1) 아무것도 안 고치면 원본 그대로
const r0 = E.serializeSection(s, { lineseg: 'strip' });
check('수정 없음 → 원본과 동일', r0.xml === sec && !r0.changed);

const cellAt = (r, c) => cells.find((x) => x.row === r && x.col === c);

// 2) 한 칸 고치기
const period = cellAt(2, 1).unit;
period.lines = ['11월 1주 (11.2~ 11.6)'];
const obs = cellAt(9, 5).unit;
obs.lines = ['하늘이는 물감 놀이에서 <색>과 "모양"을 & 함께 관찰함.'];
// 3) 줄 추가 (문단 늘리기)
const goal = cellAt(4, 1).unit;
goal.lines = goal.origLines.concat(['ㆍ 새로 추가한 세 번째 목표입니다.']);
// 4) 줄 삭제 (문단 줄이기)
const daily = cellAt(7, 1).unit;
daily.lines = daily.origLines.slice(0, 2);
// 5) 칸 비우기
const sup = cellAt(11, 3).unit;
sup.lines = [''];

const r1 = E.serializeSection(s, { lineseg: 'strip' });
check('수정 후 XML 다시 읽힘', (() => { try { E.parseXml(r1.xml); return true; } catch (e) { return false; } })());
check('바뀐 범위 5곳', r1.splices.length === 5, String(r1.splices.length));

// 바뀐 범위 밖은 원본과 글자 하나까지 같은지
let pos = 0, outPos = 0, outside = true;
for (const sp of r1.splices) {
  const before = sec.slice(pos, sp.start);
  if (r1.xml.slice(outPos, outPos + before.length) !== before) outside = false;
  outPos += before.length + sp.text.length;
  pos = sp.end;
}
if (r1.xml.slice(outPos) !== sec.slice(pos)) outside = false;
check('바뀐 문단 밖은 원본 그대로', outside);

const s2 = E.parseSection(r1.xml, 0);
const cells2 = s2.blocks.find((b) => b.type === 'table').rows.flat();
const at2 = (r, c) => cells2.find((x) => x.row === r && x.col === c).unit;
check('다시 읽은 표도 43칸', cells2.length === 43);
check('기간 칸 반영', at2(2, 1).lines.join('|') === '11월 1주 (11.2~ 11.6)');
check('특수문자 이스케이프 후 원문 복원', at2(9, 5).lines[0] === '하늘이는 물감 놀이에서 <색>과 "모양"을 & 함께 관찰함.');
check('줄 추가 → 문단 3개', at2(4, 1).lines.length === 3, at2(4, 1).lines.length + '개');
check('줄 삭제 → 문단 2개', at2(7, 1).lines.length === 2, at2(7, 1).lines.length + '개');
check('빈 칸 → 문단 1개, 글자 없음', at2(11, 3).lines.length === 1 && at2(11, 3).lines[0] === '');
check('관찰 칸 파란 글씨 유지', at2(9, 5).models[0].runs[0].charPr === '26');
check('추가 문단도 같은 문단 모양', at2(4, 1).models[2].paraPr === at2(4, 1).models[0].paraPr);
check('나머지 칸 내용 그대로', cells2.filter((c) => !['2,1', '9,5', '4,1', '7,1', '11,3'].includes(c.row + ',' + c.col))
  .every((c) => c.unit.lines.join('\n') === cells.find((o) => o.row === c.row && o.col === c.col).unit.origLines.join('\n')));
check('바뀐 문단의 줄 배치 캐시 제거', !/linesegarray/.test(r1.splices.find((x) => x.text.includes('하늘이는')).text));
const keep = E.serializeSection(s, { lineseg: 'keep' });
check('keep 옵션이면 캐시 유지', /linesegarray/.test(keep.splices.find((x) => x.text.includes('하늘이는')).text));

if (outPath) fs.writeFileSync(outPath, r1.xml);
console.log(failed ? `\n${failed}개 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
