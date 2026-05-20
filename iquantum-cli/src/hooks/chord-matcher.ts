import type { KeybindingAction, KeybindingMap } from "@iquantum/config";

export class ChordMatcher {
  readonly #map: KeybindingMap;
  readonly #windowMs: number;
  #buffer: string[] = [];
  #lastKeyTime = 0;

  constructor(map: KeybindingMap, windowMs = 500) {
    this.#map = normalizeMap(map);
    this.#windowMs = windowMs;
  }

  processKey(key: string, timestamp: number): KeybindingAction | null {
    const normalized = key.toLowerCase();
    if (!normalized) return null;

    if (
      this.#buffer.length > 0 &&
      timestamp - this.#lastKeyTime > this.#windowMs
    ) {
      this.#buffer = [];
    }

    this.#lastKeyTime = timestamp;
    this.#buffer.push(normalized);
    const chord = this.#buffer.join(" ");
    const action = this.#map[chord];
    if (action) {
      this.#buffer = [];
      return action;
    }

    const isPrefix = Object.keys(this.#map).some((candidate) =>
      candidate.startsWith(`${chord} `),
    );
    if (!isPrefix) {
      this.#buffer = [];
    }

    return null;
  }
}

function normalizeMap(map: KeybindingMap): KeybindingMap {
  const normalized: KeybindingMap = {};
  for (const [chord, action] of Object.entries(map)) {
    normalized[chord.toLowerCase()] = action;
  }
  return normalized;
}
