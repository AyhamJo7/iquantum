import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDependencyGraph,
  buildRepoMap,
  contentHash,
  type DependencyGraph,
  detectLanguage,
  extractImports,
  extractSymbolSignatures,
  type RepoMapCache,
  scoreSymbols,
  trimTobudget,
  walkRepoFiles,
} from "./index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("detectLanguage", () => {
  it("maps supported file extensions to parser languages", () => {
    expect(detectLanguage("src/index.ts")).toBe("typescript");
    expect(detectLanguage("src/view.tsx")).toBe("tsx");
    expect(detectLanguage("src/main.py")).toBe("python");
    expect(detectLanguage("src/main.go")).toBe("go");
    expect(detectLanguage("src/lib.rs")).toBe("rust");
    expect(detectLanguage("README.md")).toBeUndefined();
  });
});

describe("extractSymbolSignatures", () => {
  it("extracts TypeScript declarations, interfaces, aliases, and arrow functions", async () => {
    const symbols = await extractSymbolSignatures(
      "src/greeter.ts",
      `
      export interface GreeterContract {
        greet(name: string): string;
      }

      export type Greeting = string;

      export class Greeter {
        greet(name: string): string {
          return name;
        }
      }

      export const welcome = (name: string): string => {
        return name;
      };

      export function salute(name: string): string {
        return name;
      }
      `,
    );

    expect(symbols.map(pickComparableFields)).toEqual([
      {
        kind: "class",
        name: "GreeterContract",
        signature: "interface GreeterContract",
      },
      { kind: "class", name: "Greeting", signature: "type Greeting = string;" },
      { kind: "class", name: "Greeter", signature: "class Greeter" },
      {
        kind: "method",
        name: "greet",
        signature: "greet(name: string): string",
      },
      {
        kind: "function",
        name: "welcome",
        signature: "const welcome = (name: string): string =>",
      },
      {
        kind: "function",
        name: "salute",
        signature: "function salute(name: string): string",
      },
    ]);
  });

  it("extracts Python classes, methods, and functions", async () => {
    const symbols = await extractSymbolSignatures(
      "greeter.py",
      `
      class Greeter:
          def greet(self, name: str) -> str:
              return name

      def salute(name: str) -> str:
          return name
      `,
    );

    expect(symbols.map(pickComparableFields)).toEqual([
      { kind: "class", name: "Greeter", signature: "class Greeter:" },
      {
        kind: "method",
        name: "greet",
        signature: "def greet(self, name: str) -> str:",
      },
      {
        kind: "function",
        name: "salute",
        signature: "def salute(name: str) -> str:",
      },
    ]);
  });

  it("extracts Go structs, methods, and functions", async () => {
    const symbols = await extractSymbolSignatures(
      "greeter.go",
      `
      package main

      type Greeter struct {}

      func (g Greeter) Greet(name string) string {
        return name
      }

      func Salute(name string) string {
        return name
      }
      `,
    );

    expect(symbols.map(pickComparableFields)).toEqual([
      { kind: "class", name: "Greeter", signature: "type Greeter struct {}" },
      {
        kind: "method",
        name: "Greet",
        signature: "func (g Greeter) Greet(name string) string",
      },
      {
        kind: "function",
        name: "Salute",
        signature: "func Salute(name string) string",
      },
    ]);
  });

  it("extracts Rust structs, methods, and functions", async () => {
    const symbols = await extractSymbolSignatures(
      "greeter.rs",
      `
      struct Greeter;

      impl Greeter {
          fn greet(&self, name: String) -> String {
              name
          }
      }

      fn salute(name: String) -> String {
          name
      }
      `,
    );

    expect(symbols.map(pickComparableFields)).toEqual([
      { kind: "class", name: "Greeter", signature: "struct Greeter;" },
      {
        kind: "method",
        name: "greet",
        signature: "fn greet(&self, name: String) -> String",
      },
      {
        kind: "function",
        name: "salute",
        signature: "fn salute(name: String) -> String",
      },
    ]);
  });
});

describe("walkRepoFiles", () => {
  it("walks supported files and honors ignored paths", async () => {
    const repoRoot = await makeTempRepo();
    await writeRepoFile(repoRoot, ".gitignore", "ignored.ts\n");
    await writeRepoFile(
      repoRoot,
      "src/keep.ts",
      "export const keep = () => true;",
    );
    await writeRepoFile(
      repoRoot,
      "src/ignored.ts",
      "export const ignored = true;",
    );
    await writeRepoFile(repoRoot, "dist/out.ts", "export const built = true;");
    await writeRepoFile(
      repoRoot,
      "node_modules/pkg/index.ts",
      "export const dep = true;",
    );
    await writeRepoFile(repoRoot, "README.md", "# docs");

    const files: string[] = [];

    for await (const filePath of walkRepoFiles(repoRoot)) {
      files.push(filePath);
    }

    expect(files).toEqual([join(repoRoot, "src/keep.ts")]);
  });
});

describe("extractImports", () => {
  it("resolves local TypeScript, workspace, and Python imports", async () => {
    const repoRoot = await makeTempRepo();
    const tsFile = join(repoRoot, "src/index.ts");
    const pyFile = join(repoRoot, "pkg/main.py");

    await writeRepoFile(repoRoot, "src/foo.ts", "export const foo = true;");
    await writeRepoFile(repoRoot, "src/bar.ts", "export const bar = true;");
    await writeRepoFile(
      repoRoot,
      "packages/config/src/index.ts",
      "export const config = true;",
    );
    await writeRepoFile(repoRoot, "pkg/models.py", "class User: ...");

    await expect(
      extractImports(
        tsFile,
        `
        import { foo } from "./foo";
        export { bar } from "./bar";
        import { config } from "@iquantum/config";
        import { z } from "zod";
        `,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        join(repoRoot, "src/foo.ts"),
        join(repoRoot, "src/bar.ts"),
        join(repoRoot, "packages/config/src/index.ts"),
      ]),
    );

    await expect(
      extractImports(
        pyFile,
        `
        from .models import User
        import os
        `,
      ),
    ).resolves.toEqual([join(repoRoot, "pkg/models.py")]);
  });

  it("resolves local Go and Rust imports on a best-effort basis", async () => {
    const repoRoot = await makeTempRepo();
    const goFile = join(repoRoot, "go/main.go");
    const rustFile = join(repoRoot, "src/lib.rs");

    await writeRepoFile(repoRoot, "go/local.go", "package local");
    await writeRepoFile(repoRoot, "src/foo.rs", "pub fn bar() {}");

    await expect(
      extractImports(
        goFile,
        `
        package main
        import "./local"
        `,
      ),
    ).resolves.toEqual([join(repoRoot, "go/local.go")]);

    await expect(
      extractImports(
        rustFile,
        `
        use crate::foo::bar;
        `,
      ),
    ).resolves.toEqual([join(repoRoot, "src/foo.rs")]);
  });
});

describe("graph and ranking", () => {
  it("builds a dependency graph from walked files", async () => {
    const repoRoot = await makeTempRepo();
    await writeRepoFile(
      repoRoot,
      "src/a.ts",
      `
      import { beta } from "./b";
      export const alpha = () => beta();
      `,
    );
    await writeRepoFile(
      repoRoot,
      "src/b.ts",
      `
      export const beta = () => true;
      `,
    );

    const graph = await buildDependencyGraph(repoRoot);

    expect(graph.size).toBe(2);
    expect(graph.get(join(repoRoot, "src/a.ts"))?.imports).toEqual([
      join(repoRoot, "src/b.ts"),
    ]);
    expect(graph.get(join(repoRoot, "src/b.ts"))?.symbols[0]?.name).toBe(
      "beta",
    );
  });

  it("scores imported symbols above leaf symbols and trims to budget", () => {
    const graph = makeGraph();
    const scores = scoreSymbols(graph);
    const map = trimTobudget(graph, scores, 40);

    expect(scores.get("/repo/b.ts:beta")).toBeGreaterThan(
      scores.get("/repo/a.ts:alpha") ?? 0,
    );
    expect(map).toContain("const beta = () =>");
    expect(Math.ceil(map.length / 4)).toBeLessThanOrEqual(40);
  });
});

describe("buildRepoMap", () => {
  it("uses the cache for repeat builds with the same content hash", async () => {
    const repoRoot = await makeTempRepo();
    await writeRepoFile(
      repoRoot,
      "src/index.ts",
      "export const alpha = () => true;",
    );

    const values = new Map<string, string>();
    const cache: RepoMapCache = {
      async get(key) {
        return values.get(key) ?? null;
      },
      async set(key, value) {
        values.set(key, value);
      },
    };

    const first = await buildRepoMap(repoRoot, { cache });
    const second = await buildRepoMap(repoRoot, { cache });

    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.map).toBe(first.map);
    expect(await contentHash(repoRoot)).toHaveLength(64);
  });

  it.skipIf(process.env.CI)("maps the iquantum repository itself", async () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const result = await buildRepoMap(repoRoot);

    expect(result.tokenCount).toBeLessThanOrEqual(1000);
    expect(result.map).toContain("buildRepoMap");
    expect(result.map).toContain("loadConfig");
    expect(result.map).toContain("extractSymbolSignatures");
  });
});

function pickComparableFields(symbol: {
  kind: string;
  name: string;
  signature: string;
}): {
  kind: string;
  name: string;
  signature: string;
} {
  return {
    kind: symbol.kind,
    name: symbol.name,
    signature: symbol.signature,
  };
}

async function makeTempRepo(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "iquantum-repo-map-"));
  tempDirs.push(directory);
  await mkdir(join(directory, ".git"), { recursive: true });
  return directory;
}

async function writeRepoFile(
  repoRoot: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = join(repoRoot, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function makeGraph(): DependencyGraph {
  return new Map([
    [
      "/repo/a.ts",
      {
        symbols: [
          {
            kind: "function",
            language: "typescript",
            name: "alpha",
            signature: "const alpha = () =>",
            startLine: 1,
            endLine: 1,
          },
        ],
        imports: ["/repo/b.ts"],
      },
    ],
    [
      "/repo/b.ts",
      {
        symbols: [
          {
            kind: "function",
            language: "typescript",
            name: "beta",
            signature: "const beta = () =>",
            startLine: 1,
            endLine: 1,
          },
        ],
        imports: [],
      },
    ],
  ]);
}
