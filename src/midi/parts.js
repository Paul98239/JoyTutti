import { buildPortOffsets } from './timeline.js';

// parts.js — 名稱表（GM 繁中音色名、鼓組名、音名；分譜清單與 midiPlayer.js 用）、聲部切分（staff＝(track, 絕對 channel)、串成 part、初始音色、命名）、音符配對、
// 控制器軌（每個絕對 channel 的非音符 channel 事件）、系統軌（SysEx 與分類）、文字軌（FF01～FF0F）、某個 tick 之前的控制器狀態與 chase 序列；
// 也是 MIDI 規格常數與表的唯一定義處。segments 在 midiParser.js 的 buildSegments()。

// GM1 打擊樂固定使用第 10 個 MIDI channel（索引 9）上 program 代表的鼓組而非旋律樂器；GM2 §2.4／§3.3.1 允許用 Bank Select 在任何 channel 切換：
// bank 79H(121)＝旋律、78H(120)＝節奏——staff 的 percussionKit 依這條規則判定（isPercussionBank()），不是只看 channel 號碼。這張表只用來檢查鼓組 program 是不是 GM2 附錄 B 定義的編號。
// 拼法對齊 GM2 附錄 B 的表格標題：全部是「XXX Set」不是「XXX Kit」；56 號官方寫縮寫「SFX Set」。
export const GM_DRUM_KITS = Object.freeze({
  0: 'Standard Set', 8: 'Room Set', 16: 'Power Set', 24: 'Electronic Set',
  25: 'Analog Set', 32: 'Jazz Set', 40: 'Brush Set', 48: 'Orchestra Set', 56: 'SFX Set',
});

// GM1 音色表的繁體中文（台灣用語）對照，索引就是 GM program 編號（0~127）。分譜清單一律用這份表命名聲部，不採信檔案裡的軌名（FF03）／樂器名（FF04）
// （常是其他語言、排版分隔線或空白）；GM program 是規格明訂、與語言無關，也是音源實際會奏出的音色。這張表只管顯示名稱，內部一律用 GM program 編號與 SoundFont 的音色。
// 台灣用語統一規則：acoustic＝「原音」（不用「原聲」）、synth＝「合成器」、lead＝「主奏」、pad＝「音墊」、slap＝「拍弦」、fretless＝「無琴格」、choir＝「合唱」、
// woodblock＝「木魚」、tom＝「通通鼓」、pizzicato＝「撥奏」、brush＝「鼓刷」、管風琴不加「教堂」。
const GM_PROGRAM_NAMES_ZH = Object.freeze([
  '大鋼琴', '明亮鋼琴', '電子大鋼琴', '酒吧鋼琴',
  '電鋼琴 1', '電鋼琴 2', '大鍵琴', '擊弦古鋼琴',
  '鋼片琴', '鐘琴', '音樂盒', '顫音琴',
  '馬林巴琴', '木琴', '管鐘', '揚琴',
  '拉桿風琴', '打擊式風琴', '搖滾風琴', '管風琴',
  '簧風琴', '手風琴', '口琴', '探戈手風琴',
  '尼龍弦吉他', '鋼弦吉他', '爵士電吉他', '清音電吉他',
  '悶音電吉他', '過載電吉他', '破音電吉他', '吉他泛音',
  '原音貝斯', '指彈電貝斯', '撥片電貝斯', '無琴格貝斯',
  '拍弦貝斯 1', '拍弦貝斯 2', '合成器貝斯 1', '合成器貝斯 2',
  '小提琴', '中提琴', '大提琴', '低音提琴',
  '震音弦樂', '撥奏弦樂', '豎琴', '定音鼓',
  '弦樂合奏 1', '弦樂合奏 2', '合成器弦樂 1', '合成器弦樂 2',
  '合唱「啊」', '合唱「喔」', '合成器人聲', '管弦樂團重擊',
  '小號', '長號', '低音號', '弱音小號',
  '法國號', '銅管組', '合成器銅管 1', '合成器銅管 2',
  '高音薩克斯風', '中音薩克斯風', '次中音薩克斯風', '上低音薩克斯風',
  '雙簧管', '英國管', '低音管', '單簧管',
  '短笛', '長笛', '直笛', '排笛',
  '吹瓶', '尺八', '口哨', '陶笛',
  '方波主奏', '鋸齒波主奏', '汽笛風琴主奏', '吹氣主奏',
  '查朗戈主奏', '人聲主奏', '五度主奏', '貝斯加主奏',
  '新世紀音墊', '溫暖音墊', '複音合成器音墊', '合唱音墊',
  '弓弦音墊', '金屬音墊', '光暈音墊', '掃頻音墊',
  '音效：雨聲', '音效：配樂', '音效：水晶', '音效：氛圍',
  '音效：明亮', '音效：精靈', '音效：回聲', '音效：科幻',
  '西塔琴', '班鳩琴', '三味線', '箏',
  '拇指琴', '風笛', '民謠提琴', '嗩吶',
  '叮噹鈴', '阿哥哥鈴', '鋼鼓', '木魚',
  '太鼓', '旋律通通鼓', '合成器鼓', '反向鈸',
  '吉他換把雜音', '呼吸聲', '海浪聲', '鳥鳴',
  '電話鈴聲', '直升機', '掌聲', '槍聲',
]);

const GM_DRUM_KITS_ZH = Object.freeze({
  0: '標準鼓組', 8: '房間鼓組', 16: '強力鼓組', 24: '電子鼓組',
  25: '類比鼓組', 32: '爵士鼓組', 40: '鼓刷鼓組', 48: '管弦樂打擊組', 56: '音效打擊組',
});

/**
 * GM 音色編號 → 繁體中文名稱（命名規則見 GM_PROGRAM_NAMES_ZH）。program 超出 0~127 回傳空字串，由呼叫端決定退路；
 * 鼓組編號查不到回傳標準鼓組：GM2 §2.6 [recommended] 明訂 Bank 78H/00H 選到未定義的 program 時音源實際播放 Program 1（GM1 Drum Set），
 * 名稱要反映音源真正發出的聲音。
 */
export function gmProgramNameZh(program, isDrum = false) {
  if (!Number.isInteger(program) || program < 0 || program > 127) return '';
  if (isDrum) return GM_DRUM_KITS_ZH[program] || GM_DRUM_KITS_ZH[0];
  return GM_PROGRAM_NAMES_ZH[program];
}

const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * MIDI 音高 → 科學音名（中央 C ＝ 60 ＝ C4，升記號用 #），例如 57 → 'A3'、88 → 'E6'。分譜清單顯示譜表音域用。
 * 非 0~127 的整數回傳空字串。
 */
export function midiNoteName(midiNote) {
  if (!Number.isInteger(midiNote) || midiNote < 0 || midiNote > 127) return '';
  return PITCH_CLASS_NAMES[midiNote % 12] + (Math.floor(midiNote / 12) - 1);   // MIDI 0 ＝ C-1，所以八度要減 1
}

/** @typedef {import('./midiParser.js').MidiChannelEvent} MidiChannelEvent */
/** @typedef {import('./midiParser.js').MidiNote} MidiNote */

// MIDI 規格常數與表：唯一定義處（RESET_CC、PARAMETER_CC、GM_DEFAULT_MIXER 在後面），其他檔經 midiParser.js import，不再各自定義。
export const DRUM_CHANNEL = 9; // GM1 的打擊 channel（第 10 個，索引 9）；GM2 另外允許用 Bank Select 切換，見 GM_DRUM_KITS 的說明
export const BANK_MSB_RHYTHM = 120, BANK_MSB_MELODY = 121;   // GM2 §2.4／§3.3.1：Bank Select MSB 78H＝節奏、79H＝旋律
export const PITCH_BEND_CENTER = 8192;                       // 14-bit，LSB 在 data1、MSB 在 data2
export const CC = Object.freeze({
  BANK_MSB: 0, DATA_MSB: 6, BANK_LSB: 32, DATA_LSB: 38, HOLD: 64, SOSTENUTO: 66, DATA_INC: 96, DATA_DEC: 97,
  NRPN_LSB: 98, NRPN_MSB: 99, RPN_LSB: 100, RPN_MSB: 101, ALL_SOUND_OFF: 120, RESET_ALL: 121, ALL_NOTES_OFF: 123, MONO: 126, POLY: 127,
});

// 切分規則（不預設匯出軟體；每一步都只用 MIDI 檔裡寫明的東西：軌、絕對 channel、program、bank）：
//   staff ＝ 一個「有音符的 (track, 絕對 channel)」，排程與輸出 channel 的單位。
//   part ＝ 一組 staff，可指派的單位。兩個 staff 在同一個 part，當且僅當串得起來：
//     ① 同一個絕對 channel（不論在哪一軌）：MIDI 1.0 的 channel 訊息（Program Change、控制器）作用在整個 channel，接收端同一時間一個 channel 只有一個音色，
//        分不出是哪一軌送的。MuseScore 的鋼琴兩行譜、lakh 檔把鼓組每個打擊樂器各放一軌（都在第 10 個 channel），都因此是一個 part。
//     ② format 1／2 的同一軌、而且同為打擊或同一個 program：軌是寫檔端自己分的單位（RP-001）。同一軌裡 program 不同的 channel（混打擊與旋律、不同樂器、中途換樂器寫成另一個 channel）拆開。
//        2026-11-19 從「同一個 GM family（program >> 3）」收緊成「同一個 program」：lakh 全量裡靠 family 併起來、program 不同的 staff 對有 422 組，
//        其中 305 組（72%）兩個 channel 有 ≥20% 的音同時在響（較像兩位樂手，例如弦樂合奏 48＋合唱 52、兩種吉他），錯併多於正確合併；manifest 83 筆沒有這種合併、
//        切分結果不變（corpus/lakh 全量統計，2026-11-19）。「錯併」在 UI 補救不了、「太細」可以一人指派多個 part 補救，所以寧細勿併。
//        代價：MuseScore 的演奏法 channel 若 program 不同（普通 40／撥奏 45／震音 44）會分成不同 part（corpus 裡沒有這種檔）。
//        format 0 不套這條：RP-001 規定 format 0 只有一條「多 channel 的軌」，軌不帶任何分組資訊，每個 channel 各自成 part。
//   中途換音色（program change 不在 tick 0）不拆：program 是 channel 在時間上的狀態（MIDI 1.0；GM2 §3.3.1：已在響的音維持原音色），staff 的 program 取第一顆音那個 tick 生效的值（buildPatchLookup()）。
//   不推導左右手、譜號、旋律／伴奏、Voice 1–4、演奏法、踏板線、動態曲線、反覆記號，不依起訖時間或音數篩選或合併：MIDI 裡不存在或不精準，硬推只會多出誤判。
//   沒有音符的軌（Meta 軌、空軌）不成 staff，它的事件仍在控制器軌（collectChannelLanes）。

// 混音器的四個 CC：音量、聲像、殘響、合唱。
const MIXER_CC = Object.freeze({ 7: 'volume', 10: 'pan', 91: 'reverb', 93: 'chorus' });
// 沒有初始化區塊時下游送的 GM 預設值（CC121 依規格不會重設音量與聲像，見 GML-v1 §3.2.5.2）。
export const GM_DEFAULT_MIXER = Object.freeze({ volume: 100, pan: 64, reverb: 0, chorus: 0 });

// 每個絕對 channel 在 tick 0 的混音 CC（同一個值取檔案順序最後一次＝接收端最後收到的；不分哪一軌送的，見切分規則 ①）。
function mixerAtZero(tracks, portOffsets) {
  const byChannel = new Map(); // 絕對 channel → { volume, pan, reverb, chorus }（只有送過的鍵）
  for (const track of tracks) {
    const offset = portOffsets.get(track.index) ?? 0;
    for (const ev of track.events) {
      if (ev.ticks !== 0) break;   // 事件依 tick 排序
      if (ev.kind !== 'channel' || ev.type !== 'controlChange' || !(ev.data1 in MIXER_CC)) continue;
      const ch = ev.channel + offset;
      if (!byChannel.has(ch)) byChannel.set(ch, {});
      byChannel.get(ch)[MIXER_CC[ev.data1]] = ev.data2;
    }
  }
  return byChannel;
}

// 打擊或旋律（GM 規格的 channel 角色）：GM1 規定第 10 個 channel 是打擊；GM2 §2.4／§3.3.1 只有 Bank Select MSB 78H(120)＝節奏、79H(121)＝旋律會改變角色，
// 其他 MSB（GS／GM1 檔常在第 10 個 channel 送 0）不改變角色。所以：MSB 120 → 打擊、MSB 121 → 旋律、其他或沒送 → 依絕對 channel 是不是第 10 個。
// 官方 SpessaSynth 在預設（GS）模式下也是第 10 個 channel 固定打擊、bank select 不切換。廠商擴充（GS 的 SysEx、XG 的 MSB 127）在 percussionOverride() 另外處理。
export const isPercussionBank = (msb, absChannel) =>
  msb === BANK_MSB_RHYTHM || (msb !== BANK_MSB_MELODY && absChannel % 16 === DRUM_CHANNEL);

// 廠商擴充的打擊切換（2026-11-19 加，照官方 spessasynth_core 4.4.10 的處理，試聽用的就是它；查原始碼的 GS SysEx 處理與 BankSelectHacks）：
//   · GS「USE FOR RHYTHM PART」：DT1 位址 40 1x 15，值 0＝旋律、1／2＝鼓組 map。x 是 GS 的 part 編號，換 channel 照 core 的 MIDIUtils.gsPartToChannel
//     （x＝0 是第 10 個 channel、1～9 是第 1～9 個、10～15 不變），再加送出這個 SysEx 的軌的 port 偏移（同 core 的 channelOffset）。
//   · XG：XG System On（43 1n 4C 00 00 7E）之後，bank MSB 127 是打擊（core 的 BankSelectHacks.isXGDrum；GS 模式下 127 不是）。
// 取 staff 第一顆音那個 tick（含）之前最後一次的設定；都沒有回 undefined（照 isPercussionBank()）。
const gsPartToChannel = (part) => (part === 0 ? DRUM_CHANNEL : part <= 9 ? part - 1 : part);
function percussionSwitches(tracks, portOffsets) {
  const gs = new Map();   // 絕對 channel → [{ ticks, drum }]（依 tick → 軌序 → 軌內序）
  let xgOnTick = Infinity;
  const events = [];
  for (const track of tracks) track.events.forEach((ev, eventIndex) => { if (ev.kind === 'sysex' && ev.type === 'sysex') events.push({ ev, trackIndex: track.index, eventIndex }); });
  events.sort((a, b) => a.ev.ticks - b.ev.ticks || a.trackIndex - b.trackIndex || a.eventIndex - b.eventIndex);
  for (const { ev, trackIndex } of events) {
    const d = ev.data;
    if (classifySysex(d).category === 'xgOn') { xgOnTick = Math.min(xgOnTick, ev.ticks); continue; }
    if (d.length >= 10 && d[0] === 0x41 && d[2] === 0x42 && d[3] === 0x12 && d[4] === 0x40 && (d[5] & 0xf0) === 0x10 && d[6] === 0x15) {
      const ch = gsPartToChannel(d[5] & 0x0f) + (portOffsets.get(trackIndex) ?? 0);
      if (!gs.has(ch)) gs.set(ch, []);
      gs.get(ch).push({ ticks: ev.ticks, drum: d[7] > 0 });
    }
  }
  return (absChannel, ticks, bankMsb) => {
    const last = (gs.get(absChannel) ?? []).filter((x) => x.ticks <= ticks).at(-1);
    if (last) return last.drum;
    if (xgOnTick <= ticks && bankMsb === 127) return true;
    return undefined;
  };
}

// 把 staff 串成 part（切分規則 ① ②）：union-find。staves 依 (軌序, 絕對 channel) 排序；回傳 staff 陣列的陣列，依每組第一個 staff 排序（＝總譜由上而下）。
function groupStaves(staves, format) {
  const parent = staves.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };
  const firstBy = new Map();
  const link = (key, i) => { if (firstBy.has(key)) union(firstBy.get(key), i); else firstBy.set(key, i); };
  staves.forEach((s, i) => {
    link(`ch:${s.channel}`, i);
    if (format !== 0) link(`tr:${s.trackIndex}:${s.percussionKit ? 'drum' : `program ${s.program}`}`, i);
  });
  const groups = new Map();
  staves.forEach((s, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(s); });
  return [...groups.values()];
}

// Program Change 與 Bank Select 是 channel 的狀態、跨軌共用；一個 staff 用哪個音色要看「它第一顆音那個 tick」這個 channel 生效的值。
// 查詢 patchAt(trackIndex, 軌內 channel, 絕對 channel, tick)：優先用同一軌自己在這個 tick（含）之前最後一次送的；這軌自己沒送過才查全曲所有軌、
// 同一個絕對 channel、tick（含）之前（同 tick 依軌序、軌內序）的最後一次。同一個 tick 的事件都算進去：MuseScore 會在第一顆音之後、同一個 tick 再送一次
// Program Change（corpus/musescorefile/[JP]_LiSA_Gurenge_V2.mid 的第 0 軌：27 → 音 → 31），接收端從第二顆音起都是後送的那個音色。program 都沒送過是 0；bank 都沒送過是 null（由 buildStaff() 補 GM2 預設），
// 只送過 MSB／LSB 其中一個時另一個視為 0。全曲查詢的 key 是絕對 channel（軌內 channel ＋ port 偏移）：不同 port 的同號 channel 是不同的 channel。
function buildPatchLookup(tracks, portOffsets) {
  const own = new Map();    // `${trackIndex}:${軌內 channel}` → [{ ticks, program?, msb?, lsb? }]（檔案順序）
  const global = new Map(); // 絕對 channel → 同上（依 tick → 軌序 → 軌內序）
  const push = (map, key, item) => { if (!map.has(key)) map.set(key, []); map.get(key).push(item); };
  for (const track of tracks) {
    const offset = portOffsets.get(track.index) ?? 0;
    for (const ev of track.events) {
      if (ev.kind !== 'channel') continue;
      let item;
      if (ev.type === 'programChange') item = { ticks: ev.ticks, trackIndex: track.index, program: ev.data1 };
      else if (ev.type === 'controlChange' && ev.data1 === CC.BANK_MSB) item = { ticks: ev.ticks, trackIndex: track.index, msb: ev.data2 };
      else if (ev.type === 'controlChange' && ev.data1 === CC.BANK_LSB) item = { ticks: ev.ticks, trackIndex: track.index, lsb: ev.data2 };
      else continue;
      push(own, `${track.index}:${ev.channel}`, item);
      push(global, ev.channel + offset, item);
    }
  }
  for (const list of global.values()) list.sort((a, b) => a.ticks - b.ticks || a.trackIndex - b.trackIndex);   // 穩定排序：同軌維持軌內順序
  const lastBefore = (list, ticks, field) => {
    let value;
    for (const e of list ?? []) { if (e.ticks > ticks) break; if (e[field] !== undefined) value = e[field]; }
    return value;
  };
  const pick = (field, trackIndex, channel, absChannel, ticks) =>
    lastBefore(own.get(`${trackIndex}:${channel}`), ticks, field) ?? lastBefore(global.get(absChannel), ticks, field);
  return (trackIndex, channel, absChannel, ticks) => {
    const msb = pick('msb', trackIndex, channel, absChannel, ticks), lsb = pick('lsb', trackIndex, channel, absChannel, ticks);
    return {
      program: pick('program', trackIndex, channel, absChannel, ticks) ?? 0,
      bank: msb === undefined && lsb === undefined ? null : { msb: msb ?? 0, lsb: lsb ?? 0 },
    };
  };
}

/**
 * @param {string} partId
 * @param {string} staffId
 * @param {number} trackIndex
 * @param {number} eventIndex  note on 在這條軌事件清單裡的序號（id 用）
 * @param {number} channel  絕對 channel（含 port 偏移）
 * @param {MidiChannelEvent} onEvent
 * @param {number} endTick
 * @param {(ticks:number) => number} midiTicksToSeconds
 * @returns {MidiNote}
 */
function makeNote(partId, staffId, trackIndex, eventIndex, channel, onEvent, endTick, midiTicksToSeconds) {
  const startSeconds = midiTicksToSeconds(onEvent.ticks);
  const endSeconds = midiTicksToSeconds(endTick);
  return {
    id: `${trackIndex}:${eventIndex}`, // 同一版 parser 解析同一個檔一定相同（官方 timeline 的 {tr, ev}），給視覺化對應、日誌與事件排序用
    partId,
    staffId,
    trackIndex,
    eventIndex,
    channel,
    midiNote: onEvent.data1,
    velocity: onEvent.data2,
    startTick: onEvent.ticks,
    endTick,
    durationTicks: endTick - onEvent.ticks,
    startSeconds,
    endSeconds,
    durationSeconds: endSeconds - startSeconds,
  };
}

// 逐軌逐事件把 note-on／note-off 配成音，同時記下每個 staff 的統計（音符數、起訖、音域、同音高重疊次數）。
// staffIndex：`${trackIndex}:${軌內 channel}` → { staffId, trackIndex, trackChannel, channel（絕對） }。音的 partId 先留空，collectPartsAndNotes() 分完 part 再補。
function collectNotes(tracks, midiTicksToSeconds, warn, staffIndex) {
  const notes = [];
  const statsByStaff = new Map(); // staffId → { noteCount, startTick, endTick, overlaps, minPitch, maxPitch }
  const statsOf = (vk) => {
    let st = statsByStaff.get(vk.staffId);
    if (!st) statsByStaff.set(vk.staffId, (st = { noteCount: 0, startTick: Infinity, endTick: 0, overlaps: 0, minPitch: 127, maxPitch: 0 }));
    return st;
  };
  const emit = (vk, trackIndex, eventIndex, onEv, endTick) => {
    const note = makeNote('', vk.staffId, trackIndex, eventIndex, vk.channel, onEv, endTick, midiTicksToSeconds);
    const st = statsByStaff.get(vk.staffId);
    st.noteCount++;
    st.startTick = Math.min(st.startTick, note.startTick);
    st.endTick = Math.max(st.endTick, note.endTick);
    st.minPitch = Math.min(st.minPitch, note.midiNote);
    st.maxPitch = Math.max(st.maxPitch, note.midiNote);
    notes.push(note);
  };

  for (const track of tracks) {
    // key = channel * 128 + 音高。同一 key 可能同時有多顆未收尾的音（同音重疊），
    // 以先進先出配對：先響的音先被關掉，這是最貼近演奏直覺的解讀。
    const pending = new Map();
    // 沒有對應 note on 的 note off（孤立 note off）：先收集，軌處理完才分類。MuseScore 的樂器有多個演奏法 channel（普通、撥奏、震音），每個音起音時會對其他演奏法的 channel
    // 補送一個同音高的 note off（把它們切掉），一首歌可以有上千個。認得出這種補送（同一軌、同 tick、同音高，別的 channel 有 note on）就不警告；認不出的才依 channel 計數各報一則
    // （逐個報警會洗版，還會撞到警告數量上限把後面真正的警告吃掉）。這是匯出器的慣例，不是 SMF 規格；孤立 note off 不管有沒有警告都被忽略，不影響音符。
    const strayOffs = [];        // { channel, ticks, pitch }
    // (tick, 音高) → 在這個位置有 note on 的 channel 集合，用 16 位元整數當位元遮罩（第 c 位是 1 ＝ channel c 在場）。key 用 tick * 128 + 音高（音高 0～127 不會撞；tick 最大約 1e7，乘 128 仍遠小於 2^53）
    const onChannelsAt = new Map();
    for (let eventIndex = 0; eventIndex < track.events.length; eventIndex++) {
      const ev = track.events[eventIndex];
      if (ev.kind !== 'channel') continue;
      const isNoteOn = ev.type === 'noteOn' && ev.data2 > 0;
      // 規格允許用「力度 0 的 note on」代替 note off（可讓整段音符共用 running status），實務上絕大多數檔案都這樣寫
      const isNoteOff = ev.type === 'noteOff' || (ev.type === 'noteOn' && ev.data2 === 0);
      if (!isNoteOn && !isNoteOff) continue;

      const key = ev.channel * 128 + ev.data1;
      if (isNoteOn) {
        const vk = staffIndex.get(`${track.index}:${ev.channel}`);
        const st = statsOf(vk);
        let queue = pending.get(key);
        if (!queue) pending.set(key, (queue = []));
        if (queue.length) st.overlaps++;
        queue.push({ ev, vk, eventIndex });
        const at = ev.ticks * 128 + ev.data1;
        onChannelsAt.set(at, (onChannelsAt.get(at) ?? 0) | (1 << ev.channel)); // | ＝ 把 channel 加進集合（聯集）
        continue;
      }
      const queue = pending.get(key);
      if (!queue || !queue.length) {
        strayOffs.push({ channel: ev.channel, ticks: ev.ticks, pitch: ev.data1 });
        continue;
      }
      const { ev: onEv, vk, eventIndex: onIndex } = queue.shift();
      emit(vk, track.index, onIndex, onEv, ev.ticks);
    }
    // 要等整條軌掃完才分類：補送的 note off 跟 note on 在同一個 tick，誰先寫沒有規定，不能邊掃邊判。
    const unexplained = new Map(); // channel → { count, ticks, pitch }（第一個對不上的位置，方便追查）
    for (const { channel, ticks, pitch } of strayOffs) {
      // & ~(1 << channel)：取「別的 channel」的集合（`~` 是補集、`&` 是交集），非 0 ＝ 別的 channel 在這裡有 note on
      if ((onChannelsAt.get(ticks * 128 + pitch) ?? 0) & ~(1 << channel)) continue;
      const entry = unexplained.get(channel);
      if (entry) entry.count++;
      else unexplained.set(channel, { count: 1, ticks, pitch });
    }
    for (const [channel, { count, ticks, pitch }] of unexplained) {
      warn(`track ${track.index} 的 channel ${channel}：${count} 個 note off 沒有對應的 note on，已忽略（第一個在 tick ${ticks}、音高 ${pitch}；不是 MuseScore 補送的那種：同 tick、同音高在別的 channel 找不到 note on）`);
    }
    for (const [key, queue] of pending) {
      for (const { ev: on, vk, eventIndex } of queue) {
        warn(`track ${track.index} 的 tick ${on.ticks}：channel ${(key / 128) | 0} 音高 ${key % 128} 的 note on 沒有對應的 note off，已在軌尾收尾`);
        emit(vk, track.index, eventIndex, on, Math.max(on.ticks, track.endTick));
      }
    }
  }
  notes.sort(
    (a, b) => a.startTick - b.startTick || a.trackIndex - b.trackIndex || a.channel - b.channel || a.midiNote - b.midiNote
  );
  return { notes, statsByStaff };
}

// 一個 staff 的初始狀態（staff 是一個 (track, 絕對 channel)，見 collectNotes() 的統計）：
//   · program、bank：第一顆音那個 tick 生效的值（patch，見 buildPatchLookup()）。percussionKit：有 GS／XG 的打擊切換（percussionSwitches()）就照它，沒有依 isPercussionBank()。
//     bank 都沒送過用 GM2 §3.3.1 的規格預設，依 percussionKit 決定（打擊是節奏 bank 120，旋律是 121；沒有切換時就是「第 10 個 channel 120、其餘 121」）：
//     這個值會在輸出 channel 上送出（voices.js 的初始 patch），被 GS／XG 切換角色的 channel 若照絕對 channel 給預設，會送出跟角色相反的 bank。
//   · init：這個絕對 channel 在 tick 0 的混音 CC7／10／91／93（不分哪一軌送的，缺的補 GM 預設）；tick 0 都沒送是 null（下游用 GM 預設）。
function buildStaff(vk, st, patch, mixer, warn, switchedDrum) {
  const { program } = patch;
  const percussionKit = switchedDrum ?? isPercussionBank(patch.bank?.msb, vk.channel);
  const bank = patch.bank ?? { msb: percussionKit ? BANK_MSB_RHYTHM : BANK_MSB_MELODY, lsb: 0 };
  const init = mixer ? Object.fromEntries(Object.entries(GM_DEFAULT_MIXER).map(([k, d]) => [k, mixer[k] ?? d])) : null;
  if (percussionKit && !(program in GM_DRUM_KITS)) {
    // 這裡只確定「不是 GM2 附錄 B 定義的編號」，顯示名稱因此只能退回「標準鼓組」（見 gmProgramNameZh()）；實際播放會不會退回標準鼓組取決於載入的 SoundFont
    // （查證過 GeneralUserGS.sf3 額外提供 program 1/2/26/127 這幾組，不會真的退回），所以只能提醒顯示名稱不準確，不能斷言。
    warn(`track ${vk.trackIndex} 的 channel ${vk.channel}：鼓組 program ${program} 不是 GM2 規格附錄 B 定義的編號，顯示名稱只能用「標準鼓組」代替，實際會播放哪一組鼓聲取決於載入的 SoundFont 有沒有提供這個編號`);
  }
  if (st.overlaps) {
    warn(`track ${vk.trackIndex} 的 channel ${vk.channel}：同音高重疊 ${st.overlaps} 次（依先進先出配對，每個 note-on 配到最早還沒結束的那顆音）`);
  }
  return {
    id: vk.staffId, partId: '', trackIndex: vk.trackIndex, channel: vk.channel, program, bank, percussionKit, init,
    noteCount: st.noteCount, startTick: st.startTick, endTick: st.endTick, minPitch: st.minPitch, maxPitch: st.maxPitch,
  };
}

// 一組 staff → part 物件（staves 依軌序、絕對 channel 排序）。
function buildPart(partId, staves) {
  for (const s of staves) s.partId = partId;
  return {
    id: partId,
    name: '', // nameParts() 補：要先數過所有 part 才知道哪些音色名需要加序號
    noteCount: staves.reduce((sum, v) => sum + v.noteCount, 0),
    startTick: Math.min(...staves.map((v) => v.startTick)),
    endTick: Math.max(...staves.map((v) => v.endTick)),
    staves,
  };
}

// 命名：基底名＝part 的主 staff（音符最多，同數取 channel 小者）的 GM 繁中音色名，打擊用鼓組名，查不到才用「聲部 N」；
// 不採信軌名、不放高低音譜／旋律伴奏／bank 的任何描述。整份總譜有 ≥2 個 part 基底名相同時依 part 順序（＝總譜由上而下）
// 加序號「 1」「 2」…；基底名本身以數字結尾（「弦樂合奏 1」）改用全形括號「（1）」，免得疊成「弦樂合奏 1 1」這種容易誤讀的雙重編號。
function nameParts(parts) {
  const bases = parts.map((part, i) => {
    const main = [...part.staves].sort((a, b) => b.noteCount - a.noteCount || a.channel - b.channel)[0];
    return gmProgramNameZh(main.program, main.percussionKit) || `聲部 ${i + 1}`;
  });
  const sameBase = (i) => bases.filter((b) => b === bases[i]).length;
  const seen = new Map();
  parts.forEach((part, i) => {
    if (sameBase(i) === 1) { part.name = bases[i]; return; }
    const n = (seen.get(bases[i]) || 0) + 1;
    seen.set(bases[i], n);
    part.name = /\d$/.test(bases[i]) ? `${bases[i]}（${n}）` : `${bases[i]} ${n}`;
  });
}

// 整個聲部切分：音符配對（同時算每個 staff 的統計）→ staff 初始狀態 → 串成 part（切分規則見上方說明）→ 命名。
export function collectPartsAndNotes(tracks, midiTicksToSeconds, warn, format) {
  const portOffsets = buildPortOffsets(tracks);
  // `${trackIndex}:${軌內 channel}` → { staffId, trackIndex, trackChannel, channel（絕對） }；staff id ＝ t＋軌序號＋c＋絕對 channel。
  const staffIndex = new Map();
  for (const track of tracks) {
    const abs = portOffsets.get(track.index) ?? 0;
    for (const ev of track.events) {
      if (ev.kind !== 'channel' || ev.type !== 'noteOn' || ev.data2 === 0) continue;
      const key = `${track.index}:${ev.channel}`;
      if (!staffIndex.has(key)) staffIndex.set(key, { staffId: `t${track.index}c${ev.channel + abs}`, trackIndex: track.index, trackChannel: ev.channel, channel: ev.channel + abs });
    }
  }

  const { notes, statsByStaff } = collectNotes(tracks, midiTicksToSeconds, warn, staffIndex);
  const patchAt = buildPatchLookup(tracks, portOffsets);
  const drumAt = percussionSwitches(tracks, portOffsets);
  const mixer = mixerAtZero(tracks, portOffsets);
  const staves = [...staffIndex.values()]
    .sort((a, b) => a.trackIndex - b.trackIndex || a.channel - b.channel)
    .map((vk) => {
      const st = statsByStaff.get(vk.staffId);
      const patch = patchAt(vk.trackIndex, vk.trackChannel, vk.channel, st.startTick);
      return buildStaff(vk, st, patch, mixer.get(vk.channel), warn, drumAt(vk.channel, st.startTick, patch.bank?.msb));
    });

  // part id ＝ p＋第一個 staff 的軌序號；同一軌開頭的 part 不只一個時，其餘依序加 .1、.2…（id 只是不透明的字串）。
  const parts = [];
  const perTrack = new Map();
  for (const group of groupStaves(staves, format)) {
    const base = `p${group[0].trackIndex}`;
    const n = perTrack.get(base) ?? 0;
    perTrack.set(base, n + 1);
    parts.push(buildPart(n === 0 ? base : `${base}.${n}`, group));
  }
  if (format !== 0) {
    // 同一軌裡有不同樂器（打擊／program）的 channel、因此拆成多個 part（切分規則 ②）：提醒一次，方便追查（MuseScore 的「換樂器」也會這樣寫）。
    for (const track of tracks) {
      const ids = [...new Set(staves.filter((s) => s.trackIndex === track.index).map((s) => s.partId))];
      if (ids.length >= 2) warn(`track ${track.index} 的 channel 分屬 ${ids.length} 種不同樂器（打擊／program），分在 ${ids.join('、')} 這幾個 part`);
    }
  }
  const partOf = new Map(staves.map((s) => [s.id, s.partId]));
  for (const note of notes) note.partId = partOf.get(note.staffId);
  nameParts(parts);
  if (!parts.length) warn('這份檔案裡沒有任何音符，切分不出聲部');
  return { parts, notes };
}

// 全曲事件的排序鍵（tick → 軌序號 → 軌內序號）＝官方 BasicMIDI timeline 的順序；id 就是「軌序號:軌內序號」。
export const byFileOrder = (a, b) => a.ticks - b.ticks || a.trackIndex - b.trackIndex || a.eventIndex - b.eventIndex;
const eventRef = (trackIndex, eventIndex, ev) => ({ id: `${trackIndex}:${eventIndex}`, ticks: ev.ticks, trackIndex, eventIndex });

// channel 事件解碼後的值：pitch bend 是 14-bit（LSB 在 data1、MSB 在 data2，中心 8192）；program 與 channel pressure 只有
// data1；CC 與 poly pressure 的值在 data2（CC 編號、poly 的音高在 data1）。
function laneValue(ev) {
  if (ev.type === 'pitchBend') return (ev.data2 << 7) | ev.data1;
  if (ev.type === 'programChange' || ev.type === 'channelAftertouch') return ev.data1;
  return ev.data2;
}

/**
 * 每個用到的絕對 channel 一條控制器軌：這個 channel 所有非音符的 channel 事件（CC 0～127、program change、pitch bend、channel／poly pressure），依官方 timeline 順序。
 * 控制器屬於 channel、不屬於譜表：同一個 channel 的所有 staff 共用同一條（staff.channel 是鑰匙；只有音符的 channel 也有一條空的，所以一定找得到）。tick 0 的事件也在裡面（staff.init 照舊是摘要）。
 * @param {import('./midiParser.js').MidiTrack[]} tracks
 * @param {Map<number, number>} portOffsets  buildPortOffsets() 的結果
 * @returns {Map<number, import('./midiParser.js').LaneEvent[]>}  依絕對 channel 遞增
 */
export function collectChannelLanes(tracks, portOffsets) {
  const lanes = new Map();
  for (const track of tracks) {
    const offset = portOffsets.get(track.index) ?? 0;
    track.events.forEach((ev, eventIndex) => {
      if (ev.kind !== 'channel') return;
      const channel = ev.channel + offset;
      if (!lanes.has(channel)) lanes.set(channel, []);
      if (ev.type === 'noteOn' || ev.type === 'noteOff') return;
      lanes.get(channel).push({ ...eventRef(track.index, eventIndex, ev), channel, type: ev.type, data1: ev.data1, data2: ev.data2, value: laneValue(ev) });
    });
  }
  for (const lane of lanes.values()) lane.sort(byFileOrder);
  return new Map([...lanes].sort((a, b) => a[0] - b[0]));
}

// SysEx 分類：只解析、不送（要不要送由播放端決定）。data 是 F0 之後的位元組（含結尾的 F7，同官方 processor 收到的）。
// 依據：MIDI 1.0 Universal SysEx（7E 非即時、7F 即時；第 2 個位元組是裝置 ID）：GM1 On 7E dev 09 01、GM Off 09 02、GM2 On 09 03；Roland GS 的 DT1：41 dev 42 12 位址(3) 資料… checksum
// （40 00 7F 是 GS Reset，SC-88 的 00 00 7F 也是重設）；Yamaha XG 的參數變更：43 1n 4C 位址(3) 資料（00 00 7E 是 XG System On）。GS／XG 參數依位址判斷是不是指定某個 part
// （輸出 channel 重新分配後位址裡的 part 會對不上，播放端要另外處理）：GS 是 40／50（SC-88 的 port B）開頭、第 2 個位址的高 4 bit 是 1／2／4（part 參數區；41 開頭的鼓組設定不是）；XG 是 08 開頭（Multi Part）。
// 分不出來的（長度不夠、資料請求、其他廠商）一律 other，保留原始資料，不猜。
export function classifySysex(data) {
  const n = data.length;
  if (data[0] === 0x7e && n >= 5 && data[2] === 0x09 && data[3] >= 0x01 && data[3] <= 0x03) {
    return { category: ['gmOn', 'gmOff', 'gm2On'][data[3] - 1] };
  }
  if (data[0] === 0x7e && n >= 4) return { category: 'universalNonRealTime' };
  if (data[0] === 0x7f && n >= 4) return { category: 'universalRealTime' };
  if (data[0] === 0x41 && n >= 10 && data[2] === 0x42 && data[3] === 0x12) {
    const [a1, a2, a3] = [data[4], data[5], data[6]];
    if ((a1 === 0x40 || a1 === 0x00) && a2 === 0x00 && a3 === 0x7f) return { category: 'gsReset' };
    return { category: 'gsParameter', channelSpecific: (a1 === 0x40 || a1 === 0x50) && [0x10, 0x20, 0x40].includes(a2 & 0xf0) };
  }
  if (data[0] === 0x43 && n >= 8 && (data[1] & 0xf0) === 0x10 && data[2] === 0x4c) {
    const [a1, a2, a3] = [data[3], data[4], data[5]];
    if (a1 === 0x00 && a2 === 0x00 && a3 === 0x7e) return { category: 'xgOn' };
    return { category: 'xgParameter', channelSpecific: a1 === 0x08 };
  }
  return { category: 'other' };
}

/**
 * 全曲的 SysEx（F0）與 escape（F7）事件，依 tick → 軌序 → 軌內序，附分類（escape 是分段傳送的後續封包或任意位元組，一律 other）。
 * @returns {import('./midiParser.js').SystemEvent[]}
 */
export function collectSystemEvents(tracks) {
  const out = [];
  for (const track of tracks) {
    track.events.forEach((ev, eventIndex) => {
      if (ev.kind !== 'sysex') return;
      out.push({ ...eventRef(track.index, eventIndex, ev), type: ev.type, data: ev.data, ...(ev.type === 'sysex' ? classifySysex(ev.data) : { category: 'other' }) });
    });
  }
  return out.sort(byFileOrder);
}

/**
 * FF01～FF0F 的文字類 meta（文字、版權、軌名、樂器名、歌詞、標記、cue point、程式名、裝置名…），依 tick → 軌序 → 軌內序。
 * 不解讀內容（歌詞的語言與顯示延伸 RP-017／RP-026 等視覺化真的用到再看）。
 * @returns {import('./midiParser.js').TextEvent[]}
 */
export function collectTextEvents(tracks) {
  const out = [];
  for (const track of tracks) {
    track.events.forEach((ev, eventIndex) => {
      if (ev.kind === 'meta' && ev.type >= 0x01 && ev.type <= 0x0f) out.push({ ...eventRef(track.index, eventIndex, ev), type: ev.type, text: ev.text });
    });
  }
  return out.sort(byFileOrder);
}

/** @typedef {import('./midiParser.js').LaneEvent} LaneEvent */
/** @typedef {import('./midiParser.js').ControllerState} ControllerState */

// 用途：你早按、垂直切片跳過一段時，補上那一段的控制器狀態（例如中間踩下又放開的踏板）；暫停後續播；播放中改指派、輸出 channel 重新分配時重送狀態。
// 依據：MIDI 1.0（RPN／NRPN 先選參數再送 data entry；選了新參數之後那個參數保留舊值直到收到新的 data entry；收到 MSB 時 LSB 視為 0）、GM2 §3.5.2（CC121 重設表）、
// GM2 §3.3.1（Bank Select 要等下一個 Program Change 才生效）。對照官方 SpessaSynth：Sequencer 跳時間（setTimeTo）時選參數／data entry／bank select 依序全部重送、
// 其他 CC 只送最後一次、CC121 當成狀態重設而不重送；這裡是同一個概念，但每個狀態只留決定它的最少事件。

// CC121 Reset All Controllers（GM2 §3.5.2，與官方 SpessaSynth 依 RP-015 的實作一致）：調變 0、表情 127、延音踏板 0、滑音開關 0、持音踏板 0、弱音踏板 0；
// 另外 pitch bend 回中心、channel pressure 回 0、RPN 回 null（7F 7F）。音量、聲像、program、bank、滑音時間（CC5）、殘響／合唱深度不動。
export const RESET_CC = new Map([[1, 0], [11, 127], [64, 0], [65, 0], [66, 0], [67, 0]]);
// 瞬間指令，不留狀態、不重播：All Sound Off、All Notes Off、Omni Off／On（GM2 §3.5.4／§3.5.5：只關音、不改模式）。
const INSTANT_CC = new Set([120, 123, 124, 125]);
const SELECT_CC = new Set([CC.RPN_MSB, CC.RPN_LSB, CC.NRPN_MSB, CC.NRPN_LSB]);
const DATA_CC = new Set([CC.DATA_MSB, CC.DATA_LSB, CC.DATA_INC, CC.DATA_DEC]);
// RPN／NRPN 的選參數與 data entry：接收端的 data entry 套在「當下選的參數」上，要照順序成組送，不能用「跟上次一樣就不送」過濾。
export const PARAMETER_CC = new Set([...SELECT_CC, ...DATA_CC]);

// 原檔沒有、由狀態推出來要補送的事件（CC121 之後的預設值、選參數）：位置借用推出它的那個事件（排序用），id 是 null。
function syntheticEvent(at, type, data1, data2) {
  const value = type === 'pitchBend' ? (data2 << 7) | data1 : type === 'channelAftertouch' ? data1 : data2;
  return { id: null, synthetic: true, ticks: at.ticks, trackIndex: at.trackIndex, eventIndex: at.eventIndex, channel: at.channel, type, data1, data2, value };
}

/**
 * 一個 channel 的控制器狀態：依原檔順序逐一 apply() 這個 channel 的控制器軌事件。snapshot()＝目前的狀態；chase()＝把一個
 * 「全新、或照這個檔案播到更早位置」的 channel 帶到目前狀態的最少事件，依原檔順序。apply() 每個事件 O(1)；chase() 與 snapshot()
 * 是 O(狀態數)，所以呼叫端可以邊播邊 apply，需要時再 chase()。
 */
export class ChannelStateTracker {
  constructor() {
    this._cc = new Map();          // 一般控制器 → { value, event }：event 是 chase 要送的（原檔事件，或 CC121 之後合成的預設值）；null＝不必送
    this._bank = { msb: null, lsb: null };   // 最後一次的 CC0／CC32 事件（bank 暫存器）
    this._program = null;          // { event, bankMsb, bankLsb }：最後一個 program change，與它當下生效的 bank 事件
    this._pitchBend = null;        // { value, event }
    this._pressure = null;         // { value, event }
    this._poly = new Map();        // 音高 → 最後一個 poly pressure 事件
    this._mode = null;             // 最後一個 CC126（mono）／CC127（poly）
    this._regs = { rpn: [null, null], nrpn: [null, null] };   // 選參數的暫存器 [MSB 事件, LSB 事件]
    this._current = null;          // 'rpn'｜'nrpn'｜null：最後選的是哪一種
    this._params = new Map();      // 'rpn:MSB:LSB' → { type, msb, lsb, value: [MSB, LSB], adjusted, sessions }
    this._open = null;             // 目前選取的參數正在進行的 session（選參數之後第一個 data entry 開始，再選參數就結束）
    this._lastSelect = null;       // 最後一個改了選參數暫存器的事件（CC121 之後是合成的 RPN null）：還原選參數時借它的位置
    this._dataRaw = new Map();     // CC6／38／96／97 最後的原始值（只給快照）
  }

  /** @param {LaneEvent} ev  同一個 channel 的控制器軌事件，依原檔順序 */
  apply(ev) {
    if (ev.type === 'programChange') { this._program = { event: ev, bankMsb: this._bank.msb, bankLsb: this._bank.lsb }; return; }
    if (ev.type === 'pitchBend') { this._pitchBend = { value: ev.value, event: ev }; return; }
    if (ev.type === 'channelAftertouch') { this._pressure = { value: ev.value, event: ev }; return; }
    if (ev.type === 'polyAftertouch') { this._poly.set(ev.data1, ev); return; }
    const cc = ev.data1;
    if (INSTANT_CC.has(cc)) return;
    if (cc === CC.RESET_ALL) this._resetAll(ev);
    else if (cc === CC.MONO || cc === CC.POLY) this._mode = ev;
    else if (cc === CC.BANK_MSB) this._bank.msb = ev;
    else if (cc === CC.BANK_LSB) this._bank.lsb = ev;
    else if (SELECT_CC.has(cc)) this._select(ev);
    else if (DATA_CC.has(cc)) this._data(ev);
    else this._cc.set(cc, { value: ev.value, event: ev });
  }

  // CC121：之前設過的才需要在 chase 裡送合成的預設值；從沒設過的本來就是預設值，不送（MuseScore 每個 channel 在 tick 0 都送 CC121）。
  _resetAll(ev) {
    for (const [cc, value] of RESET_CC) {
      const prev = this._cc.get(cc);
      this._cc.set(cc, { value, event: prev?.event ? syntheticEvent(ev, 'controlChange', cc, value) : null });
    }
    this._pitchBend = { value: PITCH_BEND_CENTER, event: this._pitchBend?.event ? syntheticEvent(ev, 'pitchBend', 0, 64) : null };
    this._pressure = { value: 0, event: this._pressure?.event ? syntheticEvent(ev, 'channelAftertouch', 0, 0) : null };
    if (this._current) {   // 選過參數才需要還原成 RPN null；從沒選過等同 null
      this._regs.rpn = [syntheticEvent(ev, 'controlChange', CC.RPN_MSB, 127), syntheticEvent(ev, 'controlChange', CC.RPN_LSB, 127)];
      this._current = 'rpn';
      this._lastSelect = this._regs.rpn[1];
    }
    this._open = null;
  }

  _select(ev) {
    const cc = ev.data1;
    const type = cc === CC.RPN_MSB || cc === CC.RPN_LSB ? 'rpn' : 'nrpn';
    this._regs[type][cc === CC.RPN_MSB || cc === CC.NRPN_MSB ? 0 : 1] = ev;
    this._current = type;
    this._open = null;
    this._lastSelect = ev;
  }

  // data entry 套到目前選的參數；沒選、只選了一半、或選的是 RPN null（7F 7F）就沒有作用。
  _data(ev) {
    this._dataRaw.set(ev.data1, ev.data2);
    const p = this._currentParam();
    if (!p) return;
    if (!this._open) { this._open = { events: [], hasMsb: false }; p.sessions.push(this._open); }
    this._open.events.push(ev);
    if (ev.data1 === CC.DATA_MSB) { p.value = [ev.data2, 0]; p.adjusted = false; this._open.hasMsb = true; }   // MIDI 1.0：收到 MSB 時 LSB 視為 0
    else if (ev.data1 === CC.DATA_LSB) p.value = [p.value[0], ev.data2];
    else p.adjusted = true;   // CC96／97：一次加減多少各家不同（官方 SpessaSynth 不處理），快照不換算，只在 chase 裡原樣重播
  }

  _currentParam() {
    if (!this._current) return null;
    const [msbEv, lsbEv] = this._regs[this._current];
    if (!msbEv || !lsbEv) return null;
    const msb = msbEv.data2, lsb = lsbEv.data2;
    if (this._current === 'rpn' && msb === 127 && lsb === 127) return null;
    const key = `${this._current}:${msb}:${lsb}`;
    let p = this._params.get(key);
    if (!p) this._params.set(key, (p = { type: this._current, msb, lsb, value: [null, null], adjusted: false, sessions: [] }));
    return p;
  }

  /** @returns {ControllerState} 見 midiParser.js 的型別說明 */
  snapshot() {
    const cc = new Array(128).fill(null);
    for (const [n, s] of this._cc) cc[n] = s.value;
    if (this._bank.msb) cc[CC.BANK_MSB] = this._bank.msb.value;
    if (this._bank.lsb) cc[CC.BANK_LSB] = this._bank.lsb.value;
    for (const [n, v] of this._dataRaw) cc[n] = v;
    const reg = (type, i) => this._regs[type][i]?.value ?? null;
    cc[CC.RPN_MSB] = reg('rpn', 0); cc[CC.RPN_LSB] = reg('rpn', 1); cc[CC.NRPN_MSB] = reg('nrpn', 0); cc[CC.NRPN_LSB] = reg('nrpn', 1);
    return {
      cc,
      program: this._program?.event.value ?? null,
      programBank: this._program ? { msb: this._program.bankMsb?.value ?? null, lsb: this._program.bankLsb?.value ?? null } : null,
      pitchBend: this._pitchBend?.value ?? null,
      channelPressure: this._pressure?.value ?? null,
      polyPressure: new Map([...this._poly].map(([key, ev]) => [key, ev.value])),
      mode: this._mode ? (this._mode.data1 === CC.MONO ? 'mono' : 'poly') : null,
      selection: this._current ? { type: this._current, msb: reg(this._current, 0), lsb: reg(this._current, 1) } : null,
      parameters: new Map([...this._params].map(([key, p]) => [key, { type: p.type, msb: p.msb, lsb: p.lsb, value: [...p.value], adjusted: p.adjusted }])),
    };
  }

  /** @returns {LaneEvent[]}  依原檔順序；合成的事件 synthetic: true、id: null */
  chase() {
    const items = [];   // { at: 決定順序的事件, events: 要送的事件 }
    const add = (at, events) => items.push({ at, events });
    for (const s of this._cc.values()) if (s.event) add(s.event, [s.event]);
    if (this._mode) add(this._mode, [this._mode]);
    const { msb, lsb } = this._bank;
    if (this._program) {
      const { event, bankMsb, bankLsb } = this._program;
      add(event, [bankMsb, bankLsb, event].filter(Boolean));   // program 連同它當下生效的 bank select
      if (msb && msb !== bankMsb) add(msb, [msb]);              // program 之後又送、還沒被 program change 用到的 bank select
      if (lsb && lsb !== bankLsb) add(lsb, [lsb]);
    } else {
      if (msb) add(msb, [msb]);
      if (lsb) add(lsb, [lsb]);
    }
    if (this._pitchBend?.event) add(this._pitchBend.event, [this._pitchBend.event]);
    if (this._pressure?.event) add(this._pressure.event, [this._pressure.event]);
    for (const ev of this._poly.values()) add(ev, [ev]);
    for (const g of this._parameterGroups()) add(g.at, g.events);
    // 選參數的還原接在原檔的位置（還沒結束的 session 的第一個事件，沒有就是最後一次選參數），不放在最後：官方 SpessaSynth 會把 GS 的 NRPN（如 1/8 vibrato rate）換成 CC76 等控制器，
    // 原檔之後若又直接送那個 CC，順序錯了值就會被蓋掉。所有參數群組都在最後一次選參數之前結束，所以這個位置一定在它們之後。
    const tail = this._selectionTail();
    if (tail.length) add(this._open?.events[0] ?? this._lastSelect, tail);
    items.sort((a, b) => byFileOrder(a.at, b.at));   // sort 是穩定排序：同一個位置（同一個 CC121 推出來的）維持加入順序
    return items.flatMap((i) => i.events);
  }

  // 每個參數的值由「最後一個含 MSB 的 session 起」的 session 決定（更早的被那個 MSB 蓋掉）；每個 session 前面補選參數。這樣重播
  // 之後的值跟照檔案播一樣——不管接收端是「收到 MSB 時 LSB 歸 0」（MIDI 1.0），還是「選參數時清掉 data entry 暫存器」（官方
  // SpessaSynth）。目前參數還沒結束的 session 不放在這裡，留到 _selectionTail() 才送（CC96／97 不能重複套用）。
  _parameterGroups() {
    const groups = [];
    for (const p of this._params.values()) {
      const from = Math.max(0, p.sessions.findLastIndex((s) => s.hasMsb));
      const kept = p.sessions.slice(from).filter((s) => s !== this._open);
      if (!kept.length) continue;
      const [msbCC, lsbCC] = p.type === 'rpn' ? [CC.RPN_MSB, CC.RPN_LSB] : [CC.NRPN_MSB, CC.NRPN_LSB];
      const events = kept.flatMap((s) => [syntheticEvent(s.events[0], 'controlChange', msbCC, p.msb), syntheticEvent(s.events[0], 'controlChange', lsbCC, p.lsb), ...s.events]);
      groups.push({ at: kept.at(-1).events.at(-1), events });
    }
    return groups;
  }

  // 把選參數的暫存器還原成目前的狀態：先另一種、再目前這一種（最後選的那一種就是目前的），再重播目前參數還沒結束的 session。
  _selectionTail() {
    if (!this._current) return [];
    const other = this._current === 'rpn' ? 'nrpn' : 'rpn';
    return [...this._regs[other].filter(Boolean), ...this._regs[this._current].filter(Boolean), ...(this._open?.events ?? [])];
  }
}

function trackerAt(lane, tick) {
  const tracker = new ChannelStateTracker();
  for (const ev of lane) { if (ev.ticks >= tick) break; tracker.apply(ev); }
  return tracker;
}

/** 某個 tick 之前（不含）這個 channel 的控制器狀態。lane＝parsed.channelLanes.get(channel)。O(這個 tick 之前的事件數)。 */
export function controllerStateAt(lane, tick) { return trackerAt(lane, tick).snapshot(); }

/** 把 channel 帶到這個 tick 之前（不含）狀態的最少事件，依原檔順序（合約見 ChannelStateTracker）。 */
export function chaseEventsAt(lane, tick) { return trackerAt(lane, tick).chase(); }
