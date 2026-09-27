'use strict';

// 리허설용 봇. 입장한 뒤 힌트 입력, 투표, 제시어 맞히기를 알아서 한다.
// 사용법: node scripts/bots.js [인원=24] [서버 주소=http://localhost:3000] [방 코드]
// 방 코드를 생략하면 서버의 /healthz 가 아니라 콘솔에 출력된 코드를 넣어야 한다.

const { io } = require('socket.io-client');

const COUNT = Number(process.argv[2]) || 24;
const URL = process.argv[3] || 'http://localhost:3000';
const CODE = process.argv[4] || process.env.ROOM_CODE || '1234';

const FAMILY = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권', '황'];
const GIVEN = ['민준', '서연', '도윤', '하은', '시우', '지유', '주원', '서윤', '예준', '지아', '하준', '수아', '지호', '채원', '건우', '다은'];
const WORDS = ['맛있다', '빨간색', '여름', '동그랗다', '달콤함', '시원함', '작다', '크다', '바삭', '부드러움', '집', '학교', '여행', '주말', '추억', '친구'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

for (let i = 0; i < COUNT; i++) {
  const name = `${FAMILY[i % FAMILY.length]}${GIVEN[(i * 7) % GIVEN.length]}${i >= FAMILY.length ? i : ''}`.slice(0, 12);
  const s = io(URL);
  let pub = null;
  let priv = null;
  let acted = '';
  const act = () => {
    if (!pub || !priv || !priv.me.inSet || !priv.me.alive) return;
    const key = `${pub.phase}:${pub.setIndex}:${pub.roundIndex}`;
    if (acted === key && !priv.guessing) return;
    if (pub.phase === 'HINT_INPUT') {
      acted = key;
      if (Math.random() < 0.08) return; // 가끔 미제출
      setTimeout(() => s.emit('hint:submit', { text: pick(WORDS), final: true }), 1000 + Math.random() * 8000);
    } else if (pub.phase === 'VOTING' && pub.grid) {
      acted = key;
      const cands = pub.grid.filter((c) => c.id !== priv.me.id && !c.out);
      // 일부 인기 후보에 몰리게 해서 판정 팝업이 나오도록 한다.
      const target = Math.random() < 0.6 ? cands[0] : pick(cands);
      if (target) setTimeout(() => s.emit('vote', { target: target.id }), 500 + Math.random() * 6000);
    } else if (pub.phase === 'GUESSING' && priv.guessing) {
      acted = key;
      setTimeout(() => s.emit('guess', { text: pick(WORDS) }), 2000);
    }
  };
  s.on('state:public', (p) => { pub = p; act(); });
  s.on('state:private', (p) => { priv = p; act(); });
  s.on('connect', () => {
    s.emit('join', { code: CODE, name }, (res) => {
      if (!res.ok) console.log(`${name}: ${res.error}`);
    });
  });
}
console.log(`봇 ${COUNT}명 접속 중 → ${URL} (방 코드 ${CODE}). Ctrl+C로 종료`);
