// #265: synthetic counterpart of the 5,767-character Cloudflare 520 incident.
// Keep the useful explanation after the stylesheet to catch prefix-only truncation.
export const PROVIDER_ERROR_HTML = `<html><head><style>${"/* upstream error page styling */\n".repeat(165)}</style></head>
<body>520: Web server is returning an unknown error
Upstream connection error. Diagnostic tail: 原文保留。</body></html>`;
