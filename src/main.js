// main.js — 組裝：把各功能接在一起、開機流程。開發用量測在 devStats.js。

import * as midiPlayer from './player/midiPlayer.js';
import { initUi, setLoadingStatus, dismissLoading, showError } from './ui.js';
import { startVision, setPoseCountListener, setPerformanceStateListener, warmPoseModel, setFrameLogRecording, clearFrameLog } from './vision/vision.js';
import { startKeyboardTrigger } from './input/keyboard.js';
import { createGestureTrigger } from './input/gestureTrigger.js';
import './devStats.js';

async function bootSystem() {
  midiPlayer.startPlayer(); // 計時器不靠 import 副作用啟動
  // 播放器由這裡交給 ui.js；畫面先同步接好，開機期間 #app-shell 是 inert
  initUi(midiPlayer);
  setPoseCountListener(midiPlayer.setPlayerCount);
  // 逐幀紀錄跟著演奏走：從頭播時清空（跟按鍵錄音同一個起點），只在演奏模式播放中記
  midiPlayer.setPlaybackRestartListener(clearFrameLog);
  let recording = false;
  midiPlayer.playerStore.addEventListener('change', () => {
    const { transport, mode } = midiPlayer.playerStore.state;
    const on = transport === 'playing' && mode === 'perform';
    if (on !== recording) setFrameLogRecording(recording = on);
  });

  // 視覺與音源並行，兩邊都就緒才收起載入畫面，避免「看得到骨架、按播放卻沒聲音」的空窗期
  const [visionOk, midiOk] = await Promise.all([
    startVision({ onStatus: setLoadingStatus, onError: showError }),
    midiPlayer.warmUpMidiEngine(),
  ]);

  // 觸發來源：鍵盤（槽位 'kb'）與揮手（槽位 1~4＝演奏者 ID）並存，都進同一個入口 triggerInput
  startKeyboardTrigger(midiPlayer.triggerInput, midiPlayer.KEYBOARD_SLOT, midiPlayer.liftInput);
  const onGesture = createGestureTrigger(midiPlayer.triggerInput);
  setPerformanceStateListener((state) => { onGesture(state); midiPlayer.setPresentSlots(state.presentSlots); });

  // 視覺初始化失敗時錯誤畫面已經顯示，載入畫面不收、inert 也維持
  if (!visionOk) return;

  // 音源初始化失敗不擋進場（攝影機、骨架都還能用），狀態列由播放器寫明。
  setLoadingStatus(midiOk ? '✅ 準備就緒' : '⚠️ 已就緒，但音源引擎載入失敗');
  dismissLoading();
  warmPoseModel(); // 開機完成之後才在背景暖機姿勢模型，使用者第一次選現場人數時不必等下載
}

bootSystem()
  .catch((err) => {
    console.error('❌ 系統啟動失敗', err);
    setLoadingStatus('啟動失敗，請重新整理頁面');
  });
