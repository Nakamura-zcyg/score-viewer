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
  /** リンク先のファイルが Drive 上に見つからない（他の端末で削除された） */
  driveMissing?: boolean;
  /** 自動スクロールの速度 (CSS px/秒)。曲ごとに記憶 */
  scrollSpeed?: number;
  /** 各ページの内容がある縦範囲（割合）。余白カット用。未解析なら undefined */
  crops?: { top: number; bottom: number }[];
  /** 余白カットの楽譜ごとの調整。crops はこの dark/minInk/maxGap で解析したもの。pad は残す余白 % の上書き */
  cropParams?: { dark: number; minInk: number; maxGap?: number; pad?: number };
  /** ページ番号 → 手動で決めた範囲（割合）。自動解析の結果より優先し、再解析でも消えない */
  cropOverrides?: Record<number, { top?: number; bottom?: number }>;
  /** 反復記号用のジャンプ。起点を通過（またはそのページで「次へ」）したら行き先へ飛ぶ */
  jumps?: Jump[];
  /** メトロノームの設定（楽譜ごと） */
  metronome?: MetronomeSettings;
}

export interface MetronomeSettings {
  bpm: number;
  beats: number;
  accent: boolean;
  flash: boolean;
  /** 自動スクロールの速度を BPM から出すときの 1 ページあたりの小節数 */
  measuresPerPage?: number;
}

/** ジャンプ。位置はページ番号と、ページ上端からの高さの割合 (0〜1、余白カット前のページ基準) */
export interface Jump {
  id: string;
  fromPage: number;
  fromFrac: number;
  toPage: number;
  toFrac: number;
  /** 飛ぶ回数。1 番括弧なら 1。回数を使い切ったら通過する */
  times: number;
}

export interface DocRecord extends DocMeta {
  data: ArrayBuffer;
}

const DB_NAME = 'score-viewer';
const DB_VERSION = 2;
const STORE = 'docs';
const VSTORE = 'videos';

/** YouTube 動画の項目（端末内のみ。Drive 同期の対象外） */
export interface VideoMeta {
  id: number;
  name: string;
  videoId: string;
  url: string;
  added: number;
  opened?: number;
  /** 再生速度（記憶） */
  rate?: number;
  /** 最後の再生位置（秒） */
  lastTime?: number;
  /** 名前・速度・位置を最後に変えた時刻。Drive との合流で新しい方を採る */
  updated?: number;
  /** Drive の videos.json に載っている（載せたことがある） */
  synced?: boolean;
  /** Drive の videos.json から消えていた（他の端末で削除された） */
  driveMissing?: boolean;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(VSTORE)) {
        db.createObjectStore(VSTORE, { keyPath: 'id', autoIncrement: true });
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
    delete r.driveMissing;
  });
}

export function setCrops(
  id: number,
  crops: { top: number; bottom: number }[],
  params: { dark: number; minInk: number; maxGap: number },
): Promise<void> {
  return patch(id, (r) => {
    r.crops = crops;
    r.cropParams = {
      ...(r.cropParams ?? {}),
      dark: params.dark,
      minInk: params.minInk,
      maxGap: params.maxGap,
    };
  });
}

/** 楽譜ごとの「残す余白 %」。undefined で全体設定に戻す */
export function setCropPad(id: number, pad: number | undefined): Promise<void> {
  return patch(id, (r) => {
    const { pad: _old, ...rest } = r.cropParams ?? { dark: 160, minInk: 3 };
    r.cropParams = pad === undefined ? rest : { ...rest, pad };
  });
}

/** ページ単位の手動範囲。value が undefined ならそのページの上書きを消す */
export function setJumps(id: number, jumps: Jump[]): Promise<void> {
  return patch(id, (r) => {
    if (jumps.length) r.jumps = jumps;
    else delete r.jumps;
  });
}

export function setCropOverride(
  id: number,
  page: number,
  value: { top?: number; bottom?: number } | undefined,
): Promise<void> {
  return patch(id, (r) => {
    const next = { ...(r.cropOverrides ?? {}) };
    if (value && (value.top !== undefined || value.bottom !== undefined)) next[page] = value;
    else delete next[page];
    if (Object.keys(next).length) r.cropOverrides = next;
    else delete r.cropOverrides;
  });
}

export function setMetronome(id: number, m: MetronomeSettings): Promise<void> {
  return patch(id, (r) => {
    r.metronome = m;
  });
}

export function setScrollSpeed(id: number, scrollSpeed: number): Promise<void> {
  return patch(id, (r) => {
    r.scrollSpeed = scrollSpeed;
  });
}

export function markDriveMissing(id: number, missing: boolean): Promise<void> {
  return patch(id, (r) => {
    if (missing) r.driveMissing = true;
    else delete r.driveMissing;
  });
}

export async function deleteDoc(id: number): Promise<void> {
  const db = await openDB();
  const t = db.transaction(STORE, 'readwrite');
  t.objectStore(STORE).delete(id);
  await done(t);
}

// ---- 動画 ----

export async function listVideos(): Promise<VideoMeta[]> {
  const db = await openDB();
  const t = db.transaction(VSTORE, 'readonly');
  const all = (await request(t.objectStore(VSTORE).getAll())) as VideoMeta[];
  await done(t);
  return all;
}

export async function addVideo(name: string, videoId: string, url: string): Promise<number> {
  const db = await openDB();
  const t = db.transaction(VSTORE, 'readwrite');
  const rec: Omit<VideoMeta, 'id'> = { name, videoId, url, added: Date.now() };
  const id = await request(t.objectStore(VSTORE).add(rec));
  await done(t);
  return id as number;
}

export async function getVideo(id: number): Promise<VideoMeta | undefined> {
  const db = await openDB();
  const t = db.transaction(VSTORE, 'readonly');
  const rec = await request(t.objectStore(VSTORE).get(id));
  await done(t);
  return rec as VideoMeta | undefined;
}

async function patchVideo(id: number, fn: (rec: VideoMeta) => void): Promise<void> {
  const db = await openDB();
  const t = db.transaction(VSTORE, 'readwrite');
  const s = t.objectStore(VSTORE);
  const rec = (await request(s.get(id))) as VideoMeta | undefined;
  if (rec) {
    fn(rec);
    s.put(rec);
  }
  await done(t);
}

export function renameVideo(id: number, name: string): Promise<void> {
  return patchVideo(id, (r) => {
    r.name = name;
    r.updated = Date.now();
  });
}

export function touchVideo(id: number): Promise<void> {
  return patchVideo(id, (r) => {
    r.opened = Date.now();
  });
}

export function setVideoState(id: number, state: { rate?: number; lastTime?: number }): Promise<void> {
  return patchVideo(id, (r) => {
    if (state.rate !== undefined) r.rate = state.rate;
    if (state.lastTime !== undefined) r.lastTime = state.lastTime;
    r.updated = Date.now();
  });
}

/** Drive 側の内容で上書き・追加する（同期用） */
export async function upsertVideoFromRemote(v: {
  videoId: string;
  name: string;
  url: string;
  added: number;
  updated?: number;
  rate?: number;
  lastTime?: number;
}): Promise<void> {
  const db = await openDB();
  const t = db.transaction(VSTORE, 'readwrite');
  const s = t.objectStore(VSTORE);
  const all = (await request(s.getAll())) as VideoMeta[];
  const cur = all.find((x) => x.videoId === v.videoId);
  if (cur) {
    cur.name = v.name;
    cur.rate = v.rate;
    cur.lastTime = v.lastTime;
    cur.updated = v.updated;
    cur.synced = true;
    delete cur.driveMissing;
    s.put(cur);
  } else {
    s.add({ ...v, synced: true });
  }
  await done(t);
}

export function markVideoSynced(id: number, synced: boolean, missing: boolean): Promise<void> {
  return patchVideo(id, (r) => {
    if (synced) r.synced = true;
    else delete r.synced;
    if (missing) r.driveMissing = true;
    else delete r.driveMissing;
  });
}

export async function deleteVideo(id: number): Promise<void> {
  const db = await openDB();
  const t = db.transaction(VSTORE, 'readwrite');
  t.objectStore(VSTORE).delete(id);
  await done(t);
}
