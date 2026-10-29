// 書き込み（ペン・テキスト）のデータ型と幾何計算。
//
// 座標はすべて「ページに対する割合」(0〜1)。x はページ幅、y はページ高さに対する割合で、
// 余白カット前のページ基準。表示モード（ページ／半ページ／横幅／スクロール）に依らず同じ値を使い、
// 描画側が各モードのページ矩形に合わせて伸縮する。
// 線の太さはページ幅に対する割合、文字の大きさはページ高さに対する割合。

export interface Stroke {
  kind: 'pen';
  id: string;
  page: number;
  color: string;
  /** ページ幅に対する割合 */
  width: number;
  /** [x0, y0, x1, y1, ...] 割合 */
  pts: number[];
}

export interface TextNote {
  kind: 'text';
  id: string;
  page: number;
  x: number;
  y: number;
  text: string;
  /** ページ高さに対する割合（1 行の高さ） */
  size: number;
  color: string;
}

export type Annot = Stroke | TextNote;

export type Tool = 'pen' | 'text' | 'eraser';

export const ANNOT_COLORS = [
  { name: '赤', value: '#e53935' },
  { name: '青', value: '#1e88e5' },
  { name: '緑', value: '#2e7d32' },
  { name: '黒', value: '#111111' },
];

/** ペンの太さ（ページ幅に対する割合） */
export const ANNOT_SIZES = [
  { name: '細', width: 0.003 },
  { name: '中', width: 0.006 },
  { name: '太', width: 0.012 },
];

/**
 * 文字の大きさ（ページ高さに対する割合）。5 段階、特大は旧「太」(0.04) と同じ
 * （2026-10-30 user「極小・小・中・大・特大、今の太が特大くらい」）。ボタンは大きさの違う「A」で示す
 */
export const TEXT_SIZES = [
  { name: '極小', size: 0.012, iconPx: 9 },
  { name: '小', size: 0.018, iconPx: 12 },
  { name: '中', size: 0.026, iconPx: 15 },
  { name: '大', size: 0.033, iconPx: 19 },
  { name: '特大', size: 0.04, iconPx: 24 },
];

export function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** 画面上の点 → ページ内の割合。描画側が各モードに合わせて実装する */
export interface PagePoint {
  page: number;
  x: number;
  y: number;
  /** 画面上でのページ幅 (CSS px)。しきい値の換算に使う */
  pageWidthPx: number;
}

/** 点と線分の距離（ページ単位: w×h の座標系） */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** テキストのおおよその幅（割合）。等幅とみなして 0.55em × 文字数（全角は 1em） */
export function textWidthFrac(t: TextNote, dims: { w: number; h: number }): number {
  let em = 0;
  for (const ch of t.text) em += ch.charCodeAt(0) > 0x2e7f ? 1 : 0.55;
  return (em * t.size * dims.h) / dims.w;
}

/**
 * 消しゴム: 点 (x, y 割合) から半径 r (CSS px) 以内にある書き込みの id。
 * 線は各線分との距離、テキストは外接矩形で判定する
 */
export function hitTest(
  annots: Annot[],
  page: number,
  x: number,
  y: number,
  radiusPx: number,
  pageWidthPx: number,
  dims: { w: number; h: number },
): string[] {
  const scale = pageWidthPx / dims.w; // CSS px / ページ単位
  const r = radiusPx / scale; // ページ単位
  const px = x * dims.w;
  const py = y * dims.h;
  const out: string[] = [];
  for (const a of annots) {
    if (a.page !== page) continue;
    if (a.kind === 'pen') {
      const half = (a.width * dims.w) / 2;
      const p = a.pts;
      let hit = false;
      if (p.length === 2) hit = Math.hypot(px - p[0] * dims.w, py - p[1] * dims.h) <= r + half;
      for (let i = 0; !hit && i + 3 < p.length; i += 2) {
        const d = segDist(px, py, p[i] * dims.w, p[i + 1] * dims.h, p[i + 2] * dims.w, p[i + 3] * dims.h);
        if (d <= r + half) hit = true;
      }
      if (hit) out.push(a.id);
    } else {
      const w = textWidthFrac(a, dims) * dims.w;
      const h = a.size * dims.h;
      const ax = a.x * dims.w;
      const ay = a.y * dims.h;
      if (px >= ax - r && px <= ax + w + r && py >= ay - r && py <= ay + h + r) out.push(a.id);
    }
  }
  return out;
}

/** テキストの当たり判定だけ（テキストツールで既存の文字をタップして編集する用） */
export function textAt(
  annots: Annot[],
  page: number,
  x: number,
  y: number,
  dims: { w: number; h: number },
): TextNote | null {
  for (const a of annots) {
    if (a.kind !== 'text' || a.page !== page) continue;
    const w = textWidthFrac(a, dims);
    if (x >= a.x && x <= a.x + w && y >= a.y && y <= a.y + a.size) return a;
  }
  return null;
}
