// 키보드 · 마우스 · 포인터락.
//
// 게임 로직은 키 코드를 직접 보지 않고 액션 이름으로 묻는다 (`in.has('sprint')`).
// 키 배치를 바꾸거나 직업별 스킬 키를 추가할 때 여기만 고치면 된다.

import { MV } from '../../shared/protocol.js';
export { MV };   // 이동 비트는 프로토콜 상수 — 서버 슬램 회피 판정도 같은 값을 쓴다

export const BINDS = {
  KeyW: 'fwd', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  ArrowUp: 'fwd', ArrowDown: 'back', ArrowLeft: 'left', ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
  KeyR: 'special',        // 생존자: 재장전 / 좀비: 광폭화
  KeyF: 'use',            // 쓰러진 동료 일으키기
  KeyE: 'use',
  Digit1: 'slot1',        // 주무기
  Digit2: 'slot2',        // 권총
  Escape: 'menu',
};

const SENS_KEY = 'zfps.sensitivity';
export const SENS_MIN = 0.0004;
export const SENS_MAX = 0.0060;
export const SENS_DEFAULT = 0.0022;

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.down = new Set();        // 눌려 있는 액션
    this.pressed = new Set();     // 이번 프레임에 새로 눌린 액션
    this.mouse = { dx: 0, dy: 0, left: false, right: false };
    this.locked = false;
    this.sensitivity = Input.loadSensitivity();
    this.invertY = localStorage.getItem('zfps.invertY') === '1';

    this._onKeyDown = (e) => {
      // 닉네임 같은 입력창에서 타이핑 중이면 게임 키로 가로채지 않는다.
      // (preventDefault 가 문자 입력 자체를 막아서 's' 같은 키가 안 먹혔다)
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // 춤: Ctrl(또는 Alt) + 1 · 2 · 3 — 무기 슬롯(1 · 2)보다 먼저 가로챈다
      if ((e.ctrlKey || e.altKey) && /^Digit[1-3]$/.test(e.code)) {
        e.preventDefault();
        if (!e.repeat) this.pressed.add(`emote${e.code.slice(5)}`);
        return;
      }
      const a = BINDS[e.code];
      if (!a) return;
      if (a !== 'menu') e.preventDefault();
      if (!this.down.has(a)) this.pressed.add(a);
      this.down.add(a);
    };
    this._onKeyUp = (e) => {
      const a = BINDS[e.code];
      if (a) this.down.delete(a);
    };
    this._onMove = (e) => {
      if (!this.locked) return;
      this.mouse.dx += e.movementX * this.sensitivity;
      this.mouse.dy += e.movementY * this.sensitivity * (this.invertY ? -1 : 1);
    };
    this._onBtn = (e, v) => {
      if (!this.locked) return;
      if (e.button === 0) {
        // 단발 무기는 "누른 순간"만 필요하므로 액션으로도 올려준다
        if (v && !this.mouse.left) this.pressed.add('fire');
        this.mouse.left = v;
      }
      if (e.button === 2) this.mouse.right = v;
    };
    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.down.clear(); this.mouse.left = this.mouse.right = false; }
      this.onLockChange?.(this.locked);
    };
    this._onBlur = () => { this.down.clear(); this.mouse.left = this.mouse.right = false; };

    addEventListener('keydown', this._onKeyDown);
    addEventListener('keyup', this._onKeyUp);
    addEventListener('mousemove', this._onMove);
    addEventListener('mousedown', (e) => this._onBtn(e, true));
    addEventListener('mouseup', (e) => this._onBtn(e, false));
    addEventListener('blur', this._onBlur);
    document.addEventListener('pointerlockchange', this._onLockChange);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  lock() { this.canvas.requestPointerLock?.(); }
  unlock() { document.exitPointerLock?.(); }

  // ── 감도 (설정에서 바꾸면 바로 반영되고 다음에도 남는다) ──

  static loadSensitivity() {
    const v = Number(localStorage.getItem(SENS_KEY));
    return Number.isFinite(v) && v > 0 ? v : SENS_DEFAULT;
  }

  setSensitivity(v) {
    this.sensitivity = Math.max(SENS_MIN, Math.min(SENS_MAX, Number(v) || SENS_DEFAULT));
    try { localStorage.setItem(SENS_KEY, String(this.sensitivity)); } catch { /* 사생활 보호 모드 */ }
    return this.sensitivity;
  }

  setInvertY(on) {
    this.invertY = !!on;
    try { localStorage.setItem('zfps.invertY', on ? '1' : '0'); } catch { /* 무시 */ }
  }

  has(action) { return this.down.has(action); }
  took(action) { return this.pressed.has(action); }   // 이번 프레임 눌림 (한 번만 true)

  /** 마우스 누적 이동량을 가져가고 비운다. */
  takeMouse() {
    const m = { dx: this.mouse.dx, dy: this.mouse.dy };
    this.mouse.dx = this.mouse.dy = 0;
    return m;
  }

  /** 프레임 끝에서 호출 — 1회성 입력을 비운다. */
  endFrame() { this.pressed.clear(); }

  /** 서버에 보낼 이동 비트 */
  moveBits(onGround) {
    let b = 0;
    if (this.has('fwd')) b |= MV.FWD;
    if (this.has('back')) b |= MV.BACK;
    if (this.has('left')) b |= MV.LEFT;
    if (this.has('right')) b |= MV.RIGHT;
    if (this.has('sprint')) b |= MV.SPRINT;
    if (!onGround) b |= MV.AIR;
    if (this.mouse.left) b |= MV.FIRE;
    return b;
  }
}
