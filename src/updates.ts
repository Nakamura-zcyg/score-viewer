// 配信版の更新確認。
// Service Worker の更新チェックはブラウザがページ遷移（起動）時にしか行わないため、
// ホーム画面から起動したままの PWA は新しい版に気付かない。設定画面のボタンから
// registration.update() を明示的に呼び、見つかれば autoUpdate の仕組み（skipWaiting → activated → reload）に任せる。

let registration: ServiceWorkerRegistration | undefined;

export function setRegistration(reg: ServiceWorkerRegistration | undefined) {
  registration = reg;
}

export type UpdateResult =
  | 'updating' // 新しい版が見つかり取り込み中。完了すると自動で再読み込みされる
  | 'latest' // 配信版と同じ
  | 'offline' // 配信先に届かなかった
  | 'unsupported'; // SW 未登録（開発サーバーなど）

export async function checkForUpdate(): Promise<UpdateResult> {
  if (!('serviceWorker' in navigator)) return 'unsupported';
  const reg = registration ?? (await navigator.serviceWorker.getRegistration());
  if (!reg) return 'unsupported';

  // 取り込み済みで待機中の版があれば即切り替える（通常は skipWaiting で起きないが保険）
  if (reg.waiting) {
    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    return 'updating';
  }

  // update() の解決時点で installing が立たない実装もあるので updatefound も見る
  let found = false;
  const onFound = () => {
    found = true;
  };
  reg.addEventListener('updatefound', onFound);
  try {
    await reg.update();
  } catch {
    return 'offline';
  } finally {
    reg.removeEventListener('updatefound', onFound);
  }
  if (found || reg.installing || reg.waiting) return 'updating';
  return 'latest';
}

// ビルド時に vite.config.ts の define で埋め込む
export const APP_VERSION = __APP_VERSION__;
export const BUILD_TIME = __BUILD_TIME__;
