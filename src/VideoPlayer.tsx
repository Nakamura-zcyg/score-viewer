import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { setVideoState, type VideoMeta } from './db.ts';
import { loadYouTubeApi, PLAYBACK_RATES, type YTPlayer } from './youtube.ts';
import { useWakeLock } from './useWakeLock.ts';

// YouTube 埋め込みプレイヤー。操作は YouTube 標準。上のバーに戻るボタンと再生速度を置く。
// 速度と再生位置は動画ごとに保存し、次に開いた時に続きから始める。

interface Props {
  video: VideoMeta;
  onExit: () => void;
}

// 再生位置を保存する間隔
const SAVE_INTERVAL_MS = 5000;
// 終わり際で保存された位置は先頭に戻す（次回に「続き」として末尾から始めない）
const RESUME_TAIL_SECONDS = 10;

export default function VideoPlayer({ video, onExit }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rate, setRate] = useState(video.rate ?? 1);
  const [rates, setRates] = useState<number[]>(PLAYBACK_RATES);
  const [barVisible, setBarVisible] = useState(true);

  // ---- プレイヤー生成 ----
  useEffect(() => {
    let alive = true;
    let player: YTPlayer | null = null;
    const host = hostRef.current!;
    // API が差し替えるので、毎回新しい要素を用意する
    const el = document.createElement('div');
    host.appendChild(el);
    loadYouTubeApi()
      .then((YT) => {
        if (!alive) return;
        player = new YT.Player(el, {
          videoId: video.videoId,
          host: 'https://www.youtube-nocookie.com',
          playerVars: {
            playsinline: 1,
            rel: 0,
            modestbranding: 1,
            origin: location.origin,
            start: Math.floor(video.lastTime ?? 0),
          },
          events: {
            onReady: (e) => {
              if (!alive) return;
              playerRef.current = e.target;
              const avail = e.target.getAvailablePlaybackRates?.();
              if (avail && avail.length > 1) setRates(avail);
              const r = video.rate ?? 1;
              if (r !== 1) e.target.setPlaybackRate(r);
              setReady(true);
            },
            onError: (e) => {
              if (!alive) return;
              const msg =
                e.data === 101 || e.data === 150
                  ? '投稿者が埋め込み再生を許可していない動画です'
                  : e.data === 100
                    ? '動画が見つかりません（削除または非公開）'
                    : `再生できません（コード ${e.data}）`;
              setError(msg);
            },
          },
        });
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
      playerRef.current = null;
      try {
        player?.destroy();
      } catch {
        /* 無視 */
      }
      host.replaceChildren();
    };
  }, [video.videoId, video.lastTime, video.rate]);

  // ---- 再生位置の保存 ----
  useEffect(() => {
    if (!ready) return;
    const save = () => {
      const p = playerRef.current;
      if (!p) return;
      try {
        const t = p.getCurrentTime();
        const d = p.getDuration();
        const lastTime = d > 0 && d - t < RESUME_TAIL_SECONDS ? 0 : t;
        setVideoState(video.id, { lastTime }).catch(() => undefined);
      } catch {
        /* プレイヤー破棄後 */
      }
    };
    const timer = setInterval(save, SAVE_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      save();
    };
  }, [ready, video.id]);

  // ---- 速度の適用と保存 ----
  const changeRate = (r: number) => {
    setRate(r);
    playerRef.current?.setPlaybackRate(r);
    setVideoState(video.id, { rate: r }).catch(() => undefined);
  };

  // ---- 画面消灯防止（1 時間無操作で解除。再生中はブラウザ自体が画面を保つ） ----
  useWakeLock(false);

  return (
    <div className="video">
      <div ref={hostRef} className="video-host" />
      {!ready && !error && <div className="center muted">プレイヤーを読み込み中…</div>}
      {error && (
        <div className="center">
          <div className="load-status">
            <p>{error}</p>
            <a
              className="btn"
              href={`https://www.youtube.com/watch?v=${video.videoId}`}
              target="_blank"
              rel="noreferrer"
            >
              YouTube で開く
            </a>
            <button className="btn with-icon" onClick={onExit}>
              <ArrowLeft size={20} /> ライブラリへ戻る
            </button>
          </div>
        </div>
      )}
      <div className={'video-bar' + (barVisible ? '' : ' hidden')}>
        <button className="btn icon" onClick={onExit} aria-label="ライブラリへ戻る" title="ライブラリへ戻る">
          <ArrowLeft size={22} />
        </button>
        <span className="video-title">{video.name}</span>
        <label className="video-rate">
          速度{' '}
          <select value={rate} onChange={(e) => changeRate(Number(e.target.value))} disabled={!ready}>
            {rates.map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn icon"
          onClick={() => setBarVisible(false)}
          aria-label="バーを隠す"
          title="バーを隠す"
        >
          ×
        </button>
      </div>
      {!barVisible && (
        <button className="video-bar-show" onClick={() => setBarVisible(true)} aria-label="バーを表示">
          ⋯
        </button>
      )}
    </div>
  );
}
