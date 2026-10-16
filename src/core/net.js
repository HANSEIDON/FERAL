// 서버 연결. 메시지를 종류별로 나눠주고, 끊기면 알아서 다시 붙는다.

import { decode, encode } from '../../shared/protocol.js';

export class Net {
  constructor() {
    this.ws = null;
    this.id = 0;
    this.config = null;
    this.classes = [];
    this.connected = false;

    /** @type {Map<string, Set<Function>>} */
    this.handlers = new Map();

    // 서버 시계와의 차이. 라운드 타이머를 부드럽게 보여주려고 잰다.
    this.clockOffset = 0;

    this._retry = 0;
    this._closed = false;
  }

  /**
   * 개발 중엔 Vite 가 /ws 를 게임서버로 프록시한다. 배포하면 같은 오리진이다.
   * itch.io 처럼 화면만 다른 곳에 올릴 땐 빌드할 때 VITE_SERVER_URL 로 게임 서버를 박아 넣는다.
   */
  static url() {
    if (import.meta.env.VITE_SERVER_URL) return import.meta.env.VITE_SERVER_URL;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type).delete(fn);
  }

  emit(type, msg) {
    for (const fn of this.handlers.get(type) ?? []) {
      try { fn(msg); } catch (e) { console.error(`[net] ${type} 핸들러 오류`, e); }
    }
  }

  connect() {
    this._closed = false;
    const ws = new WebSocket(Net.url());
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this._retry = 0;
      this.emit('open', {});
    };

    ws.onmessage = (e) => {
      const m = decode(e.data);
      if (!m) return;
      if (m.t === 'welcome') {
        this.id = m.id;
        this.config = m.config;
        this.classes = m.classes ?? [];
      }
      // 서버 시계 맞추기 — 받을 때마다 (서버 시각 - 내 시각) 을 잰다. 값은 지연만큼 작게 나오므로
      // 지연이 가장 짧았던 쪽(큰 값)으로 빨리, 반대쪽으론 아주 천천히(시계가 흐르는 만큼만) 따라간다.
      // 예전엔 라운드 시작 때 한 번 잰 값을 그대로 써서, 그 순간의 지연이 판 내내 남았다.
      const sn = m.serverNow ?? (m.t === 'state' ? m.now : undefined);
      if (typeof m.t === 'string' && typeof sn === 'number') {
        const sample = sn - Date.now() / 1000;
        if (!this._synced) { this.clockOffset = sample; this._synced = true; }
        else this.clockOffset += (sample - this.clockOffset) * (sample > this.clockOffset ? 0.25 : 0.01);
      }
      this.emit(m.t, m);
    };

    ws.onclose = () => {
      this.connected = false;
      this.emit('close', {});
      if (this._closed) return;
      // 서버를 다시 켰을 때 알아서 붙게 한다 (개발 중에 자주 있는 일)
      this._retry = Math.min(this._retry + 1, 6);
      setTimeout(() => this.connect(), 400 * this._retry);
    };

    ws.onerror = () => ws.close();
  }

  close() {
    this._closed = true;
    this.ws?.close();
  }

  send(type, data) {
    if (this.ws?.readyState === 1) this.ws.send(encode(type, data));
  }

  /** 서버 기준 현재 시각(초). 라운드 남은 시간 계산에 쓴다. */
  serverTime() {
    return Date.now() / 1000 + this.clockOffset;
  }
}
