// sw.js
// アプリの見た目(HTML/CSS/JS)だけをキャッシュし、オフラインでも起動できるようにする。
// Whisperモデル本体は @huggingface/transformers が独自にCache API("transformers-cache")へ
// 保存するため、ここでは扱わない。
//
// 重要: コードを更新したら、必ずこの CACHE_NAME の数字を1つ上げてください。
// 上げないと、ユーザーのiPhoneには古いキャッシュがずっと残り続けてしまいます
// (activateイベントで「CACHE_NAMEと一致しない古いキャッシュ」を削除する仕組みのため、
// 名前が変わらないと「更新された」と認識できません)。

const CACHE_NAME = "fcp-auto-tool-shell-v20";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/style.css",
  "./js/app.js",
  "./js/learning.js",
  "./js/silence.js",
  "./js/asr.js",
  "./js/loudness.js",
  "./js/export.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // 外部CDN(モデル本体・transformers.js本体)はService Workerを介さず素通しにする
  if (url.origin !== self.location.origin) return;

  // ページ本体(HTML)はネットワーク優先: 更新があれば即座に反映し、
  // オフライン時のみキャッシュにフォールバックする
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // JS/CSS等はキャッシュ優先(CACHE_NAMEのバージョンを上げれば確実に更新される)
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      }).catch(() => cached);
    })
  );
});
