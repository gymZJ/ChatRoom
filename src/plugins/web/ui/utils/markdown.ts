import MarkdownIt from "markdown-it";
import { highlightSource } from "../syntax-highlight.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
  highlight(source, language) {
    const normalized = language.trim().toLowerCase();
    const highlighted = highlightSource(source, {
      language: normalized || null,
    });
    const languageClass = normalized
      ? " language-" + normalized.replace(/[^a-z0-9_-]/g, "")
      : "";

    return highlighted !== null
      ? '<pre class="markdown-code-block"><code class="hljs' +
          languageClass +
          '">' +
          highlighted +
          "</code></pre>"
      : '<pre class="markdown-code-block"><code' +
          languageClass +
          ">" +
          escapeHtml(source) +
          "</code></pre>";
  },
});

const defaultLinkOpen =
  markdown.renderer.rules.link_open ??
  ((tokens, index, options, _env, self) =>
    self.renderToken(tokens, index, options));

markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]!;
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, index, options, env, self);
};

export function renderMarkdown(text: string): string {
  return markdown.render(text);
}
