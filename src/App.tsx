import { useCallback, useEffect, useState } from 'react';
import { getDoc, getVideo, touchDoc, touchVideo, type DocRecord, type VideoMeta } from './db.ts';
import Library from './Library.tsx';
import Viewer from './Viewer.tsx';
import VideoPlayer from './VideoPlayer.tsx';
import Settings from './Settings.tsx';
import { prewarmWorker } from './pdf.ts';
import { checkOffline, fileName, repairOffline } from './offline.ts';

type Current =
  | { kind: 'pdf'; doc: DocRecord }
  | { kind: 'video'; video: VideoMeta }
  | { kind: 'settings' }
  | null;

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
    const t = setTimeout(() => setToast(null), toast.length > 40 ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // 起動から少し経ったら、オフラインに必要なファイルがキャッシュに揃っているか点検する。
  // 欠けていてネットがあれば入れ直し、ネットがなければ知らせる（タブレットで PDF ワーカーが
  // 欠けてオフラインで開けなかった報告への対策）。ワーカーは先にメモリへ載せておく
  useEffect(() => {
    const t = setTimeout(async () => {
      prewarmWorker();
      try {
        const st = await checkOffline();
        if (st.missing.length === 0 || st.sw === 'none') return;
        const names = st.missing.map(fileName).join('、');
        if (!navigator.onLine) {
          setToast(`オフライン用のキャッシュに欠けがあります: ${names}。ネットに繋いだ時に補われます`);
          return;
        }
        const r = await repairOffline();
        if (r.added.length > 0) setToast(`オフライン用のキャッシュを補いました（${r.added.length} 件）`);
        else if (r.failed.length > 0) setToast(`オフライン用のキャッシュを補えませんでした: ${names}`);
      } catch {
        /* 点検自体の失敗は無視 */
      }
    }, 6000);
    return () => clearTimeout(t);
  }, []);

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
      ) : current?.kind === 'settings' ? (
        <Settings onExit={exit} />
      ) : (
        <Library
          onOpen={open}
          onOpenVideo={openVideo}
          onOpenSettings={() => setCurrent({ kind: 'settings' })}
          error={error}
          onClearError={() => setError(null)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
