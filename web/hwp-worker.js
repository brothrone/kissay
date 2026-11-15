// 예전 한글 파일(.hwp) → HWPX 변환. 브라우저 안에서만 바꾸고 파일을 어디로도 보내지 않는다.
// 엔진: rhwp 0.8.7 (MIT License, © Edward Kim, https://github.com/edwardkim/rhwp)
// 받는 것: { id, bytes(ArrayBuffer), password? }  돌려주는 것: { id, ok, bytes?, loss?, code?, error? }
//   code: 'password'(암호가 걸림·틀림) | 'distribution'(배포용 문서라 바꾸지 않음) | 'broken'(읽을 수 없음) | 'engine'(엔진을 못 불러옴)
// 일지 편집기는 암호 걸린 HWPX를 열 수 없으므로, 암호 파일도 암호를 푼 HWPX로 내보낸다.
import init, { HwpDocument } from 'https://cdn.jsdelivr.net/npm/@rhwp/core@0.8.7/rhwp.js';

const ready = init({ module_or_path: 'https://cdn.jsdelivr.net/npm/@rhwp/core@0.8.7/rhwp_bg.wasm' });

self.onmessage = async (e) => {
  const { id, bytes, password } = e.data;
  try {
    await ready;
  } catch (err) {
    self.postMessage({ id, ok: false, code: 'engine', error: String((err && err.message) || err).slice(0, 300) });
    return;
  }
  let doc = null;
  try {
    const data = new Uint8Array(bytes);
    try {
      doc = password ? HwpDocument.openWithPassword(data, password) : new HwpDocument(data);
    } catch (err) {
      const m = String((err && err.message) || err);
      self.postMessage({ id, ok: false, code: /비밀번호|password|암호|encrypt/i.test(m) ? 'password' : 'broken', error: m.slice(0, 300) });
      return;
    }
    // 배포용(읽기 전용) 문서는 작성자가 고치기·복사를 막아 둔 문서라 바꾸지 않는다
    let dist = false;
    try { dist = JSON.parse(doc.convertToEditable()).converted === true; } catch (err) { /* 판단 못 하면 일반 문서로 */ }
    if (dist) { self.postMessage({ id, ok: false, code: 'distribution' }); return; }
    const r = doc.exportHwpxWithReport();
    let loss = [];
    try { loss = JSON.parse(r.contentLoss()).losses || []; } catch (err) { /* 보고서가 없으면 빈 목록 */ }
    const out = r.takeBytes();
    self.postMessage({ id, ok: true, bytes: out.buffer, loss }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, code: 'broken', error: String((err && err.message) || err).slice(0, 300) });
  } finally {
    try { if (doc) doc.free(); } catch (err) { /* 이미 풀림 */ }
  }
};
