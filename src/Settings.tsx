import { useState } from 'react';
import { ArrowLeft, RotateCcw } from 'lucide-react';
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

export default function Settings({ onExit }: Props) {
  const settings = useSettings();
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
    </section>
  );
}
