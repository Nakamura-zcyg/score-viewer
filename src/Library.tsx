import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import {
  CloudDownload,
  CloudUpload,
  FilePlus,
  Search,
  TextCursorInput,
  Trash2,
  MonitorPlay,
} from 'lucide-react';
import {
  addDoc,
  addVideo,
  deleteDoc,
  deleteVideo,
  listDocs,
  listVideos,
  renameDoc,
  renameVideo,
  type DocMeta,
  type VideoMeta,
} from './db.ts';
import { extractVideoId, fetchTitle } from './youtube.ts';
import { countPages } from './pdf.ts';
import * as drive from './drive.ts';
import {
  downloadFromDrive,
  removeVideoFromDrive,
  uploadToDrive,
  type SyncProgress,
} from './sync.ts';

interface Props {
  onOpen: (id: number) => void;
  onOpenVideo: (id: number) => void;
  error: string | null;
  onClearError: () => void;
}

/** 一覧の 1 行。PDF と動画を同じ並びで扱う */
type Item =
  | { kind: 'pdf'; key: string; name: string; added: number; opened?: number; doc: DocMeta }
  | { kind: 'video'; key: string; name: string; added: number; opened?: number; video: VideoMeta };

type SortKey = 'added' | 'name' | 'opened';
const SORT_KEY = 'score-viewer.sort';

function loadSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_KEY);
    if (v === 'added' || v === 'name' || v === 'opened') return v;
  } catch {
    /* 無視 */
  }
  return 'name';
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
    case 'videos':
      return '動画の一覧を同期中…';
    case 'done':
      return '完了';
  }
}

const ICON = 22;

function formatTime(sec: number): string {
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export default function Library({ onOpen, onOpenVideo, error, onClearError }: Props) {
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [videos, setVideos] = useState<VideoMeta[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>(loadSort);

  const refresh = useCallback(async () => {
    const [d, v] = await Promise.all([listDocs(), listVideos().catch(() => [] as VideoMeta[])]);
    setDocs(d);
    setVideos(v);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    try {
      localStorage.setItem(SORT_KEY, sort);
    } catch {
      /* 無視 */
    }
  }, [sort]);

  const items = useMemo<Item[] | null>(() => {
    if (!docs) return null;
    const a: Item[] = docs.map((d) => ({
      kind: 'pdf',
      key: `p${d.id}`,
      name: d.name,
      added: d.added,
      opened: d.opened,
      doc: d,
    }));
    const b: Item[] = videos.map((v) => ({
      kind: 'video',
      key: `v${v.id}`,
      name: v.name,
      added: v.added,
      opened: v.opened,
      video: v,
    }));
    return a.concat(b);
  }, [docs, videos]);

  const shown = useMemo(() => {
    if (!items) return null;
    const q = norm(query.trim());
    const filtered = q ? items.filter((d) => norm(d.name).includes(q)) : items.slice();
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
  }, [items, query, sort]);

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

  // ---- 動画 ----
  const onAddVideo = async () => {
    const url = prompt('YouTube の URL（共有リンクでも可）');
    if (url === null) return;
    const videoId = extractVideoId(url);
    if (!videoId) {
      alert('YouTube の動画 URL として読めませんでした。');
      return;
    }
    if (videos.some((v) => v.videoId === videoId)) {
      alert('この動画は追加済みです。');
      return;
    }
    setBusy('タイトルを取得中…');
    const title = await fetchTitle(videoId);
    setBusy(null);
    const name = prompt('名前', title ?? '');
    if (name === null) return;
    const trimmed = name.trim() || title || videoId;
    await addVideo(trimmed, videoId, url.trim());
    refresh();
  };

  const onRenameVideo = async (v: VideoMeta) => {
    const name = prompt('新しい名前', v.name);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === v.name) return;
    await renameVideo(v.id, trimmed);
    refresh();
  };

  const onDeleteVideo = async (v: VideoMeta) => {
    if (!confirm(`「${v.name}」をこの端末の一覧から削除しますか？`)) return;
    if (drive.isConfigured() && v.synced && !v.driveMissing) {
      const alsoDrive = confirm(
        `Drive の一覧からも「${v.name}」を外しますか？\n` +
          'キャンセルすると Drive には残ります（他の端末からは引き続きダウンロードできます）。',
      );
      if (alsoDrive) {
        try {
          await removeVideoFromDrive(v.videoId);
        } catch (e) {
          alert(`Drive 側を更新できなかったので中止しました。\n${e}`);
          return;
        }
      }
    }
    await deleteVideo(v.id);
    refresh();
  };

  // 削除は 2 段階。まずこの端末から、次に（Drive にもあるなら）Drive からも消すかを聞く。
  const onDelete = async (d: DocMeta) => {
    if (!confirm(`「${d.name}」をこの端末から削除しますか？`)) return;
    if (d.driveId && !d.driveMissing) {
      const alsoDrive = confirm(
        `Drive 上の「${d.name}」も削除しますか？\n` +
          'キャンセルすると Drive には残ります（他の端末からは引き続きダウンロードできます）。',
      );
      if (alsoDrive) {
        try {
          await drive.remove(d.driveId);
        } catch (e) {
          alert(`Drive 側を削除できなかったので中止しました。\n${e}`);
          return;
        }
      }
    }
    await deleteDoc(d.id);
    refresh();
  };

  const runSync = async (label: string, task: () => Promise<string>) => {
    if (syncing) return;
    setSyncing(true);
    setSyncMsg(`${label}を開始…`);
    try {
      setSyncMsg(await task());
    } catch (e) {
      setSyncMsg(`${label}に失敗: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
      refresh();
    }
  };

  const onProgress = (p: SyncProgress) => {
    setSyncMsg(progressText(p));
    if (p.phase === 'download' || p.phase === 'upload') refresh();
  };

  const onUpload = () =>
    runSync('アップロード', async () => {
      const r = await uploadToDrive(onProgress);
      const skipped = r.skippedMissing
        ? `、Drive で削除済みのため上げなかったもの ${r.skippedMissing}`
        : '';
      const vids = r.videosUploaded ? `、動画 ${r.videosUploaded}` : '';
      return `アップロード完了: ${r.uploaded} 件、名前変更 ${r.renamed}${vids}${skipped}`;
    });

  const onDownload = () =>
    runSync('ダウンロード', async () => {
      const r = await downloadFromDrive(onProgress);
      const vids = r.videosDownloaded ? `、動画 ${r.videosDownloaded}` : '';
      return `ダウンロード完了: ${r.downloaded} 件、名前変更 ${r.renamed}${vids}`;
    });

  const driveOn = drive.isConfigured();

  return (
    <section className="library">
      <header>
        <h1>Score Viewer</h1>
        <div className="actions">
          {driveOn && (
            <>
              <button
                className="btn icon"
                onClick={onUpload}
                disabled={syncing}
                aria-label="Drive へアップロード"
                title="Drive へアップロード"
              >
                <CloudUpload size={ICON} />
              </button>
              <button
                className="btn icon"
                onClick={onDownload}
                disabled={syncing}
                aria-label="Drive からダウンロード"
                title="Drive からダウンロード"
              >
                <CloudDownload size={ICON} />
              </button>
            </>
          )}
          <button
            className="btn icon"
            onClick={onAddVideo}
            aria-label="YouTube 動画を追加"
            title="YouTube 動画を追加"
          >
            <MonitorPlay size={ICON} />
          </button>
          <label className="btn icon primary" aria-label="PDF を追加" title="PDF を追加">
            <FilePlus size={ICON} />
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

      {items && items.length > 0 && (
        <div className="toolbar">
          <div className="search-wrap">
            <Search size={18} className="search-icon" aria-hidden />
            <input
              type="search"
              className="search"
              placeholder="検索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="検索"
            />
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="並び順"
          >
            <option value="name">名前順</option>
            <option value="added">追加日順</option>
            <option value="opened">最近開いた順</option>
          </select>
        </div>
      )}

      {items && items.length === 0 && (
        <p className="muted">
          まだ何もありません。右上の＋で PDF を取り込むか、YouTube アイコンで動画を追加してください。
        </p>
      )}
      {shown && items && items.length > 0 && shown.length === 0 && (
        <p className="muted">「{query}」に一致する項目はありません。</p>
      )}

      <ul className="doc-list">
        {shown?.map((it) =>
          it.kind === 'pdf' ? (
            <li key={it.key}>
              <button className="doc" onClick={() => onOpen(it.doc.id)}>
                <span className="name">{it.doc.name}</span>
                <span className="meta">
                  {it.doc.pageCount} ページ · 前回 p.{it.doc.lastPage}
                  {it.doc.driveId ? (it.doc.driveMissing ? ' · Drive で削除済み' : ' · Drive') : ''}
                  {it.doc.nameDirty ? '（名前変更を未同期）' : ''}
                </span>
              </button>
              <button
                className="btn icon"
                onClick={() => onRename(it.doc)}
                aria-label="名前変更"
                title="名前変更"
              >
                <TextCursorInput size={ICON} />
              </button>
              <button
                className="btn icon danger"
                onClick={() => onDelete(it.doc)}
                aria-label="削除"
                title="削除"
              >
                <Trash2 size={ICON} />
              </button>
            </li>
          ) : (
            <li key={it.key}>
              <button className="doc" onClick={() => onOpenVideo(it.video.id)}>
                <span className="name">
                  <MonitorPlay size={16} className="inline-icon" aria-hidden /> {it.video.name}
                </span>
                <span className="meta">
                  YouTube
                  {it.video.rate && it.video.rate !== 1 ? ` · ${it.video.rate}×` : ''}
                  {it.video.lastTime ? ` · 前回 ${formatTime(it.video.lastTime)}` : ''}
                  {it.video.synced ? (it.video.driveMissing ? ' · Drive で削除済み' : ' · Drive') : ''}
                </span>
              </button>
              <button
                className="btn icon"
                onClick={() => onRenameVideo(it.video)}
                aria-label="名前変更"
                title="名前変更"
              >
                <TextCursorInput size={ICON} />
              </button>
              <button
                className="btn icon danger"
                onClick={() => onDeleteVideo(it.video)}
                aria-label="削除"
                title="削除"
              >
                <Trash2 size={ICON} />
              </button>
            </li>
          ),
        )}
      </ul>

      <p className="muted small">
        ビューア内: 画面の右（または下）をタップで次へ、左（または上）で前へ、長押しでメニュー。
      </p>
      {driveOn && (
        <p className="muted small">
          ↑ はここにある PDF を Drive の「Score Viewer」フォルダへ上げ、↓ はフォルダにあってここにないものを取り込む。
          他の端末で Drive から消したものは「Drive で削除済み」と表示され、上げ直さない。
        </p>
      )}
    </section>
  );
}
