'use strict';
// 자동 업데이트. 원격 update.json의 version이 package.json보다 높으면 zip을 받아
// src·package.json·문서를 바꿔치기하고 앱을 다시 띄운다. electron 본체(node_modules)는 건드리지 않는다.
// 포터블 폴더 구조를 그대로 두고 파일만 갈아 끼우는 방식이라 설치 프로그램이 없다.

const { app } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

// 릴리스마다 update.json과 zip을 GitHub Release에 올린다. latest 링크라 URL은 고정이다.
// 검증할 때는 LLMBENCH_UPDATE_URL로 바꿔 끼운다.
const DEFAULT_URL = 'https://github.com/pandion5/llmbench/releases/latest/download/update.json';
const UPDATE_URL = process.env.LLMBENCH_UPDATE_URL || DEFAULT_URL;
const TIMEOUT_MS = 10000;
// PATH에 GNU tar(git-bash)가 먼저 잡히면 zip을 못 푼다. 윈도우 내장 bsdtar를 직접 부른다.
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

let listeners = [];
let applying = false;

function onProgress(cb) {
  listeners.push(cb);
}
function emit(p) {
  for (const cb of listeners) cb(p);
}

function currentVersion() {
  return app.getVersion();
}

// "0.2.10" 같은 문자열을 숫자 배열로 비교한다. 문자가 섞이면 0으로 본다.
function compareVersion(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('리다이렉트가 너무 많음'));
    // 검증용 로컬 서버는 http라 프로토콜에 맞춰 고른다
    const mod = url.startsWith('http:') ? http : https;
    const req = mod.get(url, { headers: { 'User-Agent': 'llmbench-updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpGet(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`${TIMEOUT_MS / 1000}초간 응답 없음`)));
  });
}

async function fetchJson(url) {
  const res = await httpGet(url);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// 원격 정보를 읽어 현재 버전과 비교한다. 네트워크가 안 되면 available false에 error를 채운다.
async function check() {
  const current = currentVersion();
  try {
    const m = await fetchJson(UPDATE_URL);
    if (!m || typeof m.version !== 'string' || typeof m.zipUrl !== 'string' || typeof m.sha256 !== 'string') {
      throw new Error('update.json 형식이 다름');
    }
    return {
      current,
      latest: m.version,
      available: compareVersion(m.version, current) > 0,
      notes: typeof m.notes === 'string' ? m.notes : '',
      zipUrl: m.zipUrl,
      sha256: m.sha256.toLowerCase(),
      error: null
    };
  } catch (e) {
    return { current, latest: null, available: false, notes: '', zipUrl: null, sha256: null, error: e.message };
  }
}

async function downloadTo(url, dest, onTick) {
  const res = await httpGet(url);
  const total = parseInt(res.headers['content-length'] || '0', 10);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  const hash = crypto.createHash('sha256');
  let got = 0;
  await new Promise((resolve, reject) => {
    res.on('data', (c) => {
      got += c.length;
      hash.update(c);
      if (onTick) onTick(got, total);
    });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });
  return hash.digest('hex');
}

function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(file, args, { windowsHide: true, stdio: 'ignore', ...opts });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${file} 종료코드 ${code}`))));
  });
}

// 교체 배치. 앱이 끝날 때까지 기다린 뒤 staging 내용을 앱 폴더에 덮어쓰고 start.bat을 다시 띄운다.
// 경로는 배치 안에 문자열로 들어가므로 set으로 변수에 넣고 따옴표로 감싼다.
function applyScript(appDir, staging, pid) {
  return [
    '@echo off',
    'chcp 65001 >nul',
    `set "APP=${appDir}"`,
    `set "STG=${staging}"`,
    `set "PID=${pid}"`,
    ':wait',
    'tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul',
    'if not errorlevel 1 (',
    '  timeout /t 1 /nobreak >nul',
    '  goto wait',
    ')',
    // src는 통째로 맞춘다(삭제된 파일도 반영). 나머지는 파일 단위 복사.
    'robocopy "%STG%\\src" "%APP%\\src" /MIR /NFL /NDL /NJH /NJS /NP >nul',
    'if errorlevel 8 goto fail',
    'copy /Y "%STG%\\package.json" "%APP%\\package.json" >nul',
    'if exist "%STG%\\README.md" copy /Y "%STG%\\README.md" "%APP%\\README.md" >nul',
    'if exist "%STG%\\CONTRACT.md" copy /Y "%STG%\\CONTRACT.md" "%APP%\\CONTRACT.md" >nul',
    'if exist "%STG%\\start.bat" copy /Y "%STG%\\start.bat" "%APP%\\start.bat" >nul',
    'if exist "%STG%\\llmbench.vbs" copy /Y "%STG%\\llmbench.vbs" "%APP%\\llmbench.vbs" >nul',
    'rmdir /S /Q "%STG%" >nul 2>nul',
    // 콘솔 창 없이 다시 띄운다. vbs가 없으면 start.bat.
    'if exist "%APP%\\llmbench.vbs" (wscript "%APP%\\llmbench.vbs") else (start "" "%APP%\\start.bat")',
    'exit /b 0',
    ':fail',
    'echo 업데이트 파일 복사에 실패했다. %STG% 내용을 %APP%에 직접 복사한다.',
    'pause',
    'exit /b 1',
    ''
  ].join('\r\n');
}

// zip을 받아 검증하고 교체 배치를 띄운 뒤 앱을 끝낸다.
async function apply() {
  if (applying) throw new Error('업데이트가 이미 진행 중');
  applying = true;
  try {
    const info = await check();
    if (!info.available) throw new Error(info.error || '새 버전이 없음');

    const work = path.join(app.getPath('userData'), 'update');
    const staging = path.join(work, 'staging');
    const zip = path.join(work, `llmbench-update-${info.latest}.zip`);
    await fsp.rm(work, { recursive: true, force: true });
    await fsp.mkdir(staging, { recursive: true });

    emit({ stage: 'download', percent: 0, text: `${info.latest} 받는 중` });
    const sha = await downloadTo(info.zipUrl, zip, (got, total) => {
      emit({ stage: 'download', percent: total ? Math.round((got / total) * 100) : 0, text: `${info.latest} 받는 중` });
    });
    if (sha !== info.sha256) throw new Error(`sha256 불일치. 받은 파일을 버린다.\n기대 ${info.sha256}\n실제 ${sha}`);

    emit({ stage: 'extract', percent: 100, text: '압축 푸는 중' });
    await run(fs.existsSync(TAR) ? TAR : 'tar', ['-xf', zip, '-C', staging]);
    if (!fs.existsSync(path.join(staging, 'src', 'main.js')) || !fs.existsSync(path.join(staging, 'package.json'))) {
      throw new Error('업데이트 zip 안에 src/main.js 또는 package.json이 없음');
    }

    const appDir = app.getAppPath();
    const script = path.join(work, 'apply-update.cmd');
    await fsp.writeFile(script, applyScript(appDir, staging, process.pid), 'utf8');

    emit({ stage: 'restart', percent: 100, text: '앱을 다시 시작한다' });
    // Electron 자식은 Job 객체에 묶여 앱이 끝나면 같이 죽는다. powershell의 Start-Process로 띄우면
    // 셸이 만든 별도 프로세스라 살아남는다. powershell이 끝난 뒤 앱을 끝낸다.
    const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
    await run('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Start-Process -FilePath 'cmd.exe' -ArgumentList '/c',${quote(`"${script}"`)} -WindowStyle Minimized`
    ]);
    setTimeout(() => app.quit(), 300);
    return { ok: true, error: null };
  } catch (e) {
    emit({ stage: 'error', percent: 0, text: e.message });
    return { ok: false, error: e.message };
  } finally {
    applying = false;
  }
}

module.exports = { check, apply, onProgress, compareVersion, applyScript, UPDATE_URL };
