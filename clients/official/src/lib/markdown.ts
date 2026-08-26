import DOMPurify from 'dompurify'
import { marked, Renderer, type Tokens } from 'marked'

const MARKDOWN_SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    'a', 'script', 'style', 'iframe', 'object', 'embed', 'img', 'picture', 'source',
    'audio', 'video', 'track', 'svg', 'math', 'form', 'input', 'textarea',
    'select', 'option', 'link', 'meta',
  ],
  FORBID_ATTR: ['href', 'src', 'style', 'srcset', 'ping', 'formaction', 'xlink:href'],
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const renderer = new Renderer()

renderer.html = ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text)

renderer.code = ({ text, lang }: Tokens.Code) => {
  const language = lang?.trim().split(/\s+/, 1)[0] || 'code'
  return `<div class="code-block-wrap"><div class="code-block-header"><span class="code-lang">${escapeHtml(language)}</span><button class="code-copy-btn markdown-copy-action" type="button" aria-label="复制代码">复制</button></div><pre class="code-block-pre"><code>${escapeHtml(text)}</code></pre></div>`
}

renderer.link = function ({ href, tokens }: Tokens.Link) {
  const target = escapeHtml(href)
  const label = this.parser.parseInline(tokens)
  return `<button class="markdown-copy-link markdown-copy-action" type="button" data-copy-target="${target}" aria-label="复制链接：${target}" title="点击复制链接">${label}<span class="markdown-copy-hint" aria-live="polite">复制链接</span></button>`
}

renderer.image = ({ text }: Tokens.Image) => {
  const label = escapeHtml(text.trim() || '未命名图片')
  return `<span class="markdown-image-placeholder" role="note">图片：${label}</span>`
}

/**
 * Produces the client-only Markdown structure before the final DOM sanitizer.
 * Exported so the no-navigation/no-resource policy can be tested without a DOM.
 */
export function renderClientMarkdownStructure(source: string): string {
  return marked.parse(source || '', {
    async: false,
    breaks: true,
    gfm: true,
    renderer,
  }) as string
}

export function renderClientMarkdown(source: string): string {
  return DOMPurify.sanitize(renderClientMarkdownStructure(source), MARKDOWN_SANITIZE_CONFIG)
}
