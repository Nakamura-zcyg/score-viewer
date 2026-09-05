import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { updateLastPage, type DocRecord } from './db.ts';
import { loadPdf, pageSize, renderPage, type PDFDocumentProxy } from './pdf.ts';

interface Props {
  doc: DocRecord;
  onExit: () => void;
}

// タップ判定: 指が触れてから離すまでがこれ未満なら「タップ」
const TAP_MAX_MS = 400;
// 長押し判定: 触れたままこれ以上経ったら「長押し」
const LONG_PRESS_MS = 500;
// これ以上動いたらタップ／長押しのどちらでもない
const MOVE_CANCEL_PX = 12;
// 先読みするページ数（前後）
const PREFETCH = 2;
// 半ページモード: 上下それぞれが表示するページ高さの割合。0.5 なら重なりなし、0.575 なら 15% 重なる
const HALF_VIEW_FRACTION = 0.575;

/** 繰りモード。auto は横向きなら half、縦向きなら page */
type TurnMode = 'auto' | 'page' | 'half';
type EffectiveMode = 'page' | 'half';
const MODE_KEY = 'score-viewer.turnMode';

function loadMode(): TurnMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === 'page' || v === 'half' || v === 'auto') return v;
  } catch {
    /* 無視 */
  }
  return 'auto';
}

interface Layout {
  /** CSS px 換算の描画倍率 */
  scale: number;
  /** 各スライスの縦オフセット (CSS px)。page モードは [0] */
  slices: number[];
  pageW: number;
  pageH: number;
}

function computeLayout(
  mode: EffectiveMode,
  size: { w: number; h: number },
  dims: { w: number; h: number },
): Layout {
  const { w: W, h: H } = size;
  if (mode === 'page') {
    const scale = Math.min(W / dims.w, H / dims.h);
    return { scale, slices: [0], pageW: dims.w * scale, pageH: dims.h * scale };
  }
  // half: 横幅いっぱい、ただし 1 画面がページ高さの HALF_VIEW_FRACTION を超えないよう縮める
  const scale = Math.min(W / dims.w, H / (HALF_VIEW_FRACTION * dims.h));
  const pageH = dims.h * scale;
  if (pageH <= H + 0.5) {
    return { scale, slices: [0], pageW: dims.w * scale, pageH };
  }
  const f = H / pageH; // 1 画面に入るページ高さの割合
  const n = f >= 0.5 ? 2 : Math.ceil(1 / f);
  const slices: number[] = [];
  for (let i = 0; i < n; i++) slices.push(Math.round((i * (pageH - H)) / (n - 1)));
  return { scale, slices, pageW: dims.w * scale, pageH };
}

interface Pos {
  page: number;
  slice: number;
}

export default function Viewer({ doc, onExit }: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [pos, setPos] = useState<Pos>(() => ({
    page: Math.min(Math.max(doc.lastPage, 1), doc.pageCount),
    slice: 0,
  }));
  const [menuOpen, setMenuOpen] = useState(false);
  const [indicator, setIndicator] = useState<string | null>(null);
  const [gotoValue, setGotoValue] = useState('');
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [modeSetting, setModeSetting] = useState<TurnMode>(loadMode);

  const effMode: EffectiveMode =
    modeSetting === 'auto' ? (size.w > size.h ? 'half' : 'page') : modeSetting;

  const layout = useMemo(
    () => (dims ? computeLayout(effMode, size, dims) : null),
    [effMode, size, dims],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cacheRef = useRef(new Map<number, HTMLCanvasElement>());
  const pendingRef = useRef(new Map<number, Promise<HTMLCanvasElement>>());
  const renderChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const posRef = useRef(pos);
  posRef.current = pos;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // ---- PDF 読み込み ----
  useEffect(() => {
    let alive = true;
    let loaded: PDFDocumentProxy | null = null;
    loadPdf(doc.data).then(async (d) => {
      if (!alive) {
        d.destroy();
        return;
      }
      loaded = d;
      // 全ページ同寸法とみなし、1 ページ目の寸法でレイアウトを決める
      const s = await pageSize(d, 1);
      if (!alive) return;
      setDims(s);
      setPdf(d);
    });
    return () => {
      alive = false;
      loaded?.destroy();
    };
  }, [doc]);

  // ---- 画面サイズ変化 ----
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ---- 倍率が変わったらキャッシュを捨て、スライスを先頭に戻す ----
  useEffect(() => {
    cacheRef.current.clear();
    pendingRef.current.clear();
    setPos((p) => (p.slice === 0 ? p : { ...p, slice: 0 }));
  }, [layout?.scale, effMode]);

  // ---- モード設定の保存 ----
  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, modeSetting);
    } catch {
      /* 無視 */
    }
  }, [modeSetting]);

  // ---- ページ描画（直列キュー） ----
  const getPageCanvas = useCallback(
    (n: number): Promise<HTMLCanvasElement> => {
      const cached = cacheRef.current.get(n);
      if (cached) return Promise.resolve(cached);
      const pending = pendingRef.current.get(n);
      if (pending) return pending;
      if (!pdf || !layout) return Promise.reject(new Error('not ready'));

      const dpr = window.devicePixelRatio || 1;
      const scale = layout.scale;
      const p = renderChainRef.current
        .then(() => renderPage(pdf, n, scale, dpr))
        .then((c) => {
          // 描画中に倍率が変わっていたら捨てる
          if (layoutRef.current?.scale === scale) cacheRef.current.set(n, c);
          pendingRef.current.delete(n);
          return c;
        });
      pendingRef.current.set(n, p);
      // 失敗してもチェーンは止めない
      renderChainRef.current = p.catch(() => undefined);
      return p;
    },
    [pdf, layout],
  );

  // 表示中の位置を display canvas に転写し、前後を先読み
  useEffect(() => {
    if (!pdf || !layout) return;
    let alive = true;
    const canvas = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(size.w * dpr);
    const H = Math.round(size.h * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const { page, slice } = pos;
    const offset = layout.slices[Math.min(slice, layout.slices.length - 1)] ?? 0;

    getPageCanvas(page).then((src) => {
      if (!alive) return;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      const x = Math.floor((W - src.width) / 2);
      // ページが画面に収まるなら縦中央、収まらないならスライスのオフセット分ずらす
      const y = src.height <= H ? Math.floor((H - src.height) / 2) : -Math.round(offset * dpr);
      ctx.drawImage(src, x, y);
    });

    // 先読み: 次 → 前 → 次々 → 前々 の順
    const order: number[] = [];
    for (let k = 1; k <= PREFETCH; k++) {
      if (page + k <= doc.pageCount) order.push(page + k);
      if (page - k >= 1) order.push(page - k);
    }
    order.forEach((n) => getPageCanvas(n).catch(() => undefined));

    // 範囲外のキャッシュを捨てる
    for (const k of Array.from(cacheRef.current.keys())) {
      if (Math.abs(k - page) > PREFETCH) cacheRef.current.delete(k);
    }

    return () => {
      alive = false;
    };
  }, [pdf, layout, pos, size, getPageCanvas, doc.pageCount]);

  // ---- 最後に見ていたページを保存 ----
  useEffect(() => {
    const t = setTimeout(() => updateLastPage(doc.id, pos.page).catch(() => undefined), 300);
    return () => clearTimeout(t);
  }, [doc.id, pos.page]);

  // ---- 位置表示 ----
  useEffect(() => {
    if (indicator === null) return;
    const t = setTimeout(() => setIndicator(null), 900);
    return () => clearTimeout(t);
  }, [indicator]);

  const describe = useCallback(
    (p: Pos) => {
      const n = layoutRef.current?.slices.length ?? 1;
      if (n <= 1) return `${p.page} / ${doc.pageCount}`;
      const part = n === 2 ? (p.slice === 0 ? '上' : '下') : `${p.slice + 1}/${n}`;
      return `${p.page} / ${doc.pageCount}  ${part}`;
    },
    [doc.pageCount],
  );

  // ---- ページ・スライス移動 ----
  const moveTo = useCallback(
    (p: Pos) => {
      setPos(p);
      setIndicator(describe(p));
    },
    [describe],
  );

  const next = useCallback(() => {
    const cur = posRef.current;
    const n = layoutRef.current?.slices.length ?? 1;
    if (cur.slice + 1 < n) return moveTo({ page: cur.page, slice: cur.slice + 1 });
    if (cur.page < doc.pageCount) return moveTo({ page: cur.page + 1, slice: 0 });
    setIndicator('最後のページ');
  }, [doc.pageCount, moveTo]);

  const prev = useCallback(() => {
    const cur = posRef.current;
    const n = layoutRef.current?.slices.length ?? 1;
    if (cur.slice > 0) return moveTo({ page: cur.page, slice: cur.slice - 1 });
    if (cur.page > 1) return moveTo({ page: cur.page - 1, slice: n - 1 });
    setIndicator('最初のページ');
  }, [moveTo]);

  const goToPage = useCallback(
    (n: number) => moveTo({ page: Math.min(Math.max(n, 1), doc.pageCount), slice: 0 }),
    [doc.pageCount, moveTo],
  );

  // ---- タップ／長押し判定 ----
  const gestureRef = useRef<{
    id: number;
    x: number;
    y: number;
    t: number;
    timer: number;
    consumed: boolean;
  } | null>(null);

  const clearGesture = () => {
    if (gestureRef.current) {
      clearTimeout(gestureRef.current.timer);
      gestureRef.current = null;
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (menuOpen) return;
    if (gestureRef.current) return; // 2 本目以降は無視
    const g = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      t: performance.now(),
      timer: 0,
      consumed: false,
    };
    g.timer = window.setTimeout(() => {
      if (gestureRef.current === g) {
        g.consumed = true;
        setMenuOpen(true);
      }
    }, LONG_PRESS_MS);
    gestureRef.current = g;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g || g.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - g.x, e.clientY - g.y) > MOVE_CANCEL_PX) {
      clearTimeout(g.timer);
      g.consumed = true;
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g || g.id !== e.pointerId) return;
    clearGesture();
    if (g.consumed) return;
    const dt = performance.now() - g.t;
    if (dt > TAP_MAX_MS) return;
    const el = containerRef.current;
    const w = el?.clientWidth ?? window.innerWidth;
    const h = el?.clientHeight ?? window.innerHeight;
    // page モード: 左右で判定。half モード: 上下で判定
    const isPrev = effMode === 'half' ? e.clientY < h / 2 : e.clientX < w / 2;
    if (isPrev) prev();
    else next();
  };

  const onPointerCancel = () => clearGesture();

  // ---- キーボード（Bluetooth ペダル・外付けキー） ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (menuOpen) {
        if (e.key === 'Escape') setMenuOpen(false);
        return;
      }
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
        case 'Enter':
          e.preventDefault();
          next();
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
        case 'Backspace':
          e.preventDefault();
          prev();
          break;
        case 'Escape':
          setMenuOpen(true);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen, next, prev]);

  // ---- 画面消灯防止 ----
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    const acquire = async () => {
      try {
        lock = await navigator.wakeLock?.request('screen');
      } catch {
        /* 非対応や省電力モードでは失敗する。無視 */
      }
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') acquire();
    };
    acquire();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      lock?.release().catch(() => undefined);
    };
  }, []);

  // ---- 右クリック／長押しメニュー抑止 ----
  useEffect(() => {
    const block = (e: Event) => e.preventDefault();
    document.addEventListener('contextmenu', block);
    return () => document.removeEventListener('contextmenu', block);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      /* 非対応 */
    }
  };

  const submitGoto = () => {
    const n = parseInt(gotoValue, 10);
    if (Number.isFinite(n)) {
      goToPage(n);
      setGotoValue('');
      setMenuOpen(false);
    }
  };

  const sliceCount = layout?.slices.length ?? 1;

  return (
    <div
      ref={containerRef}
      className="viewer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <canvas ref={canvasRef} className="page-canvas" />

      {!pdf && <div className="center muted">読み込み中…</div>}

      <div className={'indicator' + (indicator ? ' show' : '')}>{indicator ?? ''}</div>

      {menuOpen && (
        <div className="overlay" onPointerDown={(e) => e.stopPropagation()}>
          <div className="panel">
            <div className="row title">{doc.name}</div>
            <div className="row">
              <button className="btn" onClick={prev}>
                ◀ 前
              </button>
              <span>{describe(pos)}</span>
              <button className="btn" onClick={next}>
                次 ▶
              </button>
            </div>
            <div className="row">
              <label>
                ページへ移動{' '}
                <input
                  type="number"
                  min={1}
                  max={doc.pageCount}
                  inputMode="numeric"
                  value={gotoValue}
                  onChange={(e) => setGotoValue(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitGoto()}
                />
              </label>
              <button className="btn" onClick={submitGoto}>
                移動
              </button>
            </div>
            <div className="row">
              <label>
                繰りモード{' '}
                <select
                  value={modeSetting}
                  onChange={(e) => setModeSetting(e.target.value as TurnMode)}
                >
                  <option value="auto">自動（横向きで半ページ）</option>
                  <option value="page">ページ（左右タップ）</option>
                  <option value="half">半ページ（上下タップ）</option>
                </select>
              </label>
              <span className="muted-inline">
                今: {effMode === 'half' ? `半ページ ${sliceCount} 分割` : 'ページ'}
              </span>
            </div>
            <div className="row">
              <button className="btn" onClick={toggleFullscreen}>
                全画面切替
              </button>
              <button className="btn" onClick={onExit}>
                ライブラリへ戻る
              </button>
            </div>
            <div className="row">
              <button className="btn primary wide" onClick={() => setMenuOpen(false)}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
