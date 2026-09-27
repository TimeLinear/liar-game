'use strict';

(function () {
  const { socket, params, remainingMs, esc, fmt, signed, PHASE_LABEL, holdToReveal } = LG;
  const $main = document.getElementById('main');
  const $topInfo = document.getElementById('topInfo');
  const $peek = document.getElementById('peek');
  const $peekBtn = document.getElementById('peekBtn');
  const $banner = document.getElementById('connBanner');

  // ?slot=2 처럼 주면 같은 브라우저에서 여러 참가자를 테스트할 수 있다.
  const slot = params.get('slot');
  const TOKEN_KEY = `liar_token${slot ? `_${slot}` : ''}`;
  const PEEK_HIDE_KEY = 'liar_peek_hidden';
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} },
    del: (k) => { try { localStorage.removeItem(k); } catch (_) {} },
  };

  let joined = false;
  let kicked = false;
  let joinError = '';
  let pub = null;
  let priv = null;
  let liarWords = [];
  let currentView = '';
  let currentKey = '';

  // ─── 연결과 입장 ───────────────────────────────────────────────────────
  socket.on('connect', () => {
    $banner.classList.add('hidden');
    const token = store.get(TOKEN_KEY);
    if (token) {
      socket.emit('join', { token }, (res) => {
        if (res && res.ok) {
          joined = true;
          requestWakeLock();
        } else {
          store.del(TOKEN_KEY);
          joined = false;
          if (res && res.kicked) kicked = true;
        }
        render();
      });
    } else {
      render();
    }
  });
  socket.on('disconnect', () => $banner.classList.remove('hidden'));
  socket.on('kicked', () => {
    store.del(TOKEN_KEY);
    kicked = true;
    joined = false;
    render();
  });
  socket.on('state:public', (s) => {
    pub = s;
    render();
  });
  socket.on('state:private', (s) => {
    priv = s;
    render();
  });
  socket.on('liar:hints', (words) => {
    liarWords = words;
    if (peekOpen) renderPeek();
  });

  function doJoin(code, name) {
    socket.emit('join', { code, name }, (res) => {
      if (res && res.ok) {
        store.set(TOKEN_KEY, res.token);
        joined = true;
        joinError = '';
        requestWakeLock();
      } else {
        joinError = (res && res.error) || '입장하지 못했습니다';
        const el = document.getElementById('joinErr');
        if (el) el.textContent = joinError;
      }
      render();
    });
  }

  // ─── 화면 꺼짐 방지 ────────────────────────────────────────────────────
  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => (wakeLock = null));
      }
    } catch (_) {
      wakeLock = null; // 지원하지 않거나 거부되면 무시한다
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && joined) requestWakeLock();
  });

  // ─── 화면 결정 ─────────────────────────────────────────────────────────
  function viewName() {
    if (kicked) return 'kicked';
    if (!joined) return 'join';
    if (!pub || !priv) return 'loading';
    const ph = pub.phase;
    const me = priv.me;
    if (ph === 'LOBBY') return 'lobby';
    if (ph === 'GAME_END') return me.inSet || priv.score.rank ? 'final' : 'spectate';
    if (!me.inSet) return 'spectate';
    if (ph === 'SET_END') return 'setEnd';
    if (ph === 'GUESSING' && priv.guessing) return 'guess';
    if (ph === 'GUESSING' && priv.myGuess) return 'guessResult';
    if (!me.alive) return 'out';
    switch (ph) {
      case 'SET_INTRO': return 'role';
      case 'HINT_INPUT': return 'hint';
      case 'VOTING': return 'vote';
      case 'ROUND_SETTLE': return 'round';
      default: return 'wait';
    }
  }

  function render() {
    renderTop();
    const name = viewName();
    const view = VIEWS[name];
    const key = `${name}|${view.key ? view.key() : ''}`;
    if (key !== currentKey) {
      currentKey = key;
      currentView = name;
      $main.innerHTML = view.html();
      if (view.bind) view.bind();
    }
    if (view.update) view.update();
    renderPeekButton();
    tick();
  }

  function renderTop() {
    if (!joined || !priv) {
      $topInfo.textContent = '';
      return;
    }
    const parts = [esc(priv.me.name)];
    if (pub && pub.setIndex && pub.phase !== 'LOBBY') parts.push(`SET ${pub.setIndex}/${pub.settings.sets}`);
    if (pub && pub.roundIndex && ['HINT_INPUT', 'HINT_REVEAL', 'VOTING', 'JUDGING', 'GUESSING', 'ROUND_SETTLE'].includes(pub.phase)) {
      parts.push(`R${pub.roundIndex}`);
    }
    $topInfo.innerHTML = parts.join(' · ');
  }

  function tick() {
    const el = document.getElementById('timer');
    if (!el || !pub) return;
    const sec = Math.ceil(remainingMs(pub) / 1000);
    el.textContent = pub.paused ? `${sec} ⏸` : sec;
    el.classList.toggle('low', sec <= 10 && !pub.paused);
  }
  setInterval(tick, 200);

  const roleLabel = (r) => (r === 'liar' ? '🕵️ 라이어' : '🙂 시민');
  const scoreBox = () => `<div class="scorebox">
      <div><div class="k">이번 세트</div><div class="v">${fmt(priv.score.set)}</div></div>
      <div><div class="k">누적 (${priv.score.rank || '-'}위 / ${priv.score.of}명)</div><div class="v">${fmt(priv.score.total)}</div></div>
    </div>`;

  // ─── 화면들 ────────────────────────────────────────────────────────────
  const VIEWS = {
    loading: { html: () => '<div class="center muted">불러오는 중…</div>' },
    kicked: {
      html: () => `<div class="center"><div class="emoji">🚪</div><h1>퇴장되었습니다</h1><p class="muted">사회자에 의해 게임에서 퇴장되었습니다.</p></div>`,
    },
    join: {
      key: () => joinError,
      html: () => `<div class="stack" style="padding-top:4vh">
          <div class="center" style="padding-top:0"><div class="emoji">🕵️</div><h1>라이어 게임 입장</h1><p class="muted" style="margin:0">스크린에 보이는 방 코드를 입력하세요</p></div>
          <form id="joinForm" class="stack" autocomplete="off">
            <div class="field"><label for="code">방 코드</label><input id="code" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" required value="${esc(params.get('code') || '')}" /></div>
            <div class="field"><label for="name">이름</label><input id="name" type="text" maxlength="12" required placeholder="스크린에 표시될 이름" /></div>
            <div class="err" id="joinErr">${esc(joinError)}</div>
            <button class="btn primary block" type="submit">입장하기</button>
          </form>
        </div>`,
      bind() {
        const form = document.getElementById('joinForm');
        const code = document.getElementById('code');
        const name = document.getElementById('name');
        (code.value ? name : code).focus();
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          doJoin(code.value.trim(), name.value.trim());
        });
      },
    },
    lobby: {
      key: () => `${priv.me.name}|${pub.players.filter((p) => !p.spectator).length}`,
      html: () => `<div class="center"><div class="emoji">⏳</div><h1>곧 시작합니다</h1>
          <p><span class="pill">${esc(priv.me.name)}</span> 님, 입장 완료!</p>
          <p class="muted">현재 ${pub.players.filter((p) => !p.spectator).length}명 참가 중 · 스크린을 봐 주세요</p></div>`,
    },
    spectate: {
      key: () => `${pub.phase}|${pub.setIndex}|${pub.roundIndex}`,
      html: () => `<div class="center"><div class="emoji">👀</div><h1>관전 중</h1>
          <p class="muted">게임이 이미 시작되어 관전자로 입장했습니다.<br/>진행 상황은 스크린에서 볼 수 있어요.</p>
          <p><span class="pill">${esc(PHASE_LABEL[pub.phase] || '')}</span></p></div>`,
    },
    role: {
      key: () => `${pub.setIndex}|${priv.me.role}|${priv.keyword}`,
      html: () => `<div class="center" style="padding-top:2vh">
          <h1>SET ${pub.setIndex} 역할 확인</h1>
          <p class="muted" style="margin:0">남에게 보이지 않게 카드를 꾹 누르세요</p>
          <div class="rolecard" id="roleCard">
            <div class="cover"><div class="emoji">🂠</div><div style="font-size:22px;font-weight:800">꾹 눌러서 확인</div></div>
            <div class="inner">
              <div class="cat">카테고리 · ${esc(pub.category)}</div>
              ${priv.me.role === 'liar'
                ? '<div class="liar">당신은 <span class="bad">라이어</span>입니다.<br/>다른 시민들의 힌트를 보고 제시어를 아는 것처럼 속이세요!</div>'
                : `<div class="cat">제시어</div><div class="kw">${esc(priv.keyword)}</div>`}
            </div>
          </div>
          <p class="muted">확인했으면 스크린을 봐 주세요</p></div>`,
      bind() {
        const card = document.getElementById('roleCard');
        holdToReveal(card, { onOpen: () => card.classList.add('open'), onClose: () => card.classList.remove('open') });
      },
    },
    hint: {
      key: () => `${pub.setIndex}|${pub.roundIndex}`,
      html: () => `<div class="stack">
          <div style="text-align:center"><span class="pill">ROUND ${pub.roundIndex} · 힌트 입력</span></div>
          <div class="timer" id="timer"></div>
          <p style="text-align:center;margin:0" class="muted">카테고리 <b style="color:var(--text)">${esc(pub.category)}</b></p>
          <form id="hintForm" class="stack" autocomplete="off">
            <div class="field"><label for="hintInput">제시어와 관련된 단어 1개</label>
              <input id="hintInput" type="text" maxlength="${pub.settings.hintMaxLen}" enterkeyhint="done" placeholder="최대 ${pub.settings.hintMaxLen}자" value="${esc(priv.hint)}" /></div>
            <div class="err" id="hintErr"></div>
            <button class="btn primary block" type="submit">제출</button>
          </form>
          <div id="hintStatus" style="text-align:center;font-weight:700"></div>
          <p class="muted" style="font-size:14px;text-align:center;margin:0">마감 전까지 수정할 수 있고, 마감 시 입력칸의 내용이 자동 제출됩니다.</p>
        </div>`,
      bind() {
        const input = document.getElementById('hintInput');
        const form = document.getElementById('hintForm');
        const err = document.getElementById('hintErr');
        let debounce = null;
        const send = (final) => {
          socket.emit('hint:submit', { text: input.value, final }, (res) => {
            err.textContent = res && !res.ok ? res.error : '';
          });
        };
        input.addEventListener('input', () => {
          clearTimeout(debounce);
          debounce = setTimeout(() => send(false), 250);
        });
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          clearTimeout(debounce);
          if (!input.value.trim()) {
            err.textContent = '단어를 입력하세요';
            return;
          }
          send(true);
          input.blur();
        });
      },
      update() {
        const st = document.getElementById('hintStatus');
        if (!st) return;
        st.innerHTML = priv.hintSubmitted
          ? `<span class="good">✓ 제출됨: “${esc(priv.hint)}”</span>`
          : priv.hint
            ? `<span class="warn">입력 중: “${esc(priv.hint)}” (제출 버튼을 누르거나 마감 시 자동 제출)</span>`
            : '<span class="muted">아직 입력하지 않았어요</span>';
      },
    },
    wait: {
      key: () => `${pub.phase}|${pub.roundIndex}`,
      html: () => {
        const sub = {
          HINT_REVEAL: '힌트가 공개됩니다!',
          JUDGING: '판정이 진행 중입니다',
          GUESSING: '라이어가 제시어를 맞히는 중입니다',
        }[pub.phase] || '';
        return `<div class="center"><div class="emoji">📺</div><h1>스크린을 보세요</h1><p class="muted">${sub}</p></div>`;
      },
    },
    vote: {
      key: () => `${pub.setIndex}|${pub.roundIndex}`,
      html: () => `<div class="stack">
          <div style="text-align:center"><span class="pill">ROUND ${pub.roundIndex} · 투표</span></div>
          <div class="timer" id="timer"></div>
          <div id="myVote" style="text-align:center;font-weight:700"></div>
          <input id="search" type="search" placeholder="이름 또는 단어 검색" autocomplete="off" />
          <div class="err" id="voteErr"></div>
          <div class="cands" id="cands"></div>
        </div>`,
      bind() {
        const search = document.getElementById('search');
        search.addEventListener('input', drawCandidates);
        document.getElementById('cands').addEventListener('click', (e) => {
          const b = e.target.closest('.cand');
          if (!b) return;
          const target = b.dataset.id;
          priv.vote = target; // 즉시 반영하고 서버 응답을 기다린다
          VIEWS.vote.update();
          socket.emit('vote', { target }, (res) => {
            document.getElementById('voteErr').textContent = res && !res.ok ? res.error : '';
          });
        });
        drawCandidates();
      },
      update() {
        const gridKey = JSON.stringify(pub.grid);
        if (gridKey !== lastGridKey) {
          lastGridKey = gridKey;
          return drawCandidates();
        }
        const cands = document.querySelectorAll('.cand');
        cands.forEach((b) => b.classList.toggle('sel', b.dataset.id === priv.vote));
        const target = (pub.grid || []).find((c) => c.id === priv.vote);
        const mv = document.getElementById('myVote');
        if (mv) {
          mv.innerHTML = target
            ? `<span class="good">내 투표: ${esc(target.name)}</span> <span class="muted">(마감 전 변경 가능)</span>`
            : '<span class="muted">라이어라고 생각하는 사람을 고르세요</span>';
        }
      },
    },
    guess: {
      key: () => `${pub.setIndex}|${pub.roundIndex}`,
      html: () => `<div class="stack">
          <div class="center" style="padding-top:0"><div class="emoji">🎯</div><h1>제시어를 맞혀 보세요!</h1>
          <p class="muted" style="margin:0">카테고리 <b style="color:var(--text)">${esc(pub.category)}</b> · 기회는 한 번</p></div>
          <div class="timer" id="timer"></div>
          <form id="guessForm" class="stack" autocomplete="off">
            <input id="guessInput" type="text" maxlength="30" placeholder="제시어" style="font-size:22px;padding:14px" />
            <div class="err" id="guessErr"></div>
            <button class="btn primary block" type="submit">정답 제출</button>
          </form></div>`,
      bind() {
        const form = document.getElementById('guessForm');
        const input = document.getElementById('guessInput');
        input.focus();
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          if (!input.value.trim()) return;
          form.querySelector('button').disabled = true;
          socket.emit('guess', { text: input.value }, (res) => {
            if (res && !res.ok) {
              document.getElementById('guessErr').textContent = res.error;
              form.querySelector('button').disabled = false;
            }
          });
        });
      },
    },
    guessResult: {
      key: () => JSON.stringify(priv.myGuess),
      html: () => {
        const g = priv.myGuess;
        return g.correct
          ? `<div class="center"><div class="emoji">🎉</div><h1 class="good">정답입니다!</h1><p style="font-size:24px;font-weight:800">+${fmt(g.points)}점</p><p class="muted">이번 세트에서는 퇴장합니다. 다음 세트를 기다려 주세요.</p></div>`
          : `<div class="center"><div class="emoji">😵</div><h1 class="bad">아쉽게도 틀렸습니다</h1><p class="muted">이번 세트에서는 퇴장합니다. 다음 세트를 기다려 주세요.</p></div>`;
      },
    },
    out: {
      key: () => `${pub.phase}|${pub.roundIndex}|${fmt(priv.score.set)}`,
      html: () => `<div class="center"><div class="emoji">🍿</div><h1>관전 중</h1>
          <p class="muted">이번 세트에서 퇴장했습니다. 다음 세트까지 스크린으로 관전하세요.</p>
          <p><span class="pill">${esc(PHASE_LABEL[pub.phase] || '')}</span></p>${scoreBox()}</div>`,
    },
    round: {
      key: () => `${pub.roundIndex}|${fmt(priv.score.round)}|${fmt(priv.score.total)}|${priv.score.rank}`,
      html: () => `<div class="center"><div class="emoji">🧮</div><h1>ROUND ${pub.roundIndex} 정산</h1>
          <p style="font-size:30px;font-weight:900" class="${priv.score.round > 0 ? 'good' : priv.score.round < 0 ? 'bad' : 'muted'}">이번 라운드 ${signed(priv.score.round)}점</p>
          <p class="muted">남은 라이어 ${pub.roundSummary ? pub.roundSummary.liarsLeft : '-'}명</p>${scoreBox()}</div>`,
    },
    setEnd: {
      key: () => `${pub.setIndex}|${fmt(priv.score.set)}|${fmt(priv.score.total)}|${priv.score.rank}`,
      html: () => `<div class="center"><div class="emoji">🏁</div><h1>SET ${pub.setIndex} 결과</h1>
          <p>내 역할 <span class="pill">${roleLabel(priv.me.role)}</span></p>
          <p class="muted" style="margin:0">제시어</p><p style="font-size:30px;font-weight:900;margin:0" class="accent">${esc(pub.setSummary ? pub.setSummary.keyword : '')}</p>
          ${scoreBox()}</div>`,
    },
    final: {
      key: () => `${fmt(priv.score.total)}|${priv.score.rank}`,
      html: () => `<div class="center"><div class="emoji">🏆</div><h1>게임 종료!</h1>
          <p style="font-size:44px;font-weight:900;margin:6px 0" class="accent">${priv.score.rank || '-'}위</p>
          <p class="muted" style="margin:0">${priv.score.of}명 중</p>
          <p style="font-size:26px;font-weight:800">누적 ${fmt(priv.score.total)}점</p>
          <p class="muted">스크린에서 최종 랭킹을 확인하세요</p></div>`,
    },
  };

  let lastGridKey = '';
  function drawCandidates() {
    const box = document.getElementById('cands');
    if (!box) return;
    lastGridKey = JSON.stringify(pub.grid);
    const q = (document.getElementById('search').value || '').replace(/\s+/g, '').toLowerCase();
    const list = (pub.grid || [])
      .filter((c) => c.id !== priv.me.id && !c.out)
      .filter((c) => !q || `${c.name}${c.word || ''}`.replace(/\s+/g, '').toLowerCase().includes(q));
    box.innerHTML =
      list
        .map((c) => {
          const word = c.hidden ? '(가려짐)' : c.missing ? '(미제출)' : c.word;
          return `<button type="button" class="cand" data-id="${esc(c.id)}"><span class="nm">${esc(c.name)}</span><span class="wd">${esc(word)}</span></button>`;
        })
        .join('') || '<p class="muted" style="text-align:center">검색 결과가 없습니다</p>';
    VIEWS.vote.update();
  }

  // ─── 열람 버튼 ─────────────────────────────────────────────────────────
  // 버튼 유무가 라이어의 증거가 되지 않도록 모든 참가자에게 같은 버튼을 준다.
  let peekOpen = false;
  const PEEK_PHASES = new Set(['SET_INTRO', 'HINT_INPUT', 'HINT_REVEAL', 'VOTING', 'JUDGING', 'GUESSING', 'ROUND_SETTLE']);

  function peekAvailable() {
    return joined && pub && priv && priv.me.inSet && priv.me.alive && PEEK_PHASES.has(pub.phase);
  }

  function renderPeekButton() {
    const show = peekAvailable();
    $peekBtn.classList.toggle('hidden', !show);
    $peekBtn.classList.toggle('ghost', store.get(PEEK_HIDE_KEY) === '1');
    if (!show && peekOpen) peekCtl.close();
  }

  function renderPeek() {
    if (!priv) return;
    if (priv.me.role === 'liar') {
      const cur = pub ? pub.roundIndex : 0;
      const words = liarWords.length
        ? liarWords.map((w) => `<span class="${w.round < cur ? 'old' : ''}">${esc(w.word)}</span>`).join('')
        : '<span class="muted" style="background:none">아직 제출된 단어가 없습니다</span>';
      $peek.innerHTML = `<div class="muted">카테고리 · ${esc(pub.category)}</div><div style="font-weight:800;margin-top:6px">지금까지 제출된 단어</div><div class="words">${words}</div>`;
    } else {
      $peek.innerHTML = `<div class="muted">카테고리 · ${esc(pub.category)}</div><div class="muted" style="margin-top:6px">제시어</div><div class="kw">${esc(priv.keyword || '')}</div>`;
    }
  }

  const peekCtl = holdToReveal($peekBtn, {
    onOpen: () => {
      if (!peekAvailable()) return;
      peekOpen = true;
      renderPeek();
      $peek.classList.remove('hidden');
    },
    onClose: () => {
      peekOpen = false;
      $peek.classList.add('hidden');
      $peek.innerHTML = '';
    },
    onDoubleTap: () => {
      const hidden = store.get(PEEK_HIDE_KEY) === '1';
      store.set(PEEK_HIDE_KEY, hidden ? '0' : '1');
      renderPeekButton();
    },
  });

  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('input')) e.preventDefault();
  });
  document.addEventListener('pointerdown', () => {
    if (joined && !wakeLock) requestWakeLock();
  });

  render();
})();
