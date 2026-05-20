import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { ClipboardUnavailableError, copyToClipboard } from "./clipboard";

const mockSpawnSync = vi.mocked(spawnSync);

beforeEach(() => {
  mockSpawnSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("copyToClipboard", () => {
  it("succeeds when the first candidate exits 0", () => {
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<
      typeof spawnSync
    >);
    expect(() => copyToClipboard("hello")).not.toThrow();
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it("falls through to the next candidate when the first exits non-zero", () => {
    mockSpawnSync
      .mockReturnValueOnce({ status: 1 } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>);
    expect(() => copyToClipboard("hello")).not.toThrow();
    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
  });

  it("falls through when a candidate returns null status (ENOENT)", () => {
    mockSpawnSync
      .mockReturnValueOnce({ status: null } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: null } as ReturnType<typeof spawnSync>)
      .mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>);
    expect(() => copyToClipboard("hello")).not.toThrow();
    expect(mockSpawnSync).toHaveBeenCalledTimes(3);
  });

  it("throws ClipboardUnavailableError when all candidates fail", () => {
    mockSpawnSync.mockReturnValue({ status: 1 } as ReturnType<
      typeof spawnSync
    >);
    expect(() => copyToClipboard("hello")).toThrow(ClipboardUnavailableError);
  });

  it("throws ClipboardUnavailableError when all candidates return null status", () => {
    mockSpawnSync.mockReturnValue({ status: null } as ReturnType<
      typeof spawnSync
    >);
    expect(() => copyToClipboard("hello")).toThrow(ClipboardUnavailableError);
  });

  it("passes the text as input to the clipboard command", () => {
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<
      typeof spawnSync
    >);
    copyToClipboard("some text");
    expect(mockSpawnSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ input: "some text" }),
    );
  });
});
