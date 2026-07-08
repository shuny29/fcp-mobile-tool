// export.js
// 無音カット後のFCPXMLと、カット後の尺に合わせたSRT字幕を生成する。

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  }[c]));
}

function secToRational(sec, fps) {
  const frames = Math.round(sec * fps);
  return `${frames}/${fps}s`;
}

/**
 * kept segments(ms, 元動画基準) から FCPXML 文字列を生成する。
 * @param {string} videoFileName 表示用のファイル名(実ファイルパスはFCP側で改めて紐付ける)
 * @param {Array<{startMs,endMs,gainDb?:number}>} keptSegments gainDbを指定すると
 *   <adjust-volume> による非破壊の音量調整(音量正規化)を各クリップに付与する
 */
export function buildFcpxml(videoFileName, keptSegments, { fps = 30, projectName = null } = {}) {
  const baseName = videoFileName.replace(/\.[^/.]+$/, "");
  const project = projectName || `${baseName}_auto_cut`;
  const frameDuration = `100/${fps * 100}s`;

  let cursorSec = 0;
  const clipsXml = keptSegments.map((seg, i) => {
    const startSec = seg.startMs / 1000;
    const durSec = (seg.endMs - seg.startMs) / 1000;
    const hasGain = typeof seg.gainDb === "number" && Math.abs(seg.gainDb) > 0.05;
    const gainXml = hasGain
      ? `\n              <adjust-volume amount="${seg.gainDb >= 0 ? "+" : ""}${seg.gainDb.toFixed(1)}dB"/>`
      : "";
    const openTag = hasGain
      ? `            <asset-clip ref="r2" name="${escapeXml(baseName)}_clip${i + 1}" offset="${secToRational(cursorSec, fps)}" start="${secToRational(startSec, fps)}" duration="${secToRational(durSec, fps)}" format="r1">${gainXml}\n            </asset-clip>`
      : `            <asset-clip ref="r2" name="${escapeXml(baseName)}_clip${i + 1}" offset="${secToRational(cursorSec, fps)}" start="${secToRational(startSec, fps)}" duration="${secToRational(durSec, fps)}" format="r1"/>`;
    cursorSec += durSec;
    return openTag;
  }).join("\n");

  const totalDurationSec = cursorSec;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="r1" name="FFVideoFormat${fps}p" frameDuration="${frameDuration}"/>
    <asset id="r2" name="${escapeXml(baseName)}" hasVideo="1" hasAudio="1" format="r1" start="0s" duration="${secToRational(totalDurationSec, fps)}"/>
  </resources>
  <library>
    <event name="自動カット">
      <project name="${escapeXml(project)}">
        <sequence format="r1" duration="${secToRational(totalDurationSec, fps)}" tcStart="0s">
          <spine>
${clipsXml}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

/** カット後タイムラインへの時間マッピングを作る */
export function buildTimeMapping(keptSegmentsMs) {
  const mapping = [];
  let cursor = 0;
  for (const { startMs, endMs } of keptSegmentsMs) {
    const dur = endMs - startMs;
    mapping.push({ origStart: startMs, origEnd: endMs, newStart: cursor, newEnd: cursor + dur });
    cursor += dur;
  }
  return mapping;
}

export function remapMs(originalMs, mapping) {
  for (const m of mapping) {
    if (originalMs >= m.origStart && originalMs <= m.origEnd) {
      return m.newStart + (originalMs - m.origStart);
    }
  }
  let prevEnd = 0;
  for (const m of mapping) {
    if (originalMs < m.origStart) return prevEnd;
    prevEnd = m.newEnd;
  }
  return prevEnd;
}

/**
 * 字幕セグメント(元動画基準, 秒)を、カット後タイムライン基準(秒)に変換する。
 * @param {Array<{start,end,text}>} captionSegments
 * @param {Array<{startMs,endMs}>} keptSegmentsMs
 */
export function remapCaptionsToCutTimeline(captionSegments, keptSegmentsMs) {
  const mapping = buildTimeMapping(keptSegmentsMs);
  const remapped = [];
  for (const seg of captionSegments) {
    const newStartMs = remapMs(seg.start * 1000, mapping);
    const newEndMs = remapMs(seg.end * 1000, mapping);
    if (newEndMs <= newStartMs) continue;
    remapped.push({ start: newStartMs / 1000, end: newEndMs / 1000, text: seg.text });
  }
  return remapped;
}

function formatSrtTime(sec) {
  const msTotal = Math.round(sec * 1000);
  const h = Math.floor(msTotal / 3600000);
  const m = Math.floor((msTotal % 3600000) / 60000);
  const s = Math.floor((msTotal % 60000) / 1000);
  const ms = msTotal % 1000;
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

export function buildSrt(segments) {
  return segments.map((seg, i) =>
    `${i + 1}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n${seg.text}\n`
  ).join("\n");
}
