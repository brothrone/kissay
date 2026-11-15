/*
 * direct.js: 선생님이 넣은 본인 API 키로, 브라우저에서 Claude를 바로 부른다(서버를 거치지 않음).
 * - 키는 이 브라우저(localStorage)에만 저장되고 api.anthropic.com 으로만 간다.
 * - 지시문과 응답 형식은 서버와 같은 prompts.json 을 쓴다.
 * - 공식 SDK(@anthropic-ai/sdk)를 필요할 때만 불러온다. 브라우저 사용은 dangerouslyAllowBrowser 로 명시한다.
 */
(function (global) {
  'use strict';
  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm';
  const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
  const KEY_STORE = 'kissay.apiKey';

  let sdkPromise = null;
  let promptsPromise = null;

  function loadSdk() {
    if (!sdkPromise) {
      sdkPromise = import(SDK_URL)
        .then((m) => m.default || m.Anthropic)
        .catch(() => { sdkPromise = null; throw new Error('자동 작성 도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.'); });
    }
    return sdkPromise;
  }
  function loadPrompts() {
    if (!promptsPromise) {
      promptsPromise = fetch(new URL('prompts.json', document.baseURI), { cache: 'no-store' })
        .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
        .catch(() => { promptsPromise = null; throw new Error('설정 파일을 불러오지 못했어요. 새로고침해 주세요.'); });
    }
    return promptsPromise;
  }

  /* ---------- 키 보관 ---------- */
  const looksLikeKey = (k) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(String(k || '').trim());
  function getKey() { try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } }
  function setKey(k) { try { localStorage.setItem(KEY_STORE, String(k).trim()); return true; } catch (e) { return false; } }
  function clearKey() { try { localStorage.removeItem(KEY_STORE); } catch (e) { /* 무시 */ } }

  /* ---------- 호출 ---------- */
  function friendly(e, A) {
    if (A && e instanceof A.AuthenticationError) return new Error('API 키가 맞지 않아요. 키를 다시 확인해 주세요.');
    if (A && e instanceof A.PermissionDeniedError) return new Error('이 API 키로는 쓸 수 없어요. 키 권한을 확인해 주세요.');
    if (A && e instanceof A.RateLimitError) return new Error('잠시 사용량이 많아요. 1분 뒤에 다시 눌러 주세요.');
    if (A && e instanceof A.BadRequestError) {
      if (/credit|balance|billing/i.test(String(e.message))) return new Error('API 키에 남은 크레딧이 없어요. Claude 콘솔에서 충전해 주세요.');
      return new Error('채우지 못했어요. 메모를 조금 바꿔서 다시 눌러 주세요.');
    }
    if (A && e instanceof A.APIConnectionError) return new Error('인터넷 연결을 확인한 뒤 다시 눌러 주세요.');
    if (A && e instanceof A.APIError) return new Error('잠깐 연결이 고르지 않아요. 잠시 뒤 다시 눌러 주세요.');
    return e instanceof Error ? e : new Error('채우지 못했어요. 잠시 뒤 다시 눌러 주세요.');
  }

  async function ask(key, part, content, history) {
    const [Anthropic, P] = await Promise.all([loadSdk(), loadPrompts()]);
    const cfg = P[part];
    const model = P.model;
    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 });
    const params = {
      model,
      max_tokens: cfg.max_tokens,
      system: cfg.system,
      messages: (history || []).concat([{ role: 'user', content }]),
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: cfg.schema } },
    };
    if (FALLBACK_MODELS.has(model)) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    let msg;
    try {
      // 입력·출력이 길 수 있어 스트리밍으로 받고 완성된 응답만 쓴다.
      msg = await client.beta.messages.stream(params).finalMessage();
    } catch (e) {
      throw friendly(e, Anthropic);
    }
    if (msg.stop_reason === 'refusal') throw new Error('이 내용으로는 채우지 못했어요. 메모를 조금 바꿔서 다시 눌러 주세요.');
    if (msg.stop_reason === 'max_tokens') throw new Error('내용이 너무 길어서 다 채우지 못했어요. 메모를 조금 줄여서 다시 눌러 주세요.');
    const block = msg.content.find((b) => b.type === 'text');
    let data;
    try { data = JSON.parse(block ? block.text : ''); } catch (e) { throw new Error('채우지 못했어요. 한 번 더 눌러 주세요.'); }
    return { data, meta: { model: msg.model, input_tokens: msg.usage && msg.usage.input_tokens, output_tokens: msg.usage && msg.usage.output_tokens } };
  }

  /* ---------- 일지 채우기 (서버 ai_writer.draft 와 같은 규칙) ---------- */
  function cleanCells(data, cells) {
    const allowed = new Set(cells.filter((c) => c.editable).map((c) => c.id));
    const seen = new Set();
    const out = [];
    for (const item of (data && data.cells) || []) {
      if (!item || !allowed.has(item.id) || seen.has(item.id) || !Array.isArray(item.lines)) continue;
      seen.add(item.id);
      const flat = [];
      item.lines.forEach((l) => String(l).replace(/\r/g, '').split('\n').forEach((x) => flat.push(x)));
      out.push({ id: item.id, lines: flat.length ? flat : [''] });
    }
    return out;
  }
  async function draft(key, form, memo) {
    const cells = (form && form.cells) || [];
    const content = '<form>\n' + JSON.stringify({ cells }) + '\n</form>\n\n<memo>\n' + memo + '\n</memo>';
    const { data, meta } = await ask(key, 'draft', content);
    const notes = ((data && data.notes) || []).map(String).filter((n) => n.trim()).slice(0, 20);
    return { cells: cleanCells(data, cells), notes, meta };
  }

  /* ---------- 부탁하기 (서버 ai_writer.chat 과 같은 규칙) ---------- */
  async function chat(key, form, memo, messages) {
    const items = (messages || []).slice(-12)
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000).trim() }));
    while (items.length && items[0].role !== 'user') items.shift();
    const merged = [];
    for (const m of items) {
      if (merged.length && merged[merged.length - 1].role === m.role) merged[merged.length - 1].content += '\n' + m.content;
      else merged.push(Object.assign({}, m));
    }
    if (!merged.length || merged[merged.length - 1].role !== 'user') throw new Error('부탁할 내용을 적어 주세요.');
    const request = merged.pop().content;
    const cells = (form && form.cells) || [];
    const content = '<form>\n' + JSON.stringify({ cells }) + '\n</form>\n\n<memo>\n' + (memo || '(없음)') + '\n</memo>\n\n<request>\n' + request + '\n</request>';
    const { data, meta } = await ask(key, 'chat', content, merged);
    const out = cleanCells(data, cells);
    const reply = String((data && data.reply) || '').trim();
    return { reply: reply || (out.length ? '고쳤어요.' : '어떤 칸을 고칠지 한 번 더 알려 주세요.'), cells: out, meta };
  }

  /* ---------- 월안 정리 (서버 ai_writer.read_plan 과 같은 규칙) ---------- */
  async function readPlan(key, payload) {
    const P = await loadPrompts();
    const blocks = [];
    for (const f of payload.files || []) {
      if (f.mediaType === 'application/pdf') blocks.push({ type: 'document', source: { type: 'base64', media_type: f.mediaType, data: f.data } });
      else blocks.push({ type: 'image', source: { type: 'base64', media_type: f.mediaType, data: f.data } });
    }
    if (payload.text && payload.text.trim()) blocks.push({ type: 'text', text: '<plan_text>\n' + payload.text.slice(0, 60000) + '\n</plan_text>' });
    if (!blocks.length) throw new Error('월안 파일을 골라 주세요.');
    blocks.push({ type: 'text', text: P.plan.instruction });
    const { data, meta } = await ask(key, 'plan', blocks);
    const weeks = ((data && data.weeks) || []).filter((w) => w && String(w.label || '').trim()).slice(0, 8);
    if (!weeks.length) throw new Error('월안에서 주별 계획표를 찾지 못했어요. 교육계획안 쪽이 들어 있는지 확인해 주세요.');
    const notes = ((data && data.notes) || []).map(String).filter((n) => n.trim()).slice(0, 10);
    return { weeks, notes, meta };
  }

  global.ClaudeDirect = { looksLikeKey, getKey, setKey, clearKey, draft, chat, readPlan, loadSdk };
})(window);
