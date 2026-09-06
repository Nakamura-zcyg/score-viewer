import { useEffect, useRef } from 'react';
import { useSettings } from './settings.ts';

// 画面消灯防止。無操作が設定の分数だけ続いたら解除して、端末のスリープに任せる。
// 操作（タッチ・キー）があれば取り直す。active が true の間（自動スクロール中など）は無操作に数えない。

export function useWakeLock(active: boolean): void {
  const idleMs = useSettings().idleMinutes * 60 * 1000;
  const activeRef = useRef(active);
  activeRef.current = active;
  const pokeRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let timer = 0;
    let disposed = false;

    const release = () => {
      lock?.release().catch(() => undefined);
      lock = null;
    };
    const acquire = async () => {
      if (disposed || lock) return;
      try {
        const l = (await navigator.wakeLock?.request('screen')) ?? null;
        // 取得中に閉じられた／取り直されていたら、そのまま手放す
        if (disposed || lock) {
          l?.release().catch(() => undefined);
          return;
        }
        lock = l;
        // 画面が裏に回ると OS 側で解放される。表に戻った時に取り直す
        lock?.addEventListener('release', () => {
          lock = null;
        });
      } catch {
        /* 非対応や省電力モードでは失敗する。無視 */
      }
    };
    const arm = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        // 動作中（自動スクロールなど）なら数え直す
        if (activeRef.current) {
          arm();
          return;
        }
        release();
      }, idleMs);
    };
    const onActivity = () => {
      if (disposed) return;
      arm();
      if (!lock && document.visibilityState === 'visible') acquire();
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') onActivity();
    };

    pokeRef.current = onActivity;
    acquire();
    arm();
    window.addEventListener('pointerdown', onActivity, { passive: true });
    window.addEventListener('keydown', onActivity);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('keydown', onActivity);
      document.removeEventListener('visibilitychange', onVis);
      release();
    };
  }, [idleMs]);

  // active が true に変わった時も操作扱いにして、解除済みなら取り直す
  useEffect(() => {
    if (active) pokeRef.current();
  }, [active]);
}
