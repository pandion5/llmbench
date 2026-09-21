/*
 * llmbench 렌더러.
 * CONTRACT.md의 window.api만 호출한다. 프레임워크·외부 리소스 없음.
 */
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };

  // ---------- 공통 유틸 ----------

  // 숫자 포맷. 값이 없으면 '-'.
  function num(v, digits) {
    if (v === null || v === undefined || isNaN(v)) return '-';
    return Number(v).toFixed(digits === undefined ? 0 : digits);
  }

  // 금액은 1원 미만도 의미가 있어서 작은 값은 소수점까지 보여준다.
  function krw(v) {
    if (v === null || v === undefined || isNaN(v)) return '-';
    if (v < 1) return v.toFixed(2) + '원';
    if (v < 10) return v.toFixed(1) + '원';
    return Math.round(v).toLocaleString('ko-KR') + '원';
  }

  function setText(sel, text) {
    var el = $(sel);
    if (el) el.textContent = text;
  }

  // 거부된 Promise에서 사람이 읽을 문구만 뽑는다.
  function errText(err) {
    return err && err.message ? err.message : String(err);
  }

  var STATUS_LABEL = { pass: '정상', warn: '주의', fail: '불가' };
  var SERVER_LABEL = { stopped: '정지됨', starting: '시작 중', ready: '준비됨', error: '오류' };

  // ---------- 상태 ----------

  var state = {
    config: null,
    check: null,
    install: null,
    server: { state: 'stopped', pid: null, models: [], error: null },
    snapshot: null,
    benchResult: null,
    benchProgress: null,
    benchRunning: false,
    exportPath: null,
    harness: [],         // 하네스 목록
    specLogPath: null,   // 마지막 점검 결과가 저장된 경로
    history: []          // 최근 60초 모니터 이력
  };

  // 현재 탭에서 등록한 이벤트 구독 해제 함수. 탭을 떠날 때 모두 호출한다.
  var tabOffs = [];

  function subscribe(channel, cb) {
    var off = window.api.on(channel, cb);
    tabOffs.push(typeof off === 'function' ? off : function () {});
  }

  function unsubscribeAll() {
    while (tabOffs.length) {
      try { tabOffs.pop()(); } catch (e) { /* 해제 실패는 무시 */ }
    }
  }

  // ---------- 탭 ----------

  var TABS = {
    check: { mount: mountCheck },
    install: { mount: mountInstall },
    dashboard: { mount: mountDashboard },
    bench: { mount: mountBench },
    harness: { mount: mountHarness }
  };

  var currentTab = null;

  function switchTab(name) {
    if (currentTab === name) return;
    unsubscribeAll();
    currentTab = name;

    Object.keys(TABS).forEach(function (key) {
      var tab = $('#tab-' + key);
      var panel = $('#panel-' + key);
      var on = key === name;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      panel.classList.toggle('is-active', on);
      panel.hidden = !on;
    });

    TABS[name].mount();
  }

  // ---------- 상단 상태 뱃지 ----------

  function renderServerBadge() {
    var el = $('#server-badge');
    var s = state.server || { state: 'stopped' };
    el.className = 'badge st-' + s.state;
    el.textContent = '서버 ' + (SERVER_LABEL[s.state] || s.state);
    if (s.state === 'error' && s.error) el.title = s.error;
  }

  // ---------- ① 점검 ----------

  function mountCheck() {
    if (state.check) renderCheck(state.check);
  }

  function renderCheck(report) {
    var rows = $('#check-rows');
    rows.textContent = '';

    report.items.forEach(function (item) {
      var tr = document.createElement('tr');

      var th = document.createElement('th');
      th.scope = 'row';
      th.textContent = item.label;
      tr.appendChild(th);

      [item.value, item.need].forEach(function (text) {
        var td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });

      var tdState = document.createElement('td');
      var tag = document.createElement('span');
      tag.className = 'status-tag s-' + item.status;
      var dot = document.createElement('span');
      dot.className = 'status-dot';
      tag.appendChild(dot);
      // 색만으로 구분되지 않도록 텍스트 라벨을 함께 표시한다.
      tag.appendChild(document.createTextNode(STATUS_LABEL[item.status] || item.status));
      tdState.appendChild(tag);
      tr.appendChild(tdState);

      rows.appendChild(tr);
    });

    $('#check-table').hidden = false;

    var hasFail = report.items.some(function (i) { return i.status === 'fail'; });
    var hasWarn = report.items.some(function (i) { return i.status === 'warn'; });
    var banner = $('#check-banner');
    banner.textContent = '';
    banner.hidden = false;

    var msg = document.createElement('span');
    if (hasFail) {
      banner.className = 'banner banner-fail';
      msg.textContent = '조건을 만족하지 못한 항목이 있다. 설치를 진행할 수 없다.';
    } else if (hasWarn) {
      banner.className = 'banner banner-warn';
      msg.textContent = '설치는 가능하지만 주의할 항목이 있다.';
    } else {
      banner.className = 'banner banner-pass';
      msg.textContent = '설치 가능한 상태다.';
    }
    banner.appendChild(msg);

    if (!hasFail) {
      var go = document.createElement('button');
      go.type = 'button';
      go.className = 'btn';
      go.textContent = '설치 탭으로 이동';
      go.addEventListener('click', function () { switchTab('install'); });
      banner.appendChild(go);
    }

    renderHw(report.hw);
    renderSpecPath(report.specLogPath);
  }

  // 점검 결과 파일은 main이 저장한다. 경로를 알려주고 탐색기로 열 수 있게 한다.
  function renderSpecPath(path) {
    state.specLogPath = path || null;
    var box = $('#check-spec');
    if (!path) {
      box.hidden = true;
      return;
    }
    setText('#check-spec-text', '점검 결과를 ' + path + ' 에 저장했다.');
    box.hidden = false;
  }

  $('#check-spec-open').addEventListener('click', function () {
    if (state.specLogPath) window.api.shell.openPath(state.specLogPath);
  });

  function renderHw(hw) {
    var kv = $('#hw-kv');
    kv.textContent = '';

    function addRow(key, value) {
      var dt = document.createElement('dt');
      dt.textContent = key;
      var dd = document.createElement('dd');
      dd.textContent = value;
      kv.appendChild(dt);
      kv.appendChild(dd);
    }

    addRow('GPU', hw.gpu ? hw.gpu.name + ' / VRAM ' + num(hw.gpu.vramMB / 1024, 0) + 'GB / 드라이버 ' + hw.gpu.driver : 'NVIDIA GPU 없음');
    addRow('CPU', hw.cpu.name + ' (' + hw.cpu.cores + '코어 / ' + hw.cpu.threads + '스레드)');
    // RAM은 용량만으로는 생성 속도를 못 본다. 속도·모듈 수·추정 대역폭을 같이 적는다.
    var ram = hw.ram || {};
    var ramParts = [(ram.totalGB || hw.ramGB) + 'GB'];
    if (ram.speedMTs) ramParts.push(ram.speedMTs + ' MT/s');
    if (ram.modules) ramParts.push(ram.modules + '개 모듈');
    ramParts.push(ram.bandwidthGBps
      ? '대역폭 약 ' + num(ram.bandwidthGBps, 1) + ' GB/s'
      : '대역폭 알 수 없음');
    addRow('RAM', ramParts.join(' · '));

    var tbody = $('#hw-drives');
    tbody.textContent = '';
    var current = hw.ssd ? hw.ssd.letter : '';
    hw.drives.forEach(function (d) {
      var tr = document.createElement('tr');
      [d.letter, num(d.freeGB, 0) + 'GB', num(d.totalGB, 0) + 'GB', d.media].forEach(function (text) {
        var td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });
      // 설치 위치 열: 현재 드라이브면 표시, 아니면 선택 버튼. 누르면 설치 경로를 바꾸고 점검을 다시 돌린다.
      var td = document.createElement('td');
      if (d.letter === current) {
        td.textContent = '현재';
      } else {
        var pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'btn btn-sm';
        pick.textContent = d.letter + ':\\llm\\qwen 에 설치';
        pick.addEventListener('click', function () {
          pick.disabled = true;
          window.api.config.set({ installDir: d.letter + ':\\llm\\qwen' }).then(function () {
            $('#check-run').click();
          });
        });
        td.appendChild(pick);
      }
      tr.appendChild(td);
      tbody.appendChild(tr);
    });

    setText('#hw-ssd', hw.ssd
      ? '설치 대상 드라이브 ' + hw.ssd.letter + ' 간이 측정: 읽기 ' + num(hw.ssd.readMBps, 0) + 'MB/s, 쓰기 ' + num(hw.ssd.writeMBps, 0) + 'MB/s'
      : '드라이브 속도 측정값 없음');

    $('#hw-card').hidden = false;
  }

  $('#check-run').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    setText('#check-hint', '점검 중이다. 드라이브 속도 측정 때문에 몇 초 걸린다.');
    window.api.check.run().then(function (report) {
      state.check = report;
      renderCheck(report);
      setText('#check-hint', '점검 항목 ' + report.items.length + '개를 확인했다.');
    }).catch(function (err) {
      setText('#check-hint', '점검에 실패했다: ' + (err && err.message ? err.message : String(err)));
    }).then(function () {
      btn.disabled = false;
    });
  });

  // ---------- ② 설치 ----------

  function fillConfigForm(cfg) {
    state.config = cfg;
    $('#cfg-installDir').value = cfg.installDir;
    $('#cfg-quant').value = cfg.quant;
    $('#cfg-threads').value = cfg.threads;
    $('#cfg-ctx').value = cfg.ctx;
    $('#cfg-kwhPrice').value = cfg.kwhPrice;
    $('#cfg-autoLoad36').checked = cfg.autoLoad36 !== false;
    $('#cfg-mtp').checked = cfg.mtp === true;
    $('#cfg-mtpFile').value = cfg.mtpFile;
    $('#cfg-loadMode').value = cfg.loadMode;
    $('#cfg-ncmoe38').value = cfg.ncmoe38;
    $('#cfg-poll').value = cfg.poll;
    $('#cfg-cpuMask').value = cfg.cpuMask || '';
  }

  $('#config-export').addEventListener('click', function () {
    window.api.config.export().then(function (r) {
      setText('#config-msg', r.path ? '내보냈다: ' + r.path : '취소했다.');
    });
  });

  $('#config-import').addEventListener('click', function () {
    window.api.config.import().then(function (r) {
      if (r.error) {
        setText('#config-msg', '가져오지 못했다: ' + r.error);
        return;
      }
      if (!r.config) {
        setText('#config-msg', '취소했다.');
        return;
      }
      fillConfigForm(r.config);
      setText('#config-msg', '가져와서 저장했다: ' + r.path + '. 설치를 다시 실행하면 반영된다.');
    });
  });

  $('#config-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var partial = {
      installDir: $('#cfg-installDir').value.trim(),
      quant: $('#cfg-quant').value,
      threads: Number($('#cfg-threads').value),
      ctx: Number($('#cfg-ctx').value),
      kwhPrice: Number($('#cfg-kwhPrice').value),
      autoLoad36: $('#cfg-autoLoad36').checked,
      mtp: $('#cfg-mtp').checked,
      mtpFile: $('#cfg-mtpFile').value,
      loadMode: $('#cfg-loadMode').value,
      ncmoe38: Number($('#cfg-ncmoe38').value),
      poll: Number($('#cfg-poll').value),
      cpuMask: $('#cfg-cpuMask').value.trim()
    };
    if (!partial.installDir) {
      setText('#config-msg', '설치 경로를 입력해야 한다.');
      return;
    }
    window.api.config.set(partial).then(function (cfg) {
      fillConfigForm(cfg);
      setText('#config-msg', '설정을 저장했다.');
    }).catch(function (err) {
      setText('#config-msg', '저장 실패: ' + (err && err.message ? err.message : String(err)));
    });
  });

  function renderInstall(status) {
    state.install = status;

    var list = $('#install-steps');
    list.textContent = '';

    status.steps.forEach(function (step) {
      var li = document.createElement('li');
      li.className = 'step step-' + step.status;

      var head = document.createElement('div');
      head.className = 'step-head';

      if (step.status === 'running') {
        var sp = document.createElement('span');
        sp.className = 'spinner';
        head.appendChild(sp);
      }

      var label = document.createElement('span');
      label.className = 'step-label';
      label.textContent = step.label;
      head.appendChild(label);

      var tag = document.createElement('span');
      tag.className = 'status-tag step-state';
      tag.textContent = {
        pending: '대기', running: '진행 중', done: '끝남', error: '오류', skipped: '건너뜀'
      }[step.status] || step.status;
      head.appendChild(tag);

      li.appendChild(head);

      if (typeof step.percent === 'number') {
        var bar = document.createElement('div');
        bar.className = 'bar';
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuenow', String(Math.round(step.percent)));
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        var fill = document.createElement('span');
        fill.style.width = Math.max(0, Math.min(100, step.percent)) + '%';
        bar.appendChild(fill);
        li.appendChild(bar);
      }

      if (step.detail) {
        var detail = document.createElement('div');
        detail.className = 'step-detail';
        detail.textContent = step.detail;
        li.appendChild(detail);
      }

      list.appendChild(li);
    });

    var log = $('#install-log');
    var atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.textContent = (status.log || []).slice(-200).join('\n');
    if (atBottom) log.scrollTop = log.scrollHeight;   // 아래를 보고 있을 때만 자동 스크롤

    $('#install-start').disabled = status.running;
    $('#install-cancel').disabled = !status.running;
  }

  // 점검 결과에 warn만 있고 fail은 없는 상태인지 본다.
  function hasWarnOnly() {
    if (!state.check) return false;
    var items = state.check.items;
    var fail = items.some(function (i) { return i.status === 'fail'; });
    var warn = items.some(function (i) { return i.status === 'warn'; });
    return warn && !fail;
  }

  function requestInstall(allowWarn) {
    setText('#install-msg', '');
    $('#install-confirm').hidden = true;

    window.api.install.start(allowWarn ? { allowWarn: true } : {}).then(function (res) {
      if (res && res.started) return;

      setText('#install-msg', (res && res.reason) ? res.reason : '설치를 시작하지 못했다.');
      // 주의 항목만 걸린 경우에는 사용자가 그대로 진행할 수 있게 확인을 띄운다.
      if (!allowWarn && hasWarnOnly()) $('#install-confirm').hidden = false;
    });
  }

  $('#install-start').addEventListener('click', function () { requestInstall(false); });
  $('#install-confirm-yes').addEventListener('click', function () { requestInstall(true); });
  $('#install-confirm-no').addEventListener('click', function () {
    $('#install-confirm').hidden = true;
    setText('#install-msg', '설치를 시작하지 않았다.');
  });

  $('#install-cancel').addEventListener('click', function () {
    window.api.install.cancel();
    setText('#install-msg', '취소를 요청했다.');
  });

  function mountInstall() {
    window.api.config.get().then(fillConfigForm);
    window.api.install.status().then(renderInstall);
    subscribe('install:progress', renderInstall);
  }

  // ---------- ③ 대시보드 ----------

  function renderModels() {
    var list = $('#model-list');
    list.textContent = '';
    var srv = state.server || { state: 'stopped', models: [] };
    var models = srv.models || [];
    var stopped = srv.state === 'stopped' || srv.state === 'error';
    if (stopped || !models.length) {
      var li = document.createElement('li');
      li.className = 'hint';
      // 서버가 내려가 있으면 목록이 비는 게 정상이라는 걸 분명히 적는다.
      li.textContent = stopped
        ? '서버 정지됨. 모델 없음'
        : '서버가 준비되면 모델 목록이 나온다.';
      list.appendChild(li);
      return;
    }
    models.forEach(function (m) {
      var li = document.createElement('li');
      var name = document.createElement('span');
      name.textContent = m.id;
      var tag = document.createElement('span');
      tag.className = 'status-tag ' + (m.loaded ? 's-pass' : '');
      var dot = document.createElement('span');
      dot.className = 'status-dot';
      tag.appendChild(dot);
      tag.appendChild(document.createTextNode(m.loaded ? '로드됨' : '미로드'));
      li.appendChild(name);
      li.appendChild(tag);
      list.appendChild(li);
    });
  }

  function renderSnapshot(snap) {
    state.snapshot = snap;

    state.history.push(snap);
    if (state.history.length > 60) state.history.shift();

    if (currentTab !== 'dashboard') return;

    var price = state.config ? state.config.kwhPrice : 0;

    if (snap.gpu) {
      setText('#m-gpu-util', num(snap.gpu.utilPct, 0) + '%');
      setText('#m-vram', num(snap.gpu.memUsedMB / 1024, 1) + 'GB');
      setText('#m-vram-sub', '전체 ' + num(snap.gpu.memTotalMB / 1024, 0) + 'GB');
      setText('#m-power', num(snap.gpu.powerW, 0) + 'W');
      setText('#m-power-krw', '시간당 약 ' + krw(snap.gpu.powerW / 1000 * price));
      setText('#m-temp', num(snap.gpu.tempC, 0) + '℃');
    } else {
      setText('#m-gpu-util', '-');
      setText('#m-gpu-name', 'GPU 정보를 읽지 못했다');
    }

    setText('#m-ram', num(snap.ram.usedGB, 1) + 'GB');
    setText('#m-ram-sub', '전체 ' + num(snap.ram.totalGB, 0) + 'GB');
    setText('#m-cpu', num(snap.cpuPct, 0) + '%');
    setText('#m-disk', num(snap.disk.freeGB, 0) + 'GB');
    setText('#m-disk-sub', snap.disk.letter + ' 드라이브');

    // 점검에서 측정한 SSD 속도 캐시. 점검 전이면 값이 없다.
    if (snap.ssd) {
      setText('#m-ssd', num(snap.ssd.writeMBps, 0) + ' MB/s');
      setText('#m-ssd-sub', snap.ssd.letter + ' 쓰기 / 읽기 ' + num(snap.ssd.readMBps, 0) + ' MB/s');
    } else {
      setText('#m-ssd', '점검 전');
      setText('#m-ssd-sub', '점검 탭에서 점검을 실행하면 측정된다.');
    }

    // 이 세션의 마지막 벤치 요약.
    if (snap.lastBench) {
      setText('#m-bench', num(snap.lastBench.genTokPerSec, 1) + ' tok/s');
      setText('#m-bench-sub', snap.lastBench.model +
        ' · 프롬프트 처리 ' + num(snap.lastBench.promptTokPerSec, 1) + ' tok/s');
    } else {
      setText('#m-bench', '벤치 전');
      setText('#m-bench-sub', '벤치마크 탭에서 한 번 돌리면 여기에 나온다.');
    }

    drawChart($('#chart-power'), state.history.map(function (s) {
      return s.gpu ? s.gpu.powerW : 0;
    }), null, '#4c8dff');
    drawChart($('#chart-util'), state.history.map(function (s) {
      return s.gpu ? s.gpu.utilPct : 0;
    }), 100, '#3fb950');
  }

  // 외부 라이브러리 없이 canvas로 직접 그리는 미니 라인 차트.
  function drawChart(canvas, data, fixedMax, color) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || 600;
    var h = 120;
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = '#333843';
    ctx.lineWidth = 1;
    for (var i = 1; i < 4; i++) {
      var y = h * i / 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    if (!data.length) return;
    var max = fixedMax || Math.max.apply(null, data) * 1.2 || 1;
    var step = data.length > 1 ? w / (data.length - 1) : w;

    ctx.beginPath();
    data.forEach(function (v, idx) {
      var x = idx * step;
      var y = h - (v / max) * (h - 6) - 3;
      if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#9aa2b1';
    ctx.font = '11px sans-serif';
    ctx.fillText('최대 ' + num(max, 0), 4, 12);
  }

  $('#diag-copy').addEventListener('click', function () {
    window.api.diag.copy().then(function (r) {
      setText('#server-log-msg', '진단 정보 ' + r.chars + '자를 클립보드에 복사했다. 붙여넣기로 전달한다.');
    }).catch(function (err) {
      setText('#server-log-msg', '복사 실패: ' + (err && err.message ? err.message : String(err)));
    });
  });

  $('#diag-share').addEventListener('click', function () {
    if (!confirm('진단 정보를 paste.rs에 공개로 올린다. 주소를 아는 사람은 누구나 볼 수 있다. 진행한다?')) return;
    setText('#server-log-msg', '올리는 중');
    window.api.diag.share().then(function (r) {
      setText('#server-log-msg', '올렸다: ' + r.url + ' (주소를 클립보드에 복사했다)');
    }).catch(function (err) {
      setText('#server-log-msg', '올리지 못했다: ' + (err && err.message ? err.message : String(err)));
    });
  });

  $('#server-log-refresh').addEventListener('click', function () {
    refreshServerLog().then(function () {
      setText('#server-log-msg', '');
    });
  });

  $('#server-log-save').addEventListener('click', function () {
    window.api.server.saveLogs().then(function (r) {
      setText('#server-log-msg', '저장했다: ' + r.path);
    }).catch(function (err) {
      setText('#server-log-msg', '저장 실패: ' + (err && err.message ? err.message : String(err)));
    });
  });

  $('#server-start').addEventListener('click', function () {
    setText('#server-msg', '서버를 시작하는 중이다.');
    window.api.server.start().then(applyServerStatus);
  });

  $('#server-stop').addEventListener('click', function () {
    setText('#server-msg', '서버를 정지하는 중이다.');
    window.api.server.stop().then(applyServerStatus);
  });

  function applyServerStatus(status) {
    state.server = status;
    renderServerBadge();
    if (currentTab === 'dashboard') {
      renderModels();
      $('#server-start').disabled = status.state === 'ready' || status.state === 'starting';
      $('#server-stop').disabled = status.state === 'stopped';
      setText('#server-msg', status.error ? status.error : '');
    }
    if (currentTab === 'bench') renderBenchModels();
    if (currentTab === 'dashboard') refreshServerLog();
  }

  // 서버가 내보낸 줄을 그대로 보여준다. 모델 로드 실패 이유가 여기 찍힌다.
  function refreshServerLog() {
    return window.api.server.logs().then(function (lines) {
      var pre = $('#server-log');
      pre.textContent = lines.length ? lines.join('\n') : '아직 서버를 띄우지 않았다.';
      pre.scrollTop = pre.scrollHeight;
    });
  }

  function mountDashboard() {
    window.api.monitor.snapshot().then(renderSnapshot);
    window.api.server.status().then(applyServerStatus);
    refreshServerLog();
    renderModels();
    if (state.check && state.check.hw && state.check.hw.gpu) {
      setText('#m-gpu-name', state.check.hw.gpu.name);
    }
  }

  // ---------- ④ 벤치마크 ----------

  function benchMode() {
    var r = document.querySelector('input[name="bench-mode"]:checked');
    return r ? r.value : 'standard';
  }

  function renderBenchModels() {
    var sel = $('#bench-model');
    var prev = sel.value;
    sel.textContent = '';
    // 표준 모드는 서버와 무관하게 설치된 두 모델을 고른다
    var models = benchMode() === 'standard'
      ? [{ id: 'qwen38', loaded: false }, { id: 'qwen36', loaded: false }]
      : (state.server && state.server.models) || [];
    if (!models.length) {
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '모델 없음';
      sel.appendChild(opt);
      return;
    }
    models.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.id + (m.loaded ? ' (로드됨)' : '');
      sel.appendChild(o);
    });
    if (prev) sel.value = prev;
  }

  function renderBenchProgress(p) {
    state.benchProgress = p;
    $('#bench-live').hidden = false;
    setText('#bench-progress-text', benchMode() === 'standard'
      ? (p.promptIdx === 0 ? 'pp512 프롬프트 처리 측정 중' : 'tg128 생성 측정 중') + ' (' + (p.promptIdx + 1) + '/' + p.total + ')'
      : '프롬프트 ' + (p.promptIdx + 1) + '/' + p.total +
        ' · 생성 ' + p.tokens + '토큰 · ' + num(p.tokPerSec, 1) + ' tok/s');
    var pre = $('#bench-stream');
    pre.textContent = p.text;
    pre.scrollTop = pre.scrollHeight;
  }

  function renderTuning(result) {
    var t = result.tuning;
    var tbody = $('#tuning-rows');
    tbody.textContent = '';
    t.rows.forEach(function (r, i) {
      var tr = document.createElement('tr');
      if (i === 0) tr.className = 'row-best';
      [r.threads, r.poll, r.cpuMask === '0x0' ? '없음' : r.cpuMask, num(r.tg128, 2), num(r.stddev, 2)].forEach(function (text, j) {
        var cell = document.createElement(j === 0 ? 'th' : 'td');
        if (j === 0) cell.scope = 'row';
        cell.textContent = text;
        tr.appendChild(cell);
      });
      tbody.appendChild(tr);
    });
    var best = t.rows[0];
    var note = t.gguf + ' · CPU 전문가 ' + t.ncmoe + ' · ' + t.rows.length + '조합 ' + num(t.seconds, 0) + '초. ';
    note += '가장 빠름: 스레드 ' + best.threads + ', poll ' + best.poll + ', 마스크 ' + (best.cpuMask === '0x0' ? '없음' : best.cpuMask) + ' → ' + num(best.tg128, 2) + ' tok/s';
    if (t.currentTg128 !== null && t.currentTg128 !== undefined) {
      note += ' (현재 설정 ' + num(t.currentTg128, 2) + ', ' + num((best.tg128 / t.currentTg128 - 1) * 100, 1) + '% 차이)';
    }
    setText('#tuning-note', note);
    setText('#tuning-apply-msg', '');
    $('#bench-tuning-card').hidden = false;
  }

  function renderBenchResult(result) {
    state.benchResult = result;
    $('#bench-tuning-card').hidden = result.mode !== 'tuning';
    $('#bench-answers-card').hidden = true;
    $('#bench-verdict-card').hidden = true;
    if (result.mode === 'tuning') {
      $('#bench-table').hidden = true;
      $('#bench-summary-card').hidden = true;
      renderTuning(result);
      return;
    }

    var tbody = $('#bench-rows');
    tbody.textContent = '';
    result.runs.forEach(function (run) {
      var tr = document.createElement('tr');
      var th = document.createElement('th');
      th.scope = 'row';
      th.textContent = run.prompt.length > 40 ? run.prompt.slice(0, 40) + '…' : run.prompt;
      th.title = run.prompt;
      tr.appendChild(th);
      [
        num(run.promptTokPerSec, 1),
        num(run.genTokPerSec, 1),
        num(run.seconds, 1),
        num(run.avgPowerW, 0),
        num(run.wh, 2),
        // 서버가 timings를 안 주면 클라이언트 측정값으로 대체된 것이다.
        run.timingsSource === 'client' ? '클라이언트 측정' : '서버 timings'
      ].forEach(function (text) {
        var td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    $('#bench-table').hidden = result.mode === 'standard';

    // 체감 모드는 답변 전문을 프롬프트별로 펼쳐 볼 수 있게 둔다
    var answers = $('#bench-answers');
    answers.textContent = '';
    var hasAnswers = result.runs.some(function (r) { return typeof r.answer === 'string'; });
    result.runs.forEach(function (run, i) {
      if (typeof run.answer !== 'string') return;
      var det = document.createElement('details');
      det.className = 'answer';
      if (i === 0) det.open = true;
      var sum = document.createElement('summary');
      sum.textContent = run.prompt;
      var meta = document.createElement('span');
      meta.className = 'answer-meta';
      meta.textContent = run.genTokens + '토큰 · ' + num(run.genTokPerSec, 1) + ' tok/s' + (run.truncated ? ' · 상한에 걸려 잘림' : '');
      sum.appendChild(meta);
      var pre = document.createElement('pre');
      pre.textContent = run.answer;
      det.appendChild(sum);
      det.appendChild(pre);
      answers.appendChild(det);
    });
    $('#bench-answers-card').hidden = !hasAnswers;

    var s = result.summary;
    var cards = result.mode === 'standard' ? [
      ['pp512 프롬프트 처리', num(s.avgPromptTokPerSec, 1) + ' tok/s', '±' + num(result.standard.pp512.stddevTs, 1) + ' · ' + result.standard.reps + '회 평균'],
      ['tg128 생성', num(s.avgGenTokPerSec, 1) + ' tok/s', '±' + num(result.standard.tg128.stddevTs, 1) + ' · 커뮤니티 비교 지표'],
      ['평균 전력', num(s.avgPowerW, 0) + 'W', 'GPU, 로드 포함 ' + num(result.standard.seconds, 0) + '초'],
      ['생성 1000토큰당', num(result.standard.whPer1kGenTokens, 2) + 'Wh', krw(s.krwPer1kTokens) + (state.config ? ' · ' + state.config.kwhPrice + '원/kWh' : '')],
      ['조건', result.standard.gguf, '스레드 ' + result.standard.threads + ' · CPU 전문가 ' + result.standard.ncmoe + ' · build ' + result.standard.build]
    ] : [
      ['평균 생성 속도', num(s.avgGenTokPerSec, 1) + ' tok/s', '프롬프트 처리 ' + num(s.avgPromptTokPerSec, 1) + ' tok/s'],
      ['평균 전력', num(s.avgPowerW, 0) + 'W', 'GPU 측정 구간 평균'],
      ['총 에너지', num(s.totalWh, 2) + 'Wh', '이번 벤치 전체'],
      ['전기요금', krw(s.krw), state.config ? state.config.kwhPrice + '원/kWh 기준' : ''],
      ['1000토큰당', krw(s.krwPer1kTokens), '생성 토큰 기준']
    ];
    var box = $('#bench-summary');
    box.textContent = '';
    cards.forEach(function (c) {
      var div = document.createElement('div');
      div.className = 'metric';
      var label = document.createElement('span');
      label.className = 'metric-label';
      label.textContent = c[0];
      var value = document.createElement('strong');
      value.className = 'metric-value';
      value.textContent = c[1];
      var sub = document.createElement('span');
      sub.className = 'metric-sub';
      sub.textContent = c[2];
      div.appendChild(label);
      div.appendChild(value);
      div.appendChild(sub);
      box.appendChild(div);
    });
    $('#bench-summary-card').hidden = false;
    renderVerdict(result.verdict);
  }

  var BOTTLENECK_LABEL = {
    ram_capacity: 'RAM 용량',
    ram_bandwidth: 'RAM 대역폭',
    gpu: 'GPU',
    unknown: '특정하지 못함'
  };

  // 병목 종류별 한 줄 설명. 목표 미달일 때만 쓴다. 값이 없는 필드는 문장에서 뺀다.
  function bottleneckText(v) {
    if (v.bottleneck === 'ram_capacity') {
      return 'RAM 부족: 모델 합계 ' + num(v.modelBytesGB, 1) + ' GB > RAM ' + num(v.ramTotalGB, 0) +
        ' GB. 디스크에서 전문가를 읽고 있다.';
    }
    if (v.bottleneck === 'ram_bandwidth') {
      var now = v.bytesPerTokenGB !== null && v.bytesPerTokenGB !== undefined
        ? num(v.bytesPerTokenGB * v.genTokPerSec, 1) : null;
      var line = 'RAM 대역폭 한계';
      if (now && v.neededBandwidthGBps) {
        line += ': 현재 약 ' + now + ' GB/s, 20 tok/s에는 약 ' + num(v.neededBandwidthGBps, 1) +
          ' GB/s가 필요하다(' + num(v.neededBandwidthGBps / Number(now), 2) + '배).';
      } else if (v.neededBandwidthGBps) {
        line += ': 20 tok/s에는 약 ' + num(v.neededBandwidthGBps, 1) + ' GB/s가 필요하다.';
      } else {
        line += '다. 대역폭 값을 읽지 못해 필요량은 계산하지 않았다.';
      }
      return line;
    }
    if (v.bottleneck === 'gpu') {
      return 'GPU 한계: 사용률과 전력이 포화 상태다. RAM 대역폭보다 GPU가 먼저 막혔다.';
    }
    return '병목을 특정하지 못했다. 측정값이 모자라거나 조건이 섞여 있다.';
  }

  function renderVerdict(v) {
    var card = $('#bench-verdict-card');
    if (!v) {
      card.hidden = true;
      return;
    }

    setText('#verdict-speed', num(v.genTokPerSec, 1) + ' tok/s');

    var badge = $('#verdict-badge');
    badge.textContent = '';
    badge.className = 'status-tag ' + (v.reached ? 's-pass' : 's-warn');
    var dot = document.createElement('span');
    dot.className = 'status-dot';
    badge.appendChild(dot);
    badge.appendChild(document.createTextNode(
      v.reached ? '목표 ' + v.target + ' tok/s 도달' : '목표 ' + v.target + ' tok/s 미달'));

    // 목표에 이미 닿은 경우에는 "막혔다"는 문장이 배지와 어긋난다. 제한 요소만 짧게 적는다.
    setText('#verdict-bottleneck', v.reached
      ? '현재 제한 요소: ' + (BOTTLENECK_LABEL[v.bottleneck] || '특정하지 못함') + ' (목표는 이미 도달했다)'
      : bottleneckText(v));

    setText('#verdict-quant', '양자화를 Q4에서 IQ3_XXS로 낮추면 약 ' + num(v.quantDownTokPerSec, 1) +
      ' tok/s로 예상된다. ' + (v.quantDownReaches ? '이것만으로 20 tok/s에 닿는다.' : '이것만으로는 20 tok/s에 못 닿는다.'));

    var ul = $('#verdict-actions');
    ul.textContent = '';
    (v.actions || []).forEach(function (a) {
      var li = document.createElement('li');
      li.textContent = a;
      ul.appendChild(li);
    });

    card.hidden = false;
  }

  document.querySelectorAll('input[name="bench-mode"]').forEach(function (r) {
    r.addEventListener('change', function () { renderBenchModels(); setText('#bench-msg', ''); });
  });

  $('#bench-start').addEventListener('click', function () {
    var mode = benchMode();
    if (mode === 'prompts' && (!state.server || state.server.state !== 'ready')) {
      setText('#bench-msg', '서버가 준비되지 않았다. 대시보드 탭에서 서버를 먼저 시작한다.');
      return;
    }
    var model = $('#bench-model').value;
    if (!model) {
      setText('#bench-msg', '벤치에 사용할 모델을 고른다.');
      return;
    }

    setText('#bench-msg', '');
    state.benchRunning = true;
    $('#bench-start').disabled = true;
    $('#bench-cancel').disabled = false;
    $('#bench-live').hidden = false;
    $('#bench-stream').textContent = '';
    setText('#bench-progress-text', '시작하는 중');

    window.api.bench.run({ model: model, mode: mode }).then(function (result) {
      renderBenchResult(result);
      setText('#bench-msg', '벤치가 끝났다.');
    }).catch(function (err) {
      setText('#bench-msg', '벤치를 끝내지 못했다: ' + (err && err.message ? err.message : String(err)));
    }).then(function () {
      state.benchRunning = false;
      $('#bench-start').disabled = false;
      $('#bench-cancel').disabled = true;
    });
  });

  $('#bench-cancel').addEventListener('click', function () {
    window.api.bench.cancel();
    setText('#bench-msg', '취소를 요청했다.');
  });

  $('#tuning-apply').addEventListener('click', function () {
    var r = state.benchResult;
    if (!r || r.mode !== 'tuning') return;
    var b = r.tuning.best;
    window.api.config.set({ threads: b.threads, poll: b.poll, cpuMask: b.cpuMask }).then(function (cfg) {
      fillConfigForm(cfg);
      setText('#tuning-apply-msg', '스레드 ' + b.threads + ', poll ' + b.poll + ', 마스크 ' + (b.cpuMask || '없음') + '으로 저장했다.');
    }).catch(function (err) {
      setText('#tuning-apply-msg', '저장 실패: ' + (err && err.message ? err.message : String(err)));
    });
  });

  $('#bench-export').addEventListener('click', function () {
    window.api.bench.export().then(function (res) {
      state.exportPath = res.path;
      setText('#bench-export-path', res.path);
      $('#bench-open').hidden = false;
    }).catch(function (err) {
      setText('#bench-export-path', '저장 실패: ' + (err && err.message ? err.message : String(err)));
    });
  });

  $('#bench-open').addEventListener('click', function () {
    if (state.exportPath) window.api.shell.openPath(state.exportPath);
  });

  function mountBench() {
    window.api.server.status().then(applyServerStatus);
    renderBenchModels();
    if (state.benchProgress) renderBenchProgress(state.benchProgress);
    if (state.benchResult) renderBenchResult(state.benchResult);
    if (benchMode() === 'prompts' && (!state.server || state.server.state !== 'ready')) {
      setText('#bench-msg', '서버가 준비되지 않았다. 대시보드 탭에서 서버를 먼저 시작한다.');
    }
    subscribe('bench:progress', renderBenchProgress);
  }


  // ---------- ⑤ 하네스 (코딩 에이전트 CLI) ----------

  // 기본으로 권하는 하네스. 표에 표시만 한다.
  var HARNESS_RECOMMENDED = 'qwen-code';

  function harnessLog(line) {
    var pre = $('#harness-log');
    var atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    pre.textContent += (pre.textContent ? '\n' : '') + line;
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }

  function harnessOptions() {
    return {
      workDir: $('#harness-workdir').value.trim(),
      model: $('#harness-model').value
    };
  }

  function renderHarnessList(list) {
    state.harness = list;
    var rows = $('#harness-rows');
    rows.textContent = '';

    list.forEach(function (h) {
      var tr = document.createElement('tr');

      var th = document.createElement('th');
      th.scope = 'row';
      th.textContent = h.name;
      if (h.id === HARNESS_RECOMMENDED) {
        var rec = document.createElement('span');
        rec.className = 'harness-rec';
        rec.textContent = '기본 추천';
        th.appendChild(rec);
      }
      tr.appendChild(th);

      var tdNote = document.createElement('td');
      tdNote.className = 'harness-note';
      tdNote.textContent = h.note || '';
      tr.appendChild(tdNote);

      // 설치 상태는 색 대신 글자로도 읽히게 한다.
      var tdState = document.createElement('td');
      var tag = document.createElement('span');
      tag.className = 'status-tag' + (h.installed ? ' s-pass' : '');
      var dot = document.createElement('span');
      dot.className = 'status-dot';
      tag.appendChild(dot);
      tag.appendChild(document.createTextNode(
        h.installed ? '설치됨' + (h.version ? ' (' + h.version + ')' : '') : '설치 안 됨'));
      tdState.appendChild(tag);
      tr.appendChild(tdState);

      var tdAct = document.createElement('td');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm';
      if (h.installed) {
        btn.textContent = '터미널 열기';
        btn.addEventListener('click', function () {
          btn.disabled = true;
          setText('#harness-msg', h.name + ' 터미널을 여는 중이다.');
          window.api.harness.launch(h.id, harnessOptions()).then(function (res) {
            setText('#harness-msg', res && res.ok
              ? h.name + ' 터미널 창을 열었다.'
              : (res && res.error) || '터미널 창을 열지 못했다.');
          }).catch(function (err) {
            setText('#harness-msg', '터미널 창을 열지 못했다: ' + errText(err));
          }).then(function () { btn.disabled = false; });
        });
      } else {
        btn.textContent = '설치';
        btn.addEventListener('click', function () {
          btn.disabled = true;
          setText('#harness-msg', h.name + ' 설치를 시작했다. 로그를 확인한다.');
          window.api.harness.install(h.id).then(function (info) {
            setText('#harness-msg', h.name + ' 설치가 끝났다.');
            // 목록 전체를 다시 읽지 않고 해당 항목만 갱신한다.
            var next = (state.harness || []).map(function (x) {
              return x.id === (info && info.id ? info.id : h.id) ? info : x;
            });
            renderHarnessList(next);
          }).catch(function (err) {
            setText('#harness-msg', '설치에 실패했다: ' + errText(err));
            btn.disabled = false;
          });
        });
      }
      tdAct.appendChild(btn);
      tr.appendChild(tdAct);

      rows.appendChild(tr);
    });
  }

  function mountHarness() {
    window.api.server.status().then(applyServerStatus);
    window.api.harness.list().then(renderHarnessList).catch(function (err) {
      setText('#harness-msg', '하네스 목록을 읽지 못했다: ' + errText(err));
    });
    subscribe('harness:log', harnessLog);
  }

  // ---------- 시작 ----------

  window.startApp = function startApp() {
    Object.keys(TABS).forEach(function (key) {
      $('#tab-' + key).addEventListener('click', function () { switchTab(key); });
    });

    // 탭과 무관하게 항상 필요한 구독(한 번만 등록하므로 중복되지 않는다)
    window.api.on('server:status', applyServerStatus);
    window.api.on('monitor:tick', renderSnapshot);

    window.api.app.version().then(function (v) {
      setText('#version-badge', 'v' + v);
    });

    // 업데이트. 시작할 때 한 번 확인하고 새 버전이 있으면 버튼을 보인다.
    var updateBtn = $('#update-btn');
    window.api.on('update:progress', function (p) {
      updateBtn.disabled = p.stage !== 'error';
      updateBtn.textContent = p.stage === 'download' ? '업데이트 ' + p.percent + '%' : p.text;
      if (p.stage === 'error') updateBtn.title = p.text;
    });
    window.api.update.check().then(function (u) {
      if (!u.available) return;
      updateBtn.hidden = false;
      updateBtn.textContent = '새 버전 v' + u.latest + ' 업데이트';
      updateBtn.title = u.notes || '';
      updateBtn.addEventListener('click', function () {
        if (!confirm('v' + u.latest + '로 업데이트한다. 앱이 잠시 닫혔다가 다시 뜬다. 진행 중인 설치나 벤치는 끊긴다.')) return;
        updateBtn.disabled = true;
        updateBtn.textContent = '업데이트 준비 중';
        window.api.update.apply().then(function (r) {
          if (!r.ok) {
            updateBtn.disabled = false;
            updateBtn.textContent = '업데이트 실패, 다시 시도';
            updateBtn.title = r.error || '';
          }
        });
      });
    });

    window.api.app.isAdmin().then(function (isAdmin) {
      var el = $('#admin-badge');
      el.textContent = isAdmin ? '관리자 권한' : '일반 권한';
      el.className = 'badge ' + (isAdmin ? 'st-ready' : 'st-starting');
    });

    window.api.config.get().then(function (cfg) {
      fillConfigForm(cfg);
    });

    window.api.server.status().then(applyServerStatus);

    renderServerBadge();
    switchTab('check');
  };
})();
