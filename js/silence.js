// silence.js
// Web Audio API で動画ファイルの音声をデコードし、無音区間を検出する。
// pydub.silence.detect_nonsilent と同じ考え方をブラウザ用に実装したもの。

const FRAME_MS = 20; // 解析の最小単位(ミリ秒)

/**
 * File/Blob から AudioBuffer にデコードする。
 * iPhoneで撮影した.mov/.mp4は、Safari(WebKit)のdecodeAudioDataで概ねデコード可能。
 */
export async function decodeAudioFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    return audioBuffer;
  } finally {
    // decodeAudioDataだけならcloseしてよい(iOSはAudioContext数に上限があるため)
    ctx.close();
  }
}

function mixToMono(audioBuffer) {
  const numCh = audioBuffer.numberOfChannels;
  if (numCh === 1) return audioBuffer.getChannelData(0);
  const len = audioBuffer.length;
  const out = new Float32Array(len);
  for (let ch = 0; ch < numCh; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < len; i++) out[i] += data[i] / numCh;
  }
  return out;
}

/**
 * 発話区間(=無音でない区間)を検出する。
 * @returns [{startMs, endMs}, ...] 元の音声全体を基準にした発話区間のリスト
 */
export function detectSpeechSegments(audioBuffer, { threshDb, minSilenceLenMs, paddingMs }) {
  const sampleRate = audioBuffer.sampleRate;
  const mono = mixToMono(audioBuffer);
  const totalMs = (audioBuffer.length / sampleRate) * 1000;

  const frameSize = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const threshLinear = Math.pow(10, threshDb / 20); // dBFS -> 振幅比

  const frameCount = Math.ceil(mono.length / frameSize);
  const isSilentFrame = new Uint8Array(frameCount);

  for (let f = 0; f < frameCount; f++) {
    const start = f * frameSize;
    const end = Math.min(start + frameSize, mono.length);
    let sumSq = 0;
    for (let k = start; k < end; k++) sumSq += mono[k] * mono[k];
    const rms = Math.sqrt(sumSq / (end - start));
    isSilentFrame[f] = rms < threshLinear ? 1 : 0;
  }

  const minSilenceFrames = Math.max(1, Math.ceil(minSilenceLenMs / FRAME_MS));

  // 一定長以上続く無音フレームの区間だけを「本当の無音」として抽出
  const silenceRangesMs = [];
  let runStart = null;
  for (let f = 0; f <= frameCount; f++) {
    const silent = f < frameCount ? isSilentFrame[f] === 1 : false;
    if (silent) {
      if (runStart === null) runStart = f;
    } else if (runStart !== null) {
      if (f - runStart >= minSilenceFrames) {
        silenceRangesMs.push([runStart * FRAME_MS, Math.min(f * FRAME_MS, totalMs)]);
      }
      runStart = null;
    }
  }

  // 無音区間の補集合 = 発話区間
  const speech = [];
  let cursor = 0;
  for (const [s, e] of silenceRangesMs) {
    if (s > cursor) speech.push([cursor, s]);
    cursor = e;
  }
  if (cursor < totalMs) speech.push([cursor, totalMs]);

  // 余白(padding)を追加してから、重なった区間をマージ
  const padded = speech.map(([s, e]) => [
    Math.max(0, s - paddingMs),
    Math.min(totalMs, e + paddingMs),
  ]);

  const merged = [];
  for (const seg of padded) {
    if (merged.length && seg[0] <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], seg[1]);
    } else {
      merged.push(seg);
    }
  }

  return merged.map(([startMs, endMs]) => ({ startMs, endMs }));
}

export function summarizeCut(totalMs, keptSegments) {
  const keptMs = keptSegments.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
  return {
    originalSec: totalMs / 1000,
    keptSec: keptMs / 1000,
    cutSec: (totalMs - keptMs) / 1000,
    cutRatio: totalMs ? (totalMs - keptMs) / totalMs : 0,
    segmentCount: keptSegments.length,
  };
}
