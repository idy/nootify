/** Names are the provider's own fields, not inferred or verified legal identities. */
export function recipientDisplayName(user: { name: string; nickname?: string }): string {
  const name = user.name.trim(); const nickname = user.nickname?.trim();
  if (!name) return nickname ?? '';
  if (!nickname || nickname === name) return name;
  if (name.startsWith(`${nickname}（`) || name.startsWith(`${nickname} (`) || name.startsWith(`${nickname}(`)) return name;
  return `${nickname}（${name}）`;
}
/** Feishu profile images use its image CDN; reject arbitrary external and local addresses. */
export function larkAvatarURL(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 4096 || value !== value.trim()) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname.endsWith('.feishucdn.com') && !url.username && !url.password && !url.port) return value;
  } catch { /* Missing or malformed profile images use the initial fallback. */ }
}
