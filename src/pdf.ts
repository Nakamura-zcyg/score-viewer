// PDF.js の薄いラッパ。legacy build を使い、古い Chrome でも動くようにする。
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export type { PDFDocumentProxy };

let workerReady: Promise<void> | null = null;

/**
 * ワーカーのコードを通常の fetch で取り寄せ、Blob URL から起動するようにする。
 * pdf.js はモジュール形式の Worker を URL 直指定で起動するが、その読み込みを
 * Service Worker が横取りしない環境があり、オフラインで「読み込み中」のまま止まる。
 * 通常の fetch は必ず Service Worker を通るので、キャッシュ済みなら圏外でも届く。
 * 取り寄せに失敗したら従来どおり URL 直指定に戻す。
 */
function ensureWorker(): Promise<void> {
  if (!workerReady) {
    workerReady = (async () => {
      try {
        const res = await fetch(workerUrl);
        if (!res.ok) throw new Error(`worker ${res.status}`);
        const code = await res.text();
        const blob = new Blob([code], { type: 'text/javascript' });
        pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
      } catch {
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      }
    })();
  }
  return workerReady;
}

/** ArrayBuffer から読み込む。pdf.js はバッファを worker に転送して使えなくするので複製を渡す */
export async function loadPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  await ensureWorker();
  return pdfjsLib.getDocument({ data: data.slice(0) }).promise;
}

/** ページ数だけ取り出す（取り込み時のメタデータ用） */
export async function countPages(data: ArrayBuffer): Promise<number> {
  const doc = await loadPdf(data);
  const n = doc.numPages;
  await doc.destroy();
  return n;
}

/** ページの素の寸法（scale 1 の PDF ポイント） */
export async function pageSize(doc: PDFDocumentProxy, pageNum: number): Promise<{ w: number; h: number }> {
  const page = await doc.getPage(pageNum);
  const v = page.getViewport({ scale: 1 });
  return { w: v.width, h: v.height };
}

/** ページ内で印刷内容がある縦範囲（ページ高さに対する割合 0〜1） */
export interface PageCrop {
  top: number;
  bottom: number;
}

// 余白検出: この幅 (px) に縮小して走査する。楽譜の段は太いので粗くて足りる
const CROP_SCAN_WIDTH = 160;
// 1 行に暗い画素がこれ以上あれば「内容あり」。スキャンのゴミを無視する
const CROP_MIN_INK = 3;
const CROP_DARK = 160;

/**
 * 全ページの上下余白を検出する。各ページを小さく描いて、暗い画素のある最初と最後の行を探す。
 * 内容が見つからないページは全体 (0〜1) を返す。
 */
export async function analyzeCrops(
  doc: PDFDocumentProxy,
  onProgress?: (done: number, total: number) => void,
): Promise<PageCrop[]> {
  const out: PageCrop[] = [];
  const n = doc.numPages;
  for (let p = 1; p <= n; p++) {
    const page = await doc.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: CROP_SCAN_WIDTH / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
    page.cleanup();

    const { width: w, height: h } = canvas;
    const px = ctx.getImageData(0, 0, w, h).data;
    let first = -1;
    let last = -1;
    for (let y = 0; y < h; y++) {
      let ink = 0;
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        // 明度の近似として G チャンネルを見る
        if (px[row + x * 4 + 1] < CROP_DARK && ++ink >= CROP_MIN_INK) break;
      }
      if (ink >= CROP_MIN_INK) {
        if (first < 0) first = y;
        last = y;
      }
    }
    out.push(first < 0 ? { top: 0, bottom: 1 } : { top: first / h, bottom: (last + 1) / h });
    onProgress?.(p, n);
  }
  return out;
}

/**
 * 1 ページを CSS px 換算 scale で描画したオフスクリーン canvas を返す。
 * 実ピクセルは dpr 倍で確保する。
 */
export async function renderPage(
  doc: PDFDocumentProxy,
  pageNum: number,
  scale: number,
  dpr: number,
): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale: scale * dpr });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // intent 'print': pdf.js は表示用描画を requestAnimationFrame で進めるため、
  // タブが裏に回っている間は完了しない。印刷用は rAF を使わないので先読みが止まらない。
  await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
  page.cleanup();
  return canvas;
}
