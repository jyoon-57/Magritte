// main.js
//-----------------------------카메라 팝업 열기-----------------------------------------//
const CAMERA_URL = 'camera.html';
let cameraWin = null;

function openCameraWindow(auto = true) {
  // 창 크기/위치 지정 (메인 창 기준 가운데)
  const w = 760,
    h = 520;
  const dualScreenLeft = window.screenLeft ?? window.screenX ?? 0;
  const dualScreenTop = window.screenTop ?? window.screenY ?? 0;
  const width = window.outerWidth ?? window.innerWidth;
  const height = window.outerHeight ?? window.innerHeight;
  const left = dualScreenLeft + Math.max(0, (width - w) / 2);
  const top = dualScreenTop + Math.max(0, (height - h) / 2);

  // 같은 이름을 쓰면 이미 열린 창을 재사용함
  const features = [
    `width=${w}`,
    `height=${h}`,
    `left=${left}`,
    `top=${top}`,
    'menubar=no',
    'toolbar=no',
    'location=no',
    'status=no',
    'resizable=yes',
    'scrollbars=no',
  ].join(',');

  // 이미 있으면 포커스
  if (cameraWin && !cameraWin.closed) {
    cameraWin.focus();
    return true;
  }

  cameraWin = window.open(CAMERA_URL, 'cameraWin', features);

  // 팝업 차단 처리
  if (!cameraWin) {
    if (auto) {
      console.warn('팝업이 차단되어 자동으로 열 수 없습니다.');
      // 필요하면 화면에 버튼을 만들어 노출
      ensureCameraButton();
    }
    return false;
  }

  cameraWin.focus();
  return true;
}

// 자동 오픈 (페이지 로드 시 한 번)
window.addEventListener('load', () => {
  openCameraWindow(true);
});

// 사용자가 수동으로 다시 열 수 있는 버튼(팝업 차단 대비)
function ensureCameraButton() {
  if (document.querySelector('#open-camera-window')) return;
  const btn = document.createElement('button');
  btn.id = 'open-camera-window';
  btn.textContent = 'Open Camera Window';
  btn.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999';
  btn.addEventListener('click', () => openCameraWindow(false));
  document.body.appendChild(btn);
}

// 메인 창이 닫힐 때 카메라 창도 함께 정리(선택)
window.addEventListener('beforeunload', () => {
  try {
    if (cameraWin && !cameraWin.closed) cameraWin.close();
  } catch {}
});

//-----------------------------클릭 투 언락 오디오-----------------------------------------//
// === Audio Unlock Overlay ===
(() => {
  const overlay = document.getElementById('audio-unlock');
  if (!overlay) return;

  // 이미 컨텍스트가 열려있다면 즉시 제거
  try {
    if (Tone.context && Tone.context.state === 'running') {
      overlay.remove();
      return;
    }
  } catch (_) {}

  const unlock = async () => {
    try {
      await Tone.start(); // 사용자 제스처 안에서 호출
      console.log('[audio] unlocked');
    } catch (e) {
      console.warn('Audio unlock failed', e);
    } finally {
      overlay.classList.add('hide'); // 부드럽게 페이드아웃
      setTimeout(() => overlay.remove(), 240);
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    }
  };

  // 화면 아무 데나 클릭/터치, 또는 키 입력으로 언락
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
})();

// ----------------------------------- 1) 플레이어 & 볼륨 노드 구성 -------------------------------------------------//
// === 재생 가능한 트랙 목록 ===
const TRACKS = [
  'Astrid-S_I_Dont_Know_Why',
  'Panda-Bear_Hyukoh',
  'Patti-Smith_Gloria',
  'River_Kang',
];
let currentTrackIndex = 0;

const players = {
  beat: {
    url: 'music/Astrid-S_I_Dont_Know_Why/beat.mp3',
    player: null,
    volume: null,
    volEl: null,
    volValEl: null,
  },
  chords: {
    url: 'music/Astrid-S_I_Dont_Know_Why/chords.mp3',
    player: null,
    volume: null,
    volEl: null,
    volValEl: null,
  },
  vocals: {
    url: 'music/Astrid-S_I_Dont_Know_Why/vocals.mp3',
    player: null,
    volume: null,
    volEl: null,
    volValEl: null,
  },
};

// ui 표시용 메타데이터
const TRACK_META = {
  'Astrid-S_I_Dont_Know_Why': { title: "I don't know why", artist: 'Astrid S' },
  'Panda-Bear_Hyukoh': { title: 'Panda Bear', artist: '혁오' },
  'Patti-Smith_Gloria': { title: 'Gloria', artist: 'Patti Smith' },
  River_Kang: { title: '강의 위로', artist: '강태구' },
};

// ui Now Playing 요소
const titleEl = document.getElementById('np-title');
const artistEl = document.getElementById('np-artist');

const $ = (sel) => document.querySelector(sel);

// UI 참조
const btnPlay = $('#btnPlay') || null;
const btnPause = $('#btnPause') || null;
const speedEl = $('#speed') || {
  min: '-4',
  max: '4',
  step: '0.005',
  value: '1.0',
};
const speedVal = $('#speedVal') || null;

// 채널 UI 바인드
players.beat.volEl = $('#beatVol') || null;
players.beat.volValEl = $('#beatVolVal') || null;

players.chords.volEl = $('#chordsVol') || null;
players.chords.volValEl = $('#chordsVolVal') || null;

players.vocals.volEl = $('#vocalsVol') || null;
players.vocals.volValEl = $('#vocalsVolVal') || null;

// 재생 진행 정도 바 (progress bar)
const progressEl = document.getElementById('progress');
const progressFillEl = progressEl?.querySelector('.progress-fill');

// ====== 2) Tone.js 세팅 ======
Tone.context.lookAhead = 0.1; // 안정적 스타트
Tone.Transport.seconds = 0;
Tone.Transport.bpm.value = 120; // 참고값 (Player는 Transport에 sync해서 시간 기준만 공유)

// dB 숫자 → 표시 보조
const fmtDb = (v) => `${Number(v).toFixed(0)} dB`;

// ====== 3) 플레이어 생성 & 연결 ======
async function setup() {
  // 각 스템: Player → Volume(dB) → Destination
  for (const key of Object.keys(players)) {
    const p = players[key];
    p.volume = new Tone.Volume(0).toDestination();

    p.player = new Tone.Player({
      url: p.url,
      autostart: false,
      loop: true,
      fadeIn: 0.01,
      fadeOut: 0.01,
    }).connect(p.volume);

    // Transport와 동기화: 0초부터 루프로 같이 돈다
    p.player.sync().start(0);

    // 초기 표시
    if (p.volValEl) p.volValEl.textContent = fmtDb(p.volEl?.value ?? 0);
    p.volume.volume.value = Number(p.volEl?.value ?? 0);
  }

  //--------------- hand.js에서 받아온 값 사용해 볼륨 조절---------------------//
  if (!window.__pinchListenerAdded) {
    window.__pinchListenerAdded = true;

    // hands.js(카메라 창) → pinchVolume 메시지 수신
    window.addEventListener('message', (ev) => {
      const data = ev.data || {}; //{ type: 'pinchVolume', zone, db: next }
      if (data.type !== 'pinchVolume') return;

      const { zone, db } = data;

      // Left → beat, Center → vocals, Right → chords
      const zoneToKey = { Left: 'beat', Center: 'vocals', Right: 'chords' };
      const key = zoneToKey[zone];
      if (!key || !players[key] || !players[key].volume) return;

      const p = players[key];

      // 실제 오디오 볼륨(dB) 반영
      p.volume.volume.value = Number(db);

      // UI가 있을 때만 동기화
      if (p.volEl) p.volEl.value = String(db);
      if (p.volValEl) p.volValEl.textContent = fmtDb(db);

      // UI 투명도에 반영하기 위해 정보 전송
      window.CHOIR?.setZoneDb?.(zone, db);
    });
  }

  // ====== 음/양수 지원 스크래치(속도 조절) → 자연 복귀 ======
  const GLIDE_MS = 900; // 전체 글라이드 시간 (턴테이블 감성은 800~1500ms)
  const MIN_ABS_RATE = 0.001; // 0 대신 아주 작은 양수(엔진 안전)
  const MAX_ABS_RATE = 4;
  const SHAKA_RESUME_THRESHOLD = 0.2; // 이 이상일 때만 글라이드 중단
  const SHAKA_IGNORE_COOLDOWN_MS = 250;
  let glideRAF = null;
  let currentSignedRate = Number(speedEl?.value) || 1;
  let gliding = false;
  let shakaIgnoreUntil = 0;
  let autoPlayTimer = null;

  //슬라이더 바 자동 이동 관련 상수
  const SLIDER_MIN = Number.isFinite(parseFloat(speedEl?.min))
    ? parseFloat(speedEl.min)
    : -4;
  const SLIDER_MAX = Number.isFinite(parseFloat(speedEl?.max))
    ? parseFloat(speedEl.max)
    : 4;
  const clampToSlider = (v) => Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, v));

  // 유틸
  const clampAbs = (x) =>
    Math.min(MAX_ABS_RATE, Math.max(MIN_ABS_RATE, Math.abs(x)));
  const signOf = (x) => (x < 0 ? -1 : 1);

  // 실제 플레이어에 적용: 부호는 reverse, 크기는 playbackRate(양수)
  function applySignedRate(signedRate) {
    currentSignedRate = signedRate;
    const s = signOf(signedRate);
    const abs = clampAbs(signedRate);

    // UI 갱신(부호 유지해서 표시)
    const display = (s < 0 ? '-' : '') + abs.toFixed(2) + '×';
    if (speedVal) speedVal.textContent = display;

    // 슬라이더에 값 반영
    const signedForSlider = clampToSlider(s * abs);
    if (speedEl && speedEl.tagName) speedEl.value = String(signedForSlider);

    for (const key of Object.keys(players)) {
      const p = players[key];
      if (!p.player) continue;
      // 방향 전환
      p.player.reverse = s < 0;
      // 속도(양수)
      p.player.playbackRate = abs;
    }

    if (window.CHOIR?.setSignedRate) window.CHOIR.setSignedRate(signedRate); // ✅ 애니가 현재 음악 속도/방향을 따라가도록 전달
  }

  // rAF 중단
  function cancelGlide() {
    if (glideRAF !== null) {
      cancelAnimationFrame(glideRAF);
      glideRAF = null;
    }
    gliding = false;
  }

  // 0 교차를 매끄럽게: 두 단계 글라이드
  //  - 같은 부호끼리는 단일 글라이드
  //  - 부호가 다르면: (from → 부호유지*MIN) → reverse flip → (부호목표*MIN → target)
  function glideToSigned(targetSigned, totalDuration = GLIDE_MS) {
    cancelGlide();
    gliding = true;

    const from = currentSignedRate;
    const to = targetSigned;

    const sameSign = Math.sign(from || 1) === Math.sign(to || 1); //ture 또는 false
    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

    if (sameSign) {
      // === 단일 단계 ===
      const start = performance.now();
      const tick = (now) => {
        const t = Math.min(1, (now - start) / totalDuration);
        const v = from + (to - from) * easeOutCubic(t);
        applySignedRate(v);
        if (t < 1) glideRAF = requestAnimationFrame(tick);
        else (glideRAF = null), applySignedRate(to);
      };
      glideRAF = requestAnimationFrame(tick);
      return;
    } else (glideRAF = null), applySignedRate(to), (gliding = false);

    // === 두 단계 ===
    // 단계1: 현 부호 유지하며 |rate| → MIN_ABS_RATE 로 감속
    // 단계2: 부호 뒤집고 MIN에서 target까지 가속
    const phase1Dur = Math.max(120, totalDuration * 0.35); // 감속 비중
    const phase2Dur = totalDuration - phase1Dur;

    const fromSign = signOf(from);
    const toSign = signOf(to);

    const p1Start = performance.now();
    const p1From = from;
    const p1To = fromSign * MIN_ABS_RATE;

    const runPhase2 = () => {
      // 부호 전환 직전 살짝 완충을 주고 싶다면, 여기서 잠깐 볼륨 -6~-12dB 로 내려도 됨
      const p2Start = performance.now();
      const p2From = toSign * MIN_ABS_RATE;
      const p2To = to;

      const tick2 = (now) => {
        const t = Math.min(1, (now - p2Start) / phase2Dur);
        const v = p2From + (p2To - p2From) * easeOutCubic(t);
        applySignedRate(v);
        if (t < 1) glideRAF = requestAnimationFrame(tick2);
        else (glideRAF = null), applySignedRate(p2To), (gliding = false);
      };

      // 방향 플립 시점: MIN 근처에서 flip
      applySignedRate(toSign * MIN_ABS_RATE); // 이 호출이 reverse 토글을 유발
      glideRAF = requestAnimationFrame(tick2);
    };

    const tick1 = (now) => {
      const t = Math.min(1, (now - p1Start) / phase1Dur);
      const v = p1From + (p1To - p1From) * easeOutCubic(t);
      applySignedRate(v);
      if (t < 1) {
        glideRAF = requestAnimationFrame(tick1);
      } else {
        runPhase2();
      }
    };

    glideRAF = requestAnimationFrame(tick1);
  }

  // 드래그 중: 즉시 반영(음/양수 모두), 진행 중 글라이드 중단
  if (!window.__shakaListenerAdded) {
    window.__shakaListenerAdded = true;

    window.addEventListener('message', async (ev) => {
      const data = ev.data || {};
      if (data.type !== 'shaka') return;

      const signed = Number(data.value);
      if (!Number.isFinite(signed)) return;

      const now = performance.now();

      // noMoreShaka 직후 짧은 쿨다운 동안 약한 신호는 무시
      if (now < shakaIgnoreUntil && Math.abs(signed) < SHAKA_RESUME_THRESHOLD) {
        return;
      }

      // 글라이드 중이라면 충분히 큰 신호만 글라이드 중단
      if (gliding && Math.abs(signed) < SHAKA_RESUME_THRESHOLD) {
        return;
      }

      cancelGlide();
      applySignedRate(signed);
    });
  }
  // speedEl.addEventListener('input', () => {
  //   cancelGlide();
  //   const signed = Number(speedEl.value);
  //   applySignedRate(Number.isFinite(signed) ? signed : 1);
  // });

  // 드래그 시작/끝: 끝나면 +1.0으로 자연 복귀
  if (!window.__noMoreShakaListenerAdded) {
    window.__noMoreShakaListenerAdded = true;

    window.addEventListener('message', async (ev) => {
      const data = ev.data || {}; //{ type: 'noMoreShaka'}
      if (data.type !== 'noMoreShaka') return;

      shakaIgnoreUntil = performance.now() + SHAKA_IGNORE_COOLDOWN_MS;
      glideToSigned(1.0);
    });
  }
  // speedEl.addEventListener('pointerdown', () => {
  //   cancelGlide();
  //   const endEvents = ['pointerup', 'pointercancel'];
  //   const onEnd = () => glideToSigned(1.0);
  //   for (const ev of endEvents) {
  //     window.addEventListener(ev, onEnd, { once: true });
  //   }
  // });

  // 초기화
  applySignedRate(Number(speedEl.value) || 1);
  window.__playersReady = true;

  //=================== 다음 곡/이전 곡 ===================//
  async function setTrackByIndex(newIndex) {
    //인덱스 래핑
    const L = TRACKS.length;
    currentTrackIndex = ((newIndex % L) + L) % L; //012 중 하나(track 길이가 3이므로)
    updateNowPlaying(); //ui 업데이트
    const base = `music/${TRACKS[currentTrackIndex]}`;

    // 재생 중이라도 잠시 멈춰서 글리치 방지
    try {
      Tone.Transport.pause();
      Tone.Transport.seconds = 0; //노래 처음부터 시작되도록
    } catch (_) {}

    // 기존 타이머가 있으면 정리
    if (autoPlayTimer) {
      clearTimeout(autoPlayTimer);
      autoPlayTimer = null;
    }

    // 3개 stem URL 갱신 + Player에 로드
    const loadTasks = [];
    for (const key of Object.keys(players)) {
      const p = players[key];
      const newUrl = `${base}/${key}.mp3`;
      p.url = newUrl;
      if (p.player) {
        loadTasks.push(p.player.load(newUrl));
      }
    }

    // 모두 로딩 완료 대기
    try {
      await Promise.all(loadTasks);
    } catch (e) {
      console.warn('[tracks] load failed:', e);
    }

    // 로드 끝나도 혹시 모를 드리프트 방지로 한 번 더 0으로 고정
    try {
      Tone.Transport.seconds = 0;
    } catch (_) {}

    // 현재 속도/방향 유지 보정 (선택: 안전하게 한 번 더 적용)
    applySignedRate(currentSignedRate);

    // ✅ 1초 뒤 자동 재생
    autoPlayTimer = setTimeout(() => {
      try {
        // 일정한 동기화를 위해 약간의 딜레이로 스타트
        Tone.Transport.start('+0.05');
      } catch (e) {
        console.warn('Transport start failed:', e);
      }
    }, 0);
  }

  // === hands.js에서 오는 swipe 메시지 수신 ===
  if (!window.__swipeListenerAdded) {
    window.__swipeListenerAdded = true;

    window.addEventListener('message', async (ev) => {
      const data = ev.data || {};
      if (data.type !== 'swipe') return;
      if (!window.__playersReady) return;

      // nextTrack / previousTrack 이외 값은 무시
      const v = data.value;
      if (v !== 'nextTrack' && v !== 'previousTrack') return;

      const delta = v === 'nextTrack' ? 1 : -1;
      const newIndex = currentTrackIndex + delta;
      await setTrackByIndex(newIndex);
    });
  }

  updateNowPlaying();
}

// ====== 4) 트랜스포트 제어 ======
if (!window.__fistListenerAdded) {
  window.__fistListenerAdded = true;

  window.addEventListener('message', async (ev) => {
    const data = ev.data || {}; //{ type: 'fistOpen', state: 'FIST' }
    if (data.type !== 'fistOpen') return;
    if (!window.__playersReady) return;

    // 모든 파일 로딩 완료 대기 (캐시에 있으면 바로 통과)
    await Tone.loaded();

    // 플레이어 준비 여부 가드(초기화 전에 오는 메시지 무시)
    if (
      !players.beat.player ||
      !players.chords.player ||
      !players.vocals.player
    )
      return;

    const state = data.state;

    if (state === 'FIST') {
      Tone.Transport.pause();
    }

    if (state === 'OPEN') {
      Tone.Transport.start('+0.05'); // 50ms 후 동시 스타트
    }
  });
}

// ====== 5) 음원 재생된 정도 ======
// 현재 트랙(세 stem 중 하나)의 총 길이(초)
// vocals/beat/chords 어느 것이든 동일 길이라는 전제에서 우선순위 확인
function getTrackDuration() {
  try {
    return (
      players.vocals.player?.buffer?.duration ??
      players.beat.player?.buffer?.duration ??
      players.chords.player?.buffer?.duration ??
      0
    );
  } catch (_) {
    return 0;
  }
}

// === 진행 바 업데이트 루프 ===
let progressRAF = null;
function tickProgress() {
  const dur = getTrackDuration();
  let ratio = 0;

  if (dur > 0) {
    const t = Tone.Transport.seconds || 0; // 루프 재생에서도 0~dur 범위 사용
    ratio = Math.max(0, Math.min(1, (t % dur) / dur));
  }

  if (progressFillEl) progressFillEl.style.width = ratio * 100 + '%';
  if (progressEl)
    progressEl.setAttribute('aria-valuenow', String(Math.round(ratio * 100))); //화면 읽기 프로그램(스크린 리더) 이나 접근성 도구를 위한 것

  progressRAF = requestAnimationFrame(tickProgress);
}
tickProgress();

// === 제목, 가수 UI 반영 ===
function updateNowPlaying() {
  const key = TRACKS[currentTrackIndex];
  const meta = TRACK_META[key] || { title: '', artist: '' };
  if (titleEl) titleEl.textContent = meta.title;
  if (artistEl) artistEl.textContent = meta.artist;
}

// btnPlay.addEventListener('click', async () => {
//   // 사용자 제스처에서 오디오 컨텍스트 시작 필요
//   await Tone.start();
//   // 모든 파일 로딩 완료 대기 (캐시에 있으면 바로 통과)
//   await Tone.loaded();

//   if (Tone.Transport.state === 'started') return;

//   if (Tone.Transport.state === 'paused') {
//     Tone.Transport.start('+0.05'); // 50ms 후 동시 스타트
//     return;
//   }

//   //초기(stopped) 상태라면 현재 Transport.seconds(보통 0)에서 시작
//   Tone.Transport.start('+0.05');
// });

// btnPause.addEventListener('click', () => {
//   Tone.Transport.pause();
// });

// 실행
setup();
