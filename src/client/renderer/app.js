'use strict';
// 클라이언트 화면. 연결 상태에 따라 첫 화면과 본 화면을 바꾼다.

(function () {
  function $(sel) {
    return document.querySelector(sel);
  }

  function setText(sel, text) {
    var el = $(sel);
    if (el) el.textContent = text;
  }

  function errText(err) {
    return err && err.message ? err.message : String(err);
  }

  var state = { conn: null, messages: [], streaming: null, term: { xterm: null, fit: null, id: null, unsub: null } };

  // ---------- 화면 전환 ----------

  var TABS = ['chat', 'harness', 'conn', 'usage'];

  function switchTab(name) {
    TABS.forEach(function (key) {
      var tab = $('#tab-' + key);
      var panel = $('#panel-' + key);
      var on = key === name;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      panel.classList.toggle('is-active', on);
      panel.hidden = !on;
    });
    if (name === 'harness') loadHarness();
    if (name === 'conn') renderConn(state.conn);
    if (name === 'usage') mountUsage();
    usageTick(name === 'usage');
  }

  TABS.forEach(function (key) {
    $('#tab-' + key).addEventListener('click', function () { switchTab(key); });
  });

  // 초대 코드를 아직 안 넣었으면 첫 화면만 보인다.
  function applyMode(conn) {
    var setup = !conn || !conn.configured;
    $('#panel-setup').hidden = !setup;
    $('#panel-setup').classList.toggle('is-active', setup);
    document.querySelector('.tabs').hidden = setup;
    if (setup) {
      TABS.forEach(function (k) {
        $('#panel-' + k).hidden = true;
        $('#panel-' + k).classList.remove('is-active');
      });
      $('#setup-wg').hidden = !(conn && conn.installed === false);
    } else if (!TABS.some(function (k) { return !$('#panel-' + k).hidden; })) {
      switchTab('chat');
    }
  }

  function badge(conn) {
    var el = $('#conn-badge');
    el.className = 'badge';
    if (!conn || !conn.configured) {
      el.classList.add('st-stopped');
      el.textContent = '설정 전';
    } else if (conn.running) {
      el.classList.add('st-ready');
      el.textContent = conn.lastHandshake ? '연결됨' : '터널만 올라감';
    } else {
      el.classList.add('st-error');
      el.textContent = '끊김';
    }
  }

  function onConn(conn) {
    state.conn = conn;
    badge(conn);
    applyMode(conn);
    if (!$('#panel-conn').hidden) renderConn(conn);
  }

  window.api.on('conn:event', onConn);

  // ---------- 연결 ----------

  function kvFill(sel, pairs) {
    var el = $(sel);
    el.textContent = '';
    pairs.forEach(function (pair) {
      var dt = document.createElement('dt');
      dt.textContent = pair[0];
      var dd = document.createElement('dd');
      dd.textContent = pair[1];
      el.appendChild(dt);
      el.appendChild(dd);
    });
  }

  function renderConn(conn) {
    if (!conn) return;
    kvFill('#conn-kv', [
      ['WireGuard', conn.installed ? '설치됨' : '설치 안 됨'],
      ['초대 코드', conn.configured ? '넣어 둠' : '아직 없음'],
      ['터널', conn.running ? '올라가 있음' : '내려가 있음'],
      ['붙는 주소', conn.endpoint || '모름'],
      ['마지막 연결', conn.lastHandshake ? new Date(conn.lastHandshake).toLocaleString() : '없음 (서버까지 안 닿는다)'],
      ['주고받은 양', (conn.rxBytes || 0) + ' / ' + (conn.txBytes || 0) + ' 바이트'],
      ['서버 주소', conn.target ? conn.target.baseUrl : '모름'],
      ['이 기기 이름', conn.target ? conn.target.name : '모름']
    ]);
  }

  function refreshConn() {
    return window.api.conn.status().then(onConn);
  }

  $('#setup-apply').addEventListener('click', function () {
    var code = $('#setup-code').value.trim();
    if (!code) { setText('#setup-msg', '초대 코드를 붙여넣는다.'); return; }
    setText('#setup-msg', '연결하는 중');
    window.api.conn.apply(code).then(function (r) {
      setText('#setup-msg', r.name + '(으)로 등록했다. 터널을 올리는 중');
      return window.api.conn.up();
    }).then(function () {
      setText('#setup-msg', '연결했다.');
      return refreshConn();
    }).then(function () {
      switchTab('chat');
    }).catch(function (err) {
      setText('#setup-msg', '연결하지 못했다: ' + errText(err));
    });
  });

  $('#conn-up').addEventListener('click', function () {
    setText('#conn-msg', '터널을 올리는 중');
    window.api.conn.up().then(function () {
      setText('#conn-msg', '올렸다.');
      return refreshConn();
    }).catch(function (err) {
      setText('#conn-msg', '올리지 못했다: ' + errText(err));
    });
  });

  $('#conn-down').addEventListener('click', function () {
    window.api.conn.down().then(function () {
      setText('#conn-msg', '끊었다.');
      return refreshConn();
    });
  });

  $('#conn-check').addEventListener('click', function () {
    setText('#conn-msg', '서버에 물어보는 중');
    window.api.conn.health().then(function (ok) {
      if (!ok) { setText('#conn-msg', '서버가 응답하지 않는다. 서버 PC에서 llama-server가 떠 있는지 본다.'); return; }
      return window.api.conn.models().then(function (ms) {
        var loaded = ms.filter(function (m) { return m.loaded; }).map(function (m) { return m.id; });
        setText('#conn-msg', '응답했다. 올라온 모델: ' + (loaded.join(', ') || '없음'));
      });
    }).catch(function (err) {
      setText('#conn-msg', '확인하지 못했다: ' + errText(err));
    });
  });

  $('#conn-apply').addEventListener('click', function () {
    var code = $('#conn-code').value.trim();
    if (!code) { setText('#conn-msg', '초대 코드를 붙여넣는다.'); return; }
    window.api.conn.apply(code).then(function () {
      $('#conn-code').value = '';
      return window.api.conn.up();
    }).then(function () {
      setText('#conn-msg', '새 초대 코드로 다시 연결했다.');
      return refreshConn();
    }).catch(function (err) {
      setText('#conn-msg', '적용하지 못했다: ' + errText(err));
    });
  });

  $('#conn-forget').addEventListener('click', function () {
    if (!confirm('연결 정보를 지운다. 다시 쓰려면 초대 코드를 새로 받아야 한다. 진행할까?')) return;
    window.api.conn.forget().then(function () {
      setText('#conn-msg', '지웠다.');
      return refreshConn();
    });
  });

  // ---------- 대화 ----------

  function scrollLog() {
    $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
  }

  function addMsg(role, text) {
    var div = document.createElement('div');
    div.className = 'msg ' + (role === 'user' ? 'msg-user' : role === 'error' ? 'msg-error' : 'msg-bot');
    div.textContent = text;
    $('#chat-log').appendChild(div);
    scrollLog();
    return div;
  }

  // 답이 흘러 들어올 말풍선을 만든다. 생각 과정은 본문 위에 따로 쌓는다.
  function startAnswer() {
    var box = document.createElement('div');
    box.className = 'msg msg-bot';
    var body = document.createElement('div');
    body.className = 'msg-body';
    box.appendChild(body);
    $('#chat-log').appendChild(box);
    scrollLog();
    return { box: box, body: body, think: null, thinkBody: null, thinkAt: 0, folded: false };
  }

  // 생각 과정 칸은 첫 조각이 올 때 만든다. 안 생각하는 모델이면 아예 안 생긴다.
  function thinkPane(st) {
    if (st.think) return st;
    var box = document.createElement('details');
    box.className = 'think';
    box.open = true;
    var head = document.createElement('summary');
    head.textContent = '생각하는 중';
    var body = document.createElement('div');
    body.className = 'think-body';
    box.appendChild(head);
    box.appendChild(body);
    st.box.insertBefore(box, st.body);
    st.think = box;
    st.thinkHead = head;
    st.thinkBody = body;
    st.thinkAt = Date.now();
    return st;
  }

  // 답이 시작되면 접는다. 걸린 시간을 제목에 남겨 펼쳐 볼 판단 근거로 둔다.
  function foldThink(st) {
    if (!st || !st.think || st.folded) return;
    st.folded = true;
    st.think.open = false;
    var sec = Math.round((Date.now() - st.thinkAt) / 100) / 10;
    st.thinkHead.textContent = sec + '초 생각함';
  }

  function setSending(on) {
    $('#chat-send').disabled = on;
    $('#chat-stop').disabled = !on;
  }

  window.api.on('chat:event', function (e) {
    var st = state.streaming;
    if (e.type === 'reasoning' && st) {
      thinkPane(st);
      st.thinkBody.textContent += e.text;
      st.thinkBody.scrollTop = st.thinkBody.scrollHeight;
      scrollLog();
    }
    if (e.type === 'delta' && st) {
      foldThink(st);
      st.body.textContent += e.text;
      scrollLog();
    }
    if (e.type === 'done' && st) {
      foldThink(st);
      var meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.textContent = e.stat.tokPerSec + ' tok/s · ' + e.stat.tokens + '토큰 · ' + e.stat.seconds + '초' +
        (e.stat.waitSeconds !== null ? ' (첫 응답까지 ' + e.stat.waitSeconds + '초)' : '');
      st.box.appendChild(meta);
      // 생각만 하다 끝나면 본문이 빈 채로 남는다. 왜 비었는지 적어 준다.
      if (!e.text) st.body.textContent = '답을 내기 전에 길이 제한에 걸렸다. 생각 과정을 펼쳐 보거나 다시 물어본다.';
      setText('#chat-stat', e.stat.tokPerSec + ' tok/s');
      state.messages.push({ role: 'assistant', content: e.text });
      state.streaming = null;
      setSending(false);
    }
    if (e.type === 'canceled') {
      if (st) {
        foldThink(st);
        st.body.textContent += '\n[중지했다]';
      }
      state.streaming = null;
      setSending(false);
    }
    if (e.type === 'error') {
      if (st && !st.body.textContent && !st.think) st.box.remove();
      else if (st) foldThink(st);
      addMsg('error', '보내지 못했다: ' + e.message);
      state.streaming = null;
      setSending(false);
    }
  });

  // ---------- 사용 기록 ----------
  // 서버 프록시에 물어본다. 화면을 보고 있는 동안만 주기로 갱신한다.

  var usageTimer = null;

  function msText(ms) {
    if (!ms) return '0초';
    if (ms < 1000) return ms + 'ms';
    return (Math.round(ms / 100) / 10) + '초';
  }

  function timeText(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || '');
    return String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0') + ':' +
      String(d.getSeconds()).padStart(2, '0');
  }

  function cut(text, n) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  function kvFill(sel, pairs) {
    var el = $(sel);
    el.textContent = '';
    pairs.forEach(function (pair) {
      var dt = document.createElement('dt');
      dt.textContent = pair[0];
      var dd = document.createElement('dd');
      dd.textContent = pair[1];
      el.appendChild(dt);
      el.appendChild(dd);
    });
  }

  function emptyRow(body, text) {
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'hint';
    td.textContent = text;
    tr.appendChild(td);
    body.appendChild(tr);
  }

  function usageRender(st) {
    kvFill('#usage-kv', [
      ['서버', st.error ? st.error : (st.listening ? '받고 있음' : '안 받고 있음')],
      ['한 번에 받는 수', String(st.limit)],
      ['지금 처리 중', String(st.running.length)],
      ['기다리는 중', String(st.waiting.length)]
    ]);

    var body = $('#usage-now');
    body.textContent = '';
    var rows = st.running.map(function (r) { return ['처리 중', r]; })
      .concat(st.waiting.map(function (r) { return ['기다림', r]; }));
    if (!rows.length) {
      emptyRow(body, '지금 들어온 요청이 없다.');
      return;
    }
    rows.forEach(function (pair) {
      var r = pair[1];
      var tr = document.createElement('tr');
      [pair[0], r.who, r.model || '기본', msText(r.waitMs), msText(r.runMs), String(r.tokens || 0)]
        .forEach(function (v) {
          var td = document.createElement('td');
          td.textContent = v;
          tr.appendChild(td);
        });
      body.appendChild(tr);
    });
  }

  function usageDetail(row) {
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    td.colSpan = 6;
    var box = document.createElement('div');
    box.className = 'log-detail';

    // 걸린 시간을 나눠 보여준다. 프롬프트 읽기가 긴지 답 쓰기가 긴지 여기서 갈린다.
    var t = document.createElement('div');
    t.className = 'log-detail-time';
    var parts = [];
    if (row.waitMs) parts.push('줄에서 ' + msText(row.waitMs));
    if (row.promptMs || row.promptTokens) {
      parts.push('프롬프트 ' + (row.promptTokens || 0) + '토큰 ' + msText(row.promptMs) +
        (row.promptMs && row.promptTokens ? ' (' + Math.round(row.promptTokens / (row.promptMs / 1000)) + ' tok/s)' : ''));
    }
    if (row.genMs || row.tokens) {
      parts.push('생성 ' + (row.tokens || 0) + '토큰 ' + msText(row.genMs || row.runMs) +
        (row.genMs && row.tokens ? ' (' + (Math.round((row.tokens / (row.genMs / 1000)) * 10) / 10) + ' tok/s)' : ''));
    }
    if (!parts.length) parts.push('전체 ' + msText(row.runMs));
    t.textContent = parts.join(' · ');
    box.appendChild(t);
    [['질문', row.prompt], ['답', row.answer]].forEach(function (pair) {
      var h = document.createElement('div');
      h.className = 'log-detail-head';
      h.textContent = pair[0];
      var b = document.createElement('div');
      b.className = 'log-detail-body';
      b.textContent = pair[1] || '(없음)';
      box.appendChild(h);
      box.appendChild(b);
    });
    if (row.error) {
      var e = document.createElement('div');
      e.className = 'log-detail-head';
      e.textContent = '오류: ' + row.error;
      box.appendChild(e);
    }
    td.appendChild(box);
    tr.appendChild(td);
    return tr;
  }

  function usageRows(rows) {
    var body = $('#usage-rows');
    body.textContent = '';
    if (!rows.length) {
      emptyRow(body, '이 날짜에는 기록이 없다.');
      return;
    }
    rows.slice().reverse().forEach(function (row) {
      var tr = document.createElement('tr');
      tr.className = 'log-row';
      var genMs = row.genMs || row.runMs;
      var speed = genMs > 0 && row.tokens ? (Math.round((row.tokens / (genMs / 1000)) * 10) / 10) + ' tok/s' : '-';
      [timeText(row.at), row.who, row.model || '기본', cut(row.prompt, 48), String(row.tokens || 0), speed]
        .forEach(function (v) {
          var td = document.createElement('td');
          td.textContent = v;
          tr.appendChild(td);
        });
      var detail = usageDetail(row);
      detail.hidden = true;
      tr.addEventListener('click', function () {
        detail.hidden = !detail.hidden;
        tr.classList.toggle('is-open', !detail.hidden);
      });
      body.appendChild(tr);
      body.appendChild(detail);
    });
  }

  function usageLoadDay() {
    var day = $('#usage-day').value;
    if (!day) {
      usageRows([]);
      return Promise.resolve();
    }
    return window.api.usage.log(day).then(function (rows) {
      usageRows(rows || []);
      setText('#usage-msg', (rows || []).length + '건');
    }).catch(function (err) {
      setText('#usage-msg', '읽지 못했다: ' + errText(err));
    });
  }

  function usageLoadDays() {
    return window.api.usage.days().then(function (days) {
      var sel = $('#usage-day');
      var before = sel.value;
      sel.textContent = '';
      (days || []).forEach(function (d) {
        var o = document.createElement('option');
        o.value = d;
        o.textContent = d;
        sel.appendChild(o);
      });
      if (before && days.indexOf(before) >= 0) sel.value = before;
      return usageLoadDay();
    }).catch(function (err) {
      setText('#usage-msg', '날짜를 읽지 못했다: ' + errText(err));
    });
  }

  function usageStatus() {
    return window.api.usage.status().then(usageRender).catch(function (err) {
      kvFill('#usage-kv', [['서버', '상태를 읽지 못했다: ' + errText(err)]]);
    });
  }

  // 사용 기록 화면을 보고 있을 때만 주기로 다시 읽는다.
  function usageTick(on) {
    if (usageTimer) {
      clearInterval(usageTimer);
      usageTimer = null;
    }
    if (on) usageTimer = setInterval(usageStatus, 3000);
  }

  $('#usage-day').addEventListener('change', usageLoadDay);
  $('#usage-reload').addEventListener('click', function () {
    setText('#usage-msg', '읽는 중');
    usageLoadDays();
  });

  function mountUsage() {
    usageStatus();
    usageLoadDays();
  }

  function sendChat() {
    var text = $('#chat-text').value.trim();
    if (!text) return;
    if (!state.conn || !state.conn.running) {
      addMsg('error', '서버에 연결돼 있지 않다. 연결 탭에서 확인한다.');
      return;
    }
    $('#chat-text').value = '';
    addMsg('user', text);
    state.messages.push({ role: 'user', content: text });
    state.streaming = startAnswer();
    setSending(true);
    window.api.chat.send(state.messages, { model: $('#chat-model').value }).catch(function () {
      // 오류는 이벤트로 화면에 적는다
    });
  }

  $('#chat-send').addEventListener('click', sendChat);
  $('#chat-stop').addEventListener('click', function () { window.api.chat.cancel(); });
  $('#chat-text').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      sendChat();
    }
  });
  $('#chat-clear').addEventListener('click', function () {
    state.messages = [];
    $('#chat-log').textContent = '';
    setText('#chat-stat', '');
  });

  // ---------- 하네스 ----------

  window.api.on('harness:log', function (line) {
    var el = $('#harness-log');
    el.textContent += line + '\n';
    el.scrollTop = el.scrollHeight;
  });

  var WORKDIR_KEY = 'llmbench.harness.workdir';

  // 작업 폴더가 비어 있으면 실행 파일 옆 workspace를 쓴다.
  // 그 자리에 못 만들면 그때 고르기 창을 띄운다.
  function ensureWorkDir() {
    var dir = $('#harness-workdir').value.trim();
    if (dir) return Promise.resolve(dir);
    return window.api.app.workspace().then(function (def) {
      if (def) {
        $('#harness-workdir').value = def;
        return def;
      }
      return window.api.shell.pickDir().then(function (picked) {
        if (picked) $('#harness-workdir').value = picked;
        return picked || '';
      });
    });
  }

  function harnessOptions() {
    var dir = $('#harness-workdir').value.trim();
    // 마지막에 쓴 폴더를 기억한다. 매번 고르지 않게.
    try {
      if (dir) window.localStorage.setItem(WORKDIR_KEY, dir);
    } catch (e) {
      // 저장이 막힌 환경이면 그냥 넘어간다
    }
    return {
      workDir: dir,
      model: $('#harness-model').value,
      skipPermissions: $('#harness-skip').checked
    };
  }

  // 지난번 폴더를 채워 둔다. 없으면 기본 workspace를 보여 준다.
  try {
    var lastDir = window.localStorage.getItem(WORKDIR_KEY);
    if (lastDir) $('#harness-workdir').value = lastDir;
  } catch (e) {
    // 읽기가 막힌 환경이면 빈 칸으로 둔다
  }
  if (!$('#harness-workdir').value) {
    window.api.app.workspace().then(function (def) {
      if (def && !$('#harness-workdir').value) $('#harness-workdir').value = def;
    }).catch(function () {
      // 못 만들면 빈 칸으로 둔다. 열 때 고르기 창이 뜬다.
    });
  }

  function loadHarness() {
    window.api.harness.list().then(function (items) {
      var body = $('#harness-rows');
      body.textContent = '';
      items.forEach(function (h) {
        var tr = document.createElement('tr');
        [h.name, h.note, h.installed ? (h.version || '설치됨') : '없음'].forEach(function (t) {
          var td = document.createElement('td');
          td.textContent = t;
          tr.appendChild(td);
        });
        var td = document.createElement('td');
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-sm';
        btn.textContent = h.installed ? '터미널 열기' : '설치';
        btn.addEventListener('click', function () {
          btn.disabled = true;
          if (h.installed) {
            // 작업 폴더를 안 고르면 하네스가 홈에서 시작한다. 그 전에 고르게 한다.
            ensureWorkDir().then(function (dir) {
              if (!dir) {
                setText('#harness-msg', '작업 폴더를 골라야 연다.');
                btn.disabled = false;
                return;
              }
              return window.api.harness.launch(h.id, harnessOptions()).then(function (res) {
                if (res && res.ok) {
                  setText('#harness-msg', h.name + ' 터미널을 열었다.');
                  termOpen(res.term || h.id, h.name);
                } else {
                  setText('#harness-msg', (res && res.error) || '열지 못했다.');
                }
              });
            }).catch(function (err) {
              setText('#harness-msg', '열지 못했다: ' + errText(err));
            }).then(function () { btn.disabled = false; });
          } else {
            setText('#harness-msg', h.name + ' 설치를 시작했다. 로그를 확인한다.');
            window.api.harness.install(h.id).then(function () {
              return loadHarness();
            }).catch(function (err) {
              setText('#harness-msg', '설치하지 못했다: ' + errText(err));
            }).then(function () { btn.disabled = false; });
          }
        });
        td.appendChild(btn);
        tr.appendChild(td);
        body.appendChild(tr);
      });
    });
  }

  $('#harness-pick').addEventListener('click', function () {
    window.api.shell.pickDir().then(function (dir) {
      if (dir) $('#harness-workdir').value = dir;
    });
  });

  // ---------- 터미널 ----------

  function termOpen(id, title) {
    if (!window.Terminal) {
      setText('#harness-msg', '터미널 모듈을 불러오지 못했다.');
      return;
    }
    $('#term-card').hidden = false;
    setText('#term-title', title);
    state.term.id = id;

    if (!state.term.xterm) {
      state.term.xterm = new window.Terminal({
        fontSize: 13,
        fontFamily: '"D2Coding", "NanumGothicCoding", Consolas, monospace',
        cursorBlink: true,
        scrollback: 5000,
        theme: { background: '#0f1115', foreground: '#d7dae0' }
      });
      if (window.FitAddon && window.FitAddon.FitAddon) {
        state.term.fit = new window.FitAddon.FitAddon();
        state.term.xterm.loadAddon(state.term.fit);
      }
      state.term.xterm.open($('#term-host'));
      state.term.xterm.onData(function (d) {
        if (state.term.id) window.api.term.write(state.term.id, d);
      });
      wireTermKeys(state.term.xterm, $('#term-host'), function (d) {
        if (state.term.id) window.api.term.write(state.term.id, d);
      });
      window.addEventListener('resize', termFit);
    }

    if (!state.term.unsub) {
      state.term.unsub = window.api.on('term:event', function (e) {
        if (!state.term.xterm || e.id !== state.term.id) return;
        if (e.type === 'data') state.term.xterm.write(e.data);
        if (e.type === 'exit') state.term.xterm.write('\r\n[세션이 끝났다. 종료 코드 ' + e.exitCode + ']\r\n');
      });
    }

    window.api.term.snapshot(id).then(function (snap) {
      state.term.xterm.reset();
      if (snap && snap.buf) state.term.xterm.write(snap.buf);
      termFit();
      state.term.xterm.focus();
    });
  }

  // 터미널 키 처리. xterm은 기본으로 복사, 붙여넣기, 줄바꿈을 다 안 해 준다.
  function wireTermKeys(xterm, host, sendText) {
    function paste() {
      window.api.app.paste().then(function (text) {
        if (text) xterm.paste(text);
      });
    }
    function copySelection() {
      var sel = xterm.getSelection();
      if (!sel) return false;
      window.api.app.copy(sel);
      xterm.clearSelection();
      return true;
    }

    xterm.attachCustomKeyEventHandler(function (ev) {
      if (ev.type !== 'keydown') return true;
      // Ctrl+C는 터미널에서 중단 신호다. 고른 글이 있을 때만 복사로 쓴다.
      if (ev.ctrlKey && !ev.altKey && ev.key === 'c' && xterm.hasSelection()) {
        copySelection();
        return false;
      }
      if (ev.ctrlKey && !ev.altKey && ev.key === 'v') {
        paste();
        return false;
      }
      if (ev.ctrlKey && ev.shiftKey && (ev.key === 'C' || ev.key === 'c')) {
        copySelection();
        return false;
      }
      if (ev.ctrlKey && ev.shiftKey && (ev.key === 'V' || ev.key === 'v')) {
        paste();
        return false;
      }
      // Shift+Enter는 보내지 않고 줄만 바꾼다. 하네스는 줄바꿈 문자를 그렇게 받는다.
      if (ev.shiftKey && !ev.ctrlKey && !ev.altKey && ev.key === 'Enter') {
        sendText('\n');
        return false;
      }
      return true;
    });

    // 오른쪽 클릭은 윈도우 콘솔 방식대로 고른 게 있으면 복사, 없으면 붙여넣기.
    host.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      if (!copySelection()) paste();
    });
  }

  function termFit() {
    if (!state.term.fit || !state.term.xterm || $('#term-card').hidden) return;
    try {
      state.term.fit.fit();
      if (state.term.id) window.api.term.resize(state.term.id, state.term.xterm.cols, state.term.xterm.rows);
    } catch (e) {
      // 화면이 안 보일 때는 크기를 못 잰다
    }
  }

  $('#term-kill').addEventListener('click', function () {
    if (state.term.id) window.api.term.kill(state.term.id);
  });

  // ---------- 시작 ----------

  window.api.app.version().then(function (v) {
    setText('#version-badge', 'v' + v);
  });

  // 새 버전이 있으면 상단에 버튼을 띄운다. 시작할 때 한 번 보고 30분마다 다시 본다.
  var updateBtn = $('#update-btn');
  var updateWired = false;

  window.api.on('update:progress', function (p) {
    updateBtn.disabled = p.stage !== 'error';
    updateBtn.textContent = p.stage === 'download' ? '업데이트 ' + p.percent + '%' : p.text;
    if (p.stage === 'error') updateBtn.title = p.text;
  });

  var checkBtn = $('#update-check');
  var checkTimer = null;

  // 버튼을 눌러 확인했을 때만 결과를 버튼에 적는다. 30분마다 도는 확인은 조용히 지나간다.
  function showCheckResult(text, title) {
    checkBtn.disabled = false;
    checkBtn.textContent = text;
    checkBtn.title = title || '';
    if (checkTimer) clearTimeout(checkTimer);
    checkTimer = setTimeout(function () {
      checkBtn.textContent = '업데이트 확인';
      checkBtn.title = '';
    }, 4000);
  }

  checkBtn.addEventListener('click', function () {
    checkBtn.disabled = true;
    checkBtn.textContent = '확인 중';
    lookForUpdate(true);
  });

  function lookForUpdate(manual) {
    return window.api.update.check().then(function (u) {
      if (manual) {
        if (u && u.error) showCheckResult('확인 실패', u.error);
        else if (u && u.available) showCheckResult('새 버전 있음', 'v' + u.latest);
        else showCheckResult('최신 버전', u && u.current ? 'v' + u.current : '');
      }
      if (!u || !u.available || updateWired) return;
      updateWired = true;
      updateBtn.hidden = false;
      updateBtn.textContent = '새 버전 v' + u.latest + ' 업데이트';
      updateBtn.title = u.notes || '';
      updateBtn.addEventListener('click', function () {
        if (!confirm('v' + u.latest + '로 업데이트한다. 앱이 잠시 닫혔다가 다시 뜬다. 주고받던 대화는 끊긴다.')) return;
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
    }).catch(function (err) {
      // 확인에 실패해도 다음 회차에 다시 본다
      if (manual) showCheckResult('확인 실패', errText(err));
    });
  }
  lookForUpdate();
  setInterval(lookForUpdate, 30 * 60 * 1000);
  refreshConn();
})();
