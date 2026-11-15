/* hwp-convert.js: 예전 한글 파일(.hwp)을 HWPX로 바꾼다(hwp-worker.js를 작업 스레드로 돌림). */
(function (global) {
  'use strict';
  let worker = null;
  let seq = 0;
  const pending = new Map();

  function getWorker() {
    if (worker) return worker;
    worker = new Worker(new URL('hwp-worker.js', document.baseURI), { type: 'module' });
    worker.onmessage = (e) => {
      const done = pending.get(e.data.id);
      if (done) { pending.delete(e.data.id); done(e.data); }
    };
    worker.onerror = (e) => {
      for (const [id, done] of pending) done({ id, ok: false, code: 'engine', error: e.message });
      pending.clear();
      worker = null;
    };
    return worker;
  }

  const isOldHwp = (u8) => u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0;

  function convertOnce(buf, password) {
    return new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      const copy = buf.slice(0);
      getWorker().postMessage({ id, bytes: copy, password }, [copy]);
    });
  }

  // 암호가 걸려 있으면 물어보고, 사람이 읽을 수 있는 오류로 바꿔 던진다.
  async function toHwpx(buf, fileName) {
    let password;
    for (let tries = 0; tries < 3; tries++) {
      const r = await convertOnce(buf, password);
      if (r.ok) return { bytes: r.bytes, loss: r.loss || [], unlocked: !!password };
      if (r.code === 'password') {
        const p = global.prompt((password ? '암호가 맞지 않아요. ' : '') + '"' + fileName + '" 파일에 걸린 암호를 넣어 주세요.');
        if (!p) throw new Error('암호가 걸린 파일이라 열지 못했어요.');
        password = p;
        continue;
      }
      if (r.code === 'distribution') throw new Error('배포용(읽기 전용) 한글 파일이라 바꿀 수 없어요. 원본 파일로 열어 주세요.');
      if (r.code === 'engine') throw new Error('한글 파일 변환 도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.');
      throw new Error('이 .hwp 파일을 바꾸지 못했어요. 한글에서 열리는 파일인지 확인해 주세요.');
    }
    throw new Error('암호가 맞지 않아 열지 못했어요.');
  }

  global.HwpConvert = { isOldHwp, toHwpx };
})(window);
