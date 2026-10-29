import type { CSSProperties } from 'react';
import type { Annot } from './annot.ts';

interface Props {
  annots: Annot[];
  page: number;
  /** ページの素の寸法（PDF ポイント）。viewBox に使う */
  dims: { w: number; h: number };
  /** ページ矩形に合わせた絶対配置（left/top/width/height） */
  style: CSSProperties;
}

/**
 * 1 ページ分の書き込みを SVG で重ねる。viewBox をページ寸法にし preserveAspectRatio="none" で
 * ページ矩形いっぱいに伸ばすので、座標の割合 × 寸法 をそのまま使える。
 * pointer-events は none。編集中の入力は AnnotEditor が画面全体で受ける
 */
export default function AnnotLayer({ annots, page, dims, style }: Props) {
  const items = annots.filter((a) => a.page === page);
  if (items.length === 0) return null;
  return (
    <svg
      className="annot-layer"
      viewBox={`0 0 ${dims.w} ${dims.h}`}
      preserveAspectRatio="none"
      style={style}
      aria-hidden
    >
      {items.map((a) =>
        a.kind === 'pen' ? (
          <path
            key={a.id}
            d={pathOf(a.pts, dims)}
            stroke={a.color}
            strokeWidth={a.width * dims.w}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        ) : (
          <text
            key={a.id}
            x={a.x * dims.w}
            y={a.y * dims.h}
            fontSize={a.size * dims.h}
            fill={a.color}
            dominantBaseline="hanging"
            style={{ whiteSpace: 'pre' }}
          >
            {a.text}
          </text>
        ),
      )}
    </svg>
  );
}

function pathOf(pts: number[], dims: { w: number; h: number }): string {
  if (pts.length < 2) return '';
  const f = (i: number) => `${(pts[i] * dims.w).toFixed(1)} ${(pts[i + 1] * dims.h).toFixed(1)}`;
  if (pts.length === 2) {
    // 1 点だけ（タップ）: 点として見えるように同じ位置へ線を引く
    return `M ${f(0)} L ${f(0)}`;
  }
  let d = `M ${f(0)}`;
  for (let i = 2; i + 1 < pts.length; i += 2) d += ` L ${f(i)}`;
  return d;
}
