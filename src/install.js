'use strict';
// setup.ps1의 설치 절차를 Node로 옮긴 것.
// 6단계를 순서대로 돌리고 진행 상황을 이벤트로 알린다. 이미 있는 산출물은 건너뛴다.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');
const sys = require('./sys');

const REPO_38 = 'unsloth/Qwen3.8-Flash-Next-GGUF';
const REPO_36 = 'unsloth/Qwen3.6-35B-A3B-GGUF';
const FILE_36 = 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf';
// 릴리스 자산명 예: llama-b10991-bin-win-cuda-13.4-x64.zip, cudart-llama-bin-win-cuda-13.4-x64.zip
// CUDA 버전은 릴리스마다 바뀌므로(13.3 → 13.4) 고정하지 않고 자산 목록에서 고른다.
const CUDA_ASSET_RE = /^llama-.*-bin-win-cuda-(\d+\.\d+)-x64\.zip$/;
// CUDA 13.x는 드라이버 580 이상, 12.x는 525 이상이 필요하다.
const CUDA_MIN_DRIVER = { 13: 580, 12: 525 };
// MTP는 본가에 아직 안 들어갔다(PR ggml-org#28243 미병합). unsloth 포크 프리빌드를 쓴다.
// 자산 이름: app-<tag>-windows-x64-cuda12-portable.zip. portable은 전 GPU 세대 커널 포함.
const UNSLOTH_ASSET_RE = /^app-.*-windows-x64-cuda(\d+)-portable\.zip$/;
// MTP 헤드는 저장소 MTP/ 폴더에 있다. 어떤 파일을 쓸지는 설정에서 고른다.
const MTP_DIR = 'MTP';
// bin 폴더가 어느 빌드인지 남긴다. MTP 설정을 바꾸면 빌드를 갈아야 하므로 이 파일로 판단한다.
const BUILD_INFO = 'llmbench-build.json';
// 다운로드가 진전 없이 연속 실패할 수 있는 횟수
const MAX_RETRY = 8;

const STEP_DEFS = [
  { id: 'llamacpp', label: 'llama.cpp CUDA 빌드' },
  { id: 'model38', label: 'Qwen3.8-Flash-Next 모델' },
  { id: 'model36', label: 'Qwen3.6-35B 모델' },
  { id: 'preset', label: 'llama-server 라우터 프리셋' },
  { id: 'runbat', label: 'run.bat 생성' }
];

const state = {
  running: false,
  steps: STEP_DEFS.map((s) => ({ ...s, status: 'pending', percent: null, detail: '' })),
  log: []
};

let listener = null;
let cancelled = false;
let child = null; // 현재 돌고 있는 자식 프로세스
const activeRequests = new Set(); // 내려받는 중인 요청 전부. 취소 때 한꺼번에 끊는다

function onProgress(cb) {
  listener = cb;
}

function emit() {
  if (listener) listener(status());
}

function status() {
  return {
    running: state.running,
    steps: state.steps.map((s) => ({ ...s })),
    log: state.log.slice(-200)
  };
}

function log(line) {
  const t = new Date().toTimeString().slice(0, 8);
  state.log.push(`[${t}] ${line}`);
  if (state.log.length > 400) state.log = state.log.slice(-200);
  emit();
}

function step(id) {
  return state.steps.find((s) => s.id === id);
}

function setStep(id, patch) {
  Object.assign(step(id), patch);
  emit();
}

function fmtGB(bytes) {
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)}MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}

function fmtMBps(bps) {
  return `${(bps / 1024 ** 2).toFixed(0)}MB/s`;
}

class Cancelled extends Error {
  constructor() {
    super('사용자가 취소함');
  }
}

function throwIfCancelled() {
  if (cancelled) throw new Cancelled();
}

// ---------- HTTP ----------

function httpGet(url, opts = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('리다이렉트가 너무 많음'));
    const req = https.get(url, { headers: { 'User-Agent': 'llmbench', ...(opts.headers || {}) } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpGet(new URL(res.headers.location, url).toString(), opts, redirects + 1));
      }
      const ok = opts.okStatus || [200];
      if (!ok.includes(res.statusCode)) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('120초간 데이터 없음')));
    activeRequests.add(req);
    req.on('close', () => activeRequests.delete(req));
  });
}

async function getJson(url) {
  const res = await httpGet(url, { headers: { Accept: 'application/json' } });
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// 파일을 내려받으며 진행률을 알린다. Content-Length가 없으면 percent는 null로 둔다.
// resumeFrom이 있으면 Range로 이어받는다(서버가 206을 주면 append, 200이면 처음부터).
async function download(url, dest, onTick, resumeFrom = 0) {
  const headers = resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {};
  const res = await httpGet(url, { headers, okStatus: [200, 206] });
  const resumed = res.statusCode === 206 && resumeFrom > 0;
  const total = parseInt(res.headers['content-length'] || '0', 10) + (resumed ? resumeFrom : 0);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest, { flags: resumed ? 'a' : 'w' });
  let got = resumed ? resumeFrom : 0;
  let lastTick = Date.now();
  let lastGot = got;

  await new Promise((resolve, reject) => {
    const fail = (e) => {
      out.destroy();
      res.destroy();
      reject(e);
    };
    res.on('data', (c) => {
      got += c.length;
      const now = Date.now();
      if (now - lastTick >= 500) {
        const bps = ((got - lastGot) * 1000) / (now - lastTick);
        lastTick = now;
        lastGot = got;
        if (onTick) onTick(got, total, bps);
      }
      if (cancelled) fail(new Cancelled());
    });
    res.on('error', fail);
    out.on('error', fail);
    out.on('finish', resolve);
    res.pipe(out);
  }).catch(async (e) => {
    // 끊기거나 취소돼도 받은 만큼은 남긴다. 다음 시도가 그 지점부터 이어받는다.
    await new Promise((r) => out.close(r));
    throw e;
  });

  return { bytes: got, total };
}

// ---------- 분할 병렬 다운로드 ----------
// HF CDN은 연결 하나당 속도가 제한된다. 큰 파일을 CONNS개 구간으로 나눠 동시에 받는다.
// 구간별 진행은 <파일>.parts.json에 남겨 끊겨도 구간마다 이어받는다.
// 파일은 미리 크기를 잡지 않는다. 뒷구간이 먼저 써지면 stat 크기가 전체와 같아질 수 있으므로
// 완료 판단은 크기가 아니라 parts 파일이 없는지로 한다.

const CONNS = 4;
const MIN_PART = 64 * 1024 * 1024; // 이보다 작은 파일은 나누지 않는다

function partsPath(dest) {
  return `${dest}.parts.json`;
}

async function readParts(dest, size) {
  try {
    const p = JSON.parse(await fsp.readFile(partsPath(dest), 'utf8'));
    if (p && p.size === size && Array.isArray(p.parts)) return p.parts;
  } catch {
    // 없거나 깨졌으면 새로 만든다
  }
  // 순차 방식으로 받다 만 파일이 있으면 앞에서부터 받은 만큼을 구간에 배분한다
  let have = 0;
  try {
    have = (await fsp.stat(dest)).size;
  } catch {
    have = 0;
  }
  if (have > size) have = 0;
  const n = size >= MIN_PART * 2 ? CONNS : 1;
  const len = Math.ceil(size / n);
  const parts = [];
  for (let i = 0; i < n; i++) {
    const start = i * len;
    const end = Math.min(size, start + len);
    if (start >= size) break;
    parts.push({ start, end, have: Math.max(0, Math.min(end - start, have - start)) });
  }
  return parts;
}

async function writeParts(dest, size, parts) {
  await fsp.writeFile(partsPath(dest), JSON.stringify({ size, parts }), 'utf8');
}

// 한 구간을 이어받는다. 끊기면 진전이 있는 한 계속 재시도한다.
async function downloadPart(url, fd, part, onChunk) {
  let attempt = 0;
  for (;;) {
    throwIfCancelled();
    if (part.have >= part.end - part.start) return;
    const from = part.start + part.have;
    const before = part.have;
    try {
      const res = await httpGet(url, { headers: { Range: `bytes=${from}-${part.end - 1}` }, okStatus: [206] });
      await new Promise((resolve, reject) => {
        const fail = (e) => {
          res.destroy();
          reject(e);
        };
        let pos = from;
        res.on('data', (c) => {
          if (cancelled) return fail(new Cancelled());
          res.pause();
          fs.write(fd, c, 0, c.length, pos, (err) => {
            if (err) return fail(err);
            pos += c.length;
            part.have += c.length;
            onChunk(c.length);
            res.resume();
          });
        });
        res.on('error', fail);
        res.on('end', resolve);
      });
      return;
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      attempt = part.have > before ? 0 : attempt + 1;
      if (attempt >= MAX_RETRY) throw new Error(`구간 ${fmtGB(part.start)}~ ${MAX_RETRY}회 연속 실패: ${e.message}`);
      const wait = Math.min(30, 2 ** attempt) * 1000;
      log(`   끊김(구간 ${fmtGB(part.start)}~): ${e.message}. ${wait / 1000}초 뒤 다시 (${attempt}/${MAX_RETRY})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function downloadParallel(url, dest, size, onTick) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const parts = await readParts(dest, size);
  await writeParts(dest, size, parts);
  const fd = fs.openSync(dest, fs.existsSync(dest) ? 'r+' : 'w+');
  let got = parts.reduce((a, p) => a + p.have, 0);
  let lastTick = Date.now();
  let lastGot = got;
  let lastSave = Date.now();
  const onChunk = (n) => {
    got += n;
    const now = Date.now();
    if (now - lastTick >= 500) {
      const bps = ((got - lastGot) * 1000) / (now - lastTick);
      lastTick = now;
      lastGot = got;
      if (onTick) onTick(got, size, bps);
    }
    if (now - lastSave >= 2000) {
      lastSave = now;
      writeParts(dest, size, parts).catch(() => {});
    }
  };
  try {
    await Promise.all(parts.map((p) => downloadPart(url, fd, p, onChunk)));
  } catch (e) {
    await writeParts(dest, size, parts).catch(() => {});
    throw e;
  } finally {
    fs.closeSync(fd);
  }
  await fsp.unlink(partsPath(dest)).catch(() => {});
  return { bytes: got, total: size };
}

// ---------- 서브프로세스 ----------

function killTree(p) {
  if (!p || p.killed || p.exitCode !== null) return;
  // 쉘을 거쳐 뜬 자식까지 같이 정리한다
  spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {
    try {
      p.kill();
    } catch {
      // 이미 죽은 경우
    }
  });
}

// 자식 프로세스를 돌리고 출력을 로그에 넣는다. 0이 아닌 종료코드면 예외.
function exec(file, args, opts = {}) {
  throwIfCancelled();
  return new Promise((resolve, reject) => {
    const p = spawn(file, args, { windowsHide: true, ...opts });
    child = p;
    const pipe = (stream) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (d) => {
        buf += d;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const l of lines) if (l.trim()) log(`   ${l.trim()}`);
      });
    };
    pipe(p.stdout);
    pipe(p.stderr);
    p.on('error', (e) => {
      child = null;
      reject(e);
    });
    p.on('close', (code) => {
      child = null;
      if (cancelled) return reject(new Cancelled());
      if (code === 0) return resolve();
      reject(new Error(`${file} 종료코드 ${code}`));
    });
  });
}

// ---------- 1. llama.cpp ----------

// 드라이버가 지원하는 CUDA 자산이 있는 최신 릴리스와 그 자산 두 개(빌드, cudart)를 고른다.
// driverVersion은 nvidia-smi가 준 문자열(예: "591.86"). 모르면 12.x를 우선한다.
async function pickRelease(driverVersion) {
  const driverMajor = parseInt(String(driverVersion || '0'), 10) || 0;
  const rels = await getJson('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=8');
  if (!Array.isArray(rels)) {
    throw new Error(`GitHub 릴리스 조회 실패: ${(rels && rels.message) || '응답 형식 이상'}`);
  }
  for (const r of rels) {
    const candidates = [];
    for (const a of r.assets || []) {
      const m = CUDA_ASSET_RE.exec(a.name);
      if (!m) continue;
      const cudaMajor = parseInt(m[1], 10);
      const cudart = (r.assets || []).find((c) => c.name === `cudart-llama-bin-win-cuda-${m[1]}-x64.zip`);
      const supported = driverMajor === 0 ? cudaMajor === 12 : driverMajor >= (CUDA_MIN_DRIVER[cudaMajor] || Infinity);
      if (cudart && supported) candidates.push({ cuda: m[1], asset: a, cudart });
    }
    if (candidates.length) {
      // 드라이버가 되면 높은 CUDA 버전을 쓴다
      candidates.sort((x, y) => parseFloat(y.cuda) - parseFloat(x.cuda));
      return { release: r, ...candidates[0] };
    }
  }
  throw new Error(`최근 릴리스에 드라이버 ${driverVersion || '?'}가 지원하는 윈도우 CUDA 빌드가 없음`);
}

// unsloth 포크 최신 릴리스에서 드라이버에 맞는 windows cuda portable 자산을 고른다.
async function pickUnslothRelease(driverVersion) {
  const driverMajor = parseInt(String(driverVersion || '0'), 10) || 0;
  const rels = await getJson('https://api.github.com/repos/unslothai/llama.cpp/releases?per_page=5');
  if (!Array.isArray(rels)) {
    throw new Error(`unsloth 릴리스 조회 실패: ${(rels && rels.message) || '응답 형식 이상'}`);
  }
  for (const r of rels) {
    const candidates = [];
    for (const a of r.assets || []) {
      const m = UNSLOTH_ASSET_RE.exec(a.name);
      if (!m) continue;
      const cudaMajor = parseInt(m[1], 10);
      const supported = driverMajor === 0 ? cudaMajor === 12 : driverMajor >= (CUDA_MIN_DRIVER[cudaMajor] || Infinity);
      if (supported) candidates.push({ cuda: String(cudaMajor), asset: a });
    }
    if (candidates.length) {
      candidates.sort((x, y) => parseFloat(y.cuda) - parseFloat(x.cuda));
      return { release: r, ...candidates[0] };
    }
  }
  throw new Error(`unsloth 릴리스에 드라이버 ${driverVersion || '?'}가 지원하는 윈도우 CUDA 빌드가 없음`);
}

// zip 안 어디에 있든 llama-server.exe가 있는 폴더를 찾는다
async function findServerDir(root) {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    const entries = await fsp.readdir(d, { withFileTypes: true }).catch(() => []);
    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === 'llama-server.exe')) return d;
    for (const e of entries) if (e.isDirectory()) stack.push(path.join(d, e.name));
  }
  return null;
}

async function downloadUnsloth(binDir, onTick, driverVersion) {
  const pick = await pickUnslothRelease(driverVersion);
  const tag = pick.release.tag_name;
  log(`   unsloth 릴리스 ${tag}, CUDA ${pick.cuda} (MTP 지원)`);
  const zip = path.join(os.tmpdir(), pick.asset.name);
  log(`   ${pick.asset.name}`);
  await download(pick.asset.browser_download_url, zip, (got, total, bps) => {
    if (onTick) onTick(0, 2, got, total, bps);
  });
  const tmp = path.join(os.tmpdir(), `llmbench-unsloth-${Date.now()}`);
  await extractZip(zip, tmp);
  await fsp.unlink(zip).catch(() => {});
  const srcDir = await findServerDir(tmp);
  if (!srcDir) throw new Error('unsloth zip 안에서 llama-server.exe를 못 찾음');
  await fsp.rm(binDir, { recursive: true, force: true });
  await fsp.cp(srcDir, binDir, { recursive: true });
  await fsp.rm(tmp, { recursive: true, force: true });

  // unsloth zip에는 cudart·cublas DLL이 없어 GPU를 못 잡는다(--list-devices가 none). 본가 릴리스의
  // cudart zip을 같은 폴더에 풀어 넣는다. 본가와 같은 규칙으로 고르므로 CUDA 주버전이 맞는다.
  const up = await pickRelease(driverVersion);
  log(`   CUDA 런타임: ${up.cudart.name} (본가 ${up.release.tag_name})`);
  const czip = path.join(os.tmpdir(), up.cudart.name);
  await download(up.cudart.browser_download_url, czip, (got, total, bps) => {
    if (onTick) onTick(1, 2, got, total, bps);
  });
  await extractZip(czip, binDir);
  await fsp.unlink(czip).catch(() => {});
  return tag;
}

async function readBuildInfo(binDir) {
  try {
    return JSON.parse(await fsp.readFile(path.join(binDir, BUILD_INFO), 'utf8'));
  } catch {
    return null;
  }
}

// 윈도우 10 이상의 내장 tar가 zip을 푼다. 실패하면 Expand-Archive로 재시도.
// 경로는 명령 문자열에 넣지 않고 환경변수로 넘긴다. 문자열로 조립하면 경로에 들어간
// 따옴표나 세미콜론이 powershell 명령으로 해석될 수 있다.
const EXPAND_PS = 'Expand-Archive -LiteralPath $env:LLMBENCH_ZIP -DestinationPath $env:LLMBENCH_DEST -Force';

async function extractZip(zip, dest) {
  await fsp.mkdir(dest, { recursive: true });
  try {
    await exec('tar', ['-xf', zip, '-C', dest]);
  } catch (e) {
    if (e instanceof Cancelled) throw e;
    log(`   tar 실패, Expand-Archive로 재시도: ${e.message}`);
    await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', EXPAND_PS], {
      env: { ...process.env, LLMBENCH_ZIP: zip, LLMBENCH_DEST: dest }
    });
  }
}

/**
 * llama.cpp CUDA 빌드와 cudart를 binDir에 푼다.
 * 설치 단계에서도 쓰고, 단독으로 호출해 검증할 수도 있다.
 */
async function downloadLlamaCpp(binDir, onTick, driverVersion) {
  const pick = await pickRelease(driverVersion);
  const tag = pick.release.tag_name;
  log(`   릴리스 ${tag}, CUDA ${pick.cuda}`);
  const assets = [pick.asset, pick.cudart];
  for (let i = 0; i < assets.length; i++) {
    throwIfCancelled();
    const asset = assets[i];
    const zip = path.join(os.tmpdir(), asset.name);
    log(`   ${asset.name}`);
    await download(asset.browser_download_url, zip, (got, total, bps) => {
      if (onTick) onTick(i, assets.length, got, total, bps);
    });
    await extractZip(zip, binDir);
    await fsp.unlink(zip).catch(() => {});
  }
  return tag;
}

async function stepLlamaCpp(cfg) {
  const bin = path.join(cfg.installDir, 'bin');
  const have = await readBuildInfo(bin);
  const haveSource = have ? have.source : fs.existsSync(path.join(bin, 'llama-server.exe')) ? 'upstream' : null;
  // MTP를 끄더라도 이미 unsloth 빌드가 있으면 그대로 쓴다. unsloth 빌드는 본가 기능을 다 갖고
  // 있어서 본가로 되돌리면 400MB를 다시 받을 뿐이다.
  const want = cfg.mtp || haveSource === 'unsloth' ? 'unsloth' : 'upstream';
  if (haveSource === want) {
    setStep('llamacpp', { status: 'skipped', detail: `이미 설치됨 (${want}${have && have.tag ? ' ' + have.tag : ''})` });
    return;
  }
  if (haveSource) log(`   빌드 교체: ${haveSource} → ${want}`);
  setStep('llamacpp', { status: 'running', percent: 0, detail: '릴리스 확인 중' });
  const gpu = await sys.queryGpu().catch(() => null);
  const onTick = (idx, count, got, total, bps) => {
    const pct = total ? (got / total) * 100 : 0;
    setStep('llamacpp', {
      percent: Math.round((idx * 100 + pct) / count),
      detail: `${fmtGB(got)} / ${total ? fmtGB(total) : '?'}  ${fmtMBps(bps)}`
    });
  };
  let tag;
  if (want === 'unsloth') {
    tag = await downloadUnsloth(bin, onTick, gpu && gpu.driver);
  } else {
    await fsp.rm(bin, { recursive: true, force: true });
    tag = await downloadLlamaCpp(bin, onTick, gpu && gpu.driver);
  }
  await fsp.writeFile(path.join(bin, BUILD_INFO), JSON.stringify({ source: want, tag }), 'utf8');
  setStep('llamacpp', { status: 'done', percent: 100, detail: `${want} ${tag}` });
}

// ---------- 2~3. 모델 ----------

// HF 파일 목록과 크기. 진행률 분모와 재실행 시 건너뛰기 판정에 쓴다.
async function hfTree(repo, folder) {
  const url = `https://huggingface.co/api/models/${repo}/tree/main${folder ? '/' + folder : ''}`;
  const list = await getJson(url);
  return list
    .filter((e) => e.type === 'file')
    .map((e) => ({ path: e.path, size: (e.lfs && e.lfs.size) || e.size || 0 }));
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else {
      try {
        total += (await fsp.stat(p)).size;
      } catch {
        // 받는 중에 사라지는 임시파일은 무시
      }
    }
  }
  return total;
}

// 받은 파일이 목록과 크기까지 같으면 다시 받을 것이 없다.
async function allFilesPresent(localDir, files) {
  for (const f of files) {
    try {
      const st = await fsp.stat(path.join(localDir, f.path));
      if (f.size && st.size !== f.size) return false;
      if (fs.existsSync(partsPath(path.join(localDir, f.path)))) return false;
    } catch {
      return false;
    }
  }
  return files.length > 0;
}

// HF 파일을 직접 받는다. huggingface_hub(Python)를 쓰지 않는다. 사용자 Python 환경을 건드리지 않고,
// CLI 모듈 경로가 버전마다 바뀌는 문제도 피한다. 부분 파일은 Range로 이어받는다.
async function hfDownload(stepId, repo, folder, fileName, localDir) {
  const files = await hfTree(repo, folder);
  // folder 하위 파일은 path가 'folder/파일'로 오므로 끝부분으로 비교한다
  const wanted = fileName ? files.filter((f) => f.path === fileName || f.path.endsWith('/' + fileName)) : files;
  if (!wanted.length) throw new Error(`${repo}에서 받을 파일을 못 찾음`);
  const totalBytes = wanted.reduce((a, f) => a + f.size, 0);

  if (await allFilesPresent(localDir, wanted)) {
    setStep(stepId, { status: 'skipped', percent: 100, detail: `이미 받음 ${fmtGB(totalBytes)}` });
    return;
  }

  setStep(stepId, { status: 'running', percent: 0, detail: `합계 ${fmtGB(totalBytes)}` });
  let doneBytes = 0;
  for (const f of wanted) {
    throwIfCancelled();
    const dest = path.join(localDir, f.path);
    let have = 0;
    try {
      have = (await fsp.stat(dest)).size;
    } catch {
      have = 0;
    }
    if (f.size && have === f.size && !fs.existsSync(partsPath(dest))) {
      doneBytes += f.size;
      continue;
    }
    if (have > f.size) {
      // 크기가 더 크면 망가진 파일. 처음부터 받는다.
      await fsp.unlink(dest).catch(() => {});
      await fsp.unlink(partsPath(dest)).catch(() => {});
      have = 0;
    }
    const url = `https://huggingface.co/${repo}/resolve/main/${f.path}`;
    // 수십 GB 한 파일을 한 연결로 받으면 느리고 CDN이 중간에 끊는 일이 잦다.
    // 구간 4개로 나눠 동시에 받고, 끊기면 구간마다 받은 지점부터 이어받는다.
    log(`   ${f.path}${have ? ` (${fmtGB(have)}부터 이어받기)` : ''}`);
    await downloadParallel(url, dest, f.size, (got, _total, bps) => {
      const bytes = doneBytes + got;
      setStep(stepId, {
        percent: totalBytes ? Math.min(100, Math.round((bytes / totalBytes) * 100)) : null,
        detail: `${fmtGB(bytes)} / ${fmtGB(totalBytes)}  ${fmtMBps(bps)}  (${path.basename(f.path)}, ${CONNS}연결)`
      });
    });
    doneBytes += f.size;
  }
  setStep(stepId, { status: 'done', percent: 100, detail: fmtGB(await dirSize(localDir)) });
}

// 0.3.0과 0.3.1은 MTP 파일을 qwen38/MTP/MTP 아래에 받았다. 그 파일이 있으면 제자리로 옮긴다.
// 받다 만 파일도 같이 옮겨 이어받기를 살린다.
async function moveStrayMtp(models, name) {
  const strayDir = path.join(models, 'qwen38', 'MTP', 'MTP');
  const destDir = path.join(models, 'qwen38', 'MTP');
  if (!fs.existsSync(path.join(strayDir, name))) return;
  log('   이전 버전이 받아 둔 MTP 파일을 제자리로 옮긴다');
  for (const f of [name, `${name}.parts.json`]) {
    const from = path.join(strayDir, f);
    if (!fs.existsSync(from)) continue;
    await fsp.rename(from, path.join(destDir, f)).catch((e) => log(`   옮기지 못함 ${f}: ${e.message}`));
  }
  await fsp.rmdir(strayDir).catch(() => {});
}

async function stepModels(cfg) {
  const models = path.join(cfg.installDir, 'models');
  await hfDownload('model38', REPO_38, cfg.quant, null, path.join(models, 'qwen38'));
  if (cfg.mtp) {
    // MTP 헤드는 저장소 MTP/ 폴더에 따로 있다. 양자화와 무관하게 하나만 쓴다.
    // 받는 경로에 저장소 폴더명이 그대로 붙으므로 qwen38까지만 넘긴다.
    await moveStrayMtp(models, cfg.mtpFile);
    await hfDownload('model38', REPO_38, MTP_DIR, cfg.mtpFile, path.join(models, 'qwen38'));
  }
  await hfDownload('model36', REPO_36, null, FILE_36, path.join(models, 'qwen36'));
}

// ---------- 4. 프리셋 ----------

// 분할 모델의 첫 조각을 찾는다. llama.cpp는 이 파일만 주면 나머지 조각을 알아서 읽는다.
// 못 찾으면 엉뚱한 gguf를 고르지 않고 실패시킨다.
async function findShard(dir) {
  const entries = await fsp.readdir(dir).catch(() => []);
  const first = entries.filter((f) => /-00001-of-.*\.gguf$/i.test(f)).sort()[0];
  return first ? path.join(dir, first) : null;
}

async function stepPreset(cfg) {
  setStep('preset', { status: 'running', detail: '모델 경로 확인' });
  const models = path.join(cfg.installDir, 'models');
  const m38 = await findShard(path.join(models, 'qwen38', cfg.quant));
  const m36 = path.join(models, 'qwen36', FILE_36);
  if (!m38 || !fs.existsSync(m36)) throw new Error('모델 파일을 못 찾음');
  if (cfg.mtp && !fs.existsSync(path.join(models, 'qwen38', MTP_DIR, cfg.mtpFile))) {
    throw new Error('MTP 사이드카 파일을 못 찾음');
  }

  // 3.8은 MoE 전문가 전체를 CPU RAM에, 3.6은 20GB라 일부만 CPU로 내린다
  const ini = [
    'version = 1',
    '',
    '[*]',
    `c = ${cfg.ctx}`,
    `t = ${cfg.threads}`,
    'ngl = 99',
    'fa = on',
    'ctk = q8_0',
    'ctv = q8_0',
    'b = 2048',
    'ub = 512',
    'jinja = true',
    `load-mode = ${cfg.loadMode}`,
    `poll = ${cfg.poll}`,
    // cpu-strict는 0 또는 1만 받는다. true로 쓰면 인자 파싱에서 죽는다.
    ...(cfg.cpuMask ? [`cpu-mask = ${cfg.cpuMask}`, 'cpu-strict = 1'] : []),
    'temp = 1.0',
    'top-p = 0.95',
    'top-k = 20',
    'min-p = 0',
    '',
    '[qwen38]',
    `model = ${m38}`,
    `n-cpu-moe = ${cfg.ncmoe38}`,
    // MTP 드래프트. 헤드는 GPU에 두고 초안 2개까지 검증한다. unsloth 빌드에서만 인식된다.
    ...(cfg.mtp ? [
      `model-draft = ${path.join(models, 'qwen38', MTP_DIR, cfg.mtpFile)}`,
      'spec-type = draft-mtp',
      'spec-draft-n-max = 2'
    ] : []),
    'load-on-startup = true',
    '',
    '[qwen36]',
    `model = ${m36}`,
    'n-cpu-moe = 20',
    'temp = 0.7',
    'top-p = 0.8',
    `load-on-startup = ${cfg.autoLoad36 ? 'true' : 'false'}`,
    ''
  ].join('\n');

  await fsp.writeFile(path.join(cfg.installDir, 'models.ini'), ini, 'utf8');
  setStep('preset', { status: 'done', detail: 'models.ini 작성' });
}

// ---------- 5. run.bat ----------

async function stepRunBat(cfg) {
  const file = path.join(cfg.installDir, 'run.bat');
  if (fs.existsSync(file)) {
    setStep('runbat', { status: 'skipped', detail: '이미 있음' });
    return;
  }
  setStep('runbat', { status: 'running', detail: '' });
  const bin = path.join(cfg.installDir, 'bin');
  // 배치 파일은 시스템 코드페이지로 읽히므로 UTF-8로 저장하고 chcp 65001을 먼저 준다.
  // ascii로 저장하면 한글 경로와 안내 문구가 깨진다.
  const bat = [
    '@echo off',
    'chcp 65001 >nul',
    `cd /d "${bin}"`,
    'echo llama-server 라우터 기동. 두 모델 RAM 로드에 몇 분 걸림.',
    'echo 준비되면 llmbench 하네스 탭에서 코딩 CLI를 연다.',
    `llama-server.exe --models-preset "${path.join(cfg.installDir, 'models.ini')}" --models-max 2 --host 127.0.0.1 --port 8080`,
    'pause',
    ''
  ].join('\r\n');
  await fsp.writeFile(file, bat, 'utf8');
  setStep('runbat', { status: 'done', detail: file });
}

// ---------- 진행 ----------

async function runAll(cfg) {
  const plan = [
    ['llamacpp', () => stepLlamaCpp(cfg)],
    ['model38', () => stepModels(cfg)], // model36까지 한 번에 처리한다
    ['preset', () => stepPreset(cfg)],
    ['runbat', () => stepRunBat(cfg)]
  ];
  try {
    await fsp.mkdir(path.join(cfg.installDir, 'bin'), { recursive: true });
    await fsp.mkdir(path.join(cfg.installDir, 'models'), { recursive: true });
    log(`설치 위치 ${cfg.installDir}  양자화 ${cfg.quant}  스레드 ${cfg.threads}  컨텍스트 ${cfg.ctx}`);
    for (const [id, fn] of plan) {
      throwIfCancelled();
      log(state.steps.find((s) => s.id === id).label);
      await fn();
    }
    log('설치 끝. run.bat 또는 서버 탭에서 llama-server를 띄우면 된다.');
  } catch (e) {
    // 취소하면 소켓 abort, 프로세스 kill 등 여러 형태의 오류로 올라온다.
    // 오류 종류로 구분하지 않고 취소 요청이 있었는지로 판단한다.
    const byCancel = cancelled || e instanceof Cancelled;
    const failing = state.steps.find((s) => s.status === 'running') || state.steps.find((s) => s.status === 'pending');
    if (failing) {
      failing.status = byCancel ? 'pending' : 'error';
      failing.percent = null;
      failing.detail = byCancel ? '취소됨' : e.message;
    }
    log(byCancel ? '취소됨' : `실패: ${e.message}`);
  } finally {
    state.running = false;
    emit();
  }
}

/**
 * 점검 결과로 설치를 시작해도 되는지 판단한다.
 * fail이 하나라도 있으면 막는다. warn만 있으면 사용자가 확인(allowWarn)해야 진행한다.
 * skipAdmin은 승격을 건너뛰고 띄운 경우에만 true.
 */
function gate(report, opts, skipAdmin) {
  const fails = report.items.filter((i) => i.status === 'fail' && !(skipAdmin && i.id === 'admin'));
  if (fails.length) {
    return { blocked: true, reason: `점검에서 막힌 항목: ${fails.map((i) => i.label).join(', ')}` };
  }
  const warns = report.items.filter((i) => i.status === 'warn');
  if (warns.length && !(opts && opts.allowWarn)) {
    return { blocked: true, reason: `주의 항목 확인 필요: ${warns.map((i) => i.label).join(', ')}` };
  }
  return { blocked: false, reason: null };
}

function start(cfg) {
  if (state.running) return { started: false };
  cancelled = false;
  state.running = true;
  state.log = [];
  state.steps = STEP_DEFS.map((s) => ({ ...s, status: 'pending', percent: null, detail: '' }));
  emit();
  runAll(cfg);
  return { started: true };
}

function cancel() {
  if (!state.running) return;
  cancelled = true;
  log('취소 요청. 실행 중인 작업을 정리한다.');
  killTree(child);
  for (const r of activeRequests) r.destroy(new Cancelled());
}

// 설정 기준으로 두 모델의 gguf 경로와 CPU로 내릴 전문가 수를 돌려준다. 없는 파일은 null.
// llama-bench도 models.ini와 같은 조건으로 돌리기 위해 여기서 한 번에 정의한다.
async function modelPaths(cfg) {
  const models = path.join(cfg.installDir, 'models');
  const m38 = await findShard(path.join(models, 'qwen38', cfg.quant));
  const m36 = path.join(models, 'qwen36', FILE_36);
  return {
    qwen38: { file: m38, ncmoe: cfg.ncmoe38 },
    qwen36: { file: fs.existsSync(m36) ? m36 : null, ncmoe: 20 }
  };
}

module.exports = {
  start,
  modelPaths,
  gate,
  cancel,
  status,
  onProgress,
  downloadLlamaCpp,
  hfDownload,
  extractZip,
  findShard,
  pickRelease,
  hfTree,
  moveStrayMtp,
  stepPreset,
  pickUnslothRelease,
  findServerDir,
  downloadParallel,
  readParts,
  STEP_DEFS
};
