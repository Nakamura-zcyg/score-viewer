import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Eraser,
  PenLine,
  Type,
  Undo2,
} from 'lucide-react';
import {
  ANNOT_COLORS,
  ANNOT_SIZES,
  hitTest,
  newId,
  round4,
  textAt,
  type Annot,
  type PagePoint,
  type Stroke,
  type TextNote,
  type Tool,
} from './annot.ts';

interface Props {
  annots: Annot[];
  dims: { w: number; h: number };
  /** 画面上の点 → ページ内の割合。ページの外なら null */
  toPage: (clientX: number, clientY: number) => PagePoint | null;
  onChange: (next: Annot[]) => void;
  /** 書きかけの線（表示側で annots と合わせて描く） */
  onDraft: (s: Stroke | null) => void;
  onPrev: () => void;
  onNext: () => void;
  onDone: () => void;
  pageLabel: string;
}

const ERASE_RADIUS_PX = 14;
const MAX_UNDO = 50;

/**
 * 書き込みモードの入力層。画面全体を覆い、ページめくり等のジェスチャには渡さない。
 * ペン: 指でなぞる（ページをまたぐ点は捨てる）。テキスト: タップした所に入力欄。
 * 消しゴム: 触れた線・文字を消す。取り消しはこのモード中の操作だけ対象
 */
export default function AnnotEditor({
  annots,
  dims,
  toPage,
  onChange,
  onDraft,
  onPrev,
  onNext,
  onDone,
  pageLabel,
}: Props) {
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState(ANNOT_COLORS[0].value);
  const [sizeIdx, setSizeIdx] = useState(1);
  const undoRef = useRef<Annot[][]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const annotsRef = useRef(annots);
  annotsRef.current = annots;

  const commit = useCallback(
    (next: Annot[]) => {
      undoRef.current.push(annotsRef.current);
      if (undoRef.current.length > MAX_UNDO) undoRef.current.shift();
      setUndoCount(undoRef.current.length);
      onChange(next);
    },
    [onChange],
  );
  const undo = () => {
    const prev = undoRef.current.pop();
    setUndoCount(undoRef.current.length);
    if (prev) onChange(prev);
  };

  // ---- ペン ----
  const strokeRef = useRef<{ id: number; s: Stroke; pageWidthPx: number } | null>(null);
  const draftRaf = useRef(0);
  const pushDraft = (s: Stroke) => {
    if (draftRaf.current) return;
    draftRaf.current = requestAnimationFrame(() => {
      draftRaf.current = 0;
      onDraft({ ...s, pts: s.pts.slice() });
    });
  };

  // ---- テキスト入力欄 ----
  const [textBox, setTextBox] = useState<{
    left: number;
    top: number;
    page: number;
    x: number;
    y: number;
    editing: TextNote | null;
    value: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (textBox) inputRef.current?.focus();
  }, [textBox]);

  const commitText = () => {
    if (!textBox) return;
    const value = textBox.value.trim();
    const cur = annotsRef.current;
    if (textBox.editing) {
      const next = value
        ? cur.map((a) => (a.id === textBox.editing!.id ? { ...textBox.editing!, text: value } : a))
        : cur.filter((a) => a.id !== textBox.editing!.id);
      commit(next);
    } else if (value) {
      const t: TextNote = {
        kind: 'text',
        id: newId(),
        page: textBox.page,
        x: round4(textBox.x),
        y: round4(textBox.y),
        text: value,
        size: ANNOT_SIZES[sizeIdx].text,
        color,
      };
      commit([...cur, t]);
    }
    setTextBox(null);
  };

  const erasedRef = useRef<Set<string>>(new Set());
  const eraseAt = (p: PagePoint) => {
    const ids = hitTest(annotsRef.current, p.page, p.x, p.y, ERASE_RADIUS_PX, p.pageWidthPx, dims);
    const fresh = ids.filter((id) => !erasedRef.current.has(id));
    if (fresh.length === 0) return;
    fresh.forEach((id) => erasedRef.current.add(id));
    commit(annotsRef.current.filter((a) => !erasedRef.current.has(a.id)));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (textBox) {
      commitText();
      return;
    }
    const p = toPage(e.clientX, e.clientY);
    if (!p) return;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* 非対応、または合成イベント */
    }
    if (tool === 'pen') {
      if (strokeRef.current) return; // 2 本目の指は無視
      const s: Stroke = {
        kind: 'pen',
        id: newId(),
        page: p.page,
        color,
        width: ANNOT_SIZES[sizeIdx].width,
        pts: [round4(p.x), round4(p.y)],
      };
      strokeRef.current = { id: e.pointerId, s, pageWidthPx: p.pageWidthPx };
      pushDraft(s);
    } else if (tool === 'eraser') {
      erasedRef.current = new Set();
      strokeRef.current = { id: e.pointerId, s: null as unknown as Stroke, pageWidthPx: p.pageWidthPx };
      eraseAt(p);
    } else {
      const existing = textAt(annotsRef.current, p.page, p.x, p.y, dims);
      setTextBox({
        left: e.clientX,
        top: e.clientY,
        page: p.page,
        x: p.x,
        y: p.y,
        editing: existing,
        value: existing?.text ?? '',
      });
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    e.stopPropagation();
    const cur = strokeRef.current;
    if (!cur || cur.id !== e.pointerId) return;
    const p = toPage(e.clientX, e.clientY);
    if (!p) return;
    if (tool === 'eraser') {
      eraseAt(p);
      return;
    }
    if (p.page !== cur.s.page) return; // 別のページに入った点は捨てる
    const n = cur.s.pts.length;
    // 近すぎる点は間引く（ページ幅の 0.2%）
    if (Math.hypot(p.x - cur.s.pts[n - 2], p.y - cur.s.pts[n - 1]) < 0.002) return;
    cur.s.pts.push(round4(p.x), round4(p.y));
    pushDraft(cur.s);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    e.stopPropagation();
    const cur = strokeRef.current;
    if (!cur || cur.id !== e.pointerId) return;
    strokeRef.current = null;
    if (tool === 'pen') {
      if (draftRaf.current) cancelAnimationFrame(draftRaf.current);
      draftRaf.current = 0;
      onDraft(null);
      commit([...annotsRef.current, cur.s]);
    }
  };

  useEffect(
    () => () => {
      if (draftRaf.current) cancelAnimationFrame(draftRaf.current);
      onDraft(null);
    },
    [onDraft],
  );

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div
      className={`annot-editor tool-${tool}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="annot-toolbar" onPointerDown={stop} onPointerUp={stop} onPointerMove={stop}>
        <div className="group">
          <button
            className={'btn icon' + (tool === 'pen' ? ' primary' : '')}
            onClick={() => setTool('pen')}
            aria-label="ペン"
            title="ペン"
          >
            <PenLine size={20} />
          </button>
          <button
            className={'btn icon' + (tool === 'text' ? ' primary' : '')}
            onClick={() => setTool('text')}
            aria-label="テキスト"
            title="テキスト"
          >
            <Type size={20} />
          </button>
          <button
            className={'btn icon' + (tool === 'eraser' ? ' primary' : '')}
            onClick={() => setTool('eraser')}
            aria-label="消しゴム"
            title="消しゴム"
          >
            <Eraser size={20} />
          </button>
        </div>
        <div className="group colors">
          {ANNOT_COLORS.map((c) => (
            <button
              key={c.value}
              className={'swatch' + (color === c.value ? ' on' : '')}
              style={{ background: c.value }}
              onClick={() => setColor(c.value)}
              aria-label={c.name}
              title={c.name}
            />
          ))}
        </div>
        <div className="group sizes">
          {ANNOT_SIZES.map((s, i) => (
            <button
              key={s.name}
              className={'btn small' + (sizeIdx === i ? ' primary' : '')}
              onClick={() => setSizeIdx(i)}
              aria-label={`太さ ${s.name}`}
            >
              {s.name}
            </button>
          ))}
        </div>
        <div className="group">
          <button className="btn icon" onClick={undo} disabled={undoCount === 0} aria-label="取り消し" title="取り消し">
            <Undo2 size={20} />
          </button>
        </div>
        <div className="group pages">
          <button className="btn icon" onClick={onPrev} aria-label="前のページ" title="前のページ">
            <ChevronLeft size={20} />
          </button>
          <span className="annot-page">{pageLabel}</span>
          <button className="btn icon" onClick={onNext} aria-label="次のページ" title="次のページ">
            <ChevronRight size={20} />
          </button>
        </div>
        <button className="btn primary with-icon" onClick={onDone} aria-label="書き込みを終える">
          <Check size={20} /> 完了
        </button>
      </div>

      {textBox && (
        <div
          className="annot-textbox"
          style={{ left: Math.min(textBox.left, window.innerWidth - 260), top: textBox.top }}
          onPointerDown={stop}
          onPointerUp={stop}
          onPointerMove={stop}
        >
          <input
            ref={inputRef}
            value={textBox.value}
            placeholder="文字を入力"
            onChange={(e) => setTextBox({ ...textBox, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitText();
              if (e.key === 'Escape') setTextBox(null);
            }}
          />
          <button className="btn small primary" onClick={commitText}>
            {textBox.editing ? '更新' : '置く'}
          </button>
          <button className="btn small" onClick={() => setTextBox(null)}>
            やめる
          </button>
        </div>
      )}
    </div>
  );
}
