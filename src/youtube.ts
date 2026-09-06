// YouTube 関連: URL から動画 ID を取り出す、タイトルを取る、IFrame API を読み込む

/** 共有リンク・通常 URL・短縮 URL・埋め込み URL・Shorts から 11 文字の動画 ID を取り出す */
export function extractVideoId(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let u: URL;
  try {
    u = new URL(s.includes('://') ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  const id11 = (v: string | null | undefined) => (v && /^[A-Za-z0-9_-]{11}$/.test(v) ? v : null);
  if (host === 'youtu.be') return id11(u.pathname.slice(1).split('/')[0]);
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = id11(u.searchParams.get('v'));
    if (v) return v;
    const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
  }
  return null;
}

/** oEmbed でタイトルを取る。CORS や圏外で失敗したら null */
export async function fetchTitle(videoId: string, timeoutMs = 5000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`,
    )}`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const j = (await res.json()) as { title?: string };
    return j.title?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---- IFrame Player API の最小限の型 ----
export interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
  getAvailablePlaybackRates(): number[];
  destroy(): void;
}
interface YTNamespace {
  Player: new (
    el: HTMLElement | string,
    opts: {
      videoId: string;
      host?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (e: { target: YTPlayer }) => void;
        onStateChange?: (e: { data: number; target: YTPlayer }) => void;
        onError?: (e: { data: number }) => void;
      };
    },
  ) => YTPlayer;
  PlayerState: { ENDED: 0; PLAYING: 1; PAUSED: 2; BUFFERING: 3; CUED: 5 };
}
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiLoading: Promise<YTNamespace> | null = null;

/** https://www.youtube.com/iframe_api を読み込み、YT 名前空間を返す */
export function loadYouTubeApi(timeoutMs = 15000): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiLoading) return apiLoading;
  apiLoading = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      apiLoading = null;
      reject(new Error('YouTube のプレイヤーを読み込めませんでした（オフライン？）'));
    }, timeoutMs);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      clearTimeout(timer);
      if (window.YT) resolve(window.YT);
      else reject(new Error('YT が初期化されませんでした'));
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => {
      clearTimeout(timer);
      apiLoading = null;
      reject(new Error('YouTube のプレイヤーを読み込めませんでした（オフライン？）'));
    };
    document.head.appendChild(s);
  });
  return apiLoading;
}

export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
