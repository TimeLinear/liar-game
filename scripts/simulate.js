'use strict';

// 봇 12명으로 게임 한 판(2세트)을 끝까지 돌려 점수 계산과 비밀 유지를 검증한다.
// 사용법: npm run simulate   (?transport=polling 과 같은 조건을 보려면 POLLING=1)

const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3999;
const URL = `http://localhost:${PORT}`;
const KEY = 'simkey';
const CODE = '1234';
const transports = process.env.POLLING ? ['polling'] : ['websocket', 'polling'];

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`);
  if (!cond) failures++;
};
const near = (a, b) => Math.abs(a - b) < 0.01;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));

async function waitFor(fn, label, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = fn();
    if (v) return v;
    await sleep(20);
  }
  throw new Error(`시간 초과: ${label}`);
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, HOST_KEY: KEY, ROOM_CODE: CODE },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => server.stdout.on('data', (d) => d.toString().includes('방 코드') && r()));

  try {
    await run();
  } finally {
    server.kill();
  }
  console.log(failures ? `\n❌ 실패 ${failures}건` : '\n✅ 모든 검증 통과');
  process.exit(failures ? 1 : 0);
}

async function run() {
  // ─── 사회자 ───
  const host = io(URL, { transports });
  let hs = null;
  let pub = null;
  const publicDumps = [];
  host.on('host:state', (s) => (hs = s));
  host.on('state:public', (s) => {
    pub = s;
    publicDumps.push({ phase: s.phase, json: JSON.stringify(s) });
  });
  check((await emit(host, 'host:hello', { key: 'wrong' })).ok === false, '잘못된 사회자 키는 거절');
  check((await emit(host, 'host:hello', { key: KEY })).ok, '사회자 인증');

  // ─── 참가자 12명 ───
  const names = ['가영', '나래', '다온', '라희', '마루', '바다', '사랑', '아름', '자람', '차미', '카이', '타미'];
  const bots = [];
  for (const name of names) {
    const s = io(URL, { transports });
    const bot = { name, s, priv: null, words: [] };
    s.on('state:private', (p) => (bot.priv = p));
    s.on('liar:hints', (w) => (bot.words = w));
    const res = await emit(s, 'join', { code: CODE, name });
    bot.token = res.token;
    bot.id = res.id;
    bots.push(bot);
  }
  check(bots.every((b) => b.id), '12명 입장');
  const dup = io(URL, { transports });
  check((await emit(dup, 'join', { code: CODE, name: '가영' })).ok === false, '이름 중복 입장 거부');
  check((await emit(dup, 'join', { code: '0000', name: '외부인' })).ok === false, '틀린 방 코드 거부');
  dup.close();

  // 재접속: 토큰으로 같은 참가자 복구
  bots[0].s.close();
  await sleep(100);
  const re = io(URL, { transports });
  re.on('state:private', (p) => (bots[0].priv = p));
  re.on('liar:hints', (w) => (bots[0].words = w));
  const rr = await emit(re, 'join', { token: bots[0].token });
  check(rr.ok && rr.id === bots[0].id, '토큰으로 재접속하면 같은 참가자로 복구');
  bots[0].s = re;

  // ─── 설정 & 시작 ───
  await emit(host, 'host:settings', { sets: 2, rounds: 3, liars: 3, thresholdPct: 10, wrongVotePenalty: 10, hintSec: 30 });
  await waitFor(() => hs && hs.settings.sets === 2, '설정 반영');
  check((await emit(host, 'host:start')).ok, '게임 시작');
  await waitFor(() => pub && pub.phase === 'SET_INTRO', 'SET_INTRO');
  check((await emit(host, 'host:settings', { sets: 5 })).ok === false, '게임 중 설정 잠금');

  const byId = (id) => bots.find((b) => b.id === id);
  const next = async (phase) => {
    await emit(host, 'host:next');
    if (phase) await waitFor(() => pub.phase === phase, phase);
    await sleep(60);
  };
  const late = io(URL, { transports });
  const lateRes = await emit(late, 'join', { code: CODE, name: '늦은이' });
  await sleep(80);
  check(lateRes.ok && hs.players.find((p) => p.name === '늦은이').spectator, '게임 시작 후 입장은 관전자');
  late.close();

  const expected = new Map(bots.map((b) => [b.id, 0]));
  const add = (id, v) => expected.set(id, expected.get(id) + v);
  const u = 100 / 3;
  const liarSets = [];

  async function playSet(setNo, plan) {
    await waitFor(() => bots.every((b) => b.priv && b.priv.me.role), '역할 수신');
    const liars = bots.filter((b) => b.priv.me.role === 'liar');
    const citizens = bots.filter((b) => b.priv.me.role === 'citizen');
    liarSets.push(liars.map((b) => b.id));
    liars.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    const keyword = citizens[0].priv.keyword;
    console.log(`\n[SET ${setNo}] 제시어=${keyword} 라이어=${liars.map((b) => b.name).join(',')}`);
    check(liars.length === 3 && citizens.length === 9, '라이어 3명 추첨');
    check(liars.every((b) => b.priv.keyword === null), '라이어 소켓에는 제시어를 보내지 않음');
    check(citizens.every((b) => b.priv.keyword === keyword), '시민은 모두 같은 제시어를 받음');
    if (setNo === 2) check(liars.every((b) => !liarSets[0].includes(b.id)), '비복원 추첨: 1세트 라이어는 2세트에 다시 뽑히지 않음');

    for (let r = 1; ; r++) {
      await next('HINT_INPUT');
      // 힌트 제출
      const rej = await emit(citizens[0].s, 'hint:submit', { text: ` ${keyword} `, final: true });
      check(rej.ok === false, `R${r}: 시민이 제시어를 그대로 입력하면 거부`);
      for (const [i, b] of bots.entries()) {
        if (!b.priv.me.alive) continue;
        if (i % 5 === 4) continue; // 일부는 미제출
        await emit(b.s, 'hint:submit', { text: `힌트${r}-${i}`, final: i % 2 === 0 });
      }
      await sleep(80);
      const liveLiar = liars.find((b) => b.priv.me.alive);
      if (liveLiar) check(liveLiar.words.length > 0, `R${r}: 라이어가 실시간 단어 목록을 받음 (${liveLiar.words.length}개)`);
      await next('HINT_REVEAL');
      check(pub.grid.some((c) => c.missing), `R${r}: 미제출 칸 표시`);
      check(pub.grid.some((c) => c.word && c.word.startsWith('힌트')), `R${r}: 초안 포함 자동 제출`);
      await next('VOTING');

      const votes = plan(r, { liars, citizens });
      for (const [voter, target] of votes) await emit(voter.s, 'vote', { target: target.id });
      const self = await emit(citizens[1].s, 'vote', { target: citizens[1].id });
      check(self.ok === false, `R${r}: 자기 자신 투표 거부`);
      await sleep(60);
      check(!JSON.stringify(pub).includes('"votes"') || pub.phase !== 'VOTING', `R${r}: 투표 중 실시간 득표 비공개`);
      await next('JUDGING');

      // 판정 대기열 처리
      const caughtNow = [];
      const clearedNow = [];
      while (pub.phase === 'JUDGING' || pub.phase === 'GUESSING') {
        const j = pub.judge;
        if (pub.phase === 'JUDGING' && (!j.total || !j.current)) {
          await next('ROUND_SETTLE');
          break;
        }
        if (pub.phase === 'JUDGING' && !j.current.revealed) {
          await next();
          continue;
        }
        if (pub.phase === 'JUDGING' && j.current.isLiar) {
          const liar = byId(j.current.id);
          caughtNow.push(liar);
          await next('GUESSING');
          const guessRight = plan.guess(liar, r);
          await emit(liar.s, 'guess', { text: guessRight ? keyword.split('').join(' ') : '틀린답' });
          await waitFor(() => pub.guess && pub.guess.done, 'guess done');
          check(pub.guess.correct === guessRight, `R${r}: ${liar.name} 제시어 ${guessRight ? '정답' : '오답'} 판정 (공백 무시)`);
          if (guessRight) add(liar.id, (3 - r + 1) * u);
          await next();
          continue;
        }
        if (pub.phase === 'JUDGING') {
          clearedNow.push(byId(j.current.id));
          await next();
          continue;
        }
        await next();
      }
      await waitFor(() => pub.phase === 'ROUND_SETTLE', 'ROUND_SETTLE');
      // 기대 점수 계산
      for (const b of liars) if (b.priv.me.alive) add(b.id, u);
      for (const [voter, target] of votes) {
        if (voter.priv.me.role !== 'citizen') continue;
        if (caughtNow.includes(target)) add(voter.id, 100 / 3);
        else if (clearedNow.includes(target)) add(voter.id, -10);
      }
      console.log(`  R${r}: 검거=${caughtNow.map((b) => b.name).join(',') || '-'} 시민판명=${clearedNow.map((b) => b.name).join(',') || '-'}`);
      await sleep(60);
      if (pub.roundSummary.last) {
        const bonus = (3 - r) * u;
        for (const c of citizens) add(c.id, bonus);
        await next('SET_END');
        check(pub.setSummary.keyword === keyword, `SET ${setNo}: 세트 종료 화면에 제시어 공개`);
        break;
      }
    }
    // 세트가 끝나기 전의 공개 방송에 제시어가 들어간 적이 없는지
    const leaked = publicDumps.filter((d) => d.phase !== 'SET_END' && d.phase !== 'GAME_END' && d.json.includes(`"${keyword}"`));
    check(leaked.length === 0, `SET ${setNo}: 전체 방송에 제시어 미포함`);
    const roleLeak = publicDumps.some((d) => /"role"|"liarIds"|"keyword"(?!":null)/.test(d.json) && d.phase !== 'SET_END');
    check(!roleLeak, `SET ${setNo}: 전체 방송에 역할 정보 미포함`);
    publicDumps.length = 0;
  }

  // SET 1: R1 A 검거·정답, R2 B 검거·오답, R3 아무도 투표 안 함 → C 끝까지 생존
  const plan1 = (r, { liars, citizens }) => {
    if (r === 1) return citizens.map((c) => [c, liars[0]]);
    if (r === 2) return citizens.map((c) => [c, liars[1]]);
    return [];
  };
  plan1.guess = (liar, r) => r === 1;
  await playSet(1, plan1);

  await sleep(80);
  const sc1 = new Map(hs.players.map((p) => [p.id, p.total]));
  check(bots.every((b) => near(sc1.get(b.id), expected.get(b.id))), 'SET 1 점수가 명세대로 계산됨');
  const liars1 = liarSets[0].map((id) => byId(id));
  const l1 = liars1.map((b) => Math.round(sc1.get(b.id)));
  check(l1.every((v) => v === 100 || v === 33), `SET 1 라이어 점수: 정답 100 / 오답 33 / 생존 100 → ${l1.join(', ')}`);

  // SET 2: R1 시민 7명이 라이어 3명에게 3/2/2, 시민 2명과 라이어 3명은 시민 X에게 → 라이어 전원 검거 + X 시민 판명
  await next('SET_INTRO');
  const plan2 = (r, { liars, citizens }) => {
    // 시민 1~6 → 라이어 3명에게 2표씩, 시민 0·7과 라이어 3명 → 시민 8(X)에게 5표, X는 기권
    const x = citizens[8];
    const v = [];
    citizens.slice(1, 7).forEach((c, i) => v.push([c, liars[Math.floor(i / 2)]]));
    v.push([citizens[0], x], [citizens[7], x]);
    liars.forEach((l) => v.push([l, x]));
    return v;
  };
  plan2.guess = () => false;
  await playSet(2, plan2);

  await sleep(80);
  const sc2 = new Map(hs.players.map((p) => [p.id, p.total]));
  const mism = bots.filter((b) => !near(sc2.get(b.id), expected.get(b.id)));
  check(mism.length === 0, `SET 2 누적 점수가 명세대로 계산됨 (조기 종료 보너스, 오투표 감점 포함)${mism.length ? ` 불일치: ${mism.map((b) => `${b.name} ${sc2.get(b.id)}≠${expected.get(b.id)}`).join(' ')}` : ''}`);
  check(hs.balance.length === 2 && hs.balance.every((b) => b.citizenAvg != null && b.liarAvg != null), '사회자 밸런스 표시 (세트별 평균)');

  // 수동 정답 인정
  const g = hs.guesses[0];
  const before = hs.players.find((p) => p.id === g.pid).total;
  await emit(host, 'host:guess:set', { pid: g.pid, round: g.round, correct: true });
  await sleep(80);
  const after = hs.players.find((p) => p.id === g.pid).total;
  check(near(after - before, 100), `사회자 정답 수동 인정 → +${Math.round(after - before)}점`);
  await emit(host, 'host:guess:set', { pid: g.pid, round: g.round, correct: false });
  await sleep(80);
  check(near(hs.players.find((p) => p.id === g.pid).total, before), '사회자 정답 인정 취소 → 원래 점수');

  await next('GAME_END');
  check(pub.final.top.length >= 5, `최종 랭킹 상위 ${pub.final.top.length}명 (동점 포함)`);
  const top = pub.final.top;
  const tiesOk = top.every((e, i) => i === 0 || (Math.abs(e.score - top[i - 1].score) < 1e-6 ? e.rank === top[i - 1].rank : e.rank === i + 1));
  check(tiesOk, '동점자는 공동 순위');
  console.log('\n최종 랭킹:', top.map((e) => `${e.rank}위 ${e.name} ${Math.round(e.score)}`).join(' / '));

  // 강퇴
  await emit(host, 'host:kick', { id: bots[11].id });
  await sleep(80);
  check(!hs.players.some((p) => p.id === bots[11].id), '강퇴된 참가자 목록에서 제거');
  const kickedRe = io(URL, { transports });
  check((await emit(kickedRe, 'join', { token: bots[11].token })).kicked === true, '강퇴된 토큰으로 재입장 불가');
  kickedRe.close();

  host.close();
  for (const b of bots) b.s.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
