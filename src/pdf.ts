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
