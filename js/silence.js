// silence.js
// Web Audio API で動画ファイルの音声をデコードし、無音区間を検出する。
// pydub.silence.detect_nonsilent と同じ考え方をブラウザ用に実装したもの。

const FRAME_MS = 20; // 解析の最小単位(ミリ秒)

/**
 * File/Blob から「AudioBufferと同じインターフェースを持つオブジェクト」にデコードする。
 *
 * iPhoneで撮影した.mov/.mp4(映像+音声が1つのコンテナに入ったファイル)は、
 * Safari の decodeAudioData では失敗することが多い(音声単体のファイルに比べて
 * サポートが不安定なため)。そのため、まず高速な decodeAudioData を試し、
 * 失敗した場合は <video> 要素で実際に再生しながら音声を捕まえる
 * (=リアルタイムキャプチャ)方式にフォールバックする。
 *
 * @param {File} file
 * @param {(progress:number, phase:string) => void} [onProgress] 0〜1の進捗とフェーズ名
 */
export async function decodeAudioFile(file, onProgress = null) {
  try {
    return await decodeViaDecodeAudioData(file);
  } catch (err) {
    console.warn("decodeAudioData に失敗、リアルタイムキャプチャ方式にフォールバックします:", err);
    onProgress?.(0, "fallback");
    return await decodeViaRealtimeCapture(file, onProgress);
  }
}

async function decodeViaDecodeAudioData(file) {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    // Safariでは arrayBuffer が detach されると再利用できないため、コピーを渡す
    return await ctx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    ctx.close();
  }
}

/**
 * <video>要素で実際に(等速で)再生し、Web AudioのScriptProcessorNodeで
 * PCMサンプルを取りこぼしなく捕まえる。動画コンテナのデコードに関する
 * ブラウザの相性問題を回避できる、最も互換性の高い方法。
 * ※ 動画の長さぶんだけ実時間がかかる点に注意(ミュート再生のため音は出ない)。
 */
function decodeViaRealtimeCapture(file, onProgress) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const videoEl = document.createElement("video");
    videoEl.src = url;
    videoEl.muted = true;           // ミュート再生はユーザー操作なしでも許可される
    videoEl.playsInline = true;     // iOSでフルスクリーン強制再生になるのを防ぐ
    videoEl.setAttribute("webkit-playsinline", "true");
    videoEl.preload = "auto";
    // 画面には映さない(が、非表示にしすぎるとデコードが止まる端末があるため
    // display:none ではなく画面外に配置する)
    Object.assign(videoEl.style, {
      position: "fixed", left: "-9999px", top: "0", width: "1px", height: "1px", opacity: "0",
    });
    document.body.appendChild(videoEl);

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const chunks = [];
    let totalSamples = 0;
    let settled = false;

    function cleanup() {
      try { processor.disconnect(); } catch {}
      try { source.disconnect(); } catch {}
      try { silentGain.disconnect(); } catch {}
      try { ctx.close(); } catch {}
      videoEl.pause();
      videoEl.remove();
      URL.revokeObjectURL(url);
    }

    function finish() {
      if (settled) return;
      settled = true;
      const mono = new Float32Array(totalSamples);
      let offset = 0;
      for (const chunk of chunks) {
        mono.set(chunk, offset);
        offset += chunk.length;
      }
      const sampleRate = ctx.sampleRate;
      cleanup();
      resolve({
        sampleRate,
        numberOfChannels: 1,
        length: mono.length,
        duration: mono.length / sampleRate,
        getChannelData: () => mono,
      });
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }

    let source, processor, silentGain;

    videoEl.addEventListener("error", () => {
      fail(new Error("動画の読み込みに失敗しました(コーデック非対応の可能性があります)"));
    });

    videoEl.addEventListener("loadedmetadata", () => {
      try {
        source = ctx.createMediaElementSource(videoEl);
        processor = ctx.createScriptProcessor(4096, 1, 1);
        // ScriptProcessorNodeはdestinationに繋がないとonaudioprocessが発火しない
        // ブラウザがあるため、音量0のGainNodeを経由させて無音のまま繋ぐ
        silentGain = ctx.createGain();
        silentGain.gain.value = 0;

        source.connect(processor);
        processor.connect(silentGain);
        silentGain.connect(ctx.destination);

        processor.onaudioprocess = (e) => {
          const input = e.inputBuffer;
          const numCh = input.numberOfChannels;
          const frameLen = input.length;
          const mixed = new Float32Array(frameLen);
          for (let ch = 0; ch < numCh; ch++) {
            const data = input.getChannelData(ch);
            for (let i = 0; i < frameLen; i++) mixed[i] += data[i] / numCh;
          }
          chunks.push(mixed);
          totalSamples += frameLen;

          if (videoEl.duration) {
            onProgress?.(Math.min(1, videoEl.currentTime / videoEl.duration), "capturing");
          }
        };

        videoEl.play().catch((playErr) => fail(playErr));
      } catch (err) {
        fail(err);
      }
    });

    videoEl.addEventListener("ended", finish);
    // 一部端末で ended が発火しないケースの保険として、再生位置が
    // 動画長にほぼ到達した時点でも完了扱いにする
    videoEl.addEventListener("timeupdate", () => {
      if (videoEl.duration && videoEl.currentTime >= videoEl.duration - 0.05) {
        finish();
      }
    });
  });
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
