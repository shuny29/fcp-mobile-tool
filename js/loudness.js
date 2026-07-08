// loudness.js
// ITU-R BS.1770 のK-weightingフィルタを使った簡易ラウドネス測定と、
// 発話区間ごとの音量正規化(ゲイン計算)を行う。
//
// 注: ゲーティング(無音部分を統計から除外する処理)は省略した簡易版。
// 発話区間だけを対象に測定するため、実用上は十分な精度を狙っている。

// BS.1770 48kHz用の標準Kウェイティング係数(2段のバイクアッドフィルタ)
const STAGE1 = { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 };
const STAGE2 = { b0: 1.0, b1: -2.0, b2: 1.0, a1: -1.99004745483398, a2: 0.99007225036621 };
const MEASURE_SAMPLE_RATE = 48000;

function biquad(samples, c) {
  const out = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let n = 0; n < samples.length; n++) {
    const x0 = samples[n];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[n] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

/** Kウェイティング後の平均二乗値からLUFS(近似・ゲーティングなし)を計算する */
function lufsFromSamples(samples) {
  if (!samples.length) return -Infinity;
  const s1 = biquad(samples, STAGE1);
  const s2 = biquad(s1, STAGE2);
  let sumSq = 0;
  for (let i = 0; i < s2.length; i++) sumSq += s2[i] * s2[i];
  const meanSq = sumSq / s2.length;
  if (meanSq <= 0) return -Infinity;
  return -0.691 + 10 * Math.log10(meanSq);
}

/** 元のAudioBufferの指定区間を、測定用に48kHzモノラルへリサンプリングする */
async function extractForMeasurement(audioBuffer, startSec, endSec) {
  const originalRate = audioBuffer.sampleRate;
  const startSample = Math.max(0, Math.floor(startSec * originalRate));
  const endSample = Math.min(audioBuffer.length, Math.floor(endSec * originalRate));
  const length = Math.max(1, endSample - startSample);

  const numCh = audioBuffer.numberOfChannels;
  const monoSlice = new Float32Array(length);
  for (let ch = 0; ch < numCh; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) monoSlice[i] += data[startSample + i] / numCh;
  }

  if (originalRate === MEASURE_SAMPLE_RATE) return monoSlice;

  const targetLength = Math.max(1, Math.ceil((length / originalRate) * MEASURE_SAMPLE_RATE));
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const offlineCtx = new OfflineCtx(1, targetLength, MEASURE_SAMPLE_RATE);
  const sliceBuffer = offlineCtx.createBuffer(1, length, originalRate);
  sliceBuffer.copyToChannel(monoSlice, 0);
  const src = offlineCtx.createBufferSource();
  src.buffer = sliceBuffer;
  src.connect(offlineCtx.destination);
  src.start();
  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

/**
 * 測定済みのLUFSとピーク振幅から、適用すべきゲイン(dB)を計算する。
 * Python版(audio_normalize.py)の compute_gain_from_measurement と同じロジック。
 */
export function computeGainFromMeasurement(measuredLufs, peakLinear, targetLufs, {
  maxBoostDb = 12, maxCutDb = 12, truePeakCeilingDb = -1,
} = {}) {
  if (measuredLufs === null || measuredLufs === -Infinity || Number.isNaN(measuredLufs)) return 0;

  let gainDb = targetLufs - measuredLufs;
  gainDb = Math.max(-maxCutDb, Math.min(maxBoostDb, gainDb));

  if (peakLinear && peakLinear > 0) {
    const ceilingLinear = Math.pow(10, truePeakCeilingDb / 20);
    const projectedPeak = peakLinear * Math.pow(10, gainDb / 20);
    if (projectedPeak > ceilingLinear) {
      gainDb = 20 * Math.log10(ceilingLinear / peakLinear);
    }
  }
  return Math.round(gainDb * 100) / 100;
}

/**
 * 1つの発話区間(元動画基準の秒)のゲインを測定する。
 * 短すぎる区間(0.5秒未満)は正確に測定できないため 0dB を返す。
 */
export async function measureSegmentGain(audioBuffer, startSec, endSec, targetLufs, opts = {}) {
  const durationSec = endSec - startSec;
  if (durationSec < 0.5) return 0;

  const samples = await extractForMeasurement(audioBuffer, startSec, endSec);
  const measuredLufs = lufsFromSamples(samples);
  let peakLinear = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peakLinear) peakLinear = v;
  }
  return computeGainFromMeasurement(measuredLufs, peakLinear, targetLufs, opts);
}

export const LUFS_PRESETS = {
  youtube: -14,
  tiktok_instagram: -12,
  podcast: -16,
};
