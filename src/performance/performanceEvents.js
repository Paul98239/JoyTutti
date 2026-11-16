// performanceEvents.js — 演奏的對外事件（PerformanceEvents）與標準訂閱者：遲到統計、早按處理統計、按鍵記錄、錄音用的事件記錄。排程器（scheduler.js）建立並使用。

import { summarizeMs } from './tempo.js';

// 演奏的對外事件：排程器在 trigger()／tick()／暫停等呼叫裡先把事件排隊，呼叫結束、合成器的呼叫都送出之後才發給訂閱者（flush），訂閱者的工作不會擋在你的音前面；訂閱者丟的例外被隔離，不影響演奏。

// 量測／記錄各留最近一批（超過丟最舊的），避免長時間播放無限成長；事件記錄每顆音一筆，一首最密的歌整首約一萬多筆
const LATE_SAMPLES_MAX = 5000;
const PRESS_LOG_MAX = 20000;
const EVENT_LOG_MAX = 100000;
// 滿了一次丟最舊的八分之一而不是每筆 shift()：大陣列的 shift() 是 O(n)（10 萬筆實測每筆約 0.3ms），攤銷後每筆 O(1)。
function pushCapped(arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - (max - (max >> 3)));
}

// 每次按鍵都會走過排隊與派送（trigger() 的執行時間直接加在按下到出聲上），所以這裡刻意寫得省：沒有人訂閱的種類不排隊、
// 佇列裡種類與 payload 交錯放（不另建 [種類, payload] 小陣列）、派送用索引迴圈（不建迭代器）。
export class PerformanceEvents {
  constructor() {
    this._subscribers = new Map();   // 事件種類 → 回呼陣列（訂閱、取消時換成新的陣列：正在派送的那一輪照舊陣列跑完，新的訂閱下一個事件才生效）
    this._queue = [];                // 排隊中、還沒發的事件：種類, payload, 種類, payload…
  }

  /** 訂閱一種事件，回傳取消訂閱的函式。同一個回呼重複訂閱只算一次。 */
  on(type, fn) {
    const subs = this._subscribers.get(type) || [];
    if (!subs.includes(fn)) this._subscribers.set(type, [...subs, fn]);
    return () => this._subscribers.set(type, (this._subscribers.get(type) || []).filter((f) => f !== fn));
  }

  /** 這種事件現在有沒有人訂閱：內容要另外組、又很頻繁的種類（control）先問，沒有人訂閱就連內容都不組。 */
  has(type) {
    const subs = this._subscribers.get(type);
    return subs !== undefined && subs.length > 0;
  }

  // 排一個事件。排隊當下沒有人訂閱的種類直接略過（演奏時只有統計訂閱 noteOn／press／chase，其餘的不排隊也不派送）。
  queue(type, payload) {
    const subs = this._subscribers.get(type);
    if (subs !== undefined && subs.length > 0) this._queue.push(type, payload);
  }

  // 把排隊的事件依序發出。先把佇列換掉再發：訂閱者裡如果又呼叫了排程器（又排了事件），那些事件下一次 flush 才發，不會亂序。
  flush() {
    if (!this._queue.length) return;
    const pending = this._queue;
    this._queue = [];
    for (let i = 0; i < pending.length; i += 2) {
      const type = pending[i], payload = pending[i + 1], subs = this._subscribers.get(type);
      for (let k = 0; k < subs.length; k++) {
        try { subs[k](payload); } catch (err) { console.error(`演奏事件「${type}」的訂閱者出錯（已略過，不影響演奏）：`, err); }
      }
    }
  }
}

/** 標準訂閱者：tick() 放出的電腦音比排好的時刻晚了多少（見 scheduler.js 的 lateStats()）。 */
export function lateStatsSubscriber(events) {
  const sub = { samples: [], stats() { return summarizeMs(this.samples); }, reset() { this.samples = []; } };
  events.on('noteOn', (e) => {
    // 只記 tick() 放出的電腦音：按鍵呼叫內同刻放出的音（時鐘就是按下的那一刻）沒有「等 tick」這回事，記進去只會把統計稀釋成 0；
    // 組裡到點放出的你的音不是電腦音。
    if (e.fromTick && e.kind === 'assist') {
      pushCapped(sub.samples, e.lateMs, LATE_SAMPLES_MAX);
    }
  });
  return sub;
}

/** 標準訂閱者：你早按時的追音、跳過與取消不了的組內音（見 scheduler.js 的 chaseStats()）。 */
export function chaseStatsSubscriber(events) {
  const zero = () => ({ presses: 0, chased: 0, skipped: 0, inFlight: 0 });
  const sub = { counts: zero(), stats() { return { ...this.counts }; }, reset() { this.counts = zero(); } };
  events.on('chase', (e) => {
    sub.counts.presses++;
    sub.counts.chased += e.chased.length;
    sub.counts.skipped += e.skipped.length;
    sub.counts.inFlight += e.inFlight;
  });
  return sub;
}

/** 標準訂閱者：每次按鍵嘗試與每次放開的記錄（見 scheduler.js 的 pressLog()、liftLog()）。 */
export function pressLogSubscriber(events) {
  const sub = {
    entries: [], lifts: [],
    log() { return this.entries.map((p) => ({ ...p })); },
    liftLog() { return this.lifts.map((p) => ({ ...p })); },
    reset() { this.entries = []; this.lifts = []; },
  };
  events.on('press', (e) => {
    pushCapped(sub.entries, { slot: e.slot, clockMs: e.clockMs, released: e.result === 'released', result: e.result, jumped: e.jumped, source: e.source, key: e.key, eventTimeMs: e.eventTimeMs, receivedMs: e.receivedMs }, PRESS_LOG_MAX);
  });
  events.on('lift', (e) => {
    pushCapped(sub.lifts, { slot: e.slot, key: e.key, clockMs: e.clockMs, closed: e.closed, eventTimeMs: e.eventTimeMs, receivedMs: e.receivedMs }, PRESS_LOG_MAX);
  });
  return sub;
}

/**
 * 錄音用的事件記錄（enableEventLog() 才掛）：錨點與換錨（速度）、放行、每顆音實際發聲與收音的時刻、早按處理，存成可轉 JSON 的小物件，音符用 id（「軌序號:軌內序號」，同一版 parser 解析同一個檔一定相同）。
 * 實際發聲時刻（排程器時鐘）：帶時間戳的電腦音在時間戳發聲（時間戳已經過去就在送出的當下），其餘在送出的當下；收音時刻同理（沒有排定時刻的收音，例如 hold 著的音被暫停收掉，記送出的當下）。
 */
export function eventLogSubscriber(events) {
  const sub = { entries: [], log() { return this.entries.map((e) => ({ ...e })); }, reset() { this.entries = []; } };
  const push = (entry) => pushCapped(sub.entries, entry, EVENT_LOG_MAX);
  const ids = (notes) => notes.map((n) => n.id ?? null);
  events.on('anchor', (e) => push({ type: 'anchor', group: e.group, slice: e.slice, clockMs: e.clockMs, scoreSec: e.scoreSec, rate: e.rate }));
  events.on('reanchor', (e) => push({ type: 'reanchor', group: e.group, slice: e.slice, clockMs: e.clockMs, scoreSec: e.scoreSec, rate: e.rate }));
  events.on('release', (e) => push({ type: 'release', group: e.group, index: e.index, ticks: e.ticks, clockMs: e.clockMs }));
  events.on('group', (e) => push({ type: 'group', group: e.group, index: e.index, merged: e.merged.map((m) => m.index), clockMs: e.clockMs }));
  events.on('autoRelease', (e) => push({ type: 'autoRelease', group: e.group, index: e.index, ticks: e.ticks, dueMs: e.dueMs, clockMs: e.clockMs }));
  events.on('noteOn', (e) => push({ type: 'noteOn', noteId: e.noteId, staffId: e.staffId, kind: e.kind, atMs: e.timed ? Math.max(e.dueMs, e.clockMs) : e.clockMs }));
  events.on('noteOff', (e) => push({ type: 'noteOff', noteId: e.noteId, staffId: e.staffId, kind: e.kind, atMs: e.timed && Number.isFinite(e.offMs) ? Math.max(e.offMs, e.clockMs) : e.clockMs }));
  events.on('chase', (e) => push({ type: 'chase', group: e.group, ticks: e.ticks, chased: ids(e.chased), skipped: ids(e.skipped) }));
  events.on('leader', (e) => push({ type: 'leader', from: e.from, to: e.to, reason: e.reason, clockMs: e.clockMs }));
  events.on('performer', (e) => push({ type: 'performer', slot: e.slot, from: e.from, to: e.to, reason: e.reason, clockMs: e.clockMs }));
  events.on('presence', (e) => push({ type: 'presence', slots: e.slots, clockMs: e.clockMs, receivedMs: e.receivedMs }));
  return sub;
}
