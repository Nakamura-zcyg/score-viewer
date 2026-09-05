import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { addDoc, deleteDoc, listDocs, renameDoc, type DocMeta } from './db.ts';
import { countPages } from './pdf.ts';
import * as drive from './drive.ts';
import { syncWithDrive, type SyncProgress } from './sync.ts';

type SortKey = 'added' | 'name' | 'opened';
const SORT_KEY = 'score-viewer.sort';

function loadSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_KEY);
    if (v === 'added' || v === 'name' || v === 'opened') return v;
  } catch {
    /* 無視 */
  }
  return 'added';
}

/** 検索用の正規化: 全角半角・大文字小文字の違いを無視する */
const norm = (s: string) => s.normalize('NFKC').toLowerCase();

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
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>(loadSort);

  useEffect(() => {
    try {
      localStorage.setItem(SORT_KEY, sort);
    } catch {
      /* 無視 */
    }
  }, [sort]);

  const shown = useMemo(() => {
    if (!docs) return null;
    const q = norm(query.trim());
    const filtered = q ? docs.filter((d) => norm(d.name).includes(q)) : docs.slice();
    const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
    switch (sort) {
      case 'name':
        filtered.sort((a, b) => collator.compare(a.name, b.name));
        break;
      case 'opened':
        filtered.sort((a, b) => (b.opened ?? 0) - (a.opened ?? 0) || b.added - a.added);
        break;
      default:
        filtered.sort((a, b) => b.added - a.added);
    }
    return filtered;
  }, [docs, query, sort]);

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

      {docs && docs.length > 0 && (
        <div className="toolbar">
          <input
            type="search"
            className="search"
            placeholder="検索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="検索"
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="並び順"
          >
            <option value="added">追加日順</option>
            <option value="name">名前順</option>
            <option value="opened">最近開いた順</option>
          </select>
        </div>
      )}

      {docs && docs.length === 0 && (
        <p className="muted">まだ PDF がありません。「PDF を追加」から取り込んでください。</p>
      )}
      {shown && docs && docs.length > 0 && shown.length === 0 && (
        <p className="muted">「{query}」に一致する楽譜はありません。</p>
      )}

      <ul className="doc-list">
        {shown?.map((d) => (
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
