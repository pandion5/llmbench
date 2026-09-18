'use strict';
// 하드웨어 정보, 실시간 스냅샷, 사전 점검을 만든다.
// 외부 패키지를 쓰지 않고 powershell / nvidia-smi 서브프로세스로 값을 읽는다.

const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const GB = 1024 * 1024 * 1024;

// 양자화별 설치 드라이브 최소 여유 공간(GB). setup.ps1과 같은 값.
const DISK_NEED_GB = { 'UD-Q4_K_XL': 140, 'UD-Q3_K_XL': 120, 'UD-IQ3_XXS': 110, 'UD-Q2_K_XL': 105, 'UD-IQ1_M': 100 };

// 명령 실행. 실패해도 예외를 던지지 않고 종료코드와 출력을 그대로 넘긴다.
function run(file, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || '')
        });
      }
    );
  });
}

function ps(script, timeout = 30000) {
  return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], timeout);
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// 관리자 권한 여부. net session은 관리자가 아니면 접근 거부로 0이 아닌 코드를 준다.
async function isAdmin() {
  const r = await run('net', ['session'], 8000);
  return r.code === 0;
}

// CPU, RAM, 드라이브 목록을 한 번의 powershell 호출로 읽는다.
// 드라이브 문자 → MediaType은 Get-PhysicalDisk와 Get-Partition을 이어 붙여 구한다.
const SYS_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$media = @{}
foreach ($d in Get-PhysicalDisk) {
  foreach ($p in (Get-Partition -DiskNumber $d.DeviceId)) {
    if ($p.DriveLetter) { $media[[string]$p.DriveLetter] = [string]$d.MediaType }
  }
}
$drives = @()
foreach ($v in (Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3")) {
  $L = $v.DeviceID.Substring(0,1)
  $m = $media[$L]
  if ($m -ne 'SSD' -and $m -ne 'HDD') { $m = 'Unknown' }
  $drives += [pscustomobject]@{
    letter = $L
    freeGB = [math]::Round($v.FreeSpace / 1GB, 1)
    totalGB = [math]::Round($v.Size / 1GB, 1)
    media = $m
  }
}
$mem = @(Get-CimInstance Win32_PhysicalMemory)
[pscustomobject]@{
  cpuName = [string]$cpu.Name
  cores = [int]$cpu.NumberOfCores
  threads = [int]$cpu.NumberOfLogicalProcessors
  ramGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
  ramModules = [int]$mem.Count
  ramSpeedMTs = [int](($mem | Measure-Object -Property Speed -Minimum).Minimum)
  ramCapacityGB = [math]::Round((($mem | Measure-Object -Property Capacity -Sum).Sum) / 1GB, 1)
  drives = @($drives)
} | ConvertTo-Json -Depth 4 -Compress
`;

// 메모리 대역폭 근사. 채널당 64bit(8바이트)이므로 채널수 × 8 × MT/s / 1000 = GB/s.
// [추정] 채널 수는 못 읽어서 모듈 수로 근사한다. 데스크톱 보드는 슬롯이 4개여도
// 듀얼채널이라 모듈이 4개 이상이면 2채널로 잡는다(이 PC: DDR5-4800 4모듈 → 76.8GB/s).
// ponytail: 4채널 이상인 HEDT/서버에서는 과소평가된다.
// 정확히 하려면 Win32_PhysicalMemory의 BankLabel/DeviceLocator를 파싱해야 한다.
function estimateBandwidth(modules, speedMTs) {
  if (!modules || !speedMTs) return null;
  const channels = modules >= 4 ? 2 : modules;
  return round1((channels * 8 * speedMTs) / 1000);
}

async function getCimInfo() {
  const r = await ps(SYS_PS);
  try {
    const o = JSON.parse(r.stdout.trim());
    return {
      cpu: {
        name: o.cpuName || os.cpus()[0]?.model || 'Unknown CPU',
        cores: o.cores || os.cpus().length,
        threads: o.threads || os.cpus().length
      },
      ramGB: o.ramGB || round1(os.totalmem() / GB),
      ram: {
        totalGB: o.ramCapacityGB || o.ramGB || round1(os.totalmem() / GB),
        speedMTs: o.ramSpeedMTs || null,
        modules: o.ramModules || 0,
        bandwidthGBps: estimateBandwidth(o.ramModules, o.ramSpeedMTs)
      },
      drives: Array.isArray(o.drives) ? o.drives : [o.drives].filter(Boolean)
    };
  } catch {
    // powershell이 막혔을 때의 최소 대체값
    const totalGB = round1(os.totalmem() / GB);
    return {
      cpu: { name: os.cpus()[0]?.model || 'Unknown CPU', cores: os.cpus().length, threads: os.cpus().length },
      ramGB: totalGB,
      ram: { totalGB, speedMTs: null, modules: 0, bandwidthGBps: null },
      drives: []
    };
  }
}

async function queryGpu() {
  const r = await run(
    'nvidia-smi',
    [
      '--query-gpu=name,memory.total,memory.used,utilization.gpu,power.draw,temperature.gpu,driver_version',
      '--format=csv,noheader,nounits'
    ],
    10000
  );
  if (r.code !== 0) return null;
  const line = r.stdout.trim().split(/\r?\n/)[0];
  if (!line) return null;
  const f = line.split(',').map((s) => s.trim());
  if (f.length < 7) return null;
  return {
    name: f[0],
    memTotalMB: num(f[1]),
    memUsedMB: num(f[2]),
    utilPct: num(f[3]),
    powerW: num(f[4]),
    tempC: num(f[5]),
    driver: f[6]
  };
}

// 존재하는 가장 가까운 상위 폴더를 찾는다. 설치 폴더가 아직 없을 때 드라이브 루트로 올라간다.
function existingAncestor(p) {
  let d = path.resolve(p);
  while (!fs.existsSync(d)) {
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return d;
}

const SSD_TEST_BYTES = 256 * 1024 * 1024;
const driveSpeedCache = new Map();

// 256MB 파일을 한 번 쓰고 한 번 읽어 대략의 속도를 잰다.
// ponytail: 읽기 값은 OS 페이지 캐시 영향을 받아 실제 디스크 읽기보다 높게 나온다.
// SSD/HDD 구분 용도로만 쓴다. 정확한 값이 필요해지면 winsat disk로 교체.
async function measureDrive(installDir) {
  let dir = existingAncestor(installDir);
  const letter = dir.slice(0, 1).toUpperCase();
  const buf = Buffer.alloc(SSD_TEST_BYTES, 0x5a);
  const mb = SSD_TEST_BYTES / (1024 * 1024);

  for (const target of [dir, os.tmpdir()]) {
    if (!target) continue;
    // 대체 경로는 같은 드라이브일 때만 의미가 있다
    if (target !== dir && target.slice(0, 1).toUpperCase() !== letter) continue;
    const file = path.join(target, `llmbench-diskcheck-${process.pid}.tmp`);
    try {
      let fh = await fsp.open(file, 'w');
      const t0 = Date.now();
      await fh.write(buf, 0, buf.length, 0);
      await fh.datasync();
      const writeMs = Math.max(1, Date.now() - t0);
      await fh.close();

      fh = await fsp.open(file, 'r');
      const t1 = Date.now();
      await fh.read(buf, 0, buf.length, 0);
      const readMs = Math.max(1, Date.now() - t1);
      await fh.close();

      return {
        letter,
        writeMBps: Math.round(mb / (writeMs / 1000)),
        readMBps: Math.round(mb / (readMs / 1000))
      };
    } catch {
      // 쓰기 권한이 없으면 다음 후보로
    } finally {
      await fsp.unlink(file).catch(() => {});
    }
  }
  return null;
}

// 점검에서 잰 드라이브 속도와 마지막 벤치 요약. 스냅샷 카드에 쓴다.
let lastSsd = null;
let lastBench = null;

function setLastBench(summary) {
  lastBench = summary;
}

async function measureDriveCached(installDir) {
  const letter = path.resolve(installDir).slice(0, 1).toUpperCase();
  if (!driveSpeedCache.has(letter)) {
    driveSpeedCache.set(letter, await measureDrive(installDir));
  }
  lastSsd = driveSpeedCache.get(letter);
  return lastSsd;
}

/**
 * HwInfo를 만든다. installDir을 주면 그 드라이브의 간이 속도까지 잰다(드라이브별 1회 캐시).
 */
async function getHwInfo(installDir) {
  const [cim, gpu] = await Promise.all([getCimInfo(), queryGpu()]);
  const ssd = installDir ? await measureDriveCached(installDir) : null;
  return {
    gpu: gpu ? { name: gpu.name, vramMB: gpu.memTotalMB, driver: gpu.driver } : null,
    cpu: cim.cpu,
    ramGB: cim.ramGB,
    ram: cim.ram,
    drives: cim.drives,
    ssd
  };
}

// os.cpus() 누적 tick 차이로 CPU 사용률을 낸다. 첫 호출은 기준점만 잡고 0을 준다.
let prevCpuTicks = null;
function cpuPercent() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  const cur = { idle, total };
  const prev = prevCpuTicks;
  prevCpuTicks = cur;
  if (!prev) return 0;
  const dt = cur.total - prev.total;
  const di = cur.idle - prev.idle;
  if (dt <= 0) return 0;
  return round1(Math.min(100, Math.max(0, (1 - di / dt) * 100)));
}

function driveFreeGB(dirOrLetter) {
  const letter = path.resolve(dirOrLetter).slice(0, 1).toUpperCase();
  try {
    const st = fs.statfsSync(`${letter}:\\`);
    return round1((st.bavail * st.bsize) / GB);
  } catch {
    return 0;
  }
}

async function getSnapshot(installDir) {
  const dir = installDir || 'C:\\';
  const gpu = await queryGpu();
  return {
    ts: Date.now(),
    gpu: gpu
      ? {
          utilPct: gpu.utilPct,
          memUsedMB: gpu.memUsedMB,
          memTotalMB: gpu.memTotalMB,
          powerW: gpu.powerW,
          tempC: gpu.tempC
        }
      : null,
    ram: {
      usedGB: round1((os.totalmem() - os.freemem()) / GB),
      totalGB: round1(os.totalmem() / GB)
    },
    cpuPct: cpuPercent(),
    disk: { letter: path.resolve(dir).slice(0, 1).toUpperCase(), freeGB: driveFreeGB(dir) },
    ssd: lastSsd,
    lastBench
  };
}

async function hasCommand(file, args) {
  const r = await run(file, args, 10000);
  return r.code === 0 ? (r.stdout + r.stderr).trim().split(/\r?\n/)[0] : null;
}

/**
 * 사전 점검. CONTRACT의 9개 항목을 모두 채운다.
 * cfg는 config.js가 만든 설정 객체.
 */
async function runCheck(cfg) {
  const installDir = (cfg && cfg.installDir) || 'C:\\llm\\qwen';
  const quant = (cfg && cfg.quant) || 'UD-Q4_K_XL';
  const [hw, admin, nodeVer] = await Promise.all([
    getHwInfo(installDir),
    isAdmin(),
    hasCommand('node', ['--version'])
  ]);

  const letter = path.resolve(installDir).slice(0, 1).toUpperCase();
  const drive = hw.drives.find((d) => d.letter === letter) || null;
  const freeGB = drive ? drive.freeGB : driveFreeGB(installDir);
  const needGB = DISK_NEED_GB[quant] || 140;
  const vramGB = hw.gpu ? hw.gpu.vramMB / 1024 : 0;
  const media = drive ? drive.media : hw.ssd ? 'Unknown' : 'Unknown';

  const items = [
    {
      id: 'admin',
      label: '관리자 권한',
      status: admin ? 'pass' : 'fail',
      value: admin ? '있음' : '없음',
      need: '설치 폴더 생성과 npm 전역 설치에 필요'
    },
    {
      id: 'gpu',
      label: 'NVIDIA GPU',
      status: hw.gpu ? 'pass' : 'fail',
      value: hw.gpu ? hw.gpu.name : '없음',
      need: 'NVIDIA GPU'
    },
    {
      id: 'vram',
      label: 'VRAM',
      status: vramGB >= 12 ? 'pass' : vramGB >= 8 ? 'warn' : 'fail',
      value: hw.gpu ? `${round1(vramGB)}GB` : '없음',
      need: '12GB 이상 권장, 8GB 미만이면 속도가 많이 떨어짐'
    },
    {
      id: 'ram',
      label: '시스템 RAM',
      status: hw.ramGB >= 64 ? 'pass' : hw.ramGB >= 32 ? 'warn' : 'fail',
      value: `${hw.ramGB}GB`,
      need: 'MoE 전문가를 CPU에 올리므로 64GB 이상 권장'
    },
    {
      id: 'disk',
      label: `설치 드라이브 여유 (${letter}:)`,
      status: freeGB >= needGB ? 'pass' : 'fail',
      value: `${round1(freeGB)}GB`,
      need: `${quant} 기준 ${needGB}GB 이상`
    },
    {
      id: 'ssd',
      label: '설치 드라이브 종류',
      status: media === 'SSD' ? 'pass' : 'warn',
      value: hw.ssd ? `${media} (쓰기 ${hw.ssd.writeMBps}MB/s)` : media,
      need: 'HDD면 모델 로드에 수 분 더 걸림'
    },
    {
      id: 'node',
      label: 'Node.js',
      status: nodeVer ? 'pass' : 'fail',
      value: nodeVer || '없음',
      need: 'OpenCode를 npm으로 설치'
    },
    {
      id: 'nvidia_driver',
      label: 'NVIDIA 드라이버',
      status: hw.gpu && hw.gpu.driver ? 'pass' : 'fail',
      value: hw.gpu && hw.gpu.driver ? hw.gpu.driver : '없음',
      need: 'nvidia-smi가 동작해야 함'
    }
  ];

  return { ok: items.every((i) => i.status === 'pass'), items, hw };
}

module.exports = {
  run,
  ps,
  isAdmin,
  getHwInfo,
  getSnapshot,
  queryGpu,
  runCheck,
  setLastBench,
  driveFreeGB,
  DISK_NEED_GB
};
