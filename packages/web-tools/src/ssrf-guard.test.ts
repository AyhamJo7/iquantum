import { lookup } from "node:dns/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertNotSsrf, isPrivateIp, SsrfBlockedError } from "./ssrf-guard";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

const lookupMock = vi.mocked(lookup);

describe("assertNotSsrf", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it("rejects 192.168.0.0/16 addresses", async () => {
    mockLookup("192.168.1.1");

    await expect(assertNotSsrf("http://192.168.1.1")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("rejects 10.0.0.0/8 addresses", async () => {
    mockLookup("10.0.0.1");

    await expect(assertNotSsrf("http://10.0.0.1")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("rejects loopback addresses", async () => {
    mockLookup("127.0.0.1");

    await expect(assertNotSsrf("http://127.0.0.1")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("rejects link-local metadata addresses", async () => {
    mockLookup("169.254.169.254");

    await expect(
      assertNotSsrf("http://169.254.169.254"),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects normalized alternate IPv4 literal forms before lookup", async () => {
    await expect(assertNotSsrf("http://2130706433")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    await expect(assertNotSsrf("http://0x7f000001")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    await expect(
      assertNotSsrf("http://0300.0250.0001.0001"),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects bracketed IPv6 loopback literals before lookup", async () => {
    await expect(assertNotSsrf("http://[::1]")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects bracketed IPv6 unique-local literals before lookup", async () => {
    await expect(assertNotSsrf("http://[fc00::1]")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects non-http schemes before lookup", async () => {
    await expect(assertNotSsrf("ftp://example.com")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("allows public IPs", async () => {
    mockLookup("8.8.8.8");

    await expect(assertNotSsrf("https://example.com")).resolves.toBeUndefined();
  });

  it("rejects a hostname when any resolved address is private", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ] as never);

    await expect(assertNotSsrf("https://example.com")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });
});

function mockLookup(address: string): void {
  lookupMock.mockResolvedValue([{ address, family: 4 }] as never);
}

describe("isPrivateIp", () => {
  it("returns false for public IPv4 addresses", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });

  it("returns true for 172.16.0.0/12 addresses", () => {
    expect(isPrivateIp("172.31.0.1")).toBe(true);
  });

  it("returns true for unspecified IPv4 addresses", () => {
    expect(isPrivateIp("0.0.0.0")).toBe(true);
    expect(isPrivateIp("0.1.2.3")).toBe(true);
  });

  it("returns true for local IPv6 addresses", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("::")).toBe(true);
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("fec0::1")).toBe(true);
  });

  it("returns false for public IPv6 addresses", () => {
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
  });

  it("handles IPv4-mapped IPv6 addresses", () => {
    expect(isPrivateIp("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateIp("::ffff:c0a8:0101")).toBe(true);
    expect(isPrivateIp("0:0:0:0:0:ffff:c0a8:0101")).toBe(true);
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
  });
});
