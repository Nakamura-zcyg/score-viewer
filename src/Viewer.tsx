import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  LibraryBig,
  Maximize2,
  Minus,
  Pause,
  Play,
  Plus,
  X,
} from 'lucide-react';
import { setCrops as saveCrops, setScrollSpeed, updateLastPage, type DocRecord } from './db.ts';
import {
  analyzeCrops,
  loadPdf,
  pageSize,
  renderPage,
  type PageCrop,
  type PDFDocumentProxy,
} from './pdf.ts';
import AutoScroll from './AutoScroll.tsx';
import { useWakeLock } from './useWakeLock.ts';
import { useSettings } from './settings.ts';

interface Props {
  doc: DocRecord;
  onExit: () => void;
}

// タップ判定: 指が触れてから離すまでがこれ未満なら「タップ」
const TAP_MAX_MS = 400;
// これ以上動いたらタップ／長押しのどちらでもない
const MOVE_CANCEL_PX = 12;
// pointerup が来ないままこれ以上経った操作は残骸とみなして捨てる
const STALE_GESTURE_MS = 3000;
// 先読みするページ数（前後）
const PREFETCH = 2;
// 読み込みがこれ以上かかったら案内と戻るボタンを出す
const LOAD_SLOW_MS = 8000;
// 自動スクロールの速度範囲と既定値 (CSS px/秒)
const SPEED_MIN = 5;
const SPEED_MAX = 300;
const SPEED_DEFAULT = 40;
const SPEED_STEP = 1.15; // ± ボタン・キーでの倍率

/** 繰りモード。auto は横向きなら half、縦向きなら page */
type TurnMode = 'auto' | 'page' | 'half' | 'width' | 'scroll';
type EffectiveMode = 'page' | 'half' | 'width' | 'scroll';
const MODE_KEY = 'score-viewer.turnMode';
const SPEED_KEY = 'score-viewer.scrollSpeed';
const CROP_KEY = 'score-viewer.crop';

/** 自動スクロールでページの上下余白を切るか */
type CropMode = 'auto' | 'none';

function loadCropMode(): CropMode {
  try {
    if (localStorage.getItem(CROP_KEY) === 'none') return 'none';
  } catch {
    /* 無視 */
  }
  return 'auto';
}

function loadMode(): TurnMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === 'page' || v === 'half' || v === 'width' || v === 'scroll' || v === 'auto') return v;
  } catch {
    /* 無視 */
  }
  return 'auto';
}

function loadSpeed(doc: DocRecord): number {
  if (doc.scrollSpeed) return doc.scrollSpeed;
  try {
    const v = Number(localStorage.getItem(SPEED_KEY));
    if (v >= SPEED_MIN && v <= SPEED_MAX) return v;
  } catch {
    /* 無視 */
  }
  return SPEED_DEFAULT;
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
  mode: Exclude<EffectiveMode, 'scroll'>,
  size: { w: number; h: number },
  dims: { w: number; h: number },
  halfViewFraction: number,
): Layout {
  const { w: W, h: H } = size;
  if (mode === 'page') {
    const scale = Math.min(W / dims.w, H / dims.h);
    return { scale, slices: [0], pageW: dims.w * scale, pageH: dims.h * scale };
  }
  // width: 横幅いっぱい。縦にはみ出す分はスライスで送る
  // half: 横幅いっぱい、ただし 1 画面がページ高さの HALF_VIEW_FRACTION を超えないよう縮める
  const scale =
    mode === 'width' ? W / dims.w : Math.min(W / dims.w, H / (halfViewFraction * dims.h));
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

function modeLabel(m: EffectiveMode): string {
  switch (m) {
    case 'half':
      return '半ページ';
    case 'width':
      return '横幅いっぱい';
    case 'scroll':
      return '自動スクロール';
    default:
      return 'ページ全体';
  }
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
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [modeSetting, setModeSetting] = useState<TurnMode>(loadMode);
  // 自動スクロール
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(() => loadSpeed(doc));
  const [jump, setJump] = useState<{ page: number; seq: number } | null>(null);
  const [cropMode, setCropMode] = useState<CropMode>(loadCropMode);
  const [crops, setCrops] = useState<PageCrop[] | null>(doc.crops ?? null);
  const [analyzing, setAnalyzing] = useState<string | null>(null);

  const effMode: EffectiveMode =
    modeSetting === 'auto' ? (size.w > size.h ? 'half' : 'page') : modeSetting;
  const isScroll = effMode === 'scroll';

  const settings = useSettings();
  // 半ページモード: 上下それぞれが表示するページ高さの割合。重なり 15% なら 0.575
  const halfViewFraction = 0.5 + settings.halfOverlapPercent / 200;
  const layout = useMemo(
    () =>
      dims && !isScroll
        ? computeLayout(effMode as Exclude<EffectiveMode, 'scroll'>, size, dims, halfViewFraction)
        : null,
    [effMode, isScroll, size, dims, halfViewFraction],
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadSlow, setLoadSlow] = useState(false);
  useEffect(() => {
    let alive = true;
    let loaded: PDFDocumentProxy | null = null;
    setLoadError(null);
    setLoadSlow(false);
    const slowTimer = window.setTimeout(() => setLoadSlow(true), LOAD_SLOW_MS);
    loadPdf(doc.data)
      .then(async (d) => {
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
      })
      .catch((e: unknown) => {
        if (!alive) return;
        // 「読み込み中」のまま止めない。原因を画面に出す
        setLoadError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => clearTimeout(slowTimer));
    return () => {
      alive = false;
      clearTimeout(slowTimer);
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

  // ---- モード設定の保存。スクロール以外に切り替えたら停止 ----
  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, modeSetting);
    } catch {
      /* 無視 */
    }
  }, [modeSetting]);
  useEffect(() => {
    if (!isScroll) setRunning(false);
  }, [isScroll]);
  useEffect(() => {
    try {
      localStorage.setItem(CROP_KEY, cropMode);
    } catch {
      /* 無視 */
    }
  }, [cropMode]);

  // ---- 余白の解析（スクロールモードで初めて必要になった時に 1 回。結果は曲に保存） ----
  useEffect(() => {
    if (!pdf || !isScroll || cropMode !== 'auto' || crops) return;
    let alive = true;
    setAnalyzing(`余白を解析中 0/${doc.pageCount}`);
    analyzeCrops(pdf, (done, total) => {
      if (alive) setAnalyzing(`余白を解析中 ${done}/${total}`);
    })
      .then((result) => {
        if (!alive) return;
        setCrops(result);
        saveCrops(doc.id, result).catch(() => undefined);
      })
      .catch(() => {
        if (alive) setCropMode('none');
      })
      .finally(() => {
        if (alive) setAnalyzing(null);
      });
    return () => {
      alive = false;
    };
  }, [pdf, isScroll, cropMode, crops, doc.id, doc.pageCount]);

  // ---- 速度の保存（曲ごと + 次に開く曲の既定値） ----
  useEffect(() => {
    try {
      localStorage.setItem(SPEED_KEY, String(speed));
    } catch {
      /* 無視 */
    }
    const t = setTimeout(() => setScrollSpeed(doc.id, speed).catch(() => undefined), 500);
    return () => clearTimeout(t);
  }, [doc.id, speed]);

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

  // 表示中の位置を display canvas に転写し、前後を先読み（スクロールモードでは AutoScroll が担当）
  useEffect(() => {
    if (!pdf || !layout || isScroll) return;
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

    getPageCanvas(page)
      .then((src) => {
        if (!alive) return;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        const x = Math.floor((W - src.width) / 2);
        // ページが画面に収まるなら縦中央、収まらないならスライスのオフセット分ずらす
        const y = src.height <= H ? Math.floor((H - src.height) / 2) : -Math.round(offset * dpr);
        ctx.drawImage(src, x, y);
      })
      .catch(() => undefined); // 描画途中で閉じた時の RenderingCancelled は無視

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
  }, [pdf, layout, pos, size, getPageCanvas, doc.pageCount, isScroll]);

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

  const jumpToPage = useCallback(
    (n: number) => {
      const page = Math.min(Math.max(n, 1), doc.pageCount);
      setJump((j) => ({ page, seq: (j?.seq ?? 0) + 1 }));
      setIndicator(`${page} / ${doc.pageCount}`);
    },
    [doc.pageCount],
  );

  const next = useCallback(() => {
    const cur = posRef.current;
    if (isScroll) return jumpToPage(cur.page + 1);
    const n = layoutRef.current?.slices.length ?? 1;
    if (cur.slice + 1 < n) return moveTo({ page: cur.page, slice: cur.slice + 1 });
    if (cur.page < doc.pageCount) return moveTo({ page: cur.page + 1, slice: 0 });
    setIndicator('最後のページ');
  }, [doc.pageCount, moveTo, isScroll, jumpToPage]);

  const prev = useCallback(() => {
    const cur = posRef.current;
    if (isScroll) return jumpToPage(cur.page - 1);
    const n = layoutRef.current?.slices.length ?? 1;
    if (cur.slice > 0) return moveTo({ page: cur.page, slice: cur.slice - 1 });
    if (cur.page > 1) return moveTo({ page: cur.page - 1, slice: n - 1 });
    setIndicator('最初のページ');
  }, [moveTo, isScroll, jumpToPage]);

  const goToPage = useCallback(
    (n: number) => {
      if (isScroll) return jumpToPage(n);
      moveTo({ page: Math.min(Math.max(n, 1), doc.pageCount), slice: 0 });
    },
    [doc.pageCount, moveTo, isScroll, jumpToPage],
  );

  // ---- 自動スクロールの操作 ----
  const runningRef = useRef(running);
  runningRef.current = running;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const toggleRunning = useCallback(() => {
    const next = !runningRef.current;
    runningRef.current = next;
    setRunning(next);
    setIndicator(next ? '再生' : '停止');
  }, []);
  const changeSpeed = useCallback((factor: number) => {
    const v = Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, speedRef.current * factor)));
    speedRef.current = v;
    setSpeed(v);
    setIndicator(`${v} px/秒`);
  }, []);
  const onScrollEnd = useCallback(() => {
    setRunning(false);
    setIndicator('最後まで到達');
  }, []);
  const onScrollPage = useCallback((page: number) => {
    setPos((p) => (p.page === page ? p : { page, slice: 0 }));
  }, []);
  const openMenu = useCallback(() => setMenuOpen(true), []);
  const onNudge = useCallback((seconds: number) => {
    setIndicator(seconds > 0 ? `${seconds} 秒送り` : `${-seconds} 秒戻し`);
  }, []);

  // ---- タップ／長押し判定（ページ・半ページ・横幅モード） ----
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
    const stale = gestureRef.current;
    if (stale) {
      // pointerup が来ないまま残った操作は捨てる。そうでなければ 2 本目以降として無視
      if (performance.now() - stale.t < STALE_GESTURE_MS) return;
      clearGesture();
    }
    // 指が要素外にずれても pointerup / pointercancel が届くようにする
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
      consumed: false,
    };
    g.timer = window.setTimeout(() => {
      if (gestureRef.current === g) {
        g.consumed = true;
        setMenuOpen(true);
      }
    }, settings.longPressMs);
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
    // 縦に分割されているときは上下、そうでなければ左右で判定
    const vertical = (layoutRef.current?.slices.length ?? 1) > 1;
    const isPrev = vertical ? e.clientY < h / 2 : e.clientX < w / 2;
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
      if (isScroll) {
        switch (e.key) {
          case ' ':
          case 'Enter':
            e.preventDefault();
            toggleRunning();
            break;
          case 'ArrowUp':
          case 'ArrowRight':
            e.preventDefault();
            changeSpeed(SPEED_STEP);
            break;
          case 'ArrowDown':
          case 'ArrowLeft':
            e.preventDefault();
            changeSpeed(1 / SPEED_STEP);
            break;
          case 'PageDown':
            e.preventDefault();
            next();
            break;
          case 'PageUp':
            e.preventDefault();
            prev();
            break;
          case 'Escape':
            setMenuOpen(true);
            break;
        }
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
  }, [menuOpen, next, prev, isScroll, toggleRunning, changeSpeed]);

  // ---- 画面消灯防止（1 時間無操作で解除。自動スクロール中は無操作に数えない） ----
  useWakeLock(running);

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

  const sliceCount = layout?.slices.length ?? 1;
  const tapHint = isScroll
    ? '上下タップで 5 秒戻し/送り・2 本指タップ（PC は右クリック）で再生/停止・ドラッグで移動'
    : sliceCount > 1
      ? `${sliceCount} 分割・上下タップ`
      : '左右タップ';

  const pointerProps = isScroll
    ? {}
    : {
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
        onLostPointerCapture: onPointerCancel,
      };

  return (
    <div ref={containerRef} className="viewer" {...pointerProps}>
      {isScroll && pdf && dims ? (
        <AutoScroll
          pdf={pdf}
          pageCount={doc.pageCount}
          dims={dims}
          size={size}
          crops={cropMode === 'auto' ? crops : null}
          startPage={pos.page}
          jump={jump}
          running={running}
          speed={speed}
          onToggle={toggleRunning}
          onEnd={onScrollEnd}
          onPage={onScrollPage}
          onMenu={openMenu}
          onNudge={onNudge}
          menuOpen={menuOpen}
        />
      ) : (
        <canvas ref={canvasRef} className="page-canvas" />
      )}

      {analyzing && <div className="analyzing">{analyzing}</div>}

      {!pdf && (
        <div className="center">
          <div className="load-status">
            {loadError ? (
              <>
                <p>楽譜を開けませんでした。</p>
                <p className="muted-inline">{loadError}</p>
              </>
            ) : (
              <>
                <p className="muted">読み込み中…</p>
                {loadSlow && (
                  <p className="muted-inline">
                    時間がかかっています。圏外の場合は、一度ネットに繋いでこのアプリを開き直すと必要なファイルが保存されます。
                  </p>
                )}
              </>
            )}
            {(loadError || loadSlow) && (
              <button className="btn with-icon" onClick={onExit}>
                <LibraryBig size={20} /> ライブラリへ戻る
              </button>
            )}
          </div>
        </div>
      )}

      <div className={'indicator' + (indicator ? ' show' : '')}>{indicator ?? ''}</div>

      {menuOpen && (
        <div
          className="overlay"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            // パネルの外側（背景）をタップしたら閉じる
            if (e.target === e.currentTarget) setMenuOpen(false);
          }}
        >
          <div className="panel">
            <div className="row title">{doc.name}</div>
            <div className="row">
              <button className="btn icon" onClick={prev} aria-label="前へ" title="前へ">
                <ChevronLeft size={24} />
              </button>
              <span>{describe(pos)}</span>
              <button className="btn icon" onClick={next} aria-label="次へ" title="次へ">
                <ChevronRight size={24} />
              </button>
            </div>
            <div className="row">
              <label>
                ページへ移動{' '}
                <select
                  value={pos.page}
                  onChange={(e) => {
                    goToPage(parseInt(e.target.value, 10));
                    setMenuOpen(false);
                  }}
                >
                  {Array.from({ length: doc.pageCount }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n} / {doc.pageCount}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="row">
              <label>
                繰りモード{' '}
                <select
                  value={modeSetting}
                  onChange={(e) => setModeSetting(e.target.value as TurnMode)}
                >
                  <option value="auto">自動（横向きで半ページ）</option>
                  <option value="page">ページ全体（左右タップ）</option>
                  <option value="half">半ページ（上下タップ）</option>
                  <option value="width">横幅いっぱい</option>
                  <option value="scroll">自動スクロール</option>
                </select>
              </label>
              <span className="muted-inline">
                今: {modeLabel(effMode)}・{tapHint}
              </span>
            </div>
            {isScroll && (
              <div className="row">
                <button
                  className="btn icon"
                  onClick={() => {
                    toggleRunning();
                    setMenuOpen(false);
                  }}
                  aria-label={running ? '停止' : '再生'}
                  title={running ? '停止' : '再生'}
                >
                  {running ? <Pause size={22} /> : <Play size={22} />}
                </button>
                <button
                  className="btn icon"
                  onClick={() => changeSpeed(1 / SPEED_STEP)}
                  aria-label="遅く"
                  title="遅く"
                >
                  <Minus size={20} />
                </button>
                <input
                  type="range"
                  min={SPEED_MIN}
                  max={SPEED_MAX}
                  step={1}
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                  aria-label="スクロール速度"
                />
                <button
                  className="btn icon"
                  onClick={() => changeSpeed(SPEED_STEP)}
                  aria-label="速く"
                  title="速く"
                >
                  <Plus size={20} />
                </button>
                <span className="speed">{speed} px/秒</span>
              </div>
            )}
            {isScroll && (
              <div className="row">
                <label>
                  余白カット{' '}
                  <select
                    value={cropMode}
                    onChange={(e) => setCropMode(e.target.value as CropMode)}
                  >
                    <option value="auto">自動（上下の白を切る）</option>
                    <option value="none">なし</option>
                  </select>
                </label>
                <span className="muted-inline">
                  {cropMode === 'auto'
                    ? crops
                      ? '解析済み'
                      : analyzing ?? '未解析'
                    : 'ページをそのまま並べる'}
                </span>
              </div>
            )}
            <div className="row">
              <button className="btn with-icon" onClick={toggleFullscreen}>
                <Maximize2 size={20} /> 全画面切替
              </button>
              <button className="btn with-icon" onClick={onExit}>
                <LibraryBig size={20} /> ライブラリ
              </button>
            </div>
            <div className="row">
              <button className="btn primary wide with-icon" onClick={() => setMenuOpen(false)}>
                <X size={20} /> 閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
