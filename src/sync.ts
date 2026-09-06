// ローカル (IndexedDB) と Drive のフォルダの突き合わせ。アップロードとダウンロードは別操作。
//
//   アップロード: ローカルにあって Drive にない → 上げる。アプリで変えた名前 → Drive に反映
//   ダウンロード: Drive にあってローカルにない → 降ろす。リンク済みの名前は Drive を正とする
//
// リンク済みなのに Drive 側にファイルがないものは「他の端末で削除済み」とみなし、
// 再アップロードはしない（しないと、削除がデバイス間で永遠に往復する。user 指摘 2026-09-06）。
import {
  addDoc,
  getDoc,
  linkDrive,
  listDocs,
  listVideos,
  markDriveMissing,
  markVideoSynced,
  setName,
  upsertVideoFromRemote,
  type DocMeta,
  type VideoMeta,
} from './db.ts';
import * as drive from './drive.ts';
import { countPages } from './pdf.ts';

export interface SyncProgress {
  phase: 'auth' | 'list' | 'upload' | 'download' | 'videos' | 'done';
  current?: number;
  total?: number;
  name?: string;
}

export interface UploadResult {
  uploaded: number;
  renamed: number;
  /** Drive 側で消えていたため上げなかった数 */
  skippedMissing: number;
  /** videos.json に新しく載せた動画の数 */
  videosUploaded: number;
}

export interface DownloadResult {
  downloaded: number;
  renamed: number;
  /** videos.json から取り込んだ動画の数 */
  videosDownloaded: number;
}

// ---- 動画一覧の同期: フォルダ内の videos.json 1 つに全端末の一覧を合流させる ----
const VIDEOS_FILE = 'videos.json';

interface RemoteVideo {
  videoId: string;
  name: string;
  url: string;
  added: number;
  updated?: number;
  rate?: number;
  lastTime?: number;
}
interface VideosFile {
  version: 1;
  videos: RemoteVideo[];
}

async function readVideosFile(folderId: string): Promise<{ id: string | null; list: RemoteVideo[] }> {
  const id = await drive.findFile(folderId, VIDEOS_FILE);
  if (!id) return { id: null, list: [] };
  try {
    const j = await drive.downloadJson<VideosFile>(id);
    return { id, list: Array.isArray(j.videos) ? j.videos : [] };
  } catch {
    return { id, list: [] };
  }
}

const toRemote = (v: VideoMeta): RemoteVideo => ({
  videoId: v.videoId,
  name: v.name,
  url: v.url,
  added: v.added,
  updated: v.updated,
  rate: v.rate,
  lastTime: v.lastTime,
});

/** 端末の一覧を videos.json に合流させる。戻り値は新しく載せた数 */
async function uploadVideos(folderId: string): Promise<number> {
  const local = await listVideos();
  const { id, list } = await readVideosFile(folderId);
  const remote = new Map(list.map((v) => [v.videoId, v]));
  let added = 0;
  for (const v of local) {
    const r = remote.get(v.videoId);
    if (!r) {
      if (v.synced) {
        // 載せたことがあるのに消えている: 他の端末で削除された。上げ直さない
        await markVideoSynced(v.id, true, true);
        continue;
      }
      remote.set(v.videoId, toRemote(v));
      added++;
    } else if ((v.updated ?? 0) > (r.updated ?? 0)) {
      remote.set(v.videoId, toRemote(v));
    }
    await markVideoSynced(v.id, true, false);
  }
  const file: VideosFile = { version: 1, videos: Array.from(remote.values()) };
  await drive.uploadJson(folderId, VIDEOS_FILE, id, file);
  return added;
}

/** videos.json の内容を端末に取り込む。戻り値は新しく追加した数 */
async function downloadVideos(folderId: string): Promise<number> {
  const { list } = await readVideosFile(folderId);
  const local = await listVideos();
  const localById = new Map(local.map((v) => [v.videoId, v]));
  let added = 0;
  for (const r of list) {
    const v = localById.get(r.videoId);
    if (!v) {
      await upsertVideoFromRemote(r);
      added++;
    } else if ((r.updated ?? 0) > (v.updated ?? 0)) {
      await upsertVideoFromRemote(r);
    } else if (!v.synced || v.driveMissing) {
      await markVideoSynced(v.id, true, false);
    }
  }
  const remoteIds = new Set(list.map((r) => r.videoId));
  for (const v of local) {
    if (v.synced && !remoteIds.has(v.videoId) && !v.driveMissing) {
      await markVideoSynced(v.id, true, true);
    }
  }
  return added;
}

/** 動画を Drive の一覧から外す（削除の 2 段階目） */
export async function removeVideoFromDrive(videoId: string): Promise<void> {
  await drive.getToken();
  const folderId = await drive.ensureFolder();
  const { id, list } = await readVideosFile(folderId);
  const next = list.filter((v) => v.videoId !== videoId);
  if (next.length === list.length) return;
  await drive.uploadJson(folderId, VIDEOS_FILE, id, { version: 1, videos: next } as VideosFile);
}

const stripPdf = (n: string) => n.replace(/\.pdf$/i, '');
const withPdf = (n: string) => `${n}.pdf`;

interface Snapshot {
  folderId: string;
  remote: drive.RemoteFile[];
  remoteById: Map<string, drive.RemoteFile>;
  local: DocMeta[];
}

/** 認証 → フォルダ → 一覧取得。リンク切れの印もここで更新する */
async function snapshot(onProgress: (p: SyncProgress) => void): Promise<Snapshot> {
  onProgress({ phase: 'auth' });
  await drive.getToken();
  onProgress({ phase: 'list' });
  const folderId = await drive.ensureFolder();
  const remote = await drive.listFiles(folderId);
  const remoteById = new Map(remote.map((f) => [f.id, f]));
  const local = await listDocs();
  for (const d of local) {
    if (!d.driveId) continue;
    const missing = !remoteById.has(d.driveId);
    if (missing !== Boolean(d.driveMissing)) {
      await markDriveMissing(d.id, missing);
      d.driveMissing = missing;
    }
  }
  return { folderId, remote, remoteById, local };
}

export async function uploadToDrive(onProgress: (p: SyncProgress) => void): Promise<UploadResult> {
  const result: UploadResult = { uploaded: 0, renamed: 0, skippedMissing: 0, videosUploaded: 0 };
  const { folderId, remote, remoteById, local } = await snapshot(onProgress);
  const linkedIds = new Set(
    local.filter((d) => d.driveId && remoteById.has(d.driveId)).map((d) => d.driveId as string),
  );

  // 1) 未リンク: 同名の Drive ファイルがあればリンク、なければアップロード
  const unlinked = local.filter((d) => !d.driveId);
  result.skippedMissing = local.filter((d) => d.driveId && !remoteById.has(d.driveId)).length;
  for (let i = 0; i < unlinked.length; i++) {
    const d = unlinked[i];
    onProgress({ phase: 'upload', current: i + 1, total: unlinked.length, name: d.name });
    const sameName = remote.find((f) => !linkedIds.has(f.id) && stripPdf(f.name) === d.name);
    if (sameName) {
      await linkDrive(d.id, sameName.id);
      linkedIds.add(sameName.id);
      continue;
    }
    const rec = await getDoc(d.id);
    if (!rec) continue;
    const id = await drive.upload(folderId, withPdf(d.name), rec.data);
    await linkDrive(d.id, id);
    linkedIds.add(id);
    result.uploaded++;
  }

  // 2) アプリで変えた名前を Drive に反映
  for (const d of local) {
    if (!d.driveId || !d.nameDirty) continue;
    const f = remoteById.get(d.driveId);
    if (!f) continue;
    if (stripPdf(f.name) !== d.name) {
      await drive.rename(f.id, withPdf(d.name));
      result.renamed++;
    }
    await setName(d.id, d.name, false);
  }

  // 3) 動画一覧
  onProgress({ phase: 'videos' });
  result.videosUploaded = await uploadVideos(folderId);

  onProgress({ phase: 'done' });
  return result;
}

export async function downloadFromDrive(
  onProgress: (p: SyncProgress) => void,
): Promise<DownloadResult> {
  const result: DownloadResult = { downloaded: 0, renamed: 0, videosDownloaded: 0 };
  const { folderId, remote, remoteById, local } = await snapshot(onProgress);
  const linkedIds = new Set(local.map((d) => d.driveId).filter(Boolean) as string[]);

  // 1) リンク済み: Drive 側の名前を取り込む（アプリで変えて未反映のものは触らない）
  for (const d of local) {
    if (!d.driveId || d.nameDirty) continue;
    const f = remoteById.get(d.driveId);
    if (!f) continue;
    const remoteName = stripPdf(f.name);
    if (remoteName !== d.name) {
      await setName(d.id, remoteName, false);
      result.renamed++;
    }
  }

  // 2) Drive にだけあるもの: ダウンロード
  const missing = remote.filter((f) => !linkedIds.has(f.id));
  for (let i = 0; i < missing.length; i++) {
    const f = missing[i];
    onProgress({ phase: 'download', current: i + 1, total: missing.length, name: f.name });
    const data = await drive.download(f.id);
    let pages = 0;
    try {
      pages = await countPages(data);
    } catch {
      continue; // PDF として読めないものは取り込まない
    }
    await addDoc(stripPdf(f.name), data, pages, f.id);
    result.downloaded++;
  }

  // 3) 動画一覧
  onProgress({ phase: 'videos' });
  result.videosDownloaded = await downloadVideos(folderId);

  onProgress({ phase: 'done' });
  return result;
}
