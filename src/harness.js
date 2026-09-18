'use strict';
// 코딩 에이전트 CLI(하네스)를 외부 콘솔 창으로 띄운다.
// 앱 안에 화면을 두지 않고 설치 여부 확인, npm 전역 설치, 터미널 실행만 맡는다.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const sys = require('./sys');
const server = require('./server');
const config = require('./config');

// npm 전역 설치본은 .cmd 래퍼라 Node 22에서 shell 없이 spawn하면 EINVAL이 난다.
// 그래서 확인·설치·실행 모두 cmd /c를 거친다.
const DEFS = [
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    npm: '@qwen-code/qwen-code',
    bin: 'qwen',
    note: 'Qwen3-Coder용 CLI. ~/.qwen/settings.json에 llama-server를 OpenAI 호환 공급자로 등록한다.'
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    npm: 'opencode-ai',
    bin: 'opencode',
    note: '터미널 TUI. 터미널 열기 때 전역 opencode.json에 llama-server 프로바이더를 써 넣는다.'
  }
];

const BASE_URL = `${server.BASE_URL}/v1`;
const API_KEY = 'local';

let listener = null;

function onLog(cb) {
  listener = cb;
}

function log(line) {
  if (listener) listener(line);
}

function def(id) {
  return DEFS.find((d) => d.id === id) || null;
}

// 출력에서 버전처럼 보이는 첫 줄을 고른다. 업데이트 안내가 먼저 찍히는 CLI가 있다.
function pickVersion(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => /\d+\.\d+\.\d+/.test(l)) || lines[0] || null;
}

async function info(d) {
  const where = await sys.run('cmd', ['/c', 'where', d.bin], 10000);
  const installed = where.code === 0;
  let version = null;
  if (installed) {
    const v = await sys.run('cmd', ['/c', d.bin, '--version'], 20000);
    if (v.code === 0) version = pickVersion(v.stdout || v.stderr);
  }
  return { id: d.id, name: d.name, npm: d.npm, installed, version, note: d.note };
}

async function list() {
  return Promise.all(DEFS.map(info));
}

// npm 전역 설치. 출력은 줄 단위로 harness:log에 흘린다.
async function install(id) {
  const d = def(id);
  if (!d) throw new Error(`알 수 없는 하네스: ${id}`);

  const args = ['/c', 'npm', 'install', '-g', `${d.npm}@latest`];
  log(`npm install -g ${d.npm}@latest`);
  const code = await new Promise((resolve) => {
    const child = spawn('cmd', args, { windowsHide: true });
    let buf = '';
    const pipe = (stream) => {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const l of lines) if (l.trim()) log(l.trim());
      });
    };
    pipe(child.stdout);
    pipe(child.stderr);
    child.on('error', (e) => {
      log(`설치 실패: ${e.message}`);
      resolve(-1);
    });
    child.on('close', (c) => {
      if (buf.trim()) log(buf.trim());
      resolve(c);
    });
  });
  log(code === 0 ? `${d.name} 설치 끝` : `${d.name} 설치 실패 (종료코드 ${code})`);
  return info(d);
}

// 작업 폴더. 비어 있으면 설치 폴더 아래 workspace를 쓴다.
// 이 값은 화면에서 사용자가 자유롭게 입력한다. 아래 launchTerminal이 콘솔 창을
// cmd.exe의 start로 띄우는데, 인자 배열로 넘겨도 cmd가 명령줄을 다시 해석하기 때문에
// & | ^ % < > " 같은 문자가 그대로 들어가면 다른 명령이 함께 실행될 수 있다.
// 앱이 관리자 권한으로 돌아가므로 설치 경로(config.installDirError)와 같은 기준으로 막는다.
// 한글과 공백은 허용한다.
function resolveWorkDir(cfg, workDir) {
  const raw = workDir && String(workDir).trim() ? String(workDir).trim() : path.join(cfg.installDir, 'workspace');
  const dir = path.resolve(raw);
  if (!/^[A-Za-z]:[\\/]/.test(dir)) {
    throw new Error('작업 폴더는 C:\\work 처럼 드라이브 문자로 시작해야 한다');
  }
  const bad = dir.slice(2).match(config.FORBIDDEN_PATH_CHARS);
  if (bad) throw new Error(`작업 폴더에 쓸 수 없는 문자: ${JSON.stringify(bad[0])}`);
  // 검사를 통과한 뒤에만 만든다. 검사 전에 만들면 이상한 이름의 폴더가 남는다.
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.statSync(dir).isDirectory()) throw new Error('작업 폴더가 폴더가 아니다');
  return dir;
}

function qwenSettingsPath() {
  return path.join(os.homedir(), '.qwen', 'settings.json');
}

// llama-server를 OpenAI 호환 공급자로 등록한 설정을 기존 값에 얹는다.
// 사용자가 쓰던 다른 키는 그대로 두고 같은 id의 항목만 갱신한다.
function mergeQwenSettings(prev, model) {
  const entries = [
    { id: 'qwen38', name: 'Qwen3.8 (llama-server)', baseUrl: BASE_URL, envKey: 'OPENAI_API_KEY' },
    { id: 'qwen36', name: 'Qwen3.6 (llama-server)', baseUrl: BASE_URL, envKey: 'OPENAI_API_KEY' }
  ];
  const base = prev && typeof prev === 'object' ? prev : {};
  const providers = { ...(base.modelProviders || {}) };
  const openai = Array.isArray(providers.openai) ? providers.openai.slice() : [];
  for (const e of entries) {
    const i = openai.findIndex((x) => x && x.id === e.id);
    if (i >= 0) openai[i] = { ...openai[i], ...e };
    else openai.push(e);
  }
  providers.openai = openai;
  const security = { ...(base.security || {}) };
  security.auth = { ...(security.auth || {}), selectedType: 'openai' };
  return {
    ...base,
    modelProviders: providers,
    security,
    model: { ...(base.model || {}), name: model }
  };
}

// [전언: Qwen Code 공식 문서] 설정 파일은 ~/.qwen/settings.json.
// OpenCode 전역 설정. llama-server를 프로바이더로 등록하고 plan은 3.8, build는 3.6을 쓴다.
// 기존 파일은 .bak으로 남기고 통째로 덮어쓴다. 사용자가 손본 다른 프로바이더는 보존하지 않는다.
function opencodeConfig(ctx, model) {
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      'llama.cpp': {
        npm: '@ai-sdk/openai-compatible',
        name: 'llama-server (local)',
        options: { baseURL: BASE_URL },
        models: {
          qwen38: { name: 'Qwen3.8 Flash Next (계획/리뷰)', limit: { context: ctx, output: 16384 } },
          qwen36: { name: 'Qwen3.6 35B (실행)', limit: { context: ctx, output: 16384 } }
        }
      }
    },
    model: `llama.cpp/${model}`,
    agent: {
      plan: { model: 'llama.cpp/qwen38' },
      build: { model: 'llama.cpp/qwen36' }
    }
  };
}

async function writeOpencodeConfig(ctx, model) {
  const dir = path.join(os.homedir(), '.config', 'opencode');
  const file = path.join(dir, 'opencode.json');
  await fsp.mkdir(dir, { recursive: true });
  try {
    await fsp.copyFile(file, `${file}.bak`);
  } catch {
    // 처음이면 백업할 파일이 없다
  }
  await fsp.writeFile(file, JSON.stringify(opencodeConfig(ctx, model), null, 2), 'utf8');
  return file;
}

// 기존 파일이 있으면 .bak으로 한 부 남기고 병합한다.
async function writeQwenSettings(model) {
  const file = qwenSettingsPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  let prev = null;
  try {
    const raw = await fsp.readFile(file, 'utf8');
    await fsp.writeFile(`${file}.bak`, raw, 'utf8');
    prev = JSON.parse(raw);
  } catch {
    // 파일이 없거나 JSON이 깨졌으면 새로 만든다
  }
  await fsp.writeFile(file, JSON.stringify(mergeQwenSettings(prev, model), null, 2), 'utf8');
  return file;
}

/**
 * 콘솔 창을 실제로 띄운다. 서버 상태는 보지 않으므로 검증용으로도 쓴다.
 * 경로에 공백이 있을 수 있어 명령 문자열을 조립하지 않고 인자 배열로 넘긴다.
 */
async function launchTerminal(id, opts, cfg) {
  const d = def(id);
  if (!d) return { ok: false, error: `알 수 없는 하네스: ${id}` };

  const model = (opts && opts.model) || 'qwen38';
  let workDir;
  try {
    workDir = resolveWorkDir(cfg, opts && opts.workDir);
  } catch (e) {
    log(`작업 폴더 거부: ${e.message}`);
    return { ok: false, error: e.message };
  }

  try {
    if (d.id === 'qwen-code') log(`Qwen Code 설정 갱신: ${await writeQwenSettings(model)}`);
    if (d.id === 'opencode') log(`OpenCode 설정 갱신: ${await writeOpencodeConfig(cfg.ctx, model)}`);
  } catch (e) {
    return { ok: false, error: `설정 파일을 쓰지 못함: ${e.message}` };
  }

  // workDir은 위에서 검증했다. title과 bin은 이 파일 안의 상수라 외부 입력이 아니다.
  const title = `llmbench ${d.name}`;
  const args = ['/c', 'start', title, '/D', workDir, 'cmd', '/k', d.bin];
  try {
    const child = spawn('cmd', args, {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        OPENAI_BASE_URL: BASE_URL,
        OPENAI_API_KEY: API_KEY,
        OPENAI_MODEL: model
      }
    });
    child.unref();
  } catch (e) {
    return { ok: false, error: `콘솔 창을 띄우지 못함: ${e.message}` };
  }
  log(`${d.name} 실행: ${workDir} (모델 ${model})`);
  return { ok: true, error: null };
}

async function launch(id, opts, cfg) {
  const d = def(id);
  if (!d) return { ok: false, error: `알 수 없는 하네스: ${id}` };
  if (!(await info(d)).installed) {
    return { ok: false, error: `${d.name}이 설치돼 있지 않다. 설치를 먼저 한다.` };
  }
  if (server.status().state !== 'ready') {
    return { ok: false, error: 'llama-server가 준비되지 않았다. 서버 탭에서 먼저 시작한다.' };
  }
  return launchTerminal(id, opts, cfg);
}

module.exports = {
  list,
  install,
  launch,
  launchTerminal,
  onLog,
  mergeQwenSettings,
  opencodeConfig,
  qwenSettingsPath,
  DEFS
};
