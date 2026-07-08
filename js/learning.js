// learning.js
// 学習機能: 無音カットの好み(EMA)と、字幕の誤認識辞書をブラウザのlocalStorageに保存する。
// Pythonデスクトップ版の learning_manager.py と同じ考え方をブラウザ用に移植したもの。

const PREFS_KEY = "fcpTool.silencePrefs";
const GLOSSARY_KEY = "fcpTool.glossary";
const LEARNING_RATE = 0.3; // 大きいほど直近のフィードバックを重視

const DEFAULT_PREFS = {
  threshDb: -40,        // 無音とみなす音量(dBFS)
  minSilenceLenMs: 700,  // これより長い無音をカット対象にする
  paddingMs: 150,        // 発話前後に残す余白
  feedbackCount: 0,
};

export function getSilencePrefs() {
  const raw = localStorage.getItem(PREFS_KEY);
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function saveSilencePrefsDirect(prefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

/**
 * ユーザーが手動調整した値でEMA更新する(観測値をfeedbackとして与える)。
 * 値を指定しなかった項目は変化しない。
 */
export function updateSilencePrefs({ threshDb, minSilenceLenMs, paddingMs } = {}) {
  const prefs = getSilencePrefs();
  const ema = (old, obs) => (obs === undefined || obs === null || Number.isNaN(obs))
    ? old
    : old * (1 - LEARNING_RATE) + obs * LEARNING_RATE;

  prefs.threshDb = ema(prefs.threshDb, threshDb);
  prefs.minSilenceLenMs = ema(prefs.minSilenceLenMs, minSilenceLenMs);
  prefs.paddingMs = ema(prefs.paddingMs, paddingMs);
  prefs.feedbackCount = (prefs.feedbackCount || 0) + 1;

  saveSilencePrefsDirect(prefs);
  return prefs;
}

export function getGlossary() {
  const raw = localStorage.getItem(GLOSSARY_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveGlossary(glossary) {
  localStorage.setItem(GLOSSARY_KEY, JSON.stringify(glossary));
}

export function applyGlossary(text) {
  const glossary = getGlossary();
  let result = text;
  for (const [wrong, right] of Object.entries(glossary)) {
    result = result.split(wrong).join(right);
  }
  return result;
}

export function glossaryPromptHint() {
  const glossary = getGlossary();
  const terms = [...new Set(Object.values(glossary))];
  return terms.join("、");
}

// --- 簡易的な文字レベル差分(LCSベース)。Python版のdifflib.SequenceMatcherに相当 ---
function diffOps(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  let i = n, j = m;
  const ops = [];
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { ops.push({ tag: "equal", a: i - 1, b: j - 1 }); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) { ops.push({ tag: "delete", a: i - 1 }); i--; }
    else { ops.push({ tag: "insert", b: j - 1 }); j--; }
  }
  while (i > 0) { ops.push({ tag: "delete", a: i - 1 }); i--; }
  while (j > 0) { ops.push({ tag: "insert", b: j - 1 }); j--; }
  ops.reverse();
  return ops;
}

/**
 * 自動生成テキストと修正後テキストを比較し、「誤認識 → 正しい語」のペアを抽出して
 * 辞書(localStorage)に学習させる。1件のセグメント単位で呼び出す。
 * 戻り値: 学習したペアの数
 */
export function learnFromCorrection(originalText, correctedText) {
  if (originalText === correctedText) return 0;
  const a = Array.from(originalText);
  const b = Array.from(correctedText);
  const ops = diffOps(a, b);

  const glossary = getGlossary();
  let learned = 0;
  let idx = 0;
  while (idx < ops.length) {
    if (ops[idx].tag === "equal") { idx++; continue; }
    let delChars = [], insChars = [];
    while (idx < ops.length && ops[idx].tag !== "equal") {
      if (ops[idx].tag === "delete") delChars.push(a[ops[idx].a]);
      else insChars.push(b[ops[idx].b]);
      idx++;
    }
    const wrong = delChars.join("").trim();
    const right = insChars.join("").trim();
    if (wrong && right && wrong !== right && wrong.length <= 20) {
      glossary[wrong] = right;
      learned++;
    }
  }
  if (learned > 0) saveGlossary(glossary);
  return learned;
}
