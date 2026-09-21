'use strict';
// config.json 로드/저장. 저장 위치는 electron userData, 순수 node로 돌릴 때는 AppData/Roaming/llmbench.

const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const sys = require('./sys');

function userDataDir() {
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      return electron.app.getPath('userData');
    }
  } catch {
    // electron 밖에서 require하면 문자열(실행파일 경로)이 오거나 예외가 난다
  }
  return path.join(os.homedir(), 'AppData', 'Roaming', 'llmbench');
}

function configPath() {
  return path.join(userDataDir(), 'config.json');
}

// 물리 P코어 수. Win32_Processor의 NumberOfCores는 하이브리드 CPU에서 P+E 합계를 주므로
// P/E 구분이 불가능하다. 코어가 16개 이상이면 8로 제한한다(13900K는 P코어 8개).
// 값이 맞지 않으면 설정 화면에서 threads를 직접 바꿔 비교하면 된다.
function defaultThreads(cores) {
  if (!cores || cores < 1) return 8;
  return cores >= 16 ? 8 : cores;
}

function defaults(cores) {
  return {
    installDir: 'C:\\llm\\qwen',
    quant: 'UD-Q4_K_XL',
    threads: defaultThreads(cores),
    ctx: 65536,
    kwhPrice: 150,
    // 3.6을 서버 시작 시 같이 올릴지. RAM이 두 모델 합계보다 작으면 끄는 게 낫다.
    autoLoad36: true,
    // MTP 드래프트(스펙큘레이티브 디코딩). 켜면 llama.cpp를 unsloth 빌드로 받고 MTP 사이드카(2.6GB)를 추가로 받는다.
    mtp: false,
    mtpFile: MTP_FILES[0],
    // mmap은 파일을 걸어 두고 필요할 때 읽는다. none은 전부 RAM으로 읽어 둔다.
    // 모델이 RAM에 들어가면 none이 더 빠를 수 있다.
    loadMode: 'mmap',
    // 3.8 전문가를 CPU에 두는 층 수. 99면 전부 CPU. 줄이면 뒷층 전문가가 VRAM으로 가서 조금 빨라진다.
    ncmoe38: 99,
    // llama-server --poll (0~100). 튜닝 벤치로 고른 값을 넣는다. 50이 llama.cpp 기본값.
    poll: 50,
    // llama-server --cpu-mask. 빈 문자열이면 안 준다. 튜닝 벤치가 P코어 마스크(예: 0xFFFF)를 찾아 준다.
    cpuMask: ''
  };
}

// 아래로 갈수록 작고 빠르지만 품질이 떨어진다. Q2_K_XL·IQ1_M은 속도 실험용이다.
// MTP 드래프트 헤드 파일. shared는 타깃 모델의 임베딩을 빌려 쓰는데 양자화가 다르면
// 텐서 형상이 안 맞아 서버가 죽는다. IQ3에서는 자체 임베딩을 가진 쪽을 쓴다.
const MTP_FILES = [
  'mtp-Qwen3.8-Flash-Next-Q4_K_M.gguf',
  'mtp-Qwen3.8-Flash-Next-Q8_0.gguf',
  'mtp-Qwen3.8-Flash-Next-BF16.gguf',
  'mtp-Qwen3.8-Flash-Next-shared-Q4_K_M.gguf',
  'mtp-Qwen3.8-Flash-Next-shared-Q8_0.gguf',
  'mtp-Qwen3.8-Flash-Next-shared-BF16.gguf'
];
const LOAD_MODES = ['mmap', 'none'];

const QUANTS = ['UD-Q4_K_XL', 'UD-Q3_K_XL', 'UD-IQ3_XXS', 'UD-Q2_K_XL', 'UD-IQ1_M'];

// 설치 경로는 배치 파일과 powershell 명령에 들어가므로 명령으로 해석될 수 있는 문자를 막는다.
// 한글과 공백은 허용한다.
const FORBIDDEN_PATH_CHARS = /["'&|;`$%<>^*?\r\n\t]/;

function installDirError(v) {
  if (typeof v !== 'string' || !v.trim()) return '설치 경로가 비었음';
  const s = v.trim();
  if (!/^[A-Za-z]:[\\/]/.test(s)) return '설치 경로는 C:\\llm\\qwen 처럼 드라이브 문자로 시작해야 함';
  const bad = s.slice(2).match(FORBIDDEN_PATH_CHARS);
  if (bad) return `설치 경로에 쓸 수 없는 문자: ${JSON.stringify(bad[0])}`;
  return null;
}

let cache = null;

function sanitize(base, partial) {
  const c = { ...base };
  if (typeof partial.installDir === 'string' && !installDirError(partial.installDir)) {
    c.installDir = partial.installDir.trim();
  }
  if (QUANTS.includes(partial.quant)) c.quant = partial.quant;
  if (Number.isFinite(partial.threads) && partial.threads >= 1 && partial.threads <= 128) {
    c.threads = Math.floor(partial.threads);
  }
  if (Number.isFinite(partial.ctx) && partial.ctx >= 2048) c.ctx = Math.floor(partial.ctx);
  if (Number.isFinite(partial.kwhPrice) && partial.kwhPrice >= 0) c.kwhPrice = partial.kwhPrice;
  if (typeof partial.autoLoad36 === 'boolean') c.autoLoad36 = partial.autoLoad36;
  if (typeof partial.mtp === 'boolean') c.mtp = partial.mtp;
  if (MTP_FILES.includes(partial.mtpFile)) c.mtpFile = partial.mtpFile;
  if (LOAD_MODES.includes(partial.loadMode)) c.loadMode = partial.loadMode;
  if (Number.isFinite(partial.ncmoe38) && partial.ncmoe38 >= 0 && partial.ncmoe38 <= 99) c.ncmoe38 = Math.floor(partial.ncmoe38);
  if (Number.isFinite(partial.poll) && partial.poll >= 0 && partial.poll <= 100) c.poll = Math.floor(partial.poll);
  if (typeof partial.cpuMask === 'string' && /^(0x[0-9a-fA-F]{1,16})?$/.test(partial.cpuMask)) c.cpuMask = partial.cpuMask;
  return c;
}

async function get() {
  if (cache) return cache;
  const hw = await sys.getHwInfo();
  const base = defaults(hw.cpu.cores);
  let saved = {};
  try {
    saved = JSON.parse(await fsp.readFile(configPath(), 'utf8'));
  } catch {
    // 파일이 없으면 기본값으로 시작한다
  }
  cache = sanitize(base, saved || {});
  return cache;
}

async function set(partial) {
  const cur = await get();
  // 잘못된 설치 경로는 조용히 무시하지 않고 알린다. 설정 화면에서 그대로 보여주면 된다.
  if (partial && partial.installDir !== undefined) {
    const err = installDirError(partial.installDir);
    if (err) throw new Error(err);
  }
  cache = sanitize(cur, partial || {});
  await fsp.mkdir(path.dirname(configPath()), { recursive: true });
  await fsp.writeFile(configPath(), JSON.stringify(cache, null, 2), 'utf8');
  return cache;
}

module.exports = { get, set, configPath, userDataDir, defaultThreads, installDirError, FORBIDDEN_PATH_CHARS, QUANTS, MTP_FILES, LOAD_MODES };
