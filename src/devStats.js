// devStats.js — 開發用量測：DevTools console 的 __stats()／__pressLog()／__visionLog()／__latency()。main.js 只為了副作用 import 這個檔案。
// 專案正式完成時移除：刪掉這個檔案、main.js 的那一行 import、index.html 的那一行 modulepreload。

import * as midiPlayer from './player/midiPlayer.js';
import { visionLog, visionFrameStats, getCameraInfo } from './vision/vision.js';
import { getInputDelays } from './input/keyboard.js';
import { summarizeMs } from './performance/tempo.js';

// __stats() 只量 JS 層，音訊段由「音訊輸出」補上，「估計按下到出聲ms」把整條路串起來。
window.__stats = () => {
  const audio = midiPlayer.audioLatency();
  const keyWaits = getInputDelays();
  // 固定音訊段＝worklet 平均等半個渲染區塊＋內部延遲＋輸出延遲；瀏覽器沒提供的欄位（null）算 0，所以是下限
  const audioFixedMs = audio ? Math.round(((audio.渲染區塊ms ?? 0) / 2 + (audio.內部延遲ms ?? 0) + (audio.輸出延遲ms ?? 0)) * 10) / 10 : null;
  return {
    速度倍率: Math.round(midiPlayer.playbackRate() * 1000) / 1000,
    速度範圍: (({ lo, hi }) => ({ 下限: Math.round(lo * 1000) / 1000, 上限: Math.round(hi * 100) / 100 }))(midiPlayer.rateBounds()),
    電腦音遲到ms: midiPlayer.lateStats(),
    早按處理: midiPlayer.chaseStats(),
    合奏: midiPlayer.ensembleStats(),
    按鍵事件等待ms: summarizeMs(keyWaits),
    音訊輸出: audio,
    估計按下到出聲ms: audioFixedMs === null ? null : { 固定音訊段ms: audioFixedMs, ...summarizeMs(keyWaits.map((x) => x + audioFixedMs)) },
  };
};

window.__pressLog = midiPlayer.pressLog;

// __tryMode()：dev 開關（scheduler.js 的 cfg.modes，預設全關）。__tryMode('keyboard', { oneSlice: true }) 改 PC 鍵盤手那組、'gesture' 改揮手那組，回傳改完的開關。
//   oneSlice：一下推進一個垂直切片（近距起音分組只留和弦內的時間差，不做按不及）；holdToNext：讀法 B，他的音一律響到他的下一個起音（鍵盤開了就不再用放開鍵收音）。
// 播放中（含暫停）改的話從目前位置接續生效；其他狀態下一次 ▶ 重新載入時生效。重新整理頁面就回到預設。
window.__tryMode = (source, patch) => (source === undefined ? midiPlayer.devModes() : midiPlayer.setDevModes(source, patch ?? {}));

// copy(__visionLog())：這一段演奏（從頭播起，暫停與曲終不記）的逐幀紀錄（兩手手腕、脖子以下節點的原始／world／平滑座標與 presence、偵測、鎖定的手、推論耗時）與追蹤層的鎖定／釋放事件，
// 查手點互相干擾與多出來的 ID 用；__visionLog(15) 只取最後 15 秒。先按 ❚❚ 再切 DevTools 打指令，打字的那段就不會記進去。
window.__visionLog = visionLog;

// 長任務（主執行緒連續忙 50ms 以上，這段時間按鍵與按鈕都沒反應）：[開始時刻, 長度]，__latency() 依時刻歸到當時的現場人數。Firefox 沒有這個 API，記 null。
const longTasks = PerformanceObserver.supportedEntryTypes?.includes('longtask') ? [] : null;
if (longTasks) {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTasks.push([e.startTime, e.duration]);
    if (longTasks.length > 5000) longTasks.splice(0, 2500);
  }).observe({ type: 'longtask', buffered: true });
}

// __latency()：不同「現場人數」下的推論與主執行緒負擔。每個人數一組：推論（detectForVideo，在 Worker）耗時與佔 Worker 的比例、偵測器有跑／只追蹤分開的推論耗時、
// 主執行緒處理每幀的耗時與佔比、攝影機拍下→送出、拍下→結果進主執行緒、長任務、排程 tick 的實際間隔（超過 LOOKAHEAD_MS 的次數越多，電腦音越可能來不及提早帶時間戳送進 worklet）；
// 鏡頭規格與音訊輸出那一段（輸出延遲、worklet 渲染區塊）跟人數無關，各附一份。
// 流程：選人數 → 開鏡頭、播放彈 20～30 秒 → 換下一個人數（同一段演奏裡換：從頭播會清空逐幀紀錄），最後 copy(__latency())。排程 tick 與逐幀紀錄都只在播放中記錄。
window.__latency = () => {
  const { byCount, segments } = visionFrameStats();
  const ticks = midiPlayer.tickIntervals();
  const round1 = (x) => Math.round(x * 10) / 10;
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const result = {};
  for (const [count, g] of Object.entries(byCount)) {
    const mine = segments.filter((s) => s.count === Number(count));
    const seconds = mine.reduce((acc, s) => acc + (s.to - s.from), 0) / 1000;
    const spanMs = mine.reduce((acc, s) => acc + (s.end - s.from), 0);
    const tickMs = ticks.filter(([t]) => mine.some((s) => t >= s.from && t <= s.to)).map(([, dt]) => dt);
    const taskMs = longTasks?.filter(([t]) => mine.some((s) => t >= s.from && t <= s.end)).map(([, ms]) => ms);
    result[`現場人數 ${count}`] = {
      秒數: round1(seconds),
      幀數: g.frames,
      幀率: seconds > 0 ? round1(g.frames / seconds) : null,
      平均在場人數: round1(g.present / g.frames),
      推論ms: summarizeMs(g.detectMs),
      '推論ms（偵測器有跑）': summarizeMs(g.detectWithDetector),
      '推論ms（只追蹤）': summarizeMs(g.detectTrackingOnly),
      '推論佔比%': spanMs > 0 ? round1((sum(g.detectMs) / spanMs) * 100) : null,
      整幀ms: summarizeMs(g.frameMs),
      '主執行緒佔比%': spanMs > 0 ? round1((sum(g.frameMs) / spanMs) * 100) : null,
      拍下到處理ms: summarizeMs(g.captureLagMs),
      拍下到結果ms: summarizeMs(g.resultLagMs),
      長任務: taskMs ? { 次數: taskMs.length, 最長ms: round1(Math.max(0, ...taskMs)), 總ms: round1(sum(taskMs)) } : null,
      排程tick間隔ms: { ...summarizeMs(tickMs), [`超過${midiPlayer.LOOKAHEAD_MS}ms`]: tickMs.filter((x) => x > midiPlayer.LOOKAHEAD_MS).length },
    };
  }
  result.鏡頭 = getCameraInfo();
  result.音訊輸出 = midiPlayer.audioLatency();
  return result;
};
