import type { CSSProperties, HTMLAttributes } from "react";

export type DotMatrixPhase = "idle" | "animated" | "hover";
export type DotMatrixPattern = "full";

export type DotAnimationResolver = (input: {
  index: number;
  row: number;
  col: number;
  isActive: boolean;
  phase: DotMatrixPhase;
  reducedMotion: boolean;
}) => {
  className?: string;
  style?: CSSProperties;
};

export type DotMatrixCommonProps = Omit<
  HTMLAttributes<HTMLSpanElement>,
  "children"
> & {
  speed?: number;
  pattern?: DotMatrixPattern;
  animated?: boolean;
  hoverAnimated?: boolean;
  phase?: DotMatrixPhase;
  reducedMotion?: boolean;
  animationResolver?: DotAnimationResolver;
};

export function rowMajorIndex(row: number, col: number): number {
  return row * 5 + col;
}

function buildDiagonalSnakeOrder(): number[] {
  const order: number[] = [];
  for (let diagonal = 0; diagonal <= 8; diagonal += 1) {
    const cells: number[] = [];
    for (let row = 0; row < 5; row += 1) {
      const col = diagonal - row;
      if (col >= 0 && col < 5) {
        cells.push(rowMajorIndex(row, col));
      }
    }
    order.push(...(diagonal % 2 === 0 ? cells.reverse() : cells));
  }
  return order;
}

const DIAGONAL_SNAKE_ORDER = buildDiagonalSnakeOrder();
const DIAGONAL_SNAKE_BY_INDEX = DIAGONAL_SNAKE_ORDER.reduce<number[]>(
  (acc, index, order) => {
    acc[index] = order;
    return acc;
  },
  [],
);

export function diagonalSnakeOrderValue(index: number): number {
  return DIAGONAL_SNAKE_BY_INDEX[index] ?? 0;
}

export function diagonalSnakeNormFromIndex(index: number): number {
  const max = Math.max(1, DIAGONAL_SNAKE_ORDER.length - 1);
  return diagonalSnakeOrderValue(index) / max;
}

export function DotMatrixBase({
  className,
  pattern = "full",
  animated,
  hoverAnimated,
  phase = "idle",
  reducedMotion,
  animationResolver,
  speed,
  ...rest
}: DotMatrixCommonProps) {
  const rootClassName = ["dmx", className].filter(Boolean).join(" ");
  const isIdle = reducedMotion || phase === "idle";

  return (
    <span
      {...rest}
      className={rootClassName}
      data-phase={phase}
      data-animated={animated ? "true" : "false"}
      data-hover-animated={hoverAnimated ? "true" : "false"}
      aria-hidden={rest["aria-hidden"] ?? true}
    >
      {Array.from({ length: 25 }, (_, index) => {
        const row = Math.floor(index / 5);
        const col = index % 5;
        const isActive = pattern === "full";
        const resolved = animationResolver?.({
          index,
          row,
          col,
          isActive,
          phase,
          reducedMotion: Boolean(reducedMotion),
        });
        const dotClassName = ["dmx__dot", isIdle ? "dmx__dot--idle" : "", resolved?.className]
          .filter(Boolean)
          .join(" ");

        return (
          <span
            key={index}
            className={dotClassName}
            style={resolved?.style}
          />
        );
      })}
    </span>
  );
}
