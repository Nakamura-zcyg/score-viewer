// IndexedDB: store "docs" に PDF 本体とメタデータを保存する

export interface DocMeta {
  id: number;
  name: string;
  pageCount: number;
  lastPage: number;
  added: number;
  /** Drive 上のファイル id。未同期なら undefined */
  driveId?: string;
  /** アプリ側で名前を変えて、まだ Drive に押し出していない */
  nameDirty?: boolean;
  /** 最後に開いた時刻 (ms)。未開封なら undefined */
  opened?: number;
}

export interface DocRecord extends DocMeta {
  data: ArrayBuffer;
}

const DB_NAME = 'score-viewer';
const DB_VERSION = 1;
const STORE = 'docs';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** メタデータのみ列挙（ArrayBuffer はコピーしない） */
export async function listDocs(): Promise<DocMeta[]> {
  const db = await openDB();
  const t = db.transaction(STORE, 'readonly');
  const out: DocMeta[] = [];
  const cursorReq = t.objectStore(STORE).openCursor();
  cursorReq.onsuccess = () => {
    const c = cursorReq.result;
    if (!c) return;
    const { data: _data, ...meta } = c.value as DocRecord;
    out.push(meta);
    c.continue();
  };
  await done(t);
  return out.sort((a, b) => b.added - a.added);
}

export async function addDoc(
  name: string,
  data: ArrayBuffer,
  pageCount: number,
  driveId?: string,
): Promise<number> {
  const db = await openDB();
  const t = db.transaction(STORE, 'readwrite');
  const rec: Omit<DocRecord, 'id'> = { name, data, pageCount, lastPage: 1, added: Date.now() };
  if (driveId) rec.driveId = driveId;
  const id = await request(t.objectStore(STORE).add(rec));
  await done(t);
  return id as number;
}

export async function getDoc(id: number): Promise<DocRecord | undefined> {
  const db = await openDB();
  const t = db.transaction(STORE, 'readonly');
  const rec = await request(t.objectStore(STORE).get(id));
  await done(t);
  return rec as DocRecord | undefined;
}

async function patch(id: number, fn: (rec: DocRecord) => void): Promise<void> {
  const db = await openDB();
  const t = db.transaction(STORE, 'readwrite');
  const s = t.objectStore(STORE);
  const rec = (await request(s.get(id))) as DocRecord | undefined;
  if (rec) {
    fn(rec);
    s.put(rec);
  }
  await done(t);
}

export function updateLastPage(id: number, lastPage: number): Promise<void> {
  return patch(id, (r) => {
    r.lastPage = lastPage;
  });
}

/** ユーザー操作での名前変更。Drive へ未反映の印を付ける */
export function renameDoc(id: number, name: string): Promise<void> {
  return setName(id, name, true);
}

export function setName(id: number, name: string, dirty: boolean): Promise<void> {
  return patch(id, (r) => {
    r.name = name;
    if (dirty) r.nameDirty = true;
    else delete r.nameDirty;
  });
}

/** 開いた時刻を記録する（「最近開いた順」用） */
export function touchDoc(id: number): Promise<void> {
  return patch(id, (r) => {
    r.opened = Date.now();
  });
}

export function linkDrive(id: number, driveId: string): Promise<void> {
  return patch(id, (r) => {
    r.driveId = driveId;
  });
}

export async function deleteDoc(id: number): Promise<void> {
  const db = await openDB();
  const t = db.transaction(STORE, 'readwrite');
  t.objectStore(STORE).delete(id);
  await done(t);
}
