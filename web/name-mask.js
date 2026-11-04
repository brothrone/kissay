/*
 * name-mask.js: 아이 실명을 가명으로 바꿔 AI에 보내고, 돌아온 글에서 다시 실명으로 되돌린다.
 * 받침이 있는 이름은 받침 있는 가명으로, 없는 이름은 받침 없는 가명으로 바꿔 조사(은/는, 이/가)가 맞게 한다.
 * 가명은 보낼 글 어디에도 나오지 않는 것만 고른다.
 */
(function (global) {
  'use strict';
  const PLAIN = ['로희', '세비', '미호', '도레', '네아', '채도', '재오', '루하', '이로', '다예', '라미', '서호', '보예', '하예', '주예', '태리', '유레', '아로', '소희', '제아', '리나', '모아', '시레', '누리'];
  const FINAL = ['가온', '하람', '도담', '새롬', '세린', '로운', '라운', '예솔', '다온', '이솜', '나린', '루안', '미온', '태윤', '서진', '가람', '유솔', '하율', '도윤', '시온', '예준', '로건', '주원', '한별'];

  function hasFinal(word) {
    const c = word.charCodeAt(word.length - 1);
    if (c < 0xac00 || c > 0xd7a3) return false;
    return (c - 0xac00) % 28 !== 0;
  }

  function parseNames(input) {
    const seen = new Set();
    return String(input || '')
      .split(/[\s,;/·ㆍ]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2 && !seen.has(s) && seen.add(s));
  }

  function createMasker(names, corpus) {
    const text = String(corpus || '');
    const list = names.slice().sort((a, b) => b.length - a.length);
    const used = new Set();
    const pairs = [];
    list.forEach((real, i) => {
      const pool = hasFinal(real) ? FINAL : PLAIN;
      let alias = pool.find((a) => !used.has(a) && !text.includes(a) && !list.some((n) => n.includes(a) || a.includes(n)));
      if (!alias) alias = '아동' + (i + 1) + (hasFinal(real) ? '번' : '호');
      used.add(alias);
      pairs.push({ real, alias });
    });
    const swap = (s, from, to) => s.split(from).join(to);
    return {
      pairs,
      mask(s) { let t = String(s); for (const p of pairs) t = swap(t, p.real, p.alias); return t; },
      unmask(s) {
        let t = String(s);
        for (const p of pairs.slice().sort((a, b) => b.alias.length - a.alias.length)) t = swap(t, p.alias, p.real);
        return t;
      },
    };
  }

  const api = { createMasker, parseNames, hasFinal };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NameMask = api;
})(typeof window !== 'undefined' ? window : globalThis);
