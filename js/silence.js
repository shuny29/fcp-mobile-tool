// silence.js
// Web Audio API で動画ファイルの音声をデコードし、無音区間を検出する。
// pydub.silence.detect_nonsilent と同じ考え方をブラウザ用に実装したもの。

const FRAME_MS = 20; // 解析の最小単位(ミリ秒)
const ATTACK_MS = 10;    // 包絡線の立ち上がりの速さ(発話の始まりを素早く捉える)
const RELEASE_MS = 60;   // 包絡線の減衰の速さ(短すぎる瞬間的な音量低下では反応しないための最小限の平滑化)
const HYSTERESIS_DB = 0; // 「発話に戻る」しきい値と「無音に入る」しきい値を同じにしてある。
                          // 差を付ける(ヒステリシス)と、録音中に声量が変化した際や
                          // 語尾の余韻の場面で「一度無音と判定されると発話に戻れなくなる」
                          // 重大な不具合が起きたため、対称なしきい値に変更した。
                          // 短い揺らぎでの誤カットは、包絡線の平滑化(RELEASE_MS)と
                          // 最小無音長(AUTO_MIN_SILENCE_MS)側で防いでいる。

/**
 * ユーザー操作(ファイル選択)の直後、間を置かずにAudioContextを作成し
 * resume()を呼んでおく。iOS Safariでは「ユーザー操作の有効期限」が短く、
 * ファイル読み込みなどの非同期処理を挟んでからAudioContextを作る/resumeすると
 * 手遅れになり、音声を1サンプルも取得できない不具合があったため、
 * この関数は videoInput の change イベントハンドラの一番最初、
 * 他の await より前に呼び出すこと。
 */
export function primeAudioContext() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    ctx.resume().catch(() => {});
    return ctx;
  } catch (err) {
    console.warn("AudioContextの事前確保に失敗しました:", err);
    return null;
  }
}

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
 * @param {AudioContext} [primedCtx] primeAudioContext()で事前に確保しておいたcontext
 */
export async function decodeAudioFile(file, onProgress = null, primedCtx = null) {
  try {
    // decodeAudioDataは動画コンテナに対してはタイムアウトなしで長時間
    // 応答が返らないことがあるため、一定時間で見切りをつけてフォールバックする
    return await withTimeout(decodeViaDecodeAudioData(file), 4000, "decodeAudioData timeout");
  } catch (err) {
    console.warn("decodeAudioData に失敗/タイムアウト、リアルタイムキャプチャ方式にフォールバックします:", err);
    onProgress?.(0, "fallback");
    return await decodeViaRealtimeCapture(file, onProgress, primedCtx);
  }
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
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
function decodeViaRealtimeCapture(file, onProgress, primedCtx = null) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);

    // 以前は既存のプレビュー要素を使い回していたが、状態が残ってしまい
    // 動画の読み込みが固まる不具合の原因になっていた。サムネイル生成
    // (generateThumbnail)で確実に動いている「毎回新規作成し、画面内の
    // 小さな領域に配置する」方式に統一する。
    const videoEl = document.createElement("video");
    Object.assign(videoEl.style, {
      position: "fixed", right: "10px", bottom: "10px",
      width: "72px", height: "40px", borderRadius: "6px",
      zIndex: "9999", background: "#000",
    });
    document.body.appendChild(videoEl);

    videoEl.src = url;
    // 自動再生の許可を確実に得るため、開始時点ではミュートにしておく
    // (ミュート再生はユーザー操作なしでも許可されるため)。ただし、
    // ミュートのままだとブラウザによってはcreateMediaElementSourceで
    // Web Audio側に渡される音声データ自体まで減衰・消音してしまい、
    // 長い動画のキャプチャがほぼ無音として取得される重大な不具合があった。
    // そのため、実際に再生が始まった直後(下記の'playing'イベント)で
    // すぐにミュートを解除する。実際に音が聞こえないのは、後段のWeb Audio
    // グラフ内のsilentGain(gain=0)で担保している。
    videoEl.muted = true;
    videoEl.playsInline = true;     // iOSでフルスクリーン強制再生になるのを防ぐ
    videoEl.setAttribute("webkit-playsinline", "true");
    videoEl.preload = "auto";

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    // 事前に確保済みのAudioContext(primeAudioContext)があればそれを使う。
    // ここで新規作成すると、ユーザー操作から時間が経ちすぎていて
    // resume()が効かない(iOSの有効期限切れ)ことがあったため。
    const ctx = (primedCtx && primedCtx.state !== "closed") ? primedCtx : new AudioCtx();
    const chunks = [];
    let totalSamples = 0;
    let settled = false;

    // iOS Safariでは新規AudioContextが「サスペンド状態」のまま始まることがあり、
    // その場合 onaudioprocess が一切発火せず、音声を1サンプルも捕まえられない
    // (totalSamples=0のまま完了してしまう)バグの原因になっていた。
    // 明示的にresume()して、確実に「再生中」状態にしてから処理を始める。
    async function ensureRunning() {
      if (ctx.state !== "running") {
        try { await ctx.resume(); } catch (err) { console.warn("AudioContext.resume() failed:", err); }
      }
    }

    let watchdogTimer = null;

    // メタデータ取得(loadedmetadataイベント)自体が発火しないまま固まる
    // ケースへの保険。動画の長さに応じたウォッチドッグはメタデータ取得後にしか
    // 設定できないため、それより前の段階でも必ず打ち切れるようにしておく。
    const startupWatchdog = setTimeout(() => {
      fail(new Error("動画の読み込みがタイムアウトしました(対応していない形式の可能性があります)。別の動画でお試しください。"));
    }, 25000);

    function cleanup() {
      try { processor.disconnect(); } catch {}
      try { source.disconnect(); } catch {}
      try { silentGain.disconnect(); } catch {}
      try { ctx.close(); } catch {}
      if (watchdogTimer) clearTimeout(watchdogTimer);
      clearTimeout(startupWatchdog);
      videoEl.pause();
      videoEl.remove();
      URL.revokeObjectURL(url);
    }

    function finish() {
      if (settled) return;
      if (totalSamples === 0) {
        fail(new Error("音声データを取得できませんでした(端末の自動再生制限が原因の可能性があります)。もう一度お試しください。"));
        return;
      }
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
      (async () => {
        try {
          await ensureRunning();

          source = ctx.createMediaElementSource(videoEl);
          processor = ctx.createScriptProcessor(4096, 1, 1);
          // ScriptProcessorNodeはdestinationに繋がないとonaudioprocessが発火しない
          // ブラウザがあるため、音量0のGainNodeを経由させて無音のまま繋ぐ
          silentGain = ctx.createGain();
          silentGain.gain.value = 0;

          source.connect(processor);
          processor.connect(silentGain);
          silentGain.connect(ctx.destination);

          let sawAnySample = false;
          processor.onaudioprocess = (e) => {
            sawAnySample = true;
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

          // 念のため再生開始前後にもう一度resumeを試みる(端末によっては
          // play()呼び出し後でないと本当のrunning状態に移行しないことがある)
          await ensureRunning();
          await videoEl.play();
          await ensureRunning();
          // 再生が実際に始まったので、ここでミュートを解除する
          // (Web Audioに渡る音声データが減衰しないようにするため。
          // スピーカーから実際に音が出ることはsilentGainで防いでいる)
          videoEl.muted = false;

          // ウォッチドッグ: 動画の長さの3倍+20秒を超えても終わらない場合は、
          // 再生が固まっている(iOSが非表示動画の再生を止めた等)とみなして
          // 明確なエラーで打ち切る。無言で無限に待ち続けるのを防ぐ。
          // ここまで進んだ時点で「起動時ウォッチドッグ」の役目は終わっている
          // ため解除する(解除し忘れていたせいで、動画の長さに関わらず
          // 常に25秒でタイムアウトしてしまう重大な不具合があった)。
          clearTimeout(startupWatchdog);
          const durationSec = videoEl.duration && isFinite(videoEl.duration) ? videoEl.duration : 60;
          watchdogTimer = setTimeout(() => {
            fail(new Error("動画の再生が進まないため処理を中断しました(端末側で再生が停止した可能性があります)。もう一度お試しください。"));
          }, (durationSec * 3 + 20) * 1000);

          // 1秒経ってもonaudioprocessが一度も発火していない場合は、
          // AudioContextが依然サスペンドされている可能性が高いため、
          // もう一度resumeを試みる(自動リトライ)
          setTimeout(async () => {
            if (!sawAnySample && !settled) {
              console.warn("音声フレームが未取得のため、AudioContextの再開を再試行します");
              await ensureRunning();
            }
          }, 1000);
        } catch (err) {
          fail(err);
        }
      })();
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

// ---------------------------------------------------------------------
// 声の検出(設定不要): 人の声の帯域だけを取り出し、クリップ自身の音量分布から
// 自動でしきい値を決める。ユーザーが数値を調整する必要をなくすための実装。
// ---------------------------------------------------------------------

const AUTO_MIN_SILENCE_MS = 1200; // これより長く声が途切れたら無音区間として扱う(短い間は残す)
const AUTO_PADDING_MS = 350;     // 発話の前後に残す余白(語尾の余韻を残すため多めに)
const NOISE_PERCENTILE = 0.15;   // 「暗騒音」の目安として使う音量分布の下側パーセンタイル
const SPEECH_PERCENTILE = 0.60;  // 「発話」の目安として使う音量分布の上側パーセンタイル。
                                  // 高すぎると、クリップ内で一番大きい声だけを基準にしてしまい、
                                  // それより静かな(が正当な)発話が無音側に埋もれてしまうため、
                                  // やや低めにしてある。
const THRESHOLD_MIX = 0.08;      // 暗騒音〜発話の間のどこにしきい値を置くか(0=暗騒音寄り,1=発話寄り)。
                                  // 実際の録音で「語尾の余韻」まで無音と誤判定される
                                  // 事例があったため、より暗騒音寄りに調整している。

// 検出「後」に区間ごとの音量を均すための設定(検出結果には一切影響しない)
const GAIN_MAX_BOOST_DB = 15;  // 持ち上げすぎるとノイズも増幅するため上限を設ける
const GAIN_MAX_CUT_DB = 10;

// 声の帯域(だいたい100Hz〜4000Hz)だけを残すシンプルなハイパス+ローパス。
// 低い暗騒音(空調音等)や高域のヒスノイズを声だと誤検出しないようにする。
function onePoleHighpass(samples, sampleRate, cutoffHz) {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  const alpha = rc / (rc + dt);
  const out = new Float32Array(samples.length);
  let prevIn = samples[0] || 0;
  let prevOut = 0;
  for (let i = 1; i < samples.length; i++) {
    prevOut = alpha * (prevOut + samples[i] - prevIn);
    prevIn = samples[i];
    out[i] = prevOut;
  }
  return out;
}

function onePoleLowpass(samples, sampleRate, cutoffHz) {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  const alpha = dt / (rc + dt);
  const out = new Float32Array(samples.length);
  let prev = samples[0] || 0;
  out[0] = prev;
  for (let i = 1; i < samples.length; i++) {
    prev = prev + alpha * (samples[i] - prev);
    out[i] = prev;
  }
  return out;
}

function isolateVoiceBand(mono, sampleRate) {
  const hp = onePoleHighpass(mono, sampleRate, 100);
  return onePoleLowpass(hp, sampleRate, 4000);
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.floor(p * (sortedArr.length - 1))));
  return sortedArr[idx];
}

/**
 * 発話区間(=無音でない区間)を自動検出する。設定値は一切不要。
 *
 * 手順:
 * 1) 人の声の帯域だけを取り出す(空調音やヒスノイズを声と誤認しないため)
 * 2) フレームごとの音量(RMS)を計算し、アタック/リリースで包絡線を平滑化
 *    (語尾や子音での瞬間的な音量低下を無音と誤判定しないため)
 * 3) このクリップ自身の音量分布(生の信号)から「暗騒音」と「発話」の
 *    目安を求め、その間にしきい値を自動的に置く
 * 4) ヒステリシス付きで無音/発話を判定し、短すぎる無音は無視する
 * 5) 冒頭の無音はカットの対象から外す(先頭は必ず0から残す)
 * 6) 無音検出の結果が確定した「後」に、各発話区間の音量調整量(dB)を
 *    別途計算する(人の声を一律同じ音量にするため)。この計算は検出結果に
 *    一切影響しない(以前、検出の前に音量を均す方式を試したが、区間の
 *    一部が誤って無音判定されてしまう重大な不具合があったため、検出とは
 *    完全に切り離す設計に変更した)。
 *
 * @returns [{startMs, endMs, gainDb}, ...] 元の音声全体を基準にした発話区間のリスト
 */
export function detectSpeechSegments(audioBuffer) {
  const sampleRate = audioBuffer.sampleRate;
  const monoRaw = mixToMono(audioBuffer);
  const totalMs = (audioBuffer.length / sampleRate) * 1000;

  const voiceBand = isolateVoiceBand(monoRaw, sampleRate);
  const frameSize = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const frameCount = Math.ceil(voiceBand.length / frameSize);

  const frameRms = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const start = f * frameSize;
    const end = Math.min(start + frameSize, voiceBand.length);
    let sumSq = 0;
    for (let k = start; k < end; k++) sumSq += voiceBand[k] * voiceBand[k];
    frameRms[f] = Math.sqrt(sumSq / (end - start));
  }

  const attackCoeff = Math.exp(-1 / (ATTACK_MS / FRAME_MS));
  const releaseCoeff = Math.exp(-1 / (RELEASE_MS / FRAME_MS));
  const envelope = new Float32Array(frameCount);
  let env = frameRms[0] || 0;
  for (let f = 0; f < frameCount; f++) {
    const x = frameRms[f];
    const coeff = x > env ? attackCoeff : releaseCoeff;
    env = coeff * env + (1 - coeff) * x;
    envelope[f] = env;
  }

  const sorted = envelope.slice().sort();
  const noiseFloor = percentile(sorted, NOISE_PERCENTILE);
  const speechLevel = percentile(sorted, SPEECH_PERCENTILE);
  const range = Math.max(speechLevel - noiseFloor, 1e-6);
  const enterSilenceLinear = noiseFloor + range * THRESHOLD_MIX;
  const exitSilenceLinear = enterSilenceLinear * Math.pow(10, HYSTERESIS_DB / 20);

  // 診断情報(デバッグ表示用)。実際にこのクリップで計算された値を
  // 確認できるようにしておく(合成テストと実際の音声のズレを
  // 見分けるため)。
  const toDb = (linear) => (linear > 1e-9 ? 20 * Math.log10(linear) : -180);
  const envMax = envelope.reduce((a, b) => Math.max(a, b), 0);
  const debugInfo = {
    noiseFloorDb: Math.round(toDb(noiseFloor) * 10) / 10,
    speechLevelDb: Math.round(toDb(speechLevel) * 10) / 10,
    enterThresholdDb: Math.round(toDb(enterSilenceLinear) * 10) / 10,
    exitThresholdDb: Math.round(toDb(exitSilenceLinear) * 10) / 10,
    envelopeMaxDb: Math.round(toDb(envMax) * 10) / 10,
    frameCount,
  };

  const isSilentFrame = new Uint8Array(frameCount);
  let stateSilent = envelope[0] < enterSilenceLinear;
  for (let f = 0; f < frameCount; f++) {
    if (stateSilent) {
      if (envelope[f] >= exitSilenceLinear) stateSilent = false;
    } else {
      if (envelope[f] < enterSilenceLinear) stateSilent = true;
    }
    isSilentFrame[f] = stateSilent ? 1 : 0;
  }

  const minSilenceFrames = Math.max(1, Math.ceil(AUTO_MIN_SILENCE_MS / FRAME_MS));

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

  const speech = [];
  let cursor = 0;
  for (const [s, e] of silenceRangesMs) {
    if (s > cursor) speech.push([cursor, s]);
    cursor = e;
  }
  if (cursor < totalMs) speech.push([cursor, totalMs]);

  // 冒頭の無音はカットの対象から外す(最初の区間の開始を0まで広げて残す)
  if (speech.length && speech[0][0] > 0) {
    speech[0][0] = 0;
  } else if (!speech.length && totalMs > 0) {
    // 発話が1つも検出できなかった場合のフォールバック: 全体を残す
    speech.push([0, totalMs]);
  }

  const padded = speech.map(([s, e]) => [
    Math.max(0, s - AUTO_PADDING_MS),
    Math.min(totalMs, e + AUTO_PADDING_MS),
  ]);

  const merged = [];
  for (const seg of padded) {
    if (merged.length && seg[0] <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], seg[1]);
    } else {
      merged.push(seg);
    }
  }

  if (!merged.length) {
    const empty = [];
    empty.debug = debugInfo;
    return empty;
  }

  // 6) 検出が確定した後で、区間ごとの音量調整量(dB)を計算する。
  //    各区間の平均音量を測り、区間同士の「中央値」に揃えるためのゲインを
  //    求める(人の声を一律同じ音量にするため)。この処理は検出結果には
  //    一切影響しない。
  const segLevels = merged.map(([startMs, endMs]) => {
    const startSample = Math.max(0, Math.floor((startMs / 1000) * sampleRate));
    const endSample = Math.min(voiceBand.length, Math.floor((endMs / 1000) * sampleRate));
    let sumSq = 0;
    let count = 0;
    for (let k = startSample; k < endSample; k++) {
      sumSq += voiceBand[k] * voiceBand[k];
      count++;
    }
    return count > 0 ? Math.sqrt(sumSq / count) : 0;
  });

  const sortedLevels = segLevels.slice().sort((a, b) => a - b);
  const targetLevel = Math.max(percentile(sortedLevels, 0.5), 1e-6);
  const maxBoostLinear = Math.pow(10, GAIN_MAX_BOOST_DB / 20);
  const maxCutLinear = Math.pow(10, -GAIN_MAX_CUT_DB / 20);

  const result = merged.map(([startMs, endMs], i) => {
    const level = segLevels[i];
    let gainLinear = level > 1e-6 ? targetLevel / level : 1;
    gainLinear = Math.min(maxBoostLinear, Math.max(maxCutLinear, gainLinear));
    const gainDb = Math.round(20 * Math.log10(gainLinear) * 10) / 10;
    return { startMs, endMs, gainDb };
  });
  result.debug = debugInfo;
  return result;
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
