'use strict';
// 서버의 llama-server에 대화를 보낸다. 토큰이 오는 대로 화면에 넘긴다.

const DEFAULT_MODEL = 'qwen38';

let controller = null;
let listener = null;

function onEvent(cb) {
  listener = cb;
}

function emit(e) {
  if (listener) listener(e);
}

function busy() {
  return !!controller;
}

function cancel() {
  if (controller) controller.abort();
  controller = null;
}

// messages는 [{ role, content }] 그대로 보낸다.
async function send(target, messages, opts) {
  if (!target) throw new Error('서버에 연결돼 있지 않다');
  if (controller) throw new Error('앞선 요청이 아직 돌고 있다');
  const o = opts || {};
  controller = new AbortController();
  const t0 = Date.now();
  let text = '';
  let tokens = 0;
  let firstAt = null;

  try {
    const res = await fetch(`${target.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {})
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: o.model || DEFAULT_MODEL,
        messages,
        stream: true,
        max_tokens: o.maxTokens || 4096
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`서버가 ${res.status}로 답했다. ${body.slice(0, 200)}`);
    }

    // SSE는 줄 단위로 온다. 조각이 잘려 올 수 있어 남은 부분을 들고 간다.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += decoder.decode(value, { stream: true });
      const lines = rest.split('\n');
      rest = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (!delta) continue;
        // 생각하는 모델은 답을 내기 전에 reasoning_content로 먼저 보낸다.
        // 이걸 안 읽으면 생각하는 동안 화면이 빈 채로 멈춰 있는 것처럼 보인다.
        if (delta.reasoning_content) {
          if (firstAt === null) firstAt = Date.now();
          tokens += 1;
          emit({ type: 'reasoning', text: delta.reasoning_content });
        }
        const piece = delta.content;
        if (!piece) continue;
        if (firstAt === null) firstAt = Date.now();
        text += piece;
        tokens += 1;
        emit({ type: 'delta', text: piece });
      }
    }

    const seconds = (Date.now() - t0) / 1000;
    const genSeconds = firstAt ? (Date.now() - firstAt) / 1000 : seconds;
    const stat = {
      seconds: Math.round(seconds * 10) / 10,
      tokens,
      tokPerSec: genSeconds > 0 ? Math.round((tokens / genSeconds) * 10) / 10 : 0,
      waitSeconds: firstAt ? Math.round(((firstAt - t0) / 1000) * 10) / 10 : null
    };
    emit({ type: 'done', text, stat });
    return { text, stat };
  } catch (e) {
    if (e.name === 'AbortError') {
      emit({ type: 'canceled', text });
      return { text, canceled: true };
    }
    emit({ type: 'error', message: e.message });
    throw e;
  } finally {
    controller = null;
  }
}

async function models(target) {
  if (!target) return [];
  try {
    const res = await fetch(`${target.baseUrl}/models`, {
      headers: target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {},
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return [];
    const json = await res.json();
    const arr = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    return arr.map((m) => ({
      id: m.id || m.name,
      loaded: m.status ? m.status.value === 'loaded' : undefined
    }));
  } catch {
    return [];
  }
}

async function health(target) {
  if (!target) return false;
  try {
    const res = await fetch(`${target.baseUrl}/health`, {
      headers: target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {},
      signal: AbortSignal.timeout(4000)
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

module.exports = { send, cancel, busy, models, health, onEvent, DEFAULT_MODEL };
