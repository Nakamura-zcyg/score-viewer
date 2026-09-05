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
  markDriveMissing,
  setName,
  type DocMeta,
} from './db.ts';
import * as drive from './drive.ts';
import { countPages } from './pdf.ts';

export interface SyncProgress {
  phase: 'auth' | 'list' | 'upload' | 'download' | 'done';
  current?: number;
  total?: number;
  name?: string;
}

export interface UploadResult {
  uploaded: number;
  renamed: number;
  /** Drive 側で消えていたため上げなかった数 */
  skippedMissing: number;
}

export interface DownloadResult {
  downloaded: number;
  renamed: number;
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
  const result: UploadResult = { uploaded: 0, renamed: 0, skippedMissing: 0 };
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

  onProgress({ phase: 'done' });
  return result;
}

export async function downloadFromDrive(
  onProgress: (p: SyncProgress) => void,
): Promise<DownloadResult> {
  const result: DownloadResult = { downloaded: 0, renamed: 0 };
  const { remote, remoteById, local } = await snapshot(onProgress);
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

  onProgress({ phase: 'done' });
  return result;
}
