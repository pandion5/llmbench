'use strict';
// llama-server를 router 모드로 띄우고 상태를 관리한다.
// 서버 출력은 설치 로그와 섞이면 읽기 어려워 별도 링 버퍼에 담는다.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 8080;
const BASE_URL = `http://${HOST}:${PORT}`;
const READY_TIMEOUT_MS = 15 * 60 * 1000; // 두 모델을 RAM에 올리는 데 몇 분 걸린다
const LOG_MAX = 200;

const state = { state: 'stopped', pid: null, models: [], error: null };
const logBuf = [];
let child = null;
let listener = null;

function onStatus(cb) {
  listener = cb;
}

function status() {
  return { ...state, models: state.models.map((m) => ({ ...m })) };
}

function emit() {
  if (listener) listener(status());
}

function pushLog(line) {
  logBuf.push(line);
  if (logBuf.length > LOG_MAX * 2) logBuf.splice(0, logBuf.length - LOG_MAX);
}

function logs() {
  return logBuf.slice(-LOG_MAX);
}

function pipeLines(stream) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const l of lines) if (l.trim()) pushLog(l.trim());
  });
}

async function health(baseUrl = BASE_URL, timeoutMs = 2000) {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status === 200;
  } catch {
    return false;
  }
}

// 서버가 응답할 때까지 기다린다. 못 뜨면 false.
async function pollHealth(baseUrl = BASE_URL, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) return false;
    if (await health(baseUrl)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// 라우터 모드 /models 응답을 CONTRACT의 models 배열로 바꾼다.
// 라우터는 항목마다 status를 { value: 'loaded' } 객체로 준다. 예전처럼
// m.status === 'loaded'로 비교하면 객체와 문자열 비교라 언제나 false가 된다.
// 문자열 status를 주는 빌드도 있어 두 형태를 모두 받는다.
function parseModels(body) {
  const list = Array.isArray(body) ? body : (body && (body.data || body.models)) || [];
  return list.map((m) => {
    const st = m && m.status;
    const value = st && typeof st === 'object' ? st.value : st;
    return {
      id: m.id || m.name || String(m),
      loaded: value === 'loaded' || Boolean(m.loaded ?? m.is_loaded ?? false)
    };
  });
}

async function fetchModels(baseUrl = BASE_URL) {
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    return parseModels(await res.json());
  } catch {
    return [];
  }
}

function killTree(p) {
  if (!p || p.exitCode !== null) return;
  spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {
    try {
      p.kill();
    } catch {
      // 이미 종료됨
    }
  });
}

function start(cfg) {
  if (child && child.exitCode === null) return status();

  const exe = path.join(cfg.installDir, 'bin', 'llama-server.exe');
  const preset = path.join(cfg.installDir, 'models.ini');
  if (!fs.existsSync(exe) || !fs.existsSync(preset)) {
    Object.assign(state, {
      state: 'error',
      pid: null,
      models: [],
      error: `설치가 안 됨: ${fs.existsSync(exe) ? preset : exe} 없음`
    });
    emit();
    return status();
  }

  Object.assign(state, { state: 'starting', pid: null, models: [], error: null });
  logBuf.length = 0;
  emit();

  child = spawn(
    exe,
    ['--models-preset', preset, '--models-max', '2', '--host', HOST, '--port', String(PORT)],
    { cwd: path.dirname(exe), windowsHide: true }
  );
  pipeLines(child.stdout);
  pipeLines(child.stderr);
  state.pid = child.pid;
  emit();

  child.on('error', (e) => {
    child = null;
    Object.assign(state, { state: 'error', pid: null, models: [], error: e.message });
    emit();
  });

  child.on('close', (code) => {
    child = null;
    const stopped = state.state === 'stopped';
    Object.assign(state, {
      state: stopped ? 'stopped' : 'error',
      pid: null,
      models: [],
      error: stopped ? null : `llama-server 종료코드 ${code}`
    });
    emit();
  });

  pollHealth().then(async (ok) => {
    if (state.state === 'stopped') return; // 기다리는 사이에 중지됨
    if (!ok) {
      Object.assign(state, { state: 'error', error: '서버가 준비되지 않음. 로그 확인.' });
      emit();
      return;
    }
    state.models = await fetchModels();
    state.state = 'ready';
    state.error = null;
    emit();
  });

  return status();
}

function stop() {
  Object.assign(state, { state: 'stopped', models: [], error: null });
  killTree(child);
  child = null;
  state.pid = null;
  emit();
  return status();
}

// 현재 상태를 돌려준다. 준비 상태면 모델 목록을 다시 읽는다.
async function refresh() {
  if (state.state === 'ready') {
    if (!(await health())) {
      // 서버가 죽었으면 모델 목록도 더 이상 유효하지 않다
      Object.assign(state, { state: 'error', models: [], error: '서버 응답 없음' });
    } else {
      state.models = await fetchModels();
    }
    emit();
  }
  return status();
}

module.exports = { start, stop, status, refresh, onStatus, logs, health, pollHealth, fetchModels, parseModels, BASE_URL };
