// voices.js — OutputRouter：輸出 channel 分配、初始音色、lookahead 時間戳，排程器裡唯一呼叫合成器（assist、human，由 synth.js 注入）的地方；
// 每次呼叫都包 try／catch 並 warn 一次，音源掛掉不能拖垮排程。VoiceLedger：正在響的音、hold、尾巴收尾。
// 控制器 shadow：每個合成器 × 輸出 channel 記最後送出的值；狀態補送只送不同的值。同一 channel 的控制器依送出順序生效（_ordered()），shadow 才等於合成器的狀態。

import { CC, RESET_CC, PARAMETER_CC, GM_DEFAULT_MIXER, PITCH_BEND_CENTER } from '../midi/midiParser.js';

// 同官方 Sequencer：一個 port 16 個 channel、只增不減，每個 port 的 channel 9 是打擊。DEFAULT_PORTS 開機就補到；需要更多時 synth.js 的 load() 補，再 setPortCount()。
// 不能讀 synth.midiChannels.length（addNewChannel() 要等 worklet 回 channelAdded 才算進去），數字由這裡與 synth.js 自己計數。
export const CHANNELS_PER_PORT = 16;
export const DEFAULT_PORTS = 4;
// GM 預設值（官方 SpessaSynth 的 DEFAULT_MIDI_CONTROLLERS；沒列的是 0）：重設 channel 時，中途改過、CC121 不管的控制器送回這個值。
const CC_DEFAULTS = new Map([[7, 100], [8, 64], [10, 64], [11, 127], [71, 64], [72, 64], [73, 64], [74, 64], [75, 64], [76, 64], [77, 64], [78, 64], [81, 64], [83, 64]]);
// 重設 channel 時不送回預設值的 CC：bank 與初始音色的混音 CC7／10／91／93（之後一定重送）、RPN／NRPN（chase 照順序重播）、
// channel mode 訊息 120～127（瞬間指令，不是狀態）。
const RESEND_LATER = new Set([0, 32, 7, 10, 91, 93]);
const notState = (cc) => RESEND_LATER.has(cc) || PARAMETER_CC.has(cc) || cc >= 120;
const ccEvent = (cc, value) => ({ type: 'controlChange', data1: cc, data2: value, value });
const bendEvent = (value) => ({ type: 'pitchBend', data1: value & 0x7f, data2: value >> 7, value });

// 這個合成器上可用的旋律輸出 channel＝跳過每個 port 的打擊槽（ch % 16 === drumChannel）。
function melodicChannelsFor(synth, drumChannel, ports) {
  const total = synth ? ports * CHANNELS_PER_PORT : CHANNELS_PER_PORT;
  const out = [];
  for (let ch = 0; ch < total; ch++) {
    if (ch % CHANNELS_PER_PORT !== drumChannel) out.push(ch);
  }
  return out;
}

// 這個合成器上的打擊輸出 channel＝每個 port 的打擊槽（9／25／41／57）：合成器只有一個 port 時只有 drumChannel 一個。
function drumChannelsFor(synth, drumChannel, ports) {
  const n = synth ? ports : 1;
  return Array.from({ length: n }, (_, p) => p * CHANNELS_PER_PORT + drumChannel);
}

// 每個 staff 各配一個輸出 channel（原本共用同一個 channel 的 staff 才不打架）。打擊 staff 依鼓組 program 各佔一個打擊槽（同鼓組共用）；
// 排不進去的回報給呼叫端，不出聲。
function allocateChannels(staves, melodicChannels, drumChannels) {
  const byStaffId = new Map();
  const unplaced = [];
  const kitChannel = new Map(); // 鼓組 program → 輸出 channel
  let next = 0;
  for (const s of staves) {
    // percussionKit 已依 Bank Select 判定（channel 9 用 Bank 121 切成旋律時不算打擊，見 parts.js 的 isPercussionBank()）
    if (s.percussionKit) {
      if (!kitChannel.has(s.program) && kitChannel.size < drumChannels.length) kitChannel.set(s.program, drumChannels[kitChannel.size]);
      if (kitChannel.has(s.program)) byStaffId.set(s.id, kitChannel.get(s.program));
      else unplaced.push(s.id);
      continue;
    }
    if (next < melodicChannels.length) byStaffId.set(s.id, melodicChannels[next++]);
    else unplaced.push(s.id);
  }
  return { byStaffId, unplaced };
}

// 至少需要幾個 port（≥ DEFAULT_PORTS）：旋律每 port 15 個、每種鼓組佔一個 port 的打擊槽。pools＝[{ melodic: 旋律 staff 數, kits: Set<鼓組 program> }]，取最多的
export function portsFor(pools) {
  const melodicPerPort = CHANNELS_PER_PORT - 1; // 每個 port 扣掉打擊槽
  return Math.max(DEFAULT_PORTS, ...pools.map((p) => Math.max(Math.ceil(p.melodic / melodicPerPort), p.kits.size)));
}

export class OutputRouter {
  constructor(drumChannel) {
    this.drumChannel = drumChannel;
    this.assistSynth = null;   // 電腦輔助聲部（follower）的合成器
    this.humanSynth = null;    // 被指派聲部（driver）的合成器
    this.ports = DEFAULT_PORTS; // 合成器目前有幾個 port（每個 16 個 channel）；synth.js 補 channel 之後用 setPortCount() 更新
    this._audioBase = null;    // 只在 tick() 執行期間有值：{ audio: AudioContext 秒, clock: 排程器時鐘 }，換算時間戳用
    this._shadow = new Map();  // 'assist:輸出 channel'／'human:輸出 channel' → { cc: Map<編號, 值>, program, pitchBend, channelPressure, paused }
    this._floor = new Map();   // 同上的鍵（與 'sysex'）→ 這個輸出 channel 最後一個控制器的時間戳（AudioContext 秒）：之後送的不早於它（見 _ordered()）
    this._warned = new Set();  // 已經 warn 過的合成器呼叫種類（見 _warnOnce()）
    this._sysexSent = false;   // 送過整體參數的 SysEx（重播、換歌前要整個重設合成器，見 resetIfSysexSent()）
  }

  setSynths(assistSynth, humanSynth) {
    this.assistSynth = assistSynth;
    this.humanSynth = humanSynth;
    this._floor.clear();       // 新的合成器（新的 AudioContext，時間從頭算）：舊的時間戳沒有意義
  }

  setPortCount(ports) {
    this.ports = ports;
  }

  synthOf(staff) {
    return staff.kind === 'human' ? this.humanSynth : this.assistSynth;
  }

  // 指派聲部只配 humanSynth 的 channel、未指派只配 assistSynth 的：兩個池子各自獨立，配額用完的 staff 回報在 unplaced（指派的在前），這一輪不出聲
  allocate(assignedSpecs, assistSpecs) {
    const { byStaffId: humanCh, unplaced: u1 } =
      allocateChannels(assignedSpecs, melodicChannelsFor(this.humanSynth, this.drumChannel, this.ports), drumChannelsFor(this.humanSynth, this.drumChannel, this.ports));
    const { byStaffId: assistCh, unplaced: u2 } =
      allocateChannels(assistSpecs, melodicChannelsFor(this.assistSynth, this.drumChannel, this.ports), drumChannelsFor(this.assistSynth, this.drumChannel, this.ports));
    return { humanCh, assistCh, unplaced: [...u1, ...u2] };
  }

  // 初始狀態：bank／program＋混音 CC7／10／91／93（staff.init＝檔案 tick 0 的值，沒有就送 GM 預設），比任何 noteOn 早。只送跟 shadow 不同的
  applyInitialPatch(staff) {
    const { bank, init } = staff;
    this.sendStateDiff(staff, [
      ccEvent(0, bank?.msb || 0), ccEvent(32, bank?.lsb || 0), { type: 'programChange', data1: staff.program || 0, data2: 0, value: staff.program || 0 },
      ccEvent(7, staff.baseVolume), ccEvent(10, init?.pan ?? GM_DEFAULT_MIXER.pan), ccEvent(91, init?.reverb ?? GM_DEFAULT_MIXER.reverb), ccEvent(93, init?.chorus ?? GM_DEFAULT_MIXER.chorus),
    ]);
  }

  // 輸出 channel 的鍵（shadow 與時間戳下限共用）：哪個合成器＋哪個 channel
  _keyOf(staff) { return `${staff.kind === 'human' ? 'human' : 'assist'}:${staff.channel}`; }

  // 這個輸出 channel 已經送出的狀態（每個合成器各一份；第一次用到時建一份空的＝不知道合成器現在的值）
  _shadowOf(staff) {
    const key = this._keyOf(staff);
    let sh = this._shadow.get(key);
    if (!sh) this._shadow.set(key, (sh = { cc: new Map(), program: null, pitchBend: null, channelPressure: null, mode: null, paused: null }));
    return sh;
  }

  /** 合成器剛被清場（換歌載入）：不知道它現在的狀態，之後的狀態補送全部重送。 */
  clearShadow() { this._shadow.clear(); }

  /**
   * 送一個 channel 事件（控制器軌事件形狀：type、data1、data2、value）到這個 staff 的輸出 channel，並記進 shadow。opts＝lookahead 的時間戳（eventOptions），沒有就立刻處理。
   * poly pressure 是每個音的，channel mode 訊息（120～127）是瞬間指令，都不記 shadow；其中 CC121 會重設一批控制器，shadow 跟著改成重設後的值。
   */
  sendChannelEvent(staff, ev, opts) {
    if (!this.synthOf(staff)) return;
    const sh = this._shadowOf(staff);
    switch (ev.type) {
      case 'controlChange':
        if (ev.data1 === CC.RESET_ALL) this._markReset(sh);
        else if (ev.data1 === CC.MONO || ev.data1 === CC.POLY) sh.mode = ev.data1;
        else if (ev.data1 < 120) sh.cc.set(ev.data1, ev.value);
        break;
      case 'programChange': sh.program = ev.value; break;
      case 'pitchBend': sh.pitchBend = ev.value; break;
      case 'channelAftertouch': sh.channelPressure = ev.value; break;
    }
    this._send(staff, ev, opts);
  }

  // CC121 之後合成器的狀態（RP-015）：重設的控制器記成預設值；暫停前記下的值也作廢（channel 已重設，續播不該恢復）
  _markReset(sh) {
    for (const [cc, value] of RESET_CC) sh.cc.set(cc, value);
    sh.pitchBend = PITCH_BEND_CENTER;
    sh.channelPressure = 0;
    sh.paused = null;
  }

  // 呼叫合成器（不碰 shadow）
  _send(staff, ev, opts) {
    const synth = this.synthOf(staff);
    if (!synth) return;
    const ch = staff.channel;
    opts = this._ordered(this._keyOf(staff), opts);
    try {
      switch (ev.type) {
        case 'controlChange': synth.controllerChange(ch, ev.data1, ev.value, opts); break;
        case 'programChange': synth.programChange(ch, ev.value, opts); break;
        case 'pitchBend': synth.pitchWheel(ch, ev.value, opts); break;
        case 'channelAftertouch': synth.channelPressure(ch, ev.value, opts); break;
        case 'polyAftertouch': synth.polyPressure(ch, ev.data1, ev.value, opts); break;
      }
    } catch (err) { this._warnOnce(ev.type, err); }
  }

  // 合成器呼叫失敗不能拖垮排程，但要讓人看得到：每種呼叫只 warn 一次，不然每顆音一則會洗版
  _warnOnce(kind, err) {
    if (this._warned.has(kind)) return;
    this._warned.add(kind);
    console.warn(`合成器呼叫「${kind}」失敗（已略過、不影響排程，同種失敗不再提示）：`, err);
  }

  // 同一輸出 channel 的控制器依送出順序生效：帶時間戳、還沒生效的控制器之後，再送的時間戳不早於它，不然舊值晚一步蓋掉新值（踏板卡住、shadow 對不上）。
  // 已過去的時間戳 worklet 立刻處理，所以立刻送的不會變晚；同時間戳依送出順序（穩定排序）。key：_keyOf() 或 'sysex'
  _ordered(key, opts) {
    const floor = this._floor.get(key), time = opts?.time;
    if (floor === undefined) {
      if (time !== undefined) this._floor.set(key, time);
      return opts;
    }
    const t = time !== undefined && time > floor ? time : floor;
    this._floor.set(key, t);
    return { time: t };
  }

  /**
   * 重設這個輸出 channel 的控制器（載入、重播、改指派時，送初始音色與這首歌的狀態之前）：CC121（踏板放開、彎音回中央、表情 127…，RP-015），
   * 再把 shadow 裡中途改過、CC121 不管的控制器（音色亮度、CC2 等）送回 GM 預設，不然會留到重播或下一首。bank、混音 CC7／10／91／93 不送（初始音色馬上重送）。
   */
  resetChannel(staff) {
    if (!this.synthOf(staff)) return;
    this.sendChannelEvent(staff, ccEvent(CC.RESET_ALL, 0));
    const sh = this._shadowOf(staff);
    for (const [cc, value] of sh.cc) {
      const def = CC_DEFAULTS.get(cc) ?? 0;
      if (!notState(cc) && value !== def) this.sendChannelEvent(staff, ccEvent(cc, def));
    }
  }

  // 狀態補送（載入、早按的 chase、重播、改指派）：只送跟 shadow 不同的、立刻處理。例外：RPN／NRPN 照順序全送；
  // bank 變了，後面的 program change 值一樣也要送（新 bank 在 program change 時才生效，GM2 §3.3.1）
  sendStateDiff(staff, events) {
    const sh = this._shadowOf(staff);
    let bankChanged = false;
    for (const ev of events) {
      if (ev.type === 'controlChange') {
        // CC126／127 合成器會先停掉整個 channel 的音再切模式（CC121 不動它），所以模式沒變就不能重送
        if (ev.data1 === CC.MONO || ev.data1 === CC.POLY) { if (sh.mode === ev.data1) continue; }
        else if (!PARAMETER_CC.has(ev.data1) && sh.cc.get(ev.data1) === ev.value) continue;
        if (ev.data1 === 0 || ev.data1 === 32) bankChanged = true;
      } else if (ev.type === 'programChange') {
        if (sh.program === ev.value && !bankChanged) continue;
        bankChanged = false;
      } else if (ev.type === 'pitchBend') {
        if (sh.pitchBend === ev.value) continue;
      } else if (ev.type === 'channelAftertouch') {
        if (sh.channelPressure === ev.value) continue;
      }
      this.sendChannelEvent(staff, ev);
    }
  }

  // 暫停：放開 CC64／66、彎音歸中央，記住原值給續播（MIDI 1.0：踏板踩著時 Note Off 與 All Notes Off 不生效，會卡音；停止時控制器應歸位）。
  // 沒踩、沒彎就不送也不記（再暫停一次不會蓋掉記下的值）
  releaseForPause(staff) {
    const sh = this._shadow.get(this._keyOf(staff));
    if (!sh || sh.paused) return;                                  // 沒送過東西／已經放開過、還沒續播
    const saved = { hold: sh.cc.get(CC.HOLD), sostenuto: sh.cc.get(CC.SOSTENUTO), pitchBend: sh.pitchBend };
    const bent = saved.pitchBend !== null && saved.pitchBend !== PITCH_BEND_CENTER;
    if (!(saved.hold > 0) && !(saved.sostenuto > 0) && !bent) return;
    sh.paused = saved;
    if (saved.hold > 0) this.sendChannelEvent(staff, ccEvent(CC.HOLD, 0));
    if (saved.sostenuto > 0) this.sendChannelEvent(staff, ccEvent(CC.SOSTENUTO, 0));
    if (bent) this.sendChannelEvent(staff, bendEvent(PITCH_BEND_CENTER));
  }

  // 續播：恢復暫停前的踏板與彎音（只恢復一次）
  restoreAfterPause(staff) {
    const sh = this._shadow.get(this._keyOf(staff)), saved = sh?.paused;
    if (!saved) return;
    sh.paused = null;
    if (saved.hold > 0) this.sendChannelEvent(staff, ccEvent(CC.HOLD, saved.hold));
    if (saved.sostenuto > 0) this.sendChannelEvent(staff, ccEvent(CC.SOSTENUTO, saved.sostenuto));
    if (saved.pitchBend !== null && saved.pitchBend !== PITCH_BEND_CENTER) this.sendChannelEvent(staff, bendEvent(saved.pitchBend));
  }

  // 暫停中改指派：舊的「暫停前的值」對不上新的分配，丟掉（排程器重送 chase 之後再依新的狀態放開一次）
  forgetPauseSaves() {
    for (const sh of this._shadow.values()) sh.paused = null;
  }

  // 整體參數的 SysEx 兩個合成器都送、同一個時間，真人與電腦的平衡不變（規則見 performancePlan.js）。data＝F0 之後的位元組（含 F7）
  sendSysex(data, opts) {
    opts = this._ordered('sysex', opts);
    this._sysexSent = true;
    for (const synth of [this.assistSynth, this.humanSynth]) {
      try { synth?.systemExclusive(data, 0, opts); } catch (err) { this._warnOnce('systemExclusive', err); }
    }
  }

  /** 送過整體參數的 SysEx 之後，重播與換歌前整個 reset() 兩個合成器（CC121 管不到整體參數），shadow 清掉。回傳有沒有重設。 */
  resetIfSysexSent() {
    if (!this._sysexSent) return false;
    this._sysexSent = false;
    for (const synth of [this.assistSynth, this.humanSynth]) {
      try { synth?.reset(); } catch (err) { this._warnOnce('reset', err); }
    }
    this.clearShadow();
    return true;
  }

  // tick() 開始時設、結束時清：只有這段期間的電腦音帶時間戳
  setAudioBase(base) {
    this._audioBase = base;
  }

  // 時鐘時刻 → eventOptions；只有 tick() 裡的電腦音有，其餘 undefined＝立刻處理
  stamp(staff, ms) {
    if (staff.kind === 'human' || !this._audioBase || ms === undefined) return undefined;
    return this.stampTime(ms);
  }

  // 同上但不分真人或電腦（SysEx、被併入組裡的音）
  stampTime(ms) {
    if (!this._audioBase || ms === undefined) return undefined;
    return { time: this._audioBase.audio + (ms - this._audioBase.clock) / 1000 };
  }

  // 收音的 eventOptions。noteOn 提早送出、還沒響時，noteOff 一定排在它後 1ms：立刻處理的 noteOff 先到，那顆音之後就收不掉（卡音）；
  // 兩個時間戳來自不同 tick 的換算誤差也靠這個下限擋
  offOpts(staff, entry, offMs) {
    const stamp = this.stamp(staff, offMs);
    if (entry.onTime === undefined) return stamp;
    return { time: Math.max(stamp?.time ?? -Infinity, entry.onTime + 0.001) };
  }

  noteOn(staff, pitch, velocity, opts) {
    try { this.synthOf(staff)?.noteOn(staff.channel, pitch, velocity, opts); } catch (err) { this._warnOnce('noteOn', err); }
  }

  noteOff(staff, pitch, opts) {
    try { this.synthOf(staff)?.noteOff(staff.channel, pitch, opts); } catch (err) { this._warnOnce('noteOff', err); }
  }

  // CC123 All Notes Off：暫停、停止時的保險
  allNotesOff(staff) {
    try { this.synthOf(staff)?.controllerChange(staff.channel, CC.ALL_NOTES_OFF, 0); } catch (err) { this._warnOnce('allNotesOff', err); }
  }
}

// VoiceLedger：每個譜表正在響的音（staff.sounding：音高 → 發聲順序的佇列，同音高先進先出收）、hold、尾巴收尾、按下時依 tick 先收、暫停全收。
// 時鐘、起音序列、速度由排程器呼叫時傳入；容差與 tick → 樂譜秒在 bind() 綁定。
// hold 依 tick 記、分擁有者（holdScope：演奏者槽位——代打的音也算他的——或 'ensemble'＝伴奏，等合奏走到那個 tick）。

// 音長（檔案音長 ÷ 速度）被拉長的部分最多到 NOTE_MAX_MS（極慢 0.015× 時 0.1 秒的音會變 6 秒），但不短於檔案本身的長度（1× 時不能切）。
// 起音位置照完整速度、hold 的音照舊響到按下。應用層數字。
const NOTE_MAX_MS = 8000;
export const scaledMs = (lenSec, rate) => Math.min((lenSec * 1000) / rate, Math.max(NOTE_MAX_MS, lenSec * 1000));
// 排程時刻是一路加出來的浮點數，比大小時的容差
export const EPS_MS = 1e-6;
// hold 的對齊容差：音的結尾比某個 driver 起音早不超過這麼多，算「結尾接著這個起音」。
// 容差＝max(HOLD_GAP_TICKS, min(起音到那個起音的間隔 × HOLD_GAP_RATIO, 上限))，都依匯出器的慣例，不是規格：
//  · 至少 2 tick：MuseScore 匯出相連音時記譜長度少 1 tick，再多一點吸收取整誤差。
//  · 比例 1/8：有些匯出器把每顆音統一縮短一個比例（曲庫量測：54/164 首的主聲部，結尾固定比下一個起音早約 5.4% 的間隔，
//    只容許 2 tick 時這些歌完全不會 hold）。真正的斷奏空隙是間隔的一半左右，遠超過 1/8，不會被誤判成相連。
//  · 上限十六分音符（四分音符的 1/4；沒有四分音符的 SMPTE 用 0.125 秒）：免得長音後面的短休止被填滿。
const HOLD_GAP_TICKS = 2;
const HOLD_GAP_RATIO = 1 / 8;
const HOLD_GAP_MAX_QUARTER = 1 / 4;
const HOLD_GAP_MAX_SECONDS = 0.125;

// 空檔在容差內＝相連（不是休止）。hold 與休止清單（performancePlan.js）共用
export const holdGapTolerance = (intervalTicks, holdCapTicks) => Math.max(HOLD_GAP_TICKS, Math.min(intervalTicks * HOLD_GAP_RATIO, holdCapTicks));

// hold 容差的上限（tick）：有 ticks per quarter 就是十六分音符；SMPTE（timeDivision 是 null）用固定秒數換成 tick
export function holdCapTicksFor(score) {
  const cap = score.timeDivision ? score.timeDivision * HOLD_GAP_MAX_QUARTER : score.secondsToMIDITicks?.(HOLD_GAP_MAX_SECONDS);
  return Number.isFinite(cap) ? Math.max(HOLD_GAP_TICKS, Math.round(cap)) : HOLD_GAP_TICKS;
}

// 同音高佇列裡下一個該收的音（到期才回傳，否則 -1）：先進先出只排沒 hold、沒等鍵的音——那些不能擋住後面已到期的音
export function dueIndex(queue, limit) {
  const i = queue.findIndex((e) => e.holdTick === null && e.waitKey == null);
  return i !== -1 && queue[i].offMs <= limit + EPS_MS ? i : -1;
}

// 這顆音要 hold 到哪個 driver 起音：回傳 { tick, tailSec（那個起音之後還要響的樂譜秒） }，不 hold 回 null（照原長收）。
// 挑「結尾＋容差之前最後一個、在起音之後、還沒放行（≥ fromIndex）」的 driver 起音：
//  · 起音 ≤ 結尾（橫跨或對齊）：tailSec＝那個起音到結尾的長度，按下之後再響完；
//  · 起音在結尾之後、容差內（相連）：tailSec＝0，按下就收；超過容差（休止或斷奏）不算，改看前一個。
// 看每顆音自己的結尾而不是所屬 segment：同 tick 短音照原長收、長音等到它結尾所在的起音。橫跨的也要等：真人比預估慢時，照原長收會在檔案裡還在響時就停了。
export function holdOf(note, driverTicks, fromIndex, holdCapTicks, secOf) {
  const a = driverTicks;
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] <= note.endTick + holdCapTicks) lo = mid + 1; else hi = mid; }   // upper bound：第一個超過「結尾＋容差上限」的起音
  for (let c = lo - 1; c >= fromIndex && a[c] > note.startTick; c--) {
    const gap = a[c] - note.endTick;          // > 0：音比這個起音早收
    if (gap <= 0) return { tick: a[c], tailSec: secOf(note.endTick) - secOf(a[c]) };
    if (gap <= holdGapTolerance(a[c] - note.startTick, holdCapTicks)) return { tick: a[c], tailSec: 0 };
  }
  return null;
}

// 讀法 B（dev 開關 holdToNext）：不管檔案音長，hold 到下一個 driver 起音、按下就收；後面沒有起音回 null（照檔案音長）
export function nextOnsetHold(note, driverTicks, fromIndex) {
  for (let c = Math.max(0, fromIndex); c < driverTicks.length; c++) if (driverTicks[c] > note.startTick) return { tick: driverTicks[c], tailSec: 0 };
  return null;
}

export class VoiceLedger {
  constructor(router, events) {
    this._router = router;
    this._events = events;      // 收發音事件排進這裡（排程器在每次呼叫結束時才發出去）
    this._staves = new Map();   // staffId → staff（排程器建的）
    this._holdCapTicks = 0;     // hold 對齊容差的上限（tick），見 holdCapTicksFor()
    this._secOf = null;         // tick → 樂譜秒
  }

  // 載入、改指派時綁定這一輪的譜表與容差
  bind({ staves, holdCapTicks, secOf }) {
    this._staves = staves;
    this._holdCapTicks = holdCapTicks;
    this._secOf = secOf;
  }

  // 呼叫的是模組層級的同名函式（方法名稱不會變成可直接呼叫的變數）
  holdOf(note, holdTicks, holdFrom) { return holdOf(note, holdTicks, holdFrom, this._holdCapTicks, this._secOf); }

  // noteOn 並登記。dueMs＝預定發聲的時鐘時刻；只有 tick() 裡的電腦音與 timed（被併入組裡的真人音）帶時間戳，onTime 記下它。
  // holdScope／holdTicks／holdFrom＝hold 歸誰、等哪串起音、從哪個游標起算；fromTick＝由 tick() 放出（遲到統計只算這種）。
  // keyup 模式（mode 非 null）：不 hold；mode.key 有值（組頭）等這個鍵放開才收，null 照 offMs 收。
  // holdToNext（讀法 B）：用 nextOnsetHold 不用 holdOf()，比下一個起音長的音也在那裡收（holdOf() 會帶著 tailSec 撐過下一下）。
  sound(staff, note, offMs, dueMs, { holdScope, holdTicks, holdFrom, rate, fromTick, clockMs, timed = false, mode = null, holdToNext = false }) {
    const opts = timed ? this._router.stampTime(dueMs) : this._router.stamp(staff, dueMs);
    this._capOverlaps(staff, note, dueMs, rate, clockMs, opts?.time);
    let queue = staff.sounding.get(note.midiNote);
    if (!queue) staff.sounding.set(note.midiNote, (queue = []));
    // hold 的音先不排收音（Infinity），按到那個起音才收（releaseHeld）
    const hold = mode ? null : holdToNext ? nextOnsetHold(note, holdTicks, holdFrom) : this.holdOf(note, holdTicks, holdFrom);
    const waitKey = mode?.key ?? null;
    queue.push({
      endTick: note.endTick, offMs: hold || waitKey !== null ? Infinity : offMs, holdTick: hold ? hold.tick : null, holdScope: hold ? holdScope : null,
      tailSec: hold ? hold.tailSec : 0, waitKey, note, onTime: opts?.time, capped: false,
    }); // 先登記再 noteOn：合成器收到 noteOn 時，佇列最後一項就是這顆音
    this._router.noteOn(staff, note.midiNote, note.velocity, opts);
    this._events.queue('noteOn', {
      note, noteId: note.id ?? null, staffId: staff.id, kind: staff.kind, dueMs, clockMs,
      timed: opts !== undefined, fromTick, lateMs: Math.max(0, clockMs - dueMs),
    });
  }

  // 尾巴收尾：同譜表新音在 onsetMs 發聲時，較早起音的舊音最晚收在「onsetMs ＋ 檔案裡兩音重疊量 ÷ 速度」。
  // 舊音結尾是依發聲時的速度排的，之後變快或還在 hold 時會多響一截（糊在一起）；照檔案的重疊量收，只提早、不延長。同 tick 的和弦不互相截。
  _capOverlaps(staff, note, onsetMs, rate, clockMs, onTime) {
    const startSec = this._secOf(note.startTick);
    for (const queue of staff.sounding.values()) {
      for (const entry of queue) {
        if (entry.note.startTick >= note.startTick) continue;
        // 例外：檔案裡真的重疊、音高不同（同一行譜的多聲部）且舊音還在 hold：不修剪——修剪只擋早按造成、檔案沒寫的多疊
        if ((entry.holdTick !== null || entry.waitKey != null) && entry.note.midiNote !== note.midiNote && entry.endTick > note.startTick) continue;
        const capMs = onsetMs + scaledMs(Math.max(0, this._secOf(entry.endTick) - startSec), rate);
        // 真的截短才標 capped、不再 hold（相等只差浮點誤差，不算）；hold 著的音（Infinity）也在這裡被截成有限值
        if (capMs < entry.offMs - EPS_MS) { entry.offMs = capMs; entry.capped = true; entry.holdTick = null; entry.holdScope = null; entry.waitKey = null; }
        // 同音高：舊音還 hold 著會拖住排在後面的新音，所以也不再 hold
        else if (entry.note.midiNote === note.midiNote) { entry.capped = true; entry.holdTick = null; entry.holdScope = null; entry.waitKey = null; }
      }
    }
    // 到期的同音高舊音在新音 noteOn 前先收（否則 noteOff 連新音一起關）。新音帶時間戳時舊音收在同一個時間戳：立刻收會切短，等時鐘到又會關掉新音
    const same = staff.sounding.get(note.midiNote);
    for (let i; same && (i = dueIndex(same, onsetMs)) !== -1; ) {
      const opts = staff.kind === 'human' && onTime !== undefined
        ? { time: Math.max(onTime, (same[i].onTime ?? -Infinity) + 0.001) }
        : this._router.offOpts(staff, same[i], same[i].offMs);
      this._off(staff, note.midiNote, same[i], opts, clockMs);
      same.splice(i, 1);
    }
    if (same && !same.length) staff.sounding.delete(note.midiNote);
  }

  // 收掉到期的音（offMs ≤ limitMs）。limitMs 在 tick() 是時鐘 + LOOKAHEAD_MS，只對電腦音生效；真人的音永遠到時鐘才收
  closeDue(clockMs, limitMs = clockMs) {
    for (const staff of this._staves.values()) {
      const limit = staff.kind === 'human' ? clockMs : limitMs;
      for (const [pitch, queue] of staff.sounding) {
        for (let i; (i = dueIndex(queue, limit)) !== -1; ) {
          this._off(staff, pitch, queue[i], this._router.offOpts(staff, queue[i], queue[i].offMs), clockMs);
          queue.splice(i, 1);
        }
        if (!queue.length) staff.sounding.delete(pitch);
      }
    }
  }

  // 起音 tick 在 clock 放行：歸 scopes、等的是這個（或更早）起音的音，收在 clock ＋ tailSec ÷ rate。以真人為準：對齊的音（剩 0）按下就收，慢就一直響到按下
  releaseHeld(scopes, tick, clock, rate) {
    for (const staff of this._staves.values()) {
      for (const queue of staff.sounding.values()) {
        for (const entry of queue) {
          if (entry.holdTick === null || entry.holdTick > tick || !scopes.has(entry.holdScope)) continue;
          entry.offMs = clock + scaledMs(entry.tailSec, rate);
          entry.holdTick = null;
          entry.holdScope = null;
        }
      }
    }
  }

  // 換帶頭的人時：歸 scope、shouldRetime(等的 tick) 為真的音不再 hold，收在 offOf(tick, tailSec)（排程器依合奏新錨點算）
  retimeHeld(scope, shouldRetime, offOf) {
    for (const staff of this._staves.values()) {
      for (const queue of staff.sounding.values()) {
        for (const entry of queue) {
          if (entry.holdTick === null || entry.holdScope !== scope || !shouldRetime(entry.holdTick)) continue;
          entry.offMs = offOf(entry.holdTick, entry.tailSec);
          entry.holdTick = null;
          entry.holdScope = null;
        }
      }
    }
  }

  // 代打交還時接手（keyup 模式）：slot 在 tick 起音、還在響的音改成等鍵 key 放開
  takeOver(slot, tick, key) {
    for (const staff of this._staves.values()) {
      if (staff.kind !== 'human' || staff.slot !== slot) continue;
      for (const queue of staff.sounding.values()) {
        for (const entry of queue) {
          if (entry.note.startTick !== tick) continue;
          entry.waitKey = key;
          entry.offMs = Infinity;
          entry.holdTick = null;
          entry.holdScope = null;
        }
      }
    }
  }

  // 鍵 key 放開：只收 waitKey === key 的音（A 的 keyup 晚於 B 的 keydown 時不收 B 的），收在 clock（呼叫端接著 closeDue()）。回傳幾顆
  releaseKey(key, clock) {
    let n = 0;
    for (const staff of this._staves.values()) {
      for (const queue of staff.sounding.values()) {
        for (const entry of queue) {
          if (entry.waitKey !== key) continue;
          entry.offMs = clock;
          entry.waitKey = null;
          n++;
        }
      }
    }
    return n;
  }

  // slot 按下（或組裡起音自動放行）時，他譜表上 endTick ≤ ticks 的音先收（不管估速）；別人與伴奏的音不被切。還沒響的提早送出音照 offOpts 排在 noteOn 之後
  closeByTick(ticks, clockMs, slot) {
    for (const staff of this._staves.values()) {
      if (staff.kind !== 'human' || staff.slot !== slot) continue;
      for (const [pitch, queue] of staff.sounding) {
        while (queue.length && queue[0].endTick <= ticks) {
          this._off(staff, pitch, queue[0], this._router.offOpts(staff, queue[0]), clockMs);
          queue.shift();
        }
        if (!queue.length) staff.sounding.delete(pitch);
      }
    }
  }

  // 每個還在響的 noteOn 各送一個 noteOff
  noteOffAll(clockMs) {
    for (const staff of this._staves.values()) {
      for (const [pitch, queue] of staff.sounding) {
        for (const entry of queue) {
          this._off(staff, pitch, entry, this._router.offOpts(staff, entry), clockMs);
        }
      }
      staff.sounding.clear();
    }
  }

  isSilent() {
    for (const staff of this._staves.values()) {
      if (staff.sounding.size > 0) return false;
    }
    return true;
  }

  _off(staff, pitch, entry, opts, clockMs) {
    this._router.noteOff(staff, pitch, opts);
    this._queueNoteOff(staff, entry, opts !== undefined, clockMs);
  }

  _queueNoteOff(staff, entry, timed, clockMs) {
    this._events.queue('noteOff', {
      note: entry.note, noteId: entry.note.id ?? null, staffId: staff.id, kind: staff.kind, offMs: entry.offMs, clockMs, timed,
    });
  }
}
