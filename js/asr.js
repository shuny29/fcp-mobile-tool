// asr.js
// Transformers.js (Hugging Face) を使い、端末内(ブラウザのWASM)だけで
// 日本語の音声認識を行う。初回のみモデルをダウンロードし、以降はキャッシュから読み込む。

import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";

// ローカルモデル探索はしない(全部CDN+ブラウザキャッシュ経由)
env.allowLocalModels = false;
// COOP/COEPヘッダが無い環境(このPWAはヘッダ設定不要な単純ホスティングを想定)でも
// 動くように、マルチスレッドを前提にしない
env.backends.onnx.wasm.numThreads = 1;

let asrPipelinePromise = null;
let currentModelId = null;

// 精度と速度のバランスで選べるモデル一覧(すべて多言語対応・日本語OK)
export const MODEL_OPTIONS = {
  tiny: { id: "Xenova/whisper-tiny", label: "軽量・高速(tiny, 約75MB)" },
  base: { id: "Xenova/whisper-base", label: "標準(base, 約145MB)" },
  small: { id: "Xenova/whisper-small", label: "高精度・低速(small, 約485MB)" },
};

export function getAsrPipeline(modelKey = "base", onProgress = null) {
  const modelId = (MODEL_OPTIONS[modelKey] || MODEL_OPTIONS.base).id;
  if (asrPipelinePromise && currentModelId === modelId) {
    return asrPipelinePromise;
  }
  currentModelId = modelId;
  asrPipelinePromise = pipeline("automatic-speech-recognition", modelId, {
    progress_callback: onProgress || undefined,
  });
  return asrPipelinePromise;
}

/**
 * 16kHzモノラルのFloat32Array音声を文字起こしする。
 * @returns {Promise<{text: string, chunks: Array<{text:string, timestamp:[number,number]}>}>}
 */
export async function transcribeFloat32(pipe, float32Audio) {
  const result = await pipe(float32Audio, {
    language: "japanese",
    task: "transcribe",
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  });
  // 単一チャンクで timestamps が付かない場合のフォールバック
  if (!result.chunks) {
    return { text: result.text, chunks: [{ text: result.text, timestamp: [0, float32Audio.length / 16000] }] };
  }
  return result;
}

/**
 * 元のAudioBufferから指定区間を16kHzモノラルにリサンプリングして取り出す。
 * ブラウザ標準のOfflineAudioContextによる高品質リサンプリングを利用。
 */
export async function extractResampled16k(audioBuffer, startSec, endSec) {
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

  const targetRate = 16000;
  const targetLength = Math.max(1, Math.ceil((length / originalRate) * targetRate));
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const offlineCtx = new OfflineCtx(1, targetLength, targetRate);

  const sliceBuffer = offlineCtx.createBuffer(1, length, originalRate);
  sliceBuffer.copyToChannel(monoSlice, 0);

  const src = offlineCtx.createBufferSource();
  src.buffer = sliceBuffer;
  src.connect(offlineCtx.destination);
  src.start();

  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}
