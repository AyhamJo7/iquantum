import type { Phase } from "@iquantum/protocol";
export function PhaseStrip({
  activePhase,
  completedPhases,
}: {
  activePhase: Phase | null;
  completedPhases: Set<Phase>;
}) {
  return (
    <div>
      {["planning", "implementing", "validating"]
        .map(
          (phase) =>
            `${phase}${completedPhases.has(phase as Phase) ? " ✓" : activePhase === phase ? " ▸" : " ○"}`,
        )
        .join(" · ")}
    </div>
  );
}
