export interface AgentColor {
  index: number;
  label: string;
  hex: string;
}

export const agentColors = [
  { label: "cyan", hex: "#06b6d4" },
  { label: "green", hex: "#22c55e" },
  { label: "yellow", hex: "#eab308" },
  { label: "magenta", hex: "#d946ef" },
  { label: "orange", hex: "#f97316" },
] as const;

export class AgentColorManager {
  #nextIndex = 0;

  next(): AgentColor {
    const color = this.byIndex(this.#nextIndex);
    this.#nextIndex = (this.#nextIndex + 1) % agentColors.length;
    return color;
  }

  byIndex(index: number): AgentColor {
    const normalized = normalizeIndex(index);
    const color = agentColors[normalized];
    if (!color) {
      throw new Error(`Agent color index is out of range: ${index}`);
    }
    return { index: normalized, label: color.label, hex: color.hex };
  }
}

function normalizeIndex(index: number): number {
  if (!Number.isInteger(index)) {
    throw new Error(`Agent color index must be an integer: ${index}`);
  }

  return (
    ((index % agentColors.length) + agentColors.length) % agentColors.length
  );
}
