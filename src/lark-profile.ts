/** Names are the provider's own fields, not inferred or verified legal identities. */
export function recipientDisplayName(user: { name: string; nickname?: string }): string {
  const name = user.name.trim(); const nickname = user.nickname?.trim();
  if (!name) return nickname ?? '';
  if (!nickname || nickname === name) return name;
  if (name.startsWith(`${nickname}（`) || name.startsWith(`${nickname} (`) || name.startsWith(`${nickname}(`)) return name;
  return `${nickname}（${name}）`;
}
/** Keep cached identities/order while applying newer streamed fields. */
export function mergeRecipients<T extends { open_id: string }>(cached: readonly T[], incoming: readonly T[]): T[] {
  const users = new Map(cached.map(user => [user.open_id, user]));
  for (const user of incoming) { const previous = users.get(user.open_id); users.set(user.open_id, previous ? { ...previous, ...user } : user); }
  return [...users.values()];
}
/** Feishu profile images use its image CDN; reject arbitrary external and local addresses. */
export function larkAvatarURL(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 4096 || value !== value.trim()) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname.endsWith('.feishucdn.com') && !url.username && !url.password && !url.port) return value;
  } catch { /* Missing or malformed profile images use the initial fallback. */ }
}
