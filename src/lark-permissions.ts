import QRCode from 'qrcode';
import type { LarkPermission } from './lark-metadata.js';
import { HttpError } from './types.js';

export interface LarkPermissionHelp extends LarkPermission { url: string; qr: string }
export class LarkPermissionRequiredError extends HttpError {
  constructor(readonly permission: LarkPermissionHelp) { super(403, 'Feishu application permissions or contact access range are required'); }
}
/** No external QR service receives the application ID or permission URL. */
async function permissionHelp(appId: string, permission: LarkPermission, allowed: RegExp): Promise<LarkPermissionHelp> {
  const scopes = permission.scopes.filter(scope => allowed.test(scope));
  let target: string | undefined;
  if (permission?.url) {
    try {
      const url = new URL(permission.url);
      if (url.protocol === 'https:' && url.hostname === 'open.feishu.cn' && !url.username && !url.password && !url.port && url.pathname === `/app/${appId}/auth`) target = permission.url;
    } catch { /* Use the official console below instead of untrusted text. */ }
  }
  if (!target) {
    const url = new URL(/^cli_[a-f0-9]{16}$/i.test(appId) ? `https://open.feishu.cn/app/${appId}/auth` : 'https://open.feishu.cn/app');
    if (scopes.length && url.pathname.endsWith('/auth')) { url.searchParams.set('q', scopes.join(',')); url.searchParams.set('op_from', 'openapi'); }
    target = url.href;
  }
  return { url: target, scopes, qr: await QRCode.toDataURL(target, { width: 184, margin: 3, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#ffffff' } }) };
}
export function larkPermissionHelp(appId: string, permission?: LarkPermission): Promise<LarkPermissionHelp> {
  return permissionHelp(appId, permission ?? { scopes: ['contact:contact.base:readonly', 'contact:user.base:readonly'] }, /^contact:[a-z0-9_.]+(?::[a-z0-9_.]+)?$/);
}
export function larkMessagingPermissionHelp(appId: string, scopes: string[]): Promise<LarkPermissionHelp> {
  return permissionHelp(appId, { scopes }, /^im:[a-z0-9_.]+(?::[a-z0-9_.]+)?$/);
}
