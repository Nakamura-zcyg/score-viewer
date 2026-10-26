import { useEffect, useState } from 'react';
import { ArrowLeft, HardDrive, RefreshCw, RotateCcw } from 'lucide-react';
import { APP_VERSION, BUILD_TIME, checkForUpdate, type UpdateResult } from './updates.ts';
import { checkOffline, fileName, rebuildOffline, repairOffline, type OfflineStatus } from './offline.ts';
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

function formatBytes(n: number | undefined): string {
  if (n === undefined) return '不明';
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const SW_LABEL: Record<OfflineStatus['sw'], string> = {
  controlled: '動作中（このページを制御）',
  uncontrolled: '登録はあるが、このページを制御していない',
  none: '登録なし',
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
  const [offline, setOffline] = useState<OfflineStatus | null>(null);
  const [offlineBusy, setOfflineBusy] = useState(false);
  const [offlineMsg, setOfflineMsg] = useState<string | null>(null);

  // 開いた時点の状態を出しておく（押さなくても欠けが分かるように）
  useEffect(() => {
    checkOffline().then(setOffline).catch(() => undefined);
  }, []);

  const repair = async () => {
    setOfflineBusy(true);
    setOfflineMsg(null);
    try {
      const before = await checkOffline();
      if (before.missing.length === 0) {
        setOffline(before);
        setOfflineMsg('必要なファイルはすべてキャッシュにあります');
        return;
      }
      if (!navigator.onLine) {
        setOffline(before);
        setOfflineMsg('欠けがありますが、オフラインなので補えません。ネットに繋いでからもう一度押してください');
        return;
      }
      const r = await repairOffline();
      const after = await checkOffline();
      setOffline(after);
      if (after.missing.length === 0) {
        setOfflineMsg(`${r.added.length} 件を補いました。これでオフラインでも開けます`);
      } else {
        setOfflineMsg(
          `補えなかったものがあります: ${after.missing.map(fileName).join('、')}。「作り直す」を試してください`,
        );
      }
    } catch (e) {
      setOfflineMsg(`点検に失敗しました: ${String(e)}`);
    } finally {
      setOfflineBusy(false);
    }
  };

  const rebuild = () => {
    if (!navigator.onLine) {
      setOfflineMsg('作り直しはネットに繋いだ状態で行ってください');
      return;
    }
    if (!confirm('オフライン用のキャッシュを捨てて、配信先から入れ直します。楽譜のデータは消えません。よろしいですか？')) {
      return;
    }
    setOfflineBusy(true);
    rebuildOffline().catch((e) => {
      setOfflineMsg(`作り直しに失敗しました: ${String(e)}`);
      setOfflineBusy(false);
    });
  };
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

        <div className="setting-app-row offline-row">
          <span>
            <span className="setting-label">オフライン用キャッシュ</span>
            <span className="setting-note">
              {offline === null
                ? '確認中…'
                : offline.missing.length === 0
                  ? `必要なファイルは揃っています（${offline.entries} 件）`
                  : `欠けあり: ${offline.missing.map(fileName).join('、')}`}
            </span>
          </span>
          <button className="btn with-icon" disabled={offlineBusy} onClick={repair}>
            <HardDrive size={18} className={offlineBusy ? 'spin' : undefined} /> 確認して補う
          </button>
          <button className="btn" disabled={offlineBusy} onClick={rebuild}>
            作り直す
          </button>
        </div>
        {offline && (
          <ul className="offline-detail muted small">
            <li>Service Worker: {SW_LABEL[offline.sw]}</li>
            <li>キャッシュ: {offline.cacheName ? `${offline.entries} 件` : 'なし'}</li>
            <li>
              永続ストレージ:{' '}
              {offline.persisted === null ? '不明' : offline.persisted ? '許可済み' : '未許可（空き容量が減ると消されることがある）'}
            </li>
            <li>
              使用量: {formatBytes(offline.usage)} / 上限 {formatBytes(offline.quota)}
            </li>
          </ul>
        )}
        {offlineMsg && (
          <p className="muted small" aria-live="polite">
            {offlineMsg}
          </p>
        )}
      </section>
    </section>
  );
}
