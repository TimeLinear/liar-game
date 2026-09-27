'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const DEFAULT_BANK = require('./wordbank');

// ─── 서버 설정 ──────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
const HOST_KEY = process.env.HOST_KEY || crypto.randomBytes(4).toString('hex');
const ROOM_CODE = /^\d{4}$/.test(process.env.ROOM_CODE || '')
  ? process.env.ROOM_CODE
  : String(crypto.randomInt(1000, 10000));
// 명세상 라이어 수는 1~인원의 1/4이므로 최소 4명. 테스트할 때만 낮춘다.
const MIN_PLAYERS = Math.max(2, Number(process.env.MIN_PLAYERS) || 4);

const app = express();
app.set('trust proxy', true);
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

app.get('/', (req, res) => res.redirect('/play'));
app.get('/healthz', (req, res) => res.json({ ok: true, phase: game.phase }));
app.get('/qr.svg', async (req, res, next) => {
  try {
    const url = `${req.protocol}://${req.get('host')}/play?code=${ROOM_CODE}`;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch (err) {
    next(err);
  }
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ─── 설정값 ────────────────────────────────────────────────────────────────
const SETTING_RULES = {
  sets: { def: 5, min: 1, max: 10, label: '세트 수' },
  rounds: { def: 3, min: 2, max: 3, label: '세트당 최대 라운드' },
  liars: { def: 3, min: 1, max: 10, label: '라이어 수' },
  hintSec: { def: 45, min: 30, max: 60, label: '힌트 입력 시간(초)' },
  voteSec: { def: 60, min: 30, max: 120, label: '투표 시간(초)' },
  guessSec: { def: 30, min: 15, max: 60, label: '제시어 맞히기 시간(초)' },
  thresholdPct: { def: 30, min: 10, max: 50, label: '공개 기준(생존 인원 %)' },
  rankN: { def: 5, min: 1, max: 10, label: '랭킹 표시 인원' },
  liarBonus: { def: 0, min: 0, max: 50, label: '라이어 정답 보너스' },
  wrongVotePenalty: { def: 0, min: 0, max: 50, label: '오투표 감점 (최대 100/R)' },
  hintMaxLen: { def: 10, min: 5, max: 15, label: '힌트 최대 글자 수' },
};

function defaultSettings() {
  const s = {};
  for (const [k, r] of Object.entries(SETTING_RULES)) s[k] = r.def;
  s.noReuse = false;
  return s;
}
let settings = defaultSettings();

function applySettings(input) {
  const next = { ...settings };
  for (const [k, r] of Object.entries(SETTING_RULES)) {
    if (input[k] === undefined) continue;
    const v = Number(input[k]);
    if (Number.isFinite(v)) next[k] = Math.min(r.max, Math.max(r.min, Math.round(v)));
  }
  if (input.noReuse !== undefined) next.noReuse = !!input.noReuse;
  next.wrongVotePenalty = Math.min(next.wrongVotePenalty, 100 / next.rounds);
  settings = next;
}

// ─── 제시어 뱅크 ────────────────────────────────────────────────────────────
let bankSeq = 0;
const makeBankItem = ({ category, word, aliases }) => ({
  id: ++bankSeq,
  category: String(category).trim().slice(0, 20),
  word: String(word).trim().slice(0, 30),
  aliases: (aliases || []).map((a) => String(a).trim().slice(0, 30)).filter(Boolean),
});
let bank = DEFAULT_BANK.map(makeBankItem);

function parseAliases(v) {
  if (Array.isArray(v)) return v;
  return String(v || '').split(/[,，]/);
}

// ─── 참가자 ────────────────────────────────────────────────────────────────
// Player: id, token, name, sockets, connected, transport, spectator, inSet,
//         role(citizen/liar), alive(이번 세트 생존), wasLiar(비복원 추첨용), played, caughtRound
const players = new Map();
const tokenIndex = new Map();
const kickedTokens = new Set();
const names = new Map(); // id → 이름 (강퇴된 참가자도 기록용으로 남긴다)
const screens = new Map(); // socket.id → { transport, canAct }
let playerSeq = 0;

const allPlayers = () => [...players.values()];
const alivePlayers = () => allPlayers().filter((p) => p.inSet && p.alive);
const byName = (a, b) => a.name.localeCompare(b.name, 'ko');
const byJoin = (a, b) => a.seq - b.seq;

function maxLiars(n) {
  if (n >= 4) return Math.floor(n / 4);
  return n >= 2 ? 1 : 0;
}

// ─── 게임 상태 ──────────────────────────────────────────────────────────────
const IN_SET_PHASES = new Set([
  'SET_INTRO', 'HINT_INPUT', 'HINT_REVEAL', 'VOTING', 'JUDGING', 'GUESSING', 'ROUND_SETTLE', 'SET_END',
]);
const GRID_PHASES = new Set(['HINT_REVEAL', 'VOTING', 'JUDGING', 'GUESSING', 'ROUND_SETTLE']);
const REVEAL_COUNTDOWN_MS = 3200;

function newGame() {
  return {
    phase: 'LOBBY',
    deadline: null,
    paused: false,
    pausedRemaining: 0,
    setIndex: 0,
    roundIndex: 0,
    keyword: null,
    category: null,
    aliases: [],
    liarIds: [],
    citizenIds: [],
    hints: new Map(), // playerId → { text, submitted }
    grid: [], // 이번 라운드 공개 그리드 [{ id, name, word }]
    revealAt: 0,
    hidden: new Set(), // `${round}:${playerId}` — 사회자가 가린 힌트
    setWords: [], // 이번 세트의 이전 라운드 단어 [{ round, pid, word }]
    votes: new Map(), // voterId → targetId
    voteSnapshot: new Map(),
    threshold: 0,
    judgeQueue: [],
    judgeIdx: 0,
    guess: null,
    guesses: [], // 이번 세트의 제시어 맞히기 기록
    caughtThisRound: [],
    scoreLog: [], // { pid, set, round, pts, type, key }
    setSummary: null,
    setHistory: [],
    usedBank: new Set(),
    lastStepAt: 0,
  };
}
let game = newGame();

const unit = () => 100 / settings.rounds;
const EPS = 1e-6;
const norm = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, '').toLowerCase();
const matchesKeyword = (text) => {
  const n = norm(text);
  return !!n && [game.keyword, ...game.aliases].some((w) => norm(w) === n);
};

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── 점수 ──────────────────────────────────────────────────────────────────
function award(pid, pts, type, key = null, round = game.roundIndex) {
  if (!pts) return;
  game.scoreLog.push({ pid, set: game.setIndex, round, pts, type, key });
}

function scoreTables() {
  const total = new Map();
  const set = new Map();
  const round = new Map();
  const bySet = new Map();
  const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  for (const e of game.scoreLog) {
    add(total, e.pid, e.pts);
    if (!bySet.has(e.set)) bySet.set(e.set, new Map());
    add(bySet.get(e.set), e.pid, e.pts);
    if (e.set === game.setIndex) {
      add(set, e.pid, e.pts);
      if (e.round === game.roundIndex) add(round, e.pid, e.pts);
    }
  }
  return { total, set, round, bySet };
}

// 내부 값(소수)으로 정렬하고, 동점이면 공동 순위를 준다.
function ranked(list) {
  list.sort((a, b) => (Math.abs(a.score - b.score) < EPS ? a.name.localeCompare(b.name, 'ko') : b.score - a.score));
  let rank = 0;
  list.forEach((e, i) => {
    if (i === 0 || Math.abs(e.score - list[i - 1].score) > EPS) rank = i + 1;
    e.rank = rank;
  });
  return list;
}
// N위 경계의 동점자는 모두 포함한다.
const topN = (list, n) => list.filter((e) => e.rank <= n);

function totalRanking(sc) {
  return ranked(
    allPlayers()
      .filter((p) => p.played)
      .map((p) => ({ id: p.id, name: p.name, score: sc.total.get(p.id) || 0 }))
  );
}

// ─── 타이머 (서버가 마감을 정하고 판정한다) ─────────────────────────────────
let timer = null;

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
  game.deadline = null;
  game.paused = false;
  game.pausedRemaining = 0;
}

function startTimer(ms) {
  clearTimer();
  game.deadline = Date.now() + ms;
  timer = setTimeout(onTimeout, ms);
}

function onTimeout() {
  timer = null;
  if (game.phase === 'HINT_INPUT') endHints();
  else if (game.phase === 'VOTING') endVoting();
  else if (game.phase === 'GUESSING' && game.guess && !game.guess.done) finishGuess(null);
  broadcast();
}

function pauseTimer() {
  if (!game.deadline || game.paused) return;
  const remaining = Math.max(0, game.deadline - Date.now());
  clearTimeout(timer);
  timer = null;
  game.deadline = null;
  game.paused = true;
  game.pausedRemaining = remaining;
}

function resumeTimer() {
  if (game.paused) startTimer(game.pausedRemaining);
}

function extendTimer(sec) {
  if (game.paused) game.pausedRemaining += sec * 1000;
  else if (game.deadline) startTimer(game.deadline - Date.now() + sec * 1000);
}

const inTime = () => game.paused || (game.deadline !== null && Date.now() <= game.deadline);

// ─── 진행 ──────────────────────────────────────────────────────────────────
function startCheck() {
  const n = allPlayers().filter((p) => !p.spectator).length;
  const maxL = maxLiars(n);
  if (n < MIN_PLAYERS) return { ok: false, reason: `최소 ${MIN_PLAYERS}명이 필요합니다 (현재 ${n}명)` };
  if (settings.liars > maxL) return { ok: false, reason: `라이어 수는 인원의 1/4 이하여야 합니다 (현재 최대 ${maxL}명)` };
  if (!bank.length) return { ok: false, reason: '제시어 뱅크가 비어 있습니다' };
  const warn = settings.liars * settings.sets < n
    ? `라이어 수 × 세트 수(${settings.liars * settings.sets}) < 인원(${n}): 라이어를 못 해보는 사람이 생깁니다`
    : null;
  return { ok: true, n, warn };
}

function startGame() {
  if (game.phase !== 'LOBBY') return { ok: false, error: '이미 게임 중입니다' };
  const check = startCheck();
  if (!check.ok) return { ok: false, error: check.reason };
  const usedBank = game.usedBank;
  game = newGame();
  game.usedBank = usedBank;
  for (const p of players.values()) {
    p.wasLiar = false;
    p.played = false;
  }
  startSet();
  return { ok: true };
}

function pickLiars(active, L) {
  const chosen = shuffle(active.filter((p) => !p.wasLiar)).slice(0, L);
  if (chosen.length < L) {
    // 모든 참가자가 한 번씩 라이어를 했으면 후보를 초기화한다.
    for (const p of active) p.wasLiar = false;
    const rest = shuffle(active.filter((p) => !chosen.includes(p)));
    chosen.push(...rest.slice(0, L - chosen.length));
  }
  for (const p of chosen) p.wasLiar = true;
  return chosen;
}

function pickWord() {
  let candidates = bank.filter((b) => !game.usedBank.has(b.id));
  if (!candidates.length) {
    game.usedBank.clear();
    candidates = bank;
  }
  if (!candidates.length) return { category: '자유', word: '사과', aliases: [] };
  const item = candidates[crypto.randomInt(candidates.length)];
  game.usedBank.add(item.id);
  return item;
}

function startSet() {
  clearTimer();
  game.setIndex++;
  game.roundIndex = 0;
  const active = allPlayers().filter((p) => !p.spectator);
  for (const p of players.values()) {
    p.inSet = !p.spectator;
    p.alive = p.inSet;
    p.role = p.inSet ? 'citizen' : null;
    p.caughtRound = null;
    if (p.inSet) p.played = true;
  }
  const L = Math.max(1, Math.min(settings.liars, maxLiars(active.length)));
  const liars = pickLiars(active, L);
  for (const p of liars) p.role = 'liar';
  game.liarIds = liars.map((p) => p.id);
  game.citizenIds = active.filter((p) => p.role === 'citizen').map((p) => p.id);

  const item = pickWord();
  game.keyword = item.word;
  game.category = item.category;
  game.aliases = [...item.aliases];

  game.hints = new Map();
  game.grid = [];
  game.hidden = new Set();
  game.setWords = [];
  game.votes = new Map();
  game.guesses = [];
  game.guess = null;
  game.judgeQueue = [];
  game.setSummary = null;
  game.setHistory.push({
    set: game.setIndex,
    liarIds: [...game.liarIds],
    citizenIds: [...game.citizenIds],
    keyword: game.keyword,
    category: game.category,
  });
  game.phase = 'SET_INTRO';
}

function startRound() {
  game.roundIndex++;
  game.hints = new Map();
  game.grid = [];
  game.votes = new Map();
  game.voteSnapshot = new Map();
  game.judgeQueue = [];
  game.judgeIdx = 0;
  game.guess = null;
  game.caughtThisRound = [];
  game.phase = 'HINT_INPUT';
  startTimer(settings.hintSec * 1000);
}

function submitHint(p, raw, final) {
  if (game.phase !== 'HINT_INPUT' || !inTime()) return { ok: false, error: '입력 시간이 끝났습니다' };
  if (!p.inSet || !p.alive) return { ok: false, error: '이번 라운드 참가자가 아닙니다' };
  const text = String(raw ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!text) {
    game.hints.delete(p.id);
    return { ok: true, empty: true };
  }
  if ([...text].length > settings.hintMaxLen) return { ok: false, error: `${settings.hintMaxLen}자 이하로 입력하세요` };
  if (p.role === 'citizen' && matchesKeyword(text)) {
    game.hints.delete(p.id);
    return { ok: false, error: '제시어를 그대로 쓸 수 없어요' };
  }
  if (settings.noReuse && game.setWords.some((w) => w.word && norm(w.word) === norm(text))) {
    game.hints.delete(p.id);
    return { ok: false, error: '이전 라운드에 나온 단어는 쓸 수 없어요' };
  }
  const prev = game.hints.get(p.id);
  const submitted = !!(final || prev?.submitted);
  game.hints.set(p.id, { text, submitted });
  return { ok: true, submitted };
}

function endHints() {
  clearTimer();
  // 마감 시 입력칸의 내용이 자동 제출된다. 빈칸은 (미제출).
  game.grid = alivePlayers().sort(byName).map((p) => ({
    id: p.id,
    name: p.name,
    word: game.hints.get(p.id)?.text || null,
  }));
  for (const c of game.grid) game.setWords.push({ round: game.roundIndex, pid: c.id, word: c.word });
  game.revealAt = Date.now() + REVEAL_COUNTDOWN_MS;
  game.phase = 'HINT_REVEAL';
}

function startVoting() {
  game.votes = new Map();
  game.phase = 'VOTING';
  startTimer(settings.voteSec * 1000);
}

function castVote(p, targetId) {
  if (game.phase !== 'VOTING' || !inTime()) return { ok: false, error: '투표 시간이 아닙니다' };
  if (!p.inSet || !p.alive) return { ok: false, error: '투표권이 없습니다' };
  if (targetId == null) {
    game.votes.delete(p.id);
    return { ok: true };
  }
  const t = players.get(targetId);
  if (!t || !t.inSet || !t.alive) return { ok: false, error: '투표할 수 없는 대상입니다' };
  if (t.id === p.id) return { ok: false, error: '자기 자신에게는 투표할 수 없습니다' };
  game.votes.set(p.id, t.id);
  return { ok: true };
}

function endVoting() {
  clearTimer();
  const snapshot = new Map();
  const counts = new Map();
  for (const [v, t] of game.votes) {
    if (!players.get(v)?.alive || !players.get(t)?.alive) continue;
    snapshot.set(v, t);
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  game.voteSnapshot = snapshot;
  const aliveN = alivePlayers().length;
  game.threshold = Math.max(1, Math.ceil((aliveN * settings.thresholdPct) / 100));
  game.judgeQueue = [...counts]
    .filter(([, c]) => c >= game.threshold)
    .map(([id, c]) => ({ id, name: players.get(id).name, votes: c, revealed: false, isLiar: null }))
    .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name, 'ko'));
  game.judgeIdx = 0;
  game.phase = 'JUDGING';
  skipKickedJudges();
}

function skipKickedJudges() {
  const q = game.judgeQueue;
  while (game.judgeIdx < q.length && !players.has(q[game.judgeIdx].id)) game.judgeIdx++;
}

function judgeStep() {
  skipKickedJudges();
  const q = game.judgeQueue;
  if (game.judgeIdx >= q.length) return settleRound();
  const cur = q[game.judgeIdx];
  if (!cur.revealed) {
    cur.revealed = true;
    cur.isLiar = game.liarIds.includes(cur.id);
    if (cur.isLiar) {
      players.get(cur.id).caughtRound = game.roundIndex;
      game.caughtThisRound.push(cur.id);
    }
    return;
  }
  if (cur.isLiar) return startGuessing(cur.id);
  advanceJudge();
}

function advanceJudge() {
  game.judgeIdx++;
  game.phase = 'JUDGING';
  skipKickedJudges();
  if (game.judgeIdx >= game.judgeQueue.length) settleRound();
}

function startGuessing(pid) {
  game.guess = {
    pid,
    name: names.get(pid),
    round: game.roundIndex,
    text: null,
    done: false,
    correct: false,
    manual: false,
    points: 0,
  };
  game.phase = 'GUESSING';
  startTimer(settings.guessSec * 1000);
}

const guessPoints = (round) => (settings.rounds - round + 1) * unit() + settings.liarBonus;

function setGuessCorrect(g, correct, manual) {
  const key = `guess:${game.setIndex}:${g.pid}`;
  game.scoreLog = game.scoreLog.filter((e) => e.key !== key);
  g.correct = correct;
  g.manual = manual;
  g.points = correct ? guessPoints(g.round) : 0;
  if (correct) award(g.pid, g.points, 'guess', key, g.round);
}

function finishGuess(text) {
  const g = game.guess;
  if (!g || g.done) return;
  clearTimer();
  g.text = text == null ? null : String(text).normalize('NFC').trim().slice(0, 30) || null;
  g.done = true;
  setGuessCorrect(g, matchesKeyword(g.text), false);
  // 정답 여부와 관계없이 이번 세트에서 퇴장한다.
  const p = players.get(g.pid);
  if (p) p.alive = false;
  game.guesses.push(g);
}

function liarsAlive() {
  return game.liarIds.map((id) => players.get(id)).filter((p) => p && p.alive);
}

function settleRound() {
  clearTimer();
  const u = unit();
  const L = game.liarIds.length || 1;
  const caught = new Set(game.judgeQueue.filter((j) => j.revealed && j.isLiar).map((j) => j.id));
  const cleared = new Set(game.judgeQueue.filter((j) => j.revealed && j.isLiar === false).map((j) => j.id));

  for (const p of liarsAlive()) award(p.id, u, 'survive');
  for (const [v, t] of game.voteSnapshot) {
    const voter = players.get(v);
    if (!voter || voter.role !== 'citizen') continue; // 라이어의 투표는 점수에 반영하지 않는다
    if (caught.has(t)) award(v, 100 / L, 'vote');
    else if (cleared.has(t) && settings.wrongVotePenalty > 0) award(v, -settings.wrongVotePenalty, 'wrongVote');
  }
  game.phase = 'ROUND_SETTLE';
}

function roundSummary() {
  const caught = game.judgeQueue.filter((j) => j.revealed && j.isLiar);
  const cleared = game.judgeQueue.filter((j) => j.revealed && j.isLiar === false);
  const caughtIds = new Set(caught.map((j) => j.id));
  const clearedIds = new Set(cleared.map((j) => j.id));
  let correctVoters = 0;
  let wrongVoters = 0;
  for (const [v, t] of game.voteSnapshot) {
    if (players.get(v)?.role !== 'citizen') continue;
    if (caughtIds.has(t)) correctVoters++;
    else if (clearedIds.has(t)) wrongVoters++;
  }
  const liarsLeft = liarsAlive().length;
  return {
    round: game.roundIndex,
    none: game.judgeQueue.length === 0,
    caught: caught.map((j) => {
      const g = game.guesses.find((x) => x.pid === j.id && x.round === game.roundIndex);
      return { name: j.name, correct: !!g?.correct, points: g?.points || 0 };
    }),
    cleared: cleared.map((j) => j.name),
    liarsLeft,
    correctVoters,
    perVote: 100 / (game.liarIds.length || 1),
    wrongVoters,
    penalty: settings.wrongVotePenalty,
    survivePts: unit(),
    last: liarsLeft === 0 || game.roundIndex >= settings.rounds,
  };
}

function endSet() {
  clearTimer();
  // 조기 종료 보너스: 시민은 100점에서 시작해 라운드마다 u씩 잃는 것과 같다.
  const bonus = (settings.rounds - game.roundIndex) * unit();
  if (bonus > EPS) for (const id of game.citizenIds) if (players.has(id)) award(id, bonus, 'earlyEnd');
  game.setSummary = {
    set: game.setIndex,
    keyword: game.keyword,
    category: game.category,
    roundsPlayed: game.roundIndex,
    earlyBonus: bonus,
    liars: game.liarIds.map((id) => {
      const p = players.get(id);
      return { name: names.get(id), survived: !!p && p.alive, caughtRound: p?.caughtRound ?? null, kicked: !p };
    }),
  };
  game.phase = 'SET_END';
}

function stepNext(force) {
  const now = Date.now();
  if (!force && now - game.lastStepAt < 500) return { ok: false, error: '너무 빠르게 눌렀습니다' };
  game.lastStepAt = now;
  switch (game.phase) {
    case 'SET_INTRO':
      startRound();
      break;
    case 'HINT_INPUT':
      if (!force) return { ok: false, error: '힌트 입력 중입니다' };
      endHints();
      break;
    case 'HINT_REVEAL':
      if (!force && now < game.revealAt) return { ok: false, error: '공개 중입니다' };
      startVoting();
      break;
    case 'VOTING':
      if (!force) return { ok: false, error: '투표 중입니다' };
      endVoting();
      break;
    case 'JUDGING':
      judgeStep();
      break;
    case 'GUESSING':
      if (!game.guess.done) {
        if (!force) return { ok: false, error: '제시어를 맞히는 중입니다' };
        finishGuess(null);
      } else {
        advanceJudge();
      }
      break;
    case 'ROUND_SETTLE':
      if (liarsAlive().length > 0 && game.roundIndex < settings.rounds) startRound();
      else endSet();
      break;
    case 'SET_END':
      if (game.setIndex < settings.sets) startSet();
      else {
        clearTimer();
        game.phase = 'GAME_END';
      }
      break;
    default:
      return { ok: false, error: '진행할 단계가 없습니다' };
  }
  return { ok: true };
}

function resetToLobby() {
  clearTimer();
  const usedBank = game.usedBank;
  game = newGame();
  game.usedBank = usedBank;
  for (const p of players.values()) {
    Object.assign(p, { inSet: false, alive: false, role: null, wasLiar: false, played: false, spectator: false, caughtRound: null });
  }
}

function kick(pid) {
  const p = players.get(pid);
  if (!p) return { ok: false, error: '없는 참가자입니다' };
  kickedTokens.add(p.token);
  tokenIndex.delete(p.token);
  players.delete(pid);
  for (const sid of p.sockets) {
    const s = io.sockets.sockets.get(sid);
    if (!s) continue;
    s.emit('kicked');
    s.data.pid = null;
    s.leave('pub');
    setTimeout(() => s.disconnect(true), 300);
  }
  game.hints.delete(pid);
  game.votes.delete(pid);
  for (const [v, t] of game.votes) if (t === pid) game.votes.delete(v);
  if (game.phase === 'GUESSING' && game.guess?.pid === pid && !game.guess.done) finishGuess(null);
  return { ok: true };
}

// ─── 화면별 상태 ────────────────────────────────────────────────────────────
// 전체 방송에는 역할, 제시어, 실시간 득표를 넣지 않는다.
function publicState(sc) {
  const g = game;
  const ph = g.phase;
  const pub = {
    roomCode: ROOM_CODE,
    phase: ph,
    serverNow: Date.now(),
    deadline: g.deadline,
    paused: g.paused,
    pausedRemaining: g.pausedRemaining,
    settings: { sets: settings.sets, rounds: settings.rounds, hintMaxLen: settings.hintMaxLen, rankN: settings.rankN },
    setIndex: g.setIndex,
    roundIndex: g.roundIndex,
    liarCount: g.liarIds.length,
    category: IN_SET_PHASES.has(ph) ? g.category : null,
    players: allPlayers().sort(byJoin).map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      spectator: p.spectator,
      inSet: p.inSet,
      out: ph !== 'LOBBY' && p.inSet && !p.alive,
    })),
  };
  if (ph === 'HINT_INPUT') {
    const alive = alivePlayers();
    pub.hintProgress = { submitted: alive.filter((p) => g.hints.get(p.id)?.submitted).length, total: alive.length };
  }
  if (GRID_PHASES.has(ph)) {
    pub.revealAt = g.revealAt;
    pub.grid = g.grid.map((c) => {
      const hidden = g.hidden.has(`${g.roundIndex}:${c.id}`);
      const p = players.get(c.id);
      return { id: c.id, name: c.name, word: hidden ? null : c.word, missing: !c.word, hidden, out: !p || !p.alive };
    });
  }
  if (ph === 'VOTING') {
    const alive = alivePlayers();
    pub.voteProgress = { voted: alive.filter((p) => g.votes.has(p.id)).length, total: alive.length };
  }
  if (ph === 'JUDGING' || ph === 'GUESSING') {
    const cur = g.judgeQueue[g.judgeIdx];
    pub.judge = {
      threshold: g.threshold,
      total: g.judgeQueue.length,
      idx: g.judgeIdx,
      current: cur
        ? { id: cur.id, name: cur.name, votes: cur.votes, revealed: cur.revealed, isLiar: cur.revealed ? cur.isLiar : null }
        : null,
    };
  }
  if (ph === 'GUESSING' && g.guess) {
    const x = g.guess;
    pub.guess = { name: x.name, done: x.done, correct: x.done ? x.correct : null, points: x.done ? x.points : null };
  }
  if (ph === 'ROUND_SETTLE') pub.roundSummary = roundSummary();
  if (ph === 'SET_END') {
    const setRank = ranked(
      allPlayers()
        .filter((p) => p.inSet)
        .map((p) => ({ id: p.id, name: p.name, score: sc.set.get(p.id) || 0 }))
    );
    pub.setSummary = { ...g.setSummary, top: topN(setRank, settings.rankN) };
  }
  if (ph === 'GAME_END') pub.final = { top: topN(totalRanking(sc), settings.rankN) };
  return pub;
}

function privateState(p, sc, rankMap, rankCount) {
  const g = game;
  const ph = g.phase;
  const role = p.inSet && ph !== 'LOBBY' ? p.role : null;
  const h = g.hints.get(p.id);
  const guessing = ph === 'GUESSING' && g.guess?.pid === p.id;
  return {
    me: { id: p.id, name: p.name, spectator: p.spectator, inSet: p.inSet, alive: p.alive, role },
    // 라이어 소켓에는 제시어 데이터 자체를 보내지 않는다.
    keyword: role === 'citizen' && IN_SET_PHASES.has(ph) ? g.keyword : null,
    hint: ph === 'HINT_INPUT' && h ? h.text : '',
    hintSubmitted: ph === 'HINT_INPUT' && !!h?.submitted,
    vote: ph === 'VOTING' ? g.votes.get(p.id) || null : null,
    guessing: guessing && !g.guess.done,
    myGuess: guessing && g.guess.done ? { correct: g.guess.correct, points: g.guess.points } : null,
    score: {
      round: sc.round.get(p.id) || 0,
      set: sc.set.get(p.id) || 0,
      total: sc.total.get(p.id) || 0,
      rank: rankMap.get(p.id) || null,
      of: rankCount,
    },
  };
}

function liarWords(liarId) {
  const g = game;
  const words = g.setWords
    .filter((w) => w.word && w.pid !== liarId && !g.hidden.has(`${w.round}:${w.pid}`))
    .map((w) => ({ round: w.round, word: w.word }));
  if (g.phase === 'HINT_INPUT') {
    for (const [pid, h] of g.hints) {
      if (pid !== liarId && h.submitted && !g.hidden.has(`${g.roundIndex}:${pid}`)) {
        words.push({ round: g.roundIndex, word: h.text });
      }
    }
  }
  return words;
}

function hostState(sc) {
  const g = game;
  const ph = g.phase;
  const hints =
    ph === 'HINT_INPUT'
      ? alivePlayers().sort(byName).map((p) => {
          const h = g.hints.get(p.id);
          return { id: p.id, name: p.name, text: h?.text || '', submitted: !!h?.submitted, hidden: g.hidden.has(`${g.roundIndex}:${p.id}`) };
        })
      : GRID_PHASES.has(ph)
        ? g.grid.map((c) => ({ id: c.id, name: c.name, text: c.word || '', submitted: !!c.word, hidden: g.hidden.has(`${g.roundIndex}:${c.id}`) }))
        : [];
  const tally = new Map();
  for (const t of g.votes.values()) tally.set(t, (tally.get(t) || 0) + 1);
  const transports = { websocket: 0, polling: 0 };
  for (const p of players.values()) if (p.connected && p.transport) transports[p.transport] = (transports[p.transport] || 0) + 1;
  const avg = (ids, m) => {
    const vals = ids.filter((id) => players.has(id)).map((id) => m.get(id) || 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  return {
    roomCode: ROOM_CODE,
    phase: ph,
    settings,
    settingRules: SETTING_RULES,
    locked: ph !== 'LOBBY',
    minPlayers: MIN_PLAYERS,
    startCheck: startCheck(),
    bank,
    secret: IN_SET_PHASES.has(ph)
      ? { keyword: g.keyword, aliases: g.aliases, category: g.category, liars: g.liarIds.map((id) => names.get(id)) }
      : null,
    players: allPlayers().sort(byJoin).map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      transport: p.transport,
      spectator: p.spectator,
      inSet: p.inSet,
      alive: p.alive,
      role: p.role,
      set: sc.set.get(p.id) || 0,
      total: sc.total.get(p.id) || 0,
    })),
    hints,
    votes: [...tally].map(([id, count]) => ({ id, name: names.get(id), count })).sort((a, b) => b.count - a.count),
    voted: g.votes.size,
    guesses: [...g.guesses, ...(g.guess && !g.guess.done ? [g.guess] : [])].map((x) => ({
      pid: x.pid, name: x.name, round: x.round, text: x.text, done: x.done, correct: x.correct, manual: x.manual, points: x.points,
    })),
    balance: g.setHistory.map((h) => {
      const m = sc.bySet.get(h.set) || new Map();
      return { set: h.set, category: h.category, citizenAvg: avg(h.citizenIds, m), liarAvg: avg(h.liarIds, m) };
    }),
    screens: [...screens.values()],
    transports,
  };
}

let broadcastPending = false;
function broadcast() {
  if (broadcastPending) return;
  broadcastPending = true;
  setTimeout(() => {
    broadcastPending = false;
    const sc = scoreTables();
    io.to('pub').emit('state:public', publicState(sc));
    const ranking = totalRanking(sc);
    const rankMap = new Map(ranking.map((e) => [e.id, e.rank]));
    for (const p of players.values()) {
      if (!p.sockets.size) continue;
      const priv = privateState(p, sc, rankMap, ranking.length);
      const isLiar = p.inSet && p.alive && p.role === 'liar' && IN_SET_PHASES.has(game.phase);
      const words = isLiar ? liarWords(p.id) : null;
      for (const sid of p.sockets) {
        io.to(sid).emit('state:private', priv);
        if (words) io.to(sid).emit('liar:hints', words);
      }
    }
    if (io.sockets.adapter.rooms.get('host')?.size) io.to('host').emit('host:state', hostState(sc));
  }, 30);
}

// ─── 소켓 ──────────────────────────────────────────────────────────────────
function reply(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}

function trackTransport(socket, onChange) {
  socket.data.transport = socket.conn.transport.name;
  socket.conn.on('upgrade', (t) => {
    socket.data.transport = t.name;
    onChange();
  });
}

function attach(socket, p) {
  socket.data.pid = p.id;
  p.sockets.add(socket.id);
  p.connected = true;
  p.transport = socket.data.transport;
  socket.join('pub');
}

io.on('connection', (socket) => {
  trackTransport(socket, () => {
    const p = players.get(socket.data.pid);
    if (p) p.transport = socket.data.transport;
    if (screens.has(socket.id)) screens.get(socket.id).transport = socket.data.transport;
    broadcast();
  });

  socket.on('time', (ack) => reply(ack, Date.now()));

  socket.on('join', (data = {}, ack) => {
    const token = typeof data.token === 'string' ? data.token : null;
    if (token && tokenIndex.has(token)) {
      const p = players.get(tokenIndex.get(token));
      attach(socket, p);
      reply(ack, { ok: true, token, id: p.id, name: p.name });
      return broadcast();
    }
    if (token && kickedTokens.has(token)) return reply(ack, { ok: false, kicked: true, error: '사회자에 의해 퇴장되었습니다' });
    if (data.code === undefined && token) return reply(ack, { ok: false, expired: true, error: '다시 입장해 주세요' });
    if (String(data.code || '').trim() !== ROOM_CODE) return reply(ack, { ok: false, error: '방 코드가 틀렸습니다' });
    const name = String(data.name || '').normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!name || [...name].length > 12) return reply(ack, { ok: false, error: '이름은 1~12자로 입력하세요' });
    if (allPlayers().some((p) => norm(p.name) === norm(name))) {
      return reply(ack, { ok: false, error: '이미 사용 중인 이름입니다. 다른 이름을 입력하세요' });
    }
    const p = {
      id: `p${++playerSeq}`,
      seq: playerSeq,
      token: crypto.randomBytes(16).toString('hex'),
      name,
      sockets: new Set(),
      connected: false,
      transport: null,
      spectator: game.phase !== 'LOBBY', // 게임 시작 후 새 입장은 관전자로만
      inSet: false,
      role: null,
      alive: false,
      wasLiar: false,
      played: false,
      caughtRound: null,
    };
    players.set(p.id, p);
    tokenIndex.set(p.token, p.id);
    names.set(p.id, name);
    attach(socket, p);
    reply(ack, { ok: true, token: p.token, id: p.id, name });
    broadcast();
  });

  const playerOn = (ev, fn) =>
    socket.on(ev, (data, ack) => {
      const p = players.get(socket.data.pid);
      if (!p) return reply(ack, { ok: false, error: '입장하지 않았습니다' });
      reply(ack, fn(p, data || {}));
      broadcast();
    });
  playerOn('hint:submit', (p, d) => submitHint(p, d.text, !!d.final));
  playerOn('vote', (p, d) => castVote(p, d.target ?? null));
  playerOn('guess', (p, d) => {
    if (game.phase !== 'GUESSING' || !game.guess || game.guess.done || !inTime()) return { ok: false, error: '입력 시간이 끝났습니다' };
    if (game.guess.pid !== p.id) return { ok: false, error: '제시어를 맞힐 차례가 아닙니다' };
    finishGuess(d.text);
    return { ok: true, correct: game.guess.correct };
  });

  socket.on('screen:hello', (data = {}, ack) => {
    const canAct = data.key === HOST_KEY;
    screens.set(socket.id, { transport: socket.data.transport, canAct });
    socket.data.screen = true;
    socket.data.screenCanAct = canAct;
    socket.join('pub');
    reply(ack, { ok: true, canAct });
    broadcast();
  });
  socket.on('screen:action', (data = {}, ack) => {
    if (!socket.data.screenCanAct) return reply(ack, { ok: false, error: '권한이 없습니다' });
    const r = data.type === 'next' ? stepNext(false) : { ok: false, error: '알 수 없는 동작' };
    reply(ack, r);
    broadcast();
  });

  socket.on('host:hello', (data = {}, ack) => {
    if (data.key !== HOST_KEY) return reply(ack, { ok: false, error: '사회자 키가 틀렸습니다' });
    socket.data.isHost = true;
    socket.join('host');
    socket.join('pub');
    reply(ack, { ok: true });
    broadcast();
  });

  const hostOn = (ev, fn) =>
    socket.on(ev, (data, ack) => {
      if (!socket.data.isHost) return reply(ack, { ok: false, error: '권한이 없습니다' });
      let r;
      try {
        r = fn(data || {}) || { ok: true };
      } catch (err) {
        console.error(err);
        r = { ok: false, error: '서버 오류' };
      }
      reply(ack, r);
      broadcast();
    });
  hostOn('host:settings', (d) => {
    if (game.phase !== 'LOBBY') return { ok: false, error: '게임 중에는 설정을 바꿀 수 없습니다' };
    applySettings(d);
  });
  hostOn('host:start', () => startGame());
  hostOn('host:next', () => stepNext(true));
  hostOn('host:extend', (d) => extendTimer(Math.min(120, Math.max(5, Number(d.sec) || 15))));
  hostOn('host:pause', () => pauseTimer());
  hostOn('host:resume', () => resumeTimer());
  hostOn('host:reset', () => resetToLobby());
  hostOn('host:kick', (d) => kick(d.id));
  hostOn('host:spectator', (d) => {
    const p = players.get(d.id);
    if (!p) return { ok: false, error: '없는 참가자입니다' };
    p.spectator = !!d.spectator;
  });
  hostOn('host:hint:hide', (d) => {
    const key = `${game.roundIndex}:${d.id}`;
    if (d.hidden) game.hidden.add(key);
    else game.hidden.delete(key);
  });
  hostOn('host:guess:set', (d) => {
    const g = game.guesses.find((x) => x.pid === d.pid && x.round === Number(d.round));
    if (!g || !IN_SET_PHASES.has(game.phase)) return { ok: false, error: '이번 세트의 기록이 아닙니다' };
    setGuessCorrect(g, !!d.correct, true);
  });
  hostOn('host:bank:add', (d) => {
    if (!String(d.category || '').trim() || !String(d.word || '').trim()) return { ok: false, error: '카테고리와 제시어를 입력하세요' };
    bank.push(makeBankItem({ category: d.category, word: d.word, aliases: parseAliases(d.aliases) }));
  });
  hostOn('host:bank:remove', (d) => {
    bank = bank.filter((b) => b.id !== d.id);
  });
  hostOn('host:bank:removeCategory', (d) => {
    bank = bank.filter((b) => b.category !== d.category);
  });
  hostOn('host:bank:import', (d) => {
    let added = 0;
    for (const line of String(d.text || '').split(/\r?\n/)) {
      const [category, word, aliases] = line.split('|').map((s) => (s || '').trim());
      if (!category || !word) continue;
      bank.push(makeBankItem({ category, word, aliases: parseAliases(aliases) }));
      added++;
    }
    return { ok: true, added };
  });
  hostOn('host:bank:reset', () => {
    bank = DEFAULT_BANK.map(makeBankItem);
    game.usedBank.clear();
  });

  socket.on('disconnect', () => {
    screens.delete(socket.id);
    const p = players.get(socket.data.pid);
    if (p) {
      p.sockets.delete(socket.id);
      p.connected = p.sockets.size > 0;
    }
    broadcast();
  });
});

server.listen(PORT, () => {
  // Render는 RENDER_EXTERNAL_URL을 자동으로 넣어 준다.
  const base = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  console.log('──────────────────────────────────────────────');
  console.log(` 라이어 게임 서버 실행 중 (port ${PORT})`);
  console.log(` 방 코드   : ${ROOM_CODE}`);
  console.log(` 사회자    : ${base}/host?key=${HOST_KEY}`);
  console.log(` 스크린    : ${base}/screen?key=${HOST_KEY}`);
  console.log(` 참가자    : ${base}/play?code=${ROOM_CODE}`);
  console.log('──────────────────────────────────────────────');
});
