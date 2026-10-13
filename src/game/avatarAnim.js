// GLB 캐릭터 한 구의 애니메이션.
//
// 서버가 보내는 것은 위치 · 각도 · 이동비트 · 상태뿐이다. 어떤 동작을
// 재생할지는 그 값만 보고 각자 브라우저가 정한다 — 애니메이션까지
// 서버가 지시하면 대역폭만 먹고 얻는 게 없다.

import {
  AnimationClip, AnimationMixer, LoopOnce, LoopRepeat, NumberKeyframeTrack, Quaternion,
  Vector3, VectorKeyframeTrack,
} from 'three';
import { MV } from '../core/input.js';
import { SWAP_SEC } from '../../shared/loadout.js';
import { crawlClip, emoteClip, motionClip } from './emotes.js';

/** 한 번만 재생하고 끝나는 동작. 끝나면 이동 상태로 돌아간다. */
const ONESHOT = new Set(['attack', 'attack2', 'slam', 'rage', 'jump_short']);

/**
 * 한 번 재생하고 마지막 프레임에 멈춰 있는 동작. ONESHOT 과 달리 다른 동작을
 * 막지 않는다 — 쓰러짐이 끝나면 바로 다음 동작으로 넘어간다.
 * death 를 반복하면 쓰러진 몸이 2.6초마다 일어났다 다시 쓰러진다.
 */
const HOLD = new Set(['death']);

/**
 * 모델마다 다른 값 (remotePlayers.js 의 모델 이름 — 역할 + 직업으로 정해진다).
 *  speed       이동 클립이 "제 속도"로 보이는 기준 속도(m/s). 실제 이동 속도를
 *              이 값으로 나눠 재생 속도를 맞춘다. 안 그러면 발이 땅에서 미끄러진다 —
 *              좀비는 6.5m/s 로 달리는데 걷기 클립을 원속도로 틀면 스케이트를 타는
 *              것처럼 보인다. 땅을 딛은 발의 속도를 재서 구했다.
 *  runAbove    이보다 빠르면 달리기 클립 (RUN_BAND 만큼 여유를 두고 바꾼다)
 *  sprintAbove 이보다 빠르면 질주 클립 (있는 모델만)
 *  maxRate     이동 클립 재생 속도 상한. 이보다 빨리 움직이면 다리를 더 감지 않고
 *              발이 조금 미끄러지는 쪽을 택한다 — 육중한 좀비가 종종걸음으로
 *              다리를 휘저으면 미끄러지는 것보다 훨씬 우스꽝스럽다.
 *  aimRate     조준(aim) 클립 재생 속도
 *  hold        이 모델에서만 HOLD 로 다루는 클립
 *  hands       [1번, 2번] 무기 소품 이름 (gunRig.js). 2번을 들면(이동 비트 ALT)
 *  alt         같은 동작 이름을 이 클립으로 바꿔 튼다
 *  swap        무기 교체 — 상체에 겹쳐 트는 클립 구간(from~to, 클립 초)과
 *              손에 든 것이 바뀌는 순간: empty 부터 빈손, ready 부터 새 무기
 */
const PROFILE = {
  zombie: {
    speed: { walk: 1.5, run: 3.0 }, runAbove: 2.2, maxRate: 1.6,
    // jump 클립(2.9초)은 웅크림(0~0.9) → 공중(0.9~1.85) → 착지 흡수(1.85~) 를 다 담고 있다.
    // 예전엔 처음부터 반복 재생돼서, 뛰어오른 뒤 공중에서 다시 웅크리다 착지 순간 슬램에
    // 잘렸다. 공중 구간만 틀고(발은 이미 땅을 떠났다), 슈퍼점프 체공(최대 1.4초)에 맞게
    // 0.7배로 늘인다. 공중 구간 끝(내려오는 자세)에 닿으면 착지까지 그 자세로 멈춰 있는다.
    hold: ['jump'],
    air: { from: 0.9, to: 1.85, rate: 0.7 },
  },
  hunter: {
    speed: { run: 3.11, aim_fwd: 1.04, aim_back: 0.85, aim_left: 1.32, aim_right: 1.34 },
    runAbove: 0,       // 걷기 클립이 없다 — 움직이면 달리기, 활을 당기면 조준 걷기
    maxRate: 1.8,
    // 시위를 3.3초에 걸쳐 더 당기는 클립 — 풀장전(활 chargeMax 1.4초)쯤 끝까지
    // 당겨지게 감고, 거기서 멈춰 있는다
    aimRate: 2.4,
    hold: ['jump', 'aim'],   // jump 는 도약~착지만 잘라 둔 클립이라 반복하면 공중에서 또 뛴다
  },
  gunner: {
    // 소총 클립은 걷기·질주 속도(4.5 · 6.3m/s)와 거의 같아서 원속도 그대로 돈다
    speed: { run: 4.65, sprint: 6.26, aim_fwd: 4.43, p_run: 3.08, p_walk: 2.49 },
    runAbove: 0,
    sprintAbove: 5.4,
    maxRate: 1.8,
    aimRate: 1,        // 서서 쏘기는 반복 — 누르고 있는 동안 계속 쏜다
    hold: ['jump'],
    hands: ['rifle', 'pistol'],
    // 권총 클립은 셋 다 두 손으로 겨눈 채라 서기·달리기가 곧 쏘는 자세다.
    // 권총 질주 클립은 없어서 달리기를 감아 쓴다 (maxRate 에서 멈추고 조금 미끄러진다)
    alt: {
      idle: 'p_idle', walk: 'p_walk', run: 'p_run', sprint: 'p_run',
      aim: 'p_aim', aim_fwd: 'p_run', jump: 'p_jump',
    },
    swap: {
      // 소총을 오른쪽 허리로 내려 놓고(1.25) 그 손으로 허리에서 권총을 뽑는다(1.85)
      toAlt: { clip: 'holster_rifle', from: 0.15, to: 1.95, empty: 1.25, ready: 1.85 },
      // 권총을 집어넣고(0.15) 오른쪽 허리에 멘 소총을 잡아(0.45) 앞으로 가져온다
      toMain: { clip: 'draw_rifle', from: 0.1, to: 1.5, empty: 0.15, ready: 0.45 },
    },
  },
};
const MOVE_ABOVE = 0.25;    // 이보다 느리면 서 있는 것으로 친다
const RUN_BAND = 0.15;      // 걷기↔달리기 경계에서 클립이 매 프레임 뒤바뀌지 않게

/**
 * 다리 재생 속도가 실제 속도를 따라가는 빠르기(1/초). 즉시 따라가면 질주 키를
 * 누르는 순간 다리가 한 프레임에 1.4배로 튄다.
 */
const RATE_FOLLOW = 8;

/**
 * 상체에만 겹쳐 트는 동작 (재장전 · 무기 교체). 다리는 아래에서 돌던 걷기·달리기를
 * 그대로 따른다 — 통째로 틀면 재장전하며 움직일 때 선 자세로 미끄러진다.
 * 상체 = Spine 과 그 아래 전부 (허리·가슴·목·머리·어깨·팔·손).
 */
const UPPER_CLIPS = new Set(['reload', 'holster_rifle', 'draw_rifle']);
const UPPER_FADE_IN = 0.15;
const UPPER_FADE_OUT = 0.25;
/**
 * 상체 덧씌우기 비중. three 는 같은 뼈대에 걸린 동작들을 가중 평균하므로
 * 아래 동작(가중치 1) 대비 이 비율이 되도록 가중치를 m/(1-m) 으로 준다.
 */
const UPPER_MIX = 0.97;

/**
 * 섞이는 시간. 공격처럼 즉각적인 건 짧게, 서기·걷기·달리기 사이는 넉넉히 —
 * 짧으면 출발·정지·질주 전환마다 자세가 툭 끊긴다.
 */
const FADE = {
  attack: 0.06, attack2: 0.12, slam: 0.05, death: 0.15, walk: 0.22, run: 0.22, sprint: 0.22,
  idle: 0.25, aim: 0.15, aim_fwd: 0.15, jump: 0.1, _: 0.2,
};

/**
 * 공격 클립에서 주먹이 실제로 뻗는(타격) 시점. GLB 키프레임을
 * 직접 재서 구한 값 (tools/tmp/impact_frame.mjs).
 * 누른 순간에 타격을 넣으면 상대가 주먹이 나가기 전에 반응하므로,
 * 이 값만큼 타격 등록을 늦춰 동작과 맞춘다.
 */
const IMPACT = { attack: 0.567, attack2: 1.567 };

/**
 * 한 번짜리 동작을 재생할 때 처음으로 놓을 시점(초). 0이면 처음부터.
 *
 * slam(슈퍼점프 착지충격) 클립은 "웅크림→도약→낙하→내려찍기→회복" 순이라
 * 착지 순간에 처음부터 틀면 실제 내려찍기가 1.9초 뒤에 온다 — 착지와 따로
 * 떨어진 두 동작처럼 보인다. 그래서 착지하면 이미 내려찍기(임팩트) 프레임부터
 * 재생해 착지와 동시에 타격이 들어가게 하고, 그 뒤 회복 동작만 이어지게 한다.
 * 임팩트 시점은 GLB 키프레임을 직접 재서 구한 값 (tools/tmp/slam_fine.mjs).
 *
 * attack2(좀비 스윙)는 앞 0.4초가 손을 천천히 들어올리는 준비 동작이다.
 * 처음부터 틀면 타격(1.567초)을 IMPACT_AT(0.8초)에 맞추느라 1.96배속으로
 * 감아야 해서 휘두르는 게 경련처럼 보였다. 준비 동작을 건너뛰면 1.46배속이다.
 */
const ONESHOT_SEEK = { slam: 1.87, attack2: 0.4 };

/**
 * 한 번짜리 동작을 끝내고 다음 동작으로 넘기는 시점(초). 없으면 클립 끝.
 * attack2 의 마지막 0.27초는 처음 자세로 돌아오는 꼬리라, 다음 동작과 섞여도
 * 티가 안 난다. 여기서 끊어야 앞을 건너뛴 만큼 쿨다운이 늘지 않는다
 * (예전 2.47초 ÷ 1.96 = 1.26초 ≈ 지금 1.8초 ÷ 1.46 = 1.23초).
 */
const ONESHOT_END = { attack2: 2.2, slam: 2.15 };
// slam 은 내려찍은 직후(임팩트 1.87초 + 0.28초)에 넘긴다. 그 뒤 1.6초는 허리를 펴며
// 일어나는 회복 동작이라, 착지 후 한동안 엉뚱한 동작이 이어지고 그동안 다른 동작이
// 막혔다 — 착지하자마자 달리기 · 펀치로 이어지게 여기서 끊고 섞어 넘긴다.

const seekOf = (name) => ONESHOT_SEEK[name] ?? 0;

/**
 * 한 대가 끝나는 시간(= 다음 대를 때릴 수 있는 쿨다운). 두 클립 모두
 * 이 시점에 주먹이 뻗히도록 재생 속도를 맞춘다 — 타격 타이밍은 항상
 * 일정하고, 동작은 rpm 140(0.43초/대)보다 느리게 보인다.
 */
export const IMPACT_AT = 0.8;

/**
 * 슈퍼점프 충전량(0..1)을 착지 모션 재생 속도로 바꾼다.
 * slam 클립은 3.7초라 착지 후에도 모션이 계속 이어진다 — 많이 모을수록
 * 높이에서 떨어지므로, 충전량에 비례해 빨리 감아 무게감을 준다.
 * 1.0x(최소 충전) ~ 2.2x(꽉 모은 것).
 */
export function slamRate(charge) {
  const c = Math.max(0, Math.min(1, +charge || 0));
  return 1 + 1.2 * c;
}

export class AvatarAnim {
  /**
   * @param root  SkeletonUtils.clone() 한 캐릭터
   * @param clips AnimationClip 배열 (원본 gltf.animations)
   * @param model 모델 이름 'zombie' | 'hunter' | 'gunner' — 모델별 클립 속도 (PROFILE)
   */
  constructor(root, clips, model) {
    const p = PROFILE[model] ?? PROFILE.zombie;
    this.speed = p.speed;
    this.runAbove = p.runAbove;
    this.sprintAbove = p.sprintAbove ?? Infinity;
    this.maxRate = p.maxRate;
    this.aimRate = p.aimRate ?? 1;
    this.hold = new Set([...HOLD, ...p.hold]);
    this.air = p.air ?? null;
    // 무기 (총수만) — altOn 이면 동작 이름을 alt 클립으로 바꿔 튼다
    this.altMap = p.alt ?? null;
    this.swapDef = p.swap ?? null;
    this.handNames = p.hands ?? null;
    this.altOn = false;      // 지금 동작이 2번 무기 세트인지
    this.altWant = false;    // 이동 비트가 원하는 무기
    this.swapping = null;    // 진행 중인 교체 (swap.toAlt | toMain)
    /** 손에 든 소품 이름 — null 이면 빈손 (교체 도중) */
    this.hands = this.handNames?.[0] ?? null;
    this.legSpeed = 0;   // 다리 재생 속도용 — 실제 속도를 RATE_FOLLOW 로 따라간다

    this.mixer = new AnimationMixer(root);
    this.actions = new Map();
    this.upper = new Map();   // 상체에만 겹쳐 트는 동작 (UPPER_CLIPS)
    this.upperOn = null;
    /**
     * 손에 든 소품 (활 · 총). 매 프레임 동작이 뼈대를 움직인 뒤 update(dt, this) 를 부른다 —
     * drawing(시위를 당기는 중) · down(쓰러짐) · hands(손에 든 것)를 보고 따라간다.
     */
    this.rigs = [];
    this.drawing = false;
    this.down = false;
    const rootBone = findRootBone(root);
    const upperBones = findUpperBones(root);
    for (const c of clips) {
      const clip = stripRootMotion(c, rootBone);
      if (UPPER_CLIPS.has(clip.name)) {
        const tracks = clip.tracks.filter((t) => upperBones.has(t.name.slice(0, t.name.lastIndexOf('.'))));
        this.upper.set(clip.name, this.mixer.clipAction(new AnimationClip(clip.name, clip.duration, tracks)));
      } else {
        this.actions.set(clip.name, this.mixer.clipAction(clip));
      }
    }

    this.current = null;
    this.oneshot = null;

    this.play('idle', 0);
  }

  /** 동작 이름 → 실제 클립 이름. 권총을 들면 같은 이름이라도 권총 클립이다. */
  alias(name) { return (this.altOn && this.altMap?.[name]) || name; }

  has(name) { return this.actions.has(this.alias(name)); }

  /**
   * 지금 도는 공격의 "나가는 시간" — 클립 시작부터 실제 타격까지,
   * 재생 속도를 적용한 실제 초 단위. 타격 등록을 이만큼 늦춘다.
   */
  get attackWindup() {
    const a = this.oneshot ?? this.current;
    if (!a || !(this.currentName in IMPACT)) return 0;
    return (IMPACT[this.currentName] - seekOf(this.currentName)) / (a.timeScale || 1);
  }

  /**
   * 다음 펀치의 나가는 시간. 쿨다운을 이 값으로 잡으면 타격이 항상
   * 주먹이 뻗는 순간에 들어간다.
   */
  get nextWindup() {
    const name = 'attack2';   // 항상 왼손 스윙
    if (!(name in IMPACT)) return 0;
    return (IMPACT[name] - seekOf(name)) / (this.oneshotRate?.[name] ?? 1);
  }

  /**
   * 다음 trigger('attack') 이 재생할 클립 이름. 항상 왼손 스윙(attack2).
   * 조준 표시가 다음 대의 판정점에 맞게.
   */
  get nextClip() { return 'attack2'; }

  /**
   * 공격 모션이 아직 다 끝나지 않았는지. 끝나기 전엔 다음 펀치를 못 때린다 —
   * 끊으면 회복 동작이 잘려 "평캔"처럼 보인다.
   */
  get attackBusy() {
    // 주먹 동작만 본다 — 착지충격 · 포효 중에도 바로 펀치가 나가야 한다
    const a = this.oneshot;
    if (this.currentName !== 'attack' && this.currentName !== 'attack2') return false;
    return !!(a && a.isRunning() && a.time < this.endOf(this.currentName));
  }

  /** 한 번짜리 동작이 다음 동작에 자리를 내주는 클립 시점(초). */
  endOf(name) {
    return ONESHOT_END[name] ?? this.actions.get(name)?.getClip().duration ?? 0;
  }

  /**
   * 공격 클립이 끝까지 가는 실제 시간(초) — 재생 속도를 적용한 값.
   * 펀치 쿨다운을 이 값으로 잡으면 모션이 다 들어가야 다음 대가 들어간다.
   */
  get attackFull() {
    if (!this.actions.has('attack2')) return 0;
    const rate = this.oneshotRate?.attack2 ?? 1;
    return (this.endOf('attack2') - seekOf('attack2')) / rate;
  }

  /**
   * 공격 클립을 감는다. 주먹이 IMPACT_AT 초에 뻗히도록 재생 속도를 맞춘다.
   */
  setAttackRate(secondsPerHit) {
    if (!secondsPerHit) return;
    this.oneshotRate = {};
    const name = 'attack2';
    const a = this.actions.get(name);
    if (a) this.oneshotRate[name] = clamp((IMPACT[name] - seekOf(name)) / secondsPerHit, 0.5, 4);
  }

  /**
   * 춤 (Ctrl+1 · 2 · 3) — 반복해서 추다가 움직이면 멈춘다. 손에 든 무기는 내려놓는다
   * (총은 허리에 메고 활은 감춘다 — gunRig · bowRig 가 emoting 을 본다).
   */
  emote(n) {
    if (this.down) return false;
    const clip = emoteClip(n, this.mixer.getRoot());
    if (!clip) return false;
    const a = this.mixer.clipAction(clip);
    a.reset();
    a.setLoop(LoopRepeat, Infinity);
    a.timeScale = 1;
    a.enabled = true;
    a.setEffectiveWeight(1);
    if (this.current && this.current !== a) a.crossFadeFrom(this.current, 0.25, false);
    a.play();
    this.stopUpper();
    this.current = a;
    this.currentName = `emote${n}`;
    this.oneshot = null;
    this.emoting = a;
    return true;
  }

  /** emotes.glb 동작 하나를 튼다 (이미 틀고 있으면 그대로). 클립이 없으면 false. */
  motion(name, loop) {
    if (this.currentName === name) return true;
    const clip = motionClip(name, this.mixer.getRoot());
    if (!clip) return false;
    const a = this.mixer.clipAction(clip);
    a.reset();
    a.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1);
    a.clampWhenFinished = !loop;
    a.timeScale = 1;
    a.enabled = true;
    a.setEffectiveWeight(1);
    if (this.current && this.current !== a) a.crossFadeFrom(this.current, 0.35, false);
    a.play();
    this.stopUpper();
    this.current = a;
    this.currentName = name;
    this.oneshot = null;
    this.emoting = null;
    return true;
  }

  /** 기어가기 재생 — 이동 속도에 맞춰 감고, 멈추면 그 자세로 멈춘다. 클립이 없으면 false. */
  crawl(speed) {
    if (!this.crawling) {
      const c = crawlClip(this.mixer.getRoot());
      if (!c) return false;
      const a = this.mixer.clipAction(c.clip);
      a.reset();
      a.setLoop(LoopRepeat, Infinity);
      a.enabled = true;
      a.setEffectiveWeight(1);
      if (this.current && this.current !== a) a.crossFadeFrom(this.current, 0.35, false);
      a.play();
      this.stopUpper();
      this.current = a;
      this.currentName = 'crawl';
      this.oneshot = null;
      this.crawling = { action: a, speed: c.speed };
    }
    const k = this.crawling;
    this.legSpeed = speed;
    k.action.timeScale = speed > 0.12 ? clamp(speed / k.speed, 0.3, 2.5) : 0;
    return true;
  }

  /** 없는 클립은 조용히 무시한다 — 모델이 바뀌어도 터지지 않게. */
  play(name, fade) {
    if (fade === undefined) fade = FADE[name] ?? FADE._;
    const next = this.actions.get(this.alias(name));
    if (!next || this.current === next) return false;

    const once = ONESHOT.has(name);
    const stop = once || this.hold.has(name);   // 끝 프레임에서 멈춘다
    next.reset();
    next.setLoop(stop ? LoopOnce : LoopRepeat, stop ? 1 : Infinity);
    next.clampWhenFinished = stop;
    next.enabled = true;
    next.setEffectiveWeight(1);

    if (name === 'jump' && this.air) next.time = this.air.from;   // 공중 구간부터 (PROFILE.zombie.air)
    if (this.current) next.crossFadeFrom(this.current, fade, false);
    next.play();

    this.current = next;
    this.currentName = name;
    this.oneshot = once ? next : null;
    return true;
  }

  /**
   * 한 번짜리 동작을 끼워 넣는다 (공격 · 포효 · 착지충격).
   * rate — 재생 속도 배수. 착지충격은 충전량에 비례해 빨리 감는다.
   */
  trigger(name, rate) {
    const fade = FADE[name] ?? FADE._;
    if (name === 'attack') {
      // 좀비는 왼손 스윙(attack2). 사냥꾼은 공격 클립이 없다 — 활을 당기는 자세는
      // 발사 버튼을 누르고 있는 동안 update() 가 aim 으로 튼다 (aims 참고).
      const clip = this.actions.has('attack2') ? 'attack2' : 'attack';
      this.playOneshot(clip, fade);
      return;
    }
    this.playOneshot(name, fade, rate);
  }

  playOneshot(name, fade, rate) {
    const a = this.actions.get(name);
    if (!a) return;
    a.reset();
    // slam은 임팩트 프레임부터, attack2 는 준비 동작 다음부터 (ONESHOT_SEEK 참고)
    a.time = seekOf(name);
    a.timeScale = rate ?? this.oneshotRate?.[name] ?? 1;
    a.setLoop(LoopOnce, 1);
    a.clampWhenFinished = true;
    a.enabled = true;
    a.setEffectiveWeight(1);
    if (this.current && this.current !== a) a.crossFadeFrom(this.current, fade, false);
    a.play();
    this.current = a;
    this.currentName = name;
    this.oneshot = a;
  }

  /**
   * 서버 상태에서 적절한 동작을 고른다.
   *
   * @param mv    이동 비트 (core/input.js 의 MV)
   * @param state 'alive' | 'downed' | 'dead'
   * @param speed 수평 이동 속도(m/s). 걷기/달리기를 고르고 재생 속도를 맞춘다.
   *              비트로 고르면 안 된다 — 좀비는 질주 비트가 아예 안 켜져서
   *              6.5m/s 로 달리면서 걷기 클립을 틀게 된다.
   */
  update(dt, mv, state, speed = 0) {
    this.drawing = false;
    this.down = state === 'dead' || state === 'downed';
    this.wantWeapon(mv);
    this.step(dt, mv, state, speed);
    this.updateHands();
    for (const r of this.rigs) r.update(dt, this);
  }

  /**
   * 무기 교체 시작 — 이동 비트 ALT(2번 무기)가 바뀌면 교체 동작을 상체에 튼다.
   * 남의 화면도 같은 비트를 받으므로 똑같이 교체한다. 교체는 무기 쪽(combat.js)에서
   * SWAP_SEC 걸리므로 동작도 그 시간에 맞춰 감는다.
   */
  wantWeapon(mv) {
    if (!this.altMap) return;
    const want = !!(mv & MV.ALT);
    if (want === this.altWant) return;
    this.altWant = want;
    const def = this.swapDef?.[want ? 'toAlt' : 'toMain'];
    if (this.down || !def || !this.playUpper(def.clip, def.from, def.to, SWAP_SEC)) {
      this.finishSwap();   // 교체 동작이 없거나 쓰러져 있으면 바로 바꾼다
      return;
    }
    this.swapping = def;
  }

  /** 교체 동작의 시점에 맞춰 손에 든 것을 바꾼다: 옛 무기 → 빈손 → 새 무기. */
  updateHands() {
    const def = this.swapping;
    if (!def) return;
    const a = this.upperOn;
    // 다른 상체 동작(재장전)이 끼어들었거나 끝났으면 교체를 마무리한다
    if (!a || a.getClip().name !== def.clip) { this.finishSwap(); return; }
    if (a.time >= def.ready) {
      // 새 무기를 쥐는 순간 아래 동작도 그 무기 세트로 — 상체가 덮고 있는 동안 섞인다
      this.hands = this.handNames[this.altWant ? 1 : 0];
      this.altOn = this.altWant;
    } else {
      this.hands = a.time >= def.empty ? null : this.handNames[this.altWant ? 0 : 1];
    }
  }

  finishSwap() {
    this.swapping = null;
    this.altOn = this.altWant;
    this.hands = this.handNames?.[this.altWant ? 1 : 0] ?? null;
  }

  step(dt, mv, state, speed) {
    this.mixer.update(dt);
    this.legSpeed += (speed - this.legSpeed) * Math.min(1, dt * RATE_FOLLOW);
    this.updateUpper();

    // 춤 — 움직이거나 쏘거나 뛰면 그만둔다 (남의 화면도 같은 이동 비트로 멈춘다)
    if (this.emoting) {
      const busy = (mv & (MV.FWD | MV.BACK | MV.LEFT | MV.RIGHT | MV.AIR | MV.FIRE)) || speed > 0.4;
      if (!busy && state === 'alive' && this.current === this.emoting) return;
      this.emoting = null;
    }

    // CPR — 바깥(main.js updateCpr)이 짝을 지어 cpr 를 'give' · 'get' 으로 정한다
    if (this.cpr === 'get' && state === 'downed' && this.motion('cpr_get', true)) { this.crawling = null; return; }
    if (this.cpr === 'give' && state === 'alive' && this.motion('cpr_give', true)) return;
    // 죽으면 Dying 을 한 번 틀고 끝 자세로 누워 있는다
    if (state === 'dead' && this.motion('dying', false)) return;

    // 쓰러진 생존자가 기어간다 — 한 번 기기 시작하면 멈춰도 엎드린 자세를 지킨다
    // (쓰러짐 동작은 끝 자세가 달라서 섞으면 멈출 때마다 몸을 뒤집는다)
    if (state === 'downed' && (speed > 0.12 || this.crawling)) {
      if (this.crawl(speed)) return;
    }
    if (state !== 'downed') this.crawling = null;

    if (state === 'dead' || state === 'downed') {
      this.stopUpper();
      this.setRate(1);
      this.play('death', FADE.death);
      return;
    }

    // 한 번짜리가 아직 돌고 있으면 건드리지 않는다
    if (this.oneshot) {
      if (this.oneshot.isRunning() && this.oneshot.time < this.endOf(this.currentName)) return;
      this.oneshot = null;
    }

    if (mv & MV.AIR) {
      this.play('jump');
      // 공중 구간이 정해진 모델은 그 끝(내려오는 자세)에서 착지할 때까지 멈춰 있는다
      const air = this.air;
      this.setRate(air ? (this.current.time >= air.to ? 0 : air.rate) : 1);
      return;
    }

    // 활을 당기거나 총을 쏘는 동안. 몸은 조준 방향을 보고 있으므로(main.js ·
    // remotePlayers.js) 이동 비트가 곧 몸 기준 방향이다. 버튼을 떼면 다음 프레임에
    // 바로 아래의 서 있기·달리기로 섞여 돌아간다.
    if (this.aims(mv)) {
      this.drawing = true;   // 활이면 시위를 오른손에 걸어 당긴다 (bowRig.js)
      if (speed < MOVE_ABOVE) {
        this.play('aim');
        this.setRate(this.aimRate);
        return;
      }
      // 그 방향 클립이 없으면(총수는 앞으로 달리며 쏘기뿐) 앞 클립으로 —
      // 쏘는 자세가 풀리는 것보다 옆으로 미끄러지는 쪽이 덜 어색하다
      const want = aimWalk(mv);
      const name = this.has(want) ? want : 'aim_fwd';
      if (this.has(name)) {
        this.play(name);
        this.setRate(this.legRate(name));
        return;
      }
    }

    if (speed < MOVE_ABOVE) {
      this.setRate(1);
      this.play('idle');
      return;
    }

    const name = this.gait(speed);
    this.play(name);
    this.setRate(this.legRate(name));
  }

  /**
   * 걷기냐 달리기냐 질주냐. 경계 근처에서는 지금 클립을 RUN_BAND 만큼 더 붙든다 —
   * 속도가 경계에서 오락가락하면 두 클립이 매 프레임 뒤바뀌며 다리가 엉킨다.
   */
  gait(speed) {
    const edge = (name, at) => at + (this.currentName === name ? -RUN_BAND : RUN_BAND);
    if (this.has('sprint') && speed >= edge('sprint', this.sprintAbove)) return 'sprint';
    if (!this.has('walk')) return 'run';
    if (!this.has('run')) return 'walk';
    return speed >= edge('run', this.runAbove) ? 'run' : 'walk';
  }

  /**
   * 재장전 — 상체에만 겹쳐 튼다. 다리는 걷기·달리기를 계속한다.
   * sec 동안 끝까지 가도록 감는다 (무기마다 재장전 시간이 다르다).
   */
  reload(sec) {
    const a = this.upper.get('reload');
    if (a) this.playUpper('reload', 0, a.getClip().duration, sec);
  }

  /** 상체에만 클립의 from~to 구간을 sec 초에 걸쳐 튼다. 돌던 상체 동작은 끊는다. */
  playUpper(name, from, to, sec) {
    const a = this.upper.get(name);
    if (!a) return false;
    if (this.upperOn && this.upperOn !== a) this.upperOn.stop();
    a.reset();
    a.setLoop(LoopOnce, 1);
    a.clampWhenFinished = false;
    a.time = from;
    a.timeScale = (to - from) / Math.max(0.2, sec);
    a.setEffectiveWeight(0);
    a.play();
    this.upperOn = a;
    this.upperFrom = from;
    this.upperTo = to;
    return true;
  }

  /** 상체 동작의 비중 — 처음엔 서서히 덮고, 끝나기 전에 서서히 내려놓는다. */
  updateUpper() {
    const a = this.upperOn;
    if (!a) return;
    if (!a.isRunning() || a.time >= this.upperTo) { this.stopUpper(); return; }
    const scale = a.timeScale || 1;
    const sinceStart = (a.time - this.upperFrom) / scale;
    const untilEnd = (this.upperTo - a.time) / scale;
    const ramp = clamp(Math.min(sinceStart / UPPER_FADE_IN, untilEnd / UPPER_FADE_OUT), 0, 1);
    const m = UPPER_MIX * ramp;
    a.setEffectiveWeight(m / (1 - m));
  }

  stopUpper() {
    if (!this.upperOn) return;
    this.upperOn.stop();
    this.upperOn = null;
  }

  /**
   * 발이 땅을 짚도록 재생 속도를 실제 속도에 맞추되, maxRate 를 넘기지 않는다
   * (PROFILE 참고). 속도는 legSpeed 로 부드럽게 따라간다.
   */
  legRate(name) {
    const speed = this.speed[this.alias(name)] ?? this.speed[name] ?? 1;
    return clamp(this.legSpeed / speed, 0.5, this.maxRate);
  }

  /**
   * 조준 중인지 — 발사 버튼을 누르고 있고 조준 클립이 있는 모델(사냥꾼 · 총수).
   * 이동 비트에 FIRE 가 실려 오므로 남의 화면에서도 똑같이 판단된다.
   * 이 동안은 몸을 이동 방향이 아니라 조준 방향으로 돌려야 한다.
   */
  aims(mv) { return !!(mv & MV.FIRE) && this.has('aim'); }

  /**
   * 묶여 있는 상태(라운드 시작, 좀비 hold). 이동도 공격도 못 하는
   * 제자리 서 있기 클립을 강제 재생한다.
   * mixer.update 는 매 프레임 꼭 돌려야 동작이 얼어붙지 않는다.
   */
  updateHold(dt) {
    this.mixer.update(dt);
    this.oneshot = null;
    this.setRate(1);
    // 좀비는 가슴을 치며 몸을 푸는 taunt(4.5초)가 묶인 5초에 딱 맞다
    this.play(this.has('taunt') ? 'taunt' : this.has('idle_long') ? 'idle_long' : 'idle', FADE._);
    this.drawing = false;
    this.down = false;
    for (const r of this.rigs) r.update(dt, this);
  }

  /** 지금 도는 클립의 재생 속도. */
  setRate(r) {
    if (this.current && this.current.timeScale !== r) this.current.timeScale = r;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/** 조준 중 이동 비트 → 방향별 조준 걷기. 대각선은 앞뒤를 따른다. */
function aimWalk(mv) {
  if (mv & MV.BACK) return 'aim_back';
  if (mv & MV.FWD) return 'aim_fwd';
  if (mv & MV.LEFT) return 'aim_left';
  if (mv & MV.RIGHT) return 'aim_right';
  return 'aim_fwd';   // 비트 없이 밀려나는 중 (넉백 등)
}

/**
 * 스켈레톤 루트 뼈대(부모가 뼈대가 아닌 bone)를 찾는다.
 * Mixamo 모델이면 mixamorig:Hips 이다.
 */
function findRootBone(root) {
  let bone = null;
  root.traverse((o) => {
    if (o.isBone && !(o.parent && o.parent.isBone)) bone = o;
  });
  return bone;
}

/** 상체 뼈대 이름들 — 첫 Spine 과 그 아래 전부 (UPPER_CLIPS 가 이것만 움직인다). */
function findUpperBones(root) {
  let spine = null;
  root.traverse((o) => { if (!spine && o.isBone && /Spine$/.test(o.name)) spine = o; });
  const names = new Set();
  spine?.traverse((o) => { if (o.isBone) names.add(o.name); });
  return names;
}

/**
 * 루트 모션 제거.
 *
 * 이 GLB 의 Hips 뼈대 translation 에 루트 모션이 박혀 있다 — 클립이 도는
 * 동안 캐릭터가 자체적으로 앞으로 1~2m 밀려나고(walk/run 은 세로로도 2m
 * 이상), 클립이 루프되는 순간 제자리로 돌아온다. 게임 코드가 avatar.position 을
 * 서버 위치로 정확히 설정해도 이 오프셋이 덧씌워져 "좀비가 앞으로 가다 뒤로
 * 순간이동" 으로 보였다.
 *
 * 루트 뼈대의 position 트랙을 첫 키프레임 값의 고정 트랙으로 바꾼다.
 * (단순히 지우면 rest pose 로 돌아가는데, rest 와 첫 키프레임이 19cm
 *  어긋나 있어서 캐릭터가 제자리에서 밀려난다.)
 *
 * 쓰러지는 클립(KEEP_FALL)은 위아래 이동만 남긴다. 다 고정하면 Hips 가 선 키에
 * 묶여서 쓰러진 몸이 공중에 누워 있다 (사냥꾼 death 는 0.66m 뜬다).
 * 수평 이동은 그대로 지운다 — 위치는 서버가 정한다.
 */
const KEEP_FALL = new Set(['death']);

function stripRootMotion(clip, rootBone) {
  if (!rootBone) return clip;
  const target = `${rootBone.name}.position`;
  const rm = clip.tracks.find((t) => t.name === target);
  if (!rm || rm.values.length < 3) return clip;

  const first = Array.from(rm.values.slice(0, 3));
  let track;
  if (KEEP_FALL.has(clip.name) && rootBone.parent) {
    // 세계 위쪽을 Hips 부모 공간으로 — 좀비 GLB 는 Armature 가 Z-up 이라 축이 다르다
    const up = new Vector3(0, 1, 0)
      .applyQuaternion(rootBone.parent.getWorldQuaternion(new Quaternion()).invert());
    const v = Float32Array.from(rm.values);
    for (let i = 0; i < v.length; i += 3) {
      const d = (v[i] - first[0]) * up.x + (v[i + 1] - first[1]) * up.y + (v[i + 2] - first[2]) * up.z;
      v[i] = first[0] + up.x * d;
      v[i + 1] = first[1] + up.y * d;
      v[i + 2] = first[2] + up.z * d;
    }
    track = new VectorKeyframeTrack(target, rm.times, v);
  } else {
    track = new NumberKeyframeTrack(target, [0], first);
  }
  const tracks = clip.tracks.filter((t) => t.name !== target).concat(track);
  return new AnimationClip(clip.name, clip.duration, tracks);
}
