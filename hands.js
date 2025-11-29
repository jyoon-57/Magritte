// MediaPipe Tasks Vision (CDN ESM)
import {
  HandLandmarker,
  FilesetResolver,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.7';

// --------------------------- DOM: 비디오 & 오버레이 캔버스 ---------------------------
const videoEl = document.createElement('video');
videoEl.autoplay = true;
videoEl.playsInline = true;
videoEl.muted = true;

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');
Object.assign(canvas.style, {
  position: 'fixed',
  left: '16px',
  bottom: '16px',
  border: '1px solid #333',
  borderRadius: '10px',
  width: '700px',
  height: '480px',
  zIndex: 9999,
  background: 'rgba(0,0,0,0.2)',
});
document.body.appendChild(canvas);

// --------------------------- 설정값(정확도·안정성 튜닝 포인트) ---------------------------
const CFG = {
  maxHands: 2,
  targetFPS: 30, // 감지 호출 상한 (과도한 호출을 줄여 안정화)
  emaAlpha: 0.35, // 랜드마크 좌표 스무딩 강도(0~1, 클수록 최신 프레임 가중)
  minDetConf: 0.7, // 손 검출 신뢰도
  minTrackConf: 0.6, // 트래킹 신뢰도
  minPresenceConf: 0.6, // 손 존재 신뢰도
  pinchNormThreshold: 0.22, // (예시) 엄지-검지 거리 정규화 임계값
  flipHandedness: true, //캠 좌우 반전에 따른 왼손 오른손 반대로 감지 해결

  //볼륨 관련//

  pinchOn: 0.5, // 핀치 판단 기준
  pinchOff: 0.1,

  zoneBands: [0.33, 0.66], // left, center, right 나누기

  volMinDb: -50, // 최소 dB
  volMaxDb: 10, // 최대 dB
  dbPerUnit: 20, // "손 크기 대비" 1.0만큼 이동했을 때 변화시킬 dB 양 (감도)
  moveDeadband: 0.02, // 미세 떨림 무시 (손크기 기준 2% 이하 변화는 무시)

  //정지 재생 관련//

  handPose: {
    // 거리 기반: tip-손바닥중심 거리(손크기 s 로 나눈 값) 기준
    distOpen: 0.48, // 이 이상이면 '펴짐' 쪽
    distClosed: 0.28, // 이 이하면 '쥠' 쪽

    // 각도 기반: (MCP-PIP-TIP) 끼인각(°) 기준, 펼치면 180° 근처
    angleOpen: 160, // 이 이상이면 '펴짐' 쪽
    angleClosed: 80, // 이 이하면 '쥠' 쪽

    // 가중치: 거리 1차, 각도 2차 보정
    wDist: 0.7,
    wAng: 0.3,
  },

  //이전 다음 곡 관련//

  swipe: {
    emaAlpha: 0.35, // 속도 EMA 가중
    vOn: 1.0, // 속도 임계(|vx_ema| > vOn)일 때 ARMING 진입 (/s, 손크기 정규화 기준)
    dMin: 0.4, // ARMING 창에서 누적 수평 변위 임계(손크기 정규화)
    yLimit: 0.75, // 수직 드리프트 허용치(|ΣΔy_norm| <= yLimit)
    armingWindowMs: 180, // ARMING 유지 시간
    cooldownMs: 400, // 트리거 후 쿨다운
    flipDir: false, // 화면 미러여서 좌우 반전 필요하면 true
  },

  //속도 조절 관련//

  yawJog: {
    emaAlpha: 0.45, // 각속도 EMA 가중
    deadbandVel: 0.15, // |ω|가 이보다 작으면 0 처리 (rad/s)
    kVel: 1.0, // 속도 매핑 스케일(감도) (rate = kVel * ω)
    minRate: -2.0, // 최소 속도
    maxRate: 2.0, // 최대 속도
    minRad: 0.12, // 중심(9)→엄지(4) 반경(손크기 정규화) 최소
    flipDir: false, // 시계/반시계가 반대로 느껴지면 true
  },
};

// MediaPipe 기본 본(Connections) — 간결 버전
const CONNECTIONS = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4], // 엄지
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8], // 검지
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12], // 중지
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16], // 약지
  [13, 17],
  [17, 18],
  [18, 19],
  [19, 20], // 새끼
  [0, 17], // 손바닥 대각선 연결(보조)
];

// --------------------------- 상태 ---------------------------
let handLandmarker = null;
let videoReady = false;
let lastInferTs = 0;
let lastFpsTs = 0;
let fps = 0;

// 스무딩용 상태 (왼/오 손 구분)
const smoothState = {
  Left: null, // {landmarks: [{x,y,z}*21]}
  Right: null,
};

// --------------------------- 유틸 ---------------------------
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothLandmarks(prev, curr, alpha) {
  if (!prev) return curr.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 }));
  const out = new Array(curr.length);
  for (let i = 0; i < curr.length; i++) {
    out[i] = {
      x: lerp(prev[i].x, curr[i].x, alpha),
      y: lerp(prev[i].y, curr[i].y, alpha),
      z: lerp(prev[i].z ?? 0, curr[i].z ?? 0, alpha),
    };
  }
  return out;
}

function dist(a, b) {
  const dx = a.x - b.x,
    dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

// 손 크기 정규화용 기준 길이(손목 0 ↔ 중지 기저 9)
function handScale(landmarks) {
  const a = landmarks[0],
    b = landmarks[9];
  return dist(a, b) || 1e-6;
}

// 왼손 오른손 반대로 인식 해결(flip)
function normalizeHanded(handed) {
  if (CFG.flipHandedness) {
    if (handed === 'Left') return 'Right';
    if (handed === 'Right') return 'Left';
  }
  return handed || 'Unknown';
}

// (예시) 핀치(엄지-검지) 정도 0~1 정규화
function pinchNorm(landmarks) {
  const s = handScale(landmarks);
  const d = dist(landmarks[4], landmarks[8]); // 엄지 끝 vs 검지 끝
  // 보통 s 대비 d가 0.2 이하가 ‘가까움’ 느낌 → 0~1로 뒤집어 정규화
  let n = 1 - clamp01(d / (0.6 * s));
  return clamp01(n);
}

// --------------------------- 카메라 ---------------------------
async function initCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 700, height: 480, facingMode: 'user' },
    audio: false,
  });
  videoEl.srcObject = stream;
  await new Promise((res) => (videoEl.onloadedmetadata = res));
  await videoEl.play();
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  videoReady = true;
}

// --------------------------- 모델 초기화 ---------------------------
async function initHandLandmarker() {
  const filesetResolver = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.7/wasm'
  );
  const MODEL_URLS = [
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float32/latest/hand_landmarker.task',
  ];
  let lastErr;
  for (const url of MODEL_URLS) {
    try {
      handLandmarker = await HandLandmarker.createFromOptions(filesetResolver, {
        baseOptions: { modelAssetPath: url },
        numHands: CFG.maxHands,
        runningMode: 'VIDEO',
        minHandDetectionConfidence: CFG.minDetConf,
        minTrackingConfidence: CFG.minTrackConf,
        minHandPresenceConfidence: CFG.minPresenceConf,
      });
      console.log('[hands] model loaded:', url);
      return;
    } catch (err) {
      console.warn('[hands] model load failed, try next:', url, err);
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('No hand_landmarker.task could be loaded.');
}

// --------------------------- 그리기 ---------------------------
function drawHands(results) {
  const { width, height } = canvas;

  // 배경 지우고 비디오 미리보기(선택): *디버그용* — 필요 없으면 주석
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(videoEl, 0, 0, width, height);

  // left, center, right 경계선
  const [b1, b2] = CFG.zoneBands,
    x1 = b1 * canvas.width,
    x2 = b2 * canvas.width;
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath();
  ctx.moveTo(x1, 0);
  ctx.lineTo(x1, canvas.height);
  ctx.moveTo(x2, 0);
  ctx.lineTo(x2, canvas.height);
  ctx.stroke();
  ctx.setLineDash([]);

  // 핸디드니스(왼/오) 별 색상
  const colorMap = { Left: '#ffffff', Right: '#000000ff' };

  // 결과 순회
  const hands = results.landmarks || []; //[{x,y,z}, ...21개], [{x,y,z}, ...21개]]
  const handednesses = results.handednesses || []; //완손 오른손일 확률 정보 ex) [{ categoryName: "Left", score: 0.98, index: 0 }, { categoryName: "Right", score: 0.96, index: 1 }]

  for (let i = 0; i < hands.length; i++) {
    const raw = hands[i]; // [{x:0~1, y:0~1, z:?} * 21]
    const handedRaw = handednesses[i]?.[0]?.categoryName || 'Unknown';
    const handed = normalizeHanded(handedRaw); //왼손 오른손 반전 문제 해결
    const col = colorMap[handed] || '#76FF03';

    // 스무딩
    const prev = smoothState[handed];
    const sm = smoothLandmarks(prev, raw, CFG.emaAlpha);
    smoothState[handed] = sm;

    // 스케일링(정규화→픽셀)
    const pts = sm.map((p) => ({ x: p.x * width, y: p.y * height, z: p.z }));

    // 본(라인) 그리기
    ctx.lineWidth = 2;
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    for (const [a, b] of CONNECTIONS) {
      const p = pts[a];
      const q = pts[b];
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();

    // 랜드마크(점) 그리기
    ctx.globalAlpha = 1;
    for (let j = 0; j < pts.length; j++) {
      const p = pts[j];
      ctx.beginPath();
      ctx.arc(p.x, p.y, j === 0 ? 4 : 3, 0, Math.PI * 2);
      ctx.fillStyle = j === 4 || j === 8 ? '#FF5252' : col;
      ctx.fill();
    }

    //핀치 정도 표기
    const pinch = pinchNorm(sm);
    const cxNorm = handCenterXNorm(sm); //손의 중심의 x좌표 구함 (0~1)

    ctx.fillStyle = col;
    ctx.font = '12px system-ui, Arial';
    ctx.fillText(`${handed} pinch:${pinch.toFixed(2)}`, 10, 18 + i * 16);

    //주먹 판정
    detectHandPose(handed, sm);

    //핀치 판정
    updatePinch(handed, pinch, cxNorm, sm);

    //스와이프 판정
    detectSwipe(handed, sm);

    //회전 속도(조그) 판정
    detectYawJog(handed, sm);
  }
}

// FPS 오버레이
function drawFPS() {
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(canvas.width - 70, 8, 62, 20);
  ctx.fillStyle = '#fff';
  ctx.font = '12px system-ui, Arial';
  ctx.fillText(`${fps.toFixed(0)} fps`, canvas.width - 64, 22);
}

// --------------------------- left/center/right 구하기 ---------------------------
function handCenterXNorm(landmarks) {
  const idx = [0, 5, 9, 13, 17];
  let sum = 0;
  for (let i = 0; i < idx.length; i++) sum += landmarks[idx[i]].x;

  return sum / idx.length;
}

function classifyZoneByXNorm(cxNorm) {
  const b1 = CFG.zoneBands[0];
  const b2 = CFG.zoneBands[1];

  if (cxNorm <= b1) return 'Left';
  if (cxNorm <= b2) return 'Center';
  return 'Right';
}

// --------------------------- pinch on/off ---------------------------
const pinchState = {
  Left: { active: false, lastAt: 0, zoneAtOn: null, lastTipY: null },
  Right: { active: false, lastAt: 0, zoneAtOn: null, lastTipY: null },
};

function updatePinch(handed, pinch, cxNorm, sm) {
  if (handPoseState[handed].label === 'FIST') return; //주먹 쥐고있으면 return
  if (handed === 'Right') {
    const lastOpenAt = handPoseState[handed]?.lastOpenAt || 0;
    if (performance.now() - lastOpenAt < 1000) return; //주먹 펴고 1000ms(1초) 안지났으면 return
  }

  //pinchState가 active이면 볼륨 조절 실행
  if (pinchState[handed]?.active) {
    //핀 손가락이 2개 이하면 핀치 아님
    const scores = computeFingerOpenScores(sm); //0~1의 숫자 5개로 이루어진 배열. ex) {0.1, 0, 1, 1, 0.7}
    const openFlags = scores.map((s) => s >= 0.5);
    const openCount = openFlags.reduce((a, b) => a + (b ? 1 : 0), 0);
    if (openCount <= 2) {
      pinchState[handed].active = false;
      return;
    }
    applyPinchVolume(handed, sm);
  }

  if (!pinchState[handed]) pinchState[handed] = { active: false, lastAt: 0 };
  const S = pinchState[handed];

  if (!S.active && pinch >= CFG.pinchOn) {
    S.active = true;
    S.zoneAtOn = classifyZoneByXNorm(cxNorm);
    S.lastTipY = sm?.[8]?.y ?? null; // ON 순간의 검지 y를 기준점으로 고정

    return;
  }

  if (S.active && pinch <= CFG.pinchOff) {
    S.active = false;
    S.zoneAtOn = null;
    S.lastTipY = null;

    const color = handed === 'Left' ? 'color:#1DBBBB;' : 'color:#000000';

    console.log(`%c${handed} pinch OFF`, color);
  }
}

// --------------------------- Db volume control ---------------------------
const zoneVolumes = { Left: 0, Center: 0, Right: 0 };

function applyPinchVolume(handed, sm) {
  const S = pinchState[handed];
  const tipY = (2 * sm[4].y + sm[8].y) / 3; //엄지 검지 팁 평균 (엄지가 덜 움직이므로 엄지에 힘을 키워서)
  const s = handScale(sm) || 1e-6;

  if (S.lastTipY === null) {
    S.lastTipY = tipY;
    return;
  }

  const dyNorm = (S.lastTipY - tipY) / s; //손 크기 대비 y 이동량

  if (Math.abs(dyNorm) < CFG.moveDeadband) {
    S.lastTipY = tipY;
    return;
  }

  const zone = S.zoneAtOn ?? classifyZoneByXNorm(handCenterXNorm(sm));
  const prev = zoneVolumes[zone];
  const next = Math.max(
    CFG.volMinDb,
    Math.min(CFG.volMaxDb, prev + dyNorm * CFG.dbPerUnit)
  );

  zoneVolumes[zone] = next;

  // 메인 창으로 현재 존과 dB 전송
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(
        { type: 'pinchVolume', zone, db: next },
        '*' // 필요하면 동일 출처만 허용하도록 origin 명시
      );
    }
  } catch (e) {
    console.warn('postMessage failed', e);
  }

  S.lastTipY = tipY;

  const color = handed === 'Left' ? 'color:#1DBBBB;' : 'color:#000000';
  console.log(`%c${handed}hand ${zone} → ${zoneVolumes[zone]}`, color);
}

// --------------------------- fist/open 유틸---------------------------
function palmCenter(lms) {
  const idx = [0, 5, 9, 13, 17];
  let x = 0,
    y = 0;
  for (let i = 0; i < idx.length; i++) {
    x += lms[idx[i]].x;
    y += lms[idx[i]].y;
  }
  return { x: x / idx.length, y: y / idx.length };
}

function angleAt(a, b, c) {
  // 각 b (°)
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const n1 = Math.hypot(v1.x, v1.y) || 1e-6;
  const n2 = Math.hypot(v2.x, v2.y) || 1e-6;
  const cos = (v1.x * v2.x + v1.y * v2.y) / (n1 * n2);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

function map01(v, lo, hi) {
  if (hi === lo) return 0.5;
  const t = (v - lo) / (hi - lo);
  return Math.max(0, Math.min(1, t)); //map01: v가 lo보다 작으면 무조건 0, hi보다 크면 무조건 1 내보내는 함수
}

function computeFingerOpenScores(sm) {
  // Mediapipe 인덱스 체인: [MCP, PIP, TIP] 사용(엄지는 [2,3,4])
  const defs = [
    { m: 2, p: 3, t: 4 }, //Thumb
    { m: 5, p: 6, t: 8 }, // Index
    { m: 9, p: 10, t: 12 }, // Middle
    { m: 13, p: 14, t: 16 }, // Ring
    { m: 17, p: 18, t: 20 }, // Pinky
  ];

  const center = palmCenter(sm);
  const s = handScale(sm) || 1e-6;

  const out = [];
  for (const d of defs) {
    const tip = sm[d.t];
    const distNorm = Math.hypot(tip.x - center.x, tip.y - center.y) / s;
    const distScore = map01(
      distNorm,
      CFG.handPose.distClosed,
      CFG.handPose.distOpen
    );

    const ang = angleAt(sm[d.m], sm[d.p], sm[d.t]); // 펼칠수록 180°로 큼
    const angScore = map01(
      ang,
      CFG.handPose.angleClosed,
      CFG.handPose.angleOpen
    );

    const score = CFG.handPose.wDist * distScore + CFG.handPose.wAng * angScore;
    out.push(score);
  }
  return out; // 길이 5, 각 값 0(굽힘)~1(펴짐)
}

// --------------------------- fist/open 판정---------------------------
const handPoseState = {
  Left: { label: 'YEAH', lastOpenAt: 0 },
  Right: { label: 'OPEN', lastOpenAt: 0 },
};

function detectHandPose(handed, sm) {
  if (handed === 'Left') return; //오른손으로만 노래 정지/재생

  const scores = computeFingerOpenScores(sm); //0~1의 숫자 5개로 이루어진 배열. ex) {0.1, 0, 1, 1, 0.7}
  const openFlags = scores.map((s) => s >= 0.5);
  const openCount = openFlags.reduce((a, b) => a + (b ? 1 : 0), 0);

  const S =
    handPoseState[handed] ||
    (handPoseState[handed] = { label: 'OPEN', lastOpenAt: 0 });
  let nextLabel = S.label;

  // ✅ 즉각 FIST (정확도를 위해 "5개 모두 펴짐"이 아닌 상태에서만 FIST로)
  if (openCount === 0) {
    // 모두 굽힘
    nextLabel = 'FIST';
  } else if (openCount >= 4) {
    // 대부분 펴짐
    nextLabel = 'OPEN';
  }

  if (nextLabel !== S.label) {
    S.label = nextLabel;

    if (S.label === 'FIST') {
      // 메인 창으로 정보 전송
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage({ type: 'fistOpen', state: 'FIST' }, '*');
        }
      } catch (e) {
        console.warn('postMessage failed', e);
      }

      console.log('%cPause', 'color:#FF0000;font-weight:bold;');
    } else if (S.label === 'OPEN') {
      S.lastOpenAt = performance.now();

      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage({ type: 'fistOpen', state: 'OPEN' }, '*');
        }
      } catch (e) {
        console.warn('postMessage failed', e);
      }

      console.log('%cPlay', 'color:#FF0000;font-weight:bold;');
    }
  }

  return S.label;
}

// --------------------------- swipe 판정---------------------------
const swipeState = {
  Right: {
    phase: 'IDLE',
    lastX: null,
    lastY: null,
    lastT: 0,
    vxEma: 0,
    sumDx: 0,
    sumDy: 0,
    armedAt: 0,
    coolUntil: 0,
  },
};

function detectSwipe(handed, sm) {
  if (handed !== 'Right') return;
  const pose = handPoseState?.Right?.label || 'OPEN';
  if (pose === 'FIST') return;
  if (pinchState?.Right?.active) return;

  const s = handScale(sm) || 1e-6;
  const x = (sm[5].x + sm[9].x) / 2;
  const y = (sm[5].y + sm[9].y) / 2;
  const now = performance.now();

  const ST = swipeState.Right;
  if (ST.lastX == null) {
    ST.lastX = x;
    ST.lastY = y;
    ST.lastT = now;
    ST.vxEma = 0;
    return;
  }

  const dt = Math.max(1e-3, (now - ST.lastT) / 1000); // s
  const dx = (x - ST.lastX) / s;
  const dy = (y - ST.lastY) / s;
  const vx = dx / dt;

  const a = CFG.swipe.emaAlpha;
  const vxEma = ST.vxEma === 0 ? vx : ST.vxEma * (1 - a) + vx * a;
  ST.vxEma = vxEma;

  // 상태머신
  // 1) COOLDOWN
  if (ST.phase === 'COOLDOWN') {
    if (now > ST.coolUntil) ST.phase = 'IDLE';
    ST.lastX = x;
    ST.lastY = y;
    ST.lastT = now;
    return;
  }

  // 2) IDLE
  const speedGate = Math.abs(ST.vxEma) > CFG.swipe.vOn;
  if (ST.phase === 'IDLE') {
    if (speedGate) {
      ST.phase = 'ARMING';
      ST.armedAt = now;
      ST.sumDx = 0;
      ST.sumDy = 0;
    }
    ST.lastX = x;
    ST.lastY = y;
    ST.lastT = now;
    return;
  }

  // 2) ARMING
  if (ST.phase === 'ARMING') {
    // 게이트 깨지면 리셋
    if (!speedGate || pose === 'FIST' || pinchState?.Right?.active) {
      ST.phase = 'IDLE';
      ST.lastX = x;
      ST.lastY = y;
      ST.lastT = now;
      return;
    }
    // 누적 변위 업데이트
    ST.sumDx += dx;
    ST.sumDy += dy;

    // 수직 움작임 과하면 리셋
    if (Math.abs(ST.sumDy) > CFG.swipe.yLimit) {
      ST.phase = 'IDLE';
      ST.lastX = x;
      ST.lastY = y;
      ST.lastT = now;
      return;
    }

    // 시간 초과하면 라셋
    if (now - ST.armedAt > CFG.swipe.armingWindowMs) {
      ST.phase = 'IDLE';
      ST.lastX = x;
      ST.lastY = y;
      ST.lastT = now;
      return;
    }

    if (Math.abs(ST.sumDx) >= CFG.swipe.dMin) {
      // 방향 결정
      let dir = ST.sumDx < 0 ? 'LEFT' : 'RIGHT';
      if (CFG.swipe.flipDir) dir = dir === 'LEFT' ? 'RIGHT' : 'LEFT';
      if (dir === 'LEFT') {
        console.log('%cNext Track', 'color:#4CAF50;font-weight:bold;');
      } else {
        console.log('%cPrevious Track', 'color:#FF9800;font-weight:bold;');
      }

      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(
            {
              type: 'swipe',
              value: dir === 'LEFT' ? 'nextTrack' : 'previousTrack',
            },
            '*'
          );
        }
      } catch (e) {
        console.warn('postMessage failed', e);
      }

      // 쿨다운 진입
      ST.phase = 'COOLDOWN';
      ST.coolUntil = now + CFG.swipe.cooldownMs;
      ST.sumDx = ST.sumDy = 0;
      ST.lastX = x;
      ST.lastY = y;
      ST.lastT = now;
      return;
    }
    // 계속 ARMING 유지
    ST.lastX = x;
    ST.lastY = y;
    ST.lastT = now;
  }
}

// --------------------------- yaw jog 판정---------------------------
function wrapPi(a) {
  // 유틸. 항상-π ~ π 로 범위 제한. 179도에서 2도 움직였는데 -179가 되는 문제 해결. -179-179+360=2
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

const yawJogState = {
  Right: { active: false, lastTheta: null, lastT: 0, velEma: 0, offSince: 0 },
};

let shakaing = false;

function detectYawJog(handed, sm) {
  if (handed !== 'Right') return;
  if (pinchState?.Right?.active) return; // 핀치 중이면 배제

  // 샤카 게이트: 엄지/새끼 펴짐, 나머지 3개 접힘
  const scores = computeFingerOpenScores(sm); // [Thumb, Index, Middle, Ring, Pinky]
  const open = scores.map((s) => s >= 0.5);
  const shaka = open[0] && open[4] && !open[1] && !open[2] && !open[3];

  if (!shaka) {
    // 게이트 해제 시 상태만 정리
    const ST = yawJogState.Right;
    // 기준 재설정(점프 방지)
    const c = sm[9],
      v = { x: sm[4].x - c.x, y: sm[4].y - c.y };
    ST.lastTheta = Math.atan2(v.y, v.x);
    ST.lastT = performance.now();
    ST.velEma = 0;
    ST.offSince = 0;

    if (shakaing === true) {
      // 메인 창으로 정보 전송
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage({ type: 'noMoreShaka' }, '*');
        }
      } catch (e) {
        console.warn('postMessage failed', e);
      }
    }
    ST.active = false;
    shakaing = false;
    return;
  }

  // 중심(중지 MCP=9)과 엄지 TIP=4
  const c = sm[9];
  const v = { x: sm[4].x - c.x, y: sm[4].y - c.y };
  const s = handScale(sm) || 1e-6;
  const rNorm = Math.hypot(v.x, v.y) / s;
  if (rNorm < CFG.yawJog.minRad) return; // 엄지가 충분히 펼쳐지지 않으면 무시

  const theta = Math.atan2(v.y, v.x);
  const now = performance.now();
  const ST = yawJogState.Right;

  if (ST.lastTheta == null) {
    ST.lastTheta = theta;
    ST.lastT = now;
    ST.velEma = 0;
    return;
  }

  const dt = Math.max(1e-3, (now - ST.lastT) / 1000); // seconds
  const dth = wrapPi(theta - ST.lastTheta);
  let omega = dth / dt; //각속도 rad/s (반시계 +, 시계 -)
  if (CFG.yawJog.flipDir) omega = -omega; // 방향 뒤집기 옵션

  // 각속도 EMA
  const a = CFG.yawJog.emaAlpha;
  ST.velEma = ST.velEma === 0 ? omega : ST.velEma * (1 - a) + omega * a;

  // 데드밴드 & 속도 맵핑
  let rate =
    Math.abs(ST.velEma) < CFG.yawJog.deadbandVel
      ? 0
      : CFG.yawJog.kVel * ST.velEma;
  rate = Math.max(CFG.yawJog.minRate, Math.min(CFG.yawJog.maxRate, rate)); //속도

  shakaing = true;

  // 출력(연결 전이므로 콘솔 + 이벤트)
  if (rate !== 0) {
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(
          { type: 'shaka', value: rate },
          '*' // 필요하면 동일 출처만 허용하도록 origin 명시
        );
      }
    } catch (e) {
      console.warn('postMessage failed', e);
    }
    console.log(
      `%cJog rate: ${rate.toFixed(2)}x`,
      'color:#03A9F4;font-weight:bold;'
    );
  }

  // 기준 업데이트
  ST.lastTheta = theta;
  ST.lastT = now;
}

// --------------------------- 메인 루프 ---------------------------
let _processing = false;
let _lastTs = 0;

function loop() {
  // FPS 제한 (wall-clock 기반)
  const minDt = 1000 / CFG.targetFPS;
  const t = performance.now();
  if (t - lastInferTs < minDt) {
    requestAnimationFrame(loop);
    return;
  }
  // 단조 증가 보장 (동일/역행 시 +1ms)
  const nowMs = t <= _lastTs ? _lastTs + 1 : Math.floor(t);
  _lastTs = nowMs;
  lastInferTs = t;

  if (_processing) {
    requestAnimationFrame(loop);
    return;
  }
  _processing = true;

  if (videoReady && handLandmarker) {
    const result = handLandmarker.detectForVideo(videoEl, nowMs);
    if (result && result.landmarks?.length) {
      drawHands(result);
    } else {
      // 검출 실패 시 캔버스만 비우기/비디오만 표시
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    }
  }

  // FPS 계산 (뭐가 잘못됨)
  if (nowMs - lastFpsTs >= 250) {
    // 대략적 프레임율 추정(타깃 기준)
    fps = 1000 / Math.max(1, nowMs - lastInferTs);
    lastFpsTs = nowMs;
  }
  drawFPS();
  _processing = false;
  requestAnimationFrame(loop);
}

window.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    _lastTs = Math.floor(performance.now());
  }
});

// --------------------------- 시작 ---------------------------
(async () => {
  try {
    await initCamera();
    await initHandLandmarker();
    // (선택) 워밍업 한 번
    handLandmarker.detectForVideo(videoEl, performance.now());
    requestAnimationFrame(loop);
  } catch (err) {
    console.error('Hand tracking init error:', err);
    const warn = document.createElement('div');
    warn.textContent =
      '웹캠/모델 초기화 실패: 브라우저 카메라 권한과 네트워크(모델 다운로드)를 확인하세요.';
    Object.assign(warn.style, {
      position: 'fixed',
      left: '16px',
      bottom: '16px',
      background: '#222',
      color: '#fff',
      padding: '10px 12px',
      borderRadius: '8px',
      zIndex: 9999,
    });
    document.body.appendChild(warn);
  }
})();
