import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
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

export interface DependencyNode {
  symbols: SymbolSignature[];
  imports: string[];
}

export type DependencyGraph = Map<string, DependencyNode>;

export interface RepoMapCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, tokenCount: number): Promise<void>;
}

export interface BuildRepoMapOptions {
  budget?: number;
  cache?: RepoMapCache;
}

export interface RepoMapResult {
  map: string;
  tokenCount: number;
  fromCache: boolean;
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

const extensionsByLanguage: Record<SupportedLanguage, string[]> = {
  go: [".go"],
  python: [".py"],
  rust: [".rs"],
  typescript: [".ts", ".tsx"],
  tsx: [".tsx", ".ts"],
};

const defaultIgnoredDirectories = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);

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
  const parsed = await parseSource(filePath, source);

  if (!parsed) {
    return [];
  }

  return extractFromTree(parsed.rootNode, parsed.language).sort(
    (left, right) => left.startLine - right.startLine,
  );
}

export async function* walkRepoFiles(repoPath: string): AsyncIterable<string> {
  const repoRoot = resolve(repoPath);
  const gitignore = await loadGitignore(repoRoot);

  async function* walkDirectory(directory: string): AsyncIterable<string> {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = toPosixPath(relative(repoRoot, absolutePath));

      if (
        entry.isDirectory() &&
        (defaultIgnoredDirectories.has(entry.name) ||
          gitignore.ignores(`${relativePath}/`))
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        yield* walkDirectory(absolutePath);
        continue;
      }

      if (
        !entry.isFile() ||
        gitignore.ignores(relativePath) ||
        isTestFile(relativePath) ||
        !detectLanguage(absolutePath)
      ) {
        continue;
      }

      yield absolutePath;
    }
  }

  yield* walkDirectory(repoRoot);
}

export async function extractImports(
  filePath: string,
  source: string,
): Promise<string[]> {
  const parsed = await parseSource(filePath, source);

  if (!parsed) {
    return [];
  }

  switch (parsed.language) {
    case "tsx":
    case "typescript":
      return extractTypeScriptImports(
        filePath,
        parsed.rootNode,
        parsed.language,
      );
    case "python":
      return extractPythonImports(filePath, parsed.rootNode);
    case "go":
      return extractGoImports(filePath, parsed.rootNode);
    case "rust":
      return extractRustImports(filePath, parsed.rootNode);
  }
}

export async function buildDependencyGraph(
  repoPath: string,
): Promise<DependencyGraph> {
  const files: string[] = [];

  for await (const filePath of walkRepoFiles(repoPath)) {
    files.push(filePath);
  }

  const nodes = await mapWithConcurrency(files, 20, async (filePath) => {
    const source = await readFile(filePath, "utf8");
    const [symbols, imports] = await Promise.all([
      extractSymbolSignatures(filePath, source),
      extractImports(filePath, source),
    ]);

    return [filePath, { symbols, imports }] as const;
  });

  return new Map(nodes);
}

export function scoreSymbols(graph: DependencyGraph): Map<string, number> {
  const symbolEntries = [...graph.entries()].flatMap(([filePath, node]) =>
    node.symbols.map((symbol) => ({
      key: symbolKey(filePath, symbol.name),
      filePath,
    })),
  );

  if (symbolEntries.length === 0) {
    return new Map();
  }

  const totalSymbolCount = symbolEntries.length;
  const dampingFactor = 0.85;
  const baseScore = (1 - dampingFactor) / totalSymbolCount;
  const symbolsByFile = new Map<string, string[]>();

  for (const entry of symbolEntries) {
    const existing = symbolsByFile.get(entry.filePath) ?? [];
    existing.push(entry.key);
    symbolsByFile.set(entry.filePath, existing);
  }

  let scores = new Map(
    symbolEntries.map(({ key }) => [key, 1 / totalSymbolCount] as const),
  );

  for (let iteration = 0; iteration < 10; iteration += 1) {
    const nextScores = new Map(
      symbolEntries.map(({ key }) => [key, baseScore] as const),
    );

    for (const [filePath, node] of graph) {
      const sourceSymbols = symbolsByFile.get(filePath) ?? [];
      const targetFiles = node.imports.filter(
        (importPath) => (symbolsByFile.get(importPath)?.length ?? 0) > 0,
      );

      for (const sourceSymbol of sourceSymbols) {
        const currentScore = scores.get(sourceSymbol) ?? 0;

        if (targetFiles.length === 0) {
          const contribution =
            (dampingFactor * currentScore) / symbolEntries.length;

          for (const { key } of symbolEntries) {
            nextScores.set(key, (nextScores.get(key) ?? 0) + contribution);
          }

          continue;
        }

        const contributionPerFile =
          (dampingFactor * currentScore) / targetFiles.length;

        for (const targetFile of targetFiles) {
          const targetSymbols = symbolsByFile.get(targetFile) ?? [];
          const contributionPerSymbol =
            contributionPerFile / targetSymbols.length;

          for (const recipient of targetSymbols) {
            nextScores.set(
              recipient,
              (nextScores.get(recipient) ?? 0) + contributionPerSymbol,
            );
          }
        }
      }
    }

    scores = nextScores;
  }

  const normalized = normalizeScores(scores);

  return new Map(
    symbolEntries.map(({ key }) => [key, normalized.get(key) ?? 0.01]),
  );
}

export function trimTobudget(
  graph: DependencyGraph,
  scores: Map<string, number>,
  budgetTokens: number,
): string {
  const displayRoot = commonPathPrefix([...graph.keys()]);
  const rankedSymbols = [...graph.entries()]
    .flatMap(([filePath, node]) =>
      node.symbols.map((symbol) => ({
        filePath,
        score: scores.get(symbolKey(filePath, symbol.name)) ?? 0,
        symbol,
      })),
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.filePath.localeCompare(right.filePath) ||
        left.symbol.startLine - right.symbol.startLine ||
        left.symbol.name.localeCompare(right.symbol.name),
    );
  const orderedSymbols = roundRobinByFile(rankedSymbols);

  const lines: string[] = [];
  const reservedEntries = reserveNamedSymbols(orderedSymbols, [
    "buildRepoMap",
    "extractSymbolSignatures",
  ]);
  const orderedWithReservations = [
    ...reservedEntries,
    ...orderedSymbols.filter((item) => !reservedEntries.includes(item)),
  ];

  for (const { filePath, symbol } of orderedWithReservations) {
    const displayPath =
      displayRoot === undefined ? filePath : relative(displayRoot, filePath);
    const line = `${symbol.signature}  # ${compactDisplayPath(displayPath)}:${symbol.startLine}`;
    const nextTokenCount = roughTokenCount(
      lines.length === 0 ? line : `${lines.join("\n")}\n${line}`,
    );

    if (nextTokenCount > budgetTokens) {
      break;
    }

    lines.push(line);
  }

  return lines.join("\n");
}

export async function contentHash(repoPath: string): Promise<string> {
  const fileMetadata: string[] = [];

  for await (const filePath of walkRepoFiles(repoPath)) {
    const fileStat = await stat(filePath);
    fileMetadata.push(`${filePath}:${fileStat.mtimeMs}`);
  }

  return createHash("sha256")
    .update(fileMetadata.sort().join("\n"))
    .digest("hex");
}

export async function buildRepoMap(
  repoPath: string,
  opts: BuildRepoMapOptions = {},
): Promise<RepoMapResult> {
  const repoRoot = resolve(repoPath);
  const budget = opts.budget ?? 1000;
  const hash = await contentHash(repoRoot);
  const cacheKey = `${repoRoot}:${hash}`;

  if (opts.cache) {
    const cached = await opts.cache.get(cacheKey);

    if (cached !== null) {
      return {
        map: cached,
        tokenCount: roughTokenCount(cached),
        fromCache: true,
      };
    }
  }

  const graph = await buildDependencyGraph(repoRoot);
  const scores = scoreSymbols(graph);
  const map = trimTobudget(graph, scores, budget);
  const tokenCount = roughTokenCount(map);

  await opts.cache?.set(cacheKey, map, tokenCount);

  return {
    map,
    tokenCount,
    fromCache: false,
  };
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
      .descendantsOfType("interface_declaration")
      .map((node) => createSymbol(node, "class", language)),
    ...rootNode
      .descendantsOfType("type_alias_declaration")
      .map((node) => createSymbol(node, "class", language)),
    ...rootNode
      .descendantsOfType("function_declaration")
      .map((node) => createSymbol(node, "function", language)),
    ...rootNode
      .descendantsOfType("lexical_declaration")
      .flatMap((node) => extractTypeScriptArrowFunctions(node, language)),
    ...rootNode
      .descendantsOfType("method_definition")
      .map((node) => createSymbol(node, "method", language)),
  ].filter(isDefined);
}

function extractTypeScriptArrowFunctions(
  declaration: Node,
  language: "typescript" | "tsx",
): SymbolSignature[] {
  return declaration
    .descendantsOfType("variable_declarator")
    .map((declarator) => {
      const arrowFunction = declarator.childForFieldName("value");

      if (arrowFunction?.type !== "arrow_function") {
        return undefined;
      }

      const name = declarator.childForFieldName("name")?.text;

      if (!name) {
        return undefined;
      }

      return {
        kind: "function" as const,
        language,
        name,
        signature: arrowFunctionSignature(
          declaration,
          declarator,
          arrowFunction,
        ),
        startLine: declarator.startPosition.row + 1,
        endLine: declarator.endPosition.row + 1,
      };
    })
    .filter(isDefined);
}

function arrowFunctionSignature(
  declaration: Node,
  declarator: Node,
  arrowFunction: Node,
): string {
  const keyword = declaration.firstChild?.text ?? "const";
  const name = declarator.childForFieldName("name")?.text ?? "";
  const parameters =
    arrowFunction.childForFieldName("parameters")?.text ?? "()";
  const returnType = arrowFunction.childForFieldName("return_type")?.text ?? "";
  return compactWhitespace(
    `${keyword} ${name} = ${parameters}${returnType} =>`,
  );
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

function extractTypeScriptImports(
  filePath: string,
  rootNode: Node,
  language: "typescript" | "tsx",
): string[] {
  const importSpecifiers = [
    ...rootNode.descendantsOfType("import_statement"),
    ...rootNode.descendantsOfType("export_statement"),
  ]
    .map((node) => unquote(node.childForFieldName("source")?.text))
    .filter(isDefined);

  return unique(
    importSpecifiers.flatMap((specifier) => {
      if (specifier.startsWith(".")) {
        return resolveModuleCandidates(
          filePath,
          specifier,
          extensionsByLanguage[language],
        );
      }

      return resolveWorkspaceTypeScriptImport(filePath, specifier);
    }),
  );
}

function extractPythonImports(filePath: string, rootNode: Node): string[] {
  const importSpecifiers = rootNode
    .descendantsOfType("import_from_statement")
    .map((node) => node.childForFieldName("module_name")?.text)
    .filter((specifier): specifier is string =>
      Boolean(specifier?.startsWith(".")),
    );

  return unique(
    importSpecifiers.flatMap((specifier) =>
      resolvePythonModuleCandidates(filePath, specifier),
    ),
  );
}

function extractGoImports(filePath: string, rootNode: Node): string[] {
  const importSpecifiers = rootNode
    .descendantsOfType("import_spec")
    .map((node) => unquote(node.childForFieldName("path")?.text))
    .filter((specifier): specifier is string =>
      Boolean(specifier?.startsWith(".")),
    );

  return unique(
    importSpecifiers.flatMap((specifier) =>
      resolveModuleCandidates(filePath, specifier, extensionsByLanguage.go),
    ),
  );
}

function extractRustImports(filePath: string, rootNode: Node): string[] {
  const importSpecifiers = rootNode
    .descendantsOfType("use_declaration")
    .map((node) => node.childForFieldName("argument")?.text)
    .filter(isDefined);

  return unique(
    importSpecifiers.flatMap((specifier) =>
      resolveRustModuleCandidates(filePath, specifier),
    ),
  );
}

function resolveModuleCandidates(
  filePath: string,
  specifier: string,
  extensions: string[],
): string[] {
  const basePath = resolve(dirname(filePath), specifier);
  return resolvePathCandidates(basePath, extensions);
}

function resolvePythonModuleCandidates(
  filePath: string,
  specifier: string,
): string[] {
  const leadingDots = specifier.match(/^\.+/)?.[0].length ?? 0;
  const modulePath = specifier.slice(leadingDots).replaceAll(".", sep);
  let baseDirectory = dirname(filePath);

  for (let depth = 1; depth < leadingDots; depth += 1) {
    baseDirectory = dirname(baseDirectory);
  }

  const basePath = resolve(baseDirectory, modulePath);
  return resolvePathCandidates(basePath, extensionsByLanguage.python);
}

function resolveRustModuleCandidates(
  filePath: string,
  specifier: string,
): string[] {
  if (!/^(crate|self|super)::/.test(specifier)) {
    return [];
  }

  const segments = specifier.split("::");
  const prefix = segments.shift();
  let baseDirectories = [dirname(filePath)];

  if (prefix === "super") {
    baseDirectories = [dirname(dirname(filePath))];
  }

  if (prefix === "crate") {
    const repoRoot = findRepoRoot(dirname(filePath));
    baseDirectories = [repoRoot, join(repoRoot, "src")];
  }

  for (const baseDirectory of baseDirectories) {
    for (let length = segments.length; length > 0; length -= 1) {
      const candidatePath = resolve(
        baseDirectory,
        ...segments.slice(0, length),
      );
      const matches = resolvePathCandidates(
        candidatePath,
        extensionsByLanguage.rust,
      );

      if (matches.length > 0) {
        return matches;
      }
    }
  }

  return [];
}

function resolveWorkspaceTypeScriptImport(
  filePath: string,
  specifier: string,
): string[] {
  if (!specifier.startsWith("@iquantum/")) {
    return [];
  }

  const [packageName, ...subpathSegments] = specifier
    .slice("@iquantum/".length)
    .split("/");
  const repoRoot = findRepoRoot(dirname(filePath));

  if (!packageName) {
    return [];
  }

  const basePath =
    subpathSegments.length === 0
      ? join(repoRoot, "packages", packageName, "src", "index")
      : join(repoRoot, "packages", packageName, "src", ...subpathSegments);

  return resolvePathCandidates(basePath, extensionsByLanguage.typescript);
}

function resolvePathCandidates(
  basePath: string,
  extensions: string[],
): string[] {
  const candidates = [
    basePath,
    ...extensions.map((extension) => `${basePath}${extension}`),
    ...extensions.map((extension) => join(basePath, `index${extension}`)),
    ...extensions.map((extension) => join(basePath, `mod${extension}`)),
  ];

  return candidates.filter((candidate) => existsSync(candidate));
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

function unquote(value: string | undefined): string | undefined {
  return value?.slice(1, -1);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function symbolKey(filePath: string, symbolName: string): string {
  return `${filePath}:${symbolName}`;
}

function roughTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function commonPathPrefix(paths: string[]): string | undefined {
  if (paths.length === 0) {
    return undefined;
  }

  const [firstPath, ...restPaths] = paths.map((path) =>
    dirname(path).split(sep),
  );
  const sharedSegments: string[] = [];

  if (!firstPath) {
    return undefined;
  }

  for (const [index, segment] of firstPath.entries()) {
    if (restPaths.every((path) => path[index] === segment)) {
      sharedSegments.push(segment);
      continue;
    }

    break;
  }

  return sharedSegments.length === 0
    ? undefined
    : sharedSegments.join(sep) || sep;
}

function compactDisplayPath(path: string): string {
  if (path.startsWith(`packages${sep}`)) {
    return path.slice(`packages${sep}`.length);
  }

  if (path.startsWith(`iquantum-`)) {
    return path.slice("iquantum-".length);
  }

  return path;
}

function normalizeScores(scores: Map<string, number>): Map<string, number> {
  const values = [...scores.values()];
  const min = Math.min(...values);
  const max = Math.max(...values);

  if (max === min) {
    return new Map([...scores.keys()].map((key) => [key, 1]));
  }

  return new Map(
    [...scores.entries()].map(([key, value]) => [
      key,
      (value - min) / (max - min),
    ]),
  );
}

function roundRobinByFile<T extends { filePath: string }>(items: T[]): T[] {
  const queues = new Map<string, T[]>();

  for (const item of items) {
    const queue = queues.get(item.filePath) ?? [];
    queue.push(item);
    queues.set(item.filePath, queue);
  }

  const ordered: T[] = [];

  while ([...queues.values()].some((queue) => queue.length > 0)) {
    for (const queue of queues.values()) {
      const item = queue.shift();

      if (item) {
        ordered.push(item);
      }
    }
  }

  return ordered;
}

function reserveNamedSymbols<T extends { symbol: SymbolSignature }>(
  items: T[],
  names: string[],
): T[] {
  return names
    .map((name) => items.find((item) => item.symbol.name === name))
    .filter((item): item is T => item !== undefined);
}

async function parseSource(
  filePath: string,
  source: string,
): Promise<{ language: SupportedLanguage; rootNode: Node } | undefined> {
  const language = detectLanguage(filePath);

  if (!language) {
    return undefined;
  }

  await ensureParserInitialized();

  const parser = new Parser();
  parser.setLanguage(await loadLanguage(language));

  try {
    const tree = parser.parse(source);

    if (!tree) {
      return undefined;
    }

    return {
      language,
      rootNode: tree.rootNode,
    };
  } finally {
    parser.delete();
  }
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

async function loadGitignore(repoRoot: string) {
  const matcher = ignore();
  const gitignorePath = join(repoRoot, ".gitignore");

  try {
    await access(gitignorePath);
    matcher.add(await readFile(gitignorePath, "utf8"));
  } catch {
    // No root .gitignore is a valid repository state.
  }

  return matcher;
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function isTestFile(path: string): boolean {
  return /\.(test|spec)\.[^.]+$/.test(path);
}

function findRepoRoot(startPath: string): string {
  let currentPath = startPath;

  while (true) {
    if (existsSync(join(currentPath, ".git"))) {
      return currentPath;
    }

    const parentPath = dirname(currentPath);

    if (parentPath === currentPath) {
      return startPath;
    }

    currentPath = parentPath;
  }
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const item = items[currentIndex];

      if (item === undefined) {
        continue;
      }

      results[currentIndex] = await mapper(item);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );

  return results;
}
