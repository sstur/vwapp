/**
 * VW message-center bodies sometimes contain HTML (links, paragraphs). We have
 * no HTML renderer, so reduce it to readable plain text for both the list
 * preview and the detail view.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Single-line preview: plain text with all whitespace collapsed to spaces. */
export function previewText(html: string): string {
  return htmlToText(html).replace(/\s+/g, " ").trim();
}
