import { useCallback, useEffect, useState } from 'react';
import { getDoc, touchDoc, type DocRecord } from './db.ts';
import Library from './Library.tsx';
import Viewer from './Viewer.tsx';

export default function App() {
  const [current, setCurrent] = useState<DocRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(async (id: number) => {
    try {
      const rec = await getDoc(id);
      if (!rec) throw new Error('見つかりません');
      touchDoc(id).catch(() => undefined);
      setCurrent(rec);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // メニューから戻る時も history を戻し、popstate 経由で閉じる（戻るボタンと同じ経路）
  const exit = useCallback(() => {
    if (history.state?.viewer) history.back();
    else setCurrent(null);
  }, []);

  // Android の戻るボタンでビューアからライブラリへ戻れるように history を 1 段積む
  useEffect(() => {
    if (!current) return;
    history.pushState({ viewer: true }, '');
    const onPop = () => setCurrent(null);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [current]);

  if (current) {
    return <Viewer doc={current} onExit={exit} />;
  }
  return <Library onOpen={open} error={error} onClearError={() => setError(null)} />;
}
