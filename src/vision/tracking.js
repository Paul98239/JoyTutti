// tracking.js — 多人槽位追蹤與平滑：偵測該貼哪個已鎖定槽位、新面孔何時鎖定空位，加上逐節點的 One Euro 平滑。
// 純粹依位置（門檻依這個人的尺度縮放，見 bodyScaleOf）判斷；ID 只是槽位編號，不做身分認回。

const round3 = (v) => Math.round(v * 1000) / 1000;

export const DEFAULT_TRACKING_CONFIG = Object.freeze({
  maxUsers: 4,

  // 以下「尺度」＝bodyScaleOf()（以畫面寬為單位）：正面時就是肩寬，側身時不縮，所以原本以肩寬訂的比例照用。
  // 位置門檻＝max(gatePos, gatePosRatio × 這個人的尺度)：同一個動作站得近的人在正規化座標上走得比較遠；絕對值下限給遠處的小人。
  gatePos: 0.15,
  gatePosRatio: 0.45,
  // 漏配緩衝期內（漏配 ≤ missGraceMs）門檻放寬到 max(上面, graceGate, graceGateRatio × 尺度)：手在頭部交叉這類姿勢時 MediaPipe 會把整個人估歪一大段。
  // 只在單人或鄰居很遠時真的生效（見 ambiguityRatio）。
  graceGate: 0.45,
  graceGateRatio: 1.5,
  // 歧義收斂：門檻再夾到「最近另一個槽位的距離 × ambiguityRatio」以內（下限 ambiguityFloorRatio × 尺度，保留一幀內的正常位移）。
  ambiguityRatio: 0.5,
  // 站得很近時仍保留的最小半徑（尺度單位）：多人近距離實測骨架會黏到對方身上，調高到 0.4；算不準，要照實機繼續調。
  ambiguityFloorRatio: 0.4,

  // 「同一具身體」（isSameBody，四處共用）：肩膀中點距離 < max(sameBodyDist, sameBodyRatio × 較小的尺度)。兩個真人的肩膀中點不可能靠到半個肩寬以內，
  // 幽靈（同一具身體多吐一組骨架）的中點幾乎重合。取較小的尺度：站在正後方、看起來較小的人才不會被近處那個人的尺度吞掉。
  sameBodyDist: 0.03,
  sameBodyRatio: 0.5,
  // 硬保險（_releaseDuplicateTracks）：兩個槽位連續這麼久是同一具身體才釋放較晚鎖定的；單幀誤判不該砍掉正在用的 ID。
  duplicateTrackConfirmMs: 200,

  // 候選人跨幀關聯的距離（尺度單位）
  pendingAssocDist: 0.15,
  pendingAssocDistRatio: 1.0,
  // 尺度本身也平滑，否則門檻跟著單幀雜訊跳動；0.1 同我同事的數值。
  scaleEmaAlpha: 0.1,

  // 繪製用的短暫保留（getDrawableTracks）：MediaPipe 偶爾漏一幀，骨架會眨一下；100ms＝3 幀，人真的離開仍幾乎立刻消失。手勢與在場名單不用它。
  drawHoldMs: 100,
  // 以下以毫秒計（不是幀數），跟幀率脫鉤
  trackLossMs: 1500,      // 未匹配超過這段時間就釋放鎖定
  lockConfirmMs: 231,     // 新目標需持續出現這麼久才鎖定空位
  // 可見度 EMA＋遲滯（on／off 兩道門檻）：沒有的話邊緣關節在門檻附近會逐幀閃；結果寫進 smoothed[i].visible，繪製端直接用。
  visibilityEmaAlpha: 0.3,
  visibilityOnGate: 0.55,
  visibilityOffGate: 0.45,
  // 候選人這一幀沒配到時保留多久（累積時間不歸零）：邊緣或背光的人偵測不穩，否則湊不滿 lockConfirmMs。鎖定仍要求這一幀有配到。
  pendingGraceMs: 400,
  // 漏配緩衝期長度（固定，不隨 missCount 遞減：姿勢做到一半保護不能先失效）
  missGraceMs: 1320,

  // 非人物體防呆。幾何（肩寬範圍、肩在髖上方）是硬拒絕；可見度分兩級：
  //   - 嚴格：鎖定新候選人用，可見度很低的多半是背景圖案或半個身體的誤判。
  //   - 寬鬆（…Tracked）：延續已在追蹤的人用；手臂橫過胸前、側身時另一側肩膀常掉到 0.4～0.5。低於寬鬆門檻的連追蹤都不參與。
  coreVisibilityMin: 0.5,
  overallVisibilityMin: 0.3,
  coreVisibilityMinTracked: 0.3,
  overallVisibilityMinTracked: 0.2,
  minShoulderWidth: 0.015,
  maxShoulderWidth: 0.9,
  visibilityThreshold: 0.5,
});

function isFinitePoint(p) { return !!p && Number.isFinite(p.x) && Number.isFinite(p.y); }

// 幾何上像不像一個人（擋背景圖案、假人模型的誤判）：肩寬合理、髖部可信時肩在髖上方
function hasHumanGeometry(landmarks, cfg, aspect) {
  const lS = landmarks[11], rS = landmarks[12];
  const lH = landmarks[23], rH = landmarks[24];

  const shoulderWidth = Math.hypot(lS.x - rS.x, (lS.y - rS.y) * aspect);
  if (shoulderWidth < cfg.minShoulderWidth || shoulderWidth > cfg.maxShoulderWidth) return false;

  // 坐姿或下半身被裁時髖部可見度本來就低，只在可信時才檢查
  const hipVis = Math.min(lH.visibility ?? 0, rH.visibility ?? 0);
  if (hipVis >= cfg.visibilityThreshold) {
    const shoulderMidY = (lS.y + rS.y) / 2, hipMidY = (lH.y + rH.y) / 2;
    if (shoulderMidY >= hipMidY) return false;
  }
  return true;
}

// 33 點的平均可見度；沒有任何可見度數值時視為 1（等同不檢查）。
function meanLandmarkVisibility(landmarks) {
  let visSum = 0, visCount = 0;
  for (const p of landmarks) {
    if (typeof p.visibility === "number") { visSum += p.visibility; visCount++; }
  }
  return visCount > 0 ? visSum / visCount : 1;
}

function shoulderVisibility(landmarks) {
  return Math.min(landmarks[11].visibility ?? 0, landmarks[12].visibility ?? 0);
}

// 原始 landmark → 一筆偵測；null＝數值異常、不像人、或可見度不到寬鬆門檻。
// aspect＝畫面高 ÷ 寬：y 乘它才跟 x 同一把尺（尺度、距離、平滑速度、手勢都用）。
export function buildDetection(landmarks, { cfg = DEFAULT_TRACKING_CONFIG, world = null, aspect }) {
  const lShoulder = landmarks[11], rShoulder = landmarks[12];
  const lHip = landmarks[23], rHip = landmarks[24];
  if (![lShoulder, rShoulder, lHip, rHip].every(isFinitePoint)) return null;
  if (!hasHumanGeometry(landmarks, cfg, aspect)) return null;

  // 只過寬鬆門檻的可以延續已追蹤的人，但不能鎖定新 ID（strictPlausible）
  const shoulderVis = shoulderVisibility(landmarks);
  const meanVisibility = meanLandmarkVisibility(landmarks);
  if (shoulderVis < cfg.coreVisibilityMinTracked || meanVisibility < cfg.overallVisibilityMinTracked) return null;
  const strictPlausible = shoulderVis >= cfg.coreVisibilityMin && meanVisibility >= cfg.overallVisibilityMin;

  const shoulderMidX = (lShoulder.x + rShoulder.x) / 2;
  const shoulderMidY = (lShoulder.y + rShoulder.y) / 2;
  // 位置錨點＝肩膀中點：最穩（很少被裁或遮住），幽靈跟真人共用同一對肩膀（isSameBody 靠這一點）
  const centroid = { x: shoulderMidX, y: shoulderMidY };
  // scale＝這個人在畫面上多大（門檻、平滑速度、手勢的單位）；候選多於空槽位時優先鎖定最大（最近）的
  const scale = bodyScaleOf(landmarks, BODY_SCALE_TORSO_RATIO, aspect);

  // world＝worldLandmarks（公尺、原點在兩髖中間），只給逐幀紀錄用
  return { landmarks, world, centroid, scale, aspect, meanVisibility, strictPlausible };
}

// 肩膀中點距離；偵測、track、候選人都有 centroid／scale／aspect，下面幾個函式通用
function centroidDistance(a, b) {
  return Math.hypot(a.centroid.x - b.centroid.x, (a.centroid.y - b.centroid.y) * a.aspect);
}

function sameBodyGate(a, b, cfg) {
  const w = Math.min(a.scale ?? 0, b.scale ?? 0);
  return Math.max(cfg.sameBodyDist, cfg.sameBodyRatio * (Number.isFinite(w) ? w : 0));
}

export function isSameBody(a, b, cfg = DEFAULT_TRACKING_CONFIG) {
  return centroidDistance(a, b) < sameBodyGate(a, b, cfg);
}

// 離最近的 anchor 幾個尺度（越小越像延續既有 track）；沒有 anchor 時 Infinity
function continuityRank(det, anchors) {
  let best = Infinity;
  for (const a of anchors) {
    if (!a) continue;
    const scale = Math.max(a.scale ?? 0, 1e-3);
    best = Math.min(best, centroidDistance(a, det) / scale);
  }
  return best;
}

// 同一具身體只留一筆偵測。不能留第一筆：MediaPipe 多人模式把延續的追蹤框排前面、新偵測的放尾端，真人常在尾端、幽靈在前面。
// 順位：①最能延續既有 track ②平均可見度高
export function dedupeDetections(detections, cfg = DEFAULT_TRACKING_CONFIG, anchors = []) {
  if (detections.length < 2) return detections.slice();
  const ranked = detections.map((det) => ({ det, continuity: continuityRank(det, anchors) }));
  ranked.sort((a, b) => (a.continuity - b.continuity)
    || ((b.det.meanVisibility ?? 1) - (a.det.meanVisibility ?? 1)));
  const kept = [];
  for (const { det } of ranked) {
    if (!kept.some((k) => isSameBody(k, det, cfg))) kept.push(det);
  }
  return kept;
}

// 尺度＝max(肩寬, c × 軀幹長)，以畫面寬為單位：側身時肩寬趨近 0、軀幹長不縮；髖部看不到時只用肩寬。y 先乘 aspect，否則 16:9 下軀幹長多算 1.78 倍。
// c＝0.6：正面時肩寬 ÷ 軀幹長，MediaPipe 官方範例人像 0.63、corpus/recordings 2026-10-29 三段逐幀紀錄 0.68～0.72；取略小，正面時由肩寬決定、側身約為正面肩寬的 0.95。
export const BODY_SCALE_TORSO_RATIO = 0.6;
const HIP_VISIBILITY_MIN = 0.5;

export function bodyScaleOf(landmarks, c, aspect) {
  const ls = landmarks[11], rs = landmarks[12], lh = landmarks[23], rh = landmarks[24];
  const shoulderWidth = Math.hypot(ls.x - rs.x, (ls.y - rs.y) * aspect);
  if (!((lh.visibility ?? 0) >= HIP_VISIBILITY_MIN && (rh.visibility ?? 0) >= HIP_VISIBILITY_MIN)) return shoulderWidth;
  const torso = Math.hypot((ls.x + rs.x - lh.x - rh.x) / 2, ((ls.y + rs.y - lh.y - rh.y) / 2) * aspect);
  return Math.max(shoulderWidth, c * torso);
}

// One Euro（Casiez, Roussel, Vogel, CHI 2012, DOI 10.1145/2207676.2208639），照 MediaPipe 的 one_euro_filter.cc：
// 速度＝(這一幀原始值 − 上一幀原始值) × valueScale ÷ dt，先以 dCutoff 低通；截止頻率＝minCutoff＋beta × |速度|；輸出＝以該截止頻率低通。
// 一階低通的輸出永遠落在上一個輸出與這一幀輸入之間，不會過衝；時間戳沒有變新時原樣回傳輸入、不改狀態（MediaPipe 同）。
// 每個節點依序過 ONE_EURO_STAGES 的每一層：
//   人數 1：MediaPipe 內建已先平滑一層（min_cutoff 0.05、beta 80，速度除以它的推論框尺度），我們再加 EXTRA 一層（內建之後靜止時手腕仍抖 0.5～1.4px）。
//     EXTRA 照作者的順序在 v3 舊紀錄上掃（beta 0 先定壓抖動的 minCutoff，再取最快動作延遲 ≤ 10ms 的最小 beta，同一把尺重掃 9.8ms）。
//   人數 ≥ 2：MediaPipe 不平滑；先用 MEDIAPIPE_EQUIVALENT 補上它那一層，再接同一個 EXTRA，兩種人數的骨架一樣穩、一樣跟手。
//     MediaPipe 的速度除以推論框尺度（pose_landmarks_detector_graph.cc 把下一幀的推論框接到平滑的 OBJECT_SCALE_ROI，(寬＋高) ÷ 2，像素），
//     我們除以 track.scale（肩寬），所以 beta＝80 ÷（推論框是幾個肩寬）。2026-10-28 實測：官方範例人像在無頭 Chromium 裡等速平移，
//     人數 2 的原始輸出過這一層、跟人數 1 的真平滑逐幀比，移動中的平均落後量在 6.2（15～240px/s）、6.5（10～30px/s）個肩寬時一致；取 6，偏差 < 0.07px。
//   2026-10-29 用 v6 紀錄（corpus/recordings/canon-2duet-visionlog-20261029-*，有真的靜止段）重掃：mc 0.5～8 × beta 5～40 的抖動、延遲都在目標內，mc 2、beta 20 不換；
//     EXTRA 改用 2D 合成速度（speed2d，見 OneEuroFilter2D）：x、y 各算各時谷底比原始晚一幀的觸發超過一成（時刻差 p90 48ms），2D 降到 32ms 以內、靜止抖動多不到 0.03px。
//     MediaPipe 等效層照 MediaPipe 各算各。
const MP_ROI_SHOULDERS = 6;
const MEDIAPIPE_EQUIVALENT = Object.freeze({ minCutoff: 0.05, beta: 80 / MP_ROI_SHOULDERS, dCutoff: 1 });
const EXTRA = Object.freeze({ minCutoff: 2, beta: 20, dCutoff: 1, speed2d: true });
export const ONE_EURO_STAGES = Object.freeze({
  single: Object.freeze([EXTRA]),
  multi: Object.freeze([MEDIAPIPE_EQUIVALENT, EXTRA]),
});

// MediaPipe 人數 1 時先把每個節點的可見度低通一次（pose_landmarks_detector_graph.cc 的 SmoothLandmarksVisibility，low_pass_filter_alpha 0.1），人數 ≥ 2 沒有；
// 追蹤層在人數 ≥ 2 時補上同一次低通，再做自己的 EMA 與遲滯（visibilityEmaAlpha），兩種人數的節點一樣不閃
const MEDIAPIPE_VISIBILITY_ALPHA = 0.1;

const oneEuroAlpha = (cutoff, dtS) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dtS));

export class OneEuroFilter {
  constructor({ minCutoff, beta, dCutoff }) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }
  filter(x, tMs, valueScale) {
    if (this.lastT !== null && tMs <= this.lastT) return x;
    if (this.lastRaw === null) {
      this.lastRaw = x; this.out = x; this.dx = 0; this.lastT = tMs;
      return x;
    }
    const dtS = (tMs - this.lastT) / 1000;
    this.dx += oneEuroAlpha(this.dCutoff, dtS) * ((x - this.lastRaw) * valueScale / dtS - this.dx);
    this.out += oneEuroAlpha(this.minCutoff + this.beta * Math.abs(this.dx), dtS) * (x - this.out);
    this.lastRaw = x;
    this.lastT = tMs;
    return this.out;
  }
  reset() {
    this.lastRaw = null;
    this.out = null;
    this.dx = 0;
    this.lastT = null;
  }
}

// 同一個 One Euro，但 x、y 共用一個截止頻率：速度＝√(dx̂² + dŷ²)（兩軸的速度各自先以 dCutoff 低通），斜著揮時兩軸一起放開，不會一軸先到谷底、另一軸還在拖。
// y 不動時跟 1D 逐幀相同。這是我們的改法，不是 MediaPipe 的（它各軸各算）。
export class OneEuroFilter2D {
  constructor({ minCutoff, beta, dCutoff }) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.lastRaw = null;
    this.out = null;
    this.dx = 0;
    this.dy = 0;
    this.lastT = null;
  }
  filter(p, tMs, vsX, vsY) {
    if (this.lastT !== null && tMs <= this.lastT) return p;
    if (this.lastRaw === null) {
      this.lastRaw = p; this.out = { x: p.x, y: p.y }; this.lastT = tMs;
      return this.out;
    }
    const dtS = (tMs - this.lastT) / 1000, ad = oneEuroAlpha(this.dCutoff, dtS);
    this.dx += ad * ((p.x - this.lastRaw.x) * vsX / dtS - this.dx);
    this.dy += ad * ((p.y - this.lastRaw.y) * vsY / dtS - this.dy);
    const a = oneEuroAlpha(this.minCutoff + this.beta * Math.hypot(this.dx, this.dy), dtS);
    this.out = { x: this.out.x + a * (p.x - this.out.x), y: this.out.y + a * (p.y - this.out.y) };
    this.lastRaw = p;
    this.lastT = tMs;
    return this.out;
  }
}

// PersonTracker：多人 ID 鎖定狀態機（固定 maxUsers 個槽位，ID 恆等於槽位編號 1~maxUsers）。
export class PersonTracker {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_TRACKING_CONFIG, ...config };
    this.reset();
  }

  reset() {
    this.tracks = new Array(this.cfg.maxUsers).fill(null);
    this.pending = []; // 候選新目標，尚未持續出現足夠時間
    this.events = [];  // 鎖定／釋放的紀錄（開發用）：vision.js 每幀 drainEvents() 取走，給 __visionLog 匯出，查「多出來的 ID 是怎麼被鎖進去的」
  }

  hardReset() { this.reset(); }

  drainEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  _logEvent(nowMs, type, slot, extra) {
    this.events.push({ t: Math.round(nowMs), type, slot: slot + 1, ...extra });
  }

  // 同 getActiveTracks()，欄位精簡
  getTrackedUsers() {
    return this.getActiveTracks().map((t) => ({ id: t.id, slot: t.slot, landmarks: t.smoothed }));
  }

  // 手勢與在場名單用：這一幀有配到的 track。漏配緩衝期（trackLossMs）只是內部保留槽位，不算在場
  getActiveTracks() {
    return this.tracks.filter((t) => t !== null && t.missCount === 0);
  }

  // 繪製用：外加最後一次配到之後 drawHoldMs 內的 track（畫它最後的骨架）
  getDrawableTracks(nowMs) {
    const { drawHoldMs } = this.cfg;
    return this.tracks.filter((t) => t !== null
      && (t.missCount === 0 || nowMs - t.lastSeenMs <= drawHoldMs));
  }

  // 到最近另一個上一幀有配到的槽位的距離（沒有是 Infinity）。不算漏配中的：那個人可能已走掉，拿舊位置收斂門檻會把旁邊的人卡住
  _nearestOtherTrackDist(track) {
    let best = Infinity;
    for (const other of this.tracks) {
      if (!other || other === track || other.missCount > 0) continue;
      best = Math.min(best, centroidDistance(track, other));
    }
    return best;
  }

  // 偵測貼上這個槽位的成本（Infinity＝不允許）。門檻：基本 → 漏配放寬 → 依鄰居收斂（見 DEFAULT_TRACKING_CONFIG）。
  // 比對上一次的實際位置、不做速度外插：外插會把單幀雜訊往錯的方向多推一截
  _trackDetectionCost(track, det, nowMs) {
    const { gatePos, gatePosRatio, graceGate, graceGateRatio,
            ambiguityRatio, ambiguityFloorRatio, missGraceMs } = this.cfg;

    let gate = Math.max(gatePos, gatePosRatio * track.scale);
    const inGraceWindow = track.missCount > 0 && (nowMs - track.lastSeenMs) <= missGraceMs;
    if (inGraceWindow) {
      gate = Math.max(gate, graceGate, graceGateRatio * track.scale);
    }
    gate = Math.max(
      Math.min(gate, ambiguityRatio * this._nearestOtherTrackDist(track)),
      ambiguityFloorRatio * track.scale);

    const posDist = centroidDistance(track, det);
    if (posDist > gate) return Infinity;
    return posDist / gate;
  }

  // 新候選人給任一個空槽位（不做身分認回）
  _resolveSlotForNewIdentity() {
    const freeSlot = this.tracks.findIndex((t) => t === null);
    return freeSlot;
  }

  _createTrack(slot, det, nowMs) {
    const n = det.landmarks.length;
    // 人數 1 時 MediaPipe 已先平滑一層，≥ 2 時沒有（見 ONE_EURO_STAGES）
    const stages = this.cfg.maxUsers === 1 ? ONE_EURO_STAGES.single : ONE_EURO_STAGES.multi;
    const track = {
      slot,
      id: slot + 1,
      centroid: { ...det.centroid },
      // bodyScaleOf，在 _updateTrack 裡 EMA 更新
      scale: det.scale,
      aspect: det.aspect,
      lockedAtMs: nowMs,     // 兩個槽位是同一具身體時，用它決定誰較新
      duplicateSinceMs: 0,   // 跟另一個槽位重疊的起算時刻（0＝沒有）
      // 只濾 x／y（沒有地方讀 z）。每節點一串，每層是 OneEuroFilter2D 或 x、y 各一個 OneEuroFilter
      filters: Array.from({ length: n }, () => stages.map((s) => (s.speed2d ? new OneEuroFilter2D(s) : { x: new OneEuroFilter(s), y: new OneEuroFilter(s) }))),
      // 人數 ≥ 2 才有：MEDIAPIPE_VISIBILITY_ALPHA 低通的狀態，每節點一個
      visLowPass: this.cfg.maxUsers === 1 ? null : det.landmarks.map((p) => p.visibility ?? 1),
      smoothed: det.landmarks.map((p) => ({ ...p })),
      missCount: 0,       // 0＝這一幀有配到
      lastSeenMs: nowMs   // 最後一次配到的時間（釋放與漏配寬限都以此為準）
    };
    this._updateTrack(track, det, nowMs);
    return track;
  }

  _updateTrack(track, det, nowMs) {
    const { visibilityEmaAlpha, visibilityOnGate, visibilityOffGate,
            scaleEmaAlpha } = this.cfg;
    track.missCount = 0;
    track.lastSeenMs = nowMs;
    track.centroid = det.centroid;
    track.aspect = det.aspect;
    track.raw = det.landmarks;  // 原始 landmark（逐幀紀錄讀它）
    track.rawWorld = det.world;
    track.scale += (det.scale - track.scale) * scaleEmaAlpha;
    // 速度以「尺度／秒」計，遠近一致；y 先乘 aspect（MediaPipe 平滑前也先換成像素）
    const vsX = 1 / track.scale, vsY = det.aspect / track.scale;
    const chain = (layers, p) => {
      for (const l of layers) p = l instanceof OneEuroFilter2D ? l.filter(p, nowMs, vsX, vsY) : { x: l.x.filter(p.x, nowMs, vsX), y: l.y.filter(p.y, nowMs, vsY) };
      return p;
    };

    // 上一幀的結果是 EMA 與遲滯的狀態（第一幀沒有 visible 欄位，用 onGate 判定初始狀態）
    const prev = track.smoothed, lowPass = track.visLowPass;
    track.smoothed = det.landmarks.map((p, i) => {
      let rawVis = p.visibility ?? 1;
      if (lowPass) rawVis = lowPass[i] += (rawVis - lowPass[i]) * MEDIAPIPE_VISIBILITY_ALPHA;
      const prevVis = prev[i]?.visibility ?? rawVis;
      const visibility = prevVis + (rawVis - prevVis) * visibilityEmaAlpha;
      const wasVisible = prev[i]?.visible ?? (visibility >= visibilityOnGate);
      const { x, y } = chain(track.filters[i], { x: p.x, y: p.y });
      return {
        x,
        y,
        visibility,
        visible: wasVisible ? visibility > visibilityOffGate : visibility >= visibilityOnGate
      };
    });
  }

  // 候選人持續出現夠久才鎖定空位（路人短暫入鏡不搶槽位）
  _updatePendingCandidates(detections, usedDetIdx, nowMs) {
    const hasFreeSlot = this.tracks.some((t) => t === null);
    if (!hasFreeSlot) { this.pending = []; return; }

    const { pendingAssocDist, pendingAssocDistRatio } = this.cfg;
    const unmatched = [];
    detections.forEach((d, i) => {
      if (usedDetIdx.has(i)) return;
      // 沒配到的偵測可能是已鎖定者的幽靈，不擋會鎖成第二個 ID。只擋 isSameBody 這麼窄是刻意的：差超過半個肩寬就當第二個人
      if (this.tracks.some((t) => t && isSameBody(t, d, this.cfg))) return;
      if (!d.strictPlausible) return;
      unmatched.push(d);
    });

    const usedPending = new Set();
    const nextPending = [];

    for (const det of unmatched) {
      let bestIdx = -1, bestDist = Infinity;
      const assocDist = Math.max(pendingAssocDist, pendingAssocDistRatio * det.scale);
      this.pending.forEach((p, pi) => {
        if (usedPending.has(pi)) return;
        const dist = centroidDistance(p, det);
        if (dist < assocDist && dist < bestDist) { bestDist = dist; bestIdx = pi; }
      });

      if (bestIdx >= 0) {
        usedPending.add(bestIdx);
        const p = this.pending[bestIdx];
        p.centroid = det.centroid;
        p.aspect = det.aspect;
        p.det = det;
        p.lastSeenMs = nowMs;
        p.matchedThisFrame = true;
        nextPending.push(p);
      } else {
        nextPending.push({
          centroid: det.centroid,
          aspect: det.aspect,
          det,
          firstSeenMs: nowMs,
          lastSeenMs: nowMs,
          matchedThisFrame: true,
        });
      }
    }

    // 沒配到的候選人在 pendingGraceMs 內留著
    this.pending.forEach((p, pi) => {
      if (usedPending.has(pi)) return;
      p.matchedThisFrame = false;
      if (nowMs - p.lastSeenMs <= this.cfg.pendingGraceMs) nextPending.push(p);
    });

    // 優先鎖定尺度大（較近）的，背景路人不搶鏡頭前的人；沒搶到的下一幀繼續排。
    // 鎖定要 ①出現夠久 ②這一幀有配到（否則已走出畫面的候選人會拿過期的 det 鎖進來）
    const ready = nextPending.filter(
      (p) => p.matchedThisFrame && nowMs - p.firstSeenMs >= this.cfg.lockConfirmMs);
    ready.sort((a, b) => b.det.scale - a.det.scale);

    for (const p of ready) {
      const slot = this._resolveSlotForNewIdentity();
      if (slot === -1) continue;
      this.tracks[slot] = this._createTrack(slot, p.det, nowMs);
      this._logEvent(nowMs, 'lock', slot, { scale: round3(p.det.scale), vis: round3(p.det.meanVisibility), strict: p.det.strictPlausible });
      p.isLocked = true;
    }

    this.pending = nextPending.filter((p) => !p.isLocked);
  }

  // 一具身體一個 ID 的最後硬保險（收 dedupe 與候選抑制漏網的）：連續 duplicateTrackConfirmMs 是同一具身體就釋放較晚鎖定的
  _releaseDuplicateTracks(nowMs) {
    const { duplicateTrackConfirmMs } = this.cfg;
    const live = this.tracks.filter((t) => t !== null && t.missCount === 0);
    const overlapping = new Set();

    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i], b = live[j];
        if (!isSameBody(a, b, this.cfg)) continue;
        overlapping.add(a.lockedAtMs <= b.lockedAtMs ? b : a); // 保留先鎖定的那個
      }
    }

    for (const track of this.tracks) {
      if (!track) continue;
      if (!overlapping.has(track)) { track.duplicateSinceMs = 0; continue; }
      if (track.duplicateSinceMs === 0) track.duplicateSinceMs = nowMs;
      if (nowMs - track.duplicateSinceMs < duplicateTrackConfirmMs) continue;
      this.tracks[track.slot] = null;
      this._logEvent(nowMs, 'duplicate', track.slot);
    }
  }

  // 每幀：槽位與偵測貪婪匹配（槽位少，夠用）。重複偵測在這裡以目前槽位當 anchor 挑
  update(rawDetections, nowMs) {
    const detections = dedupeDetections(rawDetections, this.cfg, this.tracks);
    const usedDetIdx = new Set();
    const usedSlot = new Set();
    const candidates = [];

    this.tracks.forEach((track, slot) => {
      if (!track) return;
      // 跟先鎖定的槽位是同一具身體（幽靈曾被鎖成 ID 又疊回真人）就讓先鎖的先挑：只比成本的話真人可能換成幽靈的 ID，而漏配中的後鎖槽位硬保險也收不到
      const yields = this.tracks.some((o) => o && o.lockedAtMs < track.lockedAtMs && isSameBody(o, track, this.cfg));
      detections.forEach((det, di) => {
        const cost = this._trackDetectionCost(track, det, nowMs);
        if (cost !== Infinity) candidates.push({ slot, di, cost, yields });
      });
    });
    candidates.sort((a, b) => (a.yields - b.yields) || (a.cost - b.cost));

    for (const { slot, di } of candidates) {
      if (usedSlot.has(slot) || usedDetIdx.has(di)) continue;
      usedSlot.add(slot);
      usedDetIdx.add(di);
      this._updateTrack(this.tracks[slot], detections[di], nowMs);
    }

    this.tracks.forEach((track, slot) => {
      if (!track || usedSlot.has(slot)) return;
      track.missCount++;
      if (nowMs - track.lastSeenMs > this.cfg.trackLossMs) {
        this.tracks[slot] = null;
        this._logEvent(nowMs, 'loss', slot);
      }
    });

    this._releaseDuplicateTracks(nowMs);
    this._updatePendingCandidates(detections, usedDetIdx, nowMs);
  }
}
