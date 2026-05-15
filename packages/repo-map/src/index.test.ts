import { describe, expect, it } from "vitest";
import { detectLanguage, extractSymbolSignatures } from "./index";

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
  it("extracts TypeScript classes, methods, and functions", async () => {
    const symbols = await extractSymbolSignatures(
      "src/greeter.ts",
      `
      export class Greeter {
        greet(name: string): string {
          return name;
        }
      }

      export function salute(name: string): string {
        return name;
      }
      `,
    );

    expect(symbols.map(pickComparableFields)).toEqual([
      { kind: "class", name: "Greeter", signature: "class Greeter" },
      {
        kind: "method",
        name: "greet",
        signature: "greet(name: string): string",
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
