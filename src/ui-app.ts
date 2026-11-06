import type { LogEntry } from './events.js';
import type { PullRequest, PullSnapshot, RepositoryEntry } from './github.js';
import type { ModuleStatus, PublicSession } from './types.js';
import type { AgentPrompt } from './agents.js';
import type { GitHubLogin } from './github-auth.js';
import type { GitHubSettings, ImportSummary, SettingsPage } from './settings.js';
import type { TailscalePage } from './tailscale.js';
import type { ChatChannel, NotificationChannel } from './chat-transport.js';

interface PullSummary { internal: number; upstream: number; followed: number; running: boolean; lastSuccessAt?: string; error?: string; signedOut?: boolean }
interface Snapshot {
  time: string; modules: ModuleStatus[]; sessions: PublicSession[]; logs: LogEntry[];
  pulls?: PullSummary; access?: { tailnet_url?: string };
}
type View = 'logs' | 'sessions' | 'agents' | 'pulls-internal' | 'pulls-upstream' | 'repos' | 'settings-github' | 'settings-lark' | 'settings-slack' | 'settings-telegram' | 'settings-tailscale' | 'settings-backup' | 'settings-about';
interface AgentsPage { agents: AgentPrompt[]; editable: boolean; channel?: { name: NotificationChannel; configured: boolean; recipient?: string; groups: number } }
interface Tone { label: string; tone: string }
/** Pushed by the desktop shell as a `nootify-update` event; mirrors `UpdateView` in src-tauri/src/update.rs. A plain browser never receives it. */
interface UpdateView {
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'installing' | 'restarting' | 'failed';
  current: string; version: string | null; received: number; total: number | null; error: string | null; checked_at: number | null;
}

const views: Record<View, { hash: string; group: string; title: string; section: string }> = {
  logs: { hash: '#/logs', group: '消息桥接', title: '运行日志', section: 'logs-view' },
  sessions: { hash: '#/sessions', group: '消息桥接', title: '路由会话', section: 'sessions-view' },
  agents: { hash: '#/agents', group: '消息桥接', title: 'Agents', section: 'agents-view' },
  'pulls-internal': { hash: '#/pulls/internal', group: 'GitHub', title: '我们仓库的 PR', section: 'pulls-view' },
  'pulls-upstream': { hash: '#/pulls/upstream', group: 'GitHub', title: '提交上游的 PR', section: 'pulls-view' },
  repos: { hash: '#/repos', group: 'GitHub', title: 'PR 订阅', section: 'repos-view' },
  'settings-github': { hash: '#/settings/github', group: '设置', title: 'GitHub', section: 'settings-view' },
  'settings-lark': { hash: '#/settings/lark', group: '设置', title: '飞书', section: 'settings-view' },
  'settings-slack': { hash: '#/settings/slack', group: '设置', title: 'Slack', section: 'settings-view' },
  'settings-telegram': { hash: '#/settings/telegram', group: '设置', title: 'Telegram', section: 'settings-view' },
  'settings-tailscale': { hash: '#/settings/tailscale', group: '设置', title: 'Tailscale', section: 'settings-view' },
  'settings-backup': { hash: '#/settings/backup', group: '设置', title: '导入导出', section: 'settings-view' },
  'settings-about': { hash: '#/settings/about', group: '设置', title: '关于', section: 'settings-view' },
};
const descriptions: Record<string, string> = {
  ready: '服务已启动', lark_ready: '飞书长连接已建立', lark_failed: '飞书连接失败',
  slack_ready: 'Slack 连接已建立', slack_failed: 'Slack 连接失败', telegram_ready: 'Telegram 连接已建立', telegram_failed: 'Telegram 连接失败',
  received: '服务收到消息', socket_written: '已写入客户端，等待会话回执', input_accepted: '客户端已接受输入，等待会话回执',
  session_acknowledged: '会话已确认收到', replied: '回复已发回原消息', reply_failed: '发送回复失败',
  delivery_failed: '消息转发失败', ignored: '已跳过此消息', queue_full: '消息队列已满', registered: '本机会话已注册',
  bound: '已保存会话绑定', stopped: '监听已停止', connecting: '正在连接消息服务', pin_failed: '绑定消息置顶失败',
  reconnecting: '消息服务正在重连', reconnected: '消息服务已重新连接', refresh_completed: 'GitHub PR 已刷新', refresh_failed: 'GitHub PR 刷新失败',
  thread_created: '已为会话创建消息桥接', thread_reused: '会话已连接消息桥接', thread_message: '会话发送了进度消息', thread_failed: '进度消息发送失败',
  prompt_injected: '已写入 agent 提示词', prompt_removed: '已移除 agent 提示词', notification_channel_changed: '默认通知渠道已更新',
  github_login: 'GitHub 已登录', github_logout: 'GitHub 已退出登录', lark_configured: '飞书应用凭据已更新', slack_configured: 'Slack 配置已更新', telegram_configured: 'Telegram 配置已更新', config_exported: '配置已导出', config_imported: '配置已导入',
  tailnet_listening: 'Tailscale 访问已开启', tailnet_failed: 'Tailscale 监听失败', tailnet_unavailable: 'Tailscale 未运行，仅本机可访问',
};
const reasons: Record<string, string> = {
  session_not_local: '本机不存在该会话', session_archived: '会话已归档', session_offline: '本机会话未运行',
  archive_unknown: '无法确认归档状态', backend_unavailable: '客户端接口未配置或不可用', session_busy: '当前轮次已变化，本次未投递',
  missing_announcement: '群公告没有会话声明', ambiguous_announcement: '群公告有多个会话声明', unsupported_adapter: '尚未支持该客户端',
  sender_not_allowed: '发送者不在允许名单', duplicate: '重复消息', unsupported_message: '暂不处理此消息类型',
  host_mismatch: '会话位于另一台机器', invalid_content: '消息内容无效', delivery_failed: '投递失败',
};
const sourceNames: Record<string, string> = { host: '服务', sessions: '会话', lark: '飞书', slack: 'Slack', telegram: 'Telegram', pulls: 'GitHub', agents: 'Agents' };
const channelNames: Record<NotificationChannel, string> = { feishu: '飞书', slack: 'Slack', telegram: 'Telegram' };
const channelUnits: Record<NotificationChannel, string> = { feishu: '群', slack: '线程', telegram: '话题' };
const channelViews: Record<NotificationChannel, View> = { feishu: 'settings-lark', slack: 'settings-slack', telegram: 'settings-telegram' };
const chatChannels: ChatChannel[] = ['slack', 'telegram'];
const chatFields = { slack: ['bot-token', 'app-token', 'channel-id', 'user-id'], telegram: ['bot-token', 'chat-id', 'user-id'] } as const;
const categories: Record<string, Tone> = {
  received: { label: '已收件', tone: 'info' }, forwarded: { label: '待回执', tone: 'warn' },
  acknowledged: { label: '已确认', tone: 'ok' }, replied: { label: '已回复', tone: 'ok' },
  ignored: { label: '已忽略', tone: 'muted' }, error: { label: '异常', tone: 'error' }, system: { label: '系统', tone: 'muted' },
};
const outcomeTabs: [string, string][] = [['all', '全部'], ['forwarded', '待回执'], ['acknowledged', '已确认'], ['replied', '已回复'], ['ignored', '已忽略'], ['error', '异常']];
const pullTabs: [string, string][] = [['all', '全部'], ['attention', '需跟进'], ['draft', '草稿']];
const repoTabs: [string, string][] = [['all', '全部'], ['followed', '已关注'], ['muted', '未关注']];
const agentNames: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
const promptStates: Record<string, Tone> = {
  current: { label: '已注入', tone: 'ok' }, outdated: { label: '需要更新', tone: 'warn' }, absent: { label: '未注入', tone: 'muted' },
  missing: { label: '未配置', tone: 'muted' }, conflict: { label: '标记不完整', tone: 'error' }, error: { label: '无法读取', tone: 'error' },
};
const adapters: Record<string, string> = { 'claude-desktop': 'Claude Desktop', 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
const availability: Record<string, Tone> = {
  active: { label: '可投递', tone: 'ok' }, archived: { label: '已归档', tone: 'muted' }, offline: { label: '未运行', tone: 'warn' },
  unknown: { label: '未确认', tone: 'warn' }, missing: { label: '本机不存在', tone: 'muted' },
};
const reviews: Record<string, Tone> = {
  APPROVED: { label: '已批准', tone: 'ok' }, CHANGES_REQUESTED: { label: '需要修改', tone: 'error' }, REVIEW_REQUIRED: { label: '待审查', tone: 'warn' },
};
const moduleNames: Record<string, string> = { sessions: '会话', lark: '飞书', slack: 'Slack', telegram: 'Telegram', pulls: 'GitHub' };
const moduleStates: Record<string, Tone> = {
  ready: { label: '就绪', tone: 'ok' }, idle: { label: '等待刷新', tone: 'warn' }, refreshing: { label: '刷新中', tone: 'warn' },
  stale: { label: '刷新失败', tone: 'error' }, error: { label: '异常', tone: 'error' }, failed: { label: '异常', tone: 'error' },
  connecting: { label: '连接中', tone: 'warn' }, reconnecting: { label: '重连中', tone: 'warn' }, disabled: { label: '未启用', tone: 'muted' }, stopped: { label: '已停止', tone: 'muted' },
  signed_out: { label: '未登录', tone: 'warn' },
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
/** Views backed by the GitHub module's snapshot, loaded separately from the two-second page snapshot. */
const usesPulls = (view: View): boolean => isPullView(view) || view === 'repos';
const isSettingsView = (view: View): boolean => view.startsWith('settings-');

const state = {
  view: viewFromHash(),
  snapshot: { time: '', modules: [], sessions: [], logs: [] } as Snapshot,
  pulls: undefined as PullSnapshot | undefined,
  pullsError: '',
  outcome: 'all', pullFilter: 'all', pullSort: 'asc' as 'asc' | 'desc', repoFilter: 'all',
  pendingRepos: new Set<string>(), repoError: '', openRepoSources: new Set<string>(),
  agents: undefined as AgentsPage | undefined, agentsError: '', pendingAgents: new Set<string>(), openPreviews: new Set<string>(), channelEdited: false, pendingChannel: false,
  settings: undefined as (SettingsPage & { editable: boolean }) | undefined, github: undefined as GitHubSettings | undefined, loadingGitHub: false,
  tailscale: undefined as (TailscalePage & { editable: boolean }) | undefined, loadingTailscale: false, tailscaleError: '',
  settingsNote: undefined as { text: string; error: boolean } | undefined, pendingSettings: new Set<string>(),
  larkEdited: false, confirmClear: false, chatEdited: { slack: false, telegram: false }, confirmChatClear: { slack: false, telegram: false },
  importing: undefined as { name: string; content: unknown; summary: ImportSummary } | undefined,
  update: undefined as UpdateView | undefined,
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
  return entry.source ?? (entry.status.startsWith('slack_') ? 'slack' : entry.status.startsWith('telegram_') ? 'telegram'
    : entry.status.startsWith('lark') || entry.chat_id ? 'lark' : entry.session_id ? 'sessions' : 'host');
}
function category(entry: LogEntry): string {
  if (entry.status === 'ignored') return 'ignored';
  if (entry.status === 'received') return 'received';
  if (entry.status === 'session_acknowledged') return 'acknowledged';
  if (entry.status === 'replied' || entry.status === 'thread_message') return 'replied';
  if (entry.status === 'socket_written' || entry.status === 'input_accepted') return 'forwarded';
  if (entry.error || entry.status.includes('failed') || entry.status === 'queue_full') return 'error';
  return 'system';
}
function summary(entry: LogEntry): string {
  if (entry.reason && reasons[entry.reason]) return reasons[entry.reason];
  const provider = source(entry);
  const conversation = provider === 'lark' ? '飞书群' : provider === 'slack' ? 'Slack 线程' : provider === 'telegram' ? 'Telegram 话题' : undefined;
  if (conversation && entry.status === 'thread_created') return `已为会话创建${conversation}`;
  if (conversation && entry.status === 'thread_reused') return `会话已连接${conversation}`;
  return descriptions[entry.status] || entry.status;
}
function sessionLabel(entry: LogEntry): string | undefined {
  return entry.session_name ?? state.snapshot.sessions.find(session => session.session_id === entry.session_id)?.session_name ?? entry.session_id;
}
const logTitle = (entry: LogEntry): string => entry.preview && ['received', 'replied', 'thread_message'].includes(entry.status) ? entry.preview : summary(entry);
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
    ['聊天 ID', entry.chat_id, true], ['消息 ID', entry.message_id, true], ['发送者 ID', entry.sender_open_id, true], ['回复 ID', entry.reply_id, true],
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
const repositoryColors = new Map<string, number>();
const repositoryColorsKey = 'nootify-repository-colors-v1';
// Keep a repository's color through reloads as well as filtering and sorting. Storage is optional.
try {
  const saved: unknown = JSON.parse(localStorage.getItem(repositoryColorsKey) ?? '[]');
  if (Array.isArray(saved)) for (const entry of saved) {
    if (Array.isArray(entry) && typeof entry[0] === 'string' && Number.isInteger(entry[1]) && entry[1] >= 0 && entry[1] < 16) repositoryColors.set(entry[0], entry[1]);
  }
} catch { /* A blocked or invalid browser store does not prevent rendering. */ }
function assignRepositoryColors(pulls: PullSnapshot): void {
  const repositories = [...new Set([...pulls.internal, ...pulls.upstream].map(pull => pull.repository.toLowerCase()))].sort();
  const usage = Array.from({ length: 16 }, (_, color) => [...repositoryColors.values()].filter(value => value === color).length);
  let added = false;
  for (const repository of repositories) if (!repositoryColors.has(repository)) {
    const color = usage.indexOf(Math.min(...usage));
    repositoryColors.set(repository, color); usage[color]++; added = true;
  }
  if (added) try { localStorage.setItem(repositoryColorsKey, JSON.stringify([...repositoryColors])); } catch { /* The in-memory assignment still stays stable. */ }
}
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
  $('pull-sub').textContent = upstream ? '会话关联的上游 PR，以及会话仓库中的上游贡献' : '来自会话关联的 PR 和仓库订阅，所有作者的 Open 与草稿';
  const hidden = data?.hidden?.[upstream ? 'upstream' : 'internal'] ?? 0;
  $('pull-hidden').hidden = !hidden;
  $('pull-hidden').textContent = hidden ? `另有 ${hidden} 个 PR 在未关注的仓库` : '';
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
    (!query || [pull.title, pull.repository, pull.author, pull.headRepository ?? '', `#${pull.number}`, ...(pull.sessions ?? []).map(session => `${session.name} ${session.id}`)].join(' ').toLocaleLowerCase().includes(query)))
    .sort((a, b) => direction * (Date.parse(a.updatedAt) - Date.parse(b.updatedAt)) || a.repository.localeCompare(b.repository) || a.number - b.number);
  const empty = $('pull-empty');
  empty.hidden = pulls.length > 0;
  if (!pulls.length) {
    const first = !refresh?.lastSuccessAt;
    $('pull-empty-title').textContent = !data ? '正在读取 PR 数据' : first && refresh?.running ? '正在首次从 GitHub 拉取' : first ? '还没有 GitHub 数据' : all.length ? '没有匹配的 PR' : '没有打开的 PR';
    $('pull-empty-detail').textContent = first ? (refresh?.signedOut ? '登录 GitHub 后自动显示。' : '数据在后台刷新，完成后自动显示。') : all.length ? '换个筛选条件或搜索词。'
      : hidden ? '已关注的仓库没有打开的 PR；在「PR 订阅」中勾选更多来源。' : '刷新完成后，新的 Open PR 会出现在这里。';
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
    const repository = node('span', pull.repository, 'pull-repository'); repository.title = pull.repository;
    const color = repositoryColors.get(pull.repository.toLowerCase()) ?? 0;
    repository.dataset.color = String(color % 8); repository.classList.toggle('repository-deep', color >= 8);
    const title: Node[] = [repository, document.createTextNode(' ')];
    if (pull.isDraft) title.push(node('span', '草稿', 'tag'), document.createTextNode(' '));
    title.push(node('span', pull.title, 'pull-title-text'));
    const meta = [`#${pull.number}`, pull.author, `${ago(pull.updatedAt)}更新`];
    if (pull.sessions?.length) {
      const names = pull.sessions.map(session => session.name).join('、');
      meta.push(`会话：${names}`);
    }
    link.append(rowMain(title, meta.join(' · ')), sideBlock(reviews[pull.reviewDecision] ?? { label: '暂无审查结论', tone: 'muted' }, ciSummary(pull)));
    item.append(link); return item;
  }));
}

// ---- Followed repositories ----
function repoCell(text: string, className: string, label: string): HTMLTableCellElement {
  const cell = node('td', text, className); cell.dataset.label = label; cell.title = text;
  return cell;
}
async function setFollow(entry: RepositoryEntry, follow: boolean): Promise<void> {
  // Show the new state at once; the reload below restores the server's view if saving fails.
  entry.followed = follow; entry.choice = follow ? 'follow' : 'mute';
  state.pendingRepos.add(entry.repository); state.repoError = ''; renderRepos(); renderChrome();
  try {
    const response = await fetch('/ui/api/repos', { method: 'POST', headers: { 'x-nootify-ui': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ repository: entry.repository, follow }), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`);
    await response.json();
  } catch (error) { state.repoError = `无法保存 ${entry.repository} 的关注设置：${(error as Error).message}`; }
  state.pendingRepos.delete(entry.repository);
  await loadPulls();
}
function renderRepos(): void {
  const entries = state.pulls?.repositories ?? [];
  const followed = entries.filter(entry => entry.followed).length;
  renderTabs('repo-tabs', repoTabs.map(([value, label]) => [value, label, value === 'all' ? entries.length : value === 'followed' ? followed : entries.length - followed]), state.repoFilter, value => {
    state.repoFilter = value; renderRepos();
  });
  $('repo-banner').hidden = !state.repoError; $('repo-banner').textContent = state.repoError;
  if (state.view !== 'repos') return;
  const query = $<HTMLInputElement>('repo-search').value.trim().toLocaleLowerCase();
  const visible = entries.filter(entry => (state.repoFilter === 'all' || (state.repoFilter === 'followed') === entry.followed)
    && (!query || [entry.repository, ...entry.sources.map(source => `${source.name} ${source.id} ${source.branch ?? ''} ${source.pulls.map(pull => `#${pull.number}`).join(' ')}`)].join(' ').toLocaleLowerCase().includes(query)));
  $('repo-empty').hidden = visible.length > 0;
  $('repo-table').hidden = visible.length === 0;
  if (!visible.length) {
    $('repo-empty-title').textContent = !state.pulls ? '正在读取仓库' : entries.length ? '没有匹配的仓库' : '还没有发现仓库';
    $('repo-empty-detail').textContent = entries.length ? '换个筛选条件或搜索词。' : '后台刷新会读取本机 Claude、Codex、OpenCode 对话的工作目录和 GitHub PR。';
  }
  if (!changed('repo-rows', [visible, [...state.pendingRepos]])) return;
  replaceRows($('repo-rows'), visible.flatMap(entry => {
    const row = node('tr', undefined, 'repo-row');
    const follow = node('td', undefined, 'repo-follow-cell');
    const label = node('label', undefined, 'repo-follow');
    label.title = entry.choice === 'follow' ? '手动关注' : entry.choice === 'mute' ? '手动取消' : entry.followed ? '自动关注' : '未关注';
    const box = node('input', undefined, 'check'); box.type = 'checkbox'; box.checked = entry.followed;
    box.disabled = state.pendingRepos.has(entry.repository); box.dataset.key = entry.repository;
    box.setAttribute('aria-label', `关注 ${entry.repository}`);
    box.addEventListener('change', () => { void setFollow(entry, box.checked); });
    label.append(box); follow.append(label);
    const name = node('th', undefined, 'repo-name-cell'); name.scope = 'row';
    const repository = node('span', entry.repository, 'repo-name'); repository.title = entry.repository;
    const total = entry.pulls.internal + entry.pulls.upstream;
    const open = repoCell(String(total), `repo-open-cell${total && entry.followed ? ' tone-info' : ''}`, 'Open PR');
    open.title = `我们仓库 ${entry.pulls.internal} 个，上游 ${entry.pulls.upstream} 个`;
    const scope = repoCell(entry.allPulls ? '整个仓库' : '指定 PR', 'repo-scope-cell', '范围');
    scope.title = entry.allPulls ? '跟踪仓库中的 Open 与草稿 PR' : '仅跟踪来源会话明确关联的 PR';
    const active = repoCell(ago(entry.lastActive), 'repo-active-cell', '活跃');
    if (entry.lastActive) active.title = fullTime(entry.lastActive);
    row.append(follow, name, repoCell(entry.agents.map(agent => agentNames[agent] ?? agent).join('、') || '—', 'repo-agents-cell', '来源'), scope,
      repoCell(String(entry.sessions), 'repo-sessions-cell', '会话'), repoCell(String(entry.linkedPulls), 'repo-linked-cell', '关联 PR'), open, active);
    if (!entry.sources.length) { name.append(repository); return [row]; }

    const details = node('tr', undefined, 'repo-details'); details.id = `repo-sources-${encodeURIComponent(entry.repository)}`;
    details.hidden = !state.openRepoSources.has(entry.repository);
    const toggle = node('button', undefined, 'repo-toggle'); toggle.type = 'button'; toggle.dataset.key = `sources:${entry.repository}`;
    toggle.setAttribute('aria-expanded', String(!details.hidden)); toggle.setAttribute('aria-controls', details.id);
    toggle.setAttribute('aria-label', `${entry.repository}，${entry.sources.length} 个来源会话`);
    toggle.append(chevron(), repository); name.append(toggle);
    toggle.addEventListener('click', () => {
      const open = details.hidden;
      if (open) state.openRepoSources.add(entry.repository); else state.openRepoSources.delete(entry.repository);
      details.hidden = !open; toggle.setAttribute('aria-expanded', String(open));
    });
    const cell = node('td'); cell.colSpan = 8;
    const list = node('div', undefined, 'session-sources'); list.setAttribute('role', 'list'); list.setAttribute('aria-label', `${entry.repository} 的来源会话`);
    for (const source of entry.sources) {
      const item = node('div', undefined, 'session-source'); item.setAttribute('role', 'listitem');
      const meta = node('span', [adapters[source.adapter], source.fromRepository ? '会话仓库' : '关联 PR', source.branch, source.archived ? '已归档' : ''].filter(Boolean).join(' · '), 'source-meta');
      meta.title = meta.textContent ?? '';
      item.append(node('strong', source.name), meta, node('span', source.id, 'mono source-id'));
      if (source.pulls.length) {
        const links = node('div', undefined, 'source-links');
        for (const pull of source.pulls) {
          const link = node('a', `#${pull.number}`); link.href = pull.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = pull.url; links.append(link);
        }
        item.append(links);
      }
      list.append(item);
    }
    cell.append(list); details.append(cell);
    return [row, details];
  }));
}

// ---- Agents ----
const home = (path: string): string => path.replace(/^(?:\/Volumes\/[^/]+)?\/(?:Users|home)\/[^/]+(?=\/)/, '~');
function agentDetail(agent: AgentPrompt): string {
  if (agent.status === 'missing') return '尚未创建提示词，勾选后自动创建';
  if (agent.status === 'conflict') return '文件里的 nootify 标记不成对，请先手动修正';
  if (agent.status === 'error') return agent.error ?? '无法读取文件';
  if (agent.status === 'outdated') return '写入内容与当前版本不同';
  const channel = channelNames[state.agents?.channel?.name ?? 'feishu'];
  return agent.injected ? `新对话会按说明使用${channel}` : `勾选后写入${channel}通知说明`;
}
async function loadAgents(): Promise<void> {
  try {
    const response = await fetch('/ui/api/agents', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(response.status === 404 ? 'Agents 模块未启用' : `HTTP ${response.status}`);
    state.agents = await response.json() as AgentsPage;
  } catch (error) { state.agentsError = `无法读取 agent 状态：${(error as Error).message}`; }
  renderChrome(); renderAgents();
}
async function setAgent(agent: AgentPrompt, enabled: boolean): Promise<void> {
  if (state.agents?.editable !== true || state.pendingChannel || state.pendingAgents.has(agent.agent)) return;
  state.pendingAgents.add(agent.agent); state.agentsError = ''; renderAgents();
  try {
    const response = await fetch('/ui/api/agents', { method: 'POST', headers: { 'x-nootify-ui': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ agent: agent.agent, enabled }), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`);
    await response.json();
  } catch (error) { state.agentsError = `无法修改 ${agent.name}：${(error as Error).message}`; }
  state.pendingAgents.delete(agent.agent);
  await loadAgents();
}
async function saveChannel(): Promise<void> {
  if (state.agents?.editable !== true || state.pendingChannel || state.pendingAgents.size) return;
  const channel = $<HTMLSelectElement>('notification-channel').value;
  if (channel === state.agents.channel?.name) return;
  state.pendingChannel = true; state.agentsError = ''; renderAgents();
  try {
    await post('/ui/api/settings/channel', { channel });
    state.channelEdited = false;
    await loadAgents();
  } catch (error) { state.agentsError = `无法保存默认通知渠道：${(error as Error).message}`; }
  finally { state.pendingChannel = false; renderAgents(); }
}
function renderAgents(): void {
  const page = state.agents;
  $('agents-count').textContent = page ? String(page.agents.filter(agent => agent.injected).length || '') : '';
  const remote = page?.editable !== true;
  const banner = state.agentsError || (page && remote ? '通过 Tailscale 访问时只能查看；请在这台 Mac 上修改 agent 提示词和通知渠道。' : '');
  $('agents-banner').hidden = !banner; $('agents-banner').textContent = banner;
  const channel = page?.channel;
  const name = channelNames[channel?.name ?? 'feishu'];
  setText('channel-title', channel ? `通知渠道 · ${name}` : '通知渠道');
  setText('channel-sub', !page ? '正在读取通知渠道…' : !channel ? '通知模块未启用' : !channel.configured ? `还没有完成 ${name} 配置：到「设置 · ${name}」配置后再使用`
    : channel.recipient ? `${channel.name === 'feishu' ? '接收人' : '信任的用户'} ${channel.recipient} · 已绑定 ${channel.groups} 个${channelUnits[channel.name]}` : `还没有设置信任的用户：到「设置 · ${name}」填写`);
  const settings = $<HTMLAnchorElement>('channel-settings');
  settings.href = views[channelViews[channel?.name ?? 'feishu']].hash;
  setText('channel-settings', `配置${name}`);
  const choice = $<HTMLSelectElement>('notification-channel');
  if (!state.channelEdited) choice.value = channel?.name ?? 'feishu';
  choice.disabled = remote || !channel || state.pendingChannel || state.pendingAgents.size > 0;
  $<HTMLButtonElement>('channel-save').disabled = choice.disabled || choice.value === channel?.name;
  setText('channel-save', state.pendingChannel ? '保存中…' : '保存');
  if (state.view !== 'agents' || !page) return;
  if (!changed('agent-rows', [page, [...state.pendingAgents], state.pendingChannel])) return;
  replaceRows($('agent-rows'), page.agents.map(agent => {
    const item = node('div', undefined, 'entry'); item.setAttribute('role', 'listitem');
    const row = node('label', undefined, 'row');
    const box = node('input', undefined, 'check'); box.type = 'checkbox'; box.checked = agent.injected; box.dataset.key = agent.agent;
    box.disabled = remote || state.pendingChannel || state.pendingAgents.has(agent.agent) || ['conflict', 'error'].includes(agent.status);
    box.setAttribute('aria-label', `向 ${agent.name} 写入${name}通知说明`);
    box.addEventListener('change', () => { void setAgent(agent, box.checked); });
    row.append(box, rowMain(agent.name, `${home(agent.file)} · ${agentDetail(agent)}`), sideBlock(promptStates[agent.status] ?? promptStates.error));
    const extra = node('div', undefined, 'agent-extra');
    if (agent.status === 'outdated' && !remote) {
      const update = node('button', '更新为当前内容', 'text-button'); update.type = 'button';
      update.disabled = state.pendingChannel || state.pendingAgents.has(agent.agent);
      update.addEventListener('click', () => { void setAgent(agent, true); });
      extra.append(update);
    }
    const details = node('details');
    details.open = state.openPreviews.has(agent.agent);
    details.addEventListener('toggle', () => { if (details.open) state.openPreviews.add(agent.agent); else state.openPreviews.delete(agent.agent); });
    details.append(node('summary', agent.injected ? '查看写入的内容' : '查看将写入的内容'), node('pre', agent.block, 'mono'));
    extra.append(details);
    item.append(row, extra); return item;
  }));
}

// ---- Settings ----
const credentialSources: Record<string, string> = { environment: '环境变量', settings: '这里保存的凭据', 'mcp-config': 'MCP 配置文件' };
const githubErrors: Record<string, string> = {
  access_denied: '已在 GitHub 上拒绝授权', expired_token: '验证码已过期，请重新登录', device_flow_disabled: 'GitHub OAuth App 没有开启 Device Flow',
  'Not Found': 'GitHub 找不到这个 OAuth App，请检查 Client ID', missing_client_id: '这个版本没有配置 GitHub OAuth Client ID',
};
const loginActive = (login?: GitHubLogin): boolean => login?.status === 'starting' || login?.status === 'waiting';
/** Skips unchanged text, so polling never clears a selection such as the device code. */
function setText(id: string, text: string): void { if ($(id).textContent !== text) $(id).textContent = text; }
function setTone(id: string, tone: Tone): void { setText(id, tone.label); $(id).className = `tone-${tone.tone}`; }
const field = (id: string): HTMLInputElement => $<HTMLInputElement>(id);
async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'x-nootify-ui': '1', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(path === '/ui/api/settings/import' ? 180000 : ['/ui/api/settings/slack', '/ui/api/settings/telegram'].includes(path) ? 90000 : 20000) });
  if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`);
  return await response.json() as T;
}
function fillLark(): void {
  const lark = state.settings?.lark;
  field('lark-app-id').value = lark?.app_id ?? '';
  field('lark-app-secret').value = '';
  field('lark-recipient').value = lark?.recipient ?? '';
}
function clearChatTokens(channel: ChatChannel): void {
  field(`${channel}-bot-token`).value = '';
  if (channel === 'slack') field('slack-app-token').value = '';
}
function fillChat(channel: ChatChannel): void {
  const page = state.settings?.[channel];
  clearChatTokens(channel);
  field(`${channel}-${channel === 'slack' ? 'channel-id' : 'chat-id'}`).value = page?.chat_id ?? '';
  field(`${channel}-user-id`).value = page?.user_id ?? '';
}
async function loadSettings(): Promise<void> {
  try {
    const response = await fetch('/ui/api/settings', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(response.status === 404 ? '设置模块未启用' : `HTTP ${response.status}`);
    state.settings = await response.json() as SettingsPage & { editable: boolean };
    if (!state.larkEdited) fillLark();
    for (const channel of chatChannels) if (!state.chatEdited[channel]) fillChat(channel);
  } catch (error) { state.settingsNote = { text: `无法读取设置：${(error as Error).message}`, error: true }; }
  renderSettings();
}
async function loadGitHub(): Promise<void> {
  if (state.loadingGitHub) return;
  state.loadingGitHub = true;
  try {
    const response = await fetch('/ui/api/settings/github', { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const next = await response.json() as GitHubSettings;
    // While a login runs the service reports only its progress.
    state.github = { account: next.account ?? state.github?.account, login: next.login };
  } catch (error) { state.settingsNote = { text: `无法读取 GitHub 状态：${(error as Error).message}`, error: true }; }
  finally { state.loadingGitHub = false; renderSettings(); }
}
const tailscaleErrors: Record<string, string> = {
  embedded_client_missing: '内置 Tailscale 客户端不可用，请重新安装完整的 Nootify 应用。',
  embedded_client_stopped: 'Nootify 节点已离线，正在自动重连。',
  embedded_protocol_error: '内置客户端响应异常，请重新启动 Nootify。',
  embedded_request_timeout: '连接超时，请检查网络后重试。',
  embedded_request_failed: '无法完成操作，请检查网络后重试。',
  state_locked: '这个 Nootify 节点正在被另一个进程使用，请关闭重复运行的 Nootify。',
  state_unavailable: '无法读取 Nootify 节点的登录信息，请检查本机存储权限。',
  listener_failed: '无法开启 Nootify 节点的访问端口，请重新连接。',
  startup_failed: '内置 Tailscale 节点启动失败，请重新连接。',
  client_unavailable: '无法连接内置 Tailscale 客户端，请重启 Nootify。',
  status_failed: '暂时无法读取节点状态，正在重试。',
  busy: '内置客户端忙碌，正在重试。',
  timeout: '连接超时，请检查网络后重试。',
};
async function loadTailscale(): Promise<void> {
  if (state.loadingTailscale) return;
  state.loadingTailscale = true;
  try {
    const response = await fetch('/ui/api/settings/tailscale', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.tailscale = await response.json() as TailscalePage & { editable: boolean };
    state.tailscaleError = '';
  } catch (error) { state.tailscaleError = `无法读取 Tailscale 状态：${(error as Error).message}`; }
  finally { state.loadingTailscale = false; renderSettings(); }
}
function renderTailscale(): void {
  const data = state.tailscale;
  const remote = data?.editable !== true;
  const busy = state.pendingSettings.has('tailscale');
  const active = loginActive(data?.login);
  field('tailscale-enabled').checked = data?.enabled ?? false;
  field('tailscale-enabled').disabled = remote || busy;
  const connected = data?.status === 'connected';
  const labels: Record<TailscalePage['status'], Tone> = {
    disabled: { label: '已关闭', tone: 'muted' }, 'needs-login': { label: '待登录', tone: 'warn' }, starting: { label: '连接中', tone: 'warn' },
    'needs-approval': { label: '等待批准', tone: 'warn' }, connected: { label: '已连接', tone: 'ok' }, unavailable: { label: '不可用', tone: 'warn' },
  };
  setTone('tailscale-state', data ? labels[data.status] : { label: '', tone: 'muted' });
  setText('tailscale-status', !data ? '正在检查连接…' : connected ? [data.deviceName, data.account].filter(Boolean).join(' · ')
    : data.status === 'needs-approval' ? '请在 Tailscale 管理后台批准 Nootify 这台设备。'
    : data.status === 'unavailable' ? 'Nootify 内置节点暂时不可用。'
    : data.status === 'disabled' ? '独立的 Tailscale 设备，不使用系统客户端。' : '登录后，Nootify 会作为独立设备加入你的网络。');
  setText('tailscale-sharing', !data ? '正在读取设置…' : !data.enabled ? '节点已关闭；已有登录信息会保留。'
    : data.error ? tailscaleErrors[data.error] ?? data.error
    : data.sharing === 'ready' ? '已连接，通过 Nootify 节点的 80 端口访问。'
    : connected ? '正在开启远程访问…' : '等待 Nootify 节点连接。');
  $('tailscale-sharing').classList.toggle('tone-error', !!data?.error);
  const login = $<HTMLButtonElement>('tailscale-login');
  login.hidden = remote || !data || connected || data.login.status === 'starting' || data.status === 'needs-approval';
  login.disabled = busy;
  setText('tailscale-login', data?.login.status === 'waiting' ? '重新获取链接' : data?.enabled ? '登录 Tailscale' : '启用并登录');
  const logout = $<HTMLButtonElement>('tailscale-logout');
  logout.hidden = remote || !connected; logout.disabled = busy;
  $('tailscale-flow').hidden = remote || !active;
  setText('tailscale-flow-title', data?.login.status === 'waiting' ? '继续完成 Tailscale 登录' : '正在准备登录…');
  $<HTMLButtonElement>('tailscale-cancel').disabled = busy;
  const open = $<HTMLAnchorElement>('tailscale-open');
  open.hidden = remote || !data?.login.url;
  if (!remote && data?.login.url) open.href = data.login.url; else open.removeAttribute('href');
  $('tailscale-address-row').hidden = !data?.url;
  setText('tailscale-address', data?.url ?? '');
  setText('tailscale-dns', data?.url && data.dnsName ? `MagicDNS：http://${data.dnsName}/` : '');
}
function loadSettingsView(): void {
  if (!isSettingsView(state.view)) return;
  void loadSettings();
  if (state.view === 'settings-github') void loadGitHub();
  if (state.view === 'settings-tailscale') void loadTailscale();
}
/** Runs one page action: its buttons are disabled meanwhile, and the result replaces the page's note. */
async function settingsRun(key: string, failure: string, action: () => Promise<string | void>): Promise<void> {
  state.pendingSettings.add(key); state.settingsNote = undefined; renderSettings();
  try {
    const note = await action();
    if (note) state.settingsNote = { text: note, error: false };
  } catch (error) { state.settingsNote = { text: `${failure}：${(error as Error).message}`, error: true }; }
  state.pendingSettings.delete(key); renderSettings();
}
function githubStatus(): { text: string; tone: Tone } {
  const account = state.github?.account;
  if (!account) return { text: loginActive(state.github?.login) ? '正在登录' : '正在检查登录状态…', tone: { label: '', tone: 'muted' } };
  if (account.signedIn) return { text: `${account.login} · 和终端里的 gh 互不影响`, tone: { label: '已登录', tone: 'ok' } };
  if (account.error) return { text: `无法确认登录状态：${account.error}`, tone: { label: '未确认', tone: 'warn' } };
  return { text: '登录后才能读取 PR 和订阅', tone: { label: '未登录', tone: 'warn' } };
}
function renderGitHub(remote: boolean): void {
  const github = state.github; const login = github?.login;
  const active = loginActive(login); const waiting = login?.status === 'waiting';
  const status = githubStatus();
  setText('github-status', status.text); setTone('github-state', status.tone);
  const signedIn = github?.account?.signedIn === true;
  const start = $<HTMLButtonElement>('github-login'); const leave = $<HTMLButtonElement>('github-logout');
  start.hidden = remote || !github || active || signedIn;
  leave.hidden = remote || active || !signedIn;
  start.disabled = leave.disabled = state.pendingSettings.has('github');
  $('github-flow').hidden = !active || remote;
  setText('github-flow-title', waiting ? '在 GitHub 页面输入这个验证码' : '正在向 GitHub 申请验证码…');
  setText('github-flow-sub', waiting && login?.expiresAt ? `${clock(login.expiresAt)} 前有效，授权后这里会自动更新` : '');
  setText('github-code', login?.code ?? '');
  $('github-copy').hidden = !waiting;
  if (!waiting) setText('github-copy', '复制');
  const open = $<HTMLAnchorElement>('github-open');
  open.hidden = !waiting;
  if (login?.url) open.href = login.url;
}
function renderLark(remote: boolean): void {
  const lark = state.settings?.lark;
  const status = state.snapshot.modules.find(module => module.name === 'lark')?.status ?? lark?.status ?? 'disabled';
  setTone('lark-state', status === 'ready' ? { label: '已连接', tone: 'ok' } : moduleStates[status] ?? { label: status, tone: 'muted' });
  setText('lark-status', !lark ? '' : lark.app_id ? `${lark.app_id} · 来自${credentialSources[lark.source ?? 'settings']}${lark.recipient ? '' : ' · 还没有接收人'}` : '还没有配置应用凭据');
  const environment = lark?.source === 'environment';
  field('lark-app-secret').placeholder = lark?.saved ? '已保存，留空则不修改' : '';
  const busy = state.pendingSettings.has('lark');
  for (const id of ['lark-app-id', 'lark-app-secret']) field(id).disabled = remote || environment || busy;
  field('lark-recipient').disabled = remote || state.pendingSettings.has('recipient');
  $<HTMLButtonElement>('lark-save').disabled = remote || environment || busy;
  $<HTMLButtonElement>('recipient-save').disabled = remote || state.pendingSettings.has('recipient');
  const clear = $<HTMLButtonElement>('lark-clear');
  clear.hidden = remote || !lark?.saved; clear.disabled = busy;
  setText('lark-clear', state.confirmClear ? '再点一次确认清除' : '清除保存的凭据');
}
function renderChat(channel: ChatChannel, remote: boolean): void {
  const page = state.settings?.[channel];
  const status = state.snapshot.modules.find(module => module.name === channel)?.status ?? page?.status ?? 'disabled';
  setTone(`${channel}-state`, !page ? { label: '', tone: 'muted' } : status === 'ready' ? { label: '已连接', tone: 'ok' } : moduleStates[status] ?? { label: status, tone: 'muted' });
  setText(`${channel}-status`, !page ? '正在读取设置…' : !page.configured ? '还没有完成机器人配置'
    : `${page.account ?? '配置已保存'} · 已绑定 ${page.threads} 个${channelUnits[channel]}`);
  const busy = state.pendingSettings.has(channel);
  for (const suffix of chatFields[channel]) {
    const input = field(`${channel}-${suffix}`);
    input.disabled = remote || !page || busy;
    if (suffix.endsWith('token')) input.placeholder = page?.saved ? '已保存，留空则不修改'
      : suffix === 'app-token' ? 'xapp-…' : channel === 'slack' ? 'xoxb-…' : '123456789:…';
  }
  $<HTMLButtonElement>(`${channel}-save`).disabled = remote || !page || busy;
  setText(`${channel}-save`, busy ? '处理中…' : '验证并保存');
  const clear = $<HTMLButtonElement>(`${channel}-clear`);
  clear.hidden = remote || !page?.saved; clear.disabled = busy;
  setText(`${channel}-clear`, state.confirmChatClear[channel] ? `确认清除 ${channelNames[channel]} 配置` : `清除 ${channelNames[channel]} 配置`);
}
function importLines(summary: ImportSummary): string[] {
  const lines: string[] = [];
  if (summary.notification_channel) lines.push(`默认通知渠道：${channelNames[summary.notification_channel]}`);
  if (summary.app_id) lines.push(`飞书应用 ${summary.app_id} 和它的 App Secret`);
  if (summary.recipient) lines.push(`飞书接收人 ${summary.recipient}`);
  if (summary.slack) lines.push(`Slack 令牌、频道 ${summary.slack.chat_id} 和信任的用户 ${summary.slack.user_id}`);
  if (summary.telegram) lines.push(`Telegram 令牌、超级群 ${summary.telegram.chat_id} 和信任的用户 ${summary.telegram.user_id}`);
  if (summary.pulls_config) lines.push('GitHub PR 配置');
  if (summary.follow !== undefined) lines.push(`用文件里的 ${summary.follow} 条选择替换现有的仓库关注选择`);
  if (summary.backends.length) lines.push(`${summary.backends.map(adapter => adapters[adapter] ?? adapter).join('、')} 连接`);
  if (summary.agents.length) lines.push(`启用 ${summary.agents.map(agent => agentNames[agent] ?? agent).join('、')} 的通知说明`);
  return lines.length ? lines : ['这个文件没有可导入的设置'];
}
function renderBackup(remote: boolean): void {
  const page = state.settings;
  setText('export-path', !page ? '' : page.last_export ? `最近导出到 ${home(page.last_export)}` : `写入 ${home(page.exports_dir)}`);
  $('export-reveal').hidden = remote || !page?.last_export;
  for (const [id, key] of [['export-config', 'export'], ['import-choose', 'import'], ['import-apply', 'import'], ['import-cancel', 'import']] as const) {
    $<HTMLButtonElement>(id).disabled = remote || state.pendingSettings.has(key);
  }
  const importing = state.importing;
  $('import-preview').hidden = !importing;
  if (!importing) return;
  setText('import-name', `${importing.name} 将写入：`);
  setText('import-date', importing.summary.exported_at ? `导出于 ${fullTime(importing.summary.exported_at)}` : '');
  if (changed('import-lines', importing.summary)) $('import-lines').replaceChildren(...importLines(importing.summary).map(line => node('li', line)));
}
function renderSettings(): void {
  renderUpdate();
  if (!isSettingsView(state.view)) return;
  const remote = state.settings?.editable === false;
  const login = state.github?.login;
  const note = state.settingsNote ?? (state.view === 'settings-github' && login?.status === 'failed' ? { text: `GitHub 登录失败：${githubErrors[login.error ?? ''] ?? login.error}`, error: true }
    : state.view === 'settings-tailscale' && state.tailscaleError ? { text: state.tailscaleError, error: true }
    : state.view === 'settings-tailscale' && state.tailscale?.login.status === 'failed' ? { text: `Tailscale 登录失败：${tailscaleErrors[state.tailscale.login.error ?? ''] ?? '请重试。'}`, error: true }
    : remote ? { text: '通过 Tailscale 访问时只能查看；请在这台 Mac 上修改设置。', error: false } : undefined);
  const banner = $('settings-banner');
  banner.hidden = !note; banner.className = note && !note.error ? 'banner note' : 'banner';
  setText('settings-banner', note?.text ?? '');
  renderGitHub(remote); renderLark(remote); renderTailscale(); renderBackup(remote);
  for (const channel of chatChannels) renderChat(channel, remote);
}

// ---- Updates ----
const updateTag = (update: UpdateView): string => update.version ? `v${update.version.replace(/^v/, '')}` : '';
const megabytes = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`;
/** The native window's policy cancels this navigation and hands the request to its update worker. */
function askNative(action: 'check' | 'install'): void { location.href = `nootify://update/${action}`; }
function updateStatus(update: UpdateView): string {
  const tag = updateTag(update);
  if (update.phase === 'checking') return '正在检查更新…';
  if (update.phase === 'available') return `发现新版本 ${tag}${update.error ? `；${update.error}` : ''}`;
  if (update.phase === 'downloading') {
    const amount = update.total ? `${megabytes(update.received)} / ${megabytes(update.total)} · ${Math.min(100, Math.floor(update.received * 100 / update.total))}%` : megabytes(update.received);
    return `正在下载 ${tag} · ${amount}`;
  }
  if (update.phase === 'installing') return `正在安装 ${tag}…`;
  if (update.phase === 'restarting') return `已安装 ${tag}，正在重启…`;
  if (update.phase === 'failed') return `检查更新失败：${update.error ?? '未知错误'}`;
  if (update.phase === 'current') return `已是最新版本${update.checked_at ? ` · ${ago(new Date(update.checked_at).toISOString())}检查` : ''}`;
  return '启动约 30 秒后自动检查';
}
function compactUpdateStatus(update: UpdateView): string {
  if (update.phase === 'checking') return '检查中…';
  if (update.phase === 'downloading') return update.total
    ? `下载中 ${Math.min(100, Math.floor(update.received * 100 / update.total))}%`
    : '下载中…';
  if (update.phase === 'installing') return '安装中…';
  if (update.phase === 'restarting') return '重启中…';
  if (update.phase === 'available') return update.error ? '重试更新' : `更新 ${updateTag(update)}`;
  if (update.phase === 'failed') return '重试检查';
  if (update.phase === 'current') return '已是最新';
  return '检查更新';
}
function updateAction(update: UpdateView): 'check' | 'install' | 'details' {
  if (update.phase === 'available') return 'install';
  if (['checking', 'downloading', 'installing', 'restarting'].includes(update.phase)) return 'details';
  return 'check';
}
function renderUpdate(): void {
  const update = state.update;
  const available = update?.phase === 'available';
  const working = !!update && updateAction(update) === 'details';
  const failed = update?.phase === 'failed' || (available && !!update.error);
  for (const dot of document.querySelectorAll<HTMLElement>('.update-dot')) dot.hidden = !available;
  $('titlebar-update').hidden = !update;
  $('titlebar-update').classList.toggle('has-error', !!failed);
  const button = $<HTMLButtonElement>('update-action');
  button.classList.toggle('busy', working);
  if (update) {
    const action = updateAction(update);
    const hint = action === 'install' ? `安装 ${updateTag(update)}，完成后自动重启` : action === 'details' ? '查看更新详情' : '检查软件更新';
    setText('update-action-label', compactUpdateStatus(update));
    button.title = `${updateStatus(update)}；${hint}`;
    button.setAttribute('aria-label', button.title);
    $('update-action-icon').setAttribute('d', working ? 'M13 8a5 5 0 1 1-5-5'
      : update.phase === 'current' ? 'm3.5 8 3 3 6-6'
      : failed ? 'M13.2 8A5.2 5.2 0 1 1 11.7 4.3M13.2 2.6v3.1h-3.1' : 'M8 13V3M4 7l4-4 4 4');
  }
  const service = state.settings?.version;
  setText('about-version', [update ? `应用 ${update.current}` : '', service ? `后台服务 ${service}` : ''].filter(Boolean).join(' · ') || '—');
  setText('update-status', update ? updateStatus(update) : '在 Nootify 桌面应用里检查和安装更新');
}

// ---- Chrome, loading and events ----
function revealActiveNavigation(): void {
  if (document.documentElement.hasAttribute('data-nootify-desktop') || !matchMedia('(max-width: 760px)').matches) return;
  const active = document.querySelector<HTMLElement>('.sidebar .nav-item[aria-current="page"]');
  const navigation = active?.closest<HTMLElement>('nav');
  if (!active || !navigation) return;
  const item = active.getBoundingClientRect();
  const track = navigation.getBoundingClientRect();
  navigation.scrollLeft += item.left - track.left - (navigation.clientWidth - item.width) / 2;
}
function renderChrome(): void {
  const meta = views[state.view];
  $('crumb-group').textContent = meta.group; $('crumb-page').textContent = meta.title;
  document.title = `${meta.title} · Nootify`;
  for (const link of document.querySelectorAll<HTMLAnchorElement>('.nav-item')) {
    if (link.dataset.view === state.view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  for (const section of ['logs-view', 'sessions-view', 'agents-view', 'pulls-view', 'repos-view', 'settings-view']) $(section).hidden = section !== meta.section;
  for (const panel of document.querySelectorAll<HTMLElement>('[data-panel]')) panel.hidden = panel.dataset.panel !== state.view;
  $('settings-subnav').hidden = !isSettingsView(state.view);
  $('settings-link').toggleAttribute('data-open', isSettingsView(state.view));
  const pullSummary = state.snapshot.pulls;
  $('github-signin').hidden = !usesPulls(state.view) || !(pullSummary?.signedOut ?? state.pulls?.refresh.signedOut);
  const internal = pullSummary?.internal ?? state.pulls?.internal.length;
  const upstream = pullSummary?.upstream ?? state.pulls?.upstream.length;
  $('internal-count').textContent = internal === undefined ? '' : String(internal);
  $('upstream-count').textContent = upstream === undefined ? '' : String(upstream);
  const followedRepos = pullSummary?.followed ?? state.pulls?.repositories.filter(entry => entry.followed).length;
  $('repos-count').textContent = followedRepos === undefined ? '' : String(followedRepos);
  const busy = usesPulls(state.view) && Boolean(pullSummary?.running || state.pulls?.refresh.running);
  $('refresh').classList.toggle('busy', busy);
  const label = usesPulls(state.view) ? '在后台刷新 GitHub 数据' : '立即刷新';
  $('refresh').title = label; $('refresh').setAttribute('aria-label', label);
  $('updated').textContent = usesPulls(state.view)
    ? (busy ? '后台刷新中' : state.pulls?.refresh.lastSuccessAt ? `${ago(state.pulls.refresh.lastSuccessAt)}刷新` : '')
    : state.snapshot.time ? `更新于 ${clock(state.snapshot.time)}` : '';
  if (changed('modules', state.snapshot.modules)) {
    $('modules').replaceChildren(...state.snapshot.modules.filter(module => module.name in moduleNames).map(module => {
      const status = moduleStates[module.status] ?? { label: module.status, tone: 'muted' };
      const display = ['lark', 'slack', 'telegram'].includes(module.name) && module.status === 'ready' ? { label: '已连接', tone: 'ok' } : status;
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
function renderAll(): void { renderChrome(); renderLogs(); renderSessions(); renderAgents(); renderPulls(); renderRepos(); renderSettings(); }
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
    renderChrome(); renderLogs(); renderSessions(); renderSettings();
    if (usesPulls(state.view) && (state.snapshot.pulls?.running || state.pulls?.refresh.running)) void loadPulls();
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
    assignRepositoryColors(state.pulls);
    state.pullsError = '';
  } catch (error) { state.pullsError = (error as Error).message; }
  finally { state.loadingPulls = false; renderChrome(); renderPulls(); renderRepos(); }
}
async function refreshNow(): Promise<void> {
  if (state.view === 'agents') { await Promise.all([loadSnapshot(), loadAgents()]); return; }
  if (isSettingsView(state.view)) {
    await Promise.all([loadSnapshot(), loadSettings(), ...(state.view === 'settings-github' ? [loadGitHub()] : []), ...(state.view === 'settings-tailscale' ? [loadTailscale()] : [])]);
    return;
  }
  if (!usesPulls(state.view)) { await loadSnapshot(); return; }
  $('refresh').classList.add('busy');
  try {
    const response = await fetch('/ui/api/pulls/refresh', { method: 'POST', headers: { 'x-nootify-ui': '1' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) { state.pullsError = `无法开始刷新：${(error as Error).message}`; }
  await loadPulls();
}

window.addEventListener('hashchange', () => {
  state.view = viewFromHash();
  state.settingsNote = undefined;
  state.confirmChatClear.slack = false; state.confirmChatClear.telegram = false;
  renderAll();
  requestAnimationFrame(revealActiveNavigation);
  if (usesPulls(state.view)) void loadPulls();
  if (state.view === 'agents') void loadAgents();
  loadSettingsView();
  $(views[state.view].section).scrollTop = 0;
});
window.addEventListener('nootify-update', event => { state.update = (event as CustomEvent<UpdateView>).detail; renderUpdate(); });
$('update-action').addEventListener('click', () => {
  if (!state.update) return;
  const action = updateAction(state.update);
  if (action === 'details') location.hash = views['settings-about'].hash;
  else askNative(action);
});
type TailscaleAction = { action: 'enable'; enabled: boolean } | { action: 'login' | 'cancel' | 'logout' };
function runTailscaleAction(body: TailscaleAction, failure: string): void {
  void settingsRun('tailscale', failure, async () => {
    await post('/ui/api/settings/tailscale', body);
    await loadTailscale();
  });
}
$('tailscale-enabled').addEventListener('change', () => {
  runTailscaleAction({ action: 'enable', enabled: field('tailscale-enabled').checked }, '无法修改远程访问');
});
$('tailscale-login').addEventListener('click', () => runTailscaleAction({ action: 'login' }, '无法开始 Tailscale 登录'));
$('tailscale-cancel').addEventListener('click', () => runTailscaleAction({ action: 'cancel' }, '无法取消登录'));
$('tailscale-logout').addEventListener('click', () => runTailscaleAction({ action: 'logout' }, '无法退出 Nootify 节点'));
$('tailscale-copy').addEventListener('click', () => {
  const url = state.tailscale?.url; if (!url) return;
  void (navigator.clipboard?.writeText(url) ?? Promise.reject(new Error('Clipboard is unavailable'))).then(() => {
    setText('tailscale-copy', '已复制'); setTimeout(() => setText('tailscale-copy', '复制地址'), 2000);
  }, () => { getSelection()?.selectAllChildren($('tailscale-address')); setText('tailscale-copy', '已选中，按 ⌘C'); });
});
$('github-login').addEventListener('click', () => {
  void settingsRun('github', '无法开始登录', async () => {
    state.github = { account: state.github?.account, login: await post<GitHubLogin>('/ui/api/settings/github/login', { action: 'start' }) };
  });
});
$('github-cancel').addEventListener('click', () => {
  void settingsRun('github', '无法取消登录', async () => { await post('/ui/api/settings/github/login', { action: 'cancel' }); await loadGitHub(); });
});
$('github-logout').addEventListener('click', () => {
  void settingsRun('github', '无法退出登录', async () => { await post('/ui/api/settings/github/login', { action: 'sign-out' }); await loadGitHub(); return '已退出 GitHub 登录'; });
});
$('github-copy').addEventListener('click', () => {
  const code = state.github?.login.code;
  if (!code) return;
  // The clipboard API can be missing or refused; selecting the code then leaves ⌘C.
  void (navigator.clipboard?.writeText(code) ?? Promise.reject(new Error('Clipboard is unavailable'))).then(() => {
    setText('github-copy', '已复制');
    setTimeout(() => setText('github-copy', '复制'), 2000);
  }, () => { getSelection()?.selectAllChildren($('github-code')); setText('github-copy', '已选中，按 ⌘C'); });
});
function saveLark(): void {
  void settingsRun('lark', '无法保存飞书凭据', async () => {
    await post('/ui/api/settings/lark', { app_id: field('lark-app-id').value.trim(), app_secret: field('lark-app-secret').value });
    state.larkEdited = false;
    await loadSettings();
    return '凭据已验证并保存';
  });
}
function saveRecipient(): void {
  void settingsRun('recipient', '无法保存接收人', async () => {
    await post('/ui/api/settings/recipient', { open_id: field('lark-recipient').value.trim() });
    await loadSettings();
    return '接收人已保存';
  });
}
$('lark-save').addEventListener('click', saveLark);
$('recipient-save').addEventListener('click', saveRecipient);
for (const id of ['lark-app-id', 'lark-app-secret', 'lark-recipient']) {
  field(id).addEventListener('input', () => { state.larkEdited = true; });
  field(id).addEventListener('keydown', event => { if (event.key === 'Enter') { if (id === 'lark-recipient') saveRecipient(); else saveLark(); } });
}
$('lark-clear').addEventListener('click', () => {
  if (!state.confirmClear) {
    state.confirmClear = true; renderSettings();
    setTimeout(() => { state.confirmClear = false; renderSettings(); }, 4000);
    return;
  }
  state.confirmClear = false;
  void settingsRun('lark', '无法清除飞书凭据', async () => {
    await post('/ui/api/settings/lark', { clear: true });
    state.larkEdited = false;
    await loadSettings();
    return '已清除保存的凭据';
  });
});
$('notification-channel').addEventListener('change', () => { state.channelEdited = true; renderAgents(); });
$('channel-save').addEventListener('click', () => { void saveChannel(); });
function saveChat(channel: ChatChannel): void {
  if (state.settings?.editable !== true || state.pendingSettings.has(channel)) return;
  state.chatEdited[channel] = true; state.confirmChatClear[channel] = false;
  void settingsRun(channel, `无法保存 ${channelNames[channel]} 配置`, async () => {
    await post(`/ui/api/settings/${channel}`, {
      bot_token: field(`${channel}-bot-token`).value.trim(), user_id: field(`${channel}-user-id`).value.trim(),
      ...(channel === 'slack' ? { app_token: field('slack-app-token').value.trim(), channel_id: field('slack-channel-id').value.trim() }
        : { chat_id: field('telegram-chat-id').value.trim() }),
    });
    clearChatTokens(channel); state.chatEdited[channel] = false;
    await Promise.all([loadSettings(), loadAgents()]);
    return `${channelNames[channel]} 配置已验证并保存`;
  });
}
for (const channel of chatChannels) {
  $(`${channel}-save`).addEventListener('click', () => saveChat(channel));
  for (const suffix of chatFields[channel]) {
    const input = field(`${channel}-${suffix}`);
    input.addEventListener('input', () => {
      state.chatEdited[channel] = true;
      if (state.confirmChatClear[channel]) { state.confirmChatClear[channel] = false; renderSettings(); }
    });
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); saveChat(channel); } });
  }
  $(`${channel}-clear`).addEventListener('click', () => {
    if (state.settings?.editable !== true || !state.settings[channel].saved || state.pendingSettings.has(channel)) return;
    if (!state.confirmChatClear[channel]) {
      state.confirmChatClear[channel] = true; renderSettings();
      setTimeout(() => { state.confirmChatClear[channel] = false; renderSettings(); }, 4000);
      return;
    }
    state.confirmChatClear[channel] = false;
    void settingsRun(channel, `无法清除 ${channelNames[channel]} 配置`, async () => {
      await post(`/ui/api/settings/${channel}`, { clear: true });
      clearChatTokens(channel); state.chatEdited[channel] = false;
      await Promise.all([loadSettings(), loadAgents()]);
      return `已清除 ${channelNames[channel]} 配置`;
    });
  });
}
$('export-config').addEventListener('click', () => {
  void settingsRun('export', '无法导出配置', async () => { await post('/ui/api/settings/export'); await loadSettings(); return '配置已导出'; });
});
$('export-reveal').addEventListener('click', () => { void settingsRun('export', '无法打开访达', async () => { await post('/ui/api/settings/reveal'); }); });
$('import-choose').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', () => {
  const input = field('import-file'); const file = input.files?.[0];
  input.value = ''; // The same file can be chosen again after a change to it.
  if (!file) return;
  void settingsRun('import', `无法读取 ${file.name}`, async () => {
    if (file.size > 1024 * 1024) throw new Error('文件超过 1 MiB');
    let content: unknown;
    try { content = JSON.parse(await file.text()); } catch { throw new Error('不是有效的 JSON 文件'); }
    state.importing = { name: file.name, content, summary: await post<ImportSummary>('/ui/api/settings/import', { document: content }) };
  });
});
$('import-cancel').addEventListener('click', () => { state.importing = undefined; renderSettings(); });
$('import-apply').addEventListener('click', () => {
  const importing = state.importing;
  if (!importing) return;
  void settingsRun('import', '无法导入配置', async () => {
    const result = await post<ImportSummary>('/ui/api/settings/import', { document: importing.content, apply: true });
    state.importing = undefined; state.larkEdited = false; state.channelEdited = false;
    for (const channel of chatChannels) { state.chatEdited[channel] = false; state.confirmChatClear[channel] = false; clearChatTokens(channel); }
    await Promise.all([loadSettings(), loadAgents()]);
    return `配置已导入${result.warnings.length ? `；${result.warnings.join('；')}` : ''}`;
  });
});
$('refresh').addEventListener('click', () => { void refreshNow(); });
$('search').addEventListener('input', () => renderLogs(true));
$('pull-search').addEventListener('input', () => renderPulls());
$('repo-search').addEventListener('input', () => renderRepos());
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
  else if (state.view === 'repos') $('repo-search').focus();
  else { if (state.view !== 'logs') location.hash = views.logs.hash; $('search').focus(); }
});

renderAll();
requestAnimationFrame(revealActiveNavigation);
window.addEventListener('resize', revealActiveNavigation);
void loadSnapshot();
void loadAgents();
if (usesPulls(state.view)) void loadPulls();
loadSettingsView();
setInterval(() => { void loadSnapshot(); if (state.view === 'settings-github' && loginActive(state.github?.login)) void loadGitHub(); if (state.view === 'settings-tailscale') void loadTailscale(); }, 2000);
setInterval(() => { if (usesPulls(state.view)) void loadPulls(); }, 10000);
