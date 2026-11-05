export interface TailnetStatus { names: string[]; address?: string; owner?: string }
export interface TailnetProbe { status(): Promise<unknown>; whois(ip: string): Promise<unknown> }

/** This node's own names and addresses, its IPv4 address for listening, and the owning login. */
export function parseTailnet(status: unknown): TailnetStatus | undefined {
  const data = status as { BackendState?: string; Self?: { DNSName?: unknown; TailscaleIPs?: unknown; UserID?: unknown }; User?: Record<string, { LoginName?: unknown }> } | undefined;
  if (data?.BackendState !== 'Running' || !data.Self) return;
  const names = new Set<string>();
  if (typeof data.Self.DNSName === 'string' && data.Self.DNSName) {
    const fqdn = data.Self.DNSName.replace(/\.$/, '').toLowerCase();
    names.add(fqdn); names.add(fqdn.split('.')[0]);
  }
  const ips = Array.isArray(data.Self.TailscaleIPs) ? data.Self.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string') : [];
  for (const ip of ips) names.add(ip.includes(':') ? `[${ip.toLowerCase()}]` : ip);
  const address = ips.find(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  const owner = data.User?.[String(data.Self.UserID)]?.LoginName;
  return { names: [...names], ...(address ? { address } : {}), ...(typeof owner === 'string' ? { owner } : {}) };
}
export function parseWhois(value: unknown): string | undefined {
  const identity = value as { Node?: { Tags?: unknown }; UserProfile?: { LoginName?: unknown } } | undefined;
  // A tagged node acts as its tags, not as the user who originally enrolled it.
  if (Array.isArray(identity?.Node?.Tags) && identity.Node.Tags.length) return;
  const login = identity?.UserProfile?.LoginName;
  return typeof login === 'string' && login ? login : undefined;
}
/**
 * Admits requests that arrive on this node's Tailscale address from an allowed user's device.
 * Identity comes from Tailscale's own peer lookup of the connecting address, never from headers.
 */
export class TailnetAccess {
  private status?: TailnetStatus;
  private checked = 0;
  private pending?: Promise<void>;
  private listening?: string;
  private readonly identities = new Map<string, { login: string; until: number }>();
  constructor(private readonly port: number, private readonly options: { users?: string[]; probe: TailnetProbe; ttl?: number }) {}
  private get probe(): TailnetProbe { return this.options.probe; }
  private get ttl(): number { return this.options.ttl ?? 60_000; }
  async current(): Promise<TailnetStatus | undefined> {
    if (Date.now() - this.checked >= this.ttl) {
      this.pending ??= this.probe.status()
        .then(result => { this.observe(result); }, () => { this.observe(undefined); })
        .finally(() => { this.checked = Date.now(); this.pending = undefined; });
      await this.pending;
    }
    return this.status;
  }
  /** Refresh account/address and discard peer identities when this machine changes tailnets. */
  observe(value: unknown): TailnetStatus | undefined {
    const next = parseTailnet(value);
    if (next?.owner !== this.status?.owner || next?.address !== this.status?.address) this.identities.clear();
    this.status = next; this.checked = Date.now();
    return next;
  }
  /** Publish a node snapshot and its entry-point readiness together. */
  publish(value: unknown, listening: boolean): TailnetStatus | undefined {
    const status = this.observe(value);
    this.setListening(listening ? status?.address : undefined);
    return status;
  }
  /** Records an active entry point so pages only advertise a ready address. */
  setListening(address: string | undefined): void { this.listening = address; }
  url(): string | undefined { return this.listening ? `http://${this.listening}${this.port === 80 ? '' : `:${this.port}`}/` : undefined; }
  private async login(ip: string): Promise<string | undefined> {
    const cached = this.identities.get(ip);
    if (cached && cached.until > Date.now()) return cached.login;
    let login: string | undefined;
    try { login = parseWhois(await this.probe.whois(ip)); } catch { login = undefined; }
    // Failed lookups are not cached, so a briefly unavailable embedded node does not lock a device out.
    if (login) {
      this.identities.set(ip, { login, until: Date.now() + this.ttl });
      if (this.identities.size > 256) this.identities.delete(this.identities.keys().next().value!);
    }
    return login;
  }
  /** Returns a rejection reason, or undefined when the request may proceed. */
  async authorize(host: string, remoteAddress: string | undefined): Promise<string | undefined> {
    let hostname: string;
    try { hostname = new URL(`http://${host}`).hostname.toLowerCase(); } catch { return 'Invalid Host header'; }
    // Browsers send the name they connected to, so other site names here indicate DNS rebinding.
    const status = await this.current();
    if (!status?.names.includes(hostname)) return 'Use the Nootify device\'s Tailscale address';
    const ip = remoteAddress?.replace(/^::ffff:/, '');
    if (!ip) return 'Unknown peer address';
    const allowed = this.options.users?.length ? this.options.users : status.owner ? [status.owner] : [];
    const login = await this.login(ip);
    if (!login || !allowed.includes(login)) return 'This Tailscale identity is not allowed';
  }
}
