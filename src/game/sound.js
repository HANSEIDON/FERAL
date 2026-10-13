// 소리 — 받은 효과음 파일(public/sfx, tools/tmp/sfx_build.html 이 잘라 만든다)을 재생한다.
//
// 위치가 있는 소리(남의 총성 · 발소리 · 좀비 신음)는 듣는 사람(카메라)에서 멀수록 작아지고
// 왼쪽 · 오른쪽으로 나뉘어 들린다 — 컨테이너 너머 좀비 발소리로 방향을 알 수 있게.
// 파일을 아직 못 받았을 때 탄약 줍기만 예전 합성음으로 낸다.
// 브라우저는 사용자가 한 번 누르기 전엔 소리를 막으므로 첫 입력 때 ensure() 로 연다.
//
// 배경 음악은 메뉴 · 대기실에서만 흐르고 라운드에 들어가면 줄어들며 꺼진다.
// 라운드 중에는 비 · 천둥이 낮게 깔리고, 가끔 먼 사이렌이 들린다 (ambient).

import { Vector3 } from 'three';
import { ASSET_BASE } from '../core/assets.js';

// 파일 이름 → 기본 음량 (파일은 전부 최대 음량 0.9 로 맞춰 두었다)
const SFX = {
  m4_shot: 0.5, pistol_shot: 0.6, dry_fire: 0.5, m4_reload: 0.55, pistol_reload: 0.55,
  jump_swat: 0.35, jump_hunter: 0.35, land: 0.4, zombie_hurt: 0.35,
  slam_jump: 0.6, slam_hit: 0.95, zombie_win: 0.8, zombie_spawn: 0.65,
  s_spawn_hunter: 0.55, s_spawn_swat: 0.55,
  arrow_fly: 0.35, bow_draw: 0.4, bow_release: 0.6,
  step_s1: 0.28, step_s2: 0.28, step_s3: 0.28, step_s4: 0.28,
  step_z1: 0.55, step_z2: 0.55, step_z3: 0.55,
  z_swing: 0.5, z_hit: 0.7, s_hurt1: 0.45, s_hurt2: 0.45, s_hurt3: 0.45, s_hurt4: 0.45,
  s_down: 0.6, s_death1: 0.7, s_death2: 0.7, s_win: 0.7, s_win_voice: 0.55, rage: 0.75, pickup: 0.45,
  rain: 0.16,
  ui_whoosh: 0.5, ui_click: 0.45, ui_hover: 0.22,
};
const SWING_PEAK = 0.3;   // z_swing 에서 바람이 가장 센 시점(초) — 주먹이 닿는 순간에 맞춘다
const SURVIVOR_HURT_GAP = 1.2;   // 같은 사람 신음 최소 간격(초)
const SIRENS = ['siren1.mp3', 'siren2.wav'];
const SIREN_VOL = 0.035;   // 아주 멀리서 — 분위기만
const SIREN_SEC = 7;       // 이만큼 들리다가 2초에 걸쳐 사라진다
// 사이렌 녹음에서 소리가 제대로 나는 지점(초) — 앞쪽 무음 · 서서히 커지는 부분을 건너뛴다
const SIREN_START = { 'siren1.mp3': 6, 'siren2.wav': 2 };
// 재장전 소리에서 마지막 "철컥"(장전 끝)이 나는 시점(초) — 재장전 시간에 맞춰 앞을 건너뛴다
const RELOAD_END = { m4_reload: 2.25, pistol_reload: 1.55 };
const MUSIC_VOL = 0.32;
const ZOMBIE_HURT_GAP = 4;   // 좀비 신음 최소 간격(초)

const _d = new Vector3();

// 설정의 소리 크기 (0~1) — 다음에 들어와도 남는다
const VOL_KEY = 'zfps.volume';
const VOL_DEFAULT = { master: 0.8, sfx: 1, music: 0.7 };
function loadVolume() {
  try { return { ...VOL_DEFAULT, ...JSON.parse(localStorage.getItem(VOL_KEY) ?? '{}') }; } catch { return { ...VOL_DEFAULT }; }
}

export class Audio {
  constructor() {
    this.ctx = null;
    this.buf = new Map();
    this.ear = new Vector3();          // 듣는 위치 (카메라)
    this.right = new Vector3(1, 0, 0); // 듣는 사람의 오른쪽
    this.bgm = null;
    this.musicOn = false;
    this.vol = loadVolume();
  }

  /** 설정 — kind 'master' | 'sfx' | 'music', v 0~1. 바로 반영되고 저장된다 */
  setVolume(kind, v) {
    this.vol[kind] = Math.max(0, Math.min(1, v));
    try { localStorage.setItem(VOL_KEY, JSON.stringify(this.vol)); } catch { /* 무시 */ }
    if (this.out) this.out.gain.value = this.sfxVol;
    if (this.bgm && this.musicOn) this.bgm.volume = this.musicVol;
  }
  get sfxVol() { return this.vol.master * this.vol.sfx; }
  get musicVol() { return MUSIC_VOL * this.vol.master * this.vol.music; }

  ensure() {
    if (!this.ctx) {
      this.ctx = new (globalThis.AudioContext ?? globalThis.webkitAudioContext)();
      this.out = this.ctx.createGain();
      this.out.gain.value = this.sfxVol;
      this.out.connect(this.ctx.destination);
      for (const name of Object.keys(SFX)) {
        fetch(`${ASSET_BASE}sfx/${name}.wav`).then((r) => r.arrayBuffer())
          .then((b) => this.ctx.decodeAudioData(b)).then((a) => this.buf.set(name, a))
          .catch((e) => console.warn('[sound] 효과음을 못 받았습니다', name, e));
      }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  /** 매 프레임 — 듣는 위치를 카메라로 */
  setListener(camera) {
    this.ear.copy(camera.position);
    this.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  }

  /**
   * 효과음 하나.
   * @param o.at     위치(Vector3) — 주면 거리 감쇠 · 좌우 분리
   * @param o.range  이 거리(m) 밖이면 안 들린다
   * @param o.gain   기본 음량에 곱한다    o.rate 재생 속도    o.offset 시작 지점(초)
   * @param o.delay  몇 초 뒤에 낼지      o.loop 반복
   * @returns 재생 중인 소스 (멈출 때 쓴다) · 못 틀면 null
   */
  play(name, o = {}) {
    const ctx = this.ensure();
    const b = this.buf.get(name);
    if (!b) return null;
    let gain = (SFX[name] ?? 0.5) * (o.gain ?? 1), pan = 0;
    if (o.at) {
      _d.subVectors(o.at, this.ear);
      const dist = _d.length(), range = o.range ?? 40;
      if (dist > range) return null;
      gain *= Math.pow(1 - dist / range, 1.6);
      if (dist > 0.5) pan = Math.max(-1, Math.min(1, _d.normalize().dot(this.right))) * 0.8;
    }
    if (gain < 0.005) return null;
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = o.rate ?? 1;
    src.loop = !!o.loop;
    const g = ctx.createGain();
    g.gain.value = gain;
    let node = src.connect(g);
    if (pan) { const p = ctx.createStereoPanner(); p.pan.value = pan; node = node.connect(p); }
    node.connect(this.out);
    src.start(ctx.currentTime + Math.max(0, o.delay ?? 0), Math.max(0, Math.min(b.duration - 0.01, o.offset ?? 0)));
    return src;
  }

  /** 같은 소리 여러 벌 중 하나 (발소리) — 살짝 높낮이도 흔든다 */
  playOne(prefix, n, o = {}) {
    return this.play(`${prefix}${1 + Math.floor(Math.random() * n)}`, { ...o, rate: (o.rate ?? 1) * (0.92 + Math.random() * 0.16) });
  }

  stop(src) { try { src?.stop(); } catch { /* 이미 끝남 */ } }

  // ---------------------------------------------------------------- 무기

  /** 총성 — weaponId 'rifle' | 'pistol' | 'smg'. at 이 있으면 남의 총 */
  gunshot(weaponId, at) {
    this.play(weaponId === 'pistol' ? 'pistol_shot' : 'm4_shot', { at, range: 90, rate: 0.97 + Math.random() * 0.06 });
  }

  /** 빈 탄창 딸깍 */
  dryFire() { this.play('dry_fire'); }

  /** 재장전 — 마지막 철컥이 재장전이 끝나는 순간에 오도록 앞을 건너뛴다 */
  reload(weaponId, sec, at) {
    const name = weaponId === 'pistol' ? 'pistol_reload' : 'm4_reload';
    this.play(name, { at, range: 18, offset: RELOAD_END[name] - sec });
  }

  /** 활 시위 당기기 — 놓거나 취소하면 bowRelease · stop 으로 끊는다 */
  bowDraw() { this.stop(this._draw); this._draw = this.play('bow_draw'); }

  /** 활 놓기 + 화살 날아가는 소리. c = 장전량 0~1 (풀장전일수록 크게) */
  bowRelease(c = 1, at) {
    if (!at) { this.stop(this._draw); this._draw = null; }
    this.play('bow_release', { at, range: 40, gain: 0.55 + 0.45 * c });
    this.play('arrow_fly', { at, range: 30, gain: 0.5 + 0.5 * c });
  }

  bowCancel() { this.stop(this._draw); this._draw = null; }

  // ---------------------------------------------------------------- 몸

  /** 발소리. zombie 면 무거운 발소리 */
  step(zombie, at) {
    if (zombie) this.playOne('step_z', 3, { at, range: 34 });
    else this.playOne('step_s', 4, { at, range: 20 });
  }

  /** 생존자 점프 기합 — hunter 면 사냥꾼 목소리 */
  jump(hunter, at) { this.play(hunter ? 'jump_hunter' : 'jump_swat', { at, range: 22 }); }
  land(at) { this.play('land', { at, range: 18 }); }

  /** 좀비 슈퍼점프 도약 · 착지 충격 */
  slamJump(at) { this.play('slam_jump', { at, range: 50 }); }
  thump(at) { this.play('slam_hit', { at, range: 70 }); }

  /**
   * 좀비 신음 — 연사에 맞을 때마다 내면 거슬린다. 한 번 내면 ZOMBIE_HURT_GAP 초 동안은
   * 다시 안 낸다 (교전이 시작될 때 한 번, 그 뒤로는 띄엄띄엄).
   */
  zombieHurt(at) {
    const now = performance.now() / 1000;
    if (now - (this._hurtAt ?? -99) < ZOMBIE_HURT_GAP) return;
    this._hurtAt = now;
    this.play('zombie_hurt', { at, range: 45, rate: 0.9 + Math.random() * 0.2 });
  }

  /** 라운드 시작 — 좀비 탄생 소리는 모두에게(생존자 화면은 작게), 생존자는 직업별 곡을 같이 (사냥꾼 · 총수) */
  roundStart(role, classId) {
    if (role === 'zombie') { this.play('zombie_spawn'); return; }
    this.play('zombie_spawn', { gain: 0.45 });
    this.play(classId === 'archer' ? 's_spawn_hunter' : 's_spawn_swat');
  }
  zombieWin() { this.play('zombie_win'); }
  survivorWin() { this.play('s_win'); this.play('s_win_voice', { delay: 0.25 }); }

  /** 좀비 주먹 휘두르기 — 바람이 가장 센 순간이 impactIn 초 뒤(주먹이 닿을 때)에 오게 */
  zombieSwing(impactIn, at) { this.play('z_swing', { at, range: 25, delay: impactIn - SWING_PEAK, rate: 0.95 + Math.random() * 0.1 }); }
  /** 주먹이 몸에 닿는 소리 */
  punchHit(at) { this.play('z_hit', { at, range: 30, rate: 0.95 + Math.random() * 0.1 }); }

  /** 생존자가 맞을 때 신음 — 사람마다 SURVIVOR_HURT_GAP 초에 한 번 */
  survivorHurt(id, at) {
    const now = performance.now() / 1000;
    this._hurt ??= new Map();
    if (now - (this._hurt.get(id) ?? -99) < SURVIVOR_HURT_GAP) return;
    this._hurt.set(id, now);
    this.playOne('s_hurt', 4, { at, range: 30 });
  }
  downed(at) { this.play('s_down', { at, range: 40 }); }
  death(at) { this.playOne('s_death', 2, { at, range: 50 }); }
  rage(at) { this.play('rage', { at, range: 60 }); }

  // ---------------------------------------------------------------- 분위기 (라운드 중)

  /** 비 · 천둥을 반복해 깔고, 1~2분에 한 번 먼 사이렌을 낸다. 끄면 멈춘다 */
  ambient(on) {
    if (on === !!this._rain) return;
    if (!on) {
      this.stop(this._rain); this._rain = null;
      clearTimeout(this._sirenTimer);
      this._siren?.pause();
      return;
    }
    this._rain = this.play('rain', { loop: true });
    if (!this._rain) { setTimeout(() => this.ambient(true), 1000); return; }   // 아직 못 받았으면 조금 뒤에
    const next = () => {
      this._sirenTimer = setTimeout(() => {
        const file = SIRENS[Math.floor(Math.random() * SIRENS.length)];
        const el = new globalThis.Audio(`${ASSET_BASE}sfx/${file}`);
        this._siren = el;
        el.volume = SIREN_VOL * this.sfxVol;
        el.currentTime = SIREN_START[file] + Math.random() * 6;
        el.play().catch(() => {});
        // 잠깐 들리다가 사라진다 — 지나가는 먼 사이렌
        setTimeout(() => {
          const fade = setInterval(() => {
            el.volume = Math.max(0, el.volume - (SIREN_VOL * this.sfxVol) / 20 - 1e-4);
            if (el.volume <= 0) { clearInterval(fade); el.pause(); }
          }, 100);
        }, SIREN_SEC * 1000);
        next();
      }, (60 + Math.random() * 60) * 1000);
    };
    next();
  }

  // ---------------------------------------------------------------- 메뉴

  /** 메뉴 소리 — 'whoosh' 화면이 바뀌는 클릭 · 'click' 그냥 클릭 · 'hover' 버튼 위에 올림 */
  ui(kind) { this.play(`ui_${kind}`); }

  // ---------------------------------------------------------------- 음악

  /** 메뉴 · 대기실 배경 음악. 끄면 1초에 걸쳐 줄인다 */
  music(on) {
    if (on === this.musicOn) return;
    this.musicOn = on;
    if (!this.bgm) {
      this.bgm = new globalThis.Audio(`${ASSET_BASE}sfx/bgm.mp3`);
      this.bgm.loop = true;
      this.bgm.volume = 0;
    }
    clearInterval(this._fade);
    if (on) this.bgm.play().catch(() => { this.musicOn = false; });   // 사용자 입력 전이면 막힌다 — 다음 기회에
    this._fade = setInterval(() => {
      const target = on ? this.musicVol : 0;
      const v = this.bgm.volume + Math.sign(target - this.bgm.volume) * 0.03;
      this.bgm.volume = Math.max(0, Math.min(1, Math.abs(target - v) < 0.03 ? target : v));
      if (this.bgm.volume === target) {
        clearInterval(this._fade);
        if (!on) this.bgm.pause();
      }
    }, 50);
  }

  // ---------------------------------------------------------------- 합성 (파일 없는 소리)

  /** (예전) 짧은 하강 톤 — 좀비 주먹. 지금은 zombieSwing · punchHit 를 쓴다 */
  punch() {
    const ctx = this.ensure();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(180, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(48, ctx.currentTime + 0.14);
    g.gain.setValueAtTime(0.22, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);
    o.connect(g).connect(this.out);
    o.start();
    o.stop(ctx.currentTime + 0.17);
  }

  /** 탄약상자 주우기 */
  pickup() {
    if (this.play('pickup')) return;
    // 아직 못 받았으면 예전 합성음 — 짧은 상승 2음
    const ctx = this.ensure();
    const t0 = ctx.currentTime;
    for (const [f, dt] of [[520, 0], [780, 0.07]]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.09, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dt + 0.08);
      o.connect(g).connect(this.out);
      o.start(t0 + dt);
      o.stop(t0 + dt + 0.09);
    }
  }
}
