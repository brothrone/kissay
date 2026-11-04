const M = require('../web/name-mask.js');
let failed = 0;
const check = (name, ok, info) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) failed++; };

const names = M.parseNames('민서, 지아 수아/하준 이안, 건우, 민서');
check('이름 목록 정리(중복 제거)', names.join(',') === '민서,지아,수아,하준,이안,건우', names.join(','));
check('받침 판별', M.hasFinal('하준') && !M.hasFinal('민서'));

const corpus = '민서는 스포이드를 사용함. 하준이는 블록을 쌓음. 로희라는 단어가 이미 있음.';
const mk = M.createMasker(names, corpus);
const aliasOf = (n) => mk.pairs.find((p) => p.real === n).alias;
check('가명이 본문에 이미 있는 말과 겹치지 않음', !mk.pairs.some((p) => corpus.includes(p.alias)), mk.pairs.map((p) => p.real + '→' + p.alias).join(' '));
check('받침 없는 이름 → 받침 없는 가명', !M.hasFinal(aliasOf('민서')));
check('받침 있는 이름 → 받침 있는 가명', M.hasFinal(aliasOf('하준')));
const masked = mk.mask(corpus);
check('실명이 남지 않음', !names.some((n) => masked.includes(n)), masked);
const aiOut = aliasOf('민서') + '는 친구와 색을 섞음. ' + aliasOf('하준') + '이가 도와줌.';
check('AI 결과 되돌리기', mk.unmask(aiOut) === '민서는 친구와 색을 섞음. 하준이가 도와줌.', mk.unmask(aiOut));
check('왕복하면 원문과 같음', mk.unmask(masked) === corpus);
const mk2 = M.createMasker(['수아', '수아린'], '수아린과 수아가 놀이함.');
check('긴 이름 먼저 바꿈', mk2.unmask(mk2.mask('수아린과 수아가 놀이함.')) === '수아린과 수아가 놀이함.' && !mk2.mask('수아린과 수아가 놀이함.').includes('수아'));
console.log(failed ? `\n${failed}개 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
