import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { addDoc, deleteDoc, listDocs, type DocMeta } from './db.ts';
import { countPages } from './pdf.ts';

interface Props {
  onOpen: (id: number) => void;
  error: string | null;
  onClearError: () => void;
}

export default function Library({ onOpen, error, onClearError }: Props) {
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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

  const onDelete = async (d: DocMeta) => {
    if (!confirm(`「${d.name}」を削除しますか？`)) return;
    await deleteDoc(d.id);
    refresh();
  };

  return (
    <section className="library">
      <header>
        <h1>Score Viewer</h1>
        <label className="btn primary">
          PDF を追加
          <input type="file" accept="application/pdf,.pdf" multiple hidden onChange={onFiles} />
        </label>
      </header>

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
              </span>
            </button>
            <button className="btn danger" onClick={() => onDelete(d)} aria-label="削除">
              削除
            </button>
          </li>
        ))}
      </ul>

      <p className="muted small">
        ビューア内: 左半分タップで前へ、右半分タップで次へ、長押しでメニュー。
      </p>
    </section>
  );
}
