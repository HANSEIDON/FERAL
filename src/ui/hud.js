// HUD · 결과 화면. DOM 을 직접 만지는 곳은 여기로 몰아둔다.
//
//   왼쪽 아래   역할 · 무기, 체력(마디 막대) · 스태미나. 쓰러지면 출혈 막대(남은 시간)로 바뀐다.
//               좀비는 광폭화(R) 준비 · 발동 · 재사용 대기를 같이 보인다
//   오른쪽 아래 무기 이름 · 탄약 · 재장전 · 무기 칸
//   위          남은 시간 (시작 묶임 시간은 크게)    오른쪽 위  알림
//   화면 속     쓰러진 동료 머리 위에 출혈 막대 · 거리 (생존자에게만)
// 글자는 i18n.js 를 거친다 — 한국어 · 영어.

import { PHASE } from '../../shared/protocol.js';
import { onLangChange, reasonText, t } from './i18n.js';

const $ = (id) => document.getElementById(id);

/**
 * 값이 바뀔 때만 DOM 을 건드린다.
 *
 * HUD 갱신은 매 프레임 돌기 때문에, 그때마다 innerHTML 을 다시 쓰거나
 * style 을 건드리면 초당 60번 레이아웃을 다시 계산하게 된다. 그게 프레임을
 * 길게 만들고, 긴 프레임은 화면에서 순간이동으로 보인다.
 */
const memo = new Map();
function set(key, value, apply) {
  if (memo.get(key) === value) return;
  memo.set(key, value);
  apply(value);
}
export function resetHudCache() { memo.clear(); }

const weaponName = (spec) => (spec ? t(`w.${spec.id}`) : '');

export class Hud {
  constructor(net) {
    this.net = net;
    this.markEls = [];
    // 언어를 바꾸면 이미 그려 둔 글자(역할 · 무기 · 결과)도 다시 쓴다
    onLangChange(() => {
      memo.clear();
      if (this._role) this.setRole(...this._role);
      if (this._result) this.showResult(...this._result);
    });
  }

  // 시작 화면 · 대기실 · 일시정지는 menu.js 가 맡는다

  /** 연습 모드 표시 — 인게임 좌상단 배지 */
  setPractice(on) {
    $('practiceTag').style.display = on ? 'block' : 'none';
  }

  // ---------------------------------------------------------------- 인게임

  /** 라운드 중에만 HUD 를 보여준다 (로비에서 체력바가 비쳐 보이지 않게). */
  setInRound(on) {
    document.body.classList.toggle('in-round', on);
  }

  /** @param classId 생존자 직업 (default = SWAT, archer = 사냥꾼) */
  setRole(role, loadout, classId) {
    this._role = [role, loadout, classId];
    const z = role === 'zombie';
    $('role').textContent = z ? t('role.zombie') : t(`class.${classId ?? 'default'}`);
    $('role').className = z ? 'zombie' : 'survivor';
    if (z) $('weapon').textContent = '';   // 생존자는 지금 든 무기를 setAmmo 가 쓴다
    document.body.classList.toggle('is-zombie', z);
  }

  /** 탄약 · 재장전 표시. 주먹은 숨기고, 활 같은 무한 탄약은 ∞ 로 보여준다. */
  setAmmo(weapon, now) {
    const box = $('ammo');
    if (!weapon.spec || weapon.spec.id === 'fist') {
      set('ammo.show', 'none', (v) => { box.style.display = v; });
      return;
    }
    set('ammo.show', 'block', (v) => { box.style.display = v; });
    // 이름 옆 무기도 지금 든 무기로 — 권총으로 바꾸면 같이 바뀐다
    set('ammo.w', weaponName(weapon.spec), (v) => { $('ammoWeapon').textContent = v; $('weapon').textContent = v; });

    // 활 — 탄약이 무한이므로 ∞ 만 보여준다 (탄창·보급은 없다)
    if (weapon.infinite) {
      set('ammo.n', '∞', (v) => { $('ammoNum').textContent = v; });
      set('ammo.mag', '', (v) => { $('ammoMag').textContent = v; });
      set('ammo.res', '', (v) => { $('ammoReserve').textContent = v; });
      set('ammo.cls', '', (v) => { $('ammoNum').className = v; });
      set('reload.show', false, () => { $('reload').style.display = 'none'; });
      return;
    }

    set('ammo.n', weapon.ammo, (v) => { $('ammoNum').textContent = v; });
    set('ammo.mag', weapon.magSize, (v) => { $('ammoMag').textContent = `/ ${v}`; });
    set('ammo.res', weapon.reserve ?? 0, (v) => { $('ammoReserve').textContent = `+ ${v}`; });
    set('ammo.cls', weapon.ammo === 0 ? 'empty' : (weapon.ammo <= weapon.magSize * 0.25 ? 'low' : ''),
        (v) => { $('ammoNum').className = v; });

    set('reload.show', weapon.reloading, (v) => { $('reload').style.display = v ? 'block' : 'none'; });
    if (weapon.reloading) $('reloadFill').style.width = `${weapon.reloadProgress(now) * 100}%`;
  }

  /**
   * 프레임레이트. 낮으면 한 프레임에 훌쩍 움직여서 순간이동처럼 보인다.
   * 이상할 때 여기부터 보면 된다.
   */
  setFps(dt) {
    this._fpsAcc = (this._fpsAcc ?? 0) + dt;
    this._fpsN = (this._fpsN ?? 0) + 1;
    if (this._fpsAcc < 0.4) return;
    const fps = this._fpsN / this._fpsAcc;
    const el = $('fps');
    set('fps.txt', Math.round(fps), (v) => { el.textContent = `${v} fps`; });
    set('fps.cls', fps < 40 ? 'bad' : '', (v) => { el.className = v; });
    this._fpsAcc = 0;
    this._fpsN = 0;
  }

  /** 충전 게이지 0~1 (좀비=슈퍼점프, 생존자=활 장전). 0 이면 숨긴다. labelKey 는 i18n 키 */
  setCharge(p, labelKey) {
    const box = $('chargeBar');
    set('charge.show', p > 0, (v) => { box.style.display = v ? 'block' : 'none'; });
    if (labelKey) set('charge.label', t(labelKey), (v) => { box.querySelector('span').textContent = v; });
    if (p <= 0) return;
    set('charge.w', Math.round(Math.min(1, p) * 100), (v) => { $('chargeFill').style.width = `${v}%`; });
    set('charge.cls', p >= 1 ? 'full' : '', (v) => { $('chargeFill').className = v; });
  }

  /** 무기 칸 표시. 좀비는 숨긴다. */
  setSlots(weapon) {
    const box = $('slots');
    if (!weapon.slots || weapon.slots.length < 2) {
      set('slots.show', 'none', (v) => { box.style.display = v; });
      return;
    }
    set('slots.show', 'flex', (v) => { box.style.display = v; });
    // 칸 내용은 무기를 바꿀 때만 바뀐다. 매 프레임 다시 쓸 이유가 없다.
    const key = weapon.slots.map((s) => weaponName(s.spec)).join('|') + '#' + weapon.index;
    set('slots.html', key, () => {
      box.innerHTML = weapon.slots.map((s, i) =>
        `<span class="slot ${i === weapon.index ? 'on' : ''}"><b>${i + 1}</b>${weaponName(s.spec)}</span>`
      ).join('');
    });
  }

  /** 일으키기 진행률 0~1. 0 이면 숨긴다. */
  setRevive(p) {
    const box = $('reviveBar');
    set('rev.show', p > 0, (v) => { box.style.display = v ? 'block' : 'none'; });
    if (p <= 0) return;
    set('rev.w', Math.round(Math.min(1, p) * 100), (v) => { $('reviveFill').style.width = `${v}%`; });
  }

  /**
   * 조준점 상태 — 근접 무기가 "지금 때리면 맞나"를 미리 보여준다.
   * '' 기본 · 'hot' = 사거리+각도 OK (때리면 명중) · 'near' = 보이나 사거리 밖
   */
  crossState(s) {
    if (this._crossState === s) return;
    this._crossState = s;
    document.body.classList.toggle('cross-hot', s === 'hot');
    document.body.classList.toggle('cross-near', s === 'near');
  }

  /** 맞췄을 때 조준점에 X 표시 */
  hitmark(head) {
    const el = $('hitmark');
    el.className = head ? 'show head' : 'show';
    clearTimeout(this._hitTimer);
    this._hitTimer = setTimeout(() => { el.className = ''; }, 140);
  }

  /** 내가 맞았을 때 화면 가장자리 붉은 섬광 */
  flashDamage() {
    const el = $('damage');
    el.classList.remove('on');
    void el.offsetWidth;          // 애니메이션 재시작
    el.classList.add('on');
  }

  setVitals(hp, maxHp, stamina, maxStamina) {
    const frac = Math.max(0, hp / maxHp);
    set('hp.w', Math.round(frac * 100), (v) => { $('hpFill').style.width = `${v}%`; });
    set('hp.n', Math.max(0, Math.round(hp)), (v) => { $('hpText').textContent = v; });
    // 체력 30% 아래 — 화면 가장자리가 붉게 맥박친다
    set('hp.low', hp > 0 && frac < 0.3, (v) => document.body.classList.toggle('low-hp', v));

    const hasStam = maxStamina > 0;
    set('stam.show', hasStam, (v) => { $('stamina').style.display = v ? '' : 'none'; });
    if (hasStam) {
      set('stam.w', Math.round((stamina / maxStamina) * 100),
          (v) => { $('stamFill').style.width = `${v}%`; $('stamina').classList.toggle('low', v < 25); });
    }
  }

  /**
   * 쓰러진 동안의 출혈 막대 — 체력 대신 "죽기까지 남은 시간"을 보인다.
   * @param left 남은 초 (null 이면 쓰러지지 않음)  @param total 전체 출혈 시간
   */
  setDowned(left, total) {
    const on = left != null;
    set('down.on', on, (v) => document.body.classList.toggle('is-downed', v));
    if (!on) return;
    set('down.w', Math.round(Math.max(0, left / total) * 100), (v) => { $('bleedFill').style.width = `${v}%`; });
    set('down.n', Math.max(0, Math.ceil(left)), (v) => { $('bleedText').textContent = `${v}s`; });
  }

  /**
   * 좀비 광폭화(R) 상태.
   * @param s { active: 남은 발동 초 | 0, cooldown: 남은 대기 초 | 0, total: 막대 기준 초 }
   */
  setRage(s) {
    const el = $('abil');
    const state = s.active > 0 ? 'active' : (s.cooldown > 0 ? 'cd' : 'ready');
    set('rage.state', state, (v) => { el.className = v; });
    const frac = s.active > 0 ? s.active / s.total : (s.cooldown > 0 ? 1 - s.cooldown / s.total : 1);
    set('rage.w', Math.round(frac * 100), (v) => { $('rageFill').style.width = `${v}%`; });
    const text = state === 'ready' ? t('ready') : `${Math.ceil(s.active > 0 ? s.active : s.cooldown)}s`;
    set('rage.t', text, (v) => { $('rageText').textContent = v; });
  }

  /**
   * 쓰러진 동료 표시 — 화면 좌표로 받은 목록을 머리 위 표식으로 그린다.
   * @param list [{ x, y (화면 px), frac (출혈 남은 비율), dist (m) }]
   */
  setMarks(list) {
    const box = $('marks');
    while (this.markEls.length < list.length) {
      const el = document.createElement('div');
      el.className = 'mark';
      el.innerHTML = `<div class="ic"></div><div class="lb"></div><div class="bar"><i></i></div><div class="d"></div>`;
      box.appendChild(el);
      this.markEls.push(el);
    }
    this.markEls.forEach((el, i) => {
      const m = list[i];
      el.style.display = m ? '' : 'none';
      if (!m) return;
      el.style.left = `${m.x}px`;
      el.style.top = `${m.y}px`;
      el.querySelector('.lb').textContent = t('down');
      el.querySelector('.bar i').style.width = `${Math.round(Math.max(0, m.frac) * 100)}%`;
      el.querySelector('.d').textContent = `${Math.round(m.dist)}m`;
    });
  }

  setTimer(phase, left, hold) {
    const el = $('timer');
    if (phase !== PHASE.PLAYING) { set('timer.txt', '', (v) => { el.textContent = v; }); return; }
    if (hold > 0) {
      set('timer.txt', `${Math.ceil(hold)}`, (v) => { el.textContent = v; });
      set('timer.cls', 'hold', (v) => { el.className = v; });
      set('hold.show', true, () => { $('holdHint').style.display = 'block'; });
    } else {
      const m = Math.floor(left / 60);
      const s = Math.floor(left % 60);
      set('timer.txt', `${m}:${String(s).padStart(2, '0')}`, (v) => { el.textContent = v; });
      set('timer.cls', left < 20 ? 'urgent' : '', (v) => { el.className = v; });
      set('hold.show', false, () => { $('holdHint').style.display = 'none'; });
    }
  }

  showResult(winner, reason) {
    this._result = [winner, reason];
    const box = $('result');
    box.style.display = 'block';
    box.className = winner === 'zombie' ? 'zombie' : 'survivor';
    $('resultTitle').textContent = t(`win.${winner === 'zombie' ? 'zombie' : 'survivor'}`);
    $('resultWhy').textContent = reasonText(reason);
  }

  hideResult() { this._result = null; $('result').style.display = 'none'; }

  toast(text, kind = '') {
    const li = document.createElement('li');
    li.textContent = text;
    li.className = kind;
    $('feed').replaceChildren(li);   // 한 번에 한 줄 — 겹쳐 쌓지 않는다
    setTimeout(() => li.remove(), 4000);
  }

  setHint(text) {
    $('hint').textContent = text ?? '';
    $('hint').style.display = text ? 'block' : 'none';
  }
}
