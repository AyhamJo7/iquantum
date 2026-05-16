import { marked } from "marked";

const ANSI_BOLD = "\u001b[1m";
const ANSI_BOLD_END = "\u001b[22m";
const ANSI_CYAN = "\u001b[36m";
const ANSI_RESET_COLOR = "\u001b[39m";

const renderCache = new Map<string, string>();
const RENDER_CACHE_MAX = 500;

export function renderMarkdownToAnsi(markdown: string): string {
  const cached = renderCache.get(markdown);

  if (cached !== undefined) {
    return cached;
  }

  const result = renderMarkdownUncached(markdown);

  if (renderCache.size >= RENDER_CACHE_MAX) {
    renderCache.delete(renderCache.keys().next().value as string);
  }

  renderCache.set(markdown, result);
  return result;
}

function renderMarkdownUncached(markdown: string): string {
  const html = marked.parse(markdown, { async: false }) as string;

  return decodeEntities(
    html
      .replaceAll(
        /<pre><code(?: class="[^"]*")?>([\s\S]*?)<\/code><\/pre>/g,
        `${ANSI_CYAN}$1${ANSI_RESET_COLOR}`,
      )
      .replaceAll(
        /<strong>([\s\S]*?)<\/strong>/g,
        `${ANSI_BOLD}$1${ANSI_BOLD_END}`,
      )
      .replaceAll(
        /<code>([\s\S]*?)<\/code>/g,
        `${ANSI_CYAN}$1${ANSI_RESET_COLOR}`,
      )
      .replaceAll(
        /<h[1-6]>([\s\S]*?)<\/h[1-6]>/g,
        `${ANSI_BOLD}$1${ANSI_BOLD_END}\n`,
      )
      .replaceAll(/<li>([\s\S]*?)<\/li>/g, "• $1\n")
      .replaceAll(/<\/p>|<\/ul>|<\/ol>|<br\s*\/?>/g, "\n")
      .replaceAll(/<[^>]+>/g, "")
      .replaceAll(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function decodeEntities(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}
