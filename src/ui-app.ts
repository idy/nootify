import type { LogEntry } from './events.js';
import type { PullRequest, PullSnapshot } from './github.js';
import type { ModuleStatus, PublicSession } from './types.js';

interface PullSummary { internal: number; upstream: number; running: boolean; lastSuccessAt?: string; error?: string }
interface Snapshot {
  time: string; modules: ModuleStatus[]; sessions: PublicSession[]; logs: LogEntry[];
  pulls?: PullSummary; access?: { tailnet_url?: string };
}
type View = 'logs' | 'sessions' | 'pulls-internal' | 'pulls-upstream';
interface Tone { label: string; tone: string }

const views: Record<View, { hash: string; group: string; title: string; section: string }> = {
  logs: { hash: '#/logs', group: '消息桥接', title: '运行日志', section: 'logs-view' },
  sessions: { hash: '#/sessions', group: '消息桥接', title: '路由会话', section: 'sessions-view' },
  'pulls-internal': { hash: '#/pulls/internal', group: 'GitHub', title: '我们仓库的 PR', section: 'pulls-view' },
  'pulls-upstream': { hash: '#/pulls/upstream', group: 'GitHub', title: '提交上游的 PR', section: 'pulls-view' },
};
const descriptions: Record<string, string> = {
  ready: '服务已启动', lark_ready: '飞书长连接已建立', lark_failed: '飞书连接失败',
  received: '服务收到飞书消息', socket_written: '已写入客户端，等待会话回执', input_accepted: '客户端已接受输入，等待会话回执',
  session_acknowledged: '会话已确认收到', replied: '回复已发回原飞书消息', reply_failed: '发送飞书回复失败',
  delivery_failed: '消息转发失败', ignored: '已跳过此消息', queue_full: '消息队列已满', registered: '本机会话已注册',
  bound: '已保存会话绑定', stopped: '监听已停止', connecting: '正在连接飞书', pin_failed: '绑定消息置顶失败',
  reconnecting: '飞书正在重连', reconnected: '飞书已重新连接', refresh_completed: 'GitHub PR 已刷新', refresh_failed: 'GitHub PR 刷新失败',
  tailnet_listening: 'Tailscale 访问已开启', tailnet_failed: 'Tailscale 监听失败', tailnet_unavailable: 'Tailscale 未运行，仅本机可访问',
};
const reasons: Record<string, string> = {
  session_not_local: '本机不存在该会话', session_archived: '会话已归档', session_offline: '本机会话未运行',
  archive_unknown: '无法确认归档状态', backend_unavailable: '客户端接口未配置或不可用', session_busy: '当前轮次已变化，本次未投递',
  missing_announcement: '群公告没有会话声明', ambiguous_announcement: '群公告有多个会话声明', unsupported_adapter: '尚未支持该客户端',
  sender_not_allowed: '发送者不在允许名单', duplicate: '重复消息', unsupported_message: '暂不处理此消息类型',
  host_mismatch: '会话位于另一台机器', invalid_content: '消息内容无效', delivery_failed: '投递失败',
};
const sourceNames: Record<string, string> = { host: '服务', sessions: '会话', lark: '飞书', pulls: 'GitHub' };
const categories: Record<string, Tone> = {
  received: { label: '已收件', tone: 'info' }, forwarded: { label: '待回执', tone: 'warn' },
  acknowledged: { label: '已确认', tone: 'ok' }, replied: { label: '已回复', tone: 'ok' },
  ignored: { label: '已忽略', tone: 'muted' }, error: { label: '异常', tone: 'error' }, system: { label: '系统', tone: 'muted' },
};
const outcomeTabs: [string, string][] = [['all', '全部'], ['forwarded', '待回执'], ['acknowledged', '已确认'], ['replied', '已回复'], ['ignored', '已忽略'], ['error', '异常']];
const pullTabs: [string, string][] = [['all', '全部'], ['attention', '需跟进'], ['draft', '草稿']];
const adapters: Record<string, string> = { 'claude-desktop': 'Claude Desktop', 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
const availability: Record<string, Tone> = {
  active: { label: '可投递', tone: 'ok' }, archived: { label: '已归档', tone: 'muted' }, offline: { label: '未运行', tone: 'warn' },
  unknown: { label: '未确认', tone: 'warn' }, missing: { label: '本机不存在', tone: 'muted' },
};
const reviews: Record<string, Tone> = {
  APPROVED: { label: '已批准', tone: 'ok' }, CHANGES_REQUESTED: { label: '需要修改', tone: 'error' }, REVIEW_REQUIRED: { label: '待审查', tone: 'warn' },
};
const moduleNames: Record<string, string> = { sessions: '会话', lark: '飞书', pulls: 'GitHub' };
const moduleStates: Record<string, Tone> = {
  ready: { label: '就绪', tone: 'ok' }, idle: { label: '等待刷新', tone: 'warn' }, refreshing: { label: '刷新中', tone: 'warn' },
  stale: { label: '刷新失败', tone: 'error' }, error: { label: '异常', tone: 'error' }, failed: { label: '异常', tone: 'error' },
  connecting: { label: '连接中', tone: 'warn' }, reconnecting: { label: '重连中', tone: 'warn' }, disabled: { label: '未启用', tone: 'muted' }, stopped: { label: '已停止', tone: 'muted' },
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
function chevron(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('class', 'chevron'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'm6 3.5 4.5 4.5L6 12.5');
  svg.append(path); return svg;
}
function viewFromHash(): View {
  for (const [view, meta] of Object.entries(views) as [View, (typeof views)[View]][]) if (location.hash === meta.hash) return view;
  return 'logs';
}
const isPullView = (view: View): view is 'pulls-internal' | 'pulls-upstream' => view.startsWith('pulls-');

const state = {
  view: viewFromHash(),
  snapshot: { time: '', modules: [], sessions: [], logs: [] } as Snapshot,
  pulls: undefined as PullSnapshot | undefined,
  pullsError: '',
  outcome: 'all', pullFilter: 'all', pullSort: 'asc' as 'asc' | 'desc',
  paused: false, loading: false, loadingPulls: false, connected: false,
  expanded: new Set<string>(),
  signatures: new Map<string, string>(),
};

const relative = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
function ago(value?: string): string {
  if (!value) return '—';
  const seconds = (Date.parse(value) - Date.now()) / 1000;
  if (!Number.isFinite(seconds)) return '—';
  if (Math.abs(seconds) < 45) return '刚刚';
  const units: [Intl.RelativeTimeFormatUnit, number][] = [['minute', 60], ['hour', 3600], ['day', 86400], ['month', 2592000], ['year', 31536000]];
  let [unit, size] = units[0];
  for (const [candidate, length] of units) if (Math.abs(seconds) >= length) [unit, size] = [candidate, length];
  return relative.format(Math.round(seconds / size), unit);
}
const clock = (value: string): string => new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
const fullTime = (value: string): string => new Date(value).toLocaleString('zh-CN', { hour12: false });
/** Re-render only when the visible content (or the minute used by relative times) changes. */
function changed(key: string, value: unknown): boolean {
  const signature = JSON.stringify([value, Math.floor(Date.now() / 30000)]);
  if (state.signatures.get(key) === signature) return false;
  state.signatures.set(key, signature); return true;
}
/** Replace list children while keeping keyboard focus on the same logical row. */
function replaceRows(container: HTMLElement, rows: Node[]): void {
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
  container.replaceChildren(...rows);
  if (focused) container.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus();
}
function renderTabs(id: string, tabs: [string, string, number][], selected: string, select: (value: string) => void): void {
  if (!changed(id, [tabs, selected])) return;
  const container = $(id);
  const focusedValue = container.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.value : undefined;
  container.replaceChildren(...tabs.map(([value, label, count]) => {
    const button = node('button'); button.type = 'button'; button.dataset.value = value;
    button.setAttribute('aria-pressed', String(value === selected));
    button.append(node('span', label), node('span', String(count), 'count'));
    button.addEventListener('click', () => select(value));
    return button;
  }));
  if (focusedValue) container.querySelector<HTMLElement>(`[data-value="${CSS.escape(focusedValue)}"]`)?.focus();
}
function sideBlock(primary: Tone, secondary?: string | Node[]): HTMLElement {
  const side = node('span', undefined, 'row-side');
  side.append(node('span', primary.label, `primary tone-${primary.tone}`));
  if (secondary !== undefined) {
    const line = node('span', undefined, 'secondary');
    if (typeof secondary === 'string') line.textContent = secondary; else line.append(...secondary);
    side.append(line);
  }
  return side;
}
function rowMain(title: string | Node[], meta: string): HTMLElement {
  const main = node('span', undefined, 'row-main');
  const heading = node('span', undefined, 'row-title');
  if (typeof title === 'string') heading.textContent = title; else heading.append(...title);
  heading.title = heading.textContent ?? '';
  const details = node('span', meta, 'row-meta'); details.title = meta;
  main.append(heading, details); return main;
}

// ---- Logs ----
function source(entry: LogEntry): string {
  return entry.source ?? (entry.status.startsWith('lark') || entry.chat_id ? 'lark' : entry.session_id ? 'sessions' : 'host');
}
function category(entry: LogEntry): string {
  if (entry.status === 'ignored') return 'ignored';
  if (entry.status === 'received') return 'received';
  if (entry.status === 'session_acknowledged') return 'acknowledged';
  if (entry.status === 'replied') return 'replied';
  if (entry.status === 'socket_written' || entry.status === 'input_accepted') return 'forwarded';
  if (entry.error || entry.status.includes('failed') || entry.status === 'queue_full') return 'error';
  return 'system';
}
const summary = (entry: LogEntry): string => (entry.reason && reasons[entry.reason]) || descriptions[entry.status] || entry.status;
function sessionLabel(entry: LogEntry): string | undefined {
  return entry.session_name ?? state.snapshot.sessions.find(session => session.session_id === entry.session_id)?.session_name ?? entry.session_id;
}
const logTitle = (entry: LogEntry): string => entry.preview && (entry.status === 'received' || entry.status === 'replied') ? entry.preview : summary(entry);
function logMeta(entry: LogEntry): string {
  const parts = [ago(entry.time), sourceNames[source(entry)] ?? source(entry)];
  if (logTitle(entry) !== summary(entry)) parts.push(summary(entry));
  if (entry.reason && !reasons[entry.reason]) parts.push(entry.reason);
  const session = sessionLabel(entry);
  if (session) parts.push(session);
  if (entry.error && category(entry) === 'error') parts.push(entry.error);
  if (entry.message_id) parts.push(entry.message_id.replace(/^om_/, '').slice(-10));
  return parts.join(' · ');
}
function filteredLogs(): LogEntry[] {
  const query = $<HTMLInputElement>('search').value.trim().toLocaleLowerCase();
  return state.snapshot.logs.filter(entry => (state.outcome === 'all' || category(entry) === state.outcome) &&
    (!query || [JSON.stringify(entry), sessionLabel(entry) ?? '', summary(entry)].join(' ').toLocaleLowerCase().includes(query)));
}
function logDetails(entry: LogEntry): HTMLElement {
  const box = node('div', undefined, 'details');
  const grid = node('dl', undefined, 'detail-grid');
  const fields: [string, string | undefined, boolean][] = [
    ['时间', fullTime(entry.time), false], ['事件', entry.status, true], ['会话', entry.session_id, true], ['会话名称', entry.session_name, false],
    ['群聊', entry.chat_id, true], ['消息 ID', entry.message_id, true], ['飞书用户', entry.sender_open_id, true], ['回复 ID', entry.reply_id, true],
    ['原因', entry.reason && reasons[entry.reason] ? `${reasons[entry.reason]}（${entry.reason}）` : entry.reason, false], ['错误', entry.error, false], ['消息内容', entry.preview, false],
  ];
  for (const [label, value, mono] of fields) if (value) grid.append(node('dt', label), node('dd', value, mono ? 'mono' : undefined));
  box.append(grid); return box;
}
function renderLogs(force = false): void {
  const counts: Record<string, number> = { all: state.snapshot.logs.length };
  for (const entry of state.snapshot.logs) counts[category(entry)] = (counts[category(entry)] ?? 0) + 1;
  renderTabs('outcome-tabs', outcomeTabs.map(([value, label]) => [value, label, counts[value] ?? 0]), state.outcome, value => {
    state.outcome = value; renderLogs(true);
  });
  $('logs-count').textContent = counts.forwarded ? String(counts.forwarded) : '';
  $('logs-count').title = counts.forwarded ? `${counts.forwarded} 条待回执` : '';
  if (state.paused && !force) return;
  const entries = filteredLogs();
  $('empty').hidden = entries.length > 0;
  if (!changed('logs', [entries, state.snapshot.sessions.map(session => [session.session_id, session.session_name]), [...state.expanded]]) && !force) return;
  replaceRows($('logs-table'), entries.map(entry => {
    const item = node('div', undefined, 'entry'); item.setAttribute('role', 'listitem');
    const open = state.expanded.has(entry.id);
    const row = node('button', undefined, 'row'); row.type = 'button'; row.dataset.key = entry.id;
    row.setAttribute('aria-expanded', String(open)); row.title = fullTime(entry.time);
    row.append(rowMain(logTitle(entry), logMeta(entry)), sideBlock(categories[category(entry)], clock(entry.time)), chevron());
    row.addEventListener('click', () => {
      if (state.expanded.has(entry.id)) state.expanded.delete(entry.id); else state.expanded.add(entry.id);
      renderLogs(true);
    });
    item.append(row); if (open) item.append(logDetails(entry));
    return item;
  }));
}

// ---- Routed sessions ----
function renderSessions(): void {
  const sessions = state.snapshot.sessions;
  $('session-count').textContent = sessions.length ? String(sessions.length) : '';
  $('no-sessions').hidden = sessions.length > 0;
  if (!changed('sessions', sessions)) return;
  replaceRows($('sessions-body'), sessions.map(session => {
    const item = node('div', undefined, 'entry'); item.setAttribute('role', 'listitem');
    const row = node('div', undefined, 'row');
    const meta = [adapters[session.adapter] ?? session.adapter, session.session_id, session.last_seen ? `最近查找 ${ago(session.last_seen)}` : undefined].filter(Boolean).join(' · ');
    const reason = session.last_result ? reasons[session.last_result] ?? descriptions[session.last_result] ?? session.last_result : undefined;
    row.append(rowMain(session.session_name, meta), sideBlock(availability[session.availability ?? 'unknown'] ?? availability.unknown, reason));
    item.append(row); return item;
  }));
}

// ---- Pull requests ----
function attention(pull: PullRequest): boolean {
  const stale = !pull.isDraft && Date.now() - Date.parse(pull.updatedAt) > 14 * 86_400_000;
  return pull.ci.failed > 0 || pull.reviewDecision === 'CHANGES_REQUESTED' || pull.mergeable === 'CONFLICTING' || stale;
}
function pullList(view: 'pulls-internal' | 'pulls-upstream'): PullRequest[] {
  return state.pulls?.[view === 'pulls-internal' ? 'internal' : 'upstream'] ?? [];
}
function ciSummary(pull: PullRequest): Node[] {
  const parts: Node[] = [];
  const add = (text: string, tone?: string) => { if (parts.length) parts.push(document.createTextNode(' ')); parts.push(node('span', text, tone ? `tone-${tone}` : undefined)); };
  if (!pull.ci.total) add('无 CI');
  else {
    add(`✓ ${pull.ci.passed}`, pull.ci.failed ? undefined : 'ok');
    if (pull.ci.failed) add(`✗ ${pull.ci.failed}`, 'error');
    if (pull.ci.pending) add(`◌ ${pull.ci.pending}`, 'warn');
  }
  if (pull.mergeable === 'CONFLICTING') { parts.push(document.createTextNode(' · ')); parts.push(node('span', '有冲突', 'tone-error')); }
  return parts;
}
function renderPulls(): void {
  const view = state.view;
  if (!isPullView(view)) return;
  const upstream = view === 'pulls-upstream';
  const data = state.pulls;
  const all = pullList(view);
  const counts = { all: all.length, attention: all.filter(attention).length, draft: all.filter(pull => pull.isDraft).length };
  renderTabs('pull-tabs', pullTabs.map(([value, label]) => [value, label, counts[value as keyof typeof counts]]), state.pullFilter, value => {
    state.pullFilter = value; renderPulls();
  });
  $('pull-sort').textContent = state.pullSort === 'asc' ? '最久未更新在前' : '最近更新在前';
  $('pull-title').textContent = upstream ? '我们提交给上游的 PR' : '提交到我们仓库的 PR';
  $('pull-sub').textContent = upstream ? '来自我们账号或 fork 的跨仓库 PR，仅 Open 与草稿' : '所有作者提交到我们账号与组织仓库的 PR，仅 Open 与草稿';
  const refresh = data?.refresh;
  const side = $('pull-side'); side.replaceChildren();
  side.append(node('div', refresh?.running ? '正在后台刷新…' : refresh?.lastSuccessAt ? `${ago(refresh.lastSuccessAt)}刷新` : '尚未刷新'),
    node('div', `${all.length} 个 PR`));
  const banner = $('pull-banner');
  const error = state.pullsError || refresh?.error;
  banner.hidden = !error;
  if (error) banner.textContent = `GitHub 刷新失败：${error}${refresh?.lastSuccessAt ? `。当前显示${ago(refresh.lastSuccessAt)}的数据。` : '。'}`;
  const query = $<HTMLInputElement>('pull-search').value.trim().toLocaleLowerCase();
  const direction = state.pullSort === 'asc' ? 1 : -1;
  const pulls = all.filter(pull => (state.pullFilter === 'all' || (state.pullFilter === 'draft' ? pull.isDraft : attention(pull))) &&
    (!query || [pull.title, pull.repository, pull.author, pull.headRepository ?? '', `#${pull.number}`].join(' ').toLocaleLowerCase().includes(query)))
    .sort((a, b) => direction * (Date.parse(a.updatedAt) - Date.parse(b.updatedAt)) || a.repository.localeCompare(b.repository) || a.number - b.number);
  const empty = $('pull-empty');
  empty.hidden = pulls.length > 0;
  if (!pulls.length) {
    const first = !refresh?.lastSuccessAt;
    $('pull-empty-title').textContent = !data ? '正在读取 PR 数据' : first && refresh?.running ? '正在首次从 GitHub 拉取' : first ? '还没有 GitHub 数据' : all.length ? '没有匹配的 PR' : '没有打开的 PR';
    $('pull-empty-detail').textContent = first ? '数据在后台刷新，完成后自动显示。' : all.length ? '换个筛选条件或搜索词。' : '刷新完成后，新的 Open PR 会出现在这里。';
  }
  const warnings = $<HTMLDetailsElement>('pull-warnings');
  warnings.hidden = !data?.warnings.length;
  if (changed('pull-warnings', data?.warnings)) {
    warnings.querySelector('summary')!.textContent = `数据范围与提示 · ${data?.warnings.length ?? 0} 条`;
    warnings.querySelector('ul')!.replaceChildren(...(data?.warnings ?? []).map(text => node('li', text)));
  }
  if (!changed('pull-rows', [view, pulls])) return;
  replaceRows($('pull-rows'), pulls.map(pull => {
    const item = node('div', undefined, 'entry'); item.setAttribute('role', 'listitem');
    const link = node('a', undefined, 'row'); link.href = pull.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.dataset.key = pull.url; link.title = `最后更新 ${fullTime(pull.updatedAt)}`;
    const title: Node[] = pull.isDraft ? [node('span', '草稿', 'tag'), document.createTextNode(pull.title)] : [document.createTextNode(pull.title)];
    const meta = [`${pull.repository}#${pull.number}`, pull.author, `${ago(pull.updatedAt)}更新`];
    if (upstream && pull.headRepository && pull.headRepository !== pull.repository) meta.push(`来自 ${pull.headRepository}`);
    link.append(rowMain(title, meta.join(' · ')), sideBlock(reviews[pull.reviewDecision] ?? { label: '暂无审查结论', tone: 'muted' }, ciSummary(pull)));
    item.append(link); return item;
  }));
}

// ---- Chrome, loading and events ----
function renderChrome(): void {
  const meta = views[state.view];
  $('crumb-group').textContent = meta.group; $('crumb-page').textContent = meta.title;
  document.title = `${meta.title} · Nootify`;
  for (const link of document.querySelectorAll<HTMLAnchorElement>('.nav-item')) {
    if (link.dataset.view === state.view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  for (const section of ['logs-view', 'sessions-view', 'pulls-view']) $(section).hidden = section !== meta.section;
  const pullSummary = state.snapshot.pulls;
  const internal = pullSummary?.internal ?? state.pulls?.internal.length;
  const upstream = pullSummary?.upstream ?? state.pulls?.upstream.length;
  $('internal-count').textContent = internal === undefined ? '' : String(internal);
  $('upstream-count').textContent = upstream === undefined ? '' : String(upstream);
  const busy = isPullView(state.view) && Boolean(pullSummary?.running || state.pulls?.refresh.running);
  $('refresh').classList.toggle('busy', busy);
  const label = isPullView(state.view) ? '在后台刷新 GitHub 数据' : '立即刷新';
  $('refresh').title = label; $('refresh').setAttribute('aria-label', label);
  $('updated').textContent = isPullView(state.view)
    ? (busy ? '后台刷新中' : state.pulls?.refresh.lastSuccessAt ? `${ago(state.pulls.refresh.lastSuccessAt)}刷新` : '')
    : state.snapshot.time ? `更新于 ${clock(state.snapshot.time)}` : '';
  if (changed('modules', state.snapshot.modules)) {
    $('modules').replaceChildren(...state.snapshot.modules.map(module => {
      const status = moduleStates[module.status] ?? { label: module.status, tone: 'muted' };
      const display = module.name === 'lark' && module.status === 'ready' ? { label: '已连接', tone: 'ok' } : status;
      const line = node('div', undefined, 'status-line');
      line.append(node('span', undefined, `dot ${display.tone === 'muted' ? '' : display.tone}`), node('span', moduleNames[module.name] ?? module.name), node('span', display.label, 'value'));
      return line;
    }));
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  $('access-label').textContent = local ? location.host : '经 Tailscale';
  const tailnet = state.snapshot.access?.tailnet_url;
  $('tailnet-line').hidden = !local || !tailnet;
  $('tailnet-url').textContent = tailnet ? tailnet.replace(/^https?:\/\//, '').replace(/\/$/, '') : '';
  $('tailnet-url').title = tailnet ? `tailnet 内其他设备的访问地址：${tailnet}` : '';
}
function renderAll(): void { renderChrome(); renderLogs(); renderSessions(); renderPulls(); }
async function loadSnapshot(): Promise<void> {
  if (state.loading) return;
  state.loading = true;
  try {
    const response = await fetch('/ui/api/snapshot', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.snapshot = await response.json() as Snapshot;
    state.connected = true;
    $('error').hidden = true;
    $('connection').textContent = '实时更新'; $('connection-dot').className = 'dot ok';
    renderChrome(); renderLogs(); renderSessions();
    if (isPullView(state.view) && (state.snapshot.pulls?.running || state.pulls?.refresh.running)) void loadPulls();
  } catch (error) {
    state.connected = false;
    $('error').textContent = `无法连接本机服务：${(error as Error).message}。正在自动重试。`;
    $('error').hidden = false; $('connection').textContent = '连接中断'; $('connection-dot').className = 'dot error';
  } finally { state.loading = false; }
}
async function loadPulls(): Promise<void> {
  if (state.loadingPulls) return;
  state.loadingPulls = true;
  try {
    const response = await fetch('/ui/api/pulls', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(response.status === 404 ? 'PR 模块未启用' : `HTTP ${response.status}`);
    state.pulls = await response.json() as PullSnapshot;
    state.pullsError = '';
  } catch (error) { state.pullsError = (error as Error).message; }
  finally { state.loadingPulls = false; renderChrome(); renderPulls(); }
}
async function refreshNow(): Promise<void> {
  if (!isPullView(state.view)) { await loadSnapshot(); return; }
  $('refresh').classList.add('busy');
  try {
    const response = await fetch('/ui/api/pulls/refresh', { method: 'POST', headers: { 'x-nootify-ui': '1' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) { state.pullsError = `无法开始刷新：${(error as Error).message}`; }
  await loadPulls();
}

window.addEventListener('hashchange', () => {
  state.view = viewFromHash();
  renderAll();
  if (isPullView(state.view)) void loadPulls();
  $(views[state.view].section).scrollTop = 0;
});
$('refresh').addEventListener('click', () => { void refreshNow(); });
$('search').addEventListener('input', () => renderLogs(true));
$('pull-search').addEventListener('input', () => renderPulls());
$('pull-sort').addEventListener('click', () => { state.pullSort = state.pullSort === 'asc' ? 'desc' : 'asc'; renderPulls(); });
$('pause').addEventListener('click', () => {
  state.paused = !state.paused;
  $('pause').textContent = state.paused ? '继续' : '暂停';
  $('pause').setAttribute('aria-pressed', String(state.paused));
  if (!state.paused) renderLogs(true);
});
$('export').addEventListener('click', () => {
  const blob = new Blob([filteredLogs().map(entry => JSON.stringify(entry)).join('\n') + '\n'], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const link = node('a'); link.href = url; link.download = `nootify-logs-${new Date().toISOString().slice(0, 10)}.ndjson`; link.click();
  URL.revokeObjectURL(url);
});
document.addEventListener('keydown', event => {
  if (event.key !== '/' || ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName)) return;
  event.preventDefault();
  if (isPullView(state.view)) $('pull-search').focus();
  else { if (state.view !== 'logs') location.hash = views.logs.hash; $('search').focus(); }
});

renderAll();
void loadSnapshot();
if (isPullView(state.view)) void loadPulls();
setInterval(() => { void loadSnapshot(); }, 2000);
setInterval(() => { if (isPullView(state.view)) void loadPulls(); }, 10000);
