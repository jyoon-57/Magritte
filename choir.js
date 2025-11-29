// choir.js — Step 1: 정적 배치 렌더(애니메이션/박자 연동은 추후)
// 사용 전제: index.html에서 아래처럼 초기화
// Choir.init({
//   canvasId: 'stage',
//   frames: 20,
//   frameW: 786,
//   frameH: 1200,
//   sprites: [
//     { src: './visual_source/mouth.png',  count: 1,  phase: 0.0 },
//     { src: './visual_source/apple.png',  count: 12, phase: 0.0 },
//     { src: './visual_source/pigeon.png', count: 12, phase: 0.0 },
//   ],
//   transportGetter: () => ({ seconds: Tone.Transport.seconds, bpm: Tone.Transport.bpm.value })
// });

let cfg, canvas, ctx;
let images = []; // [mouth, apple, pigeon]
let getTransport = () => ({ seconds: 0, bpm: 120 });

/** 외부(메인)에서 속도/방향을 넘겨받음 */
let signedRate = 1;
export function setSignedRate(v) {
  signedRate = v;
}
let rafId = null;
let lastFrameIndex = 0;

// [opacity] 그룹별 투명도 상태 + LERP 타깃
const opacity = { mouth: 1, apple: 1, pigeon: 1 };
const targetOpacity = { mouth: 1, apple: 1, pigeon: 1 };
const OPACITY_LERP = 0.9; // 보간 정도 (클 수록 타겟에 빨리 가까워짐)

// [opacity] dB(-50~+10) → alpha(0~1) 맵핑: 0dB 이상은 항상 1
function dbToAlpha(db) {
  if (db >= 0) return 1;

  const t = (Number(db) + 50) / 50;
  return Math.max(0, Math.min(1, t));
}

// [opacity] 외부에서 zone+db를 받아 타깃 알파(투명도)를 갱신
export function setZoneDb(zone, db) {
  const z = zone;
  const a = dbToAlpha(db);
  if (z === 'Left') targetOpacity.apple = a; // beat
  if (z === 'Center') targetOpacity.mouth = a; // vocals
  if (z === 'Right') targetOpacity.pigeon = a; // chords
}

function lerpOpacity() {
  opacity.mouth += (targetOpacity.mouth - opacity.mouth) * OPACITY_LERP;
  opacity.apple += (targetOpacity.apple - opacity.apple) * OPACITY_LERP;
  opacity.pigeon += (targetOpacity.pigeon - opacity.pigeon) * OPACITY_LERP;
}

/** 초기화 */
export async function init({
  canvasId = 'stage',
  frames = 20,
  frameW = 786,
  frameH = 1200,
  drawH = 328,
  sprites = [],
  transportGetter,
  subdivision = 0, // ✅ 비트 분할(1=4분, 2=8분, 4=16분...)
}) {
  cfg = { frames, frameW, frameH, drawH, sprites, subdivision };
  getTransport = transportGetter || getTransport;

  canvas = document.getElementById(canvasId);
  ctx = canvas.getContext('2d');

  // 캔버스를 화면 크기(100vw, 100vh)로 맞추고 DPR 스케일링
  function resize() {
    // CSS 사이즈
    canvas.style.width = '100vw';
    canvas.style.height = '100vh';
    const rect = { width: window.innerWidth, height: window.innerHeight };
    // 실제 캔버스 픽셀(레티나 대응)
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 이후 좌표는 CSS px 기준
  }
  resize();
  window.addEventListener('resize', resize);

  // 이미지 로드(먼저 mouth/apple/pigeon 순서로 기대)
  images = await Promise.all(sprites.slice(0, 3).map(loadImage));

  //루프 시작
  if (rafId) cancelAnimationFrame(rafId);
  const loop = () => {
    renderBeatSynced(); //박자 동기 렌더
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

/** 이미지 로더 */
async function loadImage(s) {
  const img = new Image();
  img.decoding = 'async';
  img.src = s.src; // s는 {src, count, phase}
  await img.decode();
  return img;
}

/**    비트→프레임 계산
   - 1비트당 프레임 1칸 전진(요구사항)
   - 재생속도 |signedRate|를 곱해 음원 빨·느려짐을 반영
   - 역재생이면 프레임 진행 방향을 반대로 */
function computeFrameIndex(seconds, bpm) {
  const frames = cfg.frames; //20
  const subdivision = cfg.subdivision;
  const beats =
    seconds * (bpm / 60) * subdivision * Math.max(0, Math.abs(signedRate)); // 누적 비트
  let idx = Math.floor(beats) % frames; //1비트마다 +1 (0~19)
  if (signedRate < 0) {
    idx = (frames - 1 - idx + frames) % frames; //방향 반전
  }
  return idx;
}

/** 한 장면 렌더(박자 동기)
   - Transport가 'started'일 때만 프레임 갱신
   - sx = frameIndex * frameW 로 잘라서 DW×DH로 축소 그리기
   - 배치 규칙: 기존 정적 배치와 동일 */
function renderBeatSynced() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  // 원본 프레임 크기 (스프라이트 시트에서 잘라올 영역)
  const SW = cfg.frameW; // 786
  const SH = cfg.frameH; // 1200
  // 화면 표시 크기: 높이 고정, 너비는 비율로 계산
  const DH = cfg.drawH; // 328 (고정)
  const DW = Math.round((SW * DH) / SH); // ⟵ 786:1200 비율 적용

  // 다운스케일 품질 개선
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // 캔버스 클리어
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // ====== Transport 정보 ======
  const seconds =
    window.Tone?.Transport?.seconds ?? getTransport().seconds ?? 0;
  const bpm = window.Tone?.Transport?.bpm?.value ?? getTransport().bpm ?? 120;
  const state = window.Tone?.Transport?.state || 'stopped';

  // ====== 프레임 인덱스(번호) 결정 ======
  const f =
    state === 'started'
      ? computeFrameIndex(seconds, bpm) //0~19
      : lastFrameIndex; // 일시정지면 마지막 프레임 유지
  lastFrameIndex = f;

  // 소스 잘라낼 좌표 (가로로 20칸 전제)
  const sx = f * SW;
  const sy = 0;

  // ▼ 0) 배경을 칠함
  ctx.globalAlpha = 1; // [opacity] 배경은 항상 불투명
  ctx.fillStyle = '#C54F4F';
  ctx.fillRect(0, 0, W, H);

  // opacity 업데이트
  lerpOpacity();

  // ▼ 1) mouth(중앙 1명): x=가운데, y=화면 높이의 52% 지점 (센터 앵커)
  const mouthImg = images[0];
  const mouthCX = W / 2;
  const mouthCY = H * 0.5;
  const mouthTLX = Math.round(mouthCX - DW / 2);
  const mouthTLY = Math.round(H - 314 - DH);

  ctx.globalAlpha = opacity.mouth;
  drawFrame(mouthImg, sx, sy, SW, SH, mouthTLX, mouthTLY, DW, DH);

  // mouth의 "왼쪽-아래" 꼭짓점 x 좌표(애플 정렬 기준)
  const mouthLeftBottomX = mouthTLX; // 좌상단에서 폭/높이를 알면 좌하단은 (TLX, TLY+FH)

  // ▼ 2) apple(좌측 12명): 3×4, 가로간격 73px, 바닥 39px 띄움
  //    - 가장 아래 줄(그룹1)의 "오른쪽 끝" 사과의 오른쪽-아래 꼭짓점 x = mouthLeftBottomX + 10
  //    - 각 줄은 위로 116px, 왼쪽으로 102px씩 누적 이동
  const appleImg = images[1];
  const GAP_X = 10; // 같은 줄에서 옆 사람과의 가로 간격
  const STEP_X = 102; // 줄이 올라갈 때 왼쪽으로 이동
  const STEP_Y = 125; // 줄이 올라갈 때 위로 이동
  const BOTTOM_OFFSET = 39; // 화면 바닥에서 띄움

  const baseBottomY = H - BOTTOM_OFFSET; // 아래줄 하단 y
  const baseTopY = Math.round(baseBottomY - DH); // 그릴 때는 좌상단 y

  // 아래줄의 오른쪽 끝 사과(기준)의 좌상단 x
  const rightmostBottomRightX = mouthLeftBottomX + 60;
  const rightmostTLX = Math.round(rightmostBottomRightX - DW);

  // 아래줄(그룹1) 3명의 좌상단 x: [왼, 중, 오]  — 폭 + 간격 만큼씩 왼쪽으로 이동 (겹치지 않는 배치)
  const baseXs = [
    rightmostTLX - 2 * (DW + GAP_X),
    rightmostTLX - 1 * (DW + GAP_X),
    rightmostTLX,
  ];

  ctx.globalAlpha = opacity.apple;

  // 4줄 누적 배치
  const appleRects = []; // [{x,y,w,h}]
  for (let row = 3; row >= 0; row--) {
    const rowXShift = -STEP_X * row;
    const rowYShift = -STEP_Y * row;
    for (let col = 0; col < 3; col++) {
      const x = baseXs[col] + rowXShift;
      const y = baseTopY + rowYShift;
      appleRects.push({ x, y, w: DW, h: DH });
      // 그리기(첫 프레임만)
      drawFrame(appleImg, sx, sy, SW, SH, x, y, DW, DH);
    }
  }

  // ▼ 3) pigeon(우측 12명): apple 12명의 좌표를 화면 중앙 y축(= W/2) 기준으로 좌우 대칭
  ctx.globalAlpha = opacity.pigeon;

  const pigeonImg = images[2];
  for (const r of appleRects) {
    const xMirror = Math.round(W - (r.x + r.w)); // 좌우 대칭
    drawFrame(pigeonImg, sx, sy, SW, SH, xMirror, r.y, r.w, r.h);
  }

  // mouth를 가장 위 레이어에 두고 싶다면 마지막에 다시 그려도 됩니다.
  // drawFrame(mouthImg, 0, 0, FW, FH, mouthTLX, mouthTLY, FW, FH);
}

/** 스프라이트 시트의 '첫 프레임' 그리기 (sx=0) */
function drawFrame(img, sx, sy, sw, sh, dx, dy, dw, dh) {
  try {
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  } catch (e) {
    // 이미지 로드 이전 호출 등 안전 가드
  }
}
