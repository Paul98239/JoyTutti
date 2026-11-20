// scheduler.js — 排程器（單位 MIDI tick）：每位演奏者（driver）按一下放行他聲部的下一個起音，伴奏（follower）跟帶頭的人的速度。
// 你的音在 trigger() 內同步 noteOn、不帶時間戳（預按鎖住的那一下除外，到點由 tick() 放出）；時鐘 _clockMs 只在 tick()／trigger()／lift() 前進，暫停不走。
// 輸入帶 key（鍵盤）＝keyup 模式：按下 noteOn、放開 noteOff、不 hold。沒有 driver 時整首自動播放（同一條路徑的第 0 段）。合成器呼叫都經 voices.js。

import { TempoFollower, CHORD_SPREAD_S, minPressIntervalSec, maxGroupSpanSec } from './tempo.js';
import { OutputRouter, portsFor, VoiceLedger, scaledMs, EPS_MS } from './voices.js';
import { buildPlan, staffPools, sliceOfTick, switchesKit, stateEvents, emptyPerformerPlan, slotOrder } from './performancePlan.js';
import { ChannelStateTracker, chaseEventsAt, DRUM_CHANNEL } from '../midi/midiParser.js';
import { ENSEMBLE, threshold, beatMs, isActive, Roster, pickLeader, classifyOffset, stage1GraceMs, shouldSubstitute, extendSteadyRun, isSteadyRun } from './ensemble.js';
import { PerformanceEvents, lateStatsSubscriber, chaseStatsSubscriber, pressLogSubscriber, eventLogSubscriber } from './performanceEvents.js';

export { CHANNELS_PER_PORT, DEFAULT_PORTS } from './voices.js';

export const DEFAULT_SCHEDULER_CONFIG = Object.freeze({
  drumChannel: DRUM_CHANNEL,
  // 預報跟目前預計差不到這麼多（ms）就不換錨，免得每個 tick 都重排（應用層數字）
  forecastMinChangeMs: 10,
  stage2K: ENSEMBLE.STAGE2_K,   // 錯過幾下才代打（ensemble.js 的 shouldSubstitute）
  // dev 開關（預設全關，使用者實機比較後才定）；load()／reassign() 時才讀。keyboard＝PC 鍵盤手，gesture＝揮手與其他槽位觸發。
  //   oneSlice：一下一個垂直切片（只留和弦門檻，不做按不及的分組）；holdToNext：他的音一律響到他的下一個起音（鍵盤也不再用放開鍵收音）
  modes: Object.freeze({
    keyboard: Object.freeze({ oneSlice: false, holdToNext: false }),
    gesture: Object.freeze({ oneSlice: false, holdToNext: false }),
  }),
});

// 控制器 ev 在檔案裡是否早於這顆音的 note on（tick → 軌序 → 軌內序，同 parser 的 byFileOrder）
const fileBefore = (ev, note) => ev.ticks < note.startTick
  || (ev.ticks === note.startTick && (ev.trackIndex < note.trackIndex || (ev.trackIndex === note.trackIndex && ev.eventIndex < note.eventIndex)));

// 合併兩個依 dueMs 排好的佇列（穩定：同一刻 a 在前，自動放行排在控制器前面）
function mergeByDue(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) out.push(j >= b.length || (i < a.length && a[i].dueMs <= b[j].dueMs) ? a[i++] : b[j++]);
  return out;
}

// 第一個 ≥ x 的位置（x 可以是 ±Infinity）
function lowerBound(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

// 第一個 > x 的位置
function upperBound(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] <= x) lo = mid + 1; else hi = mid; }
  return lo;
}

const itemTick = (it) => (it.note ? it.note.startTick : it.ev ? it.ev.ticks : it.ticks);
// 幾個佇列攤平成建批次的順序（seq）：早按時的追音與跳過照這個順序
const bySeq = (...queues) => queues.flat().sort((x, y) => x.seq - y.seq);

// 鍵盤的演奏者槽位（揮手是數字 1～4，鍵盤用字串，兩者可並存）
export const KEYBOARD_SLOT = 'kb';

// 發聲方式 mode：{ key }＝等這個鍵放開才收；LIFTED＝keyup 模式但不等鍵（照檔案音長收、不 hold）；null＝非 keyup（有 hold）
const LIFTED = Object.freeze({ key: null });
const keyupOf = (key) => (key != null ? { key } : null);

// 每個 tick 時鐘最多前進這麼多：背景分頁被節流後恢復時，不一次把空窗期的音全部放出或收掉（應用層數字）
const MAX_TICK_DT_MS = 100;
// 電腦音提早這麼久帶時間戳送進 worklet，主執行緒卡住也不會晚；代價是送出就取消不了（core 的 eventQueue 只有 push／shift）。
// 50ms：蓋過實機量到的主執行緒停頓（攝影機開著最大約 40ms）的最小值。devStats.js 的 __latency() 拿它當 tick 間隔門檻。
export const LOOKAHEAD_MS = 50;

// 這首歌至少要幾個 port（≥ DEFAULT_PORTS）：兩個合成器各自算、取大的（voices.js 的 portsFor()）
export function portsNeeded(score, assignments) {
  const { assigned, assist } = staffPools(score, assignments);
  return portsFor([assigned, assist].map((specs) => ({
    melodic: specs.filter((s) => !s.percussionKit).length,
    kits: new Set(specs.filter((s) => s.percussionKit).map((s) => s.program)),
  })));
}

// 演奏者的執行期狀態（每人一份；播放狀態由 _resetPlayback() 全部重設）。tempo 改指派時同槽位沿用，速度區間一律換成新計畫的。
function makePerformerState(index, plan, tempo = new TempoFollower()) {
  tempo.setBounds(plan.rateBounds);
  return {
    index,                 // 演奏者序號（對外事件的 group）
    slot: plan.slot,       // 'kb'、1～4；整首自動播放是 null
    plan,
    tempo,
    cursor: 0,             // 下一個還沒放行的起音（組頭或組裡等自動放行的）
    groupEnd: 0,           // 下一個要他按的起音（沒有組在進行時＝cursor）
    lastHead: null,        // 上一次實際按下的組頭（估速與去抖的「上一下」）
    anchor: null,          // 他這一段的錨點 { slice, clockMs, scoreSec, rate }；null＝還沒開始
    anchoredSlice: -1,     // 已啟動的最大段（第 0 段＝前奏，第 k+1 段由第 k 次按鍵啟動）
    timed: [],             // 組裡被併入、排好還沒送的他的音（帶 lookahead 時間戳），依 dueMs
    clock: [],             // 時鐘到了才做的他那邊的項目：送他合成器的控制器、組內自動放行，依 dueMs
    ownSent: [],           // 已提早送出、取消不了的他的音的預定時刻（統計用）
    // 預按（鎖住期間按幾下都算一下）{ kind, key, lifted, source }：'prelude' 前奏鎖、'rest' 休止符鎖、'ahead' 揮手超前鎖（合奏走到 1/2 拍內才放）
    credit: null,
    zone: 'sync',          // 上一下的區間（ensemble.js 的 classifyOffset）
    xMs: null,             // 上一下的相對時間（ms，正＝超前）
    offRun: { sign: 0, count: 0 },   // 連續幾下同方向偏離或脫隊
    stalled: false,        // 播放頭停在他的下一個起音（stall 事件只在改變時發）
    status: 'ok',          // 'ok'｜'trouble'（出狀況，恢復正常才能再帶頭）｜'substitute'（電腦代打中）
    statusReason: null,
    recoverCount: 0,       // 出狀況之後連續幾下同步（到 RECOVER_PERSIST 恢復）
    steady: null,          // 停住或代打回來之後穩定的一串（ensemble.js 的 extendSteadyRun）
    lastTriggerMs: -Infinity,   // 上一次觸發的動作時刻（含被擋、預按）：判斷「正在彈」
    lastSource: null,      // 上一次觸發的輸入來源（算錯過幾下時照它分組）
    absentSinceMs: null,   // 揮手的人離開鏡頭的時刻（在場或鍵盤是 null）
    missStartMs: null,     // 從沒觸發過的人：合奏開始走過他起音的時刻（代打計時起點）
    restEndMs: null,       // 他錯過的第一下前面是長休止時，合奏走到那一下的時刻（代打不算休止）
    lastAutoMs: null,      // 上一個起音被自動放行的時刻（代打交還時比較用）
  };
}

// 合奏狀態：帶頭的人、錨點（跟帶頭的人觸發時的錨點同一個物件）、走到過的最遠位置 floorTick（不倒退）、伴奏佇列 timed 與 clock
const makeEnsemble = () => ({ leader: null, anchor: null, floorTick: -Infinity, timed: [], clock: [] });

export class Scheduler {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
    this._router = new OutputRouter(this.cfg.drumChannel);   // 所有合成器呼叫都經過它
    this.events = new PerformanceEvents();   // 對外事件：呼叫結束、合成器呼叫都送出之後才發
    this._ledger = new VoiceLedger(this._router, this.events);   // 發聲帳本（voices.js）
    this._score = null;
    this._plan = buildPlan(null);   // 載入後不變的計畫（performancePlan.js）
    this._setPerformers();          // _performers、_bySlot
    this._ensemble = makeEnsemble();
    this._roster = new Roster();   // 誰先開始演奏（ensemble.js）
    this._seq = 0;             // 佇列項目的建批次順序（同一刻照它）
    this._resumeClockMs = 0;   // 最近一次 play() 的時鐘：動作時刻不早於它
    this._forecasters = [];    // 演奏者序號 → 預報器；是設定，載入、改指派、重設都不拿掉
    this._modes = this.cfg.modes;   // 這一輪生效的 dev 開關（load()／reassign() 時的快照）
    // 播放狀態（_resetPlayback() 全部重設）
    this._playing = false;
    this._clockMs = 0;
    this._lastTickMs = null;   // null＝下一次 tick() 的 dt 是 0
    this._lateStats = lateStatsSubscriber(this.events);
    this._chaseStats = chaseStatsSubscriber(this.events);
    this._pressLog = pressLogSubscriber(this.events);
    this._eventLog = null;     // enableEventLog() 才建，預設不記
    this._finishSent = false;
    // 不變式：每顆音最後恰好在 _sounded 或 _skipped 其中之一（isFinished() 靠它）
    this._sounded = new Set();
    this._skipped = new Set(); // 早按時整顆在身後、沒發聲的音
    this._laneTrackers = new Map();   // 早按補控制器狀態：輸入 channel → { tracker, pos }，只往後套用
  }

  setSynths(assistSynth, humanSynth) {
    this._router.setSynths(assistSynth, humanSynth);
  }

  setPortCount(ports) {
    this._router.setPortCount(ports);
  }

  /** 掛上（傳 null 拿掉）演奏者 index 的預報器：每個 tick 呼叫 forecast(view) → { atMs, uncertaintyMs?, source } 或 null。 */
  setForecaster(index, forecaster) {
    this._forecasters[index] = forecaster || undefined;
  }

  get assistSynth() { return this._router.assistSynth; }
  get humanSynth() { return this._router.humanSynth; }
  get ports() { return this._router.ports; }
  get playbackRate() { return this._holdOwner().tempo.playbackRate; }  // 帶頭的人的速度（樂譜秒 ÷ 真實秒）
  get unplacedStaffIds() { return this._plan.unplaced; }   // 排不進輸出 channel 的 staff，這一輪不出聲

  _secOf(tick) {
    return this._score.midiTicksToSeconds(tick);
  }

  // 沒有演奏者時放一份空計畫（伴奏由它的第 0 段放完）。改指派時同槽位沿用速度與上次觸發時刻，新槽位從合奏目前的速度起算。
  _setPerformers(oldBySlot = new Map(), fallbackRate) {
    const plans = this._plan.performers.length ? this._plan.performers : [emptyPerformerPlan()];
    this._performers = plans.map((plan, i) => {
      const old = oldBySlot.get(plan.slot);
      let tempo = old?.tempo;
      if (!tempo) {
        tempo = new TempoFollower();
        if (fallbackRate !== undefined) tempo.playbackRate = fallbackRate;
      }
      const p = makePerformerState(i, plan, tempo);
      if (old) { p.lastTriggerMs = old.lastTriggerMs; p.absentSinceMs = old.absentSinceMs; }
      return p;
    });
    this._bySlot = new Map(this._performers.filter((p) => p.slot !== null).map((p) => [p.slot, p]));
  }

  // 合奏跟誰走：帶頭的人；沒人帶頭時是下一個起音最早的演奏者
  _holdOwner(leader = this._ensemble.leader) {
    if (leader) return leader;
    let best = this._performers[0], bestTick = Infinity;
    for (const p of this._performers) {
      const t = p.plan.driverSegs[p.cursor]?.ticks ?? Infinity;
      if (t < bestTick) { best = p; bestTick = t; }
    }
    return best;
  }

  // 合奏停在哪個起音等（帶頭的人的下一個起音）
  _ensembleNextTick(leader = this._ensemble.leader) {
    const o = this._holdOwner(leader);
    return o.plan.driverSegs[o.cursor]?.ticks;
  }

  // 合奏這次排到哪個 tick（不含）：帶頭的人下一個要按的起音（一組的組尾，組裡的自動放行不再排伴奏）
  _ensembleHorizonTick() {
    const o = this._holdOwner();
    return o.plan.driverTicks[o.groupEnd] ?? Infinity;
  }

  /**
   * @param {import('../midi/midiParser.js').ParsedMidi} score  parseMidi() 的結果（不會被修改）
   * @param {Map<string,number>|[string,number][]} assignments  partId → 演奏者槽位
   */
  load(score, assignments) {
    this.stop();
    this._modes = this.cfg.modes;
    this._score = score || null;
    this._plan = buildPlan(this._score, assignments, this._router);
    this._router.resetIfSysexSent();   // 上一首送過整體參數的 SysEx：兩個合成器整個重設
    this._router.clearShadow();   // 換歌後不知道合成器的 channel 狀態，全部重建
    this._sendInitialState();
    this._setPerformers();
    this._ensemble = makeEnsemble();
    this._roster.clear();
    this._bindLedger();
  }

  // 合成器退回界線 boundary（tick）之前的狀態：整體 SysEx → 重設控制器 → 初始音色 → 控制器軌的 chase。載入與重播用界線 1，改指派用播放頭；都在任何 noteOn 之前。
  _sendInitialState(boundary = 1) {
    for (const ev of this._plan.globalSysex) if (ev.ticks < boundary) this._router.sendSysex(ev.data);
    const staves = [...this._plan.staves.values()];
    for (const staff of staves) this._router.resetChannel(staff);
    for (const staff of staves) this._router.applyInitialPatch(staff);
    for (const lane of this._plan.lanes.values()) this._sendLaneState(lane, chaseEventsAt(lane.events, boundary));
  }

  // 控制器軌的 chase 送到每個輸出 channel：只送跟 shadow 不同的，打擊／旋律互換的 bank select 不送（performancePlan.js 的 switchesKit）
  _sendLaneState(lane, chase) {
    const events = stateEvents(chase);
    for (const staff of lane.targets) this._router.sendStateDiff(staff, events.filter((ev) => !switchesKit(staff, ev)));
  }

  _bindLedger() {
    this._ledger.bind({ staves: this._plan.staves, holdCapTicks: this._plan.holdCapTicks, secOf: (tick) => this._secOf(tick) });
  }

  /**
   * 播放中改指派：從目前的合奏位置接續。界線＝合奏停在帶頭的人下一個起音上時是那個起音，否則是播放頭（含，那個 tick 已響過）；
   * 起音在界線之前的音算已經過了（不重播、不補放），游標指到第一個 ≥ 界線的起音，以現在的時鐘重新錨定（速度沿用、去抖與估速歷史清掉）。
   * 已知限制：lookahead 已送出的電腦音取消不了，起音在界線之後的會再放一次（LOOKAHEAD_MS 內的短暫重複）。
   * @param {Map<string,number|string>|[string,number|string][]} assignments  同 load()
   */
  reassign(assignments) {
    if (!this._score) return;
    this._modes = this.cfg.modes;
    const score = this._score;
    const rate = this.playbackRate;
    const pos = this.getPositionTicks();
    const next = this._ensembleNextTick();
    // 播放頭是浮點數，比大小留一個微小量（起音 tick 是整數）
    const boundary = next !== undefined && pos >= next - 1e-6 ? next : pos + 1e-6;
    for (const staff of this._plan.staves.values()) this._router.resetChannel(staff);
    this.silence();
    this._plan = buildPlan(score, assignments, this._router);
    // 輸出 channel 換了、可能補了 port，舊的 shadow 對不上，從頭建
    this._router.clearShadow();
    this._sendInitialState(boundary);
    if (!this._playing) for (const staff of this._plan.staves.values()) this._router.releaseForPause(staff);
    this._laneTrackers.clear();
    const leaderSlot = this._ensemble.leader?.slot;
    this._setPerformers(this._bySlot, rate);
    this._ensemble = makeEnsemble();
    this._ensemble.leader = this._bySlot.get(leaderSlot) ?? null;
    for (const slot of this._roster.slots()) if (!this._bySlot.has(slot)) this._roster.remove(slot);
    this._bindLedger();

    // 舊佇列不用保留：佇列裡的音都在界線之後，早按沒輪到的音當場已追音或跳過（_chaseOrSkip）
    this._sounded.clear();
    for (const staff of this._plan.staves.values()) {
      for (const note of staff.notes) if (note.startTick < boundary) this._sounded.add(note);
    }
    for (const p of this._performers) {
      p.cursor = lowerBound(p.plan.driverTicks, boundary);
      p.groupEnd = p.cursor;
      p.tempo.forgetHistory();
    }
    this._skipped.clear();   // 界線之前的音都已記進 _sounded
    this._finishSent = false;
    this._lastTickMs = null;
    // 第 0 段（前奏）一律 1× 起算
    const o = this._holdOwner();
    this._anchorSlice(o, o.cursor, this._clockMs, this._secOf(Math.max(0, boundary)), o.cursor === 0 ? 1 : rate, boundary, o.cursor, null, true);
    if (leaderSlot !== undefined && !this._ensemble.leader) this._updateLeader(this._clockMs, 'removed');
    this.events.flush();
  }

  play() {
    this._playing = true;
    // 暫停的時間不算進時鐘，排好的時刻不用動
    this._lastTickMs = null;
    this._resumeClockMs = this._clockMs;
    for (const staff of this._plan.staves.values()) this._router.restoreAfterPause(staff);
  }

  // 暫停：收音，時鐘、錨點、佇列都保留。收音前先放開延音踏板、彎音歸中央（MIDI 1.0：踏板踩著時 Note Off 不生效），續播再恢復。
  pause() {
    this._playing = false;
    this._lastTickMs = null;
    for (const p of this._performers) p.credit = null;   // 預按作廢
    for (const staff of this._plan.staves.values()) this._router.releaseForPause(staff);
    this.silence();
  }

  silence() {
    this._ledger.noteOffAll(this._clockMs);
    for (const staff of this._plan.staves.values()) this._router.allNotesOff(staff); // 保險
    this.events.flush();
  }

  stop() {
    this.pause();
    this._resetPlayback();
  }

  restart() {
    this.pause();
    this._resetPlayback();
    this._router.resetIfSysexSent();   // CC121 管不到整體參數
    this._sendInitialState();
    this.play();
  }

  // 播放狀態退回剛 load() 完。新增狀態欄位都要在這裡重設；呼叫端負責先 pause()。
  _resetPlayback() {
    for (const p of this._performers) {
      p.cursor = 0;
      p.groupEnd = 0;
      p.lastHead = null;
      p.anchor = null;
      p.anchoredSlice = -1;
      p.timed = [];
      p.clock = [];
      p.ownSent = [];
      p.credit = null;
      p.zone = 'sync';
      p.xMs = null;
      p.offRun = { sign: 0, count: 0 };
      p.stalled = false;
      p.status = 'ok';
      p.statusReason = null;
      p.recoverCount = 0;
      p.steady = null;
      p.lastTriggerMs = -Infinity;
      p.lastSource = null;
      p.absentSinceMs = null;
      p.missStartMs = null;
      p.restEndMs = null;
      p.lastAutoMs = null;
      p.tempo.reset();
    }
    this._ensemble = makeEnsemble();
    this._roster.clear();
    this._seq = 0;
    this._resumeClockMs = 0;
    this._laneTrackers.clear();
    this._router.forgetPauseSaves();
    this._clockMs = 0;
    this._lastTickMs = null;
    this._lateStats.reset();
    this._chaseStats.reset();
    this._pressLog.reset();
    this._eventLog?.reset();
    this._finishSent = false;
    this._sounded.clear();
    this._skipped.clear();
  }

  isPlaying() { return this._playing; }

  /** 唯讀快照（複本；note 是樂譜裡的同一個物件），給測試與工具用，取代直接讀私有欄位。 */
  inspect() {
    const withStaffId = ({ staff, note }) => ({ staffId: staff.id, note });
    const noteOf = (p) => ({ dueMs: p.dueMs, offMs: p.offMs, staffId: p.staff.id, note: p.note, own: p.own });
    const controlOf = (c) => ({
      dueMs: c.dueMs, id: c.ev.id, ticks: c.ev.ticks, type: c.ev.type, staffIds: (c.targets ?? []).map((s) => s.id),   // SysEx 沒有目標譜表
    });
    const E = this._ensemble, roster = this._roster.slots(), beat = this._score ? this._beatMsNow() : null;
    return {
      loaded: !!this._score,
      performers: this._performers.filter((p) => p.slot !== null).map((p) => ({
        slot: p.slot, source: p.lastSource, rosterIndex: roster.indexOf(p.slot), isLeader: p === E.leader, status: p.status,
        zone: p.zone, xMs: p.xMs, xBeats: p.xMs === null ? null : p.xMs / beat, rate: p.tempo.playbackRate, cursor: p.cursor,
        missed: this._score ? this._missedCount(p) : 0, sinceLastMs: this._clockMs - p.lastTriggerMs,
      })),
      playing: this._playing,
      clockMs: this._clockMs,
      playbackRate: this.playbackRate,
      rateBounds: this.rateBounds(),
      totalNotes: this._plan.totalNotes,
      holdCapTicks: this._plan.holdCapTicks,
      sounded: new Set(this._sounded),
      skipped: new Set(this._skipped),
      unplacedStaffIds: [...this._plan.unplaced],
      followers: this._plan.accompaniment.followers.map(withStaffId),
      ensemble: {
        leaderSlot: E.leader?.slot ?? null,
        roster: this._roster.slots(),
        anchor: E.anchor && { ...E.anchor },
        positionTicks: this.getPositionTicks(),
        rate: this.playbackRate,
        pending: E.timed.filter((p) => p.note).map(noteOf),
        pendingControls: [...E.timed.filter((p) => !p.note), ...E.clock].map(controlOf),
      },
      groups: this._performers.map((p) => ({
        slot: p.slot,
        slots: p.slot === null ? [] : [p.slot],
        status: p.status,
        provisional: this._roster.isProvisional(p.slot),
        segments: p.plan.driverSegs.map((s) => ({ ticks: s.ticks, items: s.items.map(withStaffId) })),
        cursor: p.cursor,
        hasPrelude: p.plan.hasPrelude,
        preludeCredit: p.credit?.kind === 'prelude',
        credit: p.credit && { ...p.credit },
        zone: p.zone,
        xMs: p.xMs,
        anchor: p.anchor && { ...p.anchor },
        anchoredSlice: p.anchoredSlice,
        stallMs: this._stallMsAt(p, this._clockMs),
        pending: p.timed.filter((x) => x.note).map(noteOf),
        pendingControls: p.clock.filter((c) => c.ev).map(controlOf),
        groupEnd: p.groupEnd,
        lastHead: p.lastHead,
        pendingAutoReleases: p.clock.filter((c) => c.autoRelease !== undefined).map((c) => ({ dueMs: c.dueMs, index: c.autoRelease, ticks: c.ticks })),
        playbackRate: p.tempo.playbackRate,
        rateBounds: { ...p.tempo.bounds },
        tempo: p.tempo.snapshot(),
      })),
      staves: [...this._plan.staves.values()].map((s) => ({
        id: s.id, partId: s.partId, slot: s.slot, kind: s.kind, channel: s.channel, program: s.program, bank: s.bank && { ...s.bank },
        init: s.init && { ...s.init }, percussionKit: s.percussionKit, baseVolume: s.baseVolume, notes: [...s.notes],
        sounding: [...s.sounding].flatMap(([pitch, queue]) => queue.map((e) => ({
          pitch, endTick: e.endTick, offMs: e.offMs, holdTick: e.holdTick, holdScope: e.holdScope, waitKey: e.waitKey ?? null, tailSec: e.tailSec, capped: e.capped, onTime: e.onTime, note: e.note,
        }))),
      })),
    };
  }

  /** 這個 tick 屬於合奏的第幾段（帶頭的人的第一個起音之前＝第 0 段）。 */
  sliceOfTick(tick) { return sliceOfTick(this._holdOwner().plan.driverTicks, tick); }

  /** 依帶頭的人的游標判斷這顆伴奏音要不要 hold（voices.js 的 holdOf()）。 */
  holdOf(note) {
    const o = this._holdOwner();
    return this._ledger.holdOf(note, o.plan.driverTicks, o.cursor);
  }

  // 播完：每顆音都處理過（響過或早按跳過）而且沒有還在響的音
  isFinished() {
    if (!this._score) return false;
    if (this._sounded.size + this._skipped.size < this._plan.totalNotes) return false;
    return this._ledger.isSilent();
  }

  /**
   * 合奏位置（tick，可為小數）：從錨點依速度往前走，最多走到帶頭的人的下一個起音（停格等他）。
   * @returns {number} 夾在 [0, score.durationTicks]；還沒開始播時 0
   */
  getPositionTicks() { return this._positionAt(this._clockMs); }

  _positionAt(clockMs) {
    const E = this._ensemble, a = E.anchor;
    if (!this._score || this._plan.staves.size === 0 || !a) return 0;
    let sec = a.scoreSec + (Math.max(0, clockMs - a.clockMs) * a.rate) / 1000;
    const next = this._ensembleNextTick();
    if (next !== undefined) sec = Math.min(sec, this._secOf(next));
    if (E.floorTick > -Infinity) sec = Math.max(sec, this._secOf(E.floorTick));   // 不倒退
    const ticks = this._score.secondsToMIDITicks(sec);
    const total = this._score.durationTicks;
    return total > 0 ? Math.min(ticks, total) : ticks;
  }

  _clockAt(nowMs) {
    if (this._lastTickMs == null) return this._clockMs;
    return this._clockMs + Math.min(MAX_TICK_DT_MS, Math.max(0, nowMs - this._lastTickMs));
  }

  // 他的播放頭停在下一個起音等了多久（ms）
  _stallMsAt(p, clockMs) {
    const reach = this._reachClockMs(p);
    return reach === null ? 0 : Math.max(0, clockMs - reach);
  }

  // 他的播放頭走到第 index 個起音的時鐘時刻；到不了（還沒開始彈的人、起音在合奏停格之後、沒有那個起音）回 null
  _reachClockMs(p, index = p.cursor) {
    const a = p.anchor ?? this._ensemble.anchor;
    const next = p.plan.driverSegs[index];
    if (!a || !next) return null;
    if (!p.anchor && next.ticks > (this._ensembleNextTick() ?? Infinity)) return null;
    return a.clockMs + ((this._secOf(next.ticks) - a.scoreSec) * 1000) / a.rate;
  }

  // 第 0 段（前奏）在第一次需要時用目前時鐘、1× 起算
  _ensureEnsembleAnchored() {
    if (this._ensemble.anchor) return;
    this._anchorSlice(this._holdOwner(), 0, this._clockMs, 0, 1, -Infinity, 0, null, true);
  }

  // 動作時刻（鍵盤 event.timeStamp、揮手最低點的拍下時刻）換成排程器時鐘；不早於最近一次續播
  _motionClock(ev, clock) {
    if (!Number.isFinite(ev.eventTimeMs) || !Number.isFinite(ev.receivedMs)) return clock;
    return Math.max(this._resumeClockMs, clock - (ev.receivedMs - ev.eventTimeMs));
  }

  // 合奏位置上一拍的真實 ms
  _beatMsNow() { return beatMs(this._score, this.getPositionTicks(), this.playbackRate); }

  // 兩個 tick 之間幾拍（SMPTE 用 ENSEMBLE.SMPTE_BEAT_SEC）
  _beatsBetween(a, b) {
    return this._score.timeDivision ? (b - a) / this._score.timeDivision : (this._secOf(b) - this._secOf(a)) / ENSEMBLE.SMPTE_BEAT_SEC;
  }

  // 第 index 個起音前面那段休止 [開始, 結束]；前面不是休止回 null
  _restBefore(p, index = p.cursor) {
    const next = p.plan.driverTicks[index], rests = p.plan.rests;
    if (next === undefined || !rests.length) return null;
    let lo = 0, hi = rests.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (rests[mid][1] < next) lo = mid + 1; else hi = mid; }
    return rests[lo]?.[1] === next ? rests[lo] : null;
  }

  // 合奏位置在他下一個起音前的休止裡，而且休止夠長（≥ REST_HANDOVER_BEATS 拍，斷奏的短空檔不算）
  _inRest(p) {
    const r = this._restBefore(p);
    if (!r) return false;
    const e = this.getPositionTicks();
    return e >= r[0] && e < r[1] && this._beatsBetween(r[0], r[1]) >= ENSEMBLE.REST_HANDOVER_BEATS;
  }

  // 他在休止中：合奏位置在他下一個起音前的休止裡，離休止結束還有 ≥ REST_HANDOVER_BEATS 拍（長音不是休止）
  _isResting(p) {
    const r = this._restBefore(p);
    if (!r) return false;
    const e = this.getPositionTicks();
    return e >= r[0] && this._beatsBetween(e, r[1]) >= ENSEMBLE.REST_HANDOVER_BEATS;
  }

  // 可以帶頭：狀態符合、聲部沒彈完、不在休止中；非現任還要正在彈（isActive），且在休止裡時只有正在觸發進場音（entering）才算回來
  // （只看休止剩幾拍的話，交棒時合奏往前跳一點就又被當成回來，在門檻上來回跳）。揮手還沒確認的人只在沒有人確認時才能暫時帶頭。
  _isCandidate(p, current, clock, entering = null, status = 'ok') {
    if (!p || p.status !== status || p.cursor >= p.plan.driverSegs.length || this._isResting(p)) return false;
    if (p === current) return true;
    if (this._provisionalBlocked(p)) return false;
    if (p !== entering && this._inRest(p)) return false;
    const reach = p.anchor && !this._restBefore(p) ? this._reachClockMs(p) : null;
    return isActive({ sinceLastMs: clock - p.lastTriggerMs, beatMs: this._beatMsNow(), resting: false, waiting: reach !== null && clock < reach });
  }

  // 揮手還沒確認、而名單上已經有人確認：不能帶頭
  _provisionalBlocked(p) { return this._roster.isProvisional(p.slot) && this._roster.hasConfirmed(); }

  // 候補的第二順位：在自己夠長的休止裡（被代打、彈完的不算）
  _isRestingStandIn(p) {
    return p.status !== 'substitute' && p.cursor < p.plan.driverSegs.length && this._inRest(p) && !this._provisionalBlocked(p);
  }

  // 第一次觸發排進名單（揮手的人先記成暫時的，窗口內再觸發才確認）
  _admit(p, ev, motion) {
    const R = this._roster, beat = this._beatMsNow();
    if (R.has(p.slot)) {
      if (R.isProvisional(p.slot) && motion - R.firstMotionMs(p.slot) <= threshold(ENSEMBLE.GESTURE_CONFIRM_BEATS, ENSEMBLE.GESTURE_CONFIRM_MIN_MS, beat)) R.confirm(p.slot);
      return;
    }
    R.admit(p.slot, { motionMs: motion, order: slotOrder(p.slot), tieMs: threshold(ENSEMBLE.TIE_BEATS, ENSEMBLE.TIE_MIN_MS, beat), provisional: ev.source === 'gesture' });
  }

  // 每個 tick：移出逾時沒確認的人、第一段防呆（帶頭的人出狀況就換）、第二段防呆（代打）、重新挑帶頭的人
  _rosterTick() {
    const R = this._roster, clock = this._clockMs;
    for (const slot of R.slots()) {
      if (!R.isProvisional(slot) || clock - R.firstMotionMs(slot) <= threshold(ENSEMBLE.GESTURE_CONFIRM_BEATS, ENSEMBLE.GESTURE_CONFIRM_MIN_MS, this._beatMsNow())) continue;
      R.remove(slot);
      if (this._ensemble.leader?.slot === slot) this._updateLeader(clock, 'unconfirmed', true);
    }
    this._checkLeaderTrouble(clock);
    this._checkSubstitutes(clock);
    this._updateLeader(clock);
  }

  // 第二段防呆：不是帶頭的人錯過太多下就由電腦代打（ensemble.js 的 shouldSubstitute）；有預按的算已觸發
  _checkSubstitutes(clock) {
    let beat = null;
    for (const p of this._performers) {
      if (p.slot === null || p === this._ensemble.leader || p.status === 'substitute' || p.credit) continue;
      const missed = this._missedCount(p);
      if (!missed) { p.missStartMs = null; p.restEndMs = null; continue; }
      if (p.missStartMs === null) { p.missStartMs = clock; p.restEndMs = this._restEndMs(p); }
      beat ??= this._beatMsNow();
      // 離上一下多久不算他自己的休止（使用者 2026-10-22 決定：長休止後晚一點進場不算離開）
      const since = clock - Math.max(p.lastTriggerMs > -Infinity ? p.lastTriggerMs : p.missStartMs, p.restEndMs ?? -Infinity);
      const absentMs = p.absentSinceMs === null ? 0 : clock - p.absentSinceMs;
      if (!shouldSubstitute({ missed, sinceLastMs: since, beatMs: beat, absentMs, k: this.cfg.stage2K })) continue;
      this._setStatus(p, 'substitute', 'stage2', clock);
      p.lastAutoMs = null;
      this._substituteFrom(p, this.getPositionTicks(), clock);
    }
  }

  // 他錯過的第一下前面是夠長的休止時，合奏走到那一下的時刻（剛開始錯過時算，錨點還是最近的才準）；不是就 null
  _restEndMs(p) {
    const r = this._restBefore(p, p.groupEnd);
    if (!r || this._beatsBetween(r[0], r[1]) < ENSEMBLE.IDLE_REST_BEATS) return null;
    const a = this._ensemble.anchor;
    return a.clockMs + ((this._secOf(r[1]) - a.scoreSec) * 1000) / a.rate;
  }

  // 他錯過了幾下（同近距分組併成的「一下」，起音落在合奏位置 MISSED_BEHIND_BEATS 拍以前），數到 stage2K 為止
  _missedCount(p) {
    const lim = this._ticksBefore(this.getPositionTicks(), ENSEMBLE.MISSED_BEHIND_BEATS), ticks = p.plan.driverTicks, cap = this.cfg.stage2K;
    let n = 0;
    for (let j = p.groupEnd; n < cap && j < ticks.length && ticks[j] <= lim; j = this._groupEnd(p, j, p.tempo.playbackRate, p.lastSource)) n++;
    return n;
  }

  // 代打：q 從合奏位置 T 起由電腦照合奏錨點替他放。T 之前的照垂直切片追音或跳過；T 起到合奏停格前，他的音帶時間戳走真人軌、每個起音一個自動放行，速度改成合奏的
  _substituteFrom(q, T, clock) {
    const a = this._ensemble.anchor, rate = a.rate, tSec = this._secOf(T), ticks = q.plan.driverTicks, segs = q.plan.driverSegs;
    for (const it of q.clock) if (it.autoRelease !== undefined && it.ticks < T) this._autoRelease(q, it.autoRelease, clock);
    const kT = lowerBound(ticks, T);
    const pending = new Map();   // 還沒響的他的音
    for (const it of q.timed) if (it.note.startTick < T) pending.set(it.note, it);
    for (let s = q.cursor; s < kT; s++) for (const it of segs[s].items) pending.set(it.note, it);
    q.timed = [];
    q.clock = [];
    q.cursor = q.groupEnd = Math.max(q.cursor, kT);
    q.credit = null;
    q.tempo.playbackRate = rate;
    // 他在響的音：結尾在 T 之前的收掉；hold 等 T 以前起音的改照樂譜剩下的長度收
    this._ledger.closeByTick(T, this._clockMs, q.slot);
    this._ledger.retimeHeld(q.slot, (t) => t < T, (t, tailSec) => clock + scaledMs(Math.max(0, this._secOf(t) + tailSec - tSec), rate));
    this._ledger.closeDue(this._clockMs);
    for (const [channel, lane] of this._plan.lanes) if (lane.targets.some((s) => s.slot === q.slot && s.kind === 'human')) this._chaseLane(channel, T);
    const chased = [], skipped = [];
    for (const { staff, note } of pending.values()) {
      if (this._sounded.has(note)) continue;
      if (note.endTick > T) {
        chased.push(note);
        this._sound(staff, note, clock + scaledMs(this._secOf(note.endTick) - tSec, rate), clock);
      } else {
        skipped.push(note);
        this._skipped.add(note);
      }
    }
    if (chased.length || skipped.length) this.events.queue('chase', { group: q.index, slot: q.slot, ticks: T, chased, skipped, inFlight: 0 });
    const hi = this._ensembleHorizonTick(), end = lowerBound(ticks, hi);
    const dueOf = (tick) => a.clockMs + ((this._secOf(tick) - a.scoreSec) * 1000) / rate;
    if (chased.length && q.cursor > 0) q.lastAutoMs = dueOf(ticks[q.cursor - 1]);   // 補上的追音也算電腦替他放了那一下
    const autos = [], controls = [];
    for (let s = q.cursor; s < end; s++) {
      autos.push({ dueMs: dueOf(ticks[s]), ticks: ticks[s], autoRelease: s, owner: q });
      for (const { staff, note } of segs[s].items) {
        const dueMs = dueOf(note.startTick);
        q.timed.push({ dueMs, offMs: dueMs + scaledMs(this._secOf(note.endTick) - this._secOf(note.startTick), rate), staff, note, own: true, mode: null, owner: q, seq: ++this._seq });
      }
    }
    for (let m = lowerBound(q.plan.controlTicks, T), mTo = lowerBound(q.plan.controlTicks, hi); m < mTo; m++) {
      const c = q.plan.controls[m];
      controls.push({ dueMs: dueOf(c.ev.ticks), ev: c.ev, targets: c.targets });
    }
    q.clock = mergeByDue(autos, controls);
    for (const it of q.clock) it.seq = ++this._seq;
    q.groupEnd = end;
    q.anchor = { slice: q.cursor, clockMs: a.clockMs, scoreSec: a.scoreSec, rate };
  }

  // 代打中的人再觸發：對到合奏時間軸上最近的起音。最近的是電腦已經替他放的那一下 → 接手不重彈（改放下一個會多推一格），進估速、回傳 false；
  // 最近的是還沒放的 → 回傳 null，照一般觸發處理。之後電腦不再替他排，狀態標成 trouble，恢復正常才能再帶頭。
  _takeOver(p, ev, clock, motion) {
    this._emitTimed(clock);   // 到期的先放，游標與「已經放了」才對
    this._emitClock(clock);
    const ticks = p.plan.driverTicks, segs = p.plan.driverSegs, a = this._ensemble.anchor;
    const dueOf = (k) => a.clockMs + ((this._secOf(ticks[k]) - a.scoreSec) * 1000) / a.rate;
    let sent = p.cursor;   // lookahead 已送出的也算電腦放了（取消不了）
    while (sent < segs.length && segs[sent].items.every(({ note }) => this._sounded.has(note))) sent++;
    const last = sent - 1, lastMs = last >= p.cursor ? dueOf(last) : p.lastAutoMs;
    const nextMs = sent < ticks.length ? dueOf(sent) : Infinity;
    for (const it of p.clock) if (it.autoRelease !== undefined && it.autoRelease < sent) this._autoRelease(p, it.autoRelease, it.dueMs);
    const take = last >= 0 && lastMs !== null && Math.abs(motion - lastMs) <= Math.abs(nextMs - motion);
    p.timed = [];
    p.clock = p.clock.filter((c) => c.autoRelease === undefined);   // 控制器照舊
    p.groupEnd = p.cursor;
    this._setStatus(p, 'trouble', take ? 'takeover' : 'returned', clock);
    if (!take) return null;
    const k = p.cursor;
    this._clockMs = clock;
    this._lastTickMs = ev.receivedMs;
    if (ev.key != null) this._ledger.takeOver(p.slot, ticks[k - 1], ev.key);
    p.tempo.forgetHistory();
    p.tempo.accept(k - 1, this._secOf(ticks[k - 1]), null, motion);
    p.lastHead = k - 1;
    this._anchorSlice(p, k, p.lastAutoMs, this._secOf(ticks[k - 1]), p.tempo.playbackRate, this.getPositionTicks(), k, null, false);   // 錨點＝電腦放出 k−1 的那一刻
    this._pressEvent(p, ev, clock, 'takeover');
    return false;
  }

  // 重新挑帶頭的人：名單上第一位可以帶頭的。現任出狀況時，接手的人自己不能已經停住；現任休止中時，只交給在他進場音之前有起音要按的人。
  // 沒有正常的人可接、現任又停住時，依序交給「出狀況但還在彈、沒停住的」→「在自己休止裡的」（使用者 2026-10-22 決定：不然別人的觸發都被鎖吞掉，整首卡住）。
  // 之後每個 tick，出狀況的現任要已經不算正在彈（超過 ACTIVE_BEATS 或不在鏡頭裡）才換，免得候補一停頓就換下一位。都沒有就維持現狀，除非 force。
  _updateLeader(clock, reason = null, force = false, entering = null) {
    const E = this._ensemble, cur = E.leader, slots = this._roster.slots(), at = (s) => this._bySlot.get(s);
    const entry = cur?.status === 'ok' && this._isResting(cur) ? cur.plan.driverTicks[cur.cursor] : null;
    const ok = (p) => this._isCandidate(p, cur, clock, entering) && (cur?.status !== 'trouble' || p === cur || !this._stallWhy(p, clock))
      && (entry === null || (p.plan.driverTicks[p.groupEnd] ?? Infinity) < entry);
    let slot = pickLeader(slots, (s) => ok(at(s)));
    const stall = cur?.status === 'trouble' ? this._stallWhy(cur, clock) : null;
    const gone = stall && (reason !== null || stall === 'absent' || clock - cur.lastTriggerMs > threshold(ENSEMBLE.ACTIVE_BEATS, ENSEMBLE.ACTIVE_MIN_MS, this._beatMsNow()));
    if (slot === null && (!cur || gone)) {
      slot = pickLeader(slots, (s) => at(s) !== cur && this._isCandidate(at(s), null, clock, entering, 'trouble') && !this._stallWhy(at(s), clock))
        ?? pickLeader(slots, (s) => at(s) !== cur && this._isRestingStandIn(at(s)));
    }
    const next = slot === null ? null : at(slot);
    if (next === cur || (next === null && !force)) return;
    const why = reason ?? (!cur ? 'first' : cur.status === 'trouble' ? cur.statusReason
      : cur.cursor >= cur.plan.driverSegs.length ? 'done' : this._isResting(cur) ? 'rest' : 'return');
    this._switchLeader(next, clock, why);
  }

  // 換帶頭的人：合奏原本就在等他時不用動；否則在這一刻重新對時，新帶頭者推算的位置超過合奏位置就跳過去（垂直切片），沒超過就停著等他（不倒退）
  _switchLeader(next, clock, reason) {
    const E = this._ensemble, cur = E.leader;
    this.events.queue('leader', { from: cur?.slot ?? null, to: next?.slot ?? null, reason, clockMs: clock });
    if (!E.anchor || (!cur && this._ensembleNextTick(next) === this._ensembleNextTick())) { E.leader = next; return; }
    // 到期還沒放的先放，再照舊的帶頭者量合奏位置
    if (this._playing) { this._emitTimed(clock); this._emitClock(clock); }
    const ePos = this._positionAt(clock);
    E.leader = next;
    let target = ePos;
    if (next?.anchor) {
      const a = next.anchor, nt = next.plan.driverSegs[next.cursor]?.ticks;
      let sec = a.scoreSec + ((clock - a.clockMs) * a.rate) / 1000;
      if (nt !== undefined) sec = Math.min(sec, this._secOf(nt));
      target = Math.max(target, this._score.secondsToMIDITicks(sec));
    }
    this._jumpEnsemble(target, clock, this._holdOwner().tempo.playbackRate);
  }

  // 合奏跳到 toTick、以 rate 重新對時：佇列作廢；跳過的伴奏音照垂直切片（追音或跳過），控制器帶到 toTick 前的狀態；
  // hold 著的伴奏音，新帶頭者還沒按到的起音照舊等，其餘照新錨點收；再從 toTick 起依新帶頭者排伴奏。
  _jumpEnsemble(toTick, clock, rate) {
    const E = this._ensemble, A = this._plan.accompaniment, from = E.floorTick;
    E.timed = [];
    E.clock = [];
    const chased = [], skipped = [];
    if (toTick > from) {
      for (let i = lowerBound(A.followerTicks, from), iTo = lowerBound(A.followerTicks, toTick); i < iTo; i++) {
        const { staff, note } = A.followers[i];
        if (this._sounded.has(note) || this._skipped.has(note)) continue;
        if (note.endTick > toTick) {
          chased.push(note);
          this._sound(staff, note, clock + scaledMs(this._secOf(note.endTick) - this._secOf(toTick), rate), clock);
        } else {
          skipped.push(note);
          this._skipped.add(note);
        }
      }
      // 只追有伴奏譜表的控制器軌（演奏者的軌照他自己的錨點；追蹤器只能往後，追到合奏位置會讓落後的人提早收到）
      for (const [channel, lane] of this._plan.lanes) {
        if (lane.targets.some((s) => s.kind !== 'human') && lane.events.some((ev) => ev.ticks >= from && ev.ticks < toTick)) this._chaseLane(channel, toTick);
      }
      for (const ev of this._plan.globalSysex) if (ev.ticks >= from && ev.ticks < toTick) this._router.sendSysex(ev.data);
    }
    const owner = this._holdOwner();
    const scoreSec = this._secOf(toTick);
    const dueOf = (tick) => clock + ((this._secOf(tick) - scoreSec) * 1000) / rate;
    const onsets = new Set(owner.plan.driverTicks.slice(owner.cursor));
    this._ledger.retimeHeld('ensemble', (tick) => tick < toTick || !onsets.has(tick), (tick, tailSec) => dueOf(tick) + scaledMs(tailSec, rate));
    const hi = Math.max(toTick, this._ensembleHorizonTick());
    const anchor = { slice: owner.cursor, clockMs: clock, scoreSec, rate };
    E.anchor = anchor;
    E.floorTick = Math.max(E.floorTick, toTick);
    this.events.queue('anchor', { group: owner.index, slot: owner.slot, slice: owner.cursor, clockMs: clock, scoreSec, rate });
    const { fresh, others } = this._ensembleBatch(null, toTick, hi, anchor, toTick, [], null);
    for (const it of fresh) { it.seq = ++this._seq; E.timed.push(it); }
    for (const it of others) { it.seq = ++this._seq; E.clock.push(it); }
    if (chased.length || skipped.length) this.events.queue('chase', { group: owner.index, slot: owner.slot, ticks: toTick, chased, skipped, inFlight: 0 });
    this._resyncSubstitutes(toTick, clock);
  }

  // 合奏時間軸 [lo, hi) 照錨點排時刻：伴奏音依起音，own（帶頭的人組裡被併入的音）同 tick 排在前面；控制器插在檔案裡比它晚的第一個音之前。
  // others＝還沒開始彈的人的控制器，排到他們各自的下一個起音。fromTick 與 floorTick 之前的不排（own 不受 floorTick 限制），已發聲的伴奏音不再排。
  _ensembleBatch(p, lo, hi, anchor, fromTick, own, ownMode) {
    const { clockMs, scoreSec, rate } = anchor;
    const dueOf = (tick) => clockMs + ((this._secOf(tick) - scoreSec) * 1000) / rate;
    const A = this._plan.accompaniment, fresh = [];
    const from = Math.max(fromTick, this._ensemble.floorTick);
    let i = lowerBound(A.followerTicks, lo), k = lowerBound(A.controlTicks, lo);
    const iTo = lowerBound(A.followerTicks, hi), kTo = lowerBound(A.controlTicks, hi);
    const take = () => {
      const c = A.controls[k++];
      if (c.ev.ticks < from) return;
      const dueMs = dueOf(c.ev.ticks);
      fresh.push(c.sysex ? { dueMs, ev: c.ev, sysex: true } : { dueMs, ev: c.ev, targets: c.targets });
    };
    for (let o = 0; i < iTo || o < own.length; ) {
      const isOwn = o < own.length && (i >= iTo || own[o].note.startTick <= A.followers[i].note.startTick);
      const { staff, note } = isOwn ? own[o++] : A.followers[i++];
      while (k < kTo && fileBefore(A.controls[k].ev, note)) take();
      if (note.startTick < (isOwn ? fromTick : from) || (!isOwn && this._sounded.has(note))) continue;
      const startSec = this._secOf(note.startTick);
      const dueMs = clockMs + ((startSec - scoreSec) * 1000) / rate;
      fresh.push({ dueMs, offMs: dueMs + scaledMs(this._secOf(note.endTick) - startSec, rate), staff, note, own: isOwn, mode: isOwn ? ownMode : null, owner: isOwn ? p : null });
    }
    while (k < kTo) take();
    const others = [];
    for (const q of this._performers) {
      if (q === p || q.anchor !== null || q.slot === null) continue;
      const qEnd = Math.min(hi, q.plan.driverSegs[q.cursor]?.ticks ?? Infinity);
      const t = q.plan.controlTicks;
      for (let m = lowerBound(t, lo), mTo = lowerBound(t, qEnd); m < mTo; m++) {
        const c = q.plan.controls[m];
        if (c.ev.ticks < from) continue;
        others.push({ dueMs: dueOf(c.ev.ticks), ev: c.ev, targets: c.targets });
      }
    }
    others.sort((x, y) => x.dueMs - y.dueMs);
    return { fresh, others };
  }

  // 啟動 p 的第 slice～lastSlice 段（同一個錨點）：組裡被併入的音（own）、他的控制器、每個起音一個自動放行照錨點排時刻。
  // withEnsemble：同一個錨點也是合奏的，伴奏一起排。fromTick 之前的不排（改指派從中間接續，狀態已用 chase 送）。上一段的佇列此時一定已清空（_chaseOrSkip）。
  _anchorSlice(p, slice, clockMs, scoreSec, rate, fromTick = -Infinity, lastSlice = slice, ownMode = null, withEnsemble = false) {
    const anchor = { slice, clockMs, scoreSec, rate };
    p.anchor = anchor;
    this.events.queue('anchor', { group: p.index, slot: p.slot, slice, clockMs, scoreSec, rate });
    p.anchoredSlice = lastSlice;
    const { driverSegs, driverTicks, controls, controlTicks } = p.plan;
    const lo = slice === 0 ? -Infinity : driverTicks[slice - 1];
    const hi = lastSlice < driverTicks.length ? driverTicks[lastSlice] : Infinity;
    const dueOf = (tick) => clockMs + ((this._secOf(tick) - scoreSec) * 1000) / rate;
    const own = [], autos = [], human = [];
    for (let s = slice; s < lastSlice; s++) {
      own.push(...driverSegs[s].items);
      autos.push({ dueMs: dueOf(driverSegs[s].ticks), ticks: driverSegs[s].ticks, autoRelease: s, owner: p });
    }
    for (let k = lowerBound(controlTicks, lo), kTo = lowerBound(controlTicks, hi); k < kTo; k++) {
      const c = controls[k];
      if (c.ev.ticks >= fromTick) human.push({ dueMs: dueOf(c.ev.ticks), ev: c.ev, targets: c.targets });
    }
    let fresh;
    if (withEnsemble) {
      const E = this._ensemble;
      E.anchor = anchor;
      E.floorTick = Math.max(E.floorTick, lo);
      const batch = this._ensembleBatch(p, lo, hi, anchor, fromTick, own, ownMode);
      fresh = batch.fresh;
      E.timed = [];
      E.clock = batch.others;
      for (const it of E.clock) it.seq = ++this._seq;
    } else {
      fresh = [];
      for (const { staff, note } of own) {
        if (note.startTick < fromTick) continue;
        const startSec = this._secOf(note.startTick);
        const dueMs = clockMs + ((startSec - scoreSec) * 1000) / rate;
        fresh.push({ dueMs, offMs: dueMs + scaledMs(this._secOf(note.endTick) - startSec, rate), staff, note, own: true, mode: ownMode, owner: p });
      }
    }
    p.timed = [];
    for (const it of fresh) { it.seq = ++this._seq; (it.own ? p.timed : this._ensemble.timed).push(it); }
    p.clock = autos.length ? mergeByDue(autos, human) : human;
    for (const it of p.clock) it.seq = ++this._seq;
    if (withEnsemble) this._resyncSubstitutes(Math.max(lo, fromTick), clockMs);
  }

  // 合奏重新對時後，代打中的人從新起點重排
  _resyncSubstitutes(fromTick, clock) {
    for (const q of this._performers) if (q.status === 'substitute') this._substituteFrom(q, fromTick, clock);
  }

  /**
   * 觸發一次：放行這個槽位的下一個起音，音在這次呼叫內 noteOn；他帶頭時同時啟動伴奏。發聲與錨點用收到的時刻，估速、去抖、名單、x 用動作時刻（_motionClock）。
   * @param {number|string|{ slot: number|string, source: string|null, eventTimeMs: number|null, receivedMs: number }} input  槽位，或輸入事件
   * @param {number} [nowMs]  performance.now()（傳槽位時用）
   * @returns {boolean} 有沒有放行
   */
  trigger(input, nowMs) {
    const ev = typeof input === 'object' && input !== null ? input : { slot: input, source: null, eventTimeMs: null, receivedMs: nowMs };
    try { return this._trigger(ev); }
    finally { this.events.flush(); }
  }

  _modeOf(source) { return this._modes[source === 'keyboard' ? 'keyboard' : 'gesture']; }

  _trigger(ev) {
    // holdToNext 開著時鍵盤拿掉 key，走跟揮手一樣的非 keyup 路徑
    if (ev.key != null && this._modeOf(ev.source).holdToNext) ev = { ...ev, key: null };
    const p = this._bySlot.get(ev.slot);
    if (!this._playing || !p || (p.status !== 'substitute' && p.groupEnd >= p.plan.driverSegs.length)) return false;
    this._ensureEnsembleAnchored();
    const clock = this._clockAt(ev.receivedMs);
    const R = this._roster, motion = this._motionClock(ev, clock), isNew = !R.has(p.slot), cur = this._ensemble.leader;
    p.lastTriggerMs = motion;
    p.lastSource = ev.source ?? null;
    this._admit(p, ev, motion);
    // 沒人帶頭：他先成為帶頭的人。已經有人帶頭：這一下先照非帶頭的人處理（x、跳、鎖）再看要不要換——先換的話，落後的人會以帶頭身分放他落後的起音，合奏反而停著等他
    if (!cur) this._updateLeader(clock, null, false, p);
    const released = this._triggerBody(p, ev, clock, motion);
    // 新加入的人因同時開始排到現任前面：原因是 tie
    const tie = isNew && cur && R.slots().indexOf(p.slot) < R.slots().indexOf(cur.slot);
    this._updateLeader(clock, tie ? 'tie' : null, false, p);
    return released;
  }

  _triggerBody(p, ev, clock, motion) {
    if (p.status === 'substitute') {
      const taken = this._takeOver(p, ev, clock, motion);
      if (taken !== null) return taken;
      if (p.groupEnd >= p.plan.driverSegs.length) return false;
    }
    let j = p.groupEnd;

    // 前奏鎖：合奏還沒走到他的入場點時不放行（放行會跳過前奏剩下的音），記成預按，走到時由 tick() 放出；不動估速與去抖
    if (j === 0 && p.plan.hasPrelude) {
      const reach = this._reachClockMs(p);
      if (reach === null || clock < reach - EPS_MS) {
        this._pressEvent(p, ev, clock, 'prelude');
        p.credit = { kind: 'prelude', key: ev.key ?? null, lifted: false, source: ev.source ?? null };
        return false;
      }
    }
    // 休止符鎖（帶頭的人也一樣）：長休止後的起音提早按，記成預按，合奏走到時放出
    if (this._restLocked(p, j, motion, clock)) return this._restCredit(p, ev, clock);
    // 超前鎖住期間再觸發只算一下
    if (p.credit?.kind === 'ahead') { this._pressEvent(p, ev, clock, 'ahead'); return false; }

    // 去抖與估速都用動作時刻：收到的時刻多了輸入與確認的延遲（揮手要等手回升），不是他的節奏
    const head = p.lastHead === null ? null : this._secOf(p.plan.driverSegs[p.lastHead].ticks);
    const blocked = p.tempo.attempt(motion, head === null ? 0 : ((this._secOf(p.plan.driverTicks[j]) - head) * 1000) / p.tempo.playbackRate);
    if (blocked) { this._pressEvent(p, ev, clock, 'blocked'); return false; }

    // 落後太多就跳到合奏位置；揮手超前太多就鎖到只超前 1/2 拍
    const before = { zone: p.zone, offRun: p.offRun };
    let act = this._classify(p, j, motion, ev.source), jumped = false;
    if (act === 'jump') {
      jumped = true;
      this._clockMs = clock;
      this._lastTickMs = ev.receivedMs;
      const chased = this._jumpBehind(p, ev, clock, motion);
      // 合奏位置上沒有他的音：這一下當成提早觸發下一個起音
      j = p.groupEnd;
      if (chased || j >= p.plan.driverSegs.length) {
        this._trackRecovery(p, clock, motion, this._positionAt(motion), true);
        this._pressEvent(p, ev, clock, 'released', true);
        return true;
      }
      p.zone = before.zone;
      p.offRun = before.offRun;
      if (this._restLocked(p, j, motion, clock)) return this._restCredit(p, ev, clock, true);
      act = this._classify(p, j, motion, ev.source);
    }
    this._trackRecovery(p, clock, motion, p.plan.driverTicks[j], jumped);
    if (act === 'lock') {
      p.tempo.accept(j, this._secOf(p.plan.driverTicks[j]), head, motion);   // 鎖住的這一下照樣進估速（放出時不再算）
      p.lastHead = j;
      p.credit = { kind: 'ahead', key: ev.key ?? null, lifted: false, source: ev.source ?? null };
      this._pressEvent(p, ev, clock, 'ahead', jumped);
      return false;
    }
    this._pressEvent(p, ev, clock, 'released', jumped);

    this._clockMs = clock;
    this._lastTickMs = ev.receivedMs;
    const inFlight = this._takeInFlight(p, clock);
    this._flushAutoReleases(p, clock);   // 提早按下一組：這一組還沒到的自動放行先做完
    this._release(p, clock, ev.source ?? null, inFlight, keyupOf(ev.key), false, motion);
    return true;
  }

  _restCredit(p, ev, clock, jumped = false) {
    this._pressEvent(p, ev, clock, 'rest', jumped);
    p.credit = { kind: 'rest', key: ev.key ?? null, lifted: false, source: ev.source ?? null };
    return false;
  }

  // 休止符鎖：起音前有 ≥ REST_LOCK_BEATS 拍的休止、動作時刻離起音 ≥ REST_LOCK_BEATS 拍、收到時合奏還沒走到起音
  _restLocked(p, j, motion, clock) {
    const r = this._restBefore(p, j);
    if (!r || this._beatsBetween(r[0], r[1]) < ENSEMBLE.REST_LOCK_BEATS) return false;
    const e = this._positionAt(motion);
    return this._beatsBetween(e, r[1]) >= ENSEMBLE.REST_LOCK_BEATS && this._positionAt(clock) < r[1] - 1e-6;
  }

  // 相對時間 x＝起音的樂譜位置 − 動作時刻的合奏位置（ms）。非帶頭的人偏離同方向連續 OFF_PERSIST 下或脫隊：落後回 'jump'、揮手超前回 'lock'，其餘 null
  _classify(p, j, motion, source) {
    const x = ((this._secOf(p.plan.driverTicks[j]) - this._secOf(this._positionAt(motion))) * 1000) / this.playbackRate;
    const zone = classifyOffset(x, this._beatMsNow(), p.zone);
    p.xMs = x;
    p.zone = zone;
    if (p === this._ensemble.leader || (zone !== 'off' && zone !== 'lost')) { p.offRun = { sign: 0, count: 0 }; return null; }
    const sign = Math.sign(x);
    p.offRun = { sign, count: p.offRun.sign === sign ? p.offRun.count + 1 : 1 };
    if (zone === 'off' && p.offRun.count < ENSEMBLE.OFF_PERSIST) return null;
    return sign < 0 ? 'jump' : source === 'gesture' ? 'lock' : null;
  }

  // 出狀況的人恢復正常：多數決出狀況的要連續 RECOVER_PERSIST 下同步；停住、代打回來的只看自己穩不穩（現任可能就是比較慢的那位）
  _trackRecovery(p, clock, motion, tick, jumped) {
    if (p.status !== 'trouble') return;
    if (p.statusReason === 'majority') {
      const synced = Math.abs(p.xMs) < threshold(ENSEMBLE.RECOVER_BEATS, ENSEMBLE.SLIGHT_MIN_MS, this._beatMsNow());
      p.recoverCount = synced ? p.recoverCount + 1 : 0;
      if (p.recoverCount >= ENSEMBLE.RECOVER_PERSIST) this._setStatus(p, 'ok', 'recovered', clock);
      return;
    }
    p.steady = extendSteadyRun(p.steady, motion, this._secOf(tick), jumped);
    if (isSteadyRun(p.steady, beatMs(this._score, tick, p.tempo.playbackRate))) this._setStatus(p, 'ok', 'recovered', clock);
  }

  _setStatus(p, status, reason, clock) {
    if (p.status === status) return;
    this.events.queue('performer', { slot: p.slot, from: p.status, to: status, reason, clockMs: clock });
    p.status = status;
    p.statusReason = reason;
    p.recoverCount = 0;
    p.steady = null;
  }

  // 第一段防呆：帶頭的人停住（_stallWhy）或被多數決判定偏離，就標成 trouble、換人
  _checkLeaderTrouble(clock) {
    const L = this._ensemble.leader;
    if (!L || L.status !== 'ok' || L.credit || L.groupEnd >= L.plan.driverSegs.length) return;
    const why = this._stallWhy(L, clock) ?? (this._majorityOff(L, clock) ? 'majority' : null);
    if (!why) return;
    this._setStatus(L, 'trouble', why, clock);
    this._updateLeader(clock, why);
  }

  // 停住了嗎：播放頭到了他的下一個起音之後，'overdue'＝過了寬限還沒按、'absent'＝離開鏡頭 ≥ ABSENT_STAGE1_MS；否則 null（有預按、彈完的不算）
  _stallWhy(p, clock) {
    if (p.credit || p.groupEnd >= p.plan.driverSegs.length) return null;
    const reach = this._reachClockMs(p, p.groupEnd);
    if (reach === null || clock < reach - EPS_MS) return null;
    if (p.absentSinceMs !== null && clock - p.absentSinceMs >= ENSEMBLE.ABSENT_STAGE1_MS) return 'absent';
    return clock >= reach + stage1GraceMs(this._stepMs(p)) ? 'overdue' : null;
  }

  // 這一步（上一個組頭到下一個要按的起音）依他的速度的真實長度（ms）
  _stepMs(p) {
    const j = p.groupEnd, from = p.lastHead ?? j - 1;
    return from < 0 ? 0 : ((this._secOf(p.plan.driverTicks[j]) - this._secOf(p.plan.driverTicks[from])) * 1000) / p.tempo.playbackRate;
  }

  // 多數決：除了 L 以外正在彈的人 ≥ 2 位，過半同方向偏離、各連續 MAJORITY_PERSIST 下
  _majorityOff(L, clock) {
    const others = this._roster.slots().map((s) => this._bySlot.get(s)).filter((q) => q !== L && this._isCandidate(q, null, clock));
    if (others.length < 2) return false;
    return [1, -1].some((sign) => others.filter((q) => q.offRun.sign === sign && q.offRun.count >= ENSEMBLE.MAJORITY_PERSIST).length > others.length / 2);
  }

  /**
   * 在場名單（vision.js 的 presentSlots，每幀呼叫）：記下揮手槽位離開鏡頭的時刻（防呆用；鍵盤永遠在場），有變才發 presence 事件（錄音重播靠它）。
   * @param {number[]} slots
   * @param {number} nowMs  performance.now()
   */
  setPresence(slots, nowMs) {
    const present = new Set(slots), clock = this._clockAt(nowMs);
    let changed = false;
    for (const p of this._performers) {
      if (typeof p.slot !== 'number') continue;
      const wasAbsent = p.absentSinceMs !== null;
      if (present.has(p.slot)) p.absentSinceMs = null;
      else if (p.absentSinceMs === null) p.absentSinceMs = clock;
      if (wasAbsent !== (p.absentSinceMs !== null)) changed = true;
    }
    if (!changed) return;
    this.events.queue('presence', { slots: [...slots], clockMs: clock, receivedMs: nowMs });
    this.events.flush();
  }

  // 落後跳：改放他的聲部在合奏位置 e 該響著的音（追音），整顆在 e 之前的跳過，游標移到第一個 > e 的起音、估速歷史重來。
  // e 落在一組近距起音中間時，同組後面的起音到點自動放行（不然他會一直慢一組、每隔一下又跳）。e 上沒有他的音時回 false，當成提早觸發下一個起音。
  _jumpBehind(p, ev, clock, motion) {
    const e = this.getPositionTicks(), eSec = this._secOf(e), rate = p.tempo.playbackRate;
    const inFlight = this._takeInFlight(p, clock);
    this._flushAutoReleases(p, clock);
    if (p.stalled) { p.stalled = false; this.events.queue('stall', { group: p.index, slot: p.slot, state: 'end', clockMs: clock }); }
    const segs = p.plan.driverSegs, k = upperBound(p.plan.driverTicks, e);
    const pending = p.timed.filter((it) => it.note);
    for (let s = p.groupEnd; s < k; s++) pending.push(...segs[s].items);
    p.timed = [];
    p.clock = [];
    p.cursor = p.groupEnd = k;
    p.tempo.forgetHistory();
    // 他在響的音：結尾在 e 之前的收掉；hold 等 e 以前起音的改照樂譜剩下的長度收
    this._ledger.closeByTick(e, this._clockMs, p.slot);
    this._ledger.retimeHeld(p.slot, (t) => t <= e, (t, tailSec) => clock + scaledMs(Math.max(0, this._secOf(t) + tailSec - eSec), rate));
    this._ledger.closeDue(this._clockMs);
    const chased = [], skipped = [];
    for (const it of pending) {
      if (this._sounded.has(it.note)) continue;
      if (it.note.startTick <= e && it.note.endTick > e) chased.push(it);
      else { skipped.push(it.note); this._skipped.add(it.note); }
    }
    const laneTick = chased.length || k >= segs.length ? e : segs[k].ticks;
    for (const [channel, lane] of this._plan.lanes) if (lane.targets.some((s) => s.slot === p.slot && s.kind === 'human')) this._chaseLane(channel, laneTick);
    if (chased.length || skipped.length || inFlight) this.events.queue('chase', { group: p.index, slot: p.slot, ticks: e, chased: chased.map((it) => it.note), skipped, inFlight });
    if (!chased.length) return false;
    p.tempo.accept(k, this._secOf(this._positionAt(motion)), null, motion);
    const end = this._groupEnd(p, k - 1, rate, ev.source ?? null), keyup = keyupOf(ev.key);
    p.lastHead = k - 1;
    p.groupEnd = end;
    this._anchorSlice(p, k, clock, eSec, rate, e, end, keyup && LIFTED, false);
    this._emitClock(clock);
    for (const { staff, note } of chased) this._sound(staff, note, clock + scaledMs(this._secOf(note.endTick) - eSec, rate), clock, false, false, keyup);
    this._ledger.closeDue(this._clockMs);
    return true;
  }

  /**
   * 放開一個鍵（keyup 模式）：等這個鍵的音收在放開那一刻；組裡被併入的音照檔案走。前奏預按的鍵在入場前放開，入場音就不等鍵。
   * @param {{ slot: number|string, key: string, source?: string|null, eventTimeMs?: number|null, receivedMs: number }} input
   * @returns {boolean} 有沒有收到音
   */
  lift(input) {
    try { return this._lift(input); }
    finally { this.events.flush(); }
  }

  _lift(ev) {
    const p = this._bySlot.get(ev.slot);
    if (ev.key == null || !p) return false;
    if (p.credit && p.credit.key === ev.key) p.credit.lifted = true;
    let clock = this._clockMs;
    if (this._playing) {   // 暫停中時鐘不走
      clock = this._clockAt(ev.receivedMs);
      this._clockMs = clock;
      this._lastTickMs = ev.receivedMs;
    }
    const closed = this._ledger.releaseKey(ev.key, clock);
    this._ledger.closeDue(clock);
    this.events.queue('lift', { group: p.index, slot: ev.slot, key: ev.key, clockMs: clock, closed, eventTimeMs: ev.eventTimeMs ?? null, receivedMs: ev.receivedMs ?? null });
    return closed > 0;
  }

  // hold 放行範圍：他自己的音；帶頭時連伴奏
  _holdScopes(p) {
    return p === this._ensemble.leader ? new Set([p.slot, 'ensemble']) : new Set([p.slot]);
  }

  // 放行 p 的下一個起音（組頭；按鍵與預按到點共用）。他帶頭時伴奏以這一下重新對時，不帶頭時不碰伴奏。
  // keyup：組頭等鍵放開、組裡的音照檔案長度。tempoAccepted：超前鎖時已進過估速。放行就用掉他的預按。
  _release(p, clock, source = null, inFlight = 0, keyup = null, tempoAccepted = false, motion = clock) {
    const j = p.cursor, seg = p.plan.driverSegs[j];
    const scoreSec = this._secOf(seg.ticks);
    const isLeader = p === this._ensemble.leader;
    p.credit = null;
    if (p.stalled) { p.stalled = false; this.events.queue('stall', { group: p.index, slot: p.slot, state: 'end', clockMs: clock }); }
    // 第一次放行：他的控制器軌先帶到這個起音之前的狀態
    if (p.anchor === null) for (const [channel, lane] of this._plan.lanes) if (lane.targets.some((s) => s.slot === p.slot && s.kind === 'human')) this._chaseLane(channel, seg.ticks);
    if (!tempoAccepted) p.tempo.accept(j, scoreSec, p.lastHead === null ? null : this._secOf(p.plan.driverSegs[p.lastHead].ticks), motion);
    const rate = p.tempo.playbackRate;
    const end = this._groupEnd(p, j, rate, source);                 // [j＋1, end) 到點自動放行
    // 到期還沒放的先放（游標前進之前，結尾對齊這個起音的才會 hold、下面收得到）
    this._emitTimed();
    p.lastHead = j;
    p.cursor = j + 1;
    p.groupEnd = end;
    this.events.queue('release', { group: p.index, slot: p.slot, index: j, ticks: seg.ticks, clockMs: clock });
    if (end > j + 1) {
      const merged = p.plan.driverSegs.slice(j + 1, end).map((s, i) => ({ index: j + 1 + i, ticks: s.ticks }));
      this.events.queue('group', { group: p.index, slot: p.slot, index: j, ticks: seg.ticks, merged, clockMs: clock });
    }

    this._ledger.closeByTick(seg.ticks, this._clockMs, p.slot);
    this._ledger.releaseHeld(this._holdScopes(p), seg.ticks, clock, rate);   // hold 等這個起音的音在按下這一刻收
    this._ledger.closeDue(this._clockMs);
    this._emitClock(this._clockMs);
    // 早按：上一段還沒輪到的音不能再照原時刻放（會跟他不同步甚至倒序），改跳到這個起音的垂直狀態（_chaseOrSkip）；錨點永遠是按下的時刻
    this._chaseOrSkip(p, seg.ticks, scoreSec, clock, inFlight, isLeader);
    this._anchorSlice(p, j + 1, clock, scoreSec, rate, -Infinity, end, keyup && LIFTED, isLeader);
    this._emitClock(clock);                                         // 同 tick 的控制器（program change 等）在他的音之前
    for (const { staff, note } of seg.items) this._sound(staff, note, clock + scaledMs(this._secOf(note.endTick) - scoreSec, rate), clock, false, false, keyup);
    this._emitTimed();                                              // 同 tick 的伴奏跟他同刻
    this._emitClock(this._clockMs);
    this._ledger.closeDue(this._clockMs);                           // 零長度的音
  }

  // 近距起音分組（門檻與依據見 tempo.js），回傳這一組的結束（不含）。從組頭 j 往後串，任一層成立就併：
  //   ① 和弦：距組頭的樂譜間隔 < CHORD_SPREAD_S。量距組頭不量相鄰，否則一長串 < 50 ms 的快音會整串併成一下；
  //   ② 按不及：相鄰間隔換成真實時間 < minPressIntervalSec，而且距組頭不超過 maxGroupSpanSec（手勢）。
  // oneSlice 只關 ②：連 ① 都關的話，真人 MIDI 的和弦每個音都要按，估速被拉到下限、合奏幾乎不動。
  _groupEnd(p, j, rate, source) {
    const segs = p.plan.driverSegs, oneSlice = this._modeOf(source).oneSlice;
    const minSec = minPressIntervalSec(source), spanSec = maxGroupSpanSec(source), headSec = this._secOf(segs[j].ticks);
    let m = j + 1;
    while (m < segs.length) {
      const sec = this._secOf(segs[m].ticks), gap = sec - this._secOf(segs[m - 1].ticks);
      if (!(sec - headSec < CHORD_SPREAD_S || (!oneSlice && gap / rate < minSec && (sec - headSec) / rate < spanSec))) break;
      m++;
    }
    return m;
  }

  // 組裡被併入的起音 s 到點：收掉結束的音、放行 hold 等它的音（跟按下它一樣），但不動估速與去抖
  _autoRelease(p, s, atMs) {
    const ticks = p.plan.driverSegs[s].ticks;
    p.cursor = s + 1;
    p.lastAutoMs = atMs;
    this._ledger.closeByTick(ticks, this._clockMs, p.slot);
    this._ledger.releaseHeld(this._holdScopes(p), ticks, atMs, p.tempo.playbackRate);
    this.events.queue('autoRelease', { group: p.index, slot: p.slot, index: s, ticks, dueMs: atMs, clockMs: this._clockMs });
  }

  // 提早按下一組時，這一組還沒到的自動放行在這一刻做完
  _flushAutoReleases(p, clock) {
    if (p.cursor >= p.groupEnd) return;
    const rest = [];
    for (const item of p.clock) {
      if (item.autoRelease !== undefined) this._autoRelease(p, item.autoRelease, clock);
      else rest.push(item);
    }
    p.clock = rest;
  }

  // 按下時，已提早送出、還沒到時刻的他的音有幾顆（取消不了；統計用）
  _takeInFlight(p, clock) {
    let n = 0;
    for (const dueMs of p.ownSent) if (dueMs > clock + EPS_MS) n++;
    p.ownSent = [];
    return n;
  }

  // 早按時的垂直切片（Antescofo 的 @tight＋@local、DAW 的 Chase Events）：佇列裡還沒輪到的音，endTick > T_k 的追音（長度＝剩餘 ÷ 速度），
  // 整顆在身後的跳過、不發聲（N3，使用者決定維持；改成補發會一次湧出幾十到上百顆）。控制器不逐一重播，先帶到 T_k 之前的狀態；SysEx 依序馬上送。
  _chaseOrSkip(p, ticks, scoreSec, clock, inFlight = 0, withEnsemble = false) {
    const E = this._ensemble;
    const left = withEnsemble ? bySeq(p.timed, E.timed) : p.timed;
    const leftClock = withEnsemble ? bySeq(p.clock, E.clock) : p.clock;
    if (!left.length && !leftClock.length && !inFlight) return;
    p.timed = [];
    p.clock = [];
    if (withEnsemble) { E.timed = []; E.clock = []; }
    let lanes = null;
    const notes = [];
    for (const it of left) {
      if (it.note) notes.push(it);
      else if (it.sysex) this._router.sendSysex(it.ev.data);
      else (lanes ??= new Set()).add(it.ev.channel);
    }
    for (const c of leftClock) if (c.ev) (lanes ??= new Set()).add(c.ev.channel);
    if (lanes) for (const channel of lanes) this._chaseLane(channel, ticks);
    if (!notes.length && !inFlight) return;
    const chased = [], skipped = [];
    for (const it of notes) {
      if (it.note.endTick > ticks) {
        chased.push(it.note);
        this._sound(it.staff, it.note, clock + scaledMs(this._secOf(it.note.endTick) - scoreSec, p.tempo.playbackRate), clock, false, false, it.mode);
      } else {
        skipped.push(it.note);
        this._skipped.add(it.note);
      }
    }
    this.events.queue('chase', { group: p.index, slot: p.slot, ticks, chased, skipped, inFlight });
  }

  // 控制器軌帶到 tick 之前的狀態（追蹤器只往後套用，不重算整條）
  _chaseLane(channel, ticks) {
    const lane = this._plan.lanes.get(channel);
    if (!lane) return;
    let t = this._laneTrackers.get(channel);
    if (!t) this._laneTrackers.set(channel, (t = { tracker: new ChannelStateTracker(), pos: 0 }));
    const { events } = lane;
    while (t.pos < events.length && events[t.pos].ticks < ticks) t.tracker.apply(events[t.pos++]);
    this._sendLaneState(lane, t.tracker.chase());
  }

  // 發聲並記進 _sounded。hold 歸誰：演奏者的譜表等他自己的下一個起音，伴奏等帶頭的人；音長看同一個人的速度。
  _sound(staff, note, offMs, dueMs, fromTick = false, timed = false, mode = null) {
    this._sounded.add(note);
    const human = staff.kind === 'human';
    const owner = human ? this._bySlot.get(staff.slot) : this._holdOwner();
    this._ledger.sound(staff, note, offMs, dueMs, {
      holdScope: human ? staff.slot : 'ensemble', holdTicks: owner.plan.driverTicks, holdFrom: owner.cursor,
      rate: owner.tempo.playbackRate, fromTick, clockMs: this._clockMs, timed, mode: mode ?? null,
      holdToNext: human && this._modeOf(owner.lastSource).holdToNext,
    });
  }

  // 各 timed 佇列裡時刻 ≤ limitMs 的項目依 (時刻, 建批次順序) 合併送出（音、控制器、SysEx）；組裡他的音也帶 lookahead 時間戳
  _emitTimed(limitMs = this._clockMs, fromTick = false) {
    const queues = [this._ensemble.timed];
    for (const p of this._performers) queues.push(p.timed);
    const idx = new Array(queues.length).fill(0);
    for (;;) {
      let best = -1, it = null;
      for (let q = 0; q < queues.length; q++) {
        const x = queues[q][idx[q]];
        if (x === undefined || x.dueMs > limitMs + EPS_MS) continue;
        if (it === null || x.dueMs < it.dueMs || (x.dueMs === it.dueMs && x.seq < it.seq)) { best = q; it = x; }
      }
      if (best < 0) break;
      idx[best]++;
      if (it.note) {
        this._sound(it.staff, it.note, it.offMs, it.dueMs, fromTick, it.own, it.mode);
        if (it.own && it.dueMs > this._clockMs + EPS_MS) it.owner.ownSent.push(it.dueMs);
      } else if (it.sysex) this._router.sendSysex(it.ev.data, this._router.stampTime(it.dueMs));
      else this._sendControl(it);
    }
    if (idx[0]) this._ensemble.timed.splice(0, idx[0]);
    this._performers.forEach((p, i) => { if (idx[i + 1]) p.timed.splice(0, idx[i + 1]); });
  }

  // 各 clock 佇列裡時刻已到的項目依 (時刻, 建批次順序) 合併做（控制器、自動放行）；不提早
  _emitClock(limitMs) {
    const queues = [this._ensemble.clock];
    for (const p of this._performers) queues.push(p.clock);
    const idx = new Array(queues.length).fill(0);
    for (;;) {
      let best = -1, it = null;
      for (let q = 0; q < queues.length; q++) {
        const x = queues[q][idx[q]];
        if (x === undefined || x.dueMs > limitMs + EPS_MS) continue;
        if (it === null || x.dueMs < it.dueMs || (x.dueMs === it.dueMs && x.seq < it.seq)) { best = q; it = x; }
      }
      if (best < 0) break;
      idx[best]++;
      if (it.autoRelease !== undefined) this._autoRelease(it.owner, it.autoRelease, it.dueMs);
      else this._sendControl(it);
    }
    if (idx[0]) this._ensemble.clock.splice(0, idx[0]);
    this._performers.forEach((p, i) => { if (idx[i + 1]) p.clock.splice(0, idx[i + 1]); });
  }

  _sendControl({ dueMs, ev, targets }) {
    for (const staff of targets) this._router.sendChannelEvent(staff, ev, this._router.stamp(staff, dueMs));
    if (this.events.has('control')) {
      this.events.queue('control', { id: ev.id, ticks: ev.ticks, type: ev.type, outputs: targets.map((s) => ({ kind: s.kind, channel: s.channel })), dueMs, clockMs: this._clockMs });
    }
  }

  /** 量測：tick() 放出的電腦音比排好的時刻晚多少 ms（tick 被主執行緒延後造成的；不含 worklet 與輸出延遲）。 */
  lateStats() { return this._lateStats.stats(); }

  /** 量測：早按的處理結果 { presses, chased, skipped, inFlight }。 */
  chaseStats() { return this._chaseStats.stats(); }

  /** 量測：帶頭的人的速度區間 { lo, hi }（複本）。 */
  rateBounds() { return { ...this._holdOwner().tempo.bounds }; }

  // 按鍵嘗試的事件。result：'released'｜'blocked'（去抖）｜'prelude'｜'rest'｜'ahead'（預按）｜'takeover'（接手代打）；jumped＝落後跳
  _pressEvent(p, ev, clockMs, result, jumped = false) {
    this.events.queue('press', { group: p.index, slot: ev.slot, source: ev.source ?? null, key: ev.key ?? null, result, jumped, clockMs, eventTimeMs: ev.eventTimeMs ?? null, receivedMs: ev.receivedMs ?? null });
  }

  /** 量測：這一輪每次按鍵嘗試的記錄（複本）。 */
  pressLog() { return this._pressLog.log(); }

  /** 量測：這一輪每次放開的記錄（複本）。 */
  liftLog() { return this._pressLog.liftLog(); }

  /** 開啟錄音用的事件記錄（performanceEvents.js 的 eventLogSubscriber）。 */
  enableEventLog() {
    if (!this._eventLog) this._eventLog = eventLogSubscriber(this.events);
  }

  /** 這一輪的事件記錄（複本；沒開是空陣列）。 */
  eventLog() { return this._eventLog ? this._eventLog.log() : []; }

  /**
   * 排程 tick（約 12ms）：推進時鐘、放出到時間的伴奏與組裡的音、收掉到期的音。演奏者的起音只來自 trigger()（預按到點與代打除外）。
   * @param {number} nowMs  performance.now()
   * @param {number} [audioNow]  AudioContext 的時間（秒）；有給才啟用 lookahead
   */
  tick(nowMs, audioNow) {
    if (!this._playing || !this._score) return;
    this._ensureEnsembleAnchored();
    const dt = this._lastTickMs == null ? 0 : Math.min(MAX_TICK_DT_MS, Math.max(0, nowMs - this._lastTickMs));
    this._lastTickMs = nowMs;
    this._clockMs += dt;
    const timed = Number.isFinite(audioNow);
    this._router.setAudioBase(timed ? { audio: audioNow, clock: this._clockMs } : null);  // 只在這個 tick 內有效
    try {
      this._askForecasters();   // 換錨與換帶頭都在收音發聲之前，這個 tick 放出的音才照新的
      this._rosterTick();
      this._tickBody(timed ? this._clockMs + LOOKAHEAD_MS : this._clockMs);
      this._queueStateEvents();
    } finally {
      this._router.setAudioBase(null);
      this.events.flush();
    }
  }

  // 狀態改變的事件只在改變時發一次：停格開始（結束在 _release() 發）、播完
  _queueStateEvents() {
    for (const p of this._performers) {
      const reach = this._reachClockMs(p);
      if (!p.stalled && reach !== null && this._clockMs >= reach - EPS_MS) {
        p.stalled = true;
        this.events.queue('stall', { group: p.index, slot: p.slot, state: 'start', clockMs: reach });
      }
    }
    if (!this._finishSent && this.isFinished()) {
      this._finishSent = true;
      this.events.queue('finish', { clockMs: this._clockMs });
    }
  }

  _askForecasters() {
    for (const p of this._performers) {
      const f = this._forecasters[p.index];
      if (f) this._applyForecast(p, f.forecast(this._forecastView(p)));
    }
  }

  // 給預報器看的唯讀資料
  _forecastView(p) {
    const segs = p.plan.driverSegs, next = p.groupEnd, from = p.lastHead ?? next - 1;
    return {
      group: p.index, cursor: next, clockMs: this._clockMs, anchor: p.anchor && { ...p.anchor },
      segmentStartSec: from >= 0 ? this._secOf(segs[from].ticks) : null,
      nextOnsetSec: next < segs.length ? this._secOf(segs[next].ticks) : null,
      rate: p.tempo.playbackRate, rateBounds: { ...p.tempo.bounds },
    };
  }

  // 段中換錨：預報說他會在 f.atMs 按下一個組頭，就以（現在, 此刻樂譜位置 pos, 新速度）為錨點，重排佇列裡 pos 之後還沒送出的項目（已送出、已過期的碰不到）
  _applyForecast(p, f) {
    if (!f) return;
    const now = this._clockMs, j = p.groupEnd, next = p.plan.driverSegs[j], a = p.anchor;
    const reach = this._reachClockMs(p, j);
    const applied = j >= 1 && !!next && !!a && reach !== null && now < reach && f.atMs > now
      && Math.abs(f.atMs - reach) >= this.cfg.forecastMinChangeMs;
    this.events.queue('forecast', { group: p.index, index: j, clockMs: now, atMs: f.atMs, uncertaintyMs: f.uncertaintyMs ?? null, source: f.source ?? null, applied });
    if (!applied) return;
    const pos = a.scoreSec + ((now - a.clockMs) * a.rate) / 1000;
    const { lo, hi } = p.tempo.bounds;
    const rate = Math.min(hi, Math.max(lo, ((this._secOf(next.ticks) - pos) * 1000) / (f.atMs - now)));
    const anchor = { slice: a.slice, clockMs: now, scoreSec: pos, rate };
    const E = this._ensemble, withEnsemble = E.anchor === a;
    p.anchor = anchor;
    if (withEnsemble) E.anchor = anchor;
    let retimed = 0;
    // 他帶頭時連伴奏與代打中的人一起重排
    const items = withEnsemble ? [...p.timed, ...p.clock, ...E.timed, ...E.clock, ...this._performers.filter((q) => q.status === 'substitute').flatMap((q) => [...q.timed, ...q.clock])] : [...p.timed, ...p.clock];
    for (const q of items) {
      const startSec = this._secOf(itemTick(q));
      if (startSec <= pos) continue;                                  // 已過期：照原時刻（馬上）放
      q.dueMs = now + ((startSec - pos) * 1000) / rate;
      if (!q.note) continue;
      q.offMs = q.dueMs + scaledMs(this._secOf(q.note.endTick) - startSec, rate);
      retimed++;
    }
    this.events.queue('reanchor', { group: p.index, slice: a.slice, clockMs: now, scoreSec: pos, rate, retimed });
  }

  _tickBody(horizonMs) {
    this._ledger.closeDue(this._clockMs, horizonMs);     // 先收再放：同音高的相連音才不會被連帶關掉
    this._emitTimed(horizonMs, true);
    this._emitClock(this._clockMs);
    this._ledger.closeDue(this._clockMs, horizonMs);     // 剛發聲就到期的短音
    // 預按到點放出（前奏鎖：走到入場點；休止符鎖：合奏走到起音；超前鎖：只差 AHEAD_RELEASE_BEATS 拍）。放行時刻取剛好到達那一刻，錨點才接在合奏時間軸上；也算他觸發了一下
    for (const p of this._performers) {
      const c = p.credit;
      if (!c) continue;
      const tick = p.plan.driverTicks[p.groupEnd];
      const at = c.kind === 'prelude' ? this._reachClockMs(p)
        : this._ensembleReachMs(c.kind === 'ahead' ? this._ticksBefore(tick, ENSEMBLE.AHEAD_RELEASE_BEATS) : tick);
      if (at === null || this._clockMs < at - EPS_MS) continue;
      // 鍵還按著就等 keyup，已放開就照檔案長度收
      const keyup = c.key != null ? (c.lifted ? LIFTED : keyupOf(c.key)) : null;
      p.lastTriggerMs = Math.max(p.lastTriggerMs, at);
      this._flushAutoReleases(p, at);
      this._release(p, at, c.source, 0, keyup, c.kind === 'ahead');
    }
  }

  // tick 往前 beats 拍的位置
  _ticksBefore(tick, beats) {
    const s = this._score;
    return s.timeDivision ? tick - beats * s.timeDivision : s.secondsToMIDITicks(this._secOf(tick) - beats * ENSEMBLE.SMPTE_BEAT_SEC);
  }

  // 合奏走到 target 的時鐘時刻（夾在錨點與現在之間）；還沒走到回 null
  _ensembleReachMs(target) {
    if (this.getPositionTicks() < target - 1e-6) return null;
    const a = this._ensemble.anchor;
    return Math.min(this._clockMs, Math.max(a.clockMs, a.clockMs + ((this._secOf(target) - a.scoreSec) * 1000) / a.rate));
  }
}
