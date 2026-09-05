// Google Drive 連携。Google Identity Services でアクセストークンを取り、Drive REST v3 を fetch で叩く。
// スコープは drive.file: このアプリが作ったファイルだけに触れる（審査不要の非機密スコープ）。

export const CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'Score Viewer';
const GSI_SRC = 'https://accounts.google.com/gsi/client';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

// ---- GIS の最小限の型 ----
interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}
interface TokenClient {
  requestAccessToken(opts?: { prompt?: string }): void;
}
declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(cfg: {
            client_id: string;
            scope: string;
            callback: (r: TokenResponse) => void;
            error_callback?: (e: { type: string; message?: string }) => void;
          }): TokenClient;
        };
      };
    };
  }
}

export interface RemoteFile {
  id: string;
  name: string;
  modifiedTime: string;
  size?: string;
}

let gsiLoading: Promise<void> | null = null;
let token: { value: string; expiresAt: number } | null = null;

export function isConfigured(): boolean {
  return CLIENT_ID.length > 0;
}

function loadGsi(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gsiLoading) return gsiLoading;
  gsiLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GSI_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gsiLoading = null;
      reject(new Error('Google のスクリプトを読み込めませんでした（オフライン？）'));
    };
    document.head.appendChild(s);
  });
  return gsiLoading;
}

/**
 * アクセストークンを返す。有効なものが手元にあればそれを使い、なければ Google の同意画面を開く。
 * ユーザー操作（クリック）の直後に呼ぶこと。そうでないとポップアップがブロックされる。
 */
export async function getToken(): Promise<string> {
  if (!isConfigured()) throw new Error('Google クライアント ID が設定されていません');
  if (token && token.expiresAt - Date.now() > 60_000) return token.value;
  await loadGsi();
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (r) => {
        if (r.error || !r.access_token) {
          reject(new Error(r.error_description ?? r.error ?? 'サインインに失敗しました'));
          return;
        }
        token = { value: r.access_token, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 };
        resolve(token.value);
      },
      error_callback: (e) => reject(new Error(e.message ?? e.type)),
    });
    client.requestAccessToken({ prompt: '' });
  });
}

export function forgetToken(): void {
  token = null;
}

async function api(path: string, init: RequestInit = {}, base = API): Promise<Response> {
  const t = await getToken();
  const res = await fetch(base + path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${t}` },
  });
  if (res.status === 401) forgetToken();
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      msg = j.error?.message ?? msg;
    } catch {
      /* 本文なし */
    }
    throw new Error(`Drive API: ${msg}`);
  }
  return res;
}

/** アプリ用フォルダの id を返す。なければ作る */
export async function ensureFolder(): Promise<string> {
  const q = encodeURIComponent(
    `mimeType='application/vnd.google-apps.folder' and name='${FOLDER_NAME}' and trashed=false`,
  );
  const found = (await (await api(`/files?q=${q}&fields=files(id)&pageSize=1`)).json()) as {
    files: { id: string }[];
  };
  if (found.files.length > 0) return found.files[0].id;
  const created = (await (
    await api('/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    })
  ).json()) as { id: string };
  return created.id;
}

/** フォルダ内の PDF 一覧 */
export async function listFiles(folderId: string): Promise<RemoteFile[]> {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const out: RemoteFile[] = [];
  let pageToken = '';
  do {
    const res = await api(
      `/files?q=${q}&fields=nextPageToken,files(id,name,modifiedTime,size)&pageSize=200` +
        (pageToken ? `&pageToken=${pageToken}` : ''),
    );
    const j = (await res.json()) as { files: RemoteFile[]; nextPageToken?: string };
    out.push(...j.files.filter((f) => /\.pdf$/i.test(f.name)));
    pageToken = j.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

export async function download(fileId: string): Promise<ArrayBuffer> {
  const res = await api(`/files/${fileId}?alt=media`);
  return res.arrayBuffer();
}

/** multipart アップロード。戻り値はファイル id */
export async function upload(folderId: string, name: string, data: ArrayBuffer): Promise<string> {
  const meta = { name, parents: [folderId], mimeType: 'application/pdf' };
  const body = new FormData();
  body.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  body.append('file', new Blob([data], { type: 'application/pdf' }));
  const res = await api('/files?uploadType=multipart&fields=id', { method: 'POST', body }, UPLOAD);
  return ((await res.json()) as { id: string }).id;
}

export async function rename(fileId: string, name: string): Promise<void> {
  await api(`/files/${fileId}?fields=id`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export async function remove(fileId: string): Promise<void> {
  try {
    await api(`/files/${fileId}`, { method: 'DELETE' });
  } catch (e) {
    // 既に消えているなら成功扱い
    if (!String(e).includes('404')) throw e;
  }
}
