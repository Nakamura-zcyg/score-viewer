// メトロノーム。Web Audio の時計で拍を先読み予約する（setTimeout の揺れに影響されない）。
// 音は短いサイン波をその場で合成するので音源ファイルは要らない。

export interface MetronomeConfig {
  bpm: number;
  /** 1 小節の拍数 */
  beats: number;
  /** 1 拍目を高い音にする */
  accent: boolean;
}

// 先読みの幅と、予約ループの間隔
const LOOKAHEAD_SEC = 0.12;
const TICK_MS = 25;

export class Metronome {
  private ctx: AudioContext | null = null;
  private timer = 0;
  private nextTime = 0;
  private beat = 0;
  private cfg: MetronomeConfig;
  private beatTimers = new Set<number>();
  running = false;
  /** 拍が鳴る時刻に合わせて呼ぶ（画面の点滅用）。beat は 0 始まり */
  onBeat: ((beat: number, beats: number) => void) | null = null;

  constructor(cfg: MetronomeConfig) {
    this.cfg = { ...cfg };
  }

  setConfig(cfg: MetronomeConfig): void {
    const beatsChanged = cfg.beats !== this.cfg.beats;
    this.cfg = { ...cfg };
    if (beatsChanged) this.beat = 0;
  }

  /** ユーザー操作の直後に呼ぶこと（音の再生許可のため） */
  start(): void {
    if (this.running) return;
    if (!this.ctx) this.ctx = new AudioContext();
    this.ctx.resume().catch(() => undefined);
    this.running = true;
    this.beat = 0;
    this.nextTime = this.ctx.currentTime + 0.05;
    this.loop();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.beatTimers.forEach((t) => clearTimeout(t));
    this.beatTimers.clear();
    this.ctx?.suspend().catch(() => undefined);
  }

  dispose(): void {
    this.stop();
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }

  private loop = (): void => {
    const ctx = this.ctx;
    if (!ctx || !this.running) return;
    while (this.nextTime < ctx.currentTime + LOOKAHEAD_SEC) {
      const beat = this.beat;
      const at = this.nextTime;
      this.click(at, this.cfg.accent && beat === 0);
      if (this.onBeat) {
        const delay = Math.max(0, (at - ctx.currentTime) * 1000);
        const t = window.setTimeout(() => {
          this.beatTimers.delete(t);
          if (this.running) this.onBeat?.(beat, this.cfg.beats);
        }, delay);
        this.beatTimers.add(t);
      }
      this.nextTime += 60 / this.cfg.bpm;
      this.beat = (beat + 1) % this.cfg.beats;
    }
    this.timer = window.setTimeout(this.loop, TICK_MS);
  };

  private click(time: number, accent: boolean): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = accent ? 1320 : 880;
    gain.gain.setValueAtTime(accent ? 1 : 0.6, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(time);
    osc.stop(time + 0.06);
  }
}
