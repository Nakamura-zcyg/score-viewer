// ローカル (IndexedDB) と Drive のフォルダを突き合わせる。
//   - ローカルにあって Drive にない → アップロード
//   - Drive にあってローカルにない → ダウンロード
//   - 両方にある → 名前をそろえる（アプリで変えた名前は押し出す。それ以外は Drive を正とする）
import { addDoc, getDoc, linkDrive, listDocs, setName, type DocMeta } from './db.ts';
import * as drive from './drive.ts';
import { countPages } from './pdf.ts';

export interface SyncProgress {
  phase: 'auth' | 'list' | 'upload' | 'download' | 'done';
  current?: number;
  total?: number;
  name?: string;
}

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  renamed: number;
}

const stripPdf = (n: string) => n.replace(/\.pdf$/i, '');
const withPdf = (n: string) => `${n}.pdf`;

export async function syncWithDrive(onProgress: (p: SyncProgress) => void): Promise<SyncResult> {
  const result: SyncResult = { uploaded: 0, downloaded: 0, renamed: 0 };

  onProgress({ phase: 'auth' });
  await drive.getToken();

  onProgress({ phase: 'list' });
  const folderId = await drive.ensureFolder();
  const remote = await drive.listFiles(folderId);
  const local = await listDocs();

  const remoteById = new Map(remote.map((f) => [f.id, f]));
  const linkedIds = new Set(local.map((d) => d.driveId).filter(Boolean) as string[]);

  // 1) 未リンクのローカル: 同名の Drive ファイルがあればリンク、なければアップロード
  const unlinked = local.filter((d) => !d.driveId || !remoteById.has(d.driveId));
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

  // 2) リンク済み: 名前の同期
  for (const d of local as DocMeta[]) {
    if (!d.driveId) continue;
    const f = remoteById.get(d.driveId);
    if (!f) continue;
    const remoteName = stripPdf(f.name);
    if (d.nameDirty) {
      if (remoteName !== d.name) {
        await drive.rename(f.id, withPdf(d.name));
        result.renamed++;
      }
      await setName(d.id, d.name, false);
    } else if (remoteName !== d.name) {
      await setName(d.id, remoteName, false);
      result.renamed++;
    }
  }

  // 3) Drive にだけあるもの: ダウンロード
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
