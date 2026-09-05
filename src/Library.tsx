import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { addDoc, deleteDoc, listDocs, renameDoc, type DocMeta } from './db.ts';
import { countPages } from './pdf.ts';
import * as drive from './drive.ts';
import { syncWithDrive, type SyncProgress } from './sync.ts';

function progressText(p: SyncProgress): string {
  switch (p.phase) {
    case 'auth':
      return 'Google にサインイン中…';
    case 'list':
      return 'Drive のフォルダを確認中…';
    case 'upload':
      return `アップロード ${p.current}/${p.total}: ${p.name}`;
    case 'download':
      return `ダウンロード ${p.current}/${p.total}: ${p.name}`;
    case 'done':
      return '完了';
  }
}

interface Props {
  onOpen: (id: number) => void;
  error: string | null;
  onClearError: () => void;
}

export default function Library({ onOpen, error, onClearError }: Props) {
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => setDocs(await listDocs()), []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    for (const f of files) {
      setBusy(f.name);
      try {
        const data = await f.arrayBuffer();
        const n = await countPages(data);
        await addDoc(f.name.replace(/\.pdf$/i, ''), data, n);
      } catch (err) {
        alert(`${f.name}: 読み込めませんでした\n${err}`);
      }
    }
    setBusy(null);
    refresh();
  };

  const onRename = async (d: DocMeta) => {
    const name = prompt('新しい名前', d.name);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === d.name) return;
    await renameDoc(d.id, trimmed);
    refresh();
  };

  const onDelete = async (d: DocMeta) => {
    const note = d.driveId ? '\nDrive 上のファイルも削除します。' : '';
    if (!confirm(`「${d.name}」を削除しますか？${note}`)) return;
    if (d.driveId) {
      try {
        await drive.remove(d.driveId);
      } catch (e) {
        alert(`Drive 側を削除できなかったので中止しました。\n${e}`);
        return;
      }
    }
    await deleteDoc(d.id);
    refresh();
  };

  const onSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncMsg('開始…');
    try {
      const r = await syncWithDrive((p) => {
        setSyncMsg(progressText(p));
        if (p.phase === 'download' || p.phase === 'upload') refresh();
      });
      setSyncMsg(
        `同期完了: アップロード ${r.uploaded}、ダウンロード ${r.downloaded}、名前変更 ${r.renamed}`,
      );
    } catch (e) {
      setSyncMsg(`同期に失敗: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
      refresh();
    }
  };

  return (
    <section className="library">
      <header>
        <h1>Score Viewer</h1>
        <div className="actions">
          {drive.isConfigured() && (
            <button className="btn" onClick={onSync} disabled={syncing}>
              {syncing ? '同期中…' : 'Drive と同期'}
            </button>
          )}
          <label className="btn primary">
            PDF を追加
            <input type="file" accept="application/pdf,.pdf" multiple hidden onChange={onFiles} />
          </label>
        </div>
      </header>

      {syncMsg && (
        <p className="muted sync-msg" onClick={() => !syncing && setSyncMsg(null)}>
          {syncMsg}
        </p>
      )}

      {error && (
        <p className="error" onClick={onClearError}>
          {error}
        </p>
      )}
      {busy && <p className="muted">読み込み中: {busy}</p>}

      {docs && docs.length === 0 && (
        <p className="muted">まだ PDF がありません。「PDF を追加」から取り込んでください。</p>
      )}

      <ul className="doc-list">
        {docs?.map((d) => (
          <li key={d.id}>
            <button className="doc" onClick={() => onOpen(d.id)}>
              <span className="name">{d.name}</span>
              <span className="meta">
                {d.pageCount} ページ · 前回 p.{d.lastPage}
                {d.driveId ? ' · Drive' : ''}
                {d.nameDirty ? '（名前変更を未同期）' : ''}
              </span>
            </button>
            <button className="btn small" onClick={() => onRename(d)} aria-label="名前変更">
              名前
            </button>
            <button className="btn danger small" onClick={() => onDelete(d)} aria-label="削除">
              削除
            </button>
          </li>
        ))}
      </ul>

      <p className="muted small">
        ビューア内: 画面の右（または下）をタップで次へ、左（または上）で前へ、長押しでメニュー。
      </p>
      {drive.isConfigured() && (
        <p className="muted small">
          「Drive と同期」は、ここにある PDF を Drive の「Score Viewer」フォルダへ上げ、フォルダにあってここにないものを取り込む。
          削除は Drive 側も一緒に消える。
        </p>
      )}
    </section>
  );
}
