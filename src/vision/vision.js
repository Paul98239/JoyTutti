// vision.js — 攝影機、骨架繪製、姿勢模型生命週期（攝影機畫面不顯示，只當推論來源）；逐幀呼叫追蹤（tracking.js）與手勢（gesture.js），送出手勢狀態（main.js 註冊 input/gestureTrigger.js 接收）

import { PersonTracker, buildDetection } from "./tracking.js";
import {
  MP_LEFT_WRIST, MP_RIGHT_WRIST, MP_LEFT_ELBOW, MP_RIGHT_ELBOW, MP_LEFT_SHOULDER, MP_RIGHT_SHOULDER,
  updateGestures, resetGestures,
} from "./gesture.js";

const CONFIG = {
  // 解析度與幀率的上限（getUserMedia 用 max）：外接鏡頭原生常是 1080p60，每幀多搬四倍像素、一秒推論 60 次，多數機器跟不上；超出時 console 警告
  width: 854,
  height: 480,
  frameRate: 30,
  maxUsers: 4, // 最多鎖定並顯示的目標人數
};

// 只用 lite 模型（最快、抖動最明顯，但夠用）。Google storage 的 /1/ 是釘死的版本（跟本地副本逐位元相同），實測比 GitHub Pages 快得多（0.6 秒 vs 100 秒以上）；
// CDN 失敗（網路、HTTP、斷線、檔案壞）才改載本地，不用逾時當條件——慢不等於壞。
const POSE_MODEL_URLS = [
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  "./src/assets/pose_landmarker_lite.task",
];
let poseModelIndex = 0; // Worker 回報的目前來源（POSE_MODEL_URLS 的索引）；改用本地之後 warmPoseModel() 不再暖 CDN

// 暖機：開機完成後用低優先序 fetch 把模型（約 5.8MB）抓進 HTTP 快取（max-age=3600），第一次選現場人數時直接命中；開機完成才叫，不跟 8.4MB 的音色庫搶頻寬。
// 不用 <link rel="preload">：幾秒內沒用掉 Chrome 會警告。失敗不處理：真的載入時會走備援並 warn。
export function warmPoseModel() {
  if (poseModelIndex !== 0) return;   // 已改用本地副本，不必暖 CDN
  fetch(POSE_MODEL_URLS[0], { priority: "low" }).then((r) => r.arrayBuffer()).catch(() => {});
}

// numPoses 決定 MediaPipe 的模式：追到的人數 ≥ numPoses 時跳過偵測器、ROI 由上一幀延續（沒有幽靈、節點最穩）；< numPoses 時每幀重跑偵測器，幽靈與抖動都出在這裡。
// landmarker 在 Worker 裡只有一份：選了現場人數 N 才建 numPoses=N，之後用 setOptions() 原地改；追蹤層槽位數也設成 N。
// 放 Worker：detectForVideo 是同步的、會卡住呼叫它的執行緒（官方文件），放主執行緒時按鍵與伴奏排程都要排隊等它。

// 4 人的代表色彩（依鎖定槽位對應）：藍綠、紅、白、淡紫，四種色相口頭上好區分（使用者選定）。
// 一般色覺、Machado 2009 三種色覺模擬與 75 歲水晶體近似（Pokorny 1987）下：兩兩色差（CIEDE2000）至少 16.9、跟琥珀 --accent 至少 13.9；
// 對舞台最亮與最暗處至少 3.05:1（紅，年長者近似下；WCAG 非文字元件 3:1，剛好過，要實機確認）。色差門檻沒有規格值，取候選裡最差情況最大的。
// 公開的色覺友善色盤（Okabe & Ito、ColorBrewer）是為白底設計的，原色在這個深色暖底＋琥珀 UI 上都比這組差。
const POSE_COLORS = ["#40B696", "#F65560", "#FFFFFF", "#B8B8FF"];
// 骨架粗細跟著人在畫面上的大小縮放（sc＝track.scale × 畫面寬，px）；下面兩個是人很小時的下限（px）
const BONE_WIDTH = 2;      // 骨架實線寬度的下限
const JOINT_RADIUS = 2;    // 關節圓點半徑的下限
const BONE_WIDTH_RATIO = 0.035;   // 實線寬度＝sc × 這個比例
const JOINT_RADIUS_RATIO = 0.9;   // 關節半徑＝實線寬度 × 這個比例
const SCALE_MIN_PX = 20;          // sc 的下限（px）：剛鎖定、尺度還很小時不讓頭與線縮成一點
// 骨頭先畫寬而淡的光暈再畫實線（不用 shadowBlur：逐像素模糊，每幀很貴）。以下數字是外觀選擇（docs/JoyTutti_doc/視覺參考-骨架-頂端UI-背景.md），沒有量測依據
const GLOW_WIDTH_RATIO = 2.6;     // 光暈寬度＝實線寬度 × 這個比例
const GLOW_ALPHA = 0.16;
const HEAD_RADIUS = 0.32;         // 頭的圓（鼻子為中心）半徑＝sc × 這個比例
const HEAD_FILL_ALPHA = 0.14;
const TAU = Math.PI * 2;
// 光暈與頭的填色先組好字串，不在每幀拼
const rgbaOf = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
const POSE_GLOW_COLORS = POSE_COLORS.map((c) => rgbaOf(c, GLOW_ALPHA));
const POSE_HEAD_FILLS = POSE_COLORS.map((c) => rgbaOf(c, HEAD_FILL_ALPHA));

const FRAME_ERROR_THRESHOLD = 90; // 連續幾幀失敗才當持續性錯誤、顯示錯誤畫面（約 1.5～3 秒）

// let：槽位數跟現場人數走，applyPoseCount 會重建
let tracker = new PersonTracker({ maxUsers: CONFIG.maxUsers });

// 手勢狀態（gesture.js 的 updateGestures()）每幀經 setPerformanceStateListener 的回呼送出
const EMPTY_PERFORMANCE_STATE = { arcTriggerSeqBySlot: {}, arcTroughMsBySlot: {}, presentSlots: [] };

let performanceStateListener = null;
let lastSentState = null;
let lastEmitMs = 0;            // 上一次送出的時刻（心跳用）
// 接收端的斷訊看門狗門檻要明顯大於這個心跳間隔
const EMIT_HEARTBEAT_MS = 100;

// 逐幀紀錄（開發用，__visionLog() 匯出；也是 __latency() 的幀耗時來源）：手點互相干擾、幽靈 ID 這類問題要逐幀原始資料才查得出來。
// 每幀一列，滿了一次丟最舊的八分之一（免得每筆 shift()）。只記演奏中：停下來打 DevTools 指令時打字的手不會混進來。
const FRAME_LOG_MAX = 20000;       // 30fps 約 11 分鐘
const TRACKER_EVENT_LOG_MAX = 3000;
let frameLog = [];
let trackerEvents = [];
let frameLogRecording = false;
const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => (v === null || v === undefined ? null : Math.round(v * 1000) / 1000);
const r4 = (v) => (v === null || v === undefined ? null : Math.round(v * 10000) / 10000);
// 「節點」欄記脖子以下 22 點（11～32；v4／v5 只到 24）：調過濾器與尺度用，也留給之後的肢體動作。
// 不依 presence 篩：猜出來的點正是量門檻要的資料
const LOG_JOINTS = Array.from({ length: 22 }, (_, i) => 11 + i);

// 33 點外框的 (寬＋高) ÷ 2，參考用：MediaPipe 平滑用的是推論框（landmarks_smoothing_calculator.cc 的 OBJECT_SCALE_ROI），拿不到
function landmarkBoxScale(lm) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of lm) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return (maxX - minX + maxY - minY) / 2;
}

function jointRow(track) {
  const { raw, rawWorld, smoothed } = track;
  return [
    track.slot + 1, r3(landmarkBoxScale(raw)),
    ...LOG_JOINTS.flatMap((j) => [r3(raw[j].x), r3(raw[j].y), r3(raw[j].visibility)]),
    ...LOG_JOINTS.flatMap((j) => (rawWorld ? [r4(rawWorld[j].x), r4(rawWorld[j].y), r4(rawWorld[j].z)] : [null, null, null])),
    ...LOG_JOINTS.flatMap((j) => [r3(smoothed[j].x), r3(smoothed[j].y)]),
    ...LOG_JOINTS.map((j) => r3(raw[j].presence)),
  ];
}

function recordFrame(ts, startMs, detectMs, rawCount, detections, activeTracks, gestureRows, captureLagMs, detectorRan, resultLagMs) {
  const events = tracker.drainEvents();   // 不記的時候也要取走，不然追蹤層的事件一直累積
  if (!frameLogRecording) return;
  const rawBySlot = new Map(activeTracks.map((t) => [t.slot + 1, t.raw]));
  const wrist = (raw, i) => (raw ? [r3(raw[i].x), r3(raw[i].y), r3(raw[i].visibility)] : [null, null, null]);
  frameLog.push([
    Math.round(ts), chosenPoseCount, rawCount, r1(detectMs), r1(performance.now() - startMs),
    detections.map((d) => [r3(d.centroid.x), r3(d.centroid.y), r3(d.scale), r3(d.meanVisibility), d.strictPlausible ? 1 : 0]),
    gestureRows.map(([id, sw, lx, ly, rx, ry, lock, seq]) => {
      const raw = rawBySlot.get(id);
      return [id, r3(sw), r3(lx), r3(ly), r3(rx), r3(ry), lock, seq, ...wrist(raw, MP_LEFT_WRIST), ...wrist(raw, MP_RIGHT_WRIST)];
    }),
    captureLagMs === null ? null : r1(captureLagMs), detectorRan, resultLagMs === null ? null : r1(resultLagMs),
    activeTracks.map(jointRow),
  ]);
  if (frameLog.length > FRAME_LOG_MAX) frameLog.splice(0, frameLog.length - (FRAME_LOG_MAX - (FRAME_LOG_MAX >> 3)));
  trackerEvents.push(...events);
  if (trackerEvents.length > TRACKER_EVENT_LOG_MAX) trackerEvents.splice(0, trackerEvents.length - (TRACKER_EVENT_LOG_MAX - (TRACKER_EVENT_LOG_MAX >> 3)));
}

// 播放中才記；clearFrameLog() 在從頭播時清空，跟按鍵紀錄同一個起點
export function setFrameLogRecording(on) { frameLogRecording = on; }
export function clearFrameLog() { frameLog = []; trackerEvents = []; }

// 匯出逐幀紀錄與追蹤層事件（seconds：只取最後 seconds 秒）；欄位說明附在資料裡
export function visionLog(seconds = null) {
  const from = seconds === null ? -Infinity : (frameLog.at(-1)?.[0] ?? 0) - seconds * 1000;
  return {
    version: 7,
    exportedAt: new Date().toISOString(),
    seconds,
    poseCount: chosenPoseCount,
    cameraOn: cameraState === "on",
    video: { w: video.videoWidth || CONFIG.width, h: video.videoHeight || CONFIG.height },
    columns: {
      frame: ["t（送去推論的時刻；沒推論時是處理時刻；performance.now，ms）", "現場人數", "MediaPipe 偵測筆數", "推論ms（在 Worker）", "主執行緒處理ms",
        "偵測[[肩中點 x, y, 尺度（v3 以前是肩寬）, 平均可見度, 嚴格可信 0/1]]",
        "追蹤[[ID, 尺度, 左手腕 x, y, 右手腕 x, y（平滑後，手腕不可見是 null；v3 以前是肩寬與手腕＋手掌合併點）, 這一幀算數的觸發是哪隻手（left／right／both／null；v6 以前是鎖定的手）, 累加計數, 原始左腕 x, y, 可見度, 原始右腕 x, y, 可見度]]",
        "拍下→送出ms（rVFC 的 captureTime；瀏覽器沒提供是 null）", "偵測器可能有跑（上一次偵測筆數 < numPoses 是 1，否則 0；沒推論是 null）",
        "拍下→結果進主執行緒ms（沒有拍下時刻時從送出算起；沒推論是 null）",
        `節點[[ID, 33 點外框尺度（參考用，不是 MediaPipe 平滑的尺度）, 原始 x, y, 可見度 ×${LOG_JOINTS.length} 點, world x, y, z（公尺）×${LOG_JOINTS.length} 點, 平滑後 x, y ×${LOG_JOINTS.length} 點, 原始 presence ×${LOG_JOINTS.length} 點（v5 起；在畫面範圍內的機率，模型沒給是 null）]]，點依序是 ${LOG_JOINTS.join(",")}（v6 起；v4／v5 是 11～24）`],
      trackerEvent: "{ t, type: lock｜loss｜duplicate, slot（ID）；lock 另有 scale 尺度、vis 平均可見度、strict }",
    },
    frames: frameLog.filter((f) => f[0] >= from),
    trackerEvents: trackerEvents.filter((e) => e.t >= from),
  };
}

// 依現場人數分組的幀耗時（__latency() 用）。segments＝同一人數連續的時段（幀間隔 > 1 秒就斷開），排程 tick 的間隔靠它歸到人數。
// end＝段內最後一幀處理完的時刻下限：佔比的分母算到這裡，不會超過 100%
export function visionFrameStats() {
  const byCount = {}, segments = [];
  for (const [t, count, , detectMs, frameMs, , tracks, captureLagMs, detectorRan, resultLagMs] of frameLog) {
    if (!count) continue;
    const g = (byCount[count] ??= { frames: 0, detectMs: [], frameMs: [], present: 0, detectWithDetector: [], detectTrackingOnly: [], captureLagMs: [], resultLagMs: [] });
    g.frames++; g.detectMs.push(detectMs); g.frameMs.push(frameMs); g.present += tracks.length;
    if (detectorRan === 1) g.detectWithDetector.push(detectMs);
    else if (detectorRan === 0) g.detectTrackingOnly.push(detectMs);
    if (captureLagMs !== null) g.captureLagMs.push(captureLagMs);
    if (resultLagMs !== null) g.resultLagMs.push(resultLagMs);
    const end = t + detectMs + frameMs;
    const last = segments.at(-1);
    if (last && last.count === count && t - last.to < 1000) { last.to = t; last.end = end; }
    else segments.push({ count, from: t, to: t, end });
  }
  return { byCount, segments };
}

export const getCameraInfo = () => cameraInfo;

function performanceStatesDiffer(a, b) {
  if (!a || !b) return true;
  if (a.presentSlots.length !== b.presentSlots.length) return true;
  for (let i = 0; i < a.presentSlots.length; i++) {
    if (a.presentSlots[i] !== b.presentSlots[i]) return true;
  }
  // 觸發序號的任何變動都是新的一下，一定要送
  for (let id = 1; id <= CONFIG.maxUsers; id++) {
    if ((a.arcTriggerSeqBySlot[id] || 0) !== (b.arcTriggerSeqBySlot[id] || 0)) return true;
  }
  return false;
}

// 有變化才送，但至少每 EMIT_HEARTBEAT_MS 送一次：「沒有變化」跟「沒有訊號」是兩件事，接收端的看門狗才只在真的沒幀時觸發
function emitGesturePerformanceState(state, nowMs) {
  const heartbeatDue = nowMs - lastEmitMs >= EMIT_HEARTBEAT_MS;
  if (!heartbeatDue && !performanceStatesDiffer(state, lastSentState)) return;
  lastSentState = state;
  lastEmitMs = nowMs;
  if (performanceStateListener) {
    try { performanceStateListener(state); }
    catch (e) { console.warn("⚠️ 手勢狀態監聽者拋錯", e); }
  }
}

// rVFC 只在新幀到達時觸發（比 rAF 輪詢省也準）；不支援時降級為 rAF
const useRVFC = "requestVideoFrameCallback" in HTMLVideoElement.prototype;

const video = document.getElementById("webcam");
const overlayCanvas = document.getElementById("overlay-canvas");
const ctx2d = overlayCanvas.getContext("2d");

// 載入狀態與錯誤畫面經 startVision() 的回呼交給 ui.js 畫
let onStatus = null;
let onError = null;
const stageHint = document.getElementById("stage-hint"); // 舞台中央的提示（攝影機關閉／還沒選現場人數）

let poseWorker = null;          // 姿勢推論的 Worker（startPoseWorker()）；null ＝ 還沒載入
let landmarkerReady = false;    // Worker 裡的 landmarker 建好了（第一次選人數之後）
let inFlight = null;            // 送進 Worker、還沒拿到結果的那一張：{ ts, captureTime, captureLagMs, detectorRan }；同一時間只送一張
let pendingFrame = null;        // 等結果期間又來的新畫面（只記最新一張的拍下時刻）：結果一回來就送，不等下一次 rVFC
let configureSeq = 0;           // 換人數的請求編號：等待期間又選了別的人數，舊的這次不算數
const pendingCalls = new Map(); // Worker 請求編號 → { resolve, reject }
let consecutiveFrameErrors = 0; // 連續幀處理失敗計數，超過 FRAME_ERROR_THRESHOLD 才視為持續性錯誤
let lastProcessedVideoTime = -1; // 上一次真的送去推論的 video.currentTime（rAF 降級路徑用來跳過重複幀）
let currentPoseCount = 0; // 目前使用中的 landmarker 的 numPoses；0 ＝ 還沒建過任何一份
let chosenPoseCount = 0;  // 系統控制 bar 選的「現場人數」；0 ＝ 還沒選 ＝ 不推論
let lastRawCount = 0;     // 上一次的偵測筆數：< numPoses 時下一幀會重跑偵測器（pose_landmarker_graph.cc），逐幀紀錄據此標記
// 下一張改送空白畫面（重置骨架 ID、鏡頭重開時）：人數夠了 MediaPipe 就不再找人；空白畫面讓它追丟、下一張重跑偵測器，等同用手遮一下鏡頭
let forgetTracking = false;
let cameraInfo = null;    // describeCamera() 的結果（__latency 用）

// frameHandle：已排程的下一幀（id ≥ 1，0＝沒有）。isLoopStopped：迴圈已停；排隊中的回呼另外會取消，旗標是第二道防線
let frameHandle = 0;
let isLoopStopped = true;

let cameraStream = null;          // 開啟中的 MediaStream；null ＝ 關閉
let cameraState = "off";          // "off" | "starting" | "on" | "stopping"
let cameraOffReason = "";         // 關閉時舞台提示的文字；"" ＝ 使用者主動關閉（顯示預設文字）
let cameraOp = Promise.resolve(); // start／stop／ended 序列化用的 promise 鏈
let cameraStateListener = null;

// 畫布尺寸跟著視訊尺寸（推論座標是 0～1）；裁切由 CSS 的 object-fit:cover 處理
function syncCanvasSize() {
  const vw = video.videoWidth || CONFIG.width;
  const vh = video.videoHeight || CONFIG.height;
  if (overlayCanvas.width !== vw || overlayCanvas.height !== vh) {
    overlayCanvas.width = vw;
    overlayCanvas.height = vh;
  }
}

function isFacePoint(i) { return i >= 0 && i <= 10; }

// 兩肩中點當虛擬「脖子」節點——MediaPipe Pose 沒有脖子 landmark。
function virtualNeckPoint(lm) {
  const ls = lm[MP_LEFT_SHOULDER], rs = lm[MP_RIGHT_SHOULDER];
  if (!(ls.visible ?? true) || !(rs.visible ?? true)) return null;
  return { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
}

// 只畫手臂鏈（肩-肘-腕-手掌）＋頭一個圓：下半身沒有被手勢或播放用到。手照 MediaPipe 的 POSE_CONNECTIONS 手部那幾條
const ARM_CONNECTIONS = [
  [MP_LEFT_SHOULDER, MP_LEFT_ELBOW], [MP_RIGHT_SHOULDER, MP_RIGHT_ELBOW],
  [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
];
const ARM_JOINTS = [MP_LEFT_SHOULDER, MP_RIGHT_SHOULDER, MP_LEFT_ELBOW, MP_RIGHT_ELBOW, 15, 16, 17, 18, 19, 20, 21, 22];
const MP_NOSE = 0;

// 依槽位上色。每人四次繪圖：骨頭光暈 → 頭的填色 → 骨頭實線＋頭外框（同一條 Path2D）→ 關節
function renderSkeletonOverlay(activeTracks) {
  const W = overlayCanvas.width;
  const H = overlayCanvas.height;

  ctx2d.clearRect(0, 0, W, H);
  if (activeTracks.length === 0) return;

  ctx2d.save();
  ctx2d.translate(W, 0);
  ctx2d.scale(-1, 1); // 水平鏡像：演奏者看骨架像照鏡子（左手在畫面左邊）
  ctx2d.lineCap = "round";   // 光暈線很寬，平頭的話線段端點會切成方塊
  ctx2d.lineJoin = "round";

  for (const track of activeTracks) {
    const colorIndex = track.slot % POSE_COLORS.length;
    const color = POSE_COLORS[colorIndex];

    // 不可見的關節不畫。visible 由 tracking.js 算（EMA＋遲滯），這裡不自己比門檻，否則邊緣關節會逐幀閃爍
    const lm = track.smoothed;
    const ls = lm[MP_LEFT_SHOULDER], rs = lm[MP_RIGHT_SHOULDER];
    // 用 track.scale（EMA 過、側身改用軀幹長）而不是這一幀的肩寬，線寬才不會忽粗忽細
    const sc = Math.max(SCALE_MIN_PX, track.scale * W);
    const core = Math.max(BONE_WIDTH, sc * BONE_WIDTH_RATIO);
    const neck = virtualNeckPoint(lm);
    const nose = lm[MP_NOSE];

    const bones = new Path2D();
    for (const [a, b] of ARM_CONNECTIONS) {
      const p = lm[a], q = lm[b];
      if (!(p.visible ?? true) || !(q.visible ?? true)) continue;
      bones.moveTo(p.x * W, p.y * H);
      bones.lineTo(q.x * W, q.y * H);
    }
    if (neck) {
      bones.moveTo(ls.x * W, ls.y * H); bones.lineTo(neck.x * W, neck.y * H);
      bones.moveTo(rs.x * W, rs.y * H); bones.lineTo(neck.x * W, neck.y * H);
    }
    // 光暈只畫骨頭（頭的外框之後才併進來）
    ctx2d.strokeStyle = POSE_GLOW_COLORS[colorIndex];
    ctx2d.lineWidth = core * GLOW_WIDTH_RATIO;
    ctx2d.stroke(bones);

    // 頭：以鼻子為中心的一個圓，不畫五官的點（細碎的點只會讓畫面亂）
    if (nose.visible ?? true) {
      const hx = nose.x * W, hy = nose.y * H, hr = sc * HEAD_RADIUS;
      ctx2d.beginPath();
      ctx2d.arc(hx, hy, hr, 0, TAU);
      ctx2d.fillStyle = POSE_HEAD_FILLS[colorIndex];
      ctx2d.fill();
      // arc 從角度 0（圓的右端）起筆，先 moveTo 過去，否則會從上一段骨頭拉一條線過來
      bones.moveTo(hx + hr, hy);
      bones.arc(hx, hy, hr, 0, TAU);
    }
    ctx2d.strokeStyle = color;
    ctx2d.lineWidth = core;
    ctx2d.stroke(bones);

    const joints = new Path2D();
    const jr = Math.max(JOINT_RADIUS, core * JOINT_RADIUS_RATIO);
    const addJoint = (x, y) => {
      // 同上：先 moveTo 到圓的右端
      joints.moveTo(x + jr, y);
      joints.arc(x, y, jr, 0, TAU);
    };
    for (const i of ARM_JOINTS) {
      const p = lm[i];
      if (!(p.visible ?? true)) continue;
      addJoint(p.x * W, p.y * H);
    }
    if (neck) addJoint(neck.x * W, neck.y * H);
    ctx2d.fillStyle = color;
    ctx2d.fill(joints);
  }

  ctx2d.restore();

  // ID 標籤畫在鏡像之外（否則文字反轉），座標手動鏡像
  ctx2d.save();
  ctx2d.textAlign = "center";
  ctx2d.textBaseline = "bottom";
  ctx2d.strokeStyle = "rgba(0,0,0,.75)";

  for (const track of activeTracks) {
    const color = POSE_COLORS[track.slot % POSE_COLORS.length];
    const lm = track.smoothed;
    const head = lm[0]; // 鼻子
    const anchor = (head && (head.visible ?? true))
      ? head
      : lm.find((p, i) => isFacePoint(i) && (p.visible ?? true));
    if (!anchor) continue;

    // 字級隨肩寬縮放，夾在 18～36px
    const shoulderWidthPx = Math.hypot((lm[11].x - lm[12].x) * W, (lm[11].y - lm[12].y) * H);
    const fontSizePx = Math.max(18, Math.min(36, shoulderWidthPx * 0.4));
    const headTopOffsetPx = Math.max(fontSizePx * 1.3, shoulderWidthPx * 0.7); // 眼睛到頭頂的估計距離

    const sx = (1 - anchor.x) * W;                  // 水平鏡像
    const sy = anchor.y * H - headTopOffsetPx / 2;   // 眼睛與頭頂的中點

    ctx2d.font = `bold ${fontSizePx.toFixed(0)}px Consolas, monospace`;
    ctx2d.lineWidth = Math.max(3, fontSizePx * 0.12);

    const label = `ID ${track.id}`;
    ctx2d.fillStyle = color;
    ctx2d.strokeText(label, sx, sy);
    ctx2d.fillText(label, sx, sy);
  }

  ctx2d.restore();
}

// rVFC 回呼帶 metadata.captureTime（拍下時刻），rAF 降級路徑沒有
function processFrame(_now, metadata) {
  frameHandle = 0;
  if (isLoopStopped) return;

  // rAF 跟螢幕更新率（常見 60Hz）跑、鏡頭多半 30fps：不比對的話同一幀會推論兩次
  if (!useRVFC) {
    if (video.currentTime === lastProcessedVideoTime) {
      scheduleNextFrame();
      return;
    }
    lastProcessedVideoTime = video.currentTime;
  }

  // 單幀例外不讓迴圈卡死：記 error、跳過這一幀；連續超過 FRAME_ERROR_THRESHOLD 幀才顯示錯誤並停止
  try {
    syncCanvasSize();
    const captureTime = metadata?.captureTime ?? null;
    if (landmarkerReady && chosenPoseCount) {
      // 同一時間只送一張，結果回來才做追蹤／手勢／繪製；等結果期間來的畫面只記最新一張
      if (inFlight) pendingFrame = { captureTime };
      else sendFrame(captureTime);
    } else {
      // 還沒選人數或模型還沒好：不推論，其餘管線照跑（舊 track 自然過期、心跳照送）
      const nowMs = performance.now();
      runPipeline(nowMs, nowMs, [], 0, captureTime === null ? null : nowMs - captureTime, null, null, []);
    }
  } catch (err) {
    frameFailed(err);
  }

  scheduleNextFrame();
}

function frameFailed(err) {
  consecutiveFrameErrors++;
  console.error(`⚠️ 幀處理失敗（連續第 ${consecutiveFrameErrors} 次）：`, err);
  if (consecutiveFrameErrors > FRAME_ERROR_THRESHOLD) {
    stopFrameLoop();
    showError("姿勢追蹤發生持續性錯誤", "請重新整理頁面。若問題持續發生，請確認鏡頭或顯示卡驅動狀態。");
  }
}

// ts＝送出時刻：detectForVideo 的時間戳（必須遞增），也是追蹤與手勢裡這張的時刻
function sendFrame(captureTime) {
  const ts = performance.now();
  pendingFrame = null;   // 取的是 video 當下最新的一張
  inFlight = { ts, captureTime, captureLagMs: captureTime === null ? null : ts - captureTime, detectorRan: lastRawCount < currentPoseCount ? 1 : 0 };
  const source = forgetTracking ? new ImageData(video.videoWidth || CONFIG.width, video.videoHeight || CONFIG.height) : video;
  forgetTracking = false;
  createImageBitmap(source).then(
    (bitmap) => {
      if (isLoopStopped || !poseWorker) { bitmap.close(); inFlight = null; return; }
      poseWorker.postMessage({ type: "detect", bitmap, ts }, [bitmap]);
    },
    (err) => { inFlight = null; frameFailed(err); },
  );
}

function handlePoseResult({ ts, inferMs, landmarks, worldLandmarks }) {
  const sent = inFlight;
  inFlight = null;
  if (!sent || sent.ts !== ts || isLoopStopped) return;   // 鏡頭關掉之後才回來的結果不用
  const startMs = performance.now();
  lastRawCount = landmarks.length;
  try {
    runPipeline(ts, startMs, landmarks, inferMs, sent.captureLagMs, sent.detectorRan, startMs - (sent.captureTime ?? ts), worldLandmarks);
  } catch (err) {
    frameFailed(err);
  }
  if (pendingFrame && !isLoopStopped) sendFrame(pendingFrame.captureTime);
}

// ts＝這張的時刻（追蹤與手勢的時間基準），startMs＝主執行緒開始處理的時刻（逐幀紀錄的耗時從這裡算）
function runPipeline(ts, startMs, rawPoses, detectMs, captureLagMs, detectorRan, resultLagMs, rawWorlds = []) {
  // buildDetection 對座標異常／不像人的回傳 null；同一具身體的重複偵測由 tracker.update() 挑
  const aspect = (video.videoHeight || CONFIG.height) / (video.videoWidth || CONFIG.width);
  const detections = rawPoses.map((lm, i) => buildDetection(lm, { world: rawWorlds[i] ?? null, aspect })).filter(Boolean);

  tracker.update(detections, ts);
  const activeTracks = tracker.getActiveTracks();

  // 最低點時刻用拍下時刻（沒有就用 ts）：揮手的動作時刻，排程器拿來估速、比先後
  const gesture = updateGestures(activeTracks, tracker.cfg.maxUsers, ts, captureLagMs === null ? ts : ts - captureLagMs);
  emitGesturePerformanceState(gesture, ts);

  // 漏偵測一兩幀的人用最後一次的骨架撐住（getDrawableTracks）
  renderSkeletonOverlay(tracker.getDrawableTracks(ts));

  recordFrame(ts, startMs, detectMs, rawPoses.length, detections, activeTracks, gesture.frame, captureLagMs, detectorRan, resultLagMs);
  consecutiveFrameErrors = 0;
}

function scheduleNextFrame() {
  if (isLoopStopped) return;
  frameHandle = useRVFC
    ? video.requestVideoFrameCallback(processFrame)
    : requestAnimationFrame(processFrame);
}

// 停止追蹤迴圈（攝影機關閉、致命錯誤）
function stopFrameLoop() {
  isLoopStopped = true;
  pendingFrame = null;
  if (frameHandle) {
    if (useRVFC) video.cancelVideoFrameCallback(frameHandle);
    else cancelAnimationFrame(frameHandle);
    frameHandle = 0;
  }
}

// 已有排程中的回呼就不再排，否則兩條迴圈每幀推論兩次
function startFrameLoop() {
  isLoopStopped = false;
  lastProcessedVideoTime = -1;
  if (!frameHandle) scheduleNextFrame();
}

function setStatus(msg) { onStatus?.(msg); }

function showError(title, detail = "") { onError?.(title, detail); }

// getUserMedia 失敗時給使用者看的文字（開機錯誤畫面與執行期重開共用）
const CAMERA_ERROR_MESSAGES = {
  NotAllowedError: ["鏡頭權限被拒絕", "請在瀏覽器設定中允許本頁面使用鏡頭。"],
  NotFoundError: ["找不到鏡頭", "請確認裝置已連接鏡頭。"],
  DevicesNotFoundError: ["找不到鏡頭", "請確認裝置已連接鏡頭。"],
  NotReadableError: ["鏡頭被佔用", "請關閉其他正在使用鏡頭的應用程式。"],
  TrackStartError: ["鏡頭被佔用", "請關閉其他正在使用鏡頭的應用程式。"],
  OverconstrainedError: ["鏡頭不支援要求的畫質", "請調整 vision.js 的 CONFIG 解析度／幀率設定，或改用其他鏡頭。"],
};
function cameraErrorText(err, fallbackTitle = "鏡頭開啟失敗") {
  return CAMERA_ERROR_MESSAGES[err?.name] || [fallbackTitle, err?.message || String(err)];
}

// track.stop() 後裝置是非同步釋放的（Firefox／Windows 明顯），緊接著重開會 NotReadableError／AbortError；等一下重試一次
const CAMERA_REOPEN_RETRY_MS = 400;
async function openCamera() {
  try {
    return await requestCameraStream();
  } catch (err) {
    if (err.name !== "NotReadableError" && err.name !== "AbortError") throw err;
    console.warn(`⚠️ 鏡頭暫時無法開啟（${err.name}），${CAMERA_REOPEN_RETRY_MS}ms 後重試一次`);
    await new Promise((r) => setTimeout(r, CAMERA_REOPEN_RETRY_MS));
    return requestCameraStream();
  }
}

async function requestCameraStream() {
  // 給 max：只給 ideal 時瀏覽器可以直接給 1080p60；ideal 讓它在合法模式中挑最接近的
  const constraints = {
    width: { ideal: CONFIG.width, max: CONFIG.width },
    height: { ideal: CONFIG.height, max: CONFIG.height },
    frameRate: { ideal: CONFIG.frameRate, max: CONFIG.frameRate },
  };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
  } catch (err) {
    if (err.name !== "OverconstrainedError") throw err;
    // 少數驅動不支援降採樣、會拒絕上限，退回只給偏好值
    console.warn("⚠️ 鏡頭不接受上限約束，退回偏好值重試（實際規格可能高於設定）");
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: CONFIG.width },
        height: { ideal: CONFIG.height },
        frameRate: { ideal: CONFIG.frameRate },
      },
      audio: false,
    });
  }

  // 約束只是請求，實際規格超出上限才提醒
  const settings = stream.getVideoTracks()[0]?.getSettings() ?? {};
  if (settings.width > CONFIG.width || settings.height > CONFIG.height ||
      settings.frameRate > CONFIG.frameRate + 1) {
    console.warn("⚠️ 鏡頭輸出高於設定上限——此裝置／瀏覽器未完全套用約束，推論負擔會提高");
  }
  return stream;
}

// 鏡頭實際規格與可調範圍（__latency 用）：幀率偏低時分得出是鏡頭給得少還是推論跟不上；Firefox 沒有 getCapabilities
function describeCamera(track) {
  const s = track?.getSettings?.() ?? {};
  const c = track?.getCapabilities?.() ?? {};
  return {
    設定: { 寬: s.width ?? null, 高: s.height ?? null, 幀率: s.frameRate ?? null, 曝光模式: s.exposureMode ?? null, 曝光時間: s.exposureTime ?? null },
    可調範圍: { 幀率: c.frameRate ?? null, 曝光模式: c.exposureMode ?? null, 曝光時間: c.exposureTime ?? null },
  };
}

// 新串流接上 <video> 並等到第一幀可用
async function attachCamera() {
  const stream = await openCamera();
  cameraStream = stream;
  cameraInfo = describeCamera(stream.getVideoTracks()[0]);
  video.srcObject = stream;

  // 鏡頭中斷（拔掉、被搶走、驅動重置）觸發 ended，當成鏡頭已關閉；用串流身分擋掉舊串流遲來的事件
  stream.getVideoTracks()[0]?.addEventListener("ended", () => onCameraEnded(stream));

  await video.play();
  await new Promise((resolve) => {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return resolve();
    video.addEventListener("loadeddata", resolve, { once: true });
  });
  syncCanvasSize();
}

// 收掉攝影機。reason＝舞台提示文字（""＝使用者主動關閉）。
// 不 hardReset 追蹤層：既有槽位維持，重開後只有空槽位給新的人；MediaPipe 的追蹤在重開後第一張清掉（forgetTracking）
function detachCamera(reason) {
  stopFrameLoop();
  cameraStream?.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  video.srcObject = null;
  // Firefox 有「最後一幀黏住」的回報，加 class 讓 CSS 藏起來（visibility，不是 display:none：還要靠它跑 rVFC）
  video.classList.add("is-off");
  cameraOffReason = reason;
  ctx2d.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  resetGestures();
  forgetTracking = true;
  // 立刻通知沒有人在場，不等看門狗
  emitGesturePerformanceState(EMPTY_PERFORMANCE_STATE, performance.now());
}

// start／stop／ended 排進同一條 promise 鏈：play() 還沒 resolve 時換 srcObject 會 AbortError；按鈕的 disabled 擋不住 ended
function enqueueCameraOp(op) {
  const run = cameraOp.then(op, op);
  cameraOp = run.catch(() => {});
  return run;
}

function setCameraState(state) {
  cameraState = state;
  refreshStageHint();
  if (cameraStateListener) {
    try { cameraStateListener(getCameraState()); }
    catch (e) { console.warn("⚠️ 鏡頭狀態監聽者拋錯", e); }
  }
}

function onCameraEnded(stream) {
  if (stream !== cameraStream) return;
  enqueueCameraOp(() => {
    if (stream !== cameraStream) return; // 排隊期間已經被換掉／關掉
    detachCamera("鏡頭已中斷，可能被拔除或被其他程式取用");
    setCameraState("off");
  });
}

// #stage-hint 只由這裡寫：鏡頭關閉優先，其次是還沒選人數，都不是就藏起來
const HINT_CAMERA_OFF = "鏡頭已關閉";
const HINT_CHOOSE_COUNT = "請在上方選擇現場人數後開始偵測";
function refreshStageHint() {
  if (!stageHint) return;
  let text = "";
  if (cameraState !== "on") text = cameraOffReason || HINT_CAMERA_OFF;
  else if (!chosenPoseCount) text = HINT_CHOOSE_COUNT;
  if (stageHint.textContent !== text) stageHint.textContent = text;
  stageHint.hidden = !text;
}

// 收到 ready 才算就緒；Worker 檔或 CDN 載入失敗會觸發 error
function startPoseWorker() {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./poseWorker.js", import.meta.url), { type: "module" });
    worker.onerror = (e) => reject(new Error(`姿勢推論 Worker 載入失敗${e.message ? `：${e.message}` : ""}`));
    worker.onmessage = ({ data }) => {
      if (data.type !== "ready") return;
      worker.onmessage = onPoseWorkerMessage;
      worker.onerror = onPoseWorkerError;
      poseWorker = worker;
      resolve();
    };
  });
}

function onPoseWorkerMessage({ data: msg }) {
  if (msg.type === "result") {
    handlePoseResult(msg);
  } else if (msg.type === "detectFailed") {
    inFlight = null;
    frameFailed(new Error(msg.message));
  } else if (msg.type === "configured" || msg.type === "configureFailed") {
    const call = pendingCalls.get(msg.id);
    pendingCalls.delete(msg.id);
    if (msg.type === "configured") {
      poseModelIndex = msg.modelIndex;
      call?.resolve();
    } else {
      call?.reject(new Error(msg.message));
    }
  }
}

// Worker 沒接住的錯誤：之後不一定還有結果，當成持續性錯誤；等待中的換人數一併失敗
function onPoseWorkerError(e) {
  console.error("⚠️ 姿勢推論 Worker 發生錯誤", e.message ?? e);
  for (const call of pendingCalls.values()) call.reject(new Error("姿勢推論 Worker 發生錯誤"));
  pendingCalls.clear();
  stopFrameLoop();
  showError("姿勢追蹤發生持續性錯誤", "請重新整理頁面。若問題持續發生，請確認鏡頭或顯示卡驅動狀態。");
}

let callSeq = 0;
function callPoseWorker(msg) {
  return new Promise((resolve, reject) => {
    const id = ++callSeq;
    pendingCalls.set(id, { resolve, reject });
    poseWorker.postMessage({ ...msg, id });
  });
}

async function initSystem() {
  try {
    setStatus("正在載入 WASM 視覺模組⋯");
    await startPoseWorker();

    // landmarker 等選了人數才建（之前本來就不推論），開機不搶建

    setStatus("正在啟動鏡頭⋯");
    // 跟「開啟鏡頭」同一條路，只是開機時失敗算致命
    await startCamera();

    // 載入畫面由 main.js 等兩路都就緒才收
    return true;

  } catch (err) {
    console.error("初始化失敗：", err);
    const [title, detail] = cameraErrorText(err, "初始化失敗");
    showError(title, detail);
    return false;
  }
}

// 重置骨架 ID：釋放所有槽位與候選，MediaPipe 也重新找人
export function hardReset() {
  tracker.hardReset();
  resetGestures();
  forgetTracking = true;
  emitGesturePerformanceState(EMPTY_PERFORMANCE_STATE, performance.now());
  ctx2d.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

// 手勢狀態的監聽者（main.js 註冊 input/gestureTrigger.js）；狀態欄位見 gesture.js 的 updateGestures()
export function setPerformanceStateListener(fn) {
  performanceStateListener = typeof fn === "function" ? fn : null;
}

// 現場人數確定後的監聽者（main.js 接到播放器的 setPlayerCount）
let poseCountListener = null;
export function setPoseCountListener(fn) {
  poseCountListener = typeof fn === "function" ? fn : null;
}

// 選的現場人數；0＝還沒選（不推論）。不是 landmarker 的 numPoses（currentPoseCount）
export function getPoseCount() {
  return chosenPoseCount;
}

// 選現場人數：建好（約 1～2 秒）才換手並開始偵測，等待期間用舊的那份繼續推論；失敗由 ui.js 顯示
export async function setPoseCount(count) {
  if (!Number.isInteger(count) || count < 1 || count > CONFIG.maxUsers) {
    throw new Error(`現場人數必須是 1~${CONFIG.maxUsers} 的整數：${count}`);
  }
  if (!poseWorker) throw new Error("視覺系統尚未就緒，無法設定現場人數");

  // 已經是這個 numPoses（重選同值、失敗後重試）：不重建
  if (landmarkerReady && currentPoseCount === count) { applyPoseCount(count); return true; }

  // 第一次建，之後原地 setOptions；等待期間骨架停在上一張
  const seq = ++configureSeq;
  await callPoseWorker({ type: "configure", numPoses: count, modelUrls: POSE_MODEL_URLS.map((u) => new URL(u, document.baseURI).href) });
  if (seq !== configureSeq) return false; // 被更新的請求取代（不是錯誤）

  landmarkerReady = true;
  currentPoseCount = count;
  lastRawCount = 0;              // 換設定後第一幀一定跑偵測器
  applyPoseCount(count);
  return true;
}

// 開始偵測；槽位數跟著人數，人數變了重建 PersonTracker（等於重置骨架 ID）
function applyPoseCount(count) {
  chosenPoseCount = count;
  if (tracker.cfg.maxUsers !== count) {
    tracker = new PersonTracker({ maxUsers: count });
    resetGestures();
    ctx2d.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    emitGesturePerformanceState(EMPTY_PERFORMANCE_STATE, performance.now());
  }
  refreshStageHint();
  if (poseCountListener) {
    try { poseCountListener(count); }
    catch (e) { console.warn("⚠️ 現場人數監聽者拋錯", e); }
  }
}

// { on, busy（開關進行中，按鈕該 disabled）, message（關閉原因或開啟失敗的文字；""＝使用者自己關的） }
export function getCameraState() {
  return {
    on: cameraState === "on",
    busy: cameraState === "starting" || cameraState === "stopping",
    message: cameraOffReason,
  };
}

export function setCameraStateListener(fn) {
  cameraStateListener = typeof fn === "function" ? fn : null;
}

// 開啟攝影機。失敗時收乾淨再拋出：attachCamera 可能接上串流後才失敗（play() 被拒），不能留半套狀態
export function startCamera() {
  return enqueueCameraOp(async () => {
    if (cameraState === "on") return;
    setCameraState("starting");
    try {
      await attachCamera();
      video.classList.remove("is-off");
      startFrameLoop();
      cameraOffReason = "";
      setCameraState("on");
    } catch (err) {
      detachCamera(cameraErrorText(err).join("："));
      setCameraState("off");
      throw err;
    }
  });
}

export function stopCamera() {
  return enqueueCameraOp(async () => {
    if (cameraState === "off") return;
    setCameraState("stopping");
    detachCamera("");
    setCameraState("off");
  });
}

window.addEventListener("beforeunload", () => {
  stopFrameLoop();
  cameraStream?.getTracks().forEach((t) => t.stop());
  poseWorker?.terminate();
  poseWorker = null;
});

// 由 main.js 明確呼叫，不靠 import 副作用（搬動 import 就會默默黑畫面）。resolve 是否成功（失敗已經 onError 顯示）；重複呼叫回傳同一個 promise
let startPromise = null;
export function startVision({ onStatus: statusFn, onError: errorFn } = {}) {
  if (!startPromise) {
    onStatus = typeof statusFn === "function" ? statusFn : null;
    onError = typeof errorFn === "function" ? errorFn : null;
    startPromise = initSystem();
  }
  return startPromise;
}
