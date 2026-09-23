'use strict';
// 코딩 에이전트 CLI(하네스)를 앱 안 터미널에서 띄운다.
// 설치 여부 확인, npm 전역 설치, 터미널 시작을 맡는다. 화면 표시는 렌더러가 한다.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const sys = require('./sys');
const terminal = require('./terminal');
const server = require('./server');
const proxy = require('./proxy');
const config = require('./config');

// npm 전역 설치본은 .cmd 래퍼라 Node 22에서 shell 없이 spawn하면 EINVAL이 난다.
// 그래서 확인·설치·실행 모두 cmd /c를 거친다.
// 맨 위가 기본으로 쓰는 하네스다. 화면 표도 이 순서로 그린다.
const DEFS = [
  {
    id: 'openclaude',
    name: 'OpenClaude',
    npm: '@gitlawb/openclaude',
    bin: 'openclaude',
    note: '기본. Claude Code 계열 CLI. 설정 파일 없이 환경변수로 llama-server를 가리킨다.',
    // 이 CLI는 OpenAI 호환 모드를 켜야 OPENAI_BASE_URL을 본다.
    // 첨부 헤더는 요청마다 바뀌는 글을 시스템 프롬프트 맨 앞에 넣어 프롬프트 캐시를 깬다. 끈다.
    // 기본 타임아웃 2분이면 캐시 미스 때(프롬프트 전부 읽기 70~120초) 끊고 다시 보낸다. 10분으로 늘린다.
    // git 상태 스냅샷은 세션마다 달라서 새 세션 첫 턴이 캐시를 못 탄다. 커밋 안내문과 함께 뺀다.
    // 터미널 제목을 짓는 요청이 매 턴 본 요청보다 먼저 간다. 로컬 모델은 64토큰 한도를 생각으로 다 써서
    // 제목이 비고 다음 턴에 또 보낸다. 그동안 본 요청이 매 턴 4초쯤 기다려서 끈다.
    // 자동 메모리를 켜면 시스템 프롬프트에 안내 3천여 토큰이 들어가고, 그 첫 줄에 계정 이름이 든 폴더 경로가 있다.
    // 사용자마다 프롬프트가 앞쪽에서 갈라져 서로의 캐시 상태를 지우므로 끈다.
    extraEnv: {
      CLAUDE_CODE_USE_OPENAI: '1',
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      API_TIMEOUT_MS: '600000'
    },
    // 켜면 파일을 고칠 때마다 묻지 않는다. 대신 확인 없이 고치고 명령을 돌린다.
    skipFlag: '--dangerously-skip-permissions'
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    npm: 'opencode-ai',
    bin: 'opencode',
    note: '터미널 TUI. 터미널 열기 때 전역 opencode.json에 llama-server 프로바이더를 써 넣는다.'
  }
];

// 기본 하네스. 화면에서 따로 안 고르면 이걸 쓴다.
const DEFAULT_HARNESS = 'openclaude';

// 하네스도 프록시를 거친다. 그래야 기록이 남고 같은 줄에 선다.
const BASE_URL = `http://127.0.0.1:${proxy.PORT}/v1`;
// 공유를 켜면 llama-server에 키가 걸린다. 그때는 그 키를 넘겨야 한다.
const API_KEY = 'local';

function currentApiKey() {
  const h = server.authHeaders();
  return h.Authorization ? h.Authorization.replace(/^Bearer /, '') : API_KEY;
}

// OpenClaude 상태줄의 달러 값은 실제 청구가 아니다. 내장 단가표에 Claude 모델만
// 있어서 모르는 이름은 입력 100만 토큰당 5달러, 출력 25달러로 계산해 버린다.
// 로컬 모델은 돈이 안 드니 그 모델의 단가를 0으로 적어 둔다.
// OpenClaude는 Claude Code와 폴더를 나눠 쓴다. 설정은 ~/.openclaude/settings.json, 전역 상태는 ~/.openclaude.json.
const OPENCLAUDE_DIR = path.join(os.homedir(), '.openclaude');

async function writeClaudePricing(model) {
  const dir = OPENCLAUDE_DIR;
  const file = path.join(dir, 'settings.json');
  let cur = {};
  try {
    cur = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    // 파일이 없으면 새로 만든다. 읽었는데 깨진 것이면 덮어쓰지 않고 그만둔다.
    if (e.code !== 'ENOENT') throw new Error(`settings.json을 읽지 못했다: ${e.message}`);
  }
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) {
    throw new Error('settings.json 모양이 객체가 아니다');
  }
  cur.modelPricing = Object.assign({}, cur.modelPricing, {
    [model]: {
      inputTokens: 0,
      outputTokens: 0,
      promptCacheReadTokens: 0,
      promptCacheWriteTokens: 0
    }
  });
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(file, JSON.stringify(cur, null, 2), 'utf8');
  await writeOpenclaudeGlobal();
  return file;
}

// cmd에 넘길 명령 한 줄. 허가 건너뛰기를 켜면 인자를 붙인다.
function launchCommand(d, skip) {
  return skip && d.skipFlag ? `${d.bin} ${d.skipFlag}` : d.bin;
}

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

// OpenCode 전역 설정. llama-server를 프로바이더로 등록한다. plan과 build 모두 고른 모델을 쓴다.
// 서버가 한 번에 한 모델만 올리니 에이전트별로 모델이 다르면 오갈 때마다 다시 올린다.
// 기존 파일은 .bak으로 남기고 통째로 덮어쓴다. 사용자가 손본 다른 프로바이더는 보존하지 않는다.
function opencodeConfig(ctx, model, baseUrl, apiKey) {
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      'llama.cpp': {
        npm: '@ai-sdk/openai-compatible',
        name: 'llama-server (local)',
        // OpenCode는 환경변수를 안 보고 여기 적힌 키를 쓴다. 비면 프록시가 401을 돌려준다.
        options: Object.assign({ baseURL: baseUrl || BASE_URL }, apiKey ? { apiKey } : {}),
        models: {
          qwen38: { name: 'Qwen3.8 Flash Next', limit: { context: ctx, output: 16384 } },
          qwen36: { name: 'Qwen3.6 35B', limit: { context: ctx, output: 16384 } }
        }
      }
    },
    model: `llama.cpp/${model}`,
    // 스킬 목록은 시스템 프롬프트에 통째로 들어간다. 스킬이 많은 PC는 1만 3천 토큰이 넘어서
    // 캐시가 빗나가면 1분 넘게 더 읽는다. 최상위 권한이라 plan과 build 모두 빠진다.
    permission: { skill: 'deny' },
    agent: {
      plan: { model: `llama.cpp/${model}` },
      build: { model: `llama.cpp/${model}` },
      // 첫 질문 앞에 세션 제목을 짓는 요청이 간다. 생각을 켜 두면 수백 토큰을 생각하느라 본 요청이 7~21초 기다린다.
      title: { options: { reasoningEffort: 'none' } }
    }
  };
}

async function writeOpencodeConfig(ctx, model, baseUrl, apiKey) {
  const dir = path.join(os.homedir(), '.config', 'opencode');
  const file = path.join(dir, 'opencode.json');
  await fsp.mkdir(dir, { recursive: true });
  try {
    await fsp.copyFile(file, `${file}.bak`);
  } catch {
    // 처음이면 백업할 파일이 없다
  }
  await fsp.writeFile(file, JSON.stringify(opencodeConfig(ctx, model, baseUrl, apiKey), null, 2), 'utf8');
  return file;
}

// OpenClaude 전역 상태 파일. knowledgeGraph가 켜져 있으면 둘째 턴부터 시스템 프롬프트 끝에
// "MULTI-TURN CONTEXT TRACKING"과 "RETRIEVED MEMORY" 블록을 턴마다 다르게 써 넣는다. 그러면
// 프롬프트 앞부분이 매 턴 바뀌어 llama-server 캐시를 하나도 못 타고 2만 토큰을 다시 읽는다. 끈다.
// 이 파일에는 로그인 상태도 들어 있으니 읽은 것에 한 키만 얹어 쓴다. 깨진 파일이면 건드리지 않는다.
async function writeOpenclaudeGlobal() {
  const file = path.join(os.homedir(), '.openclaude.json');
  let cur = {};
  try {
    cur = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`.openclaude.json을 읽지 못했다: ${e.message}`);
  }
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) throw new Error('.openclaude.json 모양이 객체가 아니다');
  if (cur.knowledgeGraphEnabled === false) return file;
  cur.knowledgeGraphEnabled = false;
  await fsp.writeFile(file, JSON.stringify(cur, null, 2), 'utf8');
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
    if (d.id === 'opencode') log(`OpenCode 설정 갱신: ${await writeOpencodeConfig(cfg.ctx, model, undefined, currentApiKey())}`);
    if (d.id === 'openclaude') log(`비용 표시 0으로 설정: ${await writeClaudePricing(model)}`);
  } catch (e) {
    return { ok: false, error: `설정 파일을 쓰지 못함: ${e.message}` };
  }

  const skip = !!(opts && opts.skipPermissions);

  // workDir은 위에서 검증했다. bin은 이 파일 안의 상수라 외부 입력이 아니다.
  // cmd /k로 띄워서 CLI가 끝나도 터미널은 남는다.
  try {
    terminal.start(id, {
      args: ['/k', launchCommand(d, skip)],
      cwd: workDir,
      cols: (opts && opts.cols) || 100,
      rows: (opts && opts.rows) || 30,
      env: {
        OPENAI_BASE_URL: BASE_URL,
        OPENAI_API_KEY: currentApiKey(),
        OPENAI_MODEL: model,
        ...(d.extraEnv || {})
      }
    });
  } catch (e) {
    return { ok: false, error: `터미널을 띄우지 못함: ${e.message}` };
  }
  log(`${d.name} 실행: ${workDir} (모델 ${model}${skip ? ', 허가 묻지 않음' : ''})`);
  return { ok: true, error: null, term: id };
}

/**
 * 다른 PC의 llama-server를 보고 띄운다. 클라이언트 앱이 쓴다.
 * target은 { baseUrl, apiKey }. 작업 폴더는 사용자가 고른 것을 그대로 쓴다.
 */
async function launchRemote(id, opts, target) {
  const d = def(id);
  if (!d) return { ok: false, error: `알 수 없는 하네스: ${id}` };
  if (!(await info(d)).installed) {
    return { ok: false, error: `${d.name}이 설치돼 있지 않다. 설치를 먼저 한다.` };
  }

  const model = (opts && opts.model) || 'qwen38';
  // 폴더를 안 고르면 홈에서 시작해 하네스가 홈을 어지른다. 고르게 한다.
  const workDir = (opts && opts.workDir) || '';
  if (!workDir) return { ok: false, error: '작업 폴더를 먼저 고른다.' };
  if (!fs.existsSync(workDir)) return { ok: false, error: `작업 폴더가 없다: ${workDir}` };

  const v1 = `${target.baseUrl}/v1`;
  try {
    if (d.id === 'opencode') log(`OpenCode 설정 갱신: ${await writeOpencodeConfig((opts && opts.ctx) || 65536, model, v1, target.apiKey)}`);
    if (d.id === 'openclaude') log(`비용 표시 0으로 설정: ${await writeClaudePricing(model)}`);
  } catch (e) {
    return { ok: false, error: `설정 파일을 쓰지 못함: ${e.message}` };
  }

  const skip = !!(opts && opts.skipPermissions);

  try {
    terminal.start(id, {
      args: ['/k', launchCommand(d, skip)],
      cwd: workDir,
      cols: (opts && opts.cols) || 100,
      rows: (opts && opts.rows) || 30,
      env: {
        OPENAI_BASE_URL: v1,
        OPENAI_API_KEY: target.apiKey || 'local',
        OPENAI_MODEL: model,
        ...(d.extraEnv || {})
      }
    });
  } catch (e) {
    return { ok: false, error: `터미널을 띄우지 못함: ${e.message}` };
  }
  log(`${d.name} 실행: ${workDir} (모델 ${model}, 서버 ${target.baseUrl}${skip ? ', 허가 묻지 않음' : ''})`);
  return { ok: true, error: null, term: id };
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
  DEFAULT_HARNESS,
  list,
  install,
  launch,
  launchRemote,
  launchTerminal,
  onLog,
  opencodeConfig,
  DEFS
};
