/** Match legacy API rows to the same content displayed by Android, once only.
 * UI dates can be campaign-update dates rather than the old API creation date.
 * Never merge two distinct Android message IDs merely because text repeats.
 */
function plain(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/<br\s*\/?\s*>|<\/p>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function legacyInboxMatch<
  T extends {
    messageId: string;
    title: string;
    body?: string | null | undefined;
  },
>(
  existing: T[],
  incoming: { id: string; title: string; body: string | null },
): T | undefined {
  if (!incoming.id.startsWith("android:")) return undefined;
  const matches = existing.filter(
    (row) =>
      !row.messageId.startsWith("android:") &&
      plain(row.title) === plain(incoming.title) &&
      plain(row.body) === plain(incoming.body),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
