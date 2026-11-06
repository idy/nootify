import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import type { Credentials, LarkApi } from './lark-metadata.js';
import { larkMessagingPermissionHelp, type LarkPermissionHelp } from './lark-permissions.js';
import { HttpError } from './types.js';

/** The app-registration protocol used by the official larksuite/cli. No CLI installation or shared app secret is needed. */
export const LARK_REGISTRATION_URL = 'https://accounts.feishu.cn/oauth/v1/app/registration';
const REQUEST_TIMEOUT = 15_000;
const APP_ID = /^cli_[a-f0-9]{16}$/i;
const OPEN_ID = /^ou_[A-Za-z0-9]+$/;

export interface LarkSetup {
  app_id: string;
  status: 'ready' | 'permissions-required' | 'unavailable';
  missing: string[];
  mention_only: boolean;
  permission?: LarkPermissionHelp;
}
export interface LarkRegistrationPage {
  status: 'idle' | 'starting' | 'waiting' | 'connecting' | 'complete' | 'failed';
  url?: string;
  qr?: string;
  expires_at?: string;
  app_id?: string;
  error?: string;
  setup?: LarkSetup;
}
export interface LarkRegistrationResult { credentials: Credentials; recipient?: string }
export interface LarkRegistrationOptions {
  fetch?: typeof fetch;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}
interface RegistrationReply {
  device_code?: string; user_code?: string; expire_in?: number; expires_in?: number; interval?: number;
  client_id?: string; client_secret?: string; error?: string;
  user_info?: { open_id?: string; tenant_brand?: string };
}

const requirements = [
  ['im:chat:create', 'im:chat'],
  ['im:chat.announcement:read', 'im:chat:readonly', 'im:chat'],
  ['im:chat.announcement:write_only', 'im:chat'],
  ['im:message:send_as_bot', 'im:message'],
  ['im:message.group_msg', 'im:message.group_msg:readonly', 'im:message.group_msg.include_bot:readonly'],
];
/** Inspect only this app's own granted bot scopes; never enumerate the owner's other applications or contacts. */
export async function inspectLarkSetup(api: LarkApi, signal?: AbortSignal): Promise<LarkSetup> {
  try {
    const data = await api.request<{ app?: { scopes?: { scope?: string; token_types?: string[] }[] } }>('GET',
      `/open-apis/application/v6/applications/${encodeURIComponent(api.appId)}?lang=zh_cn&user_id_type=open_id`, undefined,
      AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(REQUEST_TIMEOUT)]));
    if (!Array.isArray(data.app?.scopes)) throw new Error('missing_scopes');
    const scopes = new Set(data.app.scopes.filter(item => !item.token_types || item.token_types.includes('tenant')).map(item => item.scope));
    const missing = requirements.filter(alternatives => !alternatives.some(scope => scopes.has(scope))).map(alternatives => alternatives[0]!);
    const mention_only = !requirements.at(-1)!.some(scope => scopes.has(scope));
    return { app_id: api.appId, status: missing.length ? 'permissions-required' : 'ready', missing, mention_only,
      ...(missing.length ? { permission: await larkMessagingPermissionHelp(api.appId, missing) } : {}) };
  } catch {
    signal?.throwIfAborted();
    return { app_id: api.appId, status: 'unavailable', missing: [], mention_only: false,
      permission: await larkMessagingPermissionHelp(api.appId, requirements.map(alternatives => alternatives[0]!)) };
  }
}

class RegistrationFailure extends Error {}
/** A single, explicitly started registration. Device codes and returned secrets never enter the page state or reports. */
export class LarkRegistration {
  private flow: LarkRegistrationPage = { status: 'idle' };
  private controller?: AbortController;
  private running?: Promise<void>;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  constructor(private readonly accept: (result: LarkRegistrationResult, signal: AbortSignal) => Promise<LarkSetup>,
    private readonly report: (record: Record<string, unknown>) => void = () => {}, options: LarkRegistrationOptions = {}) {
    this.fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? (async (milliseconds, signal) => { await delay(milliseconds, undefined, { signal }); });
  }
  page(): LarkRegistrationPage { return structuredClone(this.flow); }
  start(): LarkRegistrationPage {
    if (['starting', 'waiting', 'connecting'].includes(this.flow.status)) return this.page();
    const controller = new AbortController();
    this.controller = controller;
    this.flow = { status: 'starting' };
    this.running = this.run(controller.signal).catch(error => {
      if (controller !== this.controller || controller.signal.aborted) return;
      this.flow = { status: 'failed', error: error instanceof RegistrationFailure ? error.message : 'registration_unavailable' };
      this.report({ source: 'lark', status: 'lark_registration_failed', reason: this.flow.error });
    });
    return this.page();
  }
  cancel(): LarkRegistrationPage {
    // Saving is a local commit, not an outstanding scan. A cancellation must never claim to undo saved credentials.
    if (this.flow.status === 'connecting') throw new HttpError(409, 'Feishu configuration is being saved; wait for it to finish');
    this.controller?.abort(); this.controller = undefined;
    this.flow = { status: 'idle' };
    return this.page();
  }
  private async post(fields: Record<string, string>, signal: AbortSignal): Promise<RegistrationReply> {
    const response = await this.fetch(LARK_REGISTRATION_URL, { method: 'POST', redirect: 'error',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields),
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)]) });
    const reply: unknown = await response.json();
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new Error('unexpected_reply');
    if (!response.ok && !(reply as RegistrationReply).error) throw new Error('request_failed');
    return reply as RegistrationReply;
  }
  private async run(signal: AbortSignal): Promise<void> {
    const device = await this.post({ action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id tenant_brand' }, signal);
    signal.throwIfAborted();
    if (device.error || typeof device.device_code !== 'string' || !device.device_code || typeof device.user_code !== 'string' || !/^[A-Za-z0-9-]{4,64}$/.test(device.user_code)) {
      throw new RegistrationFailure('registration_unavailable');
    }
    const lifetime = device.expire_in ?? device.expires_in;
    const expires = this.now() + (typeof lifetime === 'number' && Number.isFinite(lifetime) && lifetime > 0 ? Math.min(lifetime, 3600) : 600) * 1000;
    let interval = typeof device.interval === 'number' && Number.isFinite(device.interval) && device.interval > 0 ? Math.min(device.interval, 60) : 5;
    const url = new URL('https://open.feishu.cn/page/cli'); url.searchParams.set('user_code', device.user_code);
    const qr = await QRCode.toDataURL(url.href, { width: 216, margin: 3, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#ffffff' } });
    signal.throwIfAborted();
    this.flow = { status: 'waiting', url: url.href, qr, expires_at: new Date(expires).toISOString() };
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, expires - this.now()))]);
    for (;;) {
      let reply: RegistrationReply;
      try { reply = await this.post({ action: 'poll', device_code: device.device_code }, deadline); }
      catch {
        signal.throwIfAborted();
        if (deadline.aborted || this.now() >= expires) throw new RegistrationFailure('expired_token');
        interval = Math.min(interval + 1, 60);
        await this.pause(interval, deadline, signal); continue;
      }
      signal.throwIfAborted();
      if (deadline.aborted || this.now() >= expires) throw new RegistrationFailure('expired_token');
      if (reply.user_info?.tenant_brand && reply.user_info.tenant_brand !== 'feishu') throw new RegistrationFailure('unsupported_brand');
      if (!reply.error && reply.client_id && reply.client_secret) {
        if (typeof reply.client_id !== 'string' || !APP_ID.test(reply.client_id) || typeof reply.client_secret !== 'string' || reply.client_secret.length > 4096) throw new RegistrationFailure('invalid_credentials');
        this.flow = { status: 'connecting' };
        let setup: LarkSetup;
        try { setup = await this.accept({ credentials: { appId: reply.client_id, appSecret: reply.client_secret },
          ...(typeof reply.user_info?.open_id === 'string' && OPEN_ID.test(reply.user_info.open_id) ? { recipient: reply.user_info.open_id } : {}) }, signal); }
        catch { signal.throwIfAborted(); throw new RegistrationFailure('save_failed'); }
        signal.throwIfAborted();
        this.flow = { status: 'complete', app_id: reply.client_id, setup };
        this.report({ source: 'lark', status: 'lark_registration_complete' });
        return;
      }
      if (reply.error === 'access_denied') throw new RegistrationFailure('access_denied');
      if (reply.error === 'expired_token' || reply.error === 'invalid_grant') throw new RegistrationFailure('expired_token');
      if (reply.error === 'slow_down') interval = Math.min(interval + 5, 60);
      else if (reply.error && reply.error !== 'authorization_pending') throw new RegistrationFailure('registration_unavailable');
      await this.pause(interval, deadline, signal);
    }
  }
  private async pause(seconds: number, deadline: AbortSignal, signal: AbortSignal): Promise<void> {
    try { await this.wait(seconds * 1000, deadline); }
    catch { signal.throwIfAborted(); throw new RegistrationFailure('expired_token'); }
  }
  async stop(): Promise<void> { this.controller?.abort(); await this.running; }
}
