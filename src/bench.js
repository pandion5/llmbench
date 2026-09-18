'use strict';
// llama-server에 프롬프트를 스트리밍으로 보내고 속도와 전력을 잰다.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const sys = require('./sys');
const server = require('./server');

// 내장 프롬프트 3종. 짧은 질의, 코드 생성, 긴 추론.
const BUILTIN_PROMPTS = [
  '대한민국의 수도와 인구를 두 문장으로',
  'Python으로 CSV 파일을 읽어 열별 평균을 출력하는 함수 작성',
  '다음 요구사항으로 REST API를 설계하라: 사용자, 게시글, 댓글. 엔드포인트와 데이터 모델을 표로'
];
// 답변이 잘리지 않게 넉넉히 둔다. 모델이 끝내면 그 전에 멈춘다.
const MAX_TOKENS = 2048;
const TEMPERATURE = 0.7;

let controller = null;
let lastResult = null;
let listener = null;

function onProgress(cb) {
  listener = cb;
}

function emit(p) {
  if (listener) listener(p);
}

function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function round(n, d = 2) {
  const f = 10 ** d;
  return Math.round((Number.isFinite(n) ? n : 0) * f) / f;
}

// 벤치 구간 동안 GPU 전력과 사용률을 1초마다 모은다.
// 사용률은 판정에서 GPU 포화 여부를 보는 데 쓴다.
function startPowerSampler() {
  const samples = [];
  const utilSamples = [];
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    const gpu = await sys.queryGpu();
    if (gpu && gpu.powerW > 0) samples.push(gpu.powerW);
    if (gpu && Number.isFinite(gpu.utilPct)) utilSamples.push(gpu.utilPct);
    busy = false;
  };
  tick();
  const timer = setInterval(tick, 1000);
  return () => {
    clearInterval(timer);
    samples.utilPct = utilSamples;
    return samples;
  };
}

/**
 * 프롬프트 하나를 스트리밍으로 돌린다.
 * tok/s는 서버가 주는 timings를 쓰고, 없으면 측정한 시간으로 계산한다.
 */
async function runOne(prompt, model, idx, total, baseUrl) {
  const stopSampler = startPowerSampler();
  const t0 = Date.now();
  let powerSamples = [];
  let text = '';
  let tokens = 0;
  let timings = null;
  let lastEmit = 0;

  try {
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      stream: true,
      stream_options: { include_usage: true },
      // 이 옵션이 있어야 마지막 청크에 timings가 실린다
      timings_per_token: true
    });
    let res;
    try {
      res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error(`서버에 연결하지 못함 (${baseUrl}). llama-server가 떠 있는지 확인.`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());

    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        let obj;
        try {
          obj = JSON.parse(payload);
        } catch {
          continue;
        }
        if (obj.timings) timings = obj.timings;
        const delta = obj.choices && obj.choices[0] && obj.choices[0].delta;
        if (delta && delta.content) {
          text += delta.content;
          tokens += 1;
        }
      }
      const now = Date.now();
      if (now - lastEmit >= 200) {
        lastEmit = now;
        const secs = (now - t0) / 1000;
        emit({ promptIdx: idx, total, tokens, tokPerSec: round(secs > 0 ? tokens / secs : 0), text });
      }
    }
  } finally {
    powerSamples = stopSampler();
  }

  const seconds = (Date.now() - t0) / 1000;
  const avgPowerW = round(avg(powerSamples), 1);
  const avgUtilPct = round(avg(powerSamples.utilPct || []), 1);
  // 서버가 timings를 주면 그 값을 쓰고, 없으면 여기서 잰 값으로 대체한다.
  // 대체한 경우 프롬프트 처리 속도는 알 수 없어 0으로 둔다.
  const hasTimings = Boolean(timings && timings.predicted_per_second);
  const genTokens = hasTimings ? timings.predicted_n : tokens;
  const promptTokens = hasTimings ? timings.prompt_n : 0;

  emit({ promptIdx: idx, total, tokens: genTokens, tokPerSec: round(seconds > 0 ? genTokens / seconds : 0), text });

  return {
    prompt,
    promptTokens,
    genTokens,
    promptTokPerSec: round(hasTimings ? timings.prompt_per_second : 0),
    genTokPerSec: round(hasTimings ? timings.predicted_per_second : seconds > 0 ? genTokens / seconds : 0),
    seconds: round(seconds),
    avgPowerW,
    avgUtilPct,
    wh: round((avgPowerW * seconds) / 3600, 3),
    timingsSource: hasTimings ? 'server' : 'client',
    // 답변 전문. 결과 화면과 JSON에 그대로 남긴다. 출력이 깨지는지 눈으로 확인하는 용도.
    answer: text,
    truncated: hasTimings ? timings.predicted_n >= MAX_TOKENS : tokens >= MAX_TOKENS
  };
}

// P코어만 쓰는 cpu-mask. 인텔 하이브리드는 P코어만 HT가 있어 논리 스레드 - 물리 코어 = P코어 수다.
// P코어 논리 스레드는 앞쪽에 몰려 있으므로 그 개수만큼 비트를 켠다. 하이브리드가 아니면 null.
function pCoreMask(cpu) {
  if (!cpu || !cpu.cores || !cpu.threads) return null;
  const p = cpu.threads - cpu.cores;
  if (p <= 0 || p >= cpu.cores) return null;
  return '0x' + ((1n << BigInt(p * 2)) - 1n).toString(16).toUpperCase();
}

// 스레드·poll·cpu-mask 조합을 llama-bench 한 번에 돌린다(값을 쉼표로 넘기면 조합 전부 실행).
// tg128만 잰다. 모델 로드는 한 번이라 조합 수만큼 곱해도 몇 분이면 끝난다.
async function runTuning(opts, cfg) {
  const modelKey = (opts && opts.model) || 'qwen38';
  const paths = await install.modelPaths(cfg);
  const target = paths[modelKey];
  if (!target || !target.file) throw new Error(`${modelKey} 모델 파일이 없음. 설치 탭에서 먼저 받는다.`);
  const exe = path.join(cfg.installDir, 'bin', 'llama-bench.exe');
  if (!fs.existsSync(exe)) throw new Error(`llama-bench.exe 없음: ${exe}`);
  const hw = await sys.getHwInfo(cfg.installDir);

  const maxT = (hw.cpu && hw.cpu.threads) || 8;
  const threads = [...new Set([4, 6, 8, 12, 16, cfg.threads].filter((t) => t >= 1 && t <= maxT))].sort((a, b) => a - b);
  const polls = [0, 50];
  const pmask = pCoreMask(hw.cpu);
  const masks = pmask ? ['0x0', pmask] : ['0x0'];
  const total = threads.length * polls.length * masks.length;

  if (server.status().state !== 'stopped') {
    emit({ promptIdx: 0, total, tokens: 0, tokPerSec: 0, text: 'llama-server를 내리는 중 (RAM 확보)\n' });
    server.stop();
  }

  const args = [
    '-m', target.file,
    '-p', '0', '-n', String(TG), '-r', '2',
    '-t', threads.join(','),
    '--poll', polls.join(','),
    '-C', masks.join(','),
    '-ngl', '99', '-ncmoe', String(target.ncmoe),
    '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0',
    '-o', 'jsonl'
  ];

  const t0 = Date.now();
  let out = '';
  let log = `llama-bench ${args.join(' ')}\n조합 ${total}개: 스레드 ${threads.join('/')} × poll ${polls.join('/')} × 마스크 ${masks.join('/')}\n`;
  emit({ promptIdx: 0, total, tokens: 0, tokPerSec: 0, text: log });

  const code = await new Promise((resolve, reject) => {
    benchChild = spawn(exe, args, { windowsHide: true });
    benchChild.stdout.on('data', (d) => {
      out += d.toString();
      emit({ promptIdx: parseJsonl(out).length, total, tokens: 0, tokPerSec: 0, text: log });
    });
    benchChild.stderr.on('data', (d) => {
      log += d.toString();
      if (log.length > 4000) log = log.slice(-4000);
      emit({ promptIdx: parseJsonl(out).length, total, tokens: 0, tokPerSec: 0, text: log });
    });
    benchChild.on('error', reject);
    benchChild.on('exit', resolve);
  }).finally(() => {
    benchChild = null;
  });
  const seconds = (Date.now() - t0) / 1000;
  if (code !== 0) throw new Error(`llama-bench 종료코드 ${code}\n${log.slice(-800)}`);

  const rows = parseJsonl(out)
    .filter((r) => r.n_gen === TG)
    .map((r) => ({
      threads: r.n_threads,
      poll: r.poll,
      cpuMask: r.cpu_mask || '0x0',
      tg128: round(r.avg_ts, 2),
      stddev: round(r.stddev_ts, 2)
    }))
    .sort((a, b) => b.tg128 - a.tg128);
  if (!rows.length) throw new Error('llama-bench 결과를 해석하지 못함');
  const best = rows[0];
  const current = rows.find((r) => r.threads === cfg.threads && r.poll === cfg.poll && r.cpuMask === (cfg.cpuMask || '0x0')) || null;

  lastResult = {
    mode: 'tuning',
    model: modelKey,
    runs: [],
    summary: {
      avgPromptTokPerSec: 0,
      avgGenTokPerSec: best.tg128,
      avgPowerW: 0,
      totalWh: 0,
      krw: 0,
      krwPer1kTokens: 0
    },
    tuning: {
      gguf: path.basename(target.file),
      ncmoe: target.ncmoe,
      rows,
      best: { threads: best.threads, poll: best.poll, cpuMask: best.cpuMask === '0x0' ? '' : best.cpuMask },
      currentTg128: current ? current.tg128 : null,
      seconds: round(seconds, 1)
    },
    hw,
    ts: Date.now()
  };
  sys.setLastBench({ model: modelKey, genTokPerSec: best.tg128, promptTokPerSec: 0, ts: lastResult.ts });
  return lastResult;
}

async function run(opts, cfg) {
  if (controller || benchChild) throw new Error('벤치마크가 이미 돌고 있음');
  // mode 'standard'면 llama-bench, 아니면 서버에 프롬프트를 보내는 체감 벤치
  if (opts && opts.mode === 'standard') return runStandard(opts, cfg);
  if (opts && opts.mode === 'tuning') return runTuning(opts, cfg);
  const prompts = opts && Array.isArray(opts.prompts) && opts.prompts.length ? opts.prompts : BUILTIN_PROMPTS;
  const model = (opts && opts.model) || '';
  const baseUrl = (opts && opts.baseUrl) || server.BASE_URL;
  controller = new AbortController();

  try {
    const hw = await sys.getHwInfo(cfg.installDir);
    const runs = [];
    for (let i = 0; i < prompts.length; i++) {
      runs.push(await runOne(prompts[i], model, i, prompts.length, baseUrl));
    }

    const totalWh = round(
      runs.reduce((a, r) => a + r.wh, 0),
      3
    );
    const totalGenTokens = runs.reduce((a, r) => a + r.genTokens, 0);
    const krw = round((totalWh / 1000) * cfg.kwhPrice, 3);

    lastResult = {
      mode: 'prompts',
      model,
      runs,
      summary: {
        avgPromptTokPerSec: round(avg(runs.map((r) => r.promptTokPerSec))),
        avgGenTokPerSec: round(avg(runs.map((r) => r.genTokPerSec))),
        avgPowerW: round(avg(runs.map((r) => r.avgPowerW)), 1),
        totalWh,
        krw,
        krwPer1kTokens: round(totalGenTokens > 0 ? (krw / totalGenTokens) * 1000 : 0, 4)
      },
      hw,
      ts: Date.now()
    };
    lastResult.verdict = await buildVerdict(lastResult.summary, hw, cfg, avg(runs.map((r) => r.avgUtilPct)));
    // 대시보드가 마지막 벤치 결과를 스냅샷에서 바로 읽을 수 있게 넘겨둔다
    sys.setLastBench({
      model,
      genTokPerSec: lastResult.summary.avgGenTokPerSec,
      promptTokPerSec: lastResult.summary.avgPromptTokPerSec,
      ts: lastResult.ts
    });
    return lastResult;
  } finally {
    controller = null;
  }
}

// ---------- 표준 벤치 (llama-bench) ----------
// llama.cpp 동봉 llama-bench로 pp512(프롬프트 처리)·tg128(생성) tok/s를 잰다.
// 커뮤니티·모델 카드가 쓰는 지표라 다른 PC 결과와 바로 비교할 수 있다.
// 모델을 직접 로드하므로 RAM 충돌을 피하려고 llama-server는 먼저 내린다.

const { spawn } = require('child_process');
const install = require('./install');

const PP = 512;
const TG = 128;
const REPS = 3;
let benchChild = null;

function parseJsonl(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      rows.push(JSON.parse(s));
    } catch {
      // 진행 로그 등 JSON이 아닌 줄
    }
  }
  return rows;
}

async function runStandard(opts, cfg) {
  const modelKey = (opts && opts.model) || 'qwen38';
  const paths = await install.modelPaths(cfg);
  const target = paths[modelKey];
  if (!target || !target.file) throw new Error(`${modelKey} 모델 파일이 없음. 설치 탭에서 먼저 받는다.`);
  const exe = path.join(cfg.installDir, 'bin', 'llama-bench.exe');
  if (!fs.existsSync(exe)) throw new Error(`llama-bench.exe 없음: ${exe}`);

  if (server.status().state !== 'stopped') {
    emit({ promptIdx: 0, total: 2, tokens: 0, tokPerSec: 0, text: 'llama-server를 내리는 중 (RAM 확보)\n' });
    server.stop();
  }

  const args = [
    '-m', target.file,
    '-p', String(PP), '-n', String(TG), '-r', String(REPS),
    '-t', String(cfg.threads),
    '-ngl', '99', '-ncmoe', String(target.ncmoe),
    '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0',
    '-b', '2048', '-ub', '512',
    '-o', 'jsonl'
  ];

  const stopSampler = startPowerSampler();
  const t0 = Date.now();
  let out = '';
  let log = `llama-bench ${args.join(' ')}\n`;
  emit({ promptIdx: 0, total: 2, tokens: 0, tokPerSec: 0, text: log });

  const code = await new Promise((resolve, reject) => {
    benchChild = spawn(exe, args, { windowsHide: true });
    benchChild.stdout.on('data', (d) => { out += d.toString(); });
    benchChild.stderr.on('data', (d) => {
      log += d.toString();
      if (log.length > 4000) log = log.slice(-4000);
      emit({ promptIdx: out.includes('"n_gen": 128') ? 1 : 0, total: 2, tokens: 0, tokPerSec: 0, text: log });
    });
    benchChild.on('error', reject);
    benchChild.on('exit', resolve);
  }).finally(() => {
    benchChild = null;
  });
  const powerSamples = stopSampler();
  const avgUtilPct = round(avg(powerSamples.utilPct || []), 1);
  const seconds = (Date.now() - t0) / 1000;
  if (code !== 0) throw new Error(`llama-bench 종료코드 ${code}\n${log.slice(-800)}`);

  const rows = parseJsonl(out);
  const pp = rows.find((r) => r.n_prompt === PP && r.n_gen === 0);
  const tg = rows.find((r) => r.n_gen === TG && r.n_prompt === 0);
  if (!pp || !tg) throw new Error('llama-bench 결과를 해석하지 못함');

  const avgPowerW = round(avg(powerSamples), 1);
  const wh = round((avgPowerW * seconds) / 3600, 3);
  // 토큰 하나에 드는 에너지 = 전력 / 초당 토큰. 1000토큰 단위로 환산한다.
  const whPer1kGen = round((avgPowerW / tg.avg_ts) * 1000 / 3600, 3);
  const krwPer1kGen = round((whPer1kGen / 1000) * cfg.kwhPrice, 4);

  lastResult = {
    mode: 'standard',
    model: modelKey,
    runs: [],
    summary: {
      avgPromptTokPerSec: round(pp.avg_ts, 1),
      avgGenTokPerSec: round(tg.avg_ts, 1),
      avgPowerW,
      totalWh: wh,
      krw: round((wh / 1000) * cfg.kwhPrice, 3),
      krwPer1kTokens: krwPer1kGen
    },
    standard: {
      gguf: path.basename(target.file),
      build: pp.build_commit || '',
      threads: cfg.threads,
      ncmoe: target.ncmoe,
      reps: REPS,
      pp512: { avgTs: round(pp.avg_ts, 1), stddevTs: round(pp.stddev_ts, 1) },
      tg128: { avgTs: round(tg.avg_ts, 1), stddevTs: round(tg.stddev_ts, 1) },
      seconds: round(seconds, 1),
      whPer1kGenTokens: whPer1kGen
    },
    hw: await sys.getHwInfo(cfg.installDir),
    ts: Date.now()
  };
  lastResult.verdict = await buildVerdict(lastResult.summary, lastResult.hw, cfg, avgUtilPct);
  sys.setLastBench({
    model: modelKey,
    genTokPerSec: lastResult.summary.avgGenTokPerSec,
    promptTokPerSec: lastResult.summary.avgPromptTokPerSec,
    ts: lastResult.ts
  });
  return lastResult;
}

// ---------- 판정 (verdict) ----------
// 생성 속도 목표는 20 tok/s. MoE 생성 속도는 GPU보다 RAM 대역폭에 묶인다고 보고 계산한다.

const TARGET = 20;
// 양자화를 한 단계 낮췄을 때 기대하는 배율. 파일 크기 비로 잡았다(Q4 111GB, Q3 90GB, IQ3 82GB).
const QUANT_DOWN_GAIN = { 'UD-Q4_K_XL': 111 / 82, 'UD-Q3_K_XL': 90 / 82, 'UD-IQ3_XXS': 1 };
// [추정] GPU 정격 전력을 읽을 방법이 없어 고정값으로 본다.
// 4080 320W, 5070Ti 300W 기준 80%가 대략 250W다. nvidia-smi가 enforced power limit을
// 주므로 정확히 하려면 --query-gpu=power.limit을 읽어 비율로 바꾼다.
const GPU_SATURATED_W = 250;
// [추정] 사용률 임계값. MoE 생성 구간에서 GPU가 계속 일하고 있으면 85% 위로 붙는다.
// 전력이 낮아도(저전압 구간) 사용률이 높으면 GPU가 병목인 경우가 있어 따로 본다.
const GPU_SATURATED_UTIL_PCT = 85;

/**
 * 판정을 만든다. fs나 프로세스를 건드리지 않는 순수 함수라 단위 검증에 그대로 쓴다.
 * modelBytesGB는 measureModelBytesGB()가 잰 값을 넣는다.
 */
function computeVerdict({ genTokPerSec, hw, cfg, gpuAvgPowerW, gpuAvgUtilPct, modelBytesGB }) {
  const gen = Number(genTokPerSec) || 0;
  const ramTotalGB = (hw && hw.ramGB) || 0;
  const bandwidth = (hw && hw.ram && hw.ram.bandwidthGBps) || null;
  const bytes = Number(modelBytesGB) || 0;
  const powerW = Number(gpuAvgPowerW) || 0;
  const utilPct = Number(gpuAvgUtilPct) || 0;
  const gpuSaturated = powerW >= GPU_SATURATED_W || utilPct >= GPU_SATURATED_UTIL_PCT;
  const reached = gen >= TARGET;

  // 순서를 이렇게 둔 이유: 모델이 RAM에 안 들어가면 다른 값은 볼 필요가 없고,
  // GPU 전력이 포화면 대역폭을 알더라도 GPU가 먼저다. 대역폭 판정은 그다음.
  let bottleneck = 'unknown';
  if (bytes > 0 && bytes > ramTotalGB * 0.9) bottleneck = 'ram_capacity';
  else if (gpuSaturated) bottleneck = 'gpu';
  else if (bandwidth) bottleneck = 'ram_bandwidth';

  const bytesPerTokenGB = bandwidth && gen > 0 ? round(bandwidth / gen, 2) : null;
  const neededBandwidthGBps = bandwidth && gen > 0 ? round((bandwidth * TARGET) / gen, 1) : null;

  const gain = QUANT_DOWN_GAIN[(cfg && cfg.quant) || 'UD-Q4_K_XL'] || 1;
  const quantDownTokPerSec = round(gen * gain, 1);
  const quantDownReaches = quantDownTokPerSec >= TARGET;

  const actions = [];
  if (reached) {
    actions.push(`목표 ${TARGET} tok/s에 도달했다.`);
  } else if (bottleneck === 'ram_capacity') {
    actions.push(`모델 합계 ${round(bytes, 1)}GB가 RAM ${round(ramTotalGB, 1)}GB를 넘는다. 디스크에서 읽으며 도는 상태다.`);
    actions.push('Qwen3.6 자동 로드를 해제하면 약 21GB가 빈다.');
    actions.push('3.8을 IQ3_XXS(약 82GB)로 내려 RAM 안에 들어가게 한다.');
  } else if (bottleneck === 'gpu') {
    actions.push(
      `GPU가 포화 상태다. 평균 전력 ${round(powerW, 1)}W, 사용률 ${round(utilPct, 1)}%. 전력 제한과 클럭 설정을 확인한다.`
    );
    if (!quantDownReaches) {
      actions.push(`양자화를 낮춰도 ${TARGET} tok/s에 못 미친다. ${quantDownTokPerSec} tok/s 예상.`);
    }
  } else if (bottleneck === 'ram_bandwidth') {
    const ratio = round(TARGET / gen, 2);
    actions.push(
      `RAM 대역폭이 ${ratio}배 필요하다. 현재 약 ${bandwidth} GB/s에서 ${neededBandwidthGBps} GB/s로 올라가야 한다.`
    );
    actions.push('DDR5-6000 듀얼채널이 약 96 GB/s다.');
    if (!quantDownReaches) {
      actions.push(`양자화를 낮추는 것만으로는 ${TARGET} tok/s에 못 미친다. ${quantDownTokPerSec} tok/s 예상.`);
    }
    actions.push('전문가 가중치를 VRAM에 캐시하는 포크(GenerelSchwerz/llama.cpp)에서 5070Ti 16GB로 43 tok/s 보고가 있다.');
  } else {
    actions.push('병목을 특정하지 못했다. RAM 속도와 모듈 수를 읽지 못해 대역폭을 계산할 수 없다.');
    if (!quantDownReaches) {
      actions.push(`양자화를 낮춰도 ${TARGET} tok/s에 못 미친다. ${quantDownTokPerSec} tok/s 예상.`);
    }
  }

  return {
    target: TARGET,
    genTokPerSec: round(gen, 1),
    reached,
    bottleneck,
    modelBytesGB: round(bytes, 1),
    ramTotalGB: round(ramTotalGB, 1),
    bytesPerTokenGB,
    neededBandwidthGBps,
    quantDownGain: round(gain, 2),
    quantDownTokPerSec,
    quantDownReaches,
    actions: actions.slice(0, 4)
  };
}

// RAM에 올라가는 모델 파일 합계(GB). 3.8은 분할본이라 같은 폴더의 gguf를 전부 더하고,
// 3.6은 load-on-startup이라 항상 같이 올라가므로 함께 센다. 파일이 없으면 0.
async function measureModelBytesGB(cfg) {
  let bytes = 0;
  try {
    const paths = await install.modelPaths(cfg);
    const f38 = paths.qwen38 && paths.qwen38.file;
    if (f38) {
      const dir = path.dirname(f38);
      for (const name of await fsp.readdir(dir)) {
        if (!name.toLowerCase().endsWith('.gguf')) continue;
        bytes += (await fsp.stat(path.join(dir, name))).size;
      }
    }
    const f36 = paths.qwen36 && paths.qwen36.file;
    if (f36) bytes += (await fsp.stat(f36)).size;
  } catch {
    // 설치 전이면 0으로 둔다. 판정은 bottleneck='unknown'이 된다.
  }
  return round(bytes / (1024 * 1024 * 1024), 1);
}

async function buildVerdict(summary, hw, cfg, gpuAvgUtilPct) {
  return computeVerdict({
    genTokPerSec: summary.avgGenTokPerSec,
    hw,
    cfg,
    gpuAvgPowerW: summary.avgPowerW,
    gpuAvgUtilPct,
    modelBytesGB: await measureModelBytesGB(cfg)
  });
}

function cancel() {
  if (controller) controller.abort();
  if (benchChild) {
    spawn('taskkill', ['/PID', String(benchChild.pid), '/T', '/F'], { windowsHide: true });
  }
}

async function exportLast(dir) {
  if (!lastResult) throw new Error('내보낼 결과가 없음');
  // 여러 PC 결과를 한 폴더에 모을 수 있게 PC 이름을 앞에 붙인다
  const file = path.join(dir, `${os.hostname()}-bench-${lastResult.ts}.json`);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(file, JSON.stringify(lastResult, null, 2), 'utf8');
  return { path: file };
}

module.exports = { run, cancel, exportLast, onProgress, computeVerdict, measureModelBytesGB, pCoreMask, BUILTIN_PROMPTS };
