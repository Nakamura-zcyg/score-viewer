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

/** 余白検出のパラメータ。楽譜ごとに変えられる */
export interface CropParams {
  /** 明度がこれ未満の画素を「インク」とみなす (0〜255)。大きいほど薄い線も拾う */
  dark: number;
  /** 1 行にインク画素がこれ以上あれば「内容あり」。スキャンのゴミを無視する */
  minInk: number;
  /**
   * インクの塊どうしを「同じ内容」とみなす最大の隙間（ページ高さに対する割合）。
   * これより広い白い帯で本体から離れた小さな塊（ページ番号・ヘッダ）は無視する。0 で無効
   */
  maxGap: number;
}
export const DEFAULT_CROP_PARAMS: CropParams = { dark: 160, minInk: 3, maxGap: 0.04 };

/** 端の塊を「小さい」とみなす高さ（ページ高さに対する割合）。五線 1 段はこれより大きい */
const CROP_SMALL_BAND = 0.02;

/**
 * インクのある行の並びから内容の範囲 [first, last] を決める。
 * 1) 連続したインク行を塊にまとめ、隙間が maxGap 未満の塊どうしを結合する
 * 2) 両端の「小さい」塊（ページ番号・ヘッダ）を落とし、残った塊の全体を範囲とする
 * 内容が見つからなければ null。
 */
export function contentRange(
  inkRows: Uint8Array,
  maxGapRows: number,
  smallRows: number,
): [number, number] | null {
  const bands: [number, number][] = [];
  let start = -1;
  for (let y = 0; y <= inkRows.length; y++) {
    const ink = y < inkRows.length && inkRows[y] === 1;
    if (ink && start < 0) start = y;
    if (!ink && start >= 0) {
      bands.push([start, y - 1]);
      start = -1;
    }
  }
  if (bands.length === 0) return null;
  const full: [number, number] = [bands[0][0], bands[bands.length - 1][1]];
  // 0 なら規則を使わず、最初と最後のインク行
  if (maxGapRows <= 0) return full;
  // 隙間が maxGapRows 未満なら結合
  const clusters: [number, number][] = [[...bands[0]]];
  for (let i = 1; i < bands.length; i++) {
    const last = clusters[clusters.length - 1];
    if (bands[i][0] - last[1] - 1 < maxGapRows) last[1] = bands[i][1];
    else clusters.push([...bands[i]]);
  }
  const big = (c: [number, number]) => c[1] - c[0] + 1 >= smallRows;
  let lo = 0;
  let hi = clusters.length - 1;
  while (lo < hi && !big(clusters[lo])) lo++;
  while (hi > lo && !big(clusters[hi])) hi--;
  // 大きい塊が 1 つもなければ全体を使う
  if (!big(clusters[lo]) && !big(clusters[hi])) return full;
  const range: [number, number] = [clusters[lo][0], clusters[hi][1]];
  // 保険: 落とした側にインクの半分以上があるなら、規則が外れているので全体に戻す
  let inside = 0;
  let total = 0;
  for (let y = 0; y < inkRows.length; y++) {
    if (inkRows[y] !== 1) continue;
    total++;
    if (y >= range[0] && y <= range[1]) inside++;
  }
  return inside * 2 < total ? full : range;
}

/**
 * 全ページの上下余白を検出する。各ページを小さく描いて、暗い画素のある最初と最後の行を探す。
 * 内容が見つからないページは全体 (0〜1) を返す。
 */
export async function analyzeCrops(
  doc: PDFDocumentProxy,
  params: CropParams,
  onProgress?: (done: number, total: number) => void,
): Promise<PageCrop[]> {
  const { dark, minInk, maxGap } = params;
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
    const inkRows = new Uint8Array(h);
    for (let y = 0; y < h; y++) {
      let ink = 0;
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        // 明度の近似として G チャンネルを見る
        if (px[row + x * 4 + 1] < dark && ++ink >= minInk) break;
      }
      if (ink >= minInk) inkRows[y] = 1;
    }
    const range = contentRange(inkRows, Math.round(maxGap * h), Math.round(CROP_SMALL_BAND * h));
    out.push(range ? { top: range[0] / h, bottom: (range[1] + 1) / h } : { top: 0, bottom: 1 });
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
