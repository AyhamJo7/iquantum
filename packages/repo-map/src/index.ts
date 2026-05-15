import { createRequire } from "node:module";
import { extname } from "node:path";
import { Language, type Node, Parser } from "web-tree-sitter";

export type SupportedLanguage = "go" | "python" | "rust" | "typescript" | "tsx";

export type SymbolKind = "class" | "function" | "method";

export interface SymbolSignature {
  kind: SymbolKind;
  language: SupportedLanguage;
  name: string;
  signature: string;
  startLine: number;
  endLine: number;
}

const require = createRequire(import.meta.url);

const wasmPathByLanguage: Record<SupportedLanguage, string> = {
  go: require.resolve("tree-sitter-go/tree-sitter-go.wasm"),
  python: require.resolve("tree-sitter-python/tree-sitter-python.wasm"),
  rust: require.resolve("tree-sitter-rust/tree-sitter-rust.wasm"),
  typescript: require.resolve(
    "tree-sitter-typescript/tree-sitter-typescript.wasm",
  ),
  tsx: require.resolve("tree-sitter-typescript/tree-sitter-tsx.wasm"),
};

const languageByExtension: Record<string, SupportedLanguage> = {
  ".go": "go",
  ".py": "python",
  ".rs": "rust",
  ".ts": "typescript",
  ".tsx": "tsx",
};

const languageCache = new Map<SupportedLanguage, Promise<Language>>();
let parserInitialization: Promise<void> | undefined;

export function detectLanguage(
  filePath: string,
): SupportedLanguage | undefined {
  return languageByExtension[extname(filePath)];
}

export async function extractSymbolSignatures(
  filePath: string,
  source: string,
): Promise<SymbolSignature[]> {
  const language = detectLanguage(filePath);

  if (!language) {
    return [];
  }

  await ensureParserInitialized();

  const parser = new Parser();
  parser.setLanguage(await loadLanguage(language));

  try {
    const tree = parser.parse(source);

    if (!tree) {
      return [];
    }

    return extractFromTree(tree.rootNode, language).sort(
      (left, right) => left.startLine - right.startLine,
    );
  } finally {
    parser.delete();
  }
}

function extractFromTree(
  rootNode: Node,
  language: SupportedLanguage,
): SymbolSignature[] {
  switch (language) {
    case "go":
      return extractGoSymbols(rootNode);
    case "python":
      return extractPythonSymbols(rootNode);
    case "rust":
      return extractRustSymbols(rootNode);
    case "tsx":
    case "typescript":
      return extractTypeScriptSymbols(rootNode, language);
  }
}

function extractTypeScriptSymbols(
  rootNode: Node,
  language: "typescript" | "tsx",
): SymbolSignature[] {
  return [
    ...rootNode
      .descendantsOfType("class_declaration")
      .map((node) => createSymbol(node, "class", language)),
    ...rootNode
      .descendantsOfType("function_declaration")
      .map((node) => createSymbol(node, "function", language)),
    ...rootNode
      .descendantsOfType("method_definition")
      .map((node) => createSymbol(node, "method", language)),
  ].filter(isDefined);
}

function extractPythonSymbols(rootNode: Node): SymbolSignature[] {
  return [
    ...rootNode
      .descendantsOfType("class_definition")
      .map((node) => createSymbol(node, "class", "python")),
    ...rootNode
      .descendantsOfType("function_definition")
      .map((node) =>
        createSymbol(
          node,
          hasAncestor(node, "class_definition") ? "method" : "function",
          "python",
        ),
      ),
  ].filter(isDefined);
}

function extractGoSymbols(rootNode: Node): SymbolSignature[] {
  const structTypes = rootNode
    .descendantsOfType("type_spec")
    .filter((node) => node.childForFieldName("type")?.type === "struct_type")
    .map((node) => createSymbol(node, "class", "go", "type "));

  return [
    ...structTypes,
    ...rootNode
      .descendantsOfType("function_declaration")
      .map((node) => createSymbol(node, "function", "go")),
    ...rootNode
      .descendantsOfType("method_declaration")
      .map((node) => createSymbol(node, "method", "go")),
  ].filter(isDefined);
}

function extractRustSymbols(rootNode: Node): SymbolSignature[] {
  return [
    ...rootNode
      .descendantsOfType("struct_item")
      .map((node) => createSymbol(node, "class", "rust")),
    ...rootNode
      .descendantsOfType("function_item")
      .map((node) =>
        createSymbol(
          node,
          hasAncestor(node, "impl_item") ? "method" : "function",
          "rust",
        ),
      ),
  ].filter(isDefined);
}

function createSymbol(
  node: Node,
  kind: SymbolKind,
  language: SupportedLanguage,
  signaturePrefix = "",
): SymbolSignature | undefined {
  const name = node.childForFieldName("name")?.text;

  if (!name) {
    return undefined;
  }

  return {
    kind,
    language,
    name,
    signature: `${signaturePrefix}${signatureText(node)}`,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

function signatureText(node: Node): string {
  const body = node.childForFieldName("body");

  if (!body) {
    return firstLine(node.text);
  }

  return compactWhitespace(
    node.text.slice(0, body.startIndex - node.startIndex),
  );
}

function firstLine(text: string): string {
  return compactWhitespace(text.split("\n", 1)[0] ?? text);
}

function compactWhitespace(text: string): string {
  return text.trim().replaceAll(/\s+/g, " ");
}

function hasAncestor(node: Node, type: string): boolean {
  let parent = node.parent;

  while (parent) {
    if (parent.type === type) {
      return true;
    }

    parent = parent.parent;
  }

  return false;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

async function ensureParserInitialized(): Promise<void> {
  parserInitialization ??= Parser.init();
  await parserInitialization;
}

function loadLanguage(language: SupportedLanguage): Promise<Language> {
  const existing = languageCache.get(language);

  if (existing) {
    return existing;
  }

  const pending = Language.load(wasmPathByLanguage[language]);
  languageCache.set(language, pending);
  return pending;
}
