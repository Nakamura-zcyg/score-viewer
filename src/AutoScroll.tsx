import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { renderPage, type PageCrop, type PDFDocumentProxy } from './pdf.ts';

// 自動スクロール表示。ページを横幅いっぱいで縦に並べた帯を CSS transform で動かす。
// 毎フレーム canvas を描き直さないので古い端末でも滑らか。見えている前後だけ描画する。
// crops が与えられたときは各ページの上下の白い余白を切り、ページ間の間隔をそろえる。

interface Props {
  pdf: PDFDocumentProxy;
  pageCount: number;
  dims: { w: number; h: number };
  size: { w: number; h: number };
  /** 各ページの内容範囲。null なら余白を切らない */
  crops: PageCrop[] | null;
  startPage: number;
  /** ページ指定ジャンプ。seq が変わるたびに適用 */
  jump: { page: number; seq: number } | null;
  running: boolean;
  /** CSS px / 秒 */
  speed: number;
  onToggle: () => void;
  onEnd: () => void;
  onPage: (page: number) => void;
  onLongPress: () => void;
  menuOpen: boolean;
}

// 余白を切らないときのページ間の隙間 (CSS px)
const GAP_PLAIN = 8;
// 余白を切るとき、内容の上下に残す余白（ページ高さに対する割合）。前後のページ分が合わさって段間になる
const CROP_PAD = 0.015;
const TAP_MAX_MS = 400;
const LONG_PRESS_MS = 500;
const DRAG_START_PX = 12;
const STALE_GESTURE_MS = 3000;

interface Layout {
  scale: number;
  pageH: number;
  /** 各ページの帯内での上端 (px) */
  tops: number[];
  /** 各ページの表示高さ (px) */
  heights: number[];
  /** 各ページで、上端から隠す量 (px) */
  hidden: number[];
  total: number;
  maxY: number;
}

function computeLayout(
  size: { w: number; h: number },
  dims: { w: number; h: number },
  pageCount: number,
  crops: PageCrop[] | null,
): Layout {
  const scale = size.w / dims.w;
  const pageH = dims.h * scale;
  const gap = crops ? 0 : GAP_PLAIN;
  const tops: number[] = [];
  const heights: number[] = [];
  const hidden: number[] = [];
  let y = 0;
  for (let i = 0; i < pageCount; i++) {
    const c = crops?.[i];
    const t = c ? Math.max(0, c.top - CROP_PAD) : 0;
    const b = c ? Math.min(1, c.bottom + CROP_PAD) : 1;
    tops.push(y);
    heights.push((b - t) * pageH);
    hidden.push(t * pageH);
    y += (b - t) * pageH + (i < pageCount - 1 ? gap : 0);
  }
  return { scale, pageH, tops, heights, hidden, total: y, maxY: Math.max(0, y - size.h) };
}

/** y (px) がどのページにあるか。ページ間の隙間は直前のページ扱い */
function pageAt(layout: Layout, y: number): number {
  const { tops } = layout;
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export default function AutoScroll({
  pdf,
  pageCount,
  dims,
  size,
  crops,
  startPage,
  jump,
  running,
  speed,
  onToggle,
  onEnd,
  onPage,
  onLongPress,
  menuOpen,
}: Props) {
  const layout = useMemo(
    () => computeLayout(size, dims, pageCount, crops),
    [size, dims, pageCount, crops],
  );
  const layoutRef = useRef(layout);

  const yRef = useRef<number | null>(null); // 帯のスクロール位置 (px)。初期化前は null
  const stripRef = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState({ first: 1, last: 1 });
  const winRef = useRef(win);
  const lastPageRef = useRef(0);

  const cacheRef = useRef(new Map<number, HTMLCanvasElement>());
  const pendingRef = useRef(new Set<number>());
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  const [, bump] = useState(0);

  const clampY = useCallback((y: number, l: Layout) => Math.min(Math.max(y, 0), l.maxY), []);

  /** transform を更新し、描画ウィンドウと現在ページを再計算 */
  const apply = useCallback(() => {
    const l = layoutRef.current;
    const y = clampY(yRef.current ?? 0, l);
    yRef.current = y;
    const el = stripRef.current;
    if (el) el.style.transform = `translate3d(0, ${-y}px, 0)`;
    const H = size.h;
    const first = pageAt(l, y - H);
    const last = pageAt(l, y + 2 * H);
    if (first !== winRef.current.first || last !== winRef.current.last) {
      winRef.current = { first, last };
      setWin(winRef.current);
    }
    // 画面上部から 30% の位置にあるページを「現在ページ」とする
    const cur = pageAt(l, y + H * 0.3);
    if (cur !== lastPageRef.current) {
      lastPageRef.current = cur;
      onPage(cur);
    }
  }, [clampY, size.h, onPage]);

  // ---- レイアウト変更: 同じページ内の同じ位置に留まる。初回は startPage の先頭 ----
  useEffect(() => {
    const prev = layoutRef.current;
    const y = yRef.current;
    if (y === null) {
      yRef.current = layout.tops[Math.min(Math.max(startPage, 1), pageCount) - 1] ?? 0;
    } else if (prev !== layout) {
      const p = pageAt(prev, y);
      const within = prev.heights[p - 1] > 0 ? (y - prev.tops[p - 1]) / prev.heights[p - 1] : 0;
      yRef.current = layout.tops[p - 1] + Math.min(Math.max(within, 0), 1) * layout.heights[p - 1];
    }
    layoutRef.current = layout;
    if (prev.scale !== layout.scale) {
      cacheRef.current.clear();
      pendingRef.current.clear();
      bump((n) => n + 1);
    }
    apply();
    // startPage は初期位置にだけ使う
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, apply]);

  // ---- ジャンプ ----
  useEffect(() => {
    if (!jump) return;
    yRef.current = layoutRef.current.tops[Math.min(Math.max(jump.page, 1), pageCount) - 1] ?? 0;
    apply();
  }, [jump, apply, pageCount]);

  // ---- 描画ウィンドウ内のページを用意 ----
  useEffect(() => {
    const dpr = window.devicePixelRatio || 1;
    const { first, last } = win;
    const scale = layout.scale;
    for (let p = first; p <= last; p++) {
      if (cacheRef.current.has(p) || pendingRef.current.has(p)) continue;
      pendingRef.current.add(p);
      chainRef.current = chainRef.current
        .then(() => renderPage(pdf, p, scale, dpr))
        .then((c) => {
          pendingRef.current.delete(p);
          if (layoutRef.current.scale !== scale) return; // 描画中に倍率が変わった
          cacheRef.current.set(p, c);
          bump((n) => n + 1);
        })
        .catch((e: unknown) => {
          pendingRef.current.delete(p);
          if (!String(e).includes('Rendering cancelled')) console.error('autoscroll render', p, e);
        });
    }
    // 遠いものは捨てる
    for (const k of Array.from(cacheRef.current.keys())) {
      if (k < first - 1 || k > last + 1) cacheRef.current.delete(k);
    }
  }, [win, pdf, layout.scale]);

  // ---- 自動スクロール ----
  useEffect(() => {
    if (!running) return;
    let id = 0;
    let last = performance.now();
    const tick = (t: number) => {
      const dt = Math.min((t - last) / 1000, 0.1); // タブ復帰時の飛びを抑える
      last = t;
      const l = layoutRef.current;
      const next = (yRef.current ?? 0) + speed * dt;
      const atEnd = next >= l.maxY;
      yRef.current = atEnd ? l.maxY : next;
      apply();
      if (atEnd) {
        onEnd();
        return;
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [running, speed, apply, onEnd]);

  // ---- ジェスチャ: タップ=再生/停止、長押し=メニュー、ドラッグ=手動スクロール ----
  const gRef = useRef<{
    id: number;
    x: number;
    y: number;
    t: number;
    timer: number;
    dragging: boolean;
    consumed: boolean;
    lastY: number;
  } | null>(null);

  const clear = () => {
    if (gRef.current) {
      clearTimeout(gRef.current.timer);
      gRef.current = null;
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (menuOpen) return;
    const stale = gRef.current;
    if (stale) {
      if (performance.now() - stale.t < STALE_GESTURE_MS) return;
      clear();
    }
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* 非対応 */
    }
    const g = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      t: performance.now(),
      timer: 0,
      dragging: false,
      consumed: false,
      lastY: e.clientY,
    };
    g.timer = window.setTimeout(() => {
      if (gRef.current === g && !g.dragging) {
        g.consumed = true;
        onLongPress();
      }
    }, LONG_PRESS_MS);
    gRef.current = g;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gRef.current;
    if (!g || g.id !== e.pointerId) return;
    if (!g.dragging) {
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) <= DRAG_START_PX) return;
      g.dragging = true;
      g.consumed = true;
      clearTimeout(g.timer);
      g.lastY = g.y; // 押した点からの移動量を最初から数える
    }
    const dy = e.clientY - g.lastY;
    g.lastY = e.clientY;
    yRef.current = (yRef.current ?? 0) - dy;
    apply();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gRef.current;
    if (!g || g.id !== e.pointerId) return;
    clear();
    if (g.consumed) return;
    if (performance.now() - g.t > TAP_MAX_MS) return;
    onToggle();
  };

  const pages: number[] = [];
  for (let p = win.first; p <= win.last; p++) pages.push(p);

  return (
    <div
      className="autoscroll"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={clear}
      onLostPointerCapture={clear}
    >
      <div ref={stripRef} className="strip" style={{ height: layout.total }}>
        {pages.map((p) => (
          <PageSlot
            key={p}
            top={layout.tops[p - 1]}
            width={size.w}
            height={layout.heights[p - 1]}
            hidden={layout.hidden[p - 1]}
            pageH={layout.pageH}
            src={cacheRef.current.get(p) ?? null}
          />
        ))}
      </div>
    </div>
  );
}

function PageSlot({
  top,
  width,
  height,
  hidden,
  pageH,
  src,
}: {
  top: number;
  width: number;
  height: number;
  hidden: number;
  pageH: number;
  src: HTMLCanvasElement | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !src) return;
    if (c.width !== src.width || c.height !== src.height) {
      c.width = src.width;
      c.height = src.height;
    }
    c.getContext('2d')!.drawImage(src, 0, 0);
  }, [src]);
  return (
    <div className="page-slot" style={{ top, width, height }}>
      {src ? (
        <canvas ref={ref} style={{ top: -hidden, height: pageH }} />
      ) : (
        <div className="page-placeholder" />
      )}
    </div>
  );
}
