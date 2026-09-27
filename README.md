# 대규모 라이어 게임

20~30명이 한 강의실에서 함께 하는 라이어 게임 웹앱입니다. 명세는 [SPEC.md](SPEC.md)에 있습니다.

| 화면 | 주소 | 용도 |
| --- | --- | --- |
| 스크린 | `/screen?key=사회자키` | 프로젝터. 공개 정보와 진행 버튼(투표 시작, 판정 공개, 다음)만 표시 |
| 사회자 | `/host?key=사회자키` | 설정, 제시어 뱅크, 강제 진행, 강퇴, 힌트 가리기, 정답 수동 인정, 밸런스 |
| 참가자 | `/play?code=방코드` | 스마트폰. 스크린의 QR 코드로 접속 |

`/screen`을 키 없이 열면 버튼 없는 보기 전용 화면이 됩니다.

## 로컬 실행

```bash
npm install
npm start
```

콘솔에 방 코드와 사회자·스크린 주소(사회자 키 포함)가 출력됩니다.

환경 변수:

| 변수 | 설명 | 기본값 |
| --- | --- | --- |
| `PORT` | 포트 | 3000 |
| `HOST_KEY` | 사회자 키 (스크린 버튼에도 필요) | 서버 시작 시 무작위 |
| `ROOM_CODE` | 4자리 방 코드 | 서버 시작 시 무작위 |
| `PUBLIC_URL` | 콘솔에 찍을 공개 주소 (예: `https://liar.onrender.com`) | `http://localhost:PORT` |
| `MIN_PLAYERS` | 시작 최소 인원 (테스트용으로만 낮추기) | 4 |

배포할 때는 `HOST_KEY`를 직접 정해 두면 서버가 재시작돼도 사회자 주소가 바뀌지 않습니다.

## 테스트

```bash
npm run simulate
```

봇 12명으로 2세트짜리 게임을 끝까지 진행하면서 점수 계산, 비복원 추첨, 비밀 유지(전체 방송에 제시어·역할 미포함), 재접속, 강퇴, 수동 정답 인정을 검증합니다. `POLLING=1 npm run simulate`로 WebSocket 없이 롱폴링만으로도 돌려 볼 수 있습니다.

리허설용 봇으로 방을 채우려면 서버를 켠 상태에서:

```bash
node scripts/bots.js 24 http://localhost:3000 1234
```

(인원, 서버 주소, 방 코드 순서)

브라우저에서 WebSocket이 막힌 강의실을 흉내 내려면 주소 뒤에 `&transport=polling`을 붙입니다. 사회자 화면의 "연결 진단"에서 연결 방식을 확인할 수 있습니다. 한 브라우저에서 참가자 여러 명을 띄울 때는 `/play?code=1234&slot=2`처럼 `slot`을 다르게 주면 토큰이 섞이지 않습니다.

## 배포 (예: Render)

1. 이 폴더를 GitHub 저장소에 올립니다.
2. Render → New → Web Service → 저장소 선택.
3. Build Command `npm install`, Start Command `npm start`.
4. Environment에 `HOST_KEY`, `ROOM_CODE`, `PUBLIC_URL`을 넣습니다.
5. HTTPS는 자동입니다. 상태는 메모리에만 있으므로 인스턴스는 1개로 둡니다.

## 게임 당일 체크리스트

- 시작 10분 전에 스크린 페이지를 열어 서버를 깨워 둡니다 (무료 호스팅은 잠들 수 있음).
- 사회자 화면의 연결 진단에서 스크린 연결 방식을 확인합니다. polling이어도 그대로 진행합니다.
- 강의실 PC에서 접속이 안 되면 사회자 노트북을 폰 테더링으로 연결하고 HDMI로 프로젝터에 연결합니다.
- 스크린 창에서는 스페이스바/엔터/→ 키로도 "다음"을 누를 수 있습니다.

## 구조

```
server.js          게임 상태, 타이머, 판정, 점수, 소켓 이벤트 (Express + Socket.IO)
wordbank.js        기본 제시어 뱅크 (8개 카테고리, 112개)
public/common.*    공용 연결·서버 시각 보정·꾹 누르기 처리, 공용 스타일
public/screen.*    프로젝터 화면
public/host.*      사회자 화면
public/play.*      참가자 화면
scripts/           시뮬레이션 테스트, 리허설 봇
```
