// midiPlayer.js — 播放器：playerStore（唯一的真相）＋動作＋三個畫面區塊（播放 pill、分譜與本地檔、雲端曲庫），檔尾合成 { actions, fields, inputs, mount, render } 給 ui.js。
// 選歌只解析不播放；指派（每個 part 一個下拉，只有一個多譜表 part 時改列 staff）是持久設定，播放中改指派從目前位置接續（synth.reassign()）。
// 試聽（♪）用官方 Sequencer，跟演奏互斥（共用合成器的 channel）；store 的 mode 決定播放列作用在演奏還是試聽。

import { Store, rafThrottle, setMarqueeText } from '../ui.js';
import * as synth from './synth.js';
import { parseMidi, midiNoteName } from '../midi/midiParser.js';
import { downloadMidiFile, fetchCategories, searchSongs } from './midiApi.js';
import { KEYBOARD_SLOT, LOOKAHEAD_MS } from '../performance/scheduler.js';

export { KEYBOARD_SLOT, LOOKAHEAD_MS };

// 秒數 → m:ss（NaN／負數是 0:00）
function formatTime(sec) {
  if (isNaN(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

const PLAYER_COUNT = 4;      // 演奏者 ID 上限（同 vision.js 的 CONFIG.maxUsers）；實際列幾個看「現場人數」

// 排程 tick 週期（演奏者的起音不經過它）
const SCHEDULER_TICK_MS = 12;
const UI_TICK_MS = 200;
const LOADING_INDICATOR_DELAY_MS = 120; // 延遲才顯示 ⋯（本地檔幾乎瞬間就好）

/**
 * @typedef {object} PlayerState
 * @property {null | { kind: 'local', file: File, name: string } | { kind: 'cloud', id: string, blob: Blob, name: string }} source
 * @property {string} songTitle          來源名；空字串時頂端顯示「等待選擇歌曲...」
 * @property {string | null} notice      覆蓋歌名的訊息（暖機失敗／播放失敗／雲端下載失敗／檔案格式不支援）
 * @property {'perform' | 'preview'} mode  播放列目前作用在演奏還是試聽（官方 Sequencer）
 * @property {'idle' | 'loading' | 'paused' | 'playing'} transport  目前作用對象（mode 指的那一邊）的播放狀態
 * @property {boolean} started           這首載入後播過了沒（播放列的狀態表用：還沒播過時不能重播）
 * @property {boolean} finished          播完了（此時 ▶ 從頭播）
 * @property {boolean} busy              處理中（＝isSongLoading；播放列按鈕全灰）
 * @property {object | null} score       parseMidi() 的結果；null ＝ 沒有分譜資訊（單軌或解析失敗）
 * @property {object[]} parts            score.parts；沒有聲部（長度 0）才不顯示分譜區塊
 * @property {Map<string, number|string>} assignments 指派單位 id（part id，或單聲部多行譜時的 staff id）→ 演奏者槽位（1~4 或 KEYBOARD_SLOT）；改動時換新 Map
 * @property {number} playerCount        系統控制 bar 選的「現場人數」；0 ＝ 還沒選
 * @property {number} positionSeconds    播放位置（演奏：樂譜秒；試聽：官方 currentTime）；只給進度條讀
 * @property {number} previewDuration    試聽中這首的長度（秒，官方 duration）；試聽時我們的 parser 解析失敗才拿它當進度條分母（見 renderTopProgress），不在試聽是 0
 * @property {{ items: object[], categories: string[], query: string, category: string, status: 'idle' | 'searching' | 'ready' | 'empty' | 'error', selectedId: string }} library
 */
export const playerStore = new Store(/** @type {PlayerState} */ ({
  source: null,
  songTitle: '',
  notice: null,
  mode: 'perform',
  transport: 'idle',
  started: false,
  finished: false,
  busy: false,
  score: null,
  parts: [],
  assignments: new Map(),
  playerCount: 0,
  positionSeconds: 0,
  previewDuration: 0,
  library: { items: [], categories: [], query: '', category: '', status: 'idle', selectedId: '' },
}));

// 不進 store 的狀態：只影響聲音，或只是防護旗標
let lastPlayedSignature = null;    // 引擎裡目前播的「來源＋分譜」簽章，見 buildPlaybackSignature()
// 選歌的請求代號：每個 await 之後比對，不是最新那次就整段作廢（晚回來的雲端回應不能蓋掉後選的本地檔）
let sourceLoadToken = 0;
let isSongLoading = false;         // 重入防護（立即生效，不等 120ms 的 ⋯）
let endHandled = false;            // 歌曲播完的收尾只做一次

// 來源身分：本地檔用檔名＋大小＋修改時間，雲端用 id
function sourceIdentity(source) {
  return source.kind === 'local'
    ? `local:${source.file.name}:${source.file.size}:${source.file.lastModified}`
    : `cloud:${source.id}`;
}

// 指派的簽章：沒有指派是 'ALL'（整首自動播放），否則是排序後的「單位=槽位」；不同就要重新 synth.load()
function selectionSignature(score, assignments) {
  if (!score || assignments.size === 0) return 'ALL';
  return 'assign:' + [...assignments.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([p, id]) => `${p}=${id}`).join(',');
}

// 指派單位：通常一個 part 一個；只有一個 part 而它有 ≥ 2 個 staff（鋼琴兩行譜）時改成一個 staff 一個（scheduler 兩種 id 都認）。
// 譜表名稱附上音域與音數：MIDI 沒有譜號資訊，這是分得出哪個譜表是哪個的唯一事實（打擊只附音數）。
export function assignmentUnits(parts) {
  if (parts.length === 1 && parts[0].staves?.length >= 2) {
    return parts[0].staves.map((staff, i) => {
      const facts = [];
      if (!staff.percussionKit && Number.isInteger(staff.minPitch) && staff.minPitch <= staff.maxPitch) {
        facts.push(`${midiNoteName(staff.minPitch)}–${midiNoteName(staff.maxPitch)}`);
      }
      if (Number.isInteger(staff.noteCount)) facts.push(`${staff.noteCount} 音`);
      return { id: staff.id, name: `${parts[0].name}・譜表 ${i + 1}${facts.length ? `（${facts.join('，')}）` : ''}` };
    });
  }
  return parts.map((part) => ({ id: part.id, name: part.name }));
}
// 分譜清單的提示（只顯示，不自動合併或指派；「太細」由使用者自己把幾個 part 指派給同一人）→ part id → { late, group }：
//   · late：第一個音在全曲 25% 之後（lakh 約 18% 的 part；25% 是暫定的 UI 門檻），標「第 m:ss 進入」
//   · group：program 相同、軌名去掉結尾數字與左右手標記後也相同的旋律 part 標同一個字母（軌名是自由文字，只當提示、不拿來切分）
// 依 score 快取（播放中約每 200ms 重繪）。單一字母 l／r 只在分隔符號後才算左右手（不然 Guitar 會變 guita）。
const normTrackName = (s) => (s ?? '').toLowerCase().replace(/(?:[\s_\-.:#]*(?:right[\s_\-.]*hand|left[\s_\-.]*hand|rh|lh|left|right)|[\s_\-.:#]+[lr]|[\s_\-.:#]*\d+)+[\s_\-.:#]*$/, '')
  .replace(/[\s_\-.:#()[\]{}'"]/g, '');
const hintsCache = new WeakMap();
export function partHints(score) {
  if (!score || score.parts.length < 2) return new Map();
  if (!hintsCache.has(score)) hintsCache.set(score, computePartHints(score));
  return hintsCache.get(score);
}
function computePartHints(score) {
  const hints = new Map();
  const end = score.lastVoiceEventTick || 1;
  const keyOf = new Map();
  for (const part of score.parts) {
    const main = [...part.staves].sort((a, b) => b.noteCount - a.noteCount)[0];
    const name = normTrackName(score.tracks[main.trackIndex]?.name);
    // format 0 只有一條軌，軌名不是證據
    if (!main.percussionKit && name && score.format !== 0) keyOf.set(part.id, `${main.program}|${name}`);
    hints.set(part.id, { late: part.startTick / end > 0.25 ? score.midiTicksToSeconds(part.startTick) : null, group: null });
  }
  const members = new Map();
  for (const [id, key] of keyOf) { if (!members.has(key)) members.set(key, []); members.get(key).push(id); }
  let letter = 0;
  for (const ids of members.values()) {
    if (ids.length < 2) continue;
    const label = String.fromCharCode(65 + (letter % 26)) + (letter >= 26 ? String(Math.floor(letter / 26) + 1) : '');
    letter++;
    for (const id of ids) hints.get(id).group = label;
  }
  return hints;
}
const allUnitIds = () => assignmentUnits(playerStore.state.parts).map((u) => u.id);
const assignedUnitIds = () => allUnitIds().filter((id) => playerStore.state.assignments.has(id));

const updateHumanGate = () => {
  const armed = synth.isLoaded() && !synth.isPaused() && !endHandled && assignedUnitIds().length > 0;
  synth.setHumanGate(armed);
};

// 觸發一次（鍵盤與揮手都接到這裡）：同步呼叫排程器，音在這次呼叫內送進合成器
export function triggerInput(input) {
  synth.scheduler.trigger(input);
}

// 在場名單（scheduler.js 的 setPresence()）
export function setPresentSlots(slots) {
  synth.scheduler.setPresence(slots, performance.now());
}

// 放開一個鍵（scheduler.js 的 lift()）
export function liftInput(input) {
  synth.scheduler.lift(input);
}

// 量測（devStats.js 用）：以下幾個都轉給 scheduler.js 的同名方法
export function lateStats() {
  return synth.scheduler.lateStats();
}

export function chaseStats() {
  return synth.scheduler.chaseStats();
}

export function rateBounds() {
  return synth.scheduler.rateBounds();
}

export function playbackRate() {
  return synth.scheduler.playbackRate;
}

export function ensembleStats() {
  const { ensemble, performers } = synth.scheduler.inspect();
  const r = (x, d) => (Number.isFinite(x) ? Math.round(x * d) / d : x);
  return {
    帶頭: ensemble.leaderSlot,
    名單: ensemble.roster,
    演奏者: performers.map((p) => ({
      槽位: p.slot, 來源: p.source, 狀態: p.status, 區間: p.zone, x拍: r(p.xBeats, 100), 速度: r(p.rate, 1000), 錯過: p.missed, 離上一下ms: r(p.sinceLastMs, 1),
    })),
  };
}

export function audioLatency() {
  return synth.audioLatencyInfo();
}

// 錄音 v4（devStats.js 的 __pressLog 匯出，離線分析用）：歌、指派、按鍵嘗試、放開、事件串流。v4 比 v3 只多欄位。
export function pressLog() {
  const { source, songTitle, assignments } = playerStore.state;
  return {
    version: 4,
    song: { title: songTitle, source: source && { kind: source.kind, name: source.name, id: source.id ?? null } },
    assignments: [...assignments],
    presses: synth.scheduler.pressLog(),
    lifts: synth.scheduler.liftLog(),
    events: synth.scheduler.eventLog(),
    recordedAt: new Date().toISOString(),
  };
}

function clearScore() {
  playerStore.set({ score: null, parts: [], assignments: new Map(), positionSeconds: 0 });
}

// 選歌後的載入：解析＋更新分譜清單，不啟動音源引擎
function loadScore(arrayBuffer, label) {
  clearScore();
  try {
    const score = parseMidi(arrayBuffer);
    if (score.warnings.length) {
      console.warn(`⚠️ ${label} 有 ${score.warnings.length} 則解析警告：`, score.warnings);
    }
    playerStore.set({ score, parts: score.parts });
  } catch (err) {
    // 解析失敗不擋播放，但演奏會靜音（演奏不走官方 Sequencer，沒有退路）
    console.warn(`⚠️ ${label} 分譜解析失敗，無法播放`, err);
  }
}

// 換來源的共同前置：停掉演奏與試聽、清殘響、簽章失效、發新的請求代號
function beginSourceChange() {
  synth.flushPreviousSong();
  lastPlayedSignature = null;
  playerStore.set({ mode: 'perform', transport: 'idle', notice: null, started: false, finished: false, previewDuration: 0 });
  return ++sourceLoadToken;
}
const isStale = (token) => token !== sourceLoadToken;

function setNoSource() {
  playerStore.set({ source: null, songTitle: '' });
  clearScore();
}

async function selectLocalFile(file) {
  const token = beginSourceChange();
  if (!/\.(mid|midi)$/i.test(file.name)) {
    setNoSource();
    playerStore.set({ notice: `檔案格式不支援：${file.name}` });
    return;
  }
  playerStore.set({ source: { kind: 'local', file, name: file.name }, songTitle: file.name });
  const buf = await file.arrayBuffer();
  if (isStale(token)) return;
  loadScore(buf, file.name);
  playerStore.set({ transport: 'paused' });
}

// 雲端：下載完成才寫 source，過期的回應不碰共用狀態
async function selectCloudSong(id, name) {
  const token = beginSourceChange();
  playerStore.set({ source: null, songTitle: name, transport: 'loading' });
  clearScore();
  try {
    const blob = await downloadMidiFile(id);
    if (isStale(token)) return;
    const buf = await blob.arrayBuffer();
    if (isStale(token)) return;
    playerStore.set({ source: { kind: 'cloud', id, blob, name } });
    loadScore(buf, name);
    playerStore.set({ transport: 'paused' });
  } catch (err) {
    console.error('❌ 雲端曲目下載失敗', err);
    if (isStale(token)) return;
    // 下拉退回 placeholder：停在這首的話，原生 <select> 重選同一項不會觸發 change，就沒辦法重試
    setLibrary({ selectedId: '' });
    playerStore.set({ transport: 'idle', notice: '雲端下載失敗' });
  }
}

// 引擎裡在播的簽章（來源＋指派）：相同才能直接續播
const buildPlaybackSignature = (source) =>
  `${sourceIdentity(source)}::${selectionSignature(playerStore.state.score, playerStore.state.assignments)}`;

// 從頭播時通知 main.js：逐幀紀錄跟按鍵錄音同一個起點
let playbackRestartListener = null;
export function setPlaybackRestartListener(fn) { playbackRestartListener = fn; }

// ▶／↻（fromStart＝重播：從頭來）
async function playCurrentSource({ fromStart = false } = {}) {
  const s = playerStore.state;
  if (!s.source) return;
  // 重入防護：'loading' 延遲 120ms 才顯示，在那之前連按第二下會讓簽章記到沒進引擎的組合
  if (isSongLoading) return;
  // 不先清掉，重播播完的歌時真人聲部第一顆音會沒聲
  endHandled = false;
  isSongLoading = true;
  playerStore.set({ busy: true });

  let loadingIndicatorTimer = null;
  try {
    const signature = buildPlaybackSignature(s.source);
    if (signature !== lastPlayedSignature || fromStart || s.finished) playbackRestartListener?.();
    if (signature === lastPlayedSignature) {
      // 引擎裡就是這份組合：重播或播完後 ▶ 從頭來，其餘只是續播
      await (fromStart || s.finished ? synth.restart() : synth.play());
    } else {
      // 簽章不同：完整重新載入、從頭播（「處理中」只由 ▶ 的 ⋯ 表達，不改寫歌名）
      loadingIndicatorTimer = setTimeout(() => playerStore.set({ transport: 'loading' }), LOADING_INDICATOR_DELAY_MS);
      // 傳快照不傳活的 Map：演奏計畫靠它決定聲部走哪個合成器
      await synth.load(s.score, [...s.assignments]);
      if (synth.scheduler.unplacedStaffIds.length) {
        console.warn('⚠️ 分譜的 staff 超過合成器可用的輸出 channel（每個 port 旋律 15 個、鼓組各佔一個，載入時已依歌曲需要補 port），以下 staff 這一輪不會出聲：',
          synth.scheduler.unplacedStaffIds.join('、'));
      }
      await synth.play();
      lastPlayedSignature = signature;
    }
    playerStore.set({ transport: 'playing', notice: null, started: true, finished: false });
    updateHumanGate();
  } catch (err) {
    console.error(err);
    playerStore.set({ transport: 'paused', notice: `播放失敗：${s.source.name}` });
  } finally {
    clearTimeout(loadingIndicatorTimer);
    isSongLoading = false;
    playerStore.set({ busy: false });
  }
}

// ❚❚：只有播放中才能暫停（不只靠 disabled）
function pauseCurrentSource() {
  if (playerStore.state.transport !== 'playing') return;
  if (playerStore.state.mode === 'preview') synth.pausePreview();
  else synth.pause();
  playerStore.set({ transport: 'paused', notice: null });
  updateHumanGate();
}

const sourceBytes = (source) => (source.kind === 'local' ? source.file : source.blob).arrayBuffer();

// 試聽失敗的提示（parse／timeout 也是 parser 差異的訊號）
const PREVIEW_NOTICE = {
  engine: '⚠️ 音源引擎載入失敗',
  parse: '官方播放器無法解析這首 MIDI',
  timeout: '官方播放器無法解析這首 MIDI',
};

// ♪ 進入試聽：結束目前的演奏進度（共用 channel），簽章作廢，離開後 ▶ 一律重新載入。失敗回到「已載入、還沒播過」並提示
async function enterPreview() {
  const { source } = playerStore.state;
  if (!source || isSongLoading) return;
  isSongLoading = true;
  playerStore.set({ busy: true });
  const token = sourceLoadToken;
  try {
    const bytes = await sourceBytes(source);
    if (isStale(token)) return;
    lastPlayedSignature = null;
    endHandled = false;
    await synth.startPreview(bytes);
    // 期間換了來源：收掉這次的試聽
    if (isStale(token)) { synth.flushPreviousSong(); return; }
    playerStore.set({
      mode: 'preview', transport: 'playing', started: true, finished: false, notice: null,
      previewDuration: synth.previewDuration(), positionSeconds: 0,
    });
    updateHumanGate();
  } catch (err) {
    if (isStale(token) || err.kind === 'aborted') return;
    if (err.kind === 'parse' || err.kind === 'timeout') console.warn(`⚠️ 官方播放器無法解析 ${source.name}`, err);
    else if (err.kind !== 'engine') console.error(err);
    synth.flushPreviousSong(); // 失敗的載入可能動過合成器
    playerStore.set({
      mode: 'perform', transport: 'paused', started: false, finished: false, previewDuration: 0,
      notice: PREVIEW_NOTICE[err.kind] ?? `試聽失敗：${source.name}`,
    });
  } finally {
    isSongLoading = false;
    playerStore.set({ busy: false });
  }
}

// ♪ 離開試聽：回到「已載入、還沒播過」
function leavePreview() {
  synth.flushPreviousSong();
  lastPlayedSignature = null;
  endHandled = false;
  playerStore.set({
    mode: 'perform', transport: 'paused', started: false, finished: false,
    notice: null, previewDuration: 0, positionSeconds: 0,
  });
  updateHumanGate();
}

// 試聽中的 ▶ 與 ↻
async function playPreview({ fromStart = false } = {}) {
  if (isSongLoading) return;
  isSongLoading = true;
  playerStore.set({ busy: true });
  try {
    await (fromStart ? synth.restartPreview() : synth.resumePreview());
    // await 期間換了來源或離開試聽：不要寫回「播放中」
    if (playerStore.state.mode !== 'preview') return;
    playerStore.set({ transport: 'playing', finished: false, notice: null });
  } catch (err) {
    console.error(err);
    if (playerStore.state.mode === 'preview') playerStore.set({ transport: 'paused', notice: `試聽失敗：${playerStore.state.source?.name ?? ''}` });
  } finally {
    isSongLoading = false;
    playerStore.set({ busy: false });
  }
}

// 下拉的值 → 槽位（'kb' 不看現場人數；數字要在 1～現場人數；其餘是 null）
function slotOfOption(value) {
  if (value === KEYBOARD_SLOT) return KEYBOARD_SLOT;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= playerStore.state.playerCount ? n : null;
}

// 播放中（含暫停）改指派從目前位置接續；其他狀態等下一次 ▶ 依簽章重新載入
function canReassignInPlace() {
  const s = playerStore.state;
  return !(lastPlayedSignature === null || s.mode !== 'perform' || isSongLoading || endHandled || !s.source || !s.score);
}
function reassignInPlace() {
  if (!canReassignInPlace()) return;
  const s = playerStore.state;
  synth.reassign(s.score, [...s.assignments]);
  lastPlayedSignature = buildPlaybackSignature(s.source);
}

// dev 開關（devStats.js 的 __tryMode()）：排程器只在 load()／reassign() 讀，所以播放中就地重建、其他狀態等下一次 ▶。
// 載入中直接丟錯：那時 load() 可能已讀過舊開關，改動會被默默吃掉。
export function setDevModes(source, patch) {
  if (isSongLoading) throw new Error('載入或處理中，等播放開始後再切換');
  const cur = synth.scheduler.cfg.modes;
  if (!Object.hasOwn(cur, source)) throw new Error(`來源只有 ${Object.keys(cur).join('／')}`);
  const bad = Object.keys(patch).filter((k) => !Object.hasOwn(cur[source], k));
  if (bad.length) throw new Error(`沒有這個開關：${bad.join('、')}（只有 ${Object.keys(cur[source]).join('／')}）`);
  synth.scheduler.cfg = { ...synth.scheduler.cfg, modes: Object.freeze({ ...cur, [source]: Object.freeze({ ...cur[source], ...patch }) }) };
  if (canReassignInPlace()) reassignInPlace();
  else lastPlayedSignature = null;
  return synth.scheduler.cfg.modes;
}
export const devModes = () => synth.scheduler.cfg.modes;

function assignPart(unitId, value) {
  const slot = slotOfOption(value);
  const assignments = new Map(playerStore.state.assignments);
  if (slot !== null) assignments.set(unitId, slot);
  else assignments.delete(unitId);
  playerStore.set({ assignments });
  reassignInPlace();
  updateHumanGate();
}

// 「現場人數」切換成功後：下拉改列 1～n，超出的指派剪掉（PC 鍵盤手不受影響）
export function setPlayerCount(n) {
  const next = Math.max(0, Math.min(PLAYER_COUNT, Number(n) || 0));
  const s = playerStore.state;
  if (next === s.playerCount) return;
  const kept = [...s.assignments].filter(([, id]) => id === KEYBOARD_SLOT || id <= next);
  const assignments = new Map(kept);
  playerStore.set({ playerCount: next, assignments });
  if (kept.length !== s.assignments.size) reassignInPlace();
  updateHumanGate();
}

// 音源引擎失敗不擋整個 app，但寫在頂端讓使用者看得到
export async function warmUpMidiEngine() {
  const ok = await synth.initEngine();
  if (!ok) playerStore.set({ notice: '⚠️ 音源引擎載入失敗，按下播放時會自動重試' });
  return ok;
}

// UI tick：播完偵測、humanGate 補算、進度條
function uiTick() {
  const inPreview = playerStore.state.mode === 'preview';
  if (inPreview) {
    // 試聽播完：官方自己會停，這裡只切畫面
    if (!isSongLoading && !playerStore.state.finished && synth.isPreviewFinished()) {
      playerStore.set({ transport: 'paused', finished: true });
    }
  } else if (!isSongLoading && synth.isLoaded() && !endHandled && synth.isFinished()) {
    endHandled = true;
    synth.pause();
    playerStore.set({ transport: 'paused', finished: true });
  }
  // 暫停、播完這類轉變沒有新觸發時，也在 200ms 內把 humanGain 收對
  updateHumanGate();

  // 進度：演奏時是播放頭的樂譜秒（沒人觸發就停住），試聽時是官方 currentTime；差 < 0.05s 不寫，免得每 200ms 都重繪
  const score = playerStore.state.score;
  const pos = inPreview ? synth.previewTime()
    : synth.isLoaded() && score ? score.midiTicksToSeconds(synth.scheduler.getPositionTicks()) : 0;
  if (Math.abs(pos - playerStore.state.positionSeconds) > 0.05) {
    playerStore.set({ positionSeconds: pos });
  }
}

// 排程 tick（scheduler.tick()）。順便記播放中的實際間隔給 devStats.js 的 __latency()，滿了丟最舊的一半
const TICK_LOG_MAX = 50000;   // 12ms 一次約 10 分鐘
const tickLog = [];
let lastTickAt = null;
export const tickIntervals = () => tickLog.slice();
function schedulerTick() {
  if (!synth.isLoaded() || synth.isPaused()) { lastTickAt = null; return; }
  const now = performance.now();
  if (lastTickAt !== null) {
    tickLog.push([now, now - lastTickAt]);
    if (tickLog.length > TICK_LOG_MAX) tickLog.splice(0, TICK_LOG_MAX >> 1);
  }
  lastTickAt = now;
  synth.scheduler.tick(now, synth.audioNow());
}

export function startPlayer() {
  synth.scheduler.enableEventLog();   // 一律記，彈完隨時可匯出
  setInterval(uiTick, UI_TICK_MS);
  setInterval(schedulerTick, SCHEDULER_TICK_MS);
}

// 播放 pill 四顆鈕（▶ ❚❚ ↻ ♪）哪顆能按、哪顆是目前狀態，由 transportButtonState() 依 store 推導：
//   沒歌／載入中／處理中 → 全灰；剛載入 → ▶ ♪；播放中 → 只有 ❚❚（誤按重播會打斷演奏）；暫停／播完 → ▶ ↻ ♪；試聽中同樣規則，♪ 恆亮（再按結束試聽）
const pill = document.getElementById('toolbar-playback');
const transportGroup = document.getElementById('transport-group');
const songToggle = document.getElementById('song-toggle');   // pill 左端的「選歌」，分給歌名的寬度要扣掉它
const btnPlay = document.getElementById('btnPlay');
const btnPause = document.getElementById('btnPause');
const btnReplay = document.getElementById('btnReplay');
const btnPreview = document.getElementById('btnPreview');
const statusText = document.getElementById('midiStatusText');
const topProgressBar = document.getElementById('topProgressBar');

const IDLE_TITLE = '等待選擇歌曲...';

// 歌名優先單行，超長才縮小字級（--song-title-scale），縮到 MIN_SONG_TITLE_SCALE 還放不下才換行
const MIN_SONG_TITLE_SCALE = 0.6;
function fitSongTitle() {
  statusText.classList.remove('allow-wrap');
  statusText.style.setProperty('--song-title-scale', '1');
  const cs = getComputedStyle(pill);
  const gapPx = parseFloat(cs.columnGap) || 0;
  const padPx = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);   // clientWidth 含內距
  const available = pill.clientWidth - padPx - songToggle.offsetWidth - transportGroup.offsetWidth - 2 * gapPx;
  const natural = statusText.scrollWidth;
  if (available <= 0 || natural <= available) return;
  const scale = Math.max(MIN_SONG_TITLE_SCALE, available / natural);
  statusText.style.setProperty('--song-title-scale', scale.toFixed(3));
  if (scale <= MIN_SONG_TITLE_SCALE && statusText.scrollWidth > available) {
    statusText.classList.add('allow-wrap');
  }
}

// 四顆鈕的狀態表（純函式）。busy 期間 is-empty 維持 false，免得續播那一瞬間控制列透明度跳一下。
function transportButtonState({ mode, transport, started, finished, busy }) {
  const grey = { play: false, pause: false, replay: false, preview: false, current: [] };
  if (transport === 'idle' || transport === 'loading') return { ...grey, empty: true };
  if (busy) return { ...grey, empty: false };
  const inPreview = mode === 'preview';
  if (transport === 'playing') {
    return {
      play: false, pause: true, replay: false,
      preview: inPreview, // 試聽播放中 ♪ 是「結束試聽」
      current: inPreview ? ['pause', 'preview'] : ['pause'], empty: false,
    };
  }
  // paused：演奏還沒播過不能重播；試聽一定播過
  return { play: true, pause: false, replay: inPreview || started || finished, preview: true, current: inPreview ? ['preview'] : [], empty: false };
}

// action 進來再對一次狀態表（不只靠 disabled）
const whenAllowed = (button, fn) => () => { if (transportButtonState(playerStore.state)[button]) fn(); };
const transportActions = {
  'play': whenAllowed('play', () => (playerStore.state.mode === 'preview' ? playPreview() : playCurrentSource())),
  'pause': whenAllowed('pause', () => pauseCurrentSource()),
  'replay': whenAllowed('replay', () => (playerStore.state.mode === 'preview' ? playPreview({ fromStart: true }) : playCurrentSource({ fromStart: true }))),
  'preview': whenAllowed('preview', () => (playerStore.state.mode === 'preview' ? leavePreview() : enterPreview())),
};

function mountTransportPill() {
  // 視窗尺寸改變會動到 pill 的 max-width 與 --ui-fs
  window.addEventListener('resize', rafThrottle(fitSongTitle));
  fitSongTitle();
}

function renderTransportPill({ player }) {
  const state = transportButtonState(player);
  btnPlay.disabled = !state.play;
  btnPause.disabled = !state.pause;
  btnReplay.disabled = !state.replay;
  btnPreview.disabled = !state.preview;
  btnPause.classList.toggle('is-current', state.current.includes('pause'));
  btnPreview.classList.toggle('is-current', state.current.includes('preview'));
  btnPreview.setAttribute('aria-label', player.mode === 'preview' ? '關閉試聽' : '開啟試聽');
  btnPlay.classList.toggle('is-loading', player.transport === 'loading');
  pill.classList.toggle('is-empty', state.empty);

  // 只在文字不同時才寫：相同字串也會讓 pill 重新量寬置中，看起來在抽動
  const text = player.notice ?? (player.songTitle || IDLE_TITLE);
  if (statusText.textContent !== text) {
    statusText.textContent = text;
    fitSongTitle();
  }
}

// 頂端進度條：第一次有長度之前收起來；之後換歌時 score 短暫變 null 也不收，免得每次換歌都閃一次
let hasShownProgress = false;
function renderTopProgress({ player }) {
  // 試聽的分母用官方 duration 的定義（最後一個 channel 事件的秒數），但用我們的速度表算：core 4.4.10 速度事件分散多軌時速度表沒排序，
  // duration 會算錯（lakh 41 檔）；官方播放本身不受影響。我們的 parser 解析失敗時才用官方 duration。
  const total = player.mode === 'preview'
    ? (player.score ? player.score.midiTicksToSeconds(player.score.lastVoiceEventTick) : player.previewDuration)
    : (player.score?.durationSeconds || 0);
  if (total > 0) hasShownProgress = true;
  topProgressBar.hidden = !hasShownProgress;
  if (total > 0) {
    const ratio = Math.min(1, player.positionSeconds / total);
    if (topProgressBar.value !== ratio) topProgressBar.value = ratio;
  }
}

// 雲端曲庫（midiApi.js）：搜尋狀態在 playerStore.library；分類集合跨搜尋累積（分類端點可能失敗）。
// 關鍵字在這裡篩、伺服器只篩類別：曲庫的 q 也比對看不到的欄位（2026-11-03 實測 q=z 命中 73 首，歌名或作曲者有 z 的只有 2 首）。只比對下拉上看得到的「歌名 - 作曲者」。
// 第一項「請選擇歌曲」只是提示、不能選（能選的話誤點就把歌卸載了）。
const categoryEl = document.getElementById('midiCategory');
const queryEl = document.getElementById('midiSongQuery');
const songSelectEl = document.getElementById('midiSongSelect');
const songMirrorEl = document.getElementById('midiSongMirror');
const currentSongOpt = new Option('', '');   // 「目前：歌名」

const categorySet = new Set();
let requestToken = 0;          // 晚回來的舊結果不能蓋掉新的
let fetchedItems = [];         // 目前類別的整份清單（關鍵字從這裡篩）
let fetchedCategory = null;    // fetchedItems 屬於哪個類別；null＝還沒抓、上次失敗或要重抓
let inflightCategory = null;   // 抓的期間打字不重複送請求，回來時用最新的關鍵字篩

const library = () => playerStore.state.library;
const setLibrary = (patch) => playerStore.set({ library: { ...library(), ...patch } });

function mergeCategories(categories) {
  for (const category of categories) categorySet.add(category);
  setLibrary({ categories: [...categorySet].sort((a, b) => a.localeCompare(b, 'zh-Hant')) });
}

// NFKC（全形 ｃａｎｏｎ 找得到 Canon）、不分大小寫；空白分詞，每個詞都要出現
const foldText = (s) => s.normalize('NFKC').toLowerCase();
function applyQuery() {
  const words = foldText(library().query).split(/\s+/).filter(Boolean);
  const items = words.length
    ? fetchedItems.filter((item) => { const label = foldText(songLabel(item)); return words.every((w) => label.includes(w)); })
    : fetchedItems;
  setLibrary({ items, status: items.length ? 'ready' : 'empty' });
}

async function search() {
  const category = library().category.trim();
  if (fetchedCategory === category) { applyQuery(); return; }
  if (inflightCategory === category) return;
  inflightCategory = category;
  const token = ++requestToken;

  setLibrary({ status: 'searching', items: [] });
  try {
    const { items, categories } = await searchSongs({ query: '', category });
    if (token !== requestToken) return;
    mergeCategories(categories);
    fetchedItems = items;
    fetchedCategory = category;
    applyQuery();
  } catch (error) {
    if (token !== requestToken) return;
    fetchedCategory = null;   // 下次搜尋（打字、換類別、關面板）就重試
    setLibrary({ items: [], status: 'error' });
    console.error('❌ [搜尋 MIDI 歌曲清單失敗]', error);
  } finally {
    if (token === requestToken) inflightCategory = null;
  }
}

const libraryFields = {
  'category': (el) => {
    // 換分類時保留關鍵字；已選的歌跟著來源走，不動
    setLibrary({ category: el.value });
    search();
  },
  'song': (el) => {
    const id = el.value;
    // 「目前：歌名」：搜尋條件歸位讓它回到清單，不重新下載
    if (id === library().selectedId) { clearLibraryFilters(); return; }
    const name = el.options[el.selectedIndex].text;
    setLibrary({ selectedId: id });
    selectCloudSong(id, name);
  },
};

const libraryInputs = {
  // 本地重篩、不用去抖。注音組字中只記字不篩（會閃「找不到」），compositionend 再送一次；組字中也要寫進 store，不然 render 會蓋掉組字中的文字
  'song-query': (el, e) => {
    setLibrary({ query: el.value });
    if (!e.isComposing) search();
  },
};

// 搜尋條件歸位並重抓清單（順便拿到新上傳的歌）；關面板時 ui.js 也呼叫
export function clearLibraryFilters() {
  setLibrary({ query: '', category: '' });
  fetchedCategory = null;
  search();
}

function resetLibraryPicker() {
  setLibrary({ selectedId: '' });
  clearLibraryFilters();
}

function mountLibraryPicker() {
  fetchCategories().then(mergeCategories).finally(search);
}

// 歌曲下拉第一項的文字（有結果時帶首數）
function placeholderText(lib) {
  switch (lib.status) {
    case 'searching': return '搜尋中...';
    case 'error': return 'API 讀取失敗';
    case 'empty': return lib.category ? `在「${lib.category}」找不到，可改選全部類別` : '找不到符合條件的歌曲';
    case 'ready': return `請選擇歌曲（${lib.items.length} 首）`;
    default: return '請選擇歌曲';
  }
}
function songLabel(item) {
  const composer = item.composer ? ` - ${item.composer}` : '';
  return `${item.title || '未命名歌曲'}${composer}`;
}

let renderedCategories = null;
let renderedItems = null;
let renderedStatus = null;
function renderLibraryPicker({ player }) {
  const lib = player.library;
  if (lib.categories !== renderedCategories) {
    renderedCategories = lib.categories;
    categoryEl.replaceChildren(new Option('全部類別', ''), ...lib.categories.map((c) => new Option(c, c)));
  }
  if (categoryEl.value !== lib.category) categoryEl.value = lib.category;
  if (queryEl.value !== lib.query) queryEl.value = lib.query;

  if (lib.items !== renderedItems || lib.status !== renderedStatus) {
    renderedItems = lib.items;
    renderedStatus = lib.status;
    // hidden 而不只 disabled：只 disabled 的話展開時它會反白，看起來能選
    const placeholderOpt = new Option('', '');
    placeholderOpt.disabled = true;
    placeholderOpt.hidden = true;
    songSelectEl.replaceChildren(placeholderOpt, ...lib.items.map((item) => new Option(songLabel(item), String(item.id))));
  }
  const placeholder = placeholderText(lib);
  if (songSelectEl.options[0].text !== placeholder) songSelectEl.options[0].text = placeholder;
  // 目前的歌被篩掉時，第一個可選項是「目前：歌名」
  const inList = lib.items.some((item) => String(item.id) === lib.selectedId);
  const showCurrent = !!lib.selectedId && !inList && lib.status === 'ready';
  if (showCurrent) {
    const text = `目前：${player.songTitle}`;
    if (currentSongOpt.text !== text) currentSongOpt.text = text;
    if (currentSongOpt.value !== lib.selectedId) currentSongOpt.value = lib.selectedId;
    if (songSelectEl.options[1] !== currentSongOpt) songSelectEl.options[0].after(currentSongOpt);
  } else if (currentSongOpt.parentNode) {
    currentSongOpt.remove();
  }
  songSelectEl.disabled = lib.status !== 'ready';
  // 已選的歌不在清單就顯示 placeholder；用 selectedIndex 直接設（寫不存在的 value 會變成空白框，disabled 的 placeholder 也不會被自動選）
  if (inList) {
    if (songSelectEl.value !== lib.selectedId) songSelectEl.value = lib.selectedId;
  } else if (songSelectEl.selectedIndex !== 0) {
    songSelectEl.selectedIndex = 0;
  }
  // 鏡像文字給跑馬燈：原生下拉會截斷太長的歌名
  const shown = songSelectEl.selectedOptions[0]?.text ?? '';
  setMarqueeText(songMirrorEl, shown, songSelectEl.selectedIndex > 0 ? shown : '');
}

// 分譜清單每一列＝聲部名＋指派下拉（<template id="tpl-part-row">）。聲部名用 textContent（來自檔案，不當 HTML）；列只在 parts 或 playerCount 變了才重建。
const localInput = document.getElementById('localMidiInput');
const localFileName = document.getElementById('localMidiFileName');
const scorePartSection = document.getElementById('scorePartSection');
const scoreInfoText = document.getElementById('scoreInfoText');
const scorePartList = document.getElementById('scorePartList');
const partRowTemplate = document.getElementById('tpl-part-row');

const songPanelFields = {
  // 沒有檔案＝按了取消（有的瀏覽器會送 change）：不動目前的歌
  'local-file': (el) => {
    const file = el.files[0];
    if (!file) return;
    resetLibraryPicker();
    selectLocalFile(file);
  },
  'part-assign': (el) => assignPart(el.dataset.partId, el.value),
};

function buildPartRow(unit, playerCount, hint) {
  const row = partRowTemplate.content.firstElementChild.cloneNode(true);
  row.dataset.partId = unit.id;
  const notes = [];
  if (hint?.group) notes.push(`同組 ${hint.group}`);
  if (hint?.late != null) notes.push(`第 ${formatTime(hint.late)} 進入`);
  setMarqueeText(row.querySelector('.score-part-name'), notes.length ? `${unit.name}（${notes.join('・')}）` : unit.name);
  const select = row.querySelector('.score-part-id');
  select.dataset.partId = unit.id;
  select.append(new Option('無', ''), new Option('PC 鍵盤手', KEYBOARD_SLOT));
  for (let n = 1; n <= playerCount; n++) select.append(new Option(`演奏者 ${n}`, String(n)));
  return row;
}

function infoText({ score }) {
  if (!score) return '';
  const base = `${score.parts.length} 個聲部・${formatTime(score.durationSeconds)}・${Math.round(score.tempoMap[0].bpm)} BPM`;
  // 有「同組」時說明一次（每列只標字母）
  return [...partHints(score).values()].some((h) => h.group) ? `${base}。標「同組」的聲部音色與軌名相同，可能是同一個樂器，可以指派給同一個人` : base;
}

let renderedParts = null;
let renderedPlayerCount = -1;
function renderSongPanel({ player }) {
  const isLocal = player.source?.kind === 'local';
  const name = isLocal ? player.source.name : '';
  const shown = name || '未選擇檔案';
  setMarqueeText(localFileName, shown, name);
  // 來源不是本地檔就清掉檔案輸入，同一個檔才能再觸發 change
  if (!isLocal && localInput.value) localInput.value = '';

  scorePartSection.hidden = player.parts.length === 0;
  const text = infoText(player);
  if (scoreInfoText.textContent !== text) scoreInfoText.textContent = text;

  if (player.parts !== renderedParts || player.playerCount !== renderedPlayerCount) {
    renderedParts = player.parts;
    renderedPlayerCount = player.playerCount;
    const hints = partHints(player.score);
    scorePartList.replaceChildren(...assignmentUnits(player.parts).map((unit) => buildPartRow(unit, player.playerCount, hints.get(unit.id))));
  }
  for (const sel of scorePartList.querySelectorAll('.score-part-id')) {
    const assigned = player.assignments.get(sel.dataset.partId);
    const value = assigned === undefined ? '' : String(assigned);
    if (sel.value !== value) sel.value = value;
    sel.closest('.score-part-row').classList.toggle('is-mine', assigned !== undefined);
  }
}

export const actions = { ...transportActions };
export const fields = { ...songPanelFields, ...libraryFields };
export const inputs = { ...libraryInputs };
export function mount() {
  mountTransportPill();
  mountLibraryPicker();
}
export function render(snapshot) {
  renderTransportPill(snapshot);
  renderTopProgress(snapshot);
  renderSongPanel(snapshot);
  renderLibraryPicker(snapshot);
}
