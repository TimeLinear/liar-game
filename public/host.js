'use strict';

(function () {
  const { socket, params, remainingMs, transportName, onTransportChange, esc, fmt, PHASE_LABEL, holdToReveal } = LG;
  const $ = (id) => document.getElementById(id);
  const KEY_STORE = 'liar_host_key';

  let hostKey = params.get('key') || (() => { try { return localStorage.getItem(KEY_STORE); } catch (_) { return null; } })() || '';
  let authed = false;
  let hs = null; // host:state
  let pub = null;
  const lastHtml = {};

  // 같은 내용이면 다시 그리지 않는다 (버튼 클릭이 사라지지 않게).
  function setHtml(id, html) {
    if (lastHtml[id] === html) return;
    lastHtml[id] = html;
    $(id).innerHTML = html;
  }

  function hello() {
    if (!hostKey) return showAuth('');
    socket.emit('host:hello', { key: hostKey }, (res) => {
      if (res && res.ok) {
        authed = true;
        try { localStorage.setItem(KEY_STORE, hostKey); } catch (_) {}
        $('authBox').classList.add('hidden');
        $('app').classList.remove('hidden');
        $('screenLink').href = `/screen?key=${encodeURIComponent(hostKey)}`;
      } else {
        showAuth((res && res.error) || '인증 실패');
      }
    });
  }
  function showAuth(err) {
    authed = false;
    $('app').classList.add('hidden');
    $('authBox').classList.remove('hidden');
    $('authErr').textContent = err;
  }
  $('authForm').addEventListener('submit', (e) => {
    e.preventDefault();
    hostKey = $('authKey').value.trim();
    hello();
  });
  socket.on('connect', hello);
  onTransportChange(() => hs && renderConn());

  socket.on('host:state', (s) => {
    hs = s;
    render();
  });
  socket.on('state:public', (s) => {
    pub = s;
    renderHeader();
  });

  function emit(ev, data, msgEl) {
    socket.emit(ev, data || {}, (res) => {
      if (!msgEl) return;
      const el = $(msgEl);
      if (res && res.ok === false) {
        el.className = 'msg bad';
        el.textContent = res.error;
      } else {
        el.className = 'msg good';
        el.textContent = res && res.added !== undefined ? `${res.added}개 추가됨` : '';
        setTimeout(() => { if (el.textContent !== '' && el.className === 'msg good') el.textContent = ''; }, 2500);
      }
    });
  }

  // ─── 렌더링 ────────────────────────────────────────────────────────────
  function render() {
    if (!hs) return;
    renderHeader();
    renderControls();
    renderConn();
    renderPlayers();
    renderHints();
    renderVotes();
    renderGuesses();
    renderBalance();
    renderSettings();
    renderBank();
    if (secretOpen) renderSecret();
  }

  function renderHeader() {
    if (!hs) return;
    $('hCode').textContent = hs.roomCode;
    $('hPhase').textContent = PHASE_LABEL[hs.phase] || hs.phase;
    $('playLink').href = `/play?code=${hs.roomCode}`;
    if (pub && pub.setIndex && hs.phase !== 'LOBBY') {
      $('hSetRound').innerHTML = `SET <b>${pub.setIndex}</b>/${pub.settings.sets}${pub.roundIndex ? ` · ROUND <b>${pub.roundIndex}</b>/${pub.settings.rounds}` : ''}`;
    } else {
      $('hSetRound').textContent = '';
    }
  }

  function tick() {
    if (!pub) return;
    const timed = pub.deadline || pub.paused;
    $('hTimer').textContent = timed ? `${pub.paused ? '⏸ ' : '⏱ '}${Math.ceil(remainingMs(pub) / 1000)}초` : '';
  }
  setInterval(tick, 250);

  function renderControls() {
    const ph = hs.phase;
    const timed = pub && (pub.deadline || pub.paused);
    let html = '<div class="btns">';
    if (ph === 'LOBBY') {
      html += `<button class="btn primary" data-act="start" ${hs.startCheck.ok ? '' : 'disabled'}>▶ 게임 시작</button>`;
    } else {
      html += `<button class="btn primary" data-act="next">다음 단계 강제 진행 ▶</button>`;
      if (timed) {
        html += `<button class="btn" data-act="extend">+15초</button>`;
        html += pub.paused
          ? `<button class="btn" data-act="resume">▶ 재개</button>`
          : `<button class="btn" data-act="pause">⏸ 일시정지</button>`;
      }
      html += `<button class="btn danger" data-act="reset">로비로 초기화</button>`;
    }
    html += '</div>';
    if (ph === 'LOBBY') {
      const c = hs.startCheck;
      html += c.ok
        ? `<p class="note good">시작할 수 있습니다 (${c.n}명)</p>${c.warn ? `<p class="note warn">⚠ ${esc(c.warn)}</p>` : ''}`
        : `<p class="note bad">${esc(c.reason)}</p>`;
    } else {
      html += `<p class="note">스크린의 버튼(투표 시작, 판정 공개, 다음)은 스크린 창에서 누르세요. 여기의 강제 진행은 타이머가 도는 단계도 즉시 끝냅니다.</p>`;
    }
    setHtml('controls', html);
  }

  $('controls').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'start') emit('host:start', {}, 'ctlMsg');
    if (act === 'next') emit('host:next', {}, 'ctlMsg');
    if (act === 'extend') emit('host:extend', { sec: 15 }, 'ctlMsg');
    if (act === 'pause') emit('host:pause', {}, 'ctlMsg');
    if (act === 'resume') emit('host:resume', {}, 'ctlMsg');
    if (act === 'reset' && confirm('게임을 중단하고 로비로 돌아갈까요? 점수가 모두 초기화됩니다.')) emit('host:reset', {}, 'ctlMsg');
  });

  function renderConn() {
    const mine = transportName();
    const scr = hs.screens.length
      ? hs.screens.map((s) => `<span class="tag ${s.transport === 'websocket' ? 'good' : 'accent'}">${esc(s.transport)}</span>${s.canAct ? '' : ' <span class="muted">(보기 전용)</span>'}`).join(' ')
      : '<span class="bad">연결된 스크린 없음</span>';
    setHtml('conn', `<table>
      <tr><td>이 사회자 화면</td><td><span class="tag ${mine === 'websocket' ? 'good' : 'accent'}">${esc(mine)}</span></td></tr>
      <tr><td>스크린</td><td>${scr}</td></tr>
      <tr><td>참가자</td><td>websocket ${hs.transports.websocket || 0}명 · polling ${hs.transports.polling || 0}명</td></tr>
    </table><p class="note">polling이어도 게임은 그대로 진행됩니다.</p>`);
  }

  function renderPlayers() {
    const list = hs.players;
    $('pCount').textContent = `${list.filter((p) => !p.spectator).length}명 참가 · ${list.filter((p) => p.connected).length}명 접속`;
    const rows = list
      .map((p) => {
        const status = p.spectator
          ? '<span class="tag">관전</span>'
          : hs.phase !== 'LOBBY' && p.inSet && !p.alive
            ? '<span class="tag bad">퇴장</span>'
            : '';
        return `<tr class="${p.connected ? '' : 'dim'}">
          <td><span class="dot ${p.connected ? 'on' : 'off'}"></span> ${esc(p.name)} ${status}${p.connected ? '' : ' <span class="muted">연결 끊김</span>'}</td>
          <td class="num">${fmt(p.set)}</td><td class="num">${fmt(p.total)}</td>
          <td style="white-space:nowrap;text-align:right">
            <button class="btn small ghost" data-spec="${esc(p.id)}" data-val="${p.spectator ? '0' : '1'}">${p.spectator ? '참가로' : '관전으로'}</button>
            <button class="btn small danger" data-kick="${esc(p.id)}" data-name="${esc(p.name)}">강퇴</button></td></tr>`;
      })
      .join('');
    setHtml('players', list.length
      ? `<table><tr><th>이름</th><th class="num">세트</th><th class="num">누적</th><th></th></tr>${rows}</table>
         ${hs.phase !== 'LOBBY' ? '<p class="note">관전 ↔ 참가 전환은 다음 세트부터 적용됩니다.</p>' : ''}`
      : '<p class="muted">아직 입장한 참가자가 없습니다</p>');
  }
  $('players').addEventListener('click', (e) => {
    const k = e.target.closest('[data-kick]');
    if (k && confirm(`${k.dataset.name} 님을 강퇴할까요?`)) emit('host:kick', { id: k.dataset.kick });
    const s = e.target.closest('[data-spec]');
    if (s) emit('host:spectator', { id: s.dataset.spec, spectator: s.dataset.val === '1' });
  });

  function renderHints() {
    if (!hs.hints.length) return setHtml('hints', '<p class="muted">힌트 입력 단계부터 표시됩니다</p>');
    const rows = hs.hints
      .map((h) => `<tr><td>${esc(h.name)}</td>
        <td>${h.text ? `<b style="${h.hidden ? 'text-decoration:line-through;opacity:.6' : ''}">${esc(h.text)}</b>` : '<span class="muted">(미제출)</span>'}
          ${hs.phase === 'HINT_INPUT' && h.text && !h.submitted ? '<span class="muted">입력 중</span>' : ''}</td>
        <td style="text-align:right">${h.text ? `<button class="btn small ${h.hidden ? '' : 'danger'}" data-hide="${esc(h.id)}" data-val="${h.hidden ? '0' : '1'}">${h.hidden ? '보이기' : '가리기'}</button>` : ''}</td></tr>`)
      .join('');
    setHtml('hints', `<table>${rows}</table>`);
  }
  $('hints').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hide]');
    if (b) emit('host:hint:hide', { id: b.dataset.hide, hidden: b.dataset.val === '1' });
  });

  function renderVotes() {
    if (hs.phase !== 'VOTING' && !hs.votes.length) return setHtml('votes', '<p class="muted">투표 단계에서 표시됩니다</p>');
    const rows = hs.votes.map((v) => `<tr><td>${esc(v.name)}</td><td class="num"><b>${v.count}</b>표</td></tr>`).join('');
    setHtml('votes', `<p class="muted" style="margin-top:0">투표한 사람 ${hs.voted}명</p><table>${rows}</table>`);
  }

  function renderGuesses() {
    if (!hs.guesses.length) return setHtml('guesses', '<p class="muted">이번 세트에 지목된 라이어가 아직 없습니다</p>');
    const rows = hs.guesses
      .map((g) => {
        const result = !g.done ? '<span class="muted">입력 중…</span>' : g.correct ? `<span class="good">정답 +${fmt(g.points)}</span>` : '<span class="bad">오답</span>';
        const btn = g.done
          ? `<button class="btn small" data-guess="${esc(g.pid)}" data-round="${g.round}" data-val="${g.correct ? '0' : '1'}">${g.correct ? '정답 취소' : '정답 인정'}</button>`
          : '';
        return `<tr><td>${esc(g.name)}</td><td>R${g.round}</td><td>${g.text ? `“${esc(g.text)}”` : '<span class="muted">(무응답)</span>'}</td>
          <td>${result}${g.manual ? ' <span class="tag">수동</span>' : ''}</td><td style="text-align:right">${btn}</td></tr>`;
      })
      .join('');
    setHtml('guesses', `<table>${rows}</table>`);
  }
  $('guesses').addEventListener('click', (e) => {
    const b = e.target.closest('[data-guess]');
    if (b) emit('host:guess:set', { pid: b.dataset.guess, round: Number(b.dataset.round), correct: b.dataset.val === '1' });
  });

  function renderBalance() {
    if (!hs.balance.length) return setHtml('balance', '<p class="muted">세트가 진행되면 표시됩니다</p>');
    const f = (v) => (v == null ? '-' : fmt(v));
    const rows = hs.balance.map((b) => `<tr><td>SET ${b.set}</td><td>${esc(b.category)}</td><td class="num">${f(b.citizenAvg)}</td><td class="num">${f(b.liarAvg)}</td></tr>`).join('');
    setHtml('balance', `<table><tr><th>세트</th><th>카테고리</th><th class="num">시민 평균</th><th class="num">라이어 평균</th></tr>${rows}</table>
      <p class="note">한쪽으로 크게 쏠리면 첫 게임 후 라이어 정답 보너스, 오투표 감점, 공개 기준을 조정하세요.</p>`);
  }

  // ─── 비밀 정보 (꾹 눌러서) ─────────────────────────────────────────────
  let secretOpen = false;
  function renderSecret() {
    const s = hs && hs.secret;
    $('secret').innerHTML = s
      ? `<div class="muted">카테고리 · ${esc(s.category)}</div><div class="kw">${esc(s.keyword)}</div>
         ${s.aliases.length ? `<div class="muted">허용 별칭: ${s.aliases.map(esc).join(', ')}</div>` : ''}
         <div style="margin-top:8px">🕵️ 라이어: <b>${s.liars.map(esc).join(', ')}</b></div>`
      : '<span class="muted">진행 중인 세트가 없습니다</span>';
  }
  holdToReveal($('secretBtn'), {
    onOpen: () => {
      secretOpen = true;
      renderSecret();
      $('secret').classList.remove('hidden');
    },
    onClose: () => {
      secretOpen = false;
      $('secret').classList.add('hidden');
      $('secret').innerHTML = '';
    },
  });

  // ─── 설정 ──────────────────────────────────────────────────────────────
  let settingsDirty = false;
  let settingsBuilt = false;
  function buildSettings() {
    const rules = hs.settingRules;
    let html = '';
    for (const [k, r] of Object.entries(rules)) {
      html += `<label for="s_${k}">${esc(r.label)} <span class="muted">(${r.min}~${r.max})</span></label>
        <input type="number" id="s_${k}" name="${k}" min="${r.min}" max="${r.max}" step="1" />`;
    }
    html += `<label for="s_noReuse">이전 라운드 단어 재사용 금지</label><select id="s_noReuse" name="noReuse"><option value="0">끔</option><option value="1">켬</option></select>`;
    $('settingsFields').innerHTML = html;
    settingsBuilt = true;
  }
  function fillSettings() {
    for (const k of Object.keys(hs.settingRules)) $(`s_${k}`).value = Math.round(hs.settings[k] * 100) / 100;
    $('s_noReuse').value = hs.settings.noReuse ? '1' : '0';
  }
  function renderSettings() {
    if (!settingsBuilt) buildSettings();
    if (!settingsDirty) fillSettings();
    const locked = hs.locked;
    for (const el of $('settingsForm').querySelectorAll('input,select,button')) el.disabled = locked;
    $('lockNote').textContent = locked ? '🔒 게임 중에는 잠겨 있습니다' : '';
  }
  $('settingsForm').addEventListener('input', () => (settingsDirty = true));
  $('settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const data = {};
    for (const k of Object.keys(hs.settingRules)) data[k] = Number($(`s_${k}`).value);
    data.noReuse = $('s_noReuse').value === '1';
    socket.emit('host:settings', data, (res) => {
      const el = $('setMsg');
      if (res && res.ok === false) {
        el.className = 'msg bad';
        el.textContent = res.error;
        return;
      }
      settingsDirty = false;
      el.className = 'msg good';
      el.textContent = '저장했습니다 (범위를 벗어난 값은 자동으로 조정됩니다)';
    });
  });
  $('revertSettings').addEventListener('click', () => {
    settingsDirty = false;
    fillSettings();
  });

  // ─── 제시어 뱅크 ───────────────────────────────────────────────────────
  function renderBank() {
    $('bankCount').textContent = `${hs.bank.length}개`;
    const byCat = new Map();
    for (const b of hs.bank) {
      if (!byCat.has(b.category)) byCat.set(b.category, []);
      byCat.get(b.category).push(b);
    }
    const html = [...byCat]
      .map(([cat, items]) => `<div class="bankcat"><h3>${esc(cat)} <span class="muted">(${items.length})</span>
          <button class="btn small ghost" data-rmcat="${esc(cat)}">카테고리 삭제</button></h3>
        <div class="bankitems">${items
          .map((b) => `<span class="bankitem" title="${b.aliases.length ? `별칭: ${esc(b.aliases.join(', '))}` : ''}">${esc(b.word)}${b.aliases.length ? ` <span class="muted">(${b.aliases.map(esc).join(', ')})</span>` : ''}<button data-rm="${b.id}" aria-label="삭제">✕</button></span>`)
          .join('')}</div></div>`)
      .join('');
    setHtml('bankList', html || '<p class="muted">비어 있습니다</p>');
  }
  $('bankList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]');
    if (b) emit('host:bank:remove', { id: Number(b.dataset.rm) }, 'bankMsg');
    const c = e.target.closest('[data-rmcat]');
    if (c && confirm(`"${c.dataset.rmcat}" 카테고리의 제시어를 모두 삭제할까요?`)) emit('host:bank:removeCategory', { category: c.dataset.rmcat }, 'bankMsg');
  });
  $('bankAdd').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    emit('host:bank:add', { category: f.category.value, word: f.word.value, aliases: f.aliases.value }, 'bankMsg');
    f.word.value = '';
    f.aliases.value = '';
    f.word.focus();
  });
  $('bankImportBtn').addEventListener('click', () => {
    emit('host:bank:import', { text: $('bankImport').value }, 'bankMsg');
    $('bankImport').value = '';
  });
  $('bankResetBtn').addEventListener('click', () => {
    if (confirm('제시어 뱅크를 기본값으로 되돌릴까요? 추가한 제시어가 사라집니다.')) emit('host:bank:reset', {}, 'bankMsg');
  });
})();
