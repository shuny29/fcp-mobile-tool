// app.js
import * as learning from "./learning.js";
import * as silence from "./silence.js";
import * as asr from "./asr.js";
import * as exporter from "./export.js";
import * as loudness from "./loudness.js";

const $ = (id) => document.getElementById(id);

// --- アプリの状態 ---
let videoFile = null;
let audioBuffer = null;
let keptSegments = []; // [{startMs, endMs, include, gainDb?}]
let captionSegments = []; // [{start, end, text, originalText}] (元動画のタイムライン基準)

// ---------------------------------------------------------------------
// セグメントコントロール(<select>の代わりのピルボタン群)
// ---------------------------------------------------------------------
function setupSegmented(containerId) {
  const el = $(containerId);
  el.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-value]");
    if (!btn) return;
    el.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    el.dataset.value = btn.dataset.value;
  });
}
function getSegmented(containerId) {
  return $(containerId).dataset.value;
}
setupSegmented("modelSegmented");
setupSegmented("lufsSegmented");

// ---------------------------------------------------------------------
// ステップ進捗ドット(ヘッダー)とパネルの開閉制御
// ---------------------------------------------------------------------
function goToStep(stepNumber, panelId) {
  document.querySelectorAll(".step-dot").forEach((dot) => {
    const n = Number(dot.dataset.step);
    dot.classList.toggle("active", n === stepNumber);
    dot.classList.toggle("done", n < stepNumber);
  });
  const panel = $(panelId);
  panel.hidden = false;
  panel.open = true;
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function markPanelComplete(panelId) {
  $(panelId).dataset.complete = "true";
}

// ---------------------------------------------------------------------
// Step1: 動画選択 + サムネイル表示(アップロードエリアのアイコン枠に表示)
// ---------------------------------------------------------------------
function resetFileIcon() {
  const svg = $("fileIconSvg");
  svg.hidden = false;
  svg.style.display = "";
  $("fileThumbImg").hidden = true;
  $("playBadge").hidden = true;
}

$("videoInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  // iOSでは、ユーザー操作(ファイル選択)からできるだけ間を置かずに
  // AudioContextを確保しておかないと、この後の非同期処理(サムネイル生成や
  // ファイル読み込み)を経るうちに「ユーザー操作の有効期限」が切れてしまい、
  // 音声を1サンプルも取得できなくなる不具合があった。そのため、他のawaitより
  // 前、一番最初にここで確保しておく。
  const primedCtx = silence.primeAudioContext();

  videoFile = file;
  $("videoLabel").textContent = file.name;
  $("videoInfo").textContent = "サムネイルを生成中...";
  resetFileIcon();

  // サムネイルは動画の選択が完了した時点ですぐに表示する
  try {
    const dataUrl = await generateThumbnail(file);
    showThumbnailInIcon(dataUrl);
  } catch (err) {
    console.warn("サムネイル生成に失敗:", err);
  }

  $("videoInfo").textContent = "音声を解析しています...";

  try {
    audioBuffer = await silence.decodeAudioFile(file, (progress, phase) => {
      if (phase === "fallback") {
        $("videoInfo").textContent = "通常の方法で読み込めなかったため、再生しながら解析します... 0%";
      } else if (phase === "capturing") {
        $("videoInfo").textContent = `動画を再生しながら音声を解析中... ${Math.round(progress * 100)}%`;
      }
    }, primedCtx);
    const durationSec = audioBuffer.duration.toFixed(1);
    $("videoInfo").textContent = `${durationSec}秒 読み込み完了`;
    markPanelComplete("step-pick");
    await runAutoDetection();
  } catch (err) {
    console.error(err);
    $("videoInfo").textContent =
      `音声の読み込みに失敗しました(${err.message || "不明なエラー"})。別の動画でお試しください。`;
  }
});

// 動画の一場面を切り出して静止画(サムネイル)にする
function generateThumbnail(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    // 画面外に配置しつつ、DOMには接続しておく(接続されていない<video>は
    // 一部端末でイベントが正しく発火せず、処理が固まる原因になるため)
    Object.assign(video.style, {
      position: "fixed", left: "-9999px", top: "0", width: "2px", height: "2px",
    });
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("webkit-playsinline", "true");
    video.preload = "metadata";
    document.body.appendChild(video);

    let settledFlag = false;
    const settle = (fn, val) => {
      if (settledFlag) return;
      settledFlag = true;
      clearTimeout(timeoutTimer);
      URL.revokeObjectURL(url);
      video.remove();
      fn(val);
    };

    // サムネイル生成が万一固まっても、他の処理をブロックしないための保険
    const timeoutTimer = setTimeout(() => {
      settle(reject, new Error("サムネイル生成がタイムアウトしました"));
    }, 8000);

    video.src = url;
    video.addEventListener("loadedmetadata", () => {
      const seekTo = Math.min(0.3, (video.duration || 1) / 2);
      try { video.currentTime = seekTo; } catch { /* noop */ }
    });
    video.addEventListener("seeked", () => {
      try {
        const w = 160;
        const ratio = (video.videoHeight && video.videoWidth) ? video.videoHeight / video.videoWidth : 9 / 16;
        const h = Math.max(1, Math.round(w * ratio));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(video, 0, 0, w, h);
        settle(resolve, canvas.toDataURL("image/jpeg", 0.82));
      } catch (err) {
        settle(reject, err);
      }
    });
    video.addEventListener("error", () => settle(reject, new Error("サムネイル生成に失敗しました")));
  });
}

// 生成したサムネイル(静止画)を、アップロードエリアのアイコン枠に永続表示する
function showThumbnailInIcon(dataUrl) {
  $("fileThumbImg").src = dataUrl;
  const svg = $("fileIconSvg");
  svg.hidden = true;
  // hidden属性の[hidden]{display:none}がCSSの詳細度で上書きされる端末が
  // あった場合の保険として、インラインstyleでも直接非表示にする
  svg.style.display = "none";
  $("fileThumbImg").hidden = false;
  $("playBadge").hidden = false;
}

// ---------------------------------------------------------------------
// Step2: 無音区間の自動検出(設定不要・自動実行)
// ---------------------------------------------------------------------
async function runAutoDetection() {
  goToStep(2, "step-settings");
  $("autoDetectStatus").textContent = "音声を解析して無音区間を検出しています...";
  // ステータス文言を描画させてから重い処理に入る
  await new Promise((r) => requestAnimationFrame(r));

  const segments = silence.detectSpeechSegments(audioBuffer);
  keptSegments = segments.map((s) => ({ ...s, include: true }));

  const totalMs = audioBuffer.duration * 1000;
  const summary = silence.summarizeCut(totalMs, keptSegments);
  $("autoDetectStatus").textContent = "検出が完了しました";
  $("detectSummary").textContent =
    `元の長さ: ${summary.originalSec.toFixed(1)}秒 → カット後: ${summary.keptSec.toFixed(1)}秒` +
    `(削減率 ${(summary.cutRatio * 100).toFixed(1)}%, ${summary.segmentCount}区間)`;

  drawTimelineStrip(totalMs, keptSegments);
  $("timelineStripWrap").hidden = false;

  renderSegmentList();
  markPanelComplete("step-settings");
  goToStep(3, "step-segments");
}

// 署名要素: 無音カットの結果をひと目で把握できる波形ストリップ
function drawTimelineStrip(totalMs, segments) {
  const canvas = $("timelineStrip");
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 600;
  const cssHeight = 46;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const styles = getComputedStyle(document.documentElement);
  const teal = styles.getPropertyValue("--teal").trim() || "#33d1c2";
  const hairline = styles.getPropertyValue("--hairline").trim() || "#35363a";

  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.fillStyle = hairline;
  roundRect(ctx, 0, 16, cssWidth, 14, 4);
  ctx.fill();

  ctx.fillStyle = teal;
  for (const seg of segments) {
    const x = (seg.startMs / totalMs) * cssWidth;
    const w = Math.max(1.5, ((seg.endMs - seg.startMs) / totalMs) * cssWidth);
    roundRect(ctx, x, 16, w, 14, 3);
    ctx.fill();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function renderSegmentList() {
  const list = $("segmentList");
  list.innerHTML = "";
  keptSegments.forEach((seg, i) => {
    const row = document.createElement("div");
    row.className = "segment-item";
    let gainLabel = "";
    if (typeof seg.gainDb === "number" && Math.abs(seg.gainDb) > 0.05) {
      const cls = seg.gainDb >= 0 ? "boost" : "cut";
      gainLabel = `<span class="gain-tag ${cls}">${seg.gainDb >= 0 ? "+" : ""}${seg.gainDb.toFixed(1)}dB</span>`;
    }
    row.innerHTML = `
      <label class="check">
        <input type="checkbox" ${seg.include ? "checked" : ""} data-idx="${i}">
        <span class="box"></span>
      </label>
      <span class="time">${fmtTime(seg.startMs / 1000)}–${fmtTime(seg.endMs / 1000)}</span>
      ${gainLabel}
    `;
    row.querySelector("input").addEventListener("change", (e) => {
      keptSegments[i].include = e.target.checked;
    });
    list.appendChild(row);
  });
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return `${m}:${s.padStart(4, "0")}`;
}

// ---------------------------------------------------------------------
// Step3: 字幕自動生成 + 音量正規化
// ---------------------------------------------------------------------
$("btnTranscribe").addEventListener("click", async () => {
  const included = keptSegments.filter((s) => s.include);
  const statusLine = $("transcribeStatusLine");
  statusLine.hidden = false;

  if (included.length === 0) {
    $("transcribeStatus").textContent = "カットする区間しかありません。区間を選択してください。";
    return;
  }

  $("btnTranscribe").disabled = true;
  const progressEl = $("transcribeProgress");
  progressEl.hidden = false;
  progressEl.value = 0;

  $("transcribeStatus").textContent = "モデルを準備中(初回は数十MB〜のダウンロードがあります)...";
  const modelKey = getSegmented("modelSegmented");
  const pipe = await asr.getAsrPipeline(modelKey, (info) => {
    if (info.status === "progress" && info.total) {
      const pct = Math.round((info.loaded / info.total) * 100);
      $("transcribeStatus").textContent = `モデルをダウンロード中... ${pct}%`;
    }
  });

  captionSegments = [];
  for (let i = 0; i < included.length; i++) {
    const seg = included[i];
    $("transcribeStatus").textContent = `処理中... (${i + 1}/${included.length}) 音量解析+文字起こし`;
    progressEl.value = Math.round(((i) / included.length) * 100);

    const startSec = seg.startMs / 1000;
    const endSec = seg.endMs / 1000;

    // 音量正規化: この発話区間のラウドネスを測定し、目標値に合わせるゲインを算出
    // (実際の音声は書き換えず、FCPXMLの非破壊ゲインとして書き出す)
    const targetLufs = loudness.LUFS_PRESETS[getSegmented("lufsSegmented")];
    seg.gainDb = await loudness.measureSegmentGain(audioBuffer, startSec, endSec, targetLufs);

    const audio16k = await asr.extractResampled16k(audioBuffer, startSec, endSec);
    const result = await asr.transcribeFloat32(pipe, audio16k);

    for (const chunk of result.chunks) {
      const [relStart, relEnd] = chunk.timestamp;
      const text = learning.applyGlossary((chunk.text || "").trim());
      if (!text) continue;
      captionSegments.push({
        start: startSec + (relStart || 0),
        end: startSec + (relEnd != null ? relEnd : (endSec - startSec)),
        text,
        originalText: text,
      });
    }
  }

  progressEl.value = 100;
  $("transcribeStatus").textContent = `完了しました(${captionSegments.length}個の字幕セグメント / 音量を自動調整済み)`;
  $("btnTranscribe").disabled = false;

  renderSegmentList();
  renderCaptionList();
  markPanelComplete("step-segments");
  goToStep(4, "step-captions");
});

function renderCaptionList() {
  const list = $("captionList");
  list.innerHTML = "";
  captionSegments.forEach((seg, i) => {
    const row = document.createElement("div");
    row.className = "caption-item";
    row.innerHTML = `
      <span class="time">${fmtTime(seg.start)}</span>
      <textarea data-idx="${i}">${escapeHtml(seg.text)}</textarea>
    `;
    row.querySelector("textarea").addEventListener("input", (e) => {
      captionSegments[i].text = e.target.value;
    });
    list.appendChild(row);
  });
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------------------------------------------------------------------
// Step4: 字幕の修正を学習 + プレビューへ進む
// ---------------------------------------------------------------------
$("btnLearnGlossary").addEventListener("click", () => {
  let learnedTerms = 0;
  for (const seg of captionSegments) {
    if (seg.text !== seg.originalText) {
      learnedTerms += learning.learnFromCorrection(seg.originalText, seg.text);
    }
  }
  $("learnGlossaryStatus").textContent =
    `学習しました(用語 ${learnedTerms}件)。次回の文字起こしに反映されます。`;
});

$("btnGotoPreview").addEventListener("click", () => {
  markPanelComplete("step-captions");
  // 先にパネルを表示してからvideo要素を操作する(非表示要素への操作を避け、
  // MacBook/iPhone/iPad間での再生の不安定さを防ぐ)
  goToStep(5, "step-preview");
  enterPreviewStep();
});

// ---------------------------------------------------------------------
// Step5: プレビュー再生
// ---------------------------------------------------------------------
const BOUNDARY_EPS_MS = 30; // 境界付近のちらつき(細かい往復シーク)を防ぐ許容誤差

let previewSegments = [];
let previewCtx = null;
let previewGainNode = null;
let previewGraphReady = false;
let isSeekingPreview = false;

function setupPreviewGraphOnce() {
  if (previewGraphReady) return;
  previewGraphReady = true;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    previewCtx = new AudioCtx();
    const source = previewCtx.createMediaElementSource($("previewVideo"));
    previewGainNode = previewCtx.createGain();
    source.connect(previewGainNode);
    previewGainNode.connect(previewCtx.destination);
  } catch (err) {
    console.warn("プレビュー用の音量調整グラフの初期化に失敗しました(音量調整なしで再生を続けます):", err);
  }
}

function findSegmentAtMs(segments, ms) {
  for (const seg of segments) {
    if (ms >= seg.startMs - BOUNDARY_EPS_MS && ms <= seg.endMs + BOUNDARY_EPS_MS) return seg;
  }
  return null;
}
function findNextSegmentStartMs(segments, ms) {
  for (const seg of segments) {
    if (seg.startMs > ms + BOUNDARY_EPS_MS) return seg.startMs;
  }
  return null;
}

const previewVideoEl = $("previewVideo");

previewVideoEl.addEventListener("seeking", () => { isSeekingPreview = true; });
previewVideoEl.addEventListener("seeked", () => { isSeekingPreview = false; });

// iOS/Safariでは、AudioContextの再開はユーザー操作(再生ボタンのタップ等)の
// 直後に行うのが最も確実なため、'play'イベントでも念のためresumeを試みる
previewVideoEl.addEventListener("play", () => {
  if (previewCtx && previewCtx.state !== "running") {
    previewCtx.resume().catch(() => {});
  }
});

previewVideoEl.addEventListener("timeupdate", () => {
  if (!previewSegments.length || isSeekingPreview) return;
  const curMs = previewVideoEl.currentTime * 1000;
  const activeSeg = findSegmentAtMs(previewSegments, curMs);

  if (!activeSeg) {
    const nextStartMs = findNextSegmentStartMs(previewSegments, curMs);
    if (nextStartMs != null) {
      previewVideoEl.currentTime = nextStartMs / 1000;
    } else if (!previewVideoEl.paused) {
      previewVideoEl.pause();
    }
    $("previewCaptionOverlay").textContent = "";
    return;
  }

  if (previewGainNode && previewCtx) {
    const gainLinear = typeof activeSeg.gainDb === "number" ? Math.pow(10, activeSeg.gainDb / 20) : 1;
    try {
      previewGainNode.gain.setTargetAtTime(gainLinear, previewCtx.currentTime, 0.05);
    } catch {
      previewGainNode.gain.value = gainLinear;
    }
  }

  const cur = previewVideoEl.currentTime;
  const activeCaption = captionSegments.find((c) => cur >= c.start && cur <= c.end);
  $("previewCaptionOverlay").textContent = activeCaption ? activeCaption.text : "";
});

function enterPreviewStep() {
  previewSegments = keptSegments
    .filter((s) => s.include)
    .slice()
    .sort((a, b) => a.startMs - b.startMs);

  if (previewVideoEl.dataset.objectUrl) {
    URL.revokeObjectURL(previewVideoEl.dataset.objectUrl);
  }
  const url = URL.createObjectURL(videoFile);
  previewVideoEl.dataset.objectUrl = url;

  const seekToStart = () => {
    try {
      previewVideoEl.currentTime = previewSegments[0] ? previewSegments[0].startMs / 1000 : 0;
    } catch { /* noop */ }
    previewVideoEl.removeEventListener("loadedmetadata", seekToStart);
  };
  previewVideoEl.addEventListener("loadedmetadata", seekToStart);
  previewVideoEl.src = url;
  previewVideoEl.load();

  setupPreviewGraphOnce();
  if (previewCtx && previewCtx.state !== "running") {
    previewCtx.resume().catch(() => {});
  }
}

$("btnGotoExport").addEventListener("click", () => {
  previewVideoEl.pause();
  markPanelComplete("step-preview");
  goToStep(6, "step-export");
});

// ---------------------------------------------------------------------
// Step6: fcpxml形式で書き出し
// ---------------------------------------------------------------------
function buildOutputFiles() {
  const included = keptSegments.filter((s) => s.include);
  const fcpxml = exporter.buildFcpxml(videoFile.name, included);
  const remapped = exporter.remapCaptionsToCutTimeline(captionSegments, included);
  const srt = exporter.buildSrt(remapped);

  const baseName = videoFile.name.replace(/\.[^/.]+$/, "");
  return {
    fcpxmlBlob: new Blob([fcpxml], { type: "application/xml" }),
    fcpxmlName: `${baseName}_cut.fcpxml`,
    srtBlob: new Blob([srt], { type: "application/x-subrip" }),
    srtName: `${baseName}_subtitles.srt`,
  };
}

$("btnShare").addEventListener("click", async () => {
  const { fcpxmlBlob, fcpxmlName, srtBlob, srtName } = buildOutputFiles();
  const files = [
    new File([fcpxmlBlob], fcpxmlName, { type: "application/xml" }),
    new File([srtBlob], srtName, { type: "application/x-subrip" }),
  ];
  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files, title: "RoughCut" });
    } catch (err) {
      if (err.name !== "AbortError") console.error(err);
    }
  } else {
    alert("この端末では共有シートが使えません。「ファイルに保存」をお使いください。");
  }
});

$("btnDownload").addEventListener("click", () => {
  const { fcpxmlBlob, fcpxmlName, srtBlob, srtName } = buildOutputFiles();
  downloadBlob(fcpxmlBlob, fcpxmlName);
  setTimeout(() => downloadBlob(srtBlob, srtName), 400);
});

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
