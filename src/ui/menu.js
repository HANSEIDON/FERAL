// 시작 화면 · 메인 메뉴 · 대기실(캐릭터 선택) · 일시정지.
//
//   타이틀   키아트 + PRESS ANY KEY → 아무 키나 누르면 왼쪽 어둠 속에서 메뉴가 나온다
//   메인     닉네임 · 게임 시작 · 설정 · 언어
//   대기실   생존자 캐릭터 고르기(사냥꾼 · SWAT) · 참가자 · 게임 시작(2명 이상) · 연습 게임
//            좀비는 고르지 않는다 — 라운드가 시작될 때 생존자 중 한 명이 무작위로 된다
//   일시정지 라운드 중 Esc — 계속하기 · 설정 · (연습이면) 연습 끝내기
//
// 서버와 주고받는 건 예전 메뉴와 같다 (JOIN · PICK · START · endPractice).

import { C } from '../../shared/protocol.js';
import { applyI18n, getLang, LANGS, onLangChange, setLang, t } from './i18n.js';

const $ = (id) => document.getElementById(id);

// 서버 직업 id → 화면 카드
const HEROES = { archer: 'hunter', default: 'swat' };

// 연습 더미 행동 — 좀비로 연습하면(더미 = 생존자) 달려드는 행동은 뺀다
const BEHAVIORS = { survivor: ['hunt', 'still', 'chase', 'flee'], zombie: ['still', 'flee'] };

export class Menu {
  constructor({ net, input, sound, onEndPractice, onScreen, onSound }) {
    this.net = net;
    this.input = input;
    this.sound = sound;
    this.onEndPractice = onEndPractice;
    this.onScreen = onScreen;
    this.onSound = onSound;
    this.joined = false;
    this.selectedClass = 'default';
    this.lobby = null;
    this.screen = null;

    applyI18n();
    this._title();
    this._main();
    this._settings();
    this._language();
    this._lobby();
    this._pause();
    this._sounds();
    $('rcAccept').onclick = () => { this.net.send(C.ACCEPT, { ok: true }); $('rcheck').classList.add('waiting'); };
    $('rcDecline').onclick = () => this.net.send(C.ACCEPT, { ok: false });
    onLangChange(() => { this._renderBehaviors(); if (this.lobby) this.renderLobby(this.lobby); });
    this.show('title');
  }

  // ---------------------------------------------------------------- 화면 전환

  /** 'title' | 'main' | 'lobby' | 'pause' | null (숨김) */
  show(screen) {
    this.screen = screen;
    this.onScreen?.(screen);
    const ui = $('ui');
    ui.dataset.screen = screen ?? '';
    ui.style.display = screen ? 'block' : 'none';
    if (screen === 'title' || screen === 'main') $('scrTitle').classList.toggle('open', screen === 'main');
    if (screen === 'main') this._panel('mainList');
  }

  showLobby() { this.show('lobby'); }
  hide() { this.show(null); }

  showPause(practice) {
    $('pEnd').style.display = practice ? '' : 'none';
    this._pausePanel('pauseList');
    this.show('pause');
  }

  // ---------------------------------------------------------------- 타이틀 · 메인

  _title() {
    const open = (e) => {
      if (this.screen !== 'title') return;
      if (e.type === 'keydown' && (e.repeat || e.key === 'Tab')) return;
      this.onSound?.('whoosh');
      this.show('main');
      setTimeout(() => $('mPlay').focus(), 50);
    };
    addEventListener('keydown', open);
    $('scrTitle').addEventListener('pointerdown', open);
  }

  _main() {
    const name = $('name');
    name.value = localStorage.getItem('zfps.name') ?? '';
    $('mPlay').onclick = () => {
      if (!name.value.trim()) { name.focus(); name.classList.add('shake'); setTimeout(() => name.classList.remove('shake'), 400); return; }
      this.join();
      this.showLobby();
    };
    name.onkeydown = (e) => { if (e.key === 'Enter') $('mPlay').onclick(); };
    // 들어간 뒤에도 바꿀 수 있다 — 서버는 JOIN 을 다시 받으면 이름만 바꾼다
    name.onchange = () => { if (this.joined && name.value.trim()) this.rejoin(); };
    $('mSettings').onclick = () => this._panel('settingsBox', 'mainPanel');
    $('mLang').onclick = () => this._panel('langList');
    for (const b of document.querySelectorAll('#mainPanel [data-back]')) b.onclick = () => this._panel('mainList');

    // 위 · 아래 화살표로 메뉴를 옮겨 다닌다
    $('mainPanel').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = [...document.querySelectorAll('#mainPanel .view.on .mi')];
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      e.preventDefault();
    });
  }

  /** 메인 패널 안에서 목록 하나만 보인다. 설정 상자는 메인 · 일시정지가 같이 쓴다. */
  _panel(id, host = 'mainPanel') {
    if (id === 'settingsBox') $(host === 'mainPanel' ? 'settingsSlotMain' : 'settingsSlotPause').appendChild($('settingsBox'));
    for (const v of document.querySelectorAll(`#${host} .view`)) v.classList.toggle('on', v.id === id || (id === 'settingsBox' && !!v.dataset.settings));
    setTimeout(() => document.querySelector(`#${host} .view.on .mi`)?.focus(), 30);
  }

  _settings() {
    const sens = $('sens'), val = $('sensVal'), inv = $('invertY');
    const showVal = () => { val.textContent = (this.input.sensitivity * 1000).toFixed(1); };
    sens.value = String(this.input.sensitivity);
    inv.checked = this.input.invertY;
    showVal();
    // 움직이는 즉시 반영된다 — 게임 중 Esc 로 열어 맞추기 좋게
    sens.oninput = () => { this.input.setSensitivity(+sens.value); showVal(); };
    inv.onchange = () => this.input.setInvertY(inv.checked);

    // 소리 크기 — 전체 · 효과음 · 음악 (0~100)
    for (const kind of ['master', 'sfx', 'music']) {
      const el = $(`vol_${kind}`), out = $(`vol_${kind}Val`);
      const v = this.sound?.vol?.[kind] ?? 1;
      el.value = String(Math.round(v * 100));
      out.textContent = el.value;
      el.oninput = () => { out.textContent = el.value; this.sound?.setVolume(kind, +el.value / 100); };
    }
  }

  _language() {
    const box = $('langOpts');
    box.innerHTML = LANGS.map((l) => `<button class="mi lang" data-lang="${l.id}">${l.label}</button>`).join('');
    const mark = () => box.querySelectorAll('.lang').forEach((b) => b.classList.toggle('on', b.dataset.lang === getLang()));
    box.querySelectorAll('.lang').forEach((b) => { b.onclick = () => { setLang(b.dataset.lang); mark(); }; });
    mark();
  }

  /**
   * 메뉴 소리 — 버튼 위에 올리면 hover, 누르면 click. 화면이나 패널이 바뀌는 버튼은
   * data-sfx="whoosh" 를 달아 둔다 (index.html). 비활성 버튼은 소리를 내지 않는다.
   */
  _sounds() {
    const ui = $('ui');
    const target = (e) => e.target.closest?.('button:not(:disabled), .hero[data-class], select');
    let over = null;
    ui.addEventListener('pointerover', (e) => {
      const el = target(e);
      if (el && el !== over) this.onSound?.('hover');
      over = el;
    });
    ui.addEventListener('click', (e) => {
      const el = target(e);
      if (el && el.tagName !== 'SELECT') this.onSound?.(el.dataset.sfx === 'whoosh' || el.hasAttribute('data-back') ? 'whoosh' : 'click');
    });
  }

  // ---------------------------------------------------------------- 서버

  join() {
    if (this.joined) return;
    const name = $('name').value.trim() || 'Player';
    localStorage.setItem('zfps.name', name);
    this.joined = true;
    this.net.send(C.JOIN, { name });
  }

  /** 재접속 때 다시 입장한다 */
  rejoin() {
    if (!this.joined) return;
    const name = $('name').value.trim() || 'Player';
    localStorage.setItem('zfps.name', name);
    this.net.send(C.JOIN, { name });
  }

  setConnection(ok) {
    for (const el of document.querySelectorAll('.conn')) {
      el.dataset.i18n = ok ? 'online' : 'offline';
      el.textContent = t(el.dataset.i18n);
      el.classList.toggle('ok', ok);
    }
  }

  /** 서버가 열어 둔 직업만 카드를 보인다 */
  renderClasses(classes) {
    const ids = new Set(classes.map((c) => c.id));
    for (const card of document.querySelectorAll('.hero[data-class]')) card.style.display = ids.has(card.dataset.class) ? '' : 'none';
  }

  renderLobby(msg) {
    this.lobby = msg;
    const me = msg.players.find((p) => p.id === this.net.id);
    if (me?.classId && me.classId !== this.selectedClass) this._select(me.classId, false);
    $('squadCount').textContent = `${msg.players.length}/8`;
    $('roster').innerHTML = msg.players.map((p) => {
      const hero = HEROES[p.classId] ?? 'swat';
      return `<li class="${p.id === this.net.id ? 'me' : ''}">
        <span class="rn">${escapeHtml(p.name)}</span>
        ${p.id === this.net.id ? `<em>${t('you')}</em>` : ''}
        <span class="rc">${t(`${hero}.name`)}</span></li>`;
    }).join('');
    const start = $('lStart');
    start.disabled = !msg.canStart;
    start.querySelector('small').textContent = msg.canStart ? '' : t('needPlayers');
    $('pStart').disabled = !msg.canPractice;
  }

  /** 수락 확인 (서버 'check' 이벤트) — 롤처럼 전원 수락해야 시작한다 */
  readyCheck(m) {
    const box = $('rcheck'), me = this.net.id;
    clearInterval(this._rcTimer);
    if (m.cancel || m.done) {
      box.classList.remove('on', 'waiting');
      if (m.cancel) {
        const st = $('lStart').querySelector('small');
        st.textContent = t(`check.${m.reason}`, { name: m.name });
        setTimeout(() => { if (this.lobby) this.renderLobby(this.lobby); }, 3000);
      }
      return;
    }
    if (!m.ids.includes(me)) return;   // 확인이 시작된 뒤에 들어온 사람은 구경만
    if (!box.classList.contains('on')) { box.classList.add('on'); this.sound?.ui('whoosh'); }
    const mine = m.accepted.includes(me);
    box.classList.toggle('waiting', mine);
    $('rcDots').innerHTML = m.ids.map((_, i) => `<b class="${i < m.accepted.length ? 'ok' : ''}"></b>`).join('');
    $('rcStatus').textContent = mine ? t('check.waiting', { n: m.accepted.length, total: m.ids.length }) : '';
    // 남은 시간 막대 — 서버가 준 남은 초에서 줄여 나간다
    const end = performance.now() + m.left * 1000, bar = $('rcBar');
    const tick = () => { bar.style.transform = `scaleX(${Math.max(0, (end - performance.now()) / (m.total * 1000))})`; };
    tick();
    this._rcTimer = setInterval(tick, 50);
  }

  // ---------------------------------------------------------------- 대기실

  _lobby() {
    for (const card of document.querySelectorAll('.hero[data-class]')) card.onclick = () => this._select(card.dataset.class, true);
    $('lBack').onclick = () => this.show('main');
    $('lStart').onclick = () => this.net.send(C.START, {});
    $('lPractice').onclick = () => $('practiceBox').classList.toggle('open');
    $('pRole').onchange = () => this._renderBehaviors();
    this._renderBehaviors();
    $('pStart').onclick = () => {
      const zombie = $('pRole').value === 'zombie';
      this.net.send(C.START, {
        practice: true,
        role: zombie ? 'zombie' : 'survivor',
        classId: this.selectedClass,
        dummies: +$('pCount').value,
        behavior: $('pBehavior').value,
      });
    };

    // 마우스를 따라 캐릭터가 살짝 움직인다 (깊이감)
    $('scrLobby').addEventListener('pointermove', (e) => {
      const x = e.clientX / innerWidth - 0.5, y = e.clientY / innerHeight - 0.5;
      $('scrLobby').style.setProperty('--px', x.toFixed(3));
      $('scrLobby').style.setProperty('--py', y.toFixed(3));
    });
    this._select(this.selectedClass, false);
  }

  _select(classId, send) {
    this.selectedClass = classId;
    for (const card of document.querySelectorAll('.hero[data-class]')) card.classList.toggle('on', card.dataset.class === classId);
    if (send) this.net.send(C.PICK, { classId });
  }

  _renderBehaviors() {
    const el = $('pBehavior'), prev = el.value;
    const list = BEHAVIORS[$('pRole').value === 'zombie' ? 'zombie' : 'survivor'];
    el.innerHTML = list.map((b) => `<option value="${b}">${t(`bh.${b}`)}</option>`).join('');
    el.value = list.includes(prev) ? prev : list[0];
    $('pCount').querySelector('[value="0"]').textContent = t('dummyNone');
  }

  // ---------------------------------------------------------------- 일시정지

  _pause() {
    $('pResume').onclick = () => this.input.lock();
    $('pSettings').onclick = () => this._pausePanel('settingsBox');
    $('pEnd').onclick = () => this.onEndPractice?.();
    for (const b of document.querySelectorAll('#pausePanel [data-back]')) b.onclick = () => this._pausePanel('pauseList');
  }

  _pausePanel(id) { this._panel(id, 'pausePanel'); }

  // ---------------------------------------------------------------- 진단

  /** [debug] ?autostart= — 이름을 채우고 바로 연습을 시작한다 */
  autostart(role) {
    if (!$('name').value) $('name').value = 'debug';
    this.join();
    this.showLobby();
    const archer = role === 'survivor-archer';
    if (archer) this._select('archer', true);
    $('pRole').value = role === 'zombie' ? 'zombie' : 'survivor';
    this._renderBehaviors();
    setTimeout(() => $('pStart').onclick(), 400);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
