import { HttpError, identifier, object } from './types.js';

/** Provider-owned identity plus opaque return-route context, preserved through relays. */
export interface ProviderMessageRef { origin_node_id: string; provider_id: string; message_id: string; [key: string]: unknown }

export function parseMessageRef(value: unknown): ProviderMessageRef {
  const fields = object(value);
  for (const key of ['origin_node_id', 'provider_id', 'message_id']) identifier(fields[key], key);
  return fields as ProviderMessageRef;
}
export function encodeMessageRef(ref: ProviderMessageRef): string { return Buffer.from(JSON.stringify(ref)).toString('base64url'); }
export function decodeMessageRef(value: string): ProviderMessageRef {
  if (value.length > 12000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new HttpError(400, 'Invalid message reference');
  let ref: unknown;
  try { ref = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw new HttpError(400, 'Invalid message reference'); }
  return parseMessageRef(ref);
}
