import { useCallback, useEffect, useRef, useState } from 'react';
import { renderPage, type PDFDocumentProxy } from './pdf.ts';

// 自動スクロール表示。ページを横幅いっぱいで縦に並べた帯を CSS transform で動かす。
// 毎フレーム canvas を描き直さないので古い端末でも滑らか。見えている前後だけ描画する。

interface Props {
  pdf: PDFDocumentProxy;
  pageCount: number;
  dims: { w: number; h: number };
  size: { w: number; h: number };
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

const GAP = 8; // ページ間の隙間 (CSS px)
const TAP_MAX_MS = 400;
const LONG_PRESS_MS = 500;
const DRAG_START_PX = 12;
const STALE_GESTURE_MS = 3000;

export default function AutoScroll({
  pdf,
  pageCount,
  dims,
  size,
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
  const scale = size.w / dims.w;
  const pageH = dims.h * scale;
  const stride = pageH + GAP;
  const total = pageCount * pageH + (pageCount - 1) * GAP;
  const maxY = Math.max(0, total - size.h);

  // 位置は「ページ単位の連続値」で持ち、倍率が変わっても同じ場所に留まるようにする
  const posRef = useRef(startPage - 1); // 0 = 1 ページ目の先頭
  const stripRef = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState({ first: 1, last: 1 });
  const winRef = useRef(win);
  const lastPageRef = useRef(0);

  const cacheRef = useRef(new Map<number, HTMLCanvasElement>());
  const pendingRef = useRef(new Set<number>());
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  const [, bump] = useState(0);

  const yOf = useCallback(() => Math.min(Math.max(posRef.current * stride, 0), maxY), [stride, maxY]);

  /** transform を更新し、描画ウィンドウと現在ページを再計算 */
  const apply = useCallback(() => {
    const y = yOf();
    const el = stripRef.current;
    if (el) el.style.transform = `translate3d(0, ${-y}px, 0)`;
    const H = size.h;
    const first = Math.max(1, Math.floor((y - H) / stride) + 1);
    const last = Math.min(pageCount, Math.floor((y + 2 * H) / stride) + 1);
    if (first !== winRef.current.first || last !== winRef.current.last) {
      winRef.current = { first, last };
      setWin(winRef.current);
    }
    // 画面上部から 30% の位置にあるページを「現在ページ」とする
    const cur = Math.min(pageCount, Math.max(1, Math.floor((y + H * 0.3) / stride) + 1));
    if (cur !== lastPageRef.current) {
      lastPageRef.current = cur;
      onPage(cur);
    }
  }, [yOf, size.h, stride, pageCount, onPage]);

  // ---- 初期位置・ジャンプ ----
  useEffect(() => {
    apply();
  }, [apply]);
  useEffect(() => {
    if (!jump) return;
    posRef.current = jump.page - 1;
    apply();
  }, [jump, apply]);

  // ---- 倍率が変わったらキャッシュを捨てる ----
  useEffect(() => {
    cacheRef.current.clear();
    pendingRef.current.clear();
    bump((n) => n + 1);
  }, [scale]);

  // ---- 描画ウィンドウ内のページを用意 ----
  useEffect(() => {
    const dpr = window.devicePixelRatio || 1;
    const { first, last } = win;
    // 近い順に並べる
    const order: number[] = [];
    for (let p = first; p <= last; p++) order.push(p);
    for (const p of order) {
      if (cacheRef.current.has(p) || pendingRef.current.has(p)) continue;
      pendingRef.current.add(p);
      const s = scale;
      chainRef.current = chainRef.current
        .then(() => renderPage(pdf, p, s, dpr))
        .then((c) => {
          pendingRef.current.delete(p);
          if (s !== scale) return; // 描画中に倍率が変わった
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
  }, [win, pdf, scale]);

  // ---- 自動スクロール ----
  useEffect(() => {
    if (!running) return;
    let id = 0;
    let last = performance.now();
    const tick = (t: number) => {
      const dt = Math.min((t - last) / 1000, 0.1); // タブ復帰時の飛びを抑える
      last = t;
      posRef.current += (speed * dt) / stride;
      const atEnd = posRef.current * stride >= maxY;
      if (atEnd) posRef.current = maxY / stride;
      apply();
      if (atEnd) {
        onEnd();
        return;
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [running, speed, stride, maxY, apply, onEnd]);

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
    posRef.current = Math.min(Math.max(posRef.current - dy / stride, 0), maxY / stride);
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
      <div ref={stripRef} className="strip" style={{ height: total }}>
        {pages.map((p) => (
          <PageSlot
            key={p}
            top={(p - 1) * stride}
            width={size.w}
            height={pageH}
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
  src,
}: {
  top: number;
  width: number;
  height: number;
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
      {src ? <canvas ref={ref} /> : <div className="page-placeholder" />}
    </div>
  );
}
