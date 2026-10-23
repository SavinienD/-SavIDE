import { useCallback, useEffect, useRef, useState } from "react";

type Orientation = "vertical" | "horizontal";

type Props = {
  orientation: Orientation;
  onDelta: (delta: number) => void;
  onCommit?: () => void;
  /** Double-click: back to the default sizes. */
  onReset?: () => void;
  /** Locked: the gutter ignores the pointer. */
  disabled?: boolean;
};

/**
 * A thin drag-gutter. We measure the pointer delta and let the parent
 * commit it against its own clamped sizes - keeps clamping logic near
 * the layout that actually knows valid bounds.
 */
export function Splitter({ orientation, onDelta, onCommit, onReset, disabled = false }: Props) {
  const [dragging, setDragging] = useState(false);
  const last = useRef<number>(0);

  const onDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      last.current = orientation === "vertical" ? event.clientX : event.clientY;
      setDragging(true);
    },
    [orientation],
  );

  const onMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const pos = orientation === "vertical" ? event.clientX : event.clientY;
      const delta = pos - last.current;
      if (delta !== 0) {
        last.current = pos;
        onDelta(delta);
      }
    },
    [dragging, orientation, onDelta],
  );

  const onUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      event.currentTarget.releasePointerCapture(event.pointerId);
      setDragging(false);
      onCommit?.();
    },
    [dragging, onCommit],
  );

  useEffect(() => {
    if (!dragging) return;
    document.body.style.cursor =
      orientation === "vertical" ? "col-resize" : "row-resize";
    return () => {
      document.body.style.cursor = "";
    };
  }, [dragging, orientation]);

  return (
    <div
      className={orientation === "vertical" ? "gutter" : "gutter-h"}
      data-dragging={dragging ? "true" : "false"}
      data-disabled={disabled ? "true" : "false"}
      onPointerDown={disabled ? undefined : onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={disabled ? undefined : onReset}
    />
  );
}
