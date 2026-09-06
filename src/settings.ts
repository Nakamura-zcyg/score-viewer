import { useSyncExternalStore } from 'react';

// ユーザーが設定画面で変えられる数値。localStorage に保存し、変更は購読側に即時反映する。

export interface Settings {
  /** 無操作でこれだけ経ったら画面消灯防止を解除する（分） */
  idleMinutes: number;
  /** 自動スクロールの上下タップで送る秒数 */
  nudgeSeconds: number;
  /** 長押しと判定するまでの時間 (ms) */
  longPressMs: number;
  /** 半ページモードで上下が重なる割合 (%) */
  halfOverlapPercent: number;
  /** 余白カットで内容の上下に残す余白（ページ高さに対する %） */
  cropPadPercent: number;
}

export const DEFAULT_SETTINGS: Settings = {
  idleMinutes: 10,
  nudgeSeconds: 5,
  longPressMs: 500,
  halfOverlapPercent: 15,
  cropPadPercent: 1.5,
};

/** 設定画面で使う項目の説明と範囲 */
export const SETTING_FIELDS: {
  key: keyof Settings;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  note: string;
}[] = [
  {
    key: 'idleMinutes',
    label: '画面消灯までの無操作時間',
    unit: '分',
    min: 1,
    max: 720,
    step: 1,
    note: '自動スクロール中は無操作に数えない',
  },
  {
    key: 'nudgeSeconds',
    label: '上下タップで送る量',
    unit: '秒',
    min: 1,
    max: 60,
    step: 1,
    note: '自動スクロールの速度 × この秒数ぶん動く',
  },
  {
    key: 'longPressMs',
    label: '長押しの判定時間',
    unit: 'ms',
    min: 200,
    max: 2000,
    step: 50,
    note: 'これより長く押すとメニュー',
  },
  {
    key: 'halfOverlapPercent',
    label: '半ページの重なり',
    unit: '%',
    min: 0,
    max: 40,
    step: 1,
    note: '0 でちょうど半分ずつ。大きいほど段が切れにくいが 1 画面の情報は減る',
  },
  {
    key: 'cropPadPercent',
    label: '余白カットで残す余白',
    unit: '%',
    min: 0,
    max: 10,
    step: 0.5,
    note: 'ページ高さに対する割合。前後のページ分が合わさって段間になる',
  },
];

const KEY = 'score-viewer.settings';
const listeners = new Set<() => void>();
let current: Settings = load();

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const j = JSON.parse(raw) as Partial<Settings>;
    const out = { ...DEFAULT_SETTINGS };
    for (const f of SETTING_FIELDS) {
      const v = j[f.key];
      if (typeof v === 'number' && Number.isFinite(v)) out[f.key] = clamp(f, v);
    }
    return out;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function clamp(f: (typeof SETTING_FIELDS)[number], v: number): number {
  return Math.min(f.max, Math.max(f.min, v));
}

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  const next = { ...current };
  for (const f of SETTING_FIELDS) {
    const v = patch[f.key];
    if (typeof v === 'number' && Number.isFinite(v)) next[f.key] = clamp(f, v);
  }
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* 無視 */
  }
  listeners.forEach((l) => l());
}

export function resetSettings(): void {
  updateSettings({ ...DEFAULT_SETTINGS });
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** React から設定を読む。変更されると再描画される */
export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings, getSettings);
}
