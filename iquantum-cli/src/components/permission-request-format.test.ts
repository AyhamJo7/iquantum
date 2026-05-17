import { describe, expect, it } from "vitest";
import { inputSummaryRows } from "./permission-request-format";

describe("inputSummaryRows", () => {
  it("keeps object summaries to one bordered line at 80 columns", () => {
    const [row] = inputSummaryRows(
      {
        command:
          "bun run test packages/really-long-package-name && echo this row should not wrap at eighty columns",
      },
      80,
    );

    expect(row).toBeDefined();
    expect(row?.length).toBeLessThanOrEqual(78);
    expect(row).toMatch(/…$/);
  });

  it("keeps short summaries intact", () => {
    expect(inputSummaryRows({ path: "src/index.ts" }, 80)).toEqual([
      'path: "src/index.ts"',
    ]);
  });

  it("renders every array entry so approvals never hide arguments", () => {
    expect(
      inputSummaryRows(["src/a.ts", { path: "src/b.ts" }, undefined], 80),
    ).toEqual(["src/a.ts", '{"path":"src/b.ts"}', "undefined"]);
  });
});
