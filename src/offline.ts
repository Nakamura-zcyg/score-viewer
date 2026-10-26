// オフライン用キャッシュ（Service Worker の precache）の点検と補修。
//
// 背景（2026-10-26 user 報告）: タブレットで「Setting up fake worker failed: failed to fetch
// dynamically imported module …pdf.worker.min-*.mjs」が出てオフラインで PDF を開けないことがある。
// ワーカー本体は precache の一覧に入っているので、キャッシュから欠けたか、SW がその時
// 応答できなかったかのどちらか。ここでは「必要なファイルがキャッシュにあるか」を
// ページ側から直接 Cache Storage を見て確かめ、ネットがあれば欠けた分を入れ直す。

import { workerUrl } from './pdf.ts';

const PRECACHE_PREFIX = 'workbox-precache';
const BASE = import.meta.env.BASE_URL; // '/' or '/score-viewer/'

export interface OfflineStatus {
  sw: 'none' | 'uncontrolled' | 'controlled';
  cacheName: string | null;
  entries: number;
  /** 点検した URL（絶対） */
  checked: string[];
  /** キャッシュに無かった URL（絶対） */
  missing: string[];
  persisted: boolean | null;
  usage?: number;
  quota?: number;
}

interface ManifestEntry {
  url: string; // BASE 相対
  revision: string | null;
}

function abs(url: string): string {
  return new URL(url, location.origin + BASE).href;
}

/** 現在の SW が使う precache の名前。無ければ null */
async function precacheName(): Promise<string | null> {
  if (!('caches' in window)) return null;
  const names = (await caches.keys()).filter((n) => n.startsWith(PRECACHE_PREFIX));
  if (names.length === 0) return null;
  return names.find((n) => n.endsWith(location.origin + BASE)) ?? names[0];
}

/** このページが動くのに必要なファイル。index/manifest はリビジョン付きキーなので前方一致で見る */
function requiredUrls(): { exact: string[]; prefix: string[] } {
  const exact = new Set<string>([abs(workerUrl)]);
  for (const s of Array.from(document.scripts)) {
    if (s.src && s.src.startsWith(location.origin)) exact.add(s.src);
  }
  for (const l of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))) {
    if (l.href.startsWith(location.origin)) exact.add(l.href);
  }
  return { exact: Array.from(exact), prefix: [abs('index.html'), abs('manifest.webmanifest')] };
}

export async function checkOffline(): Promise<OfflineStatus> {
  const status: OfflineStatus = {
    sw: 'none',
    cacheName: null,
    entries: 0,
    checked: [],
    missing: [],
    persisted: null,
  };
  if ('serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) status.sw = navigator.serviceWorker.controller ? 'controlled' : 'uncontrolled';
  }
  try {
    status.persisted = (await navigator.storage?.persisted?.()) ?? null;
    const est = await navigator.storage?.estimate?.();
    status.usage = est?.usage;
    status.quota = est?.quota;
  } catch {
    /* 取れない環境は null のまま */
  }
  const name = await precacheName();
  status.cacheName = name;
  const req = requiredUrls();
  status.checked = [...req.exact, ...req.prefix];
  if (!name) {
    status.missing = status.checked;
    return status;
  }
  const cache = await caches.open(name);
  const keys = (await cache.keys()).map((r) => r.url);
  status.entries = keys.length;
  for (const u of req.exact) if (!keys.includes(u)) status.missing.push(u);
  for (const p of req.prefix) if (!keys.some((k) => k === p || k.startsWith(p + '?'))) status.missing.push(p);
  return status;
}

/** 配信中の sw.js から precache の一覧を取り出す。オフラインなど取れなければ null */
export async function fetchManifest(): Promise<ManifestEntry[] | null> {
  try {
    const res = await fetch(abs('sw.js'), { cache: 'no-store' });
    if (!res.ok) return null;
    const text = await res.text();
    const entries: ManifestEntry[] = [];
    const re = /\{url:"([^"]+)",revision:(null|"[0-9a-f]+")\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      entries.push({ url: m[1], revision: m[2] === 'null' ? null : m[2].slice(1, -1) });
    }
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}

export interface RepairResult {
  added: string[];
  failed: string[];
  /** 一覧が取れず、ページが知っている分だけ補った */
  partial: boolean;
}

/**
 * 欠けているファイルをネットから取ってキャッシュに入れる。SW を介さず Cache Storage に直接書くので、
 * SW が止まっていても効く。キーの付け方は workbox と同じ（リビジョン付きは ?__WB_REVISION__=）。
 */
export async function repairOffline(): Promise<RepairResult> {
  const result: RepairResult = { added: [], failed: [], partial: false };
  const name = (await precacheName()) ?? `${PRECACHE_PREFIX}-v2-${location.origin}${BASE}`;
  const cache = await caches.open(name);
  const manifest = await fetchManifest();
  const targets: { key: string; url: string }[] = [];
  if (manifest) {
    for (const e of manifest) {
      const url = abs(e.url);
      targets.push({ key: e.revision ? `${url}?__WB_REVISION__=${e.revision}` : url, url });
    }
  } else {
    result.partial = true;
    for (const url of requiredUrls().exact) targets.push({ key: url, url });
  }
  for (const t of targets) {
    if (await cache.match(t.key)) continue;
    try {
      const res = await fetch(t.url, { cache: 'reload', credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      await cache.put(t.key, res);
      result.added.push(t.url);
    } catch {
      result.failed.push(t.url);
    }
  }
  return result;
}

/** SW とキャッシュを捨てて再読み込みし、最初から入れ直す。ネットがある時だけ */
export async function rebuildOffline(): Promise<void> {
  if ('serviceWorker' in navigator) {
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  }
  if ('caches' in window) {
    for (const n of await caches.keys()) if (n.startsWith(PRECACHE_PREFIX)) await caches.delete(n);
  }
  location.reload();
}

export function fileName(url: string): string {
  return url.replace(/\?.*$/, '').split('/').pop() || url;
}
