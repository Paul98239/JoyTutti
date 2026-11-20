// synth.js — 兩個 spessasynth 合成器（電腦輔助 synth／真人 synthHuman）、humanGain 閘門＋音量凸顯、試聽（官方 Sequencer 的薄包裝 PreviewPlayer）。
// 演奏時合成器只收 scheduler.js 送來的事件；試聽用官方 Sequencer 走 synth，跟演奏互斥，任何一邊開始前都先 flushPreviousSong()。
// 真人聲部 velocity 用樂譜原值，靠 HUMAN_EMPHASIS_GAIN（> 1）突出；電腦輔助軌不掛 gain，是音量對比的基準。

import { Scheduler, CHANNELS_PER_PORT, DEFAULT_PORTS, portsNeeded } from '../performance/scheduler.js';
import { CC, DRUM_CHANNEL } from '../midi/midiParser.js';

// 試聽：位元組原樣交給官方 Sequencer 解析與排程（全在 worklet 裡），我們的 parser 失敗時仍可用、聽感也能跟演奏對照。
// 這裡只等載入結果（songChange／midiError／逾時／中斷）、提供最小控制、關掉循環播放。

const LOAD_TIMEOUT_MS = 8000;
const EVENT_ID = 'preview';

// 失敗一律帶 kind 供呼叫端分流：'parse'＝官方解析器拒絕、'timeout'＝官方沒回應、'aborted'＝被 stop()／下一次 start() 中斷（通常靜默處理）
const fail = (kind, message) => Object.assign(new Error(message), { kind });

export class PreviewPlayer {
  /**
   * @param {() => object} createSequencer  回傳一個新的官方 Sequencer（第一次 start() 才呼叫）
   * @param {{ loadTimeoutMs?: number }} [options]
   */
  constructor(createSequencer, { loadTimeoutMs = LOAD_TIMEOUT_MS } = {}) {
    this._create = createSequencer;
    this._timeoutMs = loadTimeoutMs;
    this._seq = null;
    this._loadCount = 0;
    this._abort = null;     // 正在等的那次載入的中斷函式；沒有在等就是 null
    this._active = false;   // 已載入並開始播放、還沒 stop()
  }

  get active() { return this._active; }
  get time() { return this._active ? this._seq.currentTime : 0; }
  get duration() { return this._active ? this._seq.duration : 0; }
  get finished() { return this._active && this._seq.isFinished; }

  // 載入並從頭播放。resolve 時已經開始播；失敗丟 kind＝parse／timeout／aborted 的 Error。
  async start(bytes) {
    this.stop(); // 上一次試聽（包含還在等的載入）先結束
    const seq = (this._seq ??= this._createSequencer());
    // 每次載入用不同檔名，晚到的舊 songChange 靠它擋掉（midiError 沒檔名，但解析失敗幾毫秒內就回來）
    const name = `preview-${++this._loadCount}`;
    // 先掛監聽再送出：結果可能一送出就回來
    const loaded = this._waitLoaded(seq, name);
    try {
      seq.loadNewSongList([{ binary: bytes, fileName: name }]);
    } catch (err) {
      this._abort(fail('parse', err.message)); // 連送出都失敗，當成解析失敗
    }
    await loaded;
    seq.play();
    this._active = true;
  }

  pause() { if (this._active) this._seq.pause(); }

  // 播完之後續播＝從頭（明講，不依賴官方行為）
  resume() {
    if (!this._active) return;
    if (this._seq.isFinished) this.restart();
    else this._seq.play();
  }

  // 先設時間再 play：不論暫停或播放中，都從第一個音重新開始
  restart() {
    if (!this._active) return;
    this._seq.currentTime = 0;
    this._seq.play();
  }

  // 中斷還在等的載入、暫停（官方會收掉發聲中的音）。可重複呼叫
  stop() {
    this._abort?.(fail('aborted', '試聽被中斷'));
    this._seq?.pause();
    this._active = false;
  }

  _createSequencer() {
    const seq = this._create();
    seq.loopCount = 0; // 試聽播完就該停：明確設成不循環，不依賴官方預設（4.3.14 是 -1＝無限，4.4.8 是 0）
    return seq;
  }

  _waitLoaded(seq, name) {
    return new Promise((resolve, reject) => {
      let timer = null;
      // 只認第一個結果，清掉監聽與計時器
      const settle = (err) => {
        clearTimeout(timer);
        seq.eventHandler.removeEvent('songChange', EVENT_ID);
        seq.eventHandler.removeEvent('midiError', EVENT_ID);
        if (this._abort === settle) this._abort = null;
        if (err) reject(err); else resolve();
      };
      seq.eventHandler.addEvent('songChange', EVENT_ID, ({ midiData }) => { if (midiData?.fileName === name) settle(); });
      seq.eventHandler.addEvent('midiError', EVENT_ID, (err) => settle(fail('parse', err?.message || '官方解析器拒絕這首 MIDI')));
      // 逾時：官方沒回 songChange 也沒回 midiError 時，不設上限會永遠卡在載入中（4.3.14 對長度 0 秒的 MIDI 就是這樣；4.4.8 會回應，逾時留著防其他沒有回應的情況）。
      timer = setTimeout(() => settle(fail('timeout', '官方播放器沒有回應')), this._timeoutMs);
      this._abort = settle;
    });
  }
}

// 音色庫：CDN 為主、本地為備（任一步失敗就換下一個），同一份 GeneralUser GS 2.0.3（逐位元相同）；CDN 釘在 SpessaSynth repo 的 commit 6f75050。
// 不用逾時當條件：GitHub Pages 載舊的 10.6MB（2.0.1）實測要 200 秒以上，慢不等於壞。
const SOUNDFONT_URLS = [
  'https://cdn.jsdelivr.net/gh/spessasus/SpessaSynth@6f75050/soundfonts/GeneralUserGS.sf3',
  './src/assets/GeneralUserGS.sf3',
];

// spessasynth_lib 從 jsDelivr 的 +esm 匯入；worklet 路徑直接拼（+esm 不是真實目錄，import.meta.resolve 推不出）。版本固定 4.4.8，兩個網址一起改（worklet 要跟套件同版）。
// 已知問題：4.4.0 的 addNewChannel() 每個新 channel 讓主執行緒丟 18 次 Uncaught TypeError（core 先 reset 新 channel 才發 channelAdded）；core 4.4.9 起改成先發 channelAdded 再 reset。
// 確切版本的 +esm 由 jsDelivr 第一次打包時固定相依版本（4.4.8 匯入 core 4.4.10），worklet 檔包著作者打包時的 core（4.4.8 的 worklet 檔已是 core 4.4.10 的行為）。
const LIB_ESM_URL = `https://cdn.jsdelivr.net/npm/spessasynth_lib@4.4.8/+esm`;
const WORKLET_URL = `https://cdn.jsdelivr.net/npm/spessasynth_lib@4.4.8/dist/spessasynth_processor.min.js`;

// WorkletSynthesizer 預設只有 16 個 channel，聲部多時會整段靜音（國旗歌 24 個旋律聲部實測重現）。同官方 Sequencer 用 addNewChannel() 補：開機補到 DEFAULT_PORTS，load() 依需要再補，只增不減。

const GATE_RAMP_TC = 0.03;   // humanGain on/off 的 setTargetAtTime 時間常數（防 click）
const HUMAN_EMPHASIS_GAIN = 1.2; // humanGain 開啟時的目標值；1.4 時真人實測高音太突出、蓋過電腦的低音，所以降到 1.2（約 +1.6 dB）

let audioCtx, synth, masterGain;
// synthHuman 經 humanGain（總開關，播放器決定、這裡只平滑切換）接到同一個 compressor
let synthHuman, humanGain;
let isReady = false;
let initPromise = null;
// 兩個合成器的 port 數（永遠一樣多），自己計數（見 channelCountOf()）
let portCount = DEFAULT_PORTS;
let isSongLoaded = false;
let isProcessingPlay = false;
let lastGateTarget = -1;
// SequencerClass 缺少只讓試聽不能用；PreviewPlayer 第一次試聽才建。previewUsed＝官方動過合成器狀態，下次 flush 要完整重設
let SequencerClass, previewPlayer = null, previewUsed = false;

export const scheduler = new Scheduler();

// 不能讀 s.midiChannels.length：addNewChannel() 要等 worklet 回 channelAdded 才 push（官方 JSDoc 與原始碼）；
// 對 worklet 沒有的 channel 送事件會 Uncaught TypeError（core 4.4.10 沒有範圍檢查）。所以自己計數
function channelCountOf(s) {
  return s ? portCount * CHANNELS_PER_PORT : CHANNELS_PER_PORT;
}

// 補到至少 ports 個 port（只增不減），要在送初始 patch 之前。補完不 reset（不需要，見 initEngine()）：reset 會切掉正在響的音
function ensurePorts(ports) {
  if (!synth || !synthHuman || ports <= portCount) return;
  for (const s of [synth, synthHuman]) {
    for (let i = portCount * CHANNELS_PER_PORT; i < ports * CHANNELS_PER_PORT; i++) s.addNewChannel();
  }
  portCount = ports;
  scheduler.setPortCount(portCount);
}
function isDrumChannelIndex(ch) {
  return ch % CHANNELS_PER_PORT === DRUM_CHANNEL;
}

export async function initEngine() {
  if (isReady) return true;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // 音色庫跟 lib、worklet 同時發出，立刻接手 index.html 的 preload：晚到 load 事件後約 4 秒 Chrome 會警告 preload 沒用到
    const firstSoundFont = fetch(SOUNDFONT_URLS[0]);
    firstSoundFont.catch(() => {}); // 失敗在下面處理並 warn；這裡只防 lib 先失敗、沒人 await 時變成 unhandled rejection
    try {
      const { WorkletSynthesizer, Sequencer } = await import(/* @vite-ignore */ LIB_ESM_URL);
      if (!WorkletSynthesizer) throw new Error('缺少必要匯出');
      SequencerClass = Sequencer;

      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      await audioCtx.audioWorklet.addModule(WORKLET_URL);

      // SynthConfig 不傳，全用預設值
      synth = new WorkletSynthesizer(audioCtx);
      synthHuman = new WorkletSynthesizer(audioCtx);
      scheduler.setSynths(synth, synthHuman);
      const compressor = audioCtx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.knee.value = 6;
      compressor.ratio.value = 2;
      compressor.attack.value = 0.005;
      compressor.release.value = 0.1;
      masterGain = audioCtx.createGain();
      // 音量固定，不提供拉桿（用電腦本機的音量調）
      masterGain.gain.value = 2.0;
      humanGain = audioCtx.createGain();
      humanGain.gain.value = 0; // 預設靜音，由 setHumanGate() 開
      synth.connect(compressor);
      synthHuman.connect(humanGain);
      humanGain.connect(compressor);
      compressor.connect(masterGain);
      masterGain.connect(audioCtx.destination);

      // 依序試來源。同 id 'main' 會取代前一個，只裝進一個合成器就失敗時不會留下混版本
      let lastErr;
      for (const url of SOUNDFONT_URLS) {
        try {
          const res = await (url === SOUNDFONT_URLS[0] ? firstSoundFont : fetch(url));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const sfBuf = await res.arrayBuffer();
          // addSoundBank 可能把 ArrayBuffer transfer 掉，先複製一份給第二個合成器
          const sfBufHuman = sfBuf.slice(0);
          await synth.soundBankManager.addSoundBank(sfBuf, 'main');
          await synthHuman.soundBankManager.addSoundBank(sfBufHuman, 'main');
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          console.warn(`SoundFont 載入失敗（${url}）`, err);
        }
      }
      if (lastErr) throw new Error(`SoundFont 所有來源都失敗：${lastErr.message}`);
      if (synth.isReady) await synth.isReady;
      if (synthHuman.isReady) await synthHuman.isReady;

      // 補到 DEFAULT_PORTS，放在音色庫載入之後：新 channel 一建立就查預設音色（core 4.4.10 的 createMIDIChannelInternal() 立刻 reset，裡面有 programChange）
      portCount = DEFAULT_PORTS;
      scheduler.setPortCount(portCount);
      // 補完不必 reset：core 4.4.10 建 channel 時就是 GM 配置；測試瀏覽器 getSnapshot() 比對有無 reset，64 個 channel 完全相同
      for (const s of [synth, synthHuman]) {
        for (let i = CHANNELS_PER_PORT; i < portCount * CHANNELS_PER_PORT; i++) s.addNewChannel();
      }

      isReady = true;
      return true;
    } catch (err) {
      console.error('❌ MIDI 引擎初始化失敗', err);
      // 收掉這次的 AudioContext：按播放會重試，瀏覽器對同時存在的數量有上限（Chrome 約 6 個）
      try { await audioCtx?.close(); } catch (e) { /* 已經關掉或根本沒建起來 */ }
      audioCtx = undefined;
      synth = undefined;
      synthHuman = undefined;
      scheduler.setSynths(null, null);
      masterGain = undefined;
      humanGain = undefined;
      isReady = false;
      return false;
    } finally { initPromise = null; }
  })();
  return initPromise;
}

// 換歌／換指派／進出試聽前的清場：收掉排程器、試聽與殘響，bank／program 歸零（bank 歸零只送旋律 channel：鼓組 channel 的 program 是鼓組編號，不是旋律音色）。
// CC120／121／123 每個 channel 都送，鼓組 channel 也是：MIDI 1.0 的 channel mode 訊息對所有 channel 有效；core 4.4.10 的 CC121 只重設 RP-015 那幾個控制器，
// CC120／123 只停音，都不動 bank、program 與打擊設定（core 的 controller_change.ts、resetRP15()）。
export function flushPreviousSong() {
  scheduler.stop();
  previewPlayer?.stop();
  isSongLoaded = false;
  // 官方 Sequencer 會依那首歌改各 channel 的狀態；離開試聽時整個重設，演奏才不會繼承
  if (previewUsed && synth) { synth.reset(); previewUsed = false; }
  for (const s of [synth, synthHuman]) {
    if (!s) continue;
    for (let ch = 0; ch < channelCountOf(s); ch++) {
      if (!isDrumChannelIndex(ch)) {
        s.controllerChange(ch, CC.BANK_MSB, 0);
        s.controllerChange(ch, CC.BANK_LSB, 0);
      }
      s.controllerChange(ch, CC.ALL_SOUND_OFF, 0);
      s.controllerChange(ch, CC.RESET_ALL, 0);
      s.controllerChange(ch, CC.ALL_NOTES_OFF, 0);
    }
  }
}

// 載入（不發聲，播放另外 play()）。assignments 是 [partId, 演奏者槽位][] 快照
export async function load(score, assignments) {
  if (!isReady) {
    const ok = await initEngine();
    if (!ok) throw new Error('音源庫載入失敗');
  }
  flushPreviousSong();
  ensurePorts(portsNeeded(score, assignments)); // 要在送初始 patch 之前
  scheduler.load(score, assignments);
  isSongLoaded = true;
}

// 播放中（含暫停）改指派：從目前位置接續；port 不夠先補，初始狀態由 reassign() 送
export function reassign(score, assignments) {
  if (!isSongLoaded) return;
  ensurePorts(portsNeeded(score, assignments));
  scheduler.reassign(assignments);
}

export async function play() {
  if (isProcessingPlay || !isSongLoaded) return;
  isProcessingPlay = true;
  try {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    scheduler.play();
  } finally { isProcessingPlay = false; }
}
// 從頭重播（重播鍵、播完後按 ▶）
export async function restart() {
  if (isProcessingPlay || !isSongLoaded) return;
  isProcessingPlay = true;
  try {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    scheduler.restart();
  } finally { isProcessingPlay = false; }
}
export function pause() {
  scheduler.pause();
}
// lookahead 時間戳的時鐘（eventOptions.time 就是它）；沒在跑時 undefined，排程器就不帶時間戳
export function audioNow() { return audioCtx?.state === 'running' ? audioCtx.currentTime : undefined; }
// devStats.js 的 __stats() 用：音訊這一段的延遲。都是瀏覽器／驅動的估計值（藍牙耳機常不準），沒提供的欄位是 null
export function audioLatencyInfo() {
  if (!audioCtx) return null;
  // 秒 → ms（一位小數）；非數字轉 null，免得加總變 NaN
  const toMs = (sec) => (Number.isFinite(sec) ? Math.round(sec * 10000) / 10 : null);
  const ts = audioCtx.getOutputTimestamp?.();
  return {
    狀態: audioCtx.state,
    取樣率Hz: audioCtx.sampleRate,
    // worklet 一次處理 128 個取樣（render quantum）：事件送進去後要等到下一個區塊才被處理，平均半個、最多一個
    渲染區塊ms: toMs(128 / audioCtx.sampleRate),
    內部延遲ms: toMs(audioCtx.baseLatency),     // 音訊圖內部處理與緩衝
    輸出延遲ms: toMs(audioCtx.outputLatency),   // 送出到實際出聲（作業系統＋硬體）
    // currentTime − 此刻正在輸出的時間＝渲染到輸出的落差，對照 outputLatency
    輸出時間戳落後ms: audioCtx.state === 'running' && ts ? toMs(audioCtx.currentTime - ts.contextTime) : null,
  };
}
export function isLoaded() { return isSongLoaded; }
export function isPaused() { return !isSongLoaded || !scheduler.isPlaying(); }
export function isFinished() { return isSongLoaded && scheduler.isFinished(); }

// 開始試聽（官方自己解析）。失敗丟帶 kind 的 Error（engine＝引擎沒就緒，其餘見 PreviewPlayer），resolve 時已在播
const engineError = (message) => Object.assign(new Error(message), { kind: 'engine' });
export async function startPreview(bytes) {
  if (!isReady && !(await initEngine())) throw engineError('音源引擎載入失敗');
  if (!SequencerClass) throw engineError('音源引擎缺少 Sequencer');
  flushPreviousSong();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  previewPlayer ??= new PreviewPlayer(() => new SequencerClass(synth));
  previewUsed = true;
  await previewPlayer.start(bytes);
}
export function pausePreview() { previewPlayer?.pause(); }
// await 期間若換歌（試聽已 stop），PreviewPlayer 會忽略這次續播
export async function resumePreview() {
  if (audioCtx?.state === 'suspended') await audioCtx.resume();
  previewPlayer?.resume();
}
export async function restartPreview() {
  if (audioCtx?.state === 'suspended') await audioCtx.resume();
  previewPlayer?.restart();
}
export function previewTime() { return previewPlayer?.time ?? 0; }
export function previewDuration() { return previewPlayer?.duration ?? 0; }
export function isPreviewFinished() { return previewPlayer?.finished ?? false; }

// humanGain 總開關兼音量凸顯：播放器決定開關，這裡平滑切換、去重
export function setHumanGate(on) {
  if (!audioCtx || !humanGain) return;
  const target = on ? HUMAN_EMPHASIS_GAIN : 0;
  if (target === lastGateTarget) return;
  lastGateTarget = target;
  humanGain.gain.setTargetAtTime(target, audioCtx.currentTime, GATE_RAMP_TC);
}
