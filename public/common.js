'use strict';

// 세 화면이 함께 쓰는 연결, 서버 시각 보정, 유틸.
(function () {
  const params = new URLSearchParams(location.search);
  const opts = {};
  // ?transport=polling 으로 WebSocket이 막힌 환경을 흉내 낸다.
  if (params.get('transport') === 'polling') opts.transports = ['polling'];
  const socket = io(opts);

  let offset = 0; // 서버 시각 - 내 시각
  let bestRtt = Infinity;
  function sync() {
    const t0 = Date.now();
    socket.timeout(5000).emit('time', (err, serverTime) => {
      if (err) return;
      const t1 = Date.now();
      const rtt = t1 - t0;
      // 왕복 시간이 짧았던 측정일수록 정확하다.
      if (rtt <= bestRtt * 1.5 || rtt < 150) {
        bestRtt = Math.min(bestRtt, rtt);
        offset = serverTime - (t0 + t1) / 2;
      }
    });
  }
  socket.on('connect', () => {
    bestRtt = Infinity;
    sync();
    setTimeout(sync, 1500);
  });
  setInterval(sync, 20000);

  const now = () => Date.now() + offset;

  function remainingMs(pub) {
    if (!pub) return 0;
    if (pub.paused) return pub.pausedRemaining;
    if (!pub.deadline) return 0;
    return Math.max(0, pub.deadline - now());
  }

  function transportName() {
    return socket.io.engine && socket.io.engine.transport ? socket.io.engine.transport.name : '-';
  }
  function onTransportChange(fn) {
    socket.io.on('open', () => {
      fn(transportName());
      socket.io.engine.on('upgrade', () => fn(transportName()));
    });
  }

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n) => Math.round(n || 0);
  const signed = (n) => (fmt(n) > 0 ? `+${fmt(n)}` : String(fmt(n)));

  const PHASE_LABEL = {
    LOBBY: '대기실',
    SET_INTRO: '세트 시작',
    HINT_INPUT: '힌트 입력',
    HINT_REVEAL: '힌트 공개',
    VOTING: '투표',
    JUDGING: '판정',
    GUESSING: '제시어 맞히기',
    ROUND_SETTLE: '라운드 정산',
    SET_END: '세트 종료',
    GAME_END: '게임 종료',
  };

  // 꾹 눌러야 열리는 요소. 150ms 이상 누를 때만 열고, 떼거나 취소되거나 앱을 전환하면 닫는다.
  function holdToReveal(el, { onOpen, onClose, onDoubleTap, delay = 150 }) {
    let downAt = 0;
    let holdTimer = null;
    let open = false;
    let lastTap = 0;
    const close = () => {
      clearTimeout(holdTimer);
      holdTimer = null;
      if (open) {
        open = false;
        onClose();
      }
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      downAt = performance.now();
      try {
        el.setPointerCapture(e.pointerId);
      } catch (_) {}
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => {
        open = true;
        onOpen();
      }, delay);
    });
    el.addEventListener('pointerup', () => {
      const wasOpen = open;
      const short = performance.now() - downAt < delay;
      close();
      if (wasOpen || !short || !onDoubleTap) return;
      const t = performance.now();
      if (t - lastTap < 400) {
        lastTap = 0;
        onDoubleTap();
      } else {
        lastTap = t;
      }
    });
    el.addEventListener('pointercancel', close);
    el.addEventListener('lostpointercapture', close);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) close();
    });
    window.addEventListener('blur', close);
    return { close, isOpen: () => open };
  }

  window.LG = { socket, params, now, remainingMs, transportName, onTransportChange, esc, fmt, signed, PHASE_LABEL, holdToReveal };
})();
