export class CoreFailureSupervisor {
  failed = false;
  private stopping = false;
  private exited = false;
  private complete!: () => void;
  readonly completion = new Promise<void>(resolve => { this.complete = resolve; });
  constructor(private readonly stop: () => Promise<void>, private readonly exit: (code: number) => void = code => { process.exit(code); },
    private readonly report: (error: unknown) => void = error => console.error('Service shutdown failed:', error), private readonly timeout = 10000) {}

  beginShutdown(): void { this.stopping = true; }
  observe(record: Record<string, unknown>): void {
    if (this.stopping || this.failed || record.source !== 'providers' || record.status !== 'core_stopped') return;
    this.failed = true;
    const finish = () => {
      if (this.exited) return;
      this.exited = true; this.complete(); this.exit(1);
    };
    // A broken cleanup must not leave a healthy-looking parent running forever.
    const timer = setTimeout(finish, this.timeout).unref();
    void Promise.resolve().then(this.stop).catch(this.report).finally(() => { clearTimeout(timer); finish(); });
  }
}
