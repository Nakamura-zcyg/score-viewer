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
  TEXT_SIZES,
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
  /** 2 本指で動かした時。dy は指が下へ動いた px、null はジェスチャ終了 */
  onPan: (dy: number | null) => void;
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
  onPan,
  pageLabel,
}: Props) {
  // null = どのツールも選んでいない（1 本指では何も起きない）。選択中のアイコンをもう一度押すと解除
  // （2026-10-30 user「ペンモードでアイコン再選択で解除」）
  const [tool, setTool] = useState<Tool | null>('pen');
  const pickTool = (t: Tool) => setTool((cur) => (cur === t ? null : t));
  const [color, setColor] = useState(ANNOT_COLORS[0].value);
  const [sizeIdx, setSizeIdx] = useState(1);
  const [textSizeIdx, setTextSizeIdx] = useState(2);
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
  // 2 本指: 書くのをやめて画面を動かす（2026-10-30 user 依頼「ペンでも 2 本指スクロール」）
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const panRef = useRef<{ lastY: number } | null>(null);
  const midY = () => {
    const ys = Array.from(pointersRef.current.values()).map((p) => p.y);
    return ys.reduce((a, b) => a + b, 0) / ys.length;
  };
  const cancelStroke = () => {
    if (draftRaf.current) cancelAnimationFrame(draftRaf.current);
    draftRaf.current = 0;
    strokeRef.current = null;
    onDraft(null);
  };
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
    /** 文字の大きさ（ページ高さに対する割合）。既存を編集中はその値から始める */
    size: number;
    /** 文字の色。編集欄でも変えられる（2026-10-30 user 依頼） */
    color: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // テキストのドラッグ移動（2026-10-30 user 依頼）。動かさずに離したら編集欄を開く
  const dragRef = useRef<{
    id: number;
    note: TextNote;
    startX: number;
    startY: number;
    pageWidthPx: number;
    moved: boolean;
    before: Annot[];
    raf: number;
    next: Annot[] | null;
  } | null>(null);
  useEffect(() => {
    if (textBox) inputRef.current?.focus();
  }, [textBox]);

  const commitText = () => {
    if (!textBox) return;
    const value = textBox.value.trim();
    const cur = annotsRef.current;
    if (textBox.editing) {
      const id = textBox.editing.id;
      const next = value
        ? cur.map((a) =>
            a.id === id
              ? { ...(a as TextNote), text: value, size: textBox.size, color: textBox.color }
              : a,
          )
        : cur.filter((a) => a.id !== id);
      commit(next);
    } else if (value) {
      const t: TextNote = {
        kind: 'text',
        id: newId(),
        page: textBox.page,
        x: round4(textBox.x),
        y: round4(textBox.y),
        text: value,
        size: textBox.size,
        color: textBox.color,
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
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size >= 2) {
      // 2 本目が触れたら書きかけは捨て、以後は 2 本指スクロール
      cancelStroke();
      panRef.current = { lastY: midY() };
      return;
    }
    if (panRef.current) return;
    if (tool === null) return;
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
      if (existing) {
        // 既存の文字: まずドラッグ候補にする。動かさずに離したら編集欄
        dragRef.current = {
          id: e.pointerId,
          note: existing,
          startX: p.x,
          startY: p.y,
          pageWidthPx: p.pageWidthPx,
          moved: false,
          before: annotsRef.current,
          raf: 0,
          next: null,
        };
        return;
      }
      setTextBox({
        left: e.clientX,
        top: e.clientY,
        page: p.page,
        x: p.x,
        y: p.y,
        editing: null,
        value: '',
        size: TEXT_SIZES[textSizeIdx].size,
        color,
      });
    }
  };

  const openTextBox = (note: TextNote, clientX: number, clientY: number) => {
    setTextBox({
      left: clientX,
      top: clientY,
      page: note.page,
      x: note.x,
      y: note.y,
      editing: note,
      value: note.text,
      size: note.size,
      color: note.color,
    });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    e.stopPropagation();
    const pt = pointersRef.current.get(e.pointerId);
    if (pt) {
      pt.x = e.clientX;
      pt.y = e.clientY;
    }
    if (panRef.current) {
      if (pointersRef.current.size >= 2) {
        const y = midY();
        const dy = y - panRef.current.lastY;
        panRef.current.lastY = y;
        if (dy !== 0) onPan(dy);
      }
      return;
    }
    const drag = dragRef.current;
    if (drag && drag.id === e.pointerId) {
      const p = toPage(e.clientX, e.clientY);
      if (!p || p.page !== drag.note.page) return;
      const dx = p.x - drag.startX;
      const dy = p.y - drag.startY;
      const pageHeightPx = (drag.pageWidthPx * dims.h) / dims.w;
      if (!drag.moved && Math.hypot(dx * drag.pageWidthPx, dy * pageHeightPx) < 8) return;
      drag.moved = true;
      const x = round4(Math.min(Math.max(drag.note.x + dx, 0), 1));
      const y = round4(Math.min(Math.max(drag.note.y + dy, 0), 1));
      drag.next = drag.before.map((a) => (a.id === drag.note.id ? { ...drag.note, x, y } : a));
      // 保存を伴うので 1 フレームに 1 回に抑える
      if (!drag.raf) {
        drag.raf = requestAnimationFrame(() => {
          drag.raf = 0;
          if (drag.next) onChange(drag.next);
        });
      }
      return;
    }
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
    pointersRef.current.delete(e.pointerId);
    if (panRef.current) {
      // 全部の指が離れるまでは描かない（残った 1 本で線が始まらないように）
      if (pointersRef.current.size === 0) {
        panRef.current = null;
        onPan(null);
      }
      return;
    }
    const drag = dragRef.current;
    if (drag && drag.id === e.pointerId) {
      dragRef.current = null;
      if (drag.raf) cancelAnimationFrame(drag.raf);
      if (drag.moved) {
        // 移動前の状態を取り消し履歴に積み、最終位置を確定
        annotsRef.current = drag.before;
        commit(drag.next ?? drag.before);
      } else {
        openTextBox(drag.note, e.clientX, e.clientY);
      }
      return;
    }
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
      className={`annot-editor tool-${tool ?? 'none'}`}
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
            onClick={() => pickTool('pen')}
            aria-label="ペン"
            title="ペン"
          >
            <PenLine size={20} />
          </button>
          <button
            className={'btn icon' + (tool === 'text' ? ' primary' : '')}
            onClick={() => pickTool('text')}
            aria-label="テキスト"
            title="テキスト"
          >
            <Type size={20} />
          </button>
          <button
            className={'btn icon' + (tool === 'eraser' ? ' primary' : '')}
            onClick={() => pickTool('eraser')}
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
        {tool === 'text' ? (
          <div className="group sizes">
            {TEXT_SIZES.map((s, i) => (
              <button
                key={s.name}
                className={'btn small size-a' + (textSizeIdx === i ? ' primary' : '')}
                onClick={() => setTextSizeIdx(i)}
                aria-label={`文字の大きさ ${s.name}`}
                title={s.name}
              >
                <span style={{ fontSize: s.iconPx }}>A</span>
              </button>
            ))}
          </div>
        ) : (
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
        )}
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
          <span className="group colors">
            {ANNOT_COLORS.map((c) => (
              <button
                key={c.value}
                className={'swatch' + (textBox.color === c.value ? ' on' : '')}
                style={{ background: c.value }}
                onClick={() => setTextBox({ ...textBox, color: c.value })}
                aria-label={`文字の色 ${c.name}`}
                title={c.name}
              />
            ))}
          </span>
          <span className="group sizes">
            {TEXT_SIZES.map((s) => (
              <button
                key={s.name}
                className={'btn small size-a' + (textBox.size === s.size ? ' primary' : '')}
                onClick={() => setTextBox({ ...textBox, size: s.size })}
                aria-label={`文字の大きさ ${s.name}`}
                title={s.name}
              >
                <span style={{ fontSize: s.iconPx }}>A</span>
              </button>
            ))}
          </span>
          <button className="btn small primary" onClick={commitText}>
            {textBox.editing ? '更新' : '置く'}
          </button>
          <button className="btn small" onClick={() => setTextBox(null)}>
            やめる
          </button>
          {textBox.editing && <span className="annot-hint">文字は指でドラッグして動かせます</span>}
        </div>
      )}
    </div>
  );
}
