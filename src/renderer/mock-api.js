/*
 * 개발 검증용 목 API.
 * preload가 window.api를 주입하지 않은 환경(브라우저로 index.html 직접 열기)에서만 로드된다.
 * CONTRACT.md의 타입에 맞는 값을 돌려주고 이벤트도 타이머로 흉내낸다.
 */
(function () {
  'use strict';

  var listeners = {};

  function emit(channel, payload) {
    (listeners[channel] || []).slice().forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error(e); }
    });
  }

  function later(ms, value) {
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(value); }, ms);
    });
  }

  function rand(min, max) { return min + Math.random() * (max - min); }

  // ---------- 하드웨어 (이 PC 사양 예시값) ----------

  var hw = {
    gpu: { name: 'NVIDIA GeForce RTX 4080', vramMB: 16376, driver: '566.36' },
    cpu: { name: 'Intel Core i9-13900K', cores: 24, threads: 32 },
    ramGB: 128,
    ram: { totalGB: 128, speedMTs: 4800, modules: 4, bandwidthGBps: 76.8 },
    drives: [
      { letter: 'C:', freeGB: 412, totalGB: 931, media: 'SSD' },
      { letter: 'E:', freeGB: 1680, totalGB: 3726, media: 'SSD' },
      { letter: 'F:', freeGB: 240, totalGB: 5588, media: 'HDD' }
    ],
    ssd: { letter: 'C:', writeMBps: 2480, readMBps: 3310 }
  };

  // ---------- 설정 ----------

  var config = {
    installDir: 'C:\\llm\\qwen',
    quant: 'UD-Q4_K_XL',
    threads: 24,
    ctx: 65536,
    kwhPrice: 150,
    autoLoad36: true,
    mtp: false,
    mtpFile: 'mtp-Qwen3.8-Flash-Next-shared-Q8_0.gguf',
    loadMode: 'mmap',
    ncmoe38: 99,
    poll: 50,
    cpuMask: ''
  };

  // ---------- 설치 ----------

  var installTimer = null;

  var install = {
    running: false,
    steps: [
      { id: 'llamacpp', label: 'llama.cpp 내려받기', status: 'pending', percent: 0, detail: '' },
      { id: 'model38', label: 'Qwen3.8-Flash-Next 모델 내려받기', status: 'pending', percent: 0, detail: '' },
      { id: 'model36', label: 'Qwen3.6-35B 모델 내려받기', status: 'pending', percent: 0, detail: '' },
      { id: 'preset', label: '라우터 프리셋 생성', status: 'pending', percent: null, detail: '' },
      { id: 'runbat', label: '실행 배치 파일 생성', status: 'pending', percent: null, detail: '' }
    ],
    log: ['설치 준비됨. 설치 시작을 누르면 진행한다.']
  };

  function pushLog(line) {
    install.log.push(new Date().toTimeString().slice(0, 8) + '  ' + line);
    if (install.log.length > 200) install.log = install.log.slice(-200);
  }

  function installSnapshot() {
    return JSON.parse(JSON.stringify(install));
  }

  function startInstall() {
    if (install.running) return;
    install.running = true;
    // 다운로드형 단계만 진행률을 가진다.
    var withPercent = ['llamacpp', 'model38', 'model36'];
    install.steps.forEach(function (s) {
      s.status = 'pending';
      s.percent = withPercent.indexOf(s.id) >= 0 ? 0 : null;
      s.detail = '';
    });
    install.log = [];
    pushLog('설치를 시작한다. 대상 경로 ' + config.installDir);

    var idx = 0;
    install.steps[0].status = 'running';

    installTimer = setInterval(function () {
      var step = install.steps[idx];
      if (!step) return;

      if (typeof step.percent === 'number') {
        step.percent = Math.min(100, step.percent + rand(4, 14));
        var totalGB = step.id === 'llamacpp' ? 0.3 : (step.id === 'model38' ? 111 : 21);
        step.detail = (totalGB * step.percent / 100).toFixed(1) + 'GB / ' + totalGB + 'GB  ' + Math.round(rand(28, 54)) + 'MB/s';
        if (step.percent >= 100) {
          step.percent = 100;
          step.status = 'done';
          pushLog(step.label + ' 끝남');
          idx++;
        } else if (Math.random() < 0.3) {
          pushLog(step.label + ' ' + step.percent.toFixed(0) + '%');
        }
      } else {
        // 진행률 없는 단계는 한 틱 만에 끝난다.
        step.status = 'done';
        step.detail = '';
        pushLog(step.label + (step.status === 'skipped' ? ' 건너뜀' : ' 끝남'));
        idx++;
      }

      if (idx < install.steps.length && install.steps[idx].status === 'pending') {
        install.steps[idx].status = 'running';
      }

      if (idx >= install.steps.length) {
        install.running = false;
        clearInterval(installTimer);
        installTimer = null;
        pushLog('모든 단계가 끝났다.');
      }

      emit('install:progress', installSnapshot());
    }, 400);

    emit('install:progress', installSnapshot());
  }

  function cancelInstall() {
    if (!install.running) return;
    clearInterval(installTimer);
    installTimer = null;
    install.running = false;
    install.steps.forEach(function (s) {
      if (s.status === 'pending' || s.status === 'running') s.status = 'skipped';
    });
    pushLog('사용자가 설치를 취소했다.');
    emit('install:progress', installSnapshot());
  }

  // ---------- 서버 ----------

  var server = { state: 'stopped', pid: null, models: [], error: null };

  function serverSnapshot() {
    return JSON.parse(JSON.stringify(server));
  }

  function startServer() {
    if (server.state === 'ready' || server.state === 'starting') return Promise.resolve(serverSnapshot());
    server.state = 'starting';
    server.pid = 13240;
    server.error = null;
    emit('server:status', serverSnapshot());
    return later(1200).then(function () {
      server.state = 'ready';
      server.models = [
        { id: 'qwen3.8-flash-next', loaded: true },
        { id: 'qwen3.6-35b', loaded: false }
      ];
      emit('server:status', serverSnapshot());
      return serverSnapshot();
    });
  }

  function stopServer() {
    server.state = 'stopped';
    server.pid = null;
    server.models = [];
    server.error = null;
    emit('server:status', serverSnapshot());
    return Promise.resolve(serverSnapshot());
  }

  // ---------- 모니터 ----------

  var busy = 0;          // 벤치 중에는 사용률과 전력을 올린다.
  var ssdCache = null;   // check.run()이 돌아야 채워진다.
  var lastBench = null;  // 벤치를 한 번 돌려야 채워진다.

  function snapshot() {
    var util = busy ? rand(88, 99) : rand(2, 12);
    var power = busy ? rand(255, 315) : rand(18, 40);
    return {
      ts: Date.now(),
      gpu: {
        utilPct: util,
        memUsedMB: busy ? rand(13200, 15400) : rand(900, 1800),
        memTotalMB: hw.gpu.vramMB,
        powerW: power,
        tempC: busy ? rand(66, 78) : rand(38, 46)
      },
      ram: { usedGB: rand(28, 52), totalGB: hw.ramGB },
      cpuPct: busy ? rand(20, 45) : rand(3, 14),
      disk: { letter: 'C:', freeGB: 412 - rand(0, 2) },
      ssd: ssdCache ? Object.assign({}, ssdCache) : null,
      lastBench: lastBench ? Object.assign({}, lastBench) : null
    };
  }

  setInterval(function () { emit('monitor:tick', snapshot()); }, 1000);

  // ---------- 벤치마크 ----------

  var benchCancelled = false;
  var lastResult = null;

  // 판정 샘플. 기본은 3.8로 20 tok/s에 못 미치고 RAM 대역폭에 막힌 상황이다.
  // 작은 3.6 모델은 목표를 넘기는 경우를 보려고 따로 둔다.
  function makeVerdict(model) {
    var reached = String(model).indexOf('3.6') >= 0 || String(model).indexOf('36') >= 0;
    var gen = reached ? 40 : 14;
    var bw = hw.ram.bandwidthGBps;
    var gain = 1.3;
    return {
      target: 20,
      genTokPerSec: gen,
      reached: reached,
      bottleneck: reached ? 'gpu' : 'ram_bandwidth',
      modelBytesGB: reached ? 21 : 111,
      ramTotalGB: hw.ram.totalGB,
      bytesPerTokenGB: bw / gen,
      neededBandwidthGBps: bw * 20 / gen,
      quantDownGain: gain,
      quantDownTokPerSec: gen * gain,
      quantDownReaches: gen * gain >= 20,
      actions: reached ? [
        '지금 설정으로 대화형으로 쓸 만하다.',
        '컨텍스트를 늘리면 VRAM에서 먼저 막히니 여유를 확인한다.'
      ] : [
        '3.6 모델 자동 로드를 해제해 RAM 21GB를 비운다.',
        'RAM 대역폭이 1.43배 필요하다. DDR5-6000 듀얼 채널 이상으로 올린다.',
        '전문가를 VRAM에 캐시하는 포크를 쓰면 더 나온다는 보고가 있다.'
      ]
    };
  }

  var PROMPTS = [
    '파이썬으로 CSV 파일을 읽어 열별 평균을 구하는 코드를 써줘.',
    '이 PC에서 로컬 LLM을 쓰는 게 실용적인지 세 문단으로 설명해줘.',
    '리액트 컴포넌트에서 무한 렌더링이 생기는 흔한 원인을 정리해줘.'
  ];

  var SAMPLE = ('로컬 모델을 돌릴 때 가장 먼저 보는 값은 생성 속도다. ' +
    '초당 토큰 수가 사람이 읽는 속도보다 빠르면 대화형으로 쓸 만하다. ' +
    '다음은 전력이다. GPU가 300W 근처에서 계속 돌면 하루 몇 시간만 써도 요금이 눈에 띈다. ' +
    '마지막으로 VRAM 여유를 본다. 컨텍스트를 늘리면 여기서 먼저 막힌다. ').split(' ');

  // 표준 모드 목: llama-bench 로그처럼 몇 줄 흘린 뒤 pp512/tg128 결과를 준다
  function runStandardMock(opts) {
    var model = (opts && opts.model) || 'qwen38';
    var lines = ['llama-bench -m ' + model + '.gguf -p 512 -n 128 -r 3', 'load_tensors: offloaded 99/99 layers to GPU', ''];
    var step = 0;
    return new Promise(function (resolve) {
      var timer = setInterval(function () {
        step++;
        lines.push(step < 4 ? 'pp512 반복 ' + step : 'tg128 반복 ' + (step - 3));
        emit('bench:progress', { promptIdx: step < 4 ? 0 : 1, total: 2, tokens: 0, tokPerSec: 0, text: lines.join('\n') });
        if (step >= 6 || benchCancelled) {
          clearInterval(timer);
          var pp = rand(900, 1300), tg = model === 'qwen36' ? rand(120, 160) : rand(38, 55), w = rand(240, 300);
          var whPer1k = w / tg * 1000 / 3600;
          resolve({
            mode: 'standard', model: model, runs: [],
            summary: { avgPromptTokPerSec: pp, avgGenTokPerSec: tg, avgPowerW: w, totalWh: 4.2, krw: 0.63, krwPer1kTokens: whPer1k / 1000 * 150 },
            standard: { gguf: model + '-UD-Q4_K_XL.gguf', build: 'b10976', threads: 8, ncmoe: model === 'qwen36' ? 20 : 99, reps: 3,
              pp512: { avgTs: pp, stddevTs: rand(5, 20) }, tg128: { avgTs: tg, stddevTs: rand(0.5, 2) }, seconds: 95, whPer1kGenTokens: whPer1k },
            hw: hw, verdict: makeVerdict(model), ts: Date.now()
          });
        }
      }, 400);
    });
  }

  function runTuningMock(opts) {
    var model = (opts && opts.model) || 'qwen38';
    var threads = [4, 6, 8, 12, 16], polls = [0, 50], masks = ['0x0', '0xFFFF'];
    var combos = [];
    threads.forEach(function (t) { polls.forEach(function (p) { masks.forEach(function (m) { combos.push({ threads: t, poll: p, cpuMask: m }); }); }); });
    return new Promise(function (resolve) {
      var i = 0;
      var timer = setInterval(function () {
        i++;
        emit('bench:progress', { promptIdx: i, total: combos.length, tokens: 0, tokPerSec: 0, text: '조합 ' + i + '/' + combos.length });
        if (i >= combos.length || benchCancelled) {
          clearInterval(timer);
          var rows = combos.map(function (c) {
            var base = c.threads === 8 ? 14 : c.threads === 6 ? 13.4 : c.threads === 12 ? 13.1 : c.threads === 4 ? 11 : 12;
            if (c.cpuMask !== '0x0') base += 0.6;
            if (c.poll === 0) base -= 0.2;
            return { threads: c.threads, poll: c.poll, cpuMask: c.cpuMask, tg128: Math.round((base + Math.random()) * 100) / 100, stddev: 0.2 };
          }).sort(function (a, b) { return b.tg128 - a.tg128; });
          var best = rows[0];
          resolve({
            mode: 'tuning', model: model, runs: [],
            summary: { avgPromptTokPerSec: 0, avgGenTokPerSec: best.tg128, avgPowerW: 0, totalWh: 0, krw: 0, krwPer1kTokens: 0 },
            tuning: { gguf: model + '-UD-IQ3_XXS.gguf', ncmoe: 99, rows: rows,
              best: { threads: best.threads, poll: best.poll, cpuMask: best.cpuMask === '0x0' ? '' : best.cpuMask },
              currentTg128: rows.filter(function (r) { return r.threads === 8 && r.poll === 50 && r.cpuMask === '0x0'; }).map(function (r) { return r.tg128; })[0] || null,
              seconds: 240 },
            hw: hw, ts: Date.now()
          });
        }
      }, 150);
    });
  }

  function runBench(opts) {
    if (opts && opts.mode === 'tuning') {
      benchCancelled = false;
      return runTuningMock(opts).then(function (r) { lastBench = { model: r.model, genTokPerSec: r.summary.avgGenTokPerSec, promptTokPerSec: 0, ts: r.ts }; return r; });
    }
    if (opts && opts.mode === 'standard') {
      benchCancelled = false;
      return runStandardMock(opts).then(function (r) { lastBench = { model: r.model, genTokPerSec: r.summary.avgGenTokPerSec, promptTokPerSec: r.summary.avgPromptTokPerSec, ts: r.ts }; return r; });
    }
    benchCancelled = false;
    busy++;
    var model = (opts && opts.model) || 'qwen3.8-flash-next';
    var runs = [];

    function runOne(idx) {
      if (idx >= PROMPTS.length || benchCancelled) return Promise.resolve();

      return new Promise(function (resolve) {
        var text = '';
        var tokens = 0;
        var wordIdx = 0;
        var started = Date.now();
        var genTokPerSec = rand(38, 62);
        var timer = setInterval(function () {
          if (benchCancelled) {
            clearInterval(timer);
            resolve();
            return;
          }
          text += SAMPLE[wordIdx % SAMPLE.length] + ' ';
          wordIdx++;
          tokens += 3;
          emit('bench:progress', {
            promptIdx: idx,
            total: PROMPTS.length,
            tokens: tokens,
            tokPerSec: genTokPerSec + rand(-3, 3),
            text: text
          });
          if (tokens >= 120) {
            clearInterval(timer);
            var seconds = (Date.now() - started) / 1000;
            var avgPowerW = rand(258, 305);
            runs.push({
              prompt: PROMPTS[idx],
              promptTokens: Math.round(rand(40, 120)),
              genTokens: tokens,
              promptTokPerSec: rand(900, 1600),
              genTokPerSec: genTokPerSec,
              seconds: seconds,
              avgPowerW: avgPowerW,
              wh: avgPowerW * seconds / 3600,
              // 두 번째 프롬프트만 timings가 빠진 상황을 흉내낸다.
              timingsSource: idx === 1 ? 'client' : 'server',
              answer: text,
              truncated: false
            });
            resolve();
          }
        }, 120);
      }).then(function () { return runOne(idx + 1); });
    }

    return runOne(0).then(function () {
      busy = Math.max(0, busy - 1);
      if (benchCancelled && !runs.length) throw new Error('사용자가 취소했다.');

      var avg = function (key) {
        return runs.reduce(function (a, r) { return a + r[key]; }, 0) / runs.length;
      };
      var totalWh = runs.reduce(function (a, r) { return a + r.wh; }, 0);
      var genTokens = runs.reduce(function (a, r) { return a + r.genTokens; }, 0);
      var cost = totalWh / 1000 * config.kwhPrice;

      lastResult = {
        model: model,
        runs: runs,
        summary: {
          avgPromptTokPerSec: avg('promptTokPerSec'),
          avgGenTokPerSec: avg('genTokPerSec'),
          avgPowerW: avg('avgPowerW'),
          totalWh: totalWh,
          krw: cost,
          krwPer1kTokens: genTokens ? cost / genTokens * 1000 : 0
        },
        hw: hw,
        verdict: makeVerdict(model),
        ts: Date.now()
      };
      // 대시보드 카드용 요약을 남긴다.
      lastBench = {
        model: model,
        genTokPerSec: lastResult.summary.avgGenTokPerSec,
        promptTokPerSec: lastResult.summary.avgPromptTokPerSec,
        ts: lastResult.ts
      };
      return JSON.parse(JSON.stringify(lastResult));
    });
  }

  // ---------- 점검 ----------

  function checkReport() {
    var items = [
      { id: 'admin', label: '관리자 권한', status: 'warn', value: '일반 권한으로 실행 중', need: '관리자 권한 권장' },
      { id: 'gpu', label: 'NVIDIA GPU', status: 'pass', value: hw.gpu.name, need: 'NVIDIA GPU' },
      { id: 'vram', label: 'VRAM', status: 'pass', value: '16GB', need: '12GB 이상' },
      { id: 'ram', label: '시스템 메모리', status: 'pass', value: hw.ramGB + 'GB', need: '64GB 이상' },
      { id: 'disk', label: '설치 드라이브 여유 공간', status: 'pass', value: '412GB (C:)', need: '140GB 이상' },
      { id: 'ssd', label: '설치 드라이브 매체', status: 'pass', value: 'SSD', need: 'SSD 권장' },
      { id: 'node', label: 'Node.js', status: 'pass', value: '22.11.0', need: '설치되어 있을 것' },
      { id: 'nvidia_driver', label: 'NVIDIA 드라이버', status: 'pass', value: hw.gpu.driver, need: '설치되어 있을 것' }
    ];
    // 점검을 돌려야 대시보드의 SSD 카드에 값이 생긴다.
    ssdCache = hw.ssd;
    lastCheck = items;
    return {
      ok: items.every(function (i) { return i.status === 'pass'; }),
      items: items,
      hw: hw,
      specLogPath: 'C:\\llm\\llmbench\\logs\\spec-logs\\DESKTOP-ABC123-spec.json'
    };
  }

  var lastCheck = null;   // 직전 점검 결과. install.start가 이걸 본다.

  // ---------- 하네스 ----------

  var harnesses = [
    { id: 'qwen-code', name: 'Qwen Code', npm: '@qwen-code/qwen-code', installed: false, version: null,
      note: 'Qwen 계열에 맞춘 CLI 에이전트. 로컬 llama-server를 OpenAI 호환으로 붙인다.' },
    { id: 'opencode', name: 'OpenCode', npm: 'opencode-ai', installed: true, version: '0.4.12',
      note: '터미널 TUI 에이전트. 설치 단계에서 전역 설정을 이미 만들어 둔다.' }
  ];

  function installHarness(id) {
    var h = harnesses.filter(function (x) { return x.id === id; })[0];
    if (!h) return Promise.reject(new Error('모르는 하네스다: ' + id));

    var lines = [
      'npm install -g ' + h.npm,
      'npm warn deprecated 일부 의존성은 더 이상 관리되지 않는다',
      'added 214 packages in 31s',
      h.npm + ' 전역 설치 끝남'
    ];
    var i = 0;
    return new Promise(function (resolve) {
      var timer = setInterval(function () {
        emit('harness:log', lines[i]);
        i++;
        if (i >= lines.length) {
          clearInterval(timer);
          h.installed = true;
          h.version = '0.1.7';
          resolve(Object.assign({}, h));
        }
      }, 350);
    });
  }

  function launchHarness(id, opts) {
    var h = harnesses.filter(function (x) { return x.id === id; })[0];
    if (!h) return Promise.resolve({ ok: false, error: '모르는 하네스다: ' + id });
    if (!h.installed) return Promise.resolve({ ok: false, error: h.name + '이 아직 설치되지 않았다.' });
    if (server.state !== 'ready') {
      return later(200, { ok: false, error: 'llama-server가 준비되지 않았다. 대시보드 탭에서 서버를 먼저 시작한다.' });
    }
    var workDir = (opts && opts.workDir) || (config.installDir + '\\workspace');
    emit('harness:log', h.name + ' 터미널 창을 연다. 작업 폴더 ' + workDir + ', 모델 ' + ((opts && opts.model) || 'qwen38'));
    return later(200, { ok: true, error: null });
  }

  // ---------- window.api ----------

  window.api = {
    on: function (channel, cb) {
      if (!listeners[channel]) listeners[channel] = [];
      listeners[channel].push(cb);
      return function () {
        listeners[channel] = (listeners[channel] || []).filter(function (fn) { return fn !== cb; });
      };
    },
    check: {
      run: function () { return later(600, null).then(checkReport); }
    },
    config: {
      get: function () { return Promise.resolve(Object.assign({}, config)); },
      export: function () { return Promise.resolve({ path: 'C:\\Users\\mock\\Documents\\llmbench-config-MOCK.json', error: null }); },
      import: function () {
        Object.assign(config, { installDir: 'E:\\llm\\qwen', quant: 'UD-IQ3_XXS', autoLoad36: false, mtp: true });
        return Promise.resolve({ config: Object.assign({}, config), path: 'C:\\Users\\mock\\Documents\\llmbench-config-DESKTOP-EDJAJK2.json', error: null });
      },
      set: function (partial) {
        Object.assign(config, partial);
        return Promise.resolve(Object.assign({}, config));
      }
    },
    install: {
      start: function (opts) {
        var items = lastCheck;
        if (!items) {
          return Promise.resolve({ started: false, reason: '점검을 먼저 실행해야 한다.' });
        }
        var fails = items.filter(function (i) { return i.status === 'fail'; });
        if (fails.length) {
          return Promise.resolve({
            started: false,
            reason: '불가 항목이 있다: ' + fails.map(function (i) { return i.label; }).join(', ')
          });
        }
        var warns = items.filter(function (i) { return i.status === 'warn'; });
        if (warns.length && !(opts && opts.allowWarn)) {
          return Promise.resolve({
            started: false,
            reason: '주의 항목이 있다: ' + warns.map(function (i) { return i.label; }).join(', ')
          });
        }
        startInstall();
        return Promise.resolve({ started: true, reason: null });
      },
      cancel: function () { cancelInstall(); return Promise.resolve(); },
      status: function () { return Promise.resolve(installSnapshot()); }
    },
    // 하네스 탭 목: npm 설치와 터미널 실행을 흉내만 낸다
    harness: {
      list: function () {
        return later(120, harnesses.map(function (h) { return Object.assign({}, h); }));
      },
      install: function (id) { return installHarness(id); },
      launch: function (id, opts) { return launchHarness(id, opts); }
    },
    server: {
      start: startServer,
      stop: stopServer,
      status: function () { return Promise.resolve(serverSnapshot()); },
      logs: function () {
        return Promise.resolve([
          'llama_model_loader: loaded meta data',
          'load_tensors: offloading 48 repeating layers to GPU',
          'srv    load_model: loading model (목 데이터)'
        ]);
      },
      saveLogs: function () { return Promise.resolve({ path: 'C:\\mock\\logs\\server-logs\\MOCK-server.log' }); }
    },
    monitor: {
      snapshot: function () { return Promise.resolve(snapshot()); }
    },
    bench: {
      run: runBench,
      cancel: function () { benchCancelled = true; return Promise.resolve(); },
      export: function () {
        if (!lastResult) return Promise.reject(new Error('저장할 결과가 없다.'));
        return Promise.resolve({ path: 'C:\\Users\\me\\AppData\\Roaming\\llmbench\\bench-' + lastResult.ts + '.json' });
      }
    },
    diag: {
      copy: function () { return Promise.resolve({ chars: 4210 }); },
      share: function () { return Promise.resolve({ url: 'https://paste.rs/mock', chars: 4210 }); }
    },
    wg: {
      info: function () {
        return Promise.resolve({
          installed: true, version: 'wireguard-tools v1.0.20210914', configured: true,
          serverPublicKey: 'MOCKSERVERPUBKEY', address: '10.66.0.1', port: 51820,
          endpoint: '203.0.113.7', serve: true, apiKey: 'mockapikey1234567890',
          peers: [{ name: '노트북', address: '10.66.0.2', publicKey: 'MOCKPEER1' }],
          firewall: { udp: true, tcp: true },
          listen: { port: 8080, addresses: ['0.0.0.0'], open: true },
          blocked: [],
          status: { installed: true, running: true, tunnel: 'llmbench', listenPort: 51820,
            peers: [{ publicKey: 'MOCKPEER1', name: '노트북', endpoint: '198.51.100.9:1234',
              allowedIps: '10.66.0.2/32', lastHandshake: new Date().toISOString(), rxBytes: 1024, txBytes: 2048 }] }
        });
      },
      publicIp: function () { return Promise.resolve('203.0.113.7'); },
      unblock: function () { return Promise.resolve({ ok: true, left: [] }); },
      localIps: function () { return Promise.resolve([{ name: '이더넷', address: '192.168.0.30', virtual: false }]); },
      up: function () { return Promise.resolve({ ok: true }); },
      down: function () { return Promise.resolve({ ok: true }); },
      addPeer: function (n) { return Promise.resolve({ name: n, address: '10.66.0.3' }); },
      removePeer: function () { return Promise.resolve({ ok: true }); },
      setEndpoint: function (ep) { return Promise.resolve({ endpoint: ep }); },
      setServe: function (on) { return Promise.resolve({ serve: on }); },
      rotateApiKey: function () { return Promise.resolve({ apiKey: 'newmockapikey0987654321' }); },
      invite: function () { return Promise.resolve('LLMB1.bW9ja2ludml0ZWNvZGU'); },
      peerConf: function () { return Promise.resolve('[Interface]' + String.fromCharCode(10) + 'PrivateKey = MOCK' + String.fromCharCode(10)); },
      savePeerConf: function () { return Promise.resolve({ saved: true, path: 'C:\temp\peer.conf' }); }
    },
    term: {
      start: function () { return Promise.resolve({ ok: true }); },
      write: function () { return Promise.resolve({ ok: true }); },
      resize: function () { return Promise.resolve({ ok: true }); },
      kill: function () { return Promise.resolve({ ok: true }); },
      snapshot: function () { return Promise.resolve({ running: true, buf: 'C:\\workspace>' }); }
    },
    shell: {
      openPath: function (p) { console.log('[mock] openPath', p); return Promise.resolve(); }
    },
    app: {
      isAdmin: function () { return Promise.resolve(false); },
      version: function () { return Promise.resolve('0.2.0'); },
      copy: function () { return Promise.resolve({ ok: true }); },
      paste: function () { return Promise.resolve('붙여넣은 글'); }
    },
    update: {
      check: function () {
        return Promise.resolve({ current: '0.2.0', latest: '0.3.0', available: true, notes: '목 업데이트', zipUrl: 'mock', sha256: '', error: null });
      },
      apply: function () {
        var pct = 0;
        return new Promise(function (resolve) {
          var timer = setInterval(function () {
            pct += 25;
            emit('update:progress', { stage: 'download', percent: pct, text: '0.3.0 받는 중' });
            if (pct >= 100) {
              clearInterval(timer);
              emit('update:progress', { stage: 'restart', percent: 100, text: '앱을 다시 시작한다' });
              resolve({ ok: true, error: null });
            }
          }, 300);
        });
      }
    }
  };
})();
