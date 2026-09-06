import { useCallback, useEffect, useState } from 'react';
import { getDoc, getVideo, touchDoc, touchVideo, type DocRecord, type VideoMeta } from './db.ts';
import Library from './Library.tsx';
import Viewer from './Viewer.tsx';
import VideoPlayer from './VideoPlayer.tsx';

type Current = { kind: 'pdf'; doc: DocRecord } | { kind: 'video'; video: VideoMeta } | null;

export default function App() {
  const [current, setCurrent] = useState<Current>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Service Worker が全ファイルをキャッシュし終えたら知らせる
  useEffect(() => {
    const onReady = () => setToast('オフラインでも使えるようになりました');
    window.addEventListener('sw-offline-ready', onReady);
    return () => window.removeEventListener('sw-offline-ready', onReady);
  }, []);
  useEffect(() => {
    if (toast === null) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const open = useCallback(async (id: number) => {
    try {
      const rec = await getDoc(id);
      if (!rec) throw new Error('見つかりません');
      touchDoc(id).catch(() => undefined);
      setCurrent({ kind: 'pdf', doc: rec });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const openVideo = useCallback(async (id: number) => {
    try {
      const v = await getVideo(id);
      if (!v) throw new Error('見つかりません');
      touchVideo(id).catch(() => undefined);
      setCurrent({ kind: 'video', video: v });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // メニューから戻る時も history を戻し、popstate 経由で閉じる（戻るボタンと同じ経路）
  const exit = useCallback(() => {
    if (history.state?.viewer) history.back();
    else setCurrent(null);
  }, []);

  // Android の戻るボタンでライブラリへ戻れるように history を 1 段積む
  useEffect(() => {
    if (!current) return;
    history.pushState({ viewer: true }, '');
    const onPop = () => setCurrent(null);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [current]);

  return (
    <>
      {current?.kind === 'pdf' ? (
        <Viewer doc={current.doc} onExit={exit} />
      ) : current?.kind === 'video' ? (
        <VideoPlayer video={current.video} onExit={exit} />
      ) : (
        <Library
          onOpen={open}
          onOpenVideo={openVideo}
          error={error}
          onClearError={() => setError(null)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
