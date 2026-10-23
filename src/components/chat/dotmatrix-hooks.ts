import { useEffect, useState } from "react";
import type { DotMatrixPhase } from "./dotmatrix-core";

type PhaseOptions = {
  animated: boolean;
  hoverAnimated: boolean;
  speed: number;
};

export function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = () => setPrefersReducedMotion(media.matches);

    handleChange();
    media.addEventListener?.("change", handleChange);
    return () => media.removeEventListener?.("change", handleChange);
  }, []);

  return prefersReducedMotion;
}

export function useDotMatrixPhases({
  animated,
  hoverAnimated,
}: PhaseOptions) {
  const [hovered, setHovered] = useState(false);
  const phase: DotMatrixPhase = animated
    ? "animated"
    : hoverAnimated && hovered
      ? "hover"
      : "idle";

  return {
    phase,
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  };
}

type SteppedCycleOptions = {
  active: boolean;
  cycleMsBase: number;
  steps: number;
  speed: number;
};

export function useSteppedCycle({
  active,
  cycleMsBase,
  steps,
  speed,
}: SteppedCycleOptions): number {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!active || steps <= 0) {
      setStep(0);
      return;
    }

    const normalizedSpeed = Math.max(0.1, speed);
    const intervalMs = Math.max(24, cycleMsBase / steps / normalizedSpeed);
    const interval = window.setInterval(() => {
      setStep((current) => (current + 1) % steps);
    }, intervalMs);

    return () => window.clearInterval(interval);
  }, [active, cycleMsBase, speed, steps]);

  return step;
}
