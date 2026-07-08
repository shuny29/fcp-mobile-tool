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
let keptSegments = []; // [{startMs, endMs, include}]
let captionSegments = []; // [{start, end, text, originalText}]

// --- Step1: 動画選択 ---
$("videoInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  videoFile = file;
  $("videoInfo").textContent = `読み込み中... (${file.name})`;

  try {
    audioBuffer = await silence.decodeAudioFile(file);
    const durationSec = audioBuffer.duration.toFixed(1);
    $("videoInfo").textContent = `${file.name} (${durationSec}秒)`;
    showSettingsStep();
  } catch (err) {
    console.error(err);
    $("videoInfo").textContent =
      "音声の読み込みに失敗しました。動画形式を確認してください(.mov/.mp4推奨)。";
  }
});

function showSettingsStep() {
  const prefs = learning.getSilencePrefs();
  $("threshDb").value = Math.round(prefs.threshDb);
  $("minSilenceLen").value = Math.round(prefs.minSilenceLenMs);
  $("padding").value = Math.round(prefs.paddingMs);
  updateSliderLabels();
  $("step-settings").hidden = false;
  $("step-settings").scrollIntoView({ behavior: "smooth" });
}

function updateSliderLabels() {
  $("threshDbLabel").textContent = $("threshDb").value;
  $("minSilenceLabel").textContent = $("minSilenceLen").value;
  $("paddingLabel").textContent = $("padding").value;
}
["threshDb", "minSilenceLen", "padding"].forEach((id) => {
  $(id).addEventListener("input", updateSliderLabels);
});

// --- Step2: 無音検出 ---
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

  renderSegmentList();
  $("step-segments").hidden = false;
  $("step-segments").scrollIntoView({ behavior: "smooth" });
});

function renderSegmentList() {
  const list = $("segmentList");
  list.innerHTML = "";
  keptSegments.forEach((seg, i) => {
    const row = document.createElement("div");
    row.className = "segment-item";
    const gainLabel = typeof seg.gainDb === "number" && Math.abs(seg.gainDb) > 0.05
      ? ` <span class="gain-tag">${seg.gainDb >= 0 ? "+" : ""}${seg.gainDb.toFixed(1)}dB</span>`
      : "";
    row.innerHTML = `
      <input type="checkbox" ${seg.include ? "checked" : ""} data-idx="${i}">
      <span class="time">${fmtTime(seg.startMs / 1000)} - ${fmtTime(seg.endMs / 1000)}${gainLabel}</span>
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

// --- Step3: 字幕自動生成 ---
$("btnTranscribe").addEventListener("click", async () => {
  const included = keptSegments.filter((s) => s.include);
  if (included.length === 0) {
    $("transcribeStatus").textContent = "カットする区間しかありません。区間を選択してください。";
    return;
  }

  $("btnTranscribe").disabled = true;
  const progressEl = $("transcribeProgress");
  progressEl.hidden = false;
  progressEl.value = 0;

  $("transcribeStatus").textContent = "モデルを準備中(初回は数十MB〜のダウンロードがあります)...";
  const modelKey = $("modelSelect").value;
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
    const targetLufs = loudness.LUFS_PRESETS[$("lufsPreset").value];
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
  $("step-captions").hidden = false;
  $("step-export").hidden = false;
  $("step-captions").scrollIntoView({ behavior: "smooth" });
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

// --- Step4: 学習 ---
$("btnLearn").addEventListener("click", () => {
  let learnedTerms = 0;
  for (const seg of captionSegments) {
    if (seg.text !== seg.originalText) {
      learnedTerms += learning.learnFromCorrection(seg.originalText, seg.text);
    }
  }
  const prefs = learning.updateSilencePrefs({
    threshDb: Number($("threshDb").value),
    minSilenceLenMs: Number($("minSilenceLen").value),
    paddingMs: Number($("padding").value),
  });

  $("learnStatus").textContent =
    `学習しました(用語 ${learnedTerms}件 / 無音カット基準を更新)。次回の処理に反映されます。`;
});

// --- Step5: 書き出し ---
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
      await navigator.share({ files, title: "FCP自動カット & 字幕" });
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
