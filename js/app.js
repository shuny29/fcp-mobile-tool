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
// Step1: 動画選択 + サムネイル表示
// ---------------------------------------------------------------------
$("videoInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  videoFile = file;
  $("videoLabel").textContent = file.name;
  $("videoInfo").textContent = "読み込み中...";
  $("thumbRow").hidden = true;

  try {
    audioBuffer = await silence.decodeAudioFile(file, (progress, phase) => {
      if (phase === "fallback") {
        $("videoInfo").textContent = "通常の方法で読み込めなかったため、再生しながら解析します...";
      } else if (phase === "capturing") {
        $("videoInfo").textContent = `動画を再生しながら音声を解析中... ${Math.round(progress * 100)}%`;
      }
    });
    const durationSec = audioBuffer.duration.toFixed(1);
    $("videoInfo").textContent = `${durationSec}秒 読み込み完了`;
    markPanelComplete("step-pick");
    showThumbnail(file, durationSec);
    showSettingsStep();
  } catch (err) {
    console.error(err);
    $("videoInfo").textContent =
      `音声の読み込みに失敗しました(${err.message || "不明なエラー"})。別の動画でお試しください。`;
  }
});

// 動画の一場面を切り出して小さなサムネイル画像にする
function generateThumbnail(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";

    const settle = (fn, val) => { URL.revokeObjectURL(url); fn(val); };

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

async function showThumbnail(file, durationSecText) {
  try {
    const dataUrl = await generateThumbnail(file);
    $("videoThumb").src = dataUrl;
    $("thumbName").textContent = file.name;
    $("thumbDuration").textContent = `${durationSecText}秒`;
    $("thumbRow").hidden = false;
  } catch (err) {
    console.warn("サムネイル生成に失敗:", err);
    // サムネイルが作れなくても処理自体は続行できるので、ここでは無視する
  }
}

function showSettingsStep() {
  const prefs = learning.getSilencePrefs();
  $("threshDb").value = Math.round(prefs.threshDb);
  $("minSilenceLen").value = Math.round(prefs.minSilenceLenMs);
  $("padding").value = Math.round(prefs.paddingMs);
  updateSliderLabels();
  goToStep(2, "step-settings");
}

function updateSliderLabels() {
  $("threshDbLabel").textContent = $("threshDb").value;
  $("minSilenceLabel").textContent = $("minSilenceLen").value;
  $("paddingLabel").textContent = $("padding").value;
}
["threshDb", "minSilenceLen", "padding"].forEach((id) => {
  $(id).addEventListener("input", updateSliderLabels);
});

// ---------------------------------------------------------------------
// Step2: 無音検出 + この設定を学習
// ---------------------------------------------------------------------
$("btnDetect").addEventListener("click", () => {
  const opts = {
    threshDb: Number($("threshDb").value),
    minSilenceLenMs: Number($("minSilenceLen").value),
    paddingMs: Number($("padding").value),
  };
  const segments = silence.detectSpeechSegments(audioBuffer, opts);
  keptSegments = segments.map((s) => ({ ...s, include: true }));

  const totalMs = audioBuffer.duration * 1000;
  const summary = silence.summarizeCut(totalMs, keptSegments);
  $("detectSummary").textContent =
    `元の長さ: ${summary.originalSec.toFixed(1)}秒 → カット後: ${summary.keptSec.toFixed(1)}秒` +
    `(削減率 ${(summary.cutRatio * 100).toFixed(1)}%, ${summary.segmentCount}区間)`;

  drawTimelineStrip(totalMs, keptSegments);
  $("timelineStripWrap").hidden = false;

  renderSegmentList();
  markPanelComplete("step-settings");
  goToStep(3, "step-segments");
});

$("btnLearnCut").addEventListener("click", () => {
  learning.updateSilencePrefs({
    threshDb: Number($("threshDb").value),
    minSilenceLenMs: Number($("minSilenceLen").value),
    paddingMs: Number($("padding").value),
  });
  $("learnCutStatus").textContent = "学習しました。次回の無音カット基準に反映されます。";
});

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
  enterPreviewStep();
  goToStep(5, "step-preview");
});

// ---------------------------------------------------------------------
// Step5: プレビュー再生
// ---------------------------------------------------------------------
let previewSegments = [];
let previewCtx = null;
let previewGainNode = null;
let previewGraphReady = false;

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
    console.warn("プレビュー用の音量調整グラフの初期化に失敗しました:", err);
  }
}

function findSegmentAtMs(segments, ms) {
  for (const seg of segments) {
    if (ms >= seg.startMs && ms <= seg.endMs) return seg;
  }
  return null;
}
function findNextSegmentStartMs(segments, ms) {
  for (const seg of segments) {
    if (seg.startMs > ms) return seg.startMs;
  }
  return null;
}

$("previewVideo").addEventListener("timeupdate", () => {
  if (!previewSegments.length) return;
  const video = $("previewVideo");
  const curMs = video.currentTime * 1000;
  const activeSeg = findSegmentAtMs(previewSegments, curMs);

  if (!activeSeg) {
    const nextStartMs = findNextSegmentStartMs(previewSegments, curMs);
    if (nextStartMs != null) {
      video.currentTime = nextStartMs / 1000;
    } else if (!video.paused) {
      video.pause();
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

  const cur = video.currentTime;
  const activeCaption = captionSegments.find((c) => cur >= c.start && cur <= c.end);
  $("previewCaptionOverlay").textContent = activeCaption ? activeCaption.text : "";
});

function enterPreviewStep() {
  previewSegments = keptSegments
    .filter((s) => s.include)
    .slice()
    .sort((a, b) => a.startMs - b.startMs);

  const video = $("previewVideo");
  if (video.dataset.objectUrl) URL.revokeObjectURL(video.dataset.objectUrl);
  const url = URL.createObjectURL(videoFile);
  video.dataset.objectUrl = url;
  video.src = url;
  video.currentTime = previewSegments[0] ? previewSegments[0].startMs / 1000 : 0;

  setupPreviewGraphOnce();
  if (previewCtx && previewCtx.state !== "running") {
    previewCtx.resume().catch(() => {});
  }
}

$("btnGotoExport").addEventListener("click", () => {
  $("previewVideo").pause();
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
