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
import {
  setCropOverride,
  setCropPad,
  setCrops as saveCrops,
  setJumps,
  setMetronome as saveMetronome,
  setScrollSpeed,
  updateLastPage,
  type DocRecord,
  type Jump,
  type MetronomeSettings,
} from './db.ts';
import { Metronome } from './metronome.ts';
import {
  analyzeCrops,
  DEFAULT_CROP_PARAMS,
  loadPdf,
  pageSize,
  renderPage,
  type CropParams,
  type PageCrop,
  type PDFDocumentProxy,
} from './pdf.ts';
import AutoScroll, { READ_LINE } from './AutoScroll.tsx';
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
// メトロノーム
const BPM_MIN = 30;
const BPM_MAX = 240;
const DEFAULT_METRONOME: MetronomeSettings = { bpm: 100, beats: 4, accent: true, flash: true };
const METRO_BEATS = [2, 3, 4, 6];

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
  // 反復ジャンプ
  const [jumps, setJumpsState] = useState<Jump[]>(doc.jumps ?? []);
  // メトロノーム
  const [metro, setMetro] = useState<MetronomeSettings>(() => ({
    ...DEFAULT_METRONOME,
    ...(doc.metronome ?? {}),
  }));
  const [metroRunning, setMetroRunning] = useState(false);
  const [metroBeat, setMetroBeat] = useState(0);
  const metronomeRef = useRef<Metronome | null>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const metroRef = useRef(metro);
  metroRef.current = metro;
  const [pendingFrom, setPendingFrom] = useState<{ page: number; frac: number } | null>(null);
  const firedRef = useRef(new Map<string, number>());
  const readPosRef = useRef({ page: doc.lastPage, frac: 0 });
  const [cropMode, setCropMode] = useState<CropMode>(loadCropMode);
  const [crops, setCrops] = useState<PageCrop[] | null>(doc.crops ?? null);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  // 楽譜ごとの余白カット調整。crops がどのパラメータで解析されたかも持つ
  const [cropParams, setCropParamsState] = useState<CropParams>(() => ({
    dark: doc.cropParams?.dark ?? DEFAULT_CROP_PARAMS.dark,
    minInk: doc.cropParams?.minInk ?? DEFAULT_CROP_PARAMS.minInk,
    maxGap: doc.cropParams?.maxGap ?? DEFAULT_CROP_PARAMS.maxGap,
  }));
  const [cropPadOverride, setCropPadOverride] = useState<number | undefined>(doc.cropParams?.pad);
  // 古い解析結果（maxGap なし）は隙間規則で解析し直す
  const analyzedForRef = useRef<CropParams | null>(
    doc.crops && doc.cropParams?.maxGap !== undefined
      ? {
          dark: doc.cropParams.dark,
          minInk: doc.cropParams.minInk,
          maxGap: doc.cropParams.maxGap,
        }
      : null,
  );
  // ページ単位の手動上書き
  const [cropOverrides, setCropOverrides] = useState<
    Record<number, { top?: number; bottom?: number }>
  >(doc.cropOverrides ?? {});

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

  // ---- 余白の解析（スクロールモードで必要になった時と、閾値を変えた時。結果は曲に保存） ----
  useEffect(() => {
    if (!pdf || !isScroll || cropMode !== 'auto') return;
    const done = analyzedForRef.current;
    if (
      crops &&
      done &&
      done.dark === cropParams.dark &&
      done.minInk === cropParams.minInk &&
      done.maxGap === cropParams.maxGap
    )
      return;
    let alive = true;
    // スライダー操作が続いている間は待つ
    const timer = window.setTimeout(() => {
      setAnalyzing(`余白を解析中 0/${doc.pageCount}`);
      const params = { ...cropParams };
      analyzeCrops(pdf, params, (n, total) => {
        if (alive) setAnalyzing(`余白を解析中 ${n}/${total}`);
      })
        .then((result) => {
          if (!alive) return;
          analyzedForRef.current = params;
          setCrops(result);
          saveCrops(doc.id, result, params).catch(() => undefined);
        })
        .catch(() => {
          if (alive) setCropMode('none');
        })
        .finally(() => {
          if (alive) setAnalyzing(null);
        });
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [pdf, isScroll, cropMode, crops, cropParams, doc.id, doc.pageCount]);

  const setCropDark = (dark: number) => setCropParamsState((p) => ({ ...p, dark }));
  const setCropGap = (maxGap: number) => setCropParamsState((p) => ({ ...p, maxGap }));
  const changeCropPad = (pad: number | undefined) => {
    setCropPadOverride(pad);
    setCropPad(doc.id, pad).catch(() => undefined);
  };
  const effectiveCropPad = cropPadOverride ?? settings.cropPadPercent;

  // 自動解析の結果に、ページ単位の手動上書きをかぶせる
  const effectiveCrops = useMemo<PageCrop[] | null>(() => {
    if (!crops) return null;
    if (!Object.keys(cropOverrides).length) return crops;
    return crops.map((c, i) => {
      const o = cropOverrides[i + 1];
      return o ? { top: o.top ?? c.top, bottom: o.bottom ?? c.bottom } : c;
    });
  }, [crops, cropOverrides]);

  const changeCropOverride = (page: number, patch: { top?: number; bottom?: number } | undefined) => {
    setCropOverrides((all) => {
      const next = { ...all };
      const merged = patch ? { ...(all[page] ?? {}), ...patch } : undefined;
      if (merged && (merged.top !== undefined || merged.bottom !== undefined)) next[page] = merged;
      else delete next[page];
      setCropOverride(doc.id, page, next[page]).catch(() => undefined);
      return next;
    });
  };

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

  // ---- 反復ジャンプ ----
  const jumpsRef = useRef(jumps);
  jumpsRef.current = jumps;
  const tryJump = useCallback((id: string) => {
    const j = jumpsRef.current.find((x) => x.id === id);
    if (!j) return false;
    const n = firedRef.current.get(id) ?? 0;
    if (n >= j.times) return false;
    firedRef.current.set(id, n + 1);
    return true;
  }, []);
  const onJumped = useCallback((j: Jump) => {
    setIndicator(`反復 → p${j.toPage}`);
  }, []);
  const resetJumpCounts = useCallback(() => {
    firedRef.current.clear();
    setIndicator('ジャンプ回数をリセット');
  }, []);
  /** ページ内の割合 → そのモードでの表示スライス（割合の位置が見えるスライス） */
  const sliceFor = useCallback((frac: number) => {
    const l = layoutRef.current;
    if (!l) return 0;
    const y = frac * l.pageH;
    let s = 0;
    for (let i = 0; i < l.slices.length; i++) if (l.slices[i] <= y) s = i;
    return s;
  }, []);
  /** 今の読み位置 */
  const currentReadPos = useCallback((): { page: number; frac: number } => {
    if (isScroll) return readPosRef.current;
    const l = layoutRef.current;
    const cur = posRef.current;
    const frac = l ? (l.slices[cur.slice] ?? 0) / l.pageH : 0;
    return { page: cur.page, frac };
  }, [isScroll]);
  const saveJumps = useCallback(
    (next: Jump[]) => {
      setJumpsState(next);
      setJumps(doc.id, next).catch(() => undefined);
    },
    [doc.id],
  );
  const markJumpHere = useCallback(() => {
    const here = currentReadPos();
    if (!pendingFrom) {
      setPendingFrom(here);
      setMenuOpen(false);
      setIndicator('行き先まで動かして「ここへ」');
      return;
    }
    const j: Jump = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      fromPage: pendingFrom.page,
      fromFrac: pendingFrom.frac,
      toPage: here.page,
      toFrac: here.frac,
      times: 1,
    };
    saveJumps([...jumps, j]);
    setPendingFrom(null);
    setIndicator(`ジャンプを追加: p${j.fromPage} → p${j.toPage}`);
  }, [currentReadPos, pendingFrom, jumps, saveJumps]);
  const describePos = (p: { page: number; frac: number }) =>
    `p${p.page} ${Math.round(p.frac * 100)}%`;

  const next = useCallback(() => {
    const cur = posRef.current;
    if (isScroll) return jumpToPage(cur.page + 1);
    const n = layoutRef.current?.slices.length ?? 1;
    // 起点のあるページの最後のスライスで「次へ」→ 行き先へ
    if (cur.slice + 1 >= n) {
      for (const j of jumpsRef.current) {
        if (j.fromPage === cur.page && tryJump(j.id)) {
          moveTo({ page: Math.min(Math.max(j.toPage, 1), doc.pageCount), slice: sliceFor(j.toFrac) });
          setIndicator(`反復 → p${j.toPage}`);
          return;
        }
      }
    }
    if (cur.slice + 1 < n) return moveTo({ page: cur.page, slice: cur.slice + 1 });
    if (cur.page < doc.pageCount) return moveTo({ page: cur.page + 1, slice: 0 });
    setIndicator('最後のページ');
  }, [doc.pageCount, moveTo, isScroll, jumpToPage, tryJump, sliceFor]);

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

  // ---- メトロノーム ----
  useEffect(() => {
    const m = new Metronome(metroRef.current);
    m.onBeat = (beat) => {
      setMetroBeat(beat);
      const f = flashRef.current;
      if (f && metroRef.current.flash) {
        f.classList.remove('on', 'accent');
        void f.offsetWidth; // 連続する拍でもアニメーションを再開させる
        f.classList.add('on');
        if (beat === 0 && metroRef.current.accent) f.classList.add('accent');
      }
    };
    metronomeRef.current = m;
    return () => {
      m.dispose();
      metronomeRef.current = null;
    };
  }, []);
  useEffect(() => {
    metronomeRef.current?.setConfig(metro);
    const t = setTimeout(() => saveMetronome(doc.id, metro).catch(() => undefined), 400);
    return () => clearTimeout(t);
  }, [metro, doc.id]);
  const toggleMetronome = useCallback(() => {
    const m = metronomeRef.current;
    if (!m) return;
    if (m.running) {
      m.stop();
      setMetroRunning(false);
      setIndicator('メトロノーム停止');
    } else {
      m.start();
      setMetroRunning(true);
      setIndicator(`♩= ${metroRef.current.bpm}`);
    }
  }, []);
  const setBpm = (bpm: number) =>
    setMetro((m) => ({ ...m, bpm: Math.round(Math.min(BPM_MAX, Math.max(BPM_MIN, bpm))) }));
  /** BPM と 1 ページの小節数から自動スクロールの速度 (px/秒) を出す */
  const speedFromBpm = useCallback(() => {
    if (!dims) return null;
    const mpp = metro.measuresPerPage;
    if (!mpp || mpp <= 0) return null;
    const scale = size.w / dims.w;
    const pageH = dims.h * scale;
    let avg = pageH + 8;
    const cs = cropMode === 'auto' ? effectiveCrops : null;
    if (cs && cs.length) {
      const pad = effectiveCropPad / 100;
      avg = (cs.reduce((a, c) => a + (c.bottom - c.top + 2 * pad), 0) / cs.length) * pageH;
    }
    const secondsPerPage = (mpp * metro.beats * 60) / metro.bpm;
    return Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, avg / secondsPerPage)));
  }, [dims, metro, size.w, cropMode, effectiveCrops, effectiveCropPad]);

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
      const tag = (e.target as HTMLElement | null)?.tagName;
      if ((e.key === 'm' || e.key === 'M') && tag !== 'INPUT' && tag !== 'SELECT') {
        e.preventDefault();
        toggleMetronome();
        return;
      }
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
  }, [menuOpen, next, prev, isScroll, toggleRunning, changeSpeed, toggleMetronome]);

  // ---- 画面消灯防止（1 時間無操作で解除。自動スクロール中は無操作に数えない） ----
  useWakeLock(running || metroRunning);

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
          crops={cropMode === 'auto' ? effectiveCrops : null}
          cropPad={effectiveCropPad / 100}
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
          jumps={jumps}
          tryJump={tryJump}
          onJumped={onJumped}
          readPosRef={readPosRef}
          showGuide={pendingFrom !== null}
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

      <div ref={flashRef} className="metro-flash" aria-hidden />
      {metroRunning && (
        <button
          className="metro-badge"
          onClick={toggleMetronome}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          title="タップで停止"
          aria-label="メトロノームを停止"
        >
          ♩={metro.bpm}
          <span className="metro-beats">
            {Array.from({ length: metro.beats }, (_, i) => (
              <span key={i} className={'metro-dot' + (i === metroBeat ? ' on' : '')} />
            ))}
          </span>
        </button>
      )}

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
                    ? analyzing ?? (crops ? '解析済み' : '未解析')
                    : 'ページをそのまま並べる'}
                </span>
              </div>
            )}
            {isScroll && cropMode === 'auto' && (
              <>
                <div className="row crop-row">
                  <label className="crop-label">
                    暗さの閾値
                    <span className="muted-inline">切れ過ぎるなら上げる（薄い線も内容とみなす）</span>
                  </label>
                  <input
                    type="range"
                    min={40}
                    max={240}
                    step={5}
                    value={cropParams.dark}
                    onChange={(e) => setCropDark(Number(e.target.value))}
                    aria-label="暗さの閾値"
                  />
                  <span className="speed">{cropParams.dark}</span>
                  {cropParams.dark !== DEFAULT_CROP_PARAMS.dark && (
                    <button
                      className="btn small"
                      onClick={() => setCropDark(DEFAULT_CROP_PARAMS.dark)}
                      title="既定に戻す"
                    >
                      既定
                    </button>
                  )}
                </div>
                <div className="row crop-row">
                  <label className="crop-label">
                    離れた印を無視
                    <span className="muted-inline">
                      本体からこれ以上離れた小さな印（ページ番号など）は無視。0 で無効
                    </span>
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={10}
                    step={0.5}
                    value={Math.round(cropParams.maxGap * 200) / 2}
                    onChange={(e) => setCropGap(Number(e.target.value) / 100)}
                    aria-label="離れた印を無視する隙間"
                  />
                  <span className="speed">{Math.round(cropParams.maxGap * 200) / 2} %</span>
                  {cropParams.maxGap !== DEFAULT_CROP_PARAMS.maxGap && (
                    <button
                      className="btn small"
                      onClick={() => setCropGap(DEFAULT_CROP_PARAMS.maxGap)}
                      title="既定に戻す"
                    >
                      既定
                    </button>
                  )}
                </div>
                <div className="row crop-row">
                  <label className="crop-label">
                    残す余白
                    <span className="muted-inline">
                      {cropPadOverride === undefined ? '全体設定と同じ' : 'この楽譜だけの値'}
                    </span>
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={10}
                    step={0.5}
                    value={effectiveCropPad}
                    onChange={(e) => changeCropPad(Number(e.target.value))}
                    aria-label="残す余白"
                  />
                  <span className="speed">{effectiveCropPad} %</span>
                  {cropPadOverride !== undefined && (
                    <button
                      className="btn small"
                      onClick={() => changeCropPad(undefined)}
                      title="全体設定に戻す"
                    >
                      全体
                    </button>
                  )}
                </div>
                {effectiveCrops && (
                  <>
                    <div className="row crop-row">
                      <label className="crop-label">
                        ページ {pos.page} の上端
                        <span className="muted-inline">
                          {cropOverrides[pos.page]?.top !== undefined ? '手動' : '自動'}
                        </span>
                      </label>
                      <input
                        type="range"
                        min={0}
                        max={60}
                        step={0.5}
                        value={Math.round(effectiveCrops[pos.page - 1].top * 200) / 2}
                        onChange={(e) =>
                          changeCropOverride(pos.page, { top: Number(e.target.value) / 100 })
                        }
                        aria-label="このページの上端"
                      />
                      <span className="speed">
                        {Math.round(effectiveCrops[pos.page - 1].top * 200) / 2} %
                      </span>
                    </div>
                    <div className="row crop-row">
                      <label className="crop-label">
                        ページ {pos.page} の下端
                        <span className="muted-inline">
                          {cropOverrides[pos.page]?.bottom !== undefined ? '手動' : '自動'}
                        </span>
                      </label>
                      <input
                        type="range"
                        min={40}
                        max={100}
                        step={0.5}
                        value={Math.round(effectiveCrops[pos.page - 1].bottom * 200) / 2}
                        onChange={(e) =>
                          changeCropOverride(pos.page, { bottom: Number(e.target.value) / 100 })
                        }
                        aria-label="このページの下端"
                      />
                      <span className="speed">
                        {Math.round(effectiveCrops[pos.page - 1].bottom * 200) / 2} %
                      </span>
                      {cropOverrides[pos.page] && (
                        <button
                          className="btn small"
                          onClick={() => changeCropOverride(pos.page, undefined)}
                          title="このページを自動に戻す"
                        >
                          自動
                        </button>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
            <div className="jump-section metro-section">
              <div className="row">
                <span className="jump-title">メトロノーム</span>
                <button
                  className={'btn' + (metroRunning ? ' primary' : '')}
                  onClick={toggleMetronome}
                >
                  {metroRunning ? '停止' : '開始'}
                </button>
                <span className="muted-inline">キーボードの M でも開始／停止</span>
              </div>
              <div className="row crop-row">
                <label className="crop-label">
                  テンポ
                  <span className="muted-inline">♩ = BPM</span>
                </label>
                <button className="btn icon" onClick={() => setBpm(metro.bpm - 1)} aria-label="遅く">
                  <Minus size={20} />
                </button>
                <input
                  type="range"
                  min={BPM_MIN}
                  max={BPM_MAX}
                  step={1}
                  value={metro.bpm}
                  onChange={(e) => setBpm(Number(e.target.value))}
                  aria-label="テンポ"
                />
                <button className="btn icon" onClick={() => setBpm(metro.bpm + 1)} aria-label="速く">
                  <Plus size={20} />
                </button>
                <input
                  type="number"
                  className="bpm-input"
                  min={BPM_MIN}
                  max={BPM_MAX}
                  value={metro.bpm}
                  onChange={(e) => setBpm(Number(e.target.value))}
                  aria-label="テンポの数値"
                />
              </div>
              <div className="row">
                <label>
                  拍子{' '}
                  <select
                    value={metro.beats}
                    onChange={(e) => setMetro((m) => ({ ...m, beats: Number(e.target.value) }))}
                    aria-label="拍子"
                  >
                    {METRO_BEATS.map((b) => (
                      <option key={b} value={b}>
                        {b} 拍
                      </option>
                    ))}
                  </select>
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={metro.accent}
                    onChange={(e) => setMetro((m) => ({ ...m, accent: e.target.checked }))}
                  />{' '}
                  1 拍目を強く
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={metro.flash}
                    onChange={(e) => setMetro((m) => ({ ...m, flash: e.target.checked }))}
                  />{' '}
                  画面を点滅
                </label>
              </div>
              {isScroll && (
                <div className="row">
                  <label>
                    1 ページの小節数{' '}
                    <input
                      type="number"
                      className="bpm-input"
                      min={1}
                      max={99}
                      value={metro.measuresPerPage ?? ''}
                      placeholder="例 16"
                      onChange={(e) =>
                        setMetro((m) => ({
                          ...m,
                          measuresPerPage: e.target.value ? Number(e.target.value) : undefined,
                        }))
                      }
                      aria-label="1 ページの小節数"
                    />
                  </label>
                  <button
                    className="btn"
                    disabled={speedFromBpm() === null}
                    onClick={() => {
                      const v = speedFromBpm();
                      if (v !== null) {
                        speedRef.current = v;
                        setSpeed(v);
                        setIndicator(`${v} px/秒`);
                      }
                    }}
                    title="BPM と小節数から自動スクロールの速度を出す（近似）"
                  >
                    BPM から速度を設定{speedFromBpm() !== null ? `（${speedFromBpm()} px/秒）` : ''}
                  </button>
                </div>
              )}
            </div>
            <div className="jump-section">
              <div className="row">
                <span className="jump-title">反復ジャンプ</span>
                <span className="muted-inline">
                  {isScroll
                    ? `読み位置（画面上から ${Math.round(READ_LINE * 100)}%）が起点を通ると行き先へ`
                    : '起点のページで「次へ」を押すと行き先へ'}
                </span>
              </div>
              {jumps.length > 0 && (
                <ul className="jump-list">
                  {jumps.map((j, i) => (
                    <li key={j.id}>
                      <span className="jump-desc">
                        {i + 1}. {describePos({ page: j.fromPage, frac: j.fromFrac })} →{' '}
                        {describePos({ page: j.toPage, frac: j.toFrac })}
                        <span className="muted-inline">
                          {' '}
                          残り {Math.max(0, j.times - (firedRef.current.get(j.id) ?? 0))} 回
                        </span>
                      </span>
                      <label className="jump-times">
                        回数{' '}
                        <select
                          value={j.times}
                          onChange={(e) =>
                            saveJumps(
                              jumps.map((x) =>
                                x.id === j.id ? { ...x, times: Number(e.target.value) } : x,
                              ),
                            )
                          }
                        >
                          {[1, 2, 3, 4, 5, 9].map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="btn small danger"
                        onClick={() => saveJumps(jumps.filter((x) => x.id !== j.id))}
                        title="このジャンプを削除"
                      >
                        削除
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="row">
                {pendingFrom ? (
                  <>
                    <span className="muted-inline">起点: {describePos(pendingFrom)}</span>
                    <button className="btn primary" onClick={markJumpHere}>
                      ここへ（{describePos(currentReadPos())}）
                    </button>
                    <button className="btn small" onClick={() => setPendingFrom(null)}>
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <button className="btn" onClick={markJumpHere}>
                      ここから（{describePos(currentReadPos())}）
                    </button>
                    {jumps.length > 0 && (
                      <button className="btn small" onClick={resetJumpCounts}>
                        回数リセット
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
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
