import assert from 'node:assert/strict'
import { renderClientMarkdownStructure } from '../src/lib/markdown.ts'

const rendered = renderClientMarkdownStructure(`
# Daily news

[Read more](https://example.com/story?q=alu&from=dock)

![tracking pixel](https://tracker.example/pixel.png)

<script>globalThis.compromised = true</script>
<img src="https://tracker.example/raw.png" onerror="globalThis.compromised = true">
<a href="https://example.com/escape">raw link</a>

\`\`\`html
</code><img src="https://tracker.example/code.png">
\`\`\`
`)

assert.match(rendered, /class="markdown-copy-link markdown-copy-action"/)
assert.match(rendered, /data-copy-target="https:\/\/example\.com\/story\?q=alu&amp;from=dock"/)
assert.match(rendered, />Read more<span class="markdown-copy-hint"/)
assert.match(rendered, /class="markdown-image-placeholder"[^>]*>图片：tracking pixel<\/span>/)
assert.doesNotMatch(rendered, /<a(?:\s|>)/i)
assert.doesNotMatch(rendered, /<img(?:\s|>)/i)
assert.doesNotMatch(rendered, /<script(?:\s|>)/i)
assert.doesNotMatch(rendered, /<[a-z][^>]*\shref=/i)
assert.doesNotMatch(rendered, /<[a-z][^>]*\ssrc=/i)
assert.match(rendered, /&lt;script&gt;globalThis\.compromised/)
assert.match(rendered, /&lt;\/code&gt;&lt;img src=&quot;https:\/\/tracker\.example\/code\.png&quot;&gt;/)

const dangerousLink = renderClientMarkdownStructure('[copy me](javascript:alert(1))')
assert.doesNotMatch(dangerousLink, /<a(?:\s|>)/i)
assert.doesNotMatch(dangerousLink, /<[a-z][^>]*\shref=/i)
assert.match(dangerousLink, /data-copy-target="javascript:alert\(1\)"/)

const relativeResources = renderClientMarkdownStructure('[guide](docs/guide.md) ![diagram](images/diagram.png)')
assert.match(relativeResources, /data-copy-target="docs\/guide\.md"/)
assert.match(relativeResources, />图片：diagram<\/span>/)
assert.doesNotMatch(relativeResources, /images\/diagram\.png/)

console.log('markdown policy tests passed')
