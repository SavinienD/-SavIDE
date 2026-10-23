import { DotmSquare5 } from "./DotmSquare5";

export function PlanningNextMoveBlock() {
  return (
    <div className="thinking-block planning-next-move" role="status">
      <div
        className="thinking-block__head planning-next-move__head"
        data-streaming="true"
        data-has-content="false"
      >
        <DotmSquare5
          speed={1}
          animated
          className="thinking-block__matrix planning-next-move__matrix"
        />
        <span className="thinking-block__label" data-streaming="true">
          Préparation des prochaines étapes
        </span>
      </div>
    </div>
  );
}
