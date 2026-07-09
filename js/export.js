// export.js
// 無音カット後のFCPXMLと、カット後の尺に合わせたSRT字幕を生成する。

// FCPXMLの「Basic Title」を参照するための固定UID。
// 実際にFinal Cut Proが書き出すFCPXMLで確認されている値で、
// 先頭の「...」も含めてこの通りの文字列がバンドル内の相対パスとして
// 解釈されるため、そのまま使用する(言語環境によらず安定して動作する)。
const TITLE_EFFECT_UID = ".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti";
// Basic Titleの「Position」パラメータのキー(実際の書き出しファイルで確認済み)
const TITLE_POSITION_PARAM_KEY = "9999/999166631/999166633/1/100/101";
// テロップの縦位置(px)。0が中央、マイナス方向が下にずれる(Basic Titleの座標系)。
// 「中央より少し下」の目安としてこの値をデフォルトにしている。
const DEFAULT_TELOP_POSITION_Y = -120;
const DEFAULT_TELOP_FONT_SIZE = 63;

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
 * 1つのテロップ(キュー)をFCPXMLの<title>(Basic Title、接続クリップ)として書き出す。
 * @param {{start:number,end:number,lines:string[]}} cue カット後タイムライン基準の秒
 * @param {number} localOffsetSec 親のasset-clip内でのローカルなオフセット(秒)
 * @param {number} fps
 * @param {number} idx テキストスタイルIDの重複を避けるための連番
 */
function buildTitleXml(cue, localOffsetSec, fps, idx) {
  const durSec = Math.max(1 / fps, cue.end - cue.start);
  const textXml = escapeXml(cue.lines.join("\n"));
  return `                <title ref="r3" name="telop_${idx}" lane="1" offset="${secToRational(localOffsetSec, fps)}" duration="${secToRational(durSec, fps)}">
                  <param name="Position" key="${TITLE_POSITION_PARAM_KEY}" value="0 ${DEFAULT_TELOP_POSITION_Y}"/>
                  <text>
                    <text-style ref="ts${idx}">${textXml}</text-style>
                  </text>
                  <text-style-def id="ts${idx}">
                    <text-style font="Hiragino Sans" fontSize="${DEFAULT_TELOP_FONT_SIZE}" fontColor="0 0 0 1" backgroundColor="1 1 1 1" strokeColor="0 0 0 1" strokeWidth="2" bold="1" alignment="center"/>
                  </text-style-def>
                </title>`;
}

/**
 * kept segments(ms, 元動画基準) から FCPXML 文字列を生成する。
 * @param {string} videoFileName 表示用のファイル名(実ファイルパスはFCP側で改めて紐付ける)
 * @param {Array<{startMs,endMs,gainDb?:number}>} keptSegments gainDbを指定すると
 *   <adjust-volume> による非破壊の音量調整(音量正規化)を各クリップに付与する
 * @param {Array<{start:number,end:number,lines:string[]}>} [captionCues] カット後タイムライン
 *   基準(秒)の字幕キュー。渡すと各クリップに自動テロップ(Basic Title)として埋め込む。
 */
export function buildFcpxml(videoFileName, keptSegments, { fps = 30, projectName = null, captionCues = null } = {}) {
  const baseName = videoFileName.replace(/\.[^/.]+$/, "");
  const project = projectName || `${baseName}_auto_cut`;
  const frameDuration = `100/${fps * 100}s`;
  const hasTelops = Array.isArray(captionCues) && captionCues.length > 0;
  let titleIdx = 0;

  let cursorSec = 0;
  const clipsXml = keptSegments.map((seg, i) => {
    const startSec = seg.startMs / 1000;
    const durSec = (seg.endMs - seg.startMs) / 1000;
    const clipStartInTimeline = cursorSec;
    const clipEndInTimeline = cursorSec + durSec;

    const hasGain = typeof seg.gainDb === "number" && Math.abs(seg.gainDb) > 0.05;
    const gainXml = hasGain
      ? `\n              <adjust-volume amount="${seg.gainDb >= 0 ? "+" : ""}${seg.gainDb.toFixed(1)}dB"/>`
      : "";

    // このクリップの時間範囲に重なるテロップだけを、接続クリップとして埋め込む
    let titlesXml = "";
    if (hasTelops) {
      const overlapping = captionCues.filter(
        (c) => c.start < clipEndInTimeline && c.end > clipStartInTimeline
      );
      titlesXml = overlapping.map((cue) => {
        const clippedStart = Math.max(cue.start, clipStartInTimeline);
        const clippedEnd = Math.min(cue.end, clipEndInTimeline);
        const localOffset = clippedStart - clipStartInTimeline;
        titleIdx += 1;
        return "\n" + buildTitleXml({ start: clippedStart, end: clippedEnd, lines: cue.lines }, localOffset, fps, titleIdx);
      }).join("");
    }

    const innerXml = `${gainXml}${titlesXml}`;
    const openTag = innerXml
      ? `            <asset-clip ref="r2" name="${escapeXml(baseName)}_clip${i + 1}" offset="${secToRational(cursorSec, fps)}" start="${secToRational(startSec, fps)}" duration="${secToRational(durSec, fps)}" format="r1">${innerXml}\n            </asset-clip>`
      : `            <asset-clip ref="r2" name="${escapeXml(baseName)}_clip${i + 1}" offset="${secToRational(cursorSec, fps)}" start="${secToRational(startSec, fps)}" duration="${secToRational(durSec, fps)}" format="r1"/>`;
    cursorSec += durSec;
    return openTag;
  }).join("\n");

  const totalDurationSec = cursorSec;
  const titleEffectXml = hasTelops
    ? `\n    <effect id="r3" name="Basic Title" uid="${TITLE_EFFECT_UID}"/>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="r1" name="FFVideoFormat${fps}p" frameDuration="${frameDuration}"/>
    <asset id="r2" name="${escapeXml(baseName)}" hasVideo="1" hasAudio="1" format="r1" start="0s" duration="${secToRational(totalDurationSec, fps)}"/>${titleEffectXml}
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

// ---------------------------------------------------------------------
// キャプションの整形ルール: 1行13字まで・句読点等で改行・1キュー2行まで。
// 収まりきらない場合は、複数のタイムスタンプ(キュー)に分割する
// (文字数に応じて元の時間幅を按分する)。
// ---------------------------------------------------------------------
const MAX_CHARS_PER_LINE = 13;
const MAX_LINES_PER_CUE = 2;
// 改行の判断に使う区切り記号(全角・半角の句読点や感嘆符・疑問符など)
const BREAK_CHARS = new Set(["。", "、", "！", "？", "!", "?", "，", "．", ",", ".", "…"]);

// 句読点等の直後で文章を細かい断片に分割する(区切り記号は前の断片に含める)
function splitIntoChunks(text) {
  const chunks = [];
  let current = "";
  for (const ch of text) {
    current += ch;
    if (BREAK_CHARS.has(ch)) {
      chunks.push(current);
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// 句読点がないまま長すぎる断片を、やむを得ず文字数で強制的に分割する。
// 最後の残りが1〜2文字(句読点だけ等)になる場合は、直前のスライスに
// 含めてしまい、句読点だけが単独の行になるのを避ける。
function hardWrapChunk(chunk, maxLen) {
  const parts = [];
  let i = 0;
  while (i < chunk.length) {
    let end = Math.min(i + maxLen, chunk.length);
    if (chunk.length - end > 0 && chunk.length - end <= 2) {
      end = chunk.length;
    }
    parts.push(chunk.slice(i, end));
    i = end;
  }
  return parts;
}

// 断片をできるだけ多く1行に詰め、maxCharsPerLineを超えたら改行する
function packLines(chunks, maxCharsPerLine) {
  const lines = [];
  let currentLine = "";
  for (const rawChunk of chunks) {
    const subChunks = rawChunk.length > maxCharsPerLine
      ? hardWrapChunk(rawChunk, maxCharsPerLine)
      : [rawChunk];
    for (const chunk of subChunks) {
      if (currentLine.length + chunk.length > maxCharsPerLine) {
        if (currentLine) lines.push(currentLine);
        currentLine = chunk;
      } else {
        currentLine += chunk;
      }
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

// 行の並びを、1キューあたり最大maxLinesPerCue行ずつのグループに分ける
function groupLinesIntoCues(lines, maxLinesPerCue) {
  const groups = [];
  for (let i = 0; i < lines.length; i += maxLinesPerCue) {
    groups.push(lines.slice(i, i + maxLinesPerCue));
  }
  return groups;
}

/**
 * 1つの字幕セグメント({start,end,text})を、整形ルール
 * (1行13字まで・句読点で改行・1キュー2行まで)に沿って
 * 1つ以上のキュー({start,end,lines})に変換する。
 * 2行に収まりきらない場合は、文字数に応じて時間を按分し、
 * 複数のタイムスタンプ(キュー)に分割する。
 */
export function formatCaptionCue(seg) {
  const chunks = splitIntoChunks(seg.text);
  const lines = packLines(chunks, MAX_CHARS_PER_LINE);
  const lineGroups = groupLinesIntoCues(lines, MAX_LINES_PER_CUE);

  if (lineGroups.length <= 1) {
    return [{ start: seg.start, end: seg.end, lines: lineGroups[0] || [] }];
  }

  const totalChars = lines.reduce((sum, l) => sum + l.length, 0) || 1;
  const totalDur = seg.end - seg.start;
  let cursor = seg.start;
  const results = [];
  for (const group of lineGroups) {
    const groupChars = group.reduce((sum, l) => sum + l.length, 0);
    const dur = totalDur * (groupChars / totalChars);
    const cueEnd = cursor + dur;
    results.push({ start: cursor, end: cueEnd, lines: group });
    cursor = cueEnd;
  }
  results[results.length - 1].end = seg.end; // 丸め誤差を最後のキューに吸収させる
  return results;
}

/** 字幕セグメントの配列すべてに整形ルールを適用し、キューの配列にする */
export function formatAllCaptionCues(segments) {
  const cues = [];
  for (const seg of segments) {
    cues.push(...formatCaptionCue(seg));
  }
  return cues;
}

/**
 * @param {Array<{start,end,lines:string[]}>} cues formatAllCaptionCuesの出力
 */
export function buildSrt(cues) {
  return cues.map((cue, i) =>
    `${i + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.lines.join("\n")}\n`
  ).join("\n");
}
