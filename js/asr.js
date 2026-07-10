// asr.js
// Transformers.js (Hugging Face) を使い、端末内(ブラウザ)だけで
// 日本語の音声認識を行う。初回のみモデルをダウンロードし、以降はキャッシュから読み込む。
//
// モデルは単一(base)に固定している。以前はtiny/base/smallを選べたが、
// tinyは精度が実用に耐えず、base/smallはWASM(CPU)実行だとメモリ不足で
// クラッシュすることがあったため、選択肢を無くし、その代わりに
// 対応端末では高速・省メモリなWebGPUで実行し、非対応の場合だけ
// 従来のWASMにフォールバックする方式にした。WebGPUの方がクラッシュ
// しにくく、精度(=モデルサイズ)を落とさずに済む可能性が高い。

import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";

// ローカルモデル探索はしない(全部CDN+ブラウザキャッシュ経由)
env.allowLocalModels = false;
// COOP/COEPヘッダが無い環境(このPWAはヘッダ設定不要な単純ホスティングを想定)でも
// 動くように、WASM実行時はマルチスレッドを前提にしない
env.backends.onnx.wasm.numThreads = 1;

const MODEL_ID = "Xenova/whisper-base";

let asrPipelinePromise = null;
let activeDevice = null; // "webgpu" | "wasm" (実際に使われている方式。診断表示用)

export function getActiveDevice() {
  return activeDevice;
}

async function isWebGpuAvailable() {
  try {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

export function getAsrPipeline(onProgress = null) {
  if (asrPipelinePromise) return asrPipelinePromise;

  asrPipelinePromise = (async () => {
    const webgpuOk = await isWebGpuAvailable();
    if (webgpuOk) {
      try {
        const pipe = await pipeline("automatic-speech-recognition", MODEL_ID, {
          device: "webgpu",
          progress_callback: onProgress || undefined,
        });
        activeDevice = "webgpu";
        return pipe;
      } catch (err) {
        console.warn("WebGPUでの初期化に失敗、WASMにフォールバックします:", err);
      }
    }
    const pipe = await pipeline("automatic-speech-recognition", MODEL_ID, {
      progress_callback: onProgress || undefined,
    });
    activeDevice = "wasm";
    return pipe;
  })();

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
    // 同じフレーズを繰り返してしまう(ハルシネーション)現象を抑えるための設定。
    no_repeat_ngram_size: 3,
    repetition_penalty: 1.3,
    condition_on_previous_text: false,
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
