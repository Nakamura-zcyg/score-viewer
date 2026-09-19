import { useState } from 'react';
import { ArrowLeft, RefreshCw, RotateCcw } from 'lucide-react';
import { APP_VERSION, BUILD_TIME, checkForUpdate, type UpdateResult } from './updates.ts';
import {
  DEFAULT_SETTINGS,
  resetSettings,
  SETTING_FIELDS,
  updateSettings,
  useSettings,
  type Settings as SettingsValues,
} from './settings.ts';

interface Props {
  onExit: () => void;
}

const UPDATE_MESSAGES: Record<UpdateResult, string> = {
  updating: '新しい版を取り込んでいます。終わると自動で再読み込みします',
  latest: '最新版です',
  offline: '配信先に届きませんでした。ネットに繋いでからもう一度押してください',
  unsupported: 'この環境では更新確認できません（開発サーバーなど）',
};

function formatBuildTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function Settings({ onExit }: Props) {
  const settings = useSettings();
  const [updateState, setUpdateState] = useState<'idle' | 'checking' | UpdateResult>('idle');
  // 入力中の文字列は別に持ち、確定時（blur / Enter）に数値として保存する
  const [drafts, setDrafts] = useState<Partial<Record<keyof SettingsValues, string>>>({});

  const commit = (key: keyof SettingsValues) => {
    const raw = drafts[key];
    if (raw === undefined) return;
    const v = Number(raw);
    if (Number.isFinite(v)) updateSettings({ [key]: v });
    setDrafts((d) => {
      const n = { ...d };
      delete n[key];
      return n;
    });
  };

  return (
    <section className="settings">
      <header>
        <button className="btn icon" onClick={onExit} aria-label="戻る" title="戻る">
          <ArrowLeft size={22} />
        </button>
        <h1>設定</h1>
        <button
          className="btn with-icon"
          onClick={() => {
            if (confirm('すべて既定値に戻しますか？')) {
              resetSettings();
              setDrafts({});
            }
          }}
        >
          <RotateCcw size={18} /> 既定に戻す
        </button>
      </header>

      <ul className="setting-list">
        {SETTING_FIELDS.map((f) => {
          const value = drafts[f.key] ?? String(settings[f.key]);
          const changed = settings[f.key] !== DEFAULT_SETTINGS[f.key];
          return (
            <li key={f.key}>
              <label htmlFor={`setting-${f.key}`}>
                <span className="setting-label">
                  {f.label}
                  {changed && <span className="setting-changed">（既定 {DEFAULT_SETTINGS[f.key]}）</span>}
                </span>
                <span className="setting-note">{f.note}</span>
              </label>
              <span className="setting-input">
                <input
                  id={`setting-${f.key}`}
                  type="number"
                  inputMode="decimal"
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  value={value}
                  onChange={(e) => setDrafts((d) => ({ ...d, [f.key]: e.target.value }))}
                  onBlur={() => commit(f.key)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                />
                <span className="setting-unit">{f.unit}</span>
              </span>
            </li>
          );
        })}
      </ul>

      <p className="muted small">値はこの端末に保存されます。楽譜や動画を開き直さなくても反映されます。</p>

      <section className="setting-app">
        <h2>アプリ</h2>
        <div className="setting-app-row">
          <span>
            <span className="setting-label">
              版 <code>{APP_VERSION}</code>
            </span>
            <span className="setting-note">ビルド {formatBuildTime(BUILD_TIME)}</span>
          </span>
          <button
            className="btn with-icon"
            disabled={updateState === 'checking' || updateState === 'updating'}
            onClick={async () => {
              setUpdateState('checking');
              setUpdateState(await checkForUpdate());
            }}
          >
            <RefreshCw size={18} className={updateState === 'checking' ? 'spin' : undefined} /> 最新版に更新
          </button>
        </div>
        <p className="muted small" aria-live="polite">
          {updateState === 'idle'
            ? 'ホーム画面から起動したままだと新しい版に気付かないので、ここから配信版を確認できます。'
            : updateState === 'checking'
              ? '配信先を確認しています…'
              : UPDATE_MESSAGES[updateState]}
        </p>
      </section>
    </section>
  );
}
