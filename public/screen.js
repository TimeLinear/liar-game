'use strict';

(function () {
  const { socket, params, now, remainingMs, transportName, onTransportChange, esc, fmt } = LG;
  const $main = document.getElementById('main');
  const $overlay = document.getElementById('overlay');
  const $actions = document.getElementById('actions');
  const $info = document.getElementById('info');
  const $timer = document.getElementById('timer');
  const $conn = document.getElementById('conn');

  let pub = null;
  let canAct = false;
  let lastKey = '';
  let lastRevealed = null;

  function hello() {
    socket.emit('screen:hello', { key: params.get('key') || '' }, (res) => {
      canAct = !!(res && res.canAct);
      lastKey = '';
      render();
    });
  }
  socket.on('connect', hello);
  socket.on('disconnect', () => showConn());
  onTransportChange(showConn);

  function showConn() {
    $conn.textContent = socket.connected
      ? `연결: ${transportName()}${canAct ? '' : ' · 보기 전용'}`
      : '연결 끊김 — 재연결 중…';
  }

  socket.on('state:public', (s) => {
    pub = s;
    render();
  });

  function next() {
    socket.emit('screen:action', { type: 'next' });
  }
  document.addEventListener('keydown', (e) => {
    if (!canAct) return;
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
      e.preventDefault();
      if (actionLabel()) next();
    }
  });

  const revealed = () => pub && pub.phase === 'HINT_REVEAL' ? now() >= pub.revealAt : true;

  function render(force) {
    if (!pub) return;
    const key = JSON.stringify({ ...pub, serverNow: 0, deadline: 0, pausedRemaining: 0, canAct, r: revealed() });
    if (!force && key === lastKey) return;
    lastKey = key;
    lastRevealed = revealed();
    showConn();
    renderInfo();
    const fn = VIEWS[pub.phase];
    $main.innerHTML = fn ? fn() : '';
    renderOverlay();
    renderActions();
    tick();
  }

  function renderInfo() {
    const parts = [];
    if (pub.setIndex) parts.push(`SET <b>${pub.setIndex}</b>/${pub.settings.sets}`);
    if (pub.roundIndex && pub.phase !== 'SET_INTRO' && pub.phase !== 'SET_END' && pub.phase !== 'GAME_END') {
      parts.push(`ROUND <b>${pub.roundIndex}</b>/${pub.settings.rounds}`);
    }
    if (pub.category) parts.push(`카테고리 <b>${esc(pub.category)}</b>`);
    if (pub.phase !== 'LOBBY') parts.push(`방 코드 <b>${esc(pub.roomCode)}</b>`);
    $info.innerHTML = parts.join(' &nbsp;·&nbsp; ') || '대규모 라이어 게임';
  }

  function tick() {
    if (!pub) return;
    const timed = pub.deadline || pub.paused;
    if (timed) {
      const sec = Math.ceil(remainingMs(pub) / 1000);
      $timer.innerHTML = `${pub.paused ? '<span class="paused">일시정지</span>' : ''}${sec}`;
      $timer.classList.toggle('low', sec <= 10 && !pub.paused);
    } else {
      $timer.textContent = '';
    }
    const big = document.getElementById('bigTimer');
    if (big) big.textContent = timed ? Math.ceil(remainingMs(pub) / 1000) : '';
    if (pub.phase === 'HINT_REVEAL') {
      if (revealed() !== lastRevealed) return render(true);
      const cd = document.getElementById('countdown');
      if (cd) {
        const n = Math.max(1, Math.ceil((pub.revealAt - now()) / 1000));
        if (cd.dataset.n !== String(n)) {
          cd.dataset.n = n;
          cd.innerHTML = `<span>${n}</span>`;
        }
      }
    }
  }
  setInterval(tick, 150);

  function gridHtml(opts = {}) {
    const grid = pub.grid || [];
    const n = grid.length;
    const cols = n <= 6 ? 3 : n <= 12 ? 4 : n <= 20 ? 5 : n <= 30 ? 6 : 7;
    const cells = grid
      .map((c, i) => {
        const cls = ['cell', c.missing ? 'missing' : '', c.hidden ? 'hid' : '', c.out ? 'out' : '', opts.pick === c.id ? 'pick' : '']
          .filter(Boolean)
          .join(' ');
        const word = c.hidden ? '(가려짐)' : c.missing ? '(미제출)' : esc(c.word);
        return `<div class="${cls}" style="animation-delay:${opts.animate ? i * 25 : 0}ms"><div class="n">${esc(c.name)}</div><div class="w">${word}</div></div>`;
      })
      .join('');
    return `<div class="grid ${opts.animate ? 'reveal' : ''}" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${cells}</div>`;
  }

  const ranksHtml = (list, cls = '') =>
    `<div class="rows ${cls}">${list
      .map(
        (e, i) =>
          `<div class="row ${e.rank === 1 ? 'first' : ''}" style="animation-delay:${i * 90}ms"><span class="r">${e.rank}위</span><span class="nm">${esc(e.name)}</span><span class="pt">${fmt(e.score)}점</span></div>`
      )
      .join('')}</div>`;

  const VIEWS = {
    LOBBY() {
      const joinUrl = `${location.origin}/play`;
      const list = pub.players.filter((p) => !p.spectator);
      return `<div class="lobby">
        <div class="join">
          <img src="/qr.svg" alt="접속 QR 코드" />
          <div class="label">방 코드</div>
          <div class="code">${esc(pub.roomCode)}</div>
          <div class="url">${esc(joinUrl)}</div>
        </div>
        <div class="roster">
          <h2>참가자 <span class="accent">${list.length}</span>명</h2>
          <div class="chips">${list.map((p) => `<span class="chip ${p.connected ? '' : 'off'}">${esc(p.name)}</span>`).join('') || '<span class="muted">QR 코드를 찍고 입장하세요</span>'}</div>
        </div>
      </div>`;
    },
    SET_INTRO() {
      return `<div class="center">
        <div class="big muted">SET ${pub.setIndex}</div>
        <div class="label mid">카테고리</div>
        <div class="huge accent">${esc(pub.category)}</div>
        <div class="mid" style="margin-top:1em">휴대폰에서 카드를 꾹 눌러 역할을 확인하세요</div>
        <div class="muted">이번 세트의 라이어는 ${pub.liarCount}명입니다</div>
      </div>`;
    },
    HINT_INPUT() {
      const hp = pub.hintProgress || { submitted: 0, total: 0 };
      const pct = hp.total ? (hp.submitted / hp.total) * 100 : 0;
      return `<div class="center">
        <div class="label mid">ROUND ${pub.roundIndex} · 힌트 입력</div>
        <div class="big">제시어와 관련된 단어 1개를 입력하세요</div>
        <div class="huge" id="bigTimer" style="font-size:9em"></div>
        <div class="progress"><i style="width:${pct}%"></i></div>
        <div class="mid">제출 <span class="accent">${hp.submitted}</span> / ${hp.total}</div>
      </div>`;
    },
    HINT_REVEAL() {
      if (!revealed()) return `<div class="countdown" id="countdown"></div>`;
      return `<div class="gridhead"><div class="mid">ROUND ${pub.roundIndex} 힌트</div><div class="muted">누가 라이어일까요?</div></div>${gridHtml({ animate: true })}`;
    },
    VOTING() {
      const vp = pub.voteProgress || { voted: 0, total: 0 };
      return `<div class="gridhead"><div class="mid">🗳️ 투표 중 — 라이어라고 생각하는 사람을 고르세요</div><div class="mid">투표 완료 <b>${vp.voted}</b> / ${vp.total}</div></div>${gridHtml()}`;
    },
    JUDGING() {
      return `<div class="gridhead"><div class="mid">⚖️ 판정</div><div class="muted">공개 기준 ${pub.judge ? pub.judge.threshold : '-'}표 이상</div></div>${gridHtml({ pick: pub.judge && pub.judge.current && pub.judge.current.id })}`;
    },
    GUESSING() {
      return VIEWS.JUDGING();
    },
    ROUND_SETTLE() {
      const s = pub.roundSummary;
      const lines = [];
      if (s.none) lines.push(`<div class="row"><span class="nm">지목된 사람이 없었습니다</span></div>`);
      for (const c of s.caught) {
        lines.push(`<div class="row"><span class="nm">🎯 ${esc(c.name)} — 라이어 검거</span><span class="pt ${c.correct ? 'good' : 'bad'}">${c.correct ? `제시어 정답 +${fmt(c.points)}` : '제시어 실패'}</span></div>`);
      }
      for (const n of s.cleared) lines.push(`<div class="row"><span class="nm">🙅 ${esc(n)} — 시민</span></div>`);
      const pts = [];
      if (s.caught.length) pts.push(`<div class="row"><span class="nm">라이어에게 투표한 시민 ${s.correctVoters}명</span><span class="pt good">각 +${fmt(s.perVote)}</span></div>`);
      if (s.wrongVoters && s.penalty > 0) pts.push(`<div class="row"><span class="nm">시민에게 투표한 시민 ${s.wrongVoters}명</span><span class="pt bad">각 −${fmt(s.penalty)}</span></div>`);
      if (s.liarsLeft) pts.push(`<div class="row"><span class="nm">살아남은 라이어</span><span class="pt accent">각 +${fmt(s.survivePts)}</span></div>`);
      return `<div class="center" style="justify-content:flex-start; gap:1em">
        <div class="big">ROUND ${s.round} 정산</div>
        <div class="mid">남은 라이어 <span class="${s.liarsLeft ? 'bad' : 'good'}">${s.liarsLeft}</span>명</div>
        <div class="cols" style="width:100%; text-align:left">
          <div class="card"><h3>판정 결과</h3><div class="rows">${lines.join('')}</div></div>
          <div class="card"><h3>이번 라운드 득점</h3><div class="rows">${pts.join('') || '<div class="row"><span class="nm muted">득점 없음</span></div>'}</div>
            <p class="muted" style="margin-top:1em">내 점수는 휴대폰에서 확인하세요</p></div>
        </div>
      </div>`;
    },
    SET_END() {
      const s = pub.setSummary;
      const liars = s.liars
        .map(
          (l, i) =>
            `<div class="row" style="animation-delay:${i * 120}ms"><span class="nm">🕵️ ${esc(l.name)}</span><span class="pt ${l.survived ? 'accent' : 'muted'}">${l.kicked ? '퇴장' : l.survived ? '끝까지 생존!' : `${l.caughtRound}라운드 검거`}</span></div>`
        )
        .join('');
      return `<div class="center" style="justify-content:flex-start; gap:0.4em">
        <div class="mid muted">SET ${s.set} 종료 · 제시어는</div>
        <div class="keyword">${esc(s.keyword)}</div>
        <div class="muted">${s.earlyBonus > 0.5 ? `조기 종료 보너스: 시민 전원 +${fmt(s.earlyBonus)}점` : `${s.roundsPlayed}라운드 모두 진행`}</div>
        <div class="cols" style="width:100%; text-align:left; margin-top:0.8em">
          <div class="card"><h3>이번 세트의 라이어</h3><div class="rows">${liars}</div></div>
          <div class="card"><h3>세트 점수 상위</h3>${ranksHtml(s.top)}</div>
        </div>
      </div>`;
    },
    GAME_END() {
      return `<div class="center" style="justify-content:flex-start">
        <div class="congrats">🎉 축하합니다! 🎉</div>
        <div style="width:min(900px, 90%)">${ranksHtml(pub.final.top, 'podium')}</div>
      </div>`;
    },
  };

  function renderOverlay() {
    const j = pub.judge;
    let html = '';
    if (pub.phase === 'JUDGING' && j) {
      const cur = j.current;
      if (!j.total || !cur) {
        html = `<div class="popup"><div class="who">지목된 사람 없음</div><div class="mid muted">공개 기준(${j.threshold}표)을 넘은 사람이 없습니다</div></div>`;
      } else if (!cur.revealed) {
        html = `<div class="popup ${canAct ? 'clickable' : ''}" id="judgePopup">
          <div class="label">${j.idx + 1} / ${j.total} · ${cur.votes}표</div>
          <div class="who">${esc(cur.name)}</div>
          <div class="mid muted">${canAct ? '클릭해서 확인' : '과연…?'}</div></div>`;
      } else {
        html = `<div class="popup ${cur.isLiar ? 'liar' : 'citizen'}">
          <div class="label">${j.idx + 1} / ${j.total} · ${cur.votes}표</div>
          <div class="who">${esc(cur.name)}</div>
          <div class="verdict ${cur.isLiar ? 'bad' : 'good'}">${cur.isLiar ? '라이어였습니다!' : '라이어가 아닙니다!'}</div>
          ${cur.isLiar ? '<div class="mid muted">이제 제시어를 맞힐 기회가 주어집니다</div>' : ''}</div>`;
      }
    } else if (pub.phase === 'GUESSING' && pub.guess) {
      const g = pub.guess;
      if (!g.done) {
        html = `<div class="popup liar"><div class="who">${esc(g.name)}</div>
          <div class="mid">제시어를 맞히는 중…</div><div class="huge" id="bigTimer"></div></div>`;
      } else if (g.correct) {
        html = `<div class="popup citizen"><div class="who">${esc(g.name)}</div>
          <div class="verdict good">제시어를 맞혔습니다!!</div><div class="big accent">${fmt(g.points)}점 득점!</div></div>`;
      } else {
        html = `<div class="popup liar"><div class="who">${esc(g.name)}</div>
          <div class="verdict bad">제시어를 맞히지 못했습니다</div><div class="mid muted">추가 점수 없음</div></div>`;
      }
    }
    $overlay.className = html ? 'overlay' : '';
    $overlay.innerHTML = html;
    const popup = document.getElementById('judgePopup');
    if (popup && canAct) popup.addEventListener('click', next);
  }

  function actionLabel() {
    if (!pub) return null;
    const j = pub.judge;
    switch (pub.phase) {
      case 'SET_INTRO':
        return '힌트 입력 시작 ▶';
      case 'HINT_REVEAL':
        return revealed() ? '투표 시작 ▶' : null;
      case 'JUDGING':
        if (!j || !j.total || !j.current) return '라운드 정산 ▶';
        if (!j.current.revealed) return '판정 공개';
        return j.current.isLiar ? '제시어 맞히기 ▶' : '다음 ▶';
      case 'GUESSING':
        return pub.guess && pub.guess.done ? '다음 ▶' : null;
      case 'ROUND_SETTLE':
        return pub.roundSummary && pub.roundSummary.last ? '세트 결과 ▶' : '다음 라운드 ▶';
      case 'SET_END':
        return pub.setIndex < pub.settings.sets ? '다음 세트 ▶' : '최종 결과 ▶';
      default:
        return null;
    }
  }

  function renderActions() {
    const label = canAct && actionLabel();
    $actions.innerHTML = label ? `<button class="btn primary" id="nextBtn">${esc(label)}</button>` : '';
    const btn = document.getElementById('nextBtn');
    if (btn) {
      btn.addEventListener('click', () => {
        btn.disabled = true;
        next();
        setTimeout(() => (btn.disabled = false), 600);
      });
    }
  }
})();
