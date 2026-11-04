import type { LogEntry } from './events.js';
import type { PullRequest, PullSnapshot, RepositoryEntry } from './github.js';
import type { ModuleStatus, PublicSession } from './types.js';
import type { AgentPrompt } from './agents.js';
import type { GitHubLogin } from './github-auth.js';
import type { GitHubSettings, ImportSummary, SettingsPage } from './settings.js';

interface PullSummary { internal: number; upstream: number; followed: number; running: boolean; lastSuccessAt?: string; error?: string }
interface Snapshot {
  time: string; modules: ModuleStatus[]; sessions: PublicSession[]; logs: LogEntry[];
  pulls?: PullSummary; access?: { tailnet_url?: string };
}
type View = 'logs' | 'sessions' | 'agents' | 'pulls-internal' | 'pulls-upstream' | 'repos' | 'settings-github' | 'settings-lark' | 'settings-backup' | 'settings-about';
interface AgentsPage { agents: AgentPrompt[]; editable: boolean; channel?: { name: string; configured: boolean; recipient?: string; groups: number } }
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
  'settings-backup': { hash: '#/settings/backup', group: '设置', title: '导入导出', section: 'settings-view' },
  'settings-about': { hash: '#/settings/about', group: '设置', title: '关于', section: 'settings-view' },
};
const descriptions: Record<string, string> = {
  ready: '服务已启动', lark_ready: '飞书长连接已建立', lark_failed: '飞书连接失败',
  received: '服务收到飞书消息', socket_written: '已写入客户端，等待会话回执', input_accepted: '客户端已接受输入，等待会话回执',
  session_acknowledged: '会话已确认收到', replied: '回复已发回原飞书消息', reply_failed: '发送飞书回复失败',
  delivery_failed: '消息转发失败', ignored: '已跳过此消息', queue_full: '消息队列已满', registered: '本机会话已注册',
  bound: '已保存会话绑定', stopped: '监听已停止', connecting: '正在连接飞书', pin_failed: '绑定消息置顶失败',
  reconnecting: '飞书正在重连', reconnected: '飞书已重新连接', refresh_completed: 'GitHub PR 已刷新', refresh_failed: 'GitHub PR 刷新失败',
  thread_created: '已为会话创建飞书群', thread_reused: '会话已连接飞书群', thread_message: '会话发送了进度消息', thread_failed: '进度消息发送失败',
  prompt_injected: '已写入 agent 提示词', prompt_removed: '已移除 agent 提示词',
  github_login: 'GitHub 已登录', lark_configured: '飞书应用凭据已更新', config_exported: '配置已导出', config_imported: '配置已导入',
  tailnet_listening: 'Tailscale 访问已开启', tailnet_failed: 'Tailscale 监听失败', tailnet_unavailable: 'Tailscale 未运行，仅本机可访问',
};
const reasons: Record<string, string> = {
  session_not_local: '本机不存在该会话', session_archived: '会话已归档', session_offline: '本机会话未运行',
  archive_unknown: '无法确认归档状态', backend_unavailable: '客户端接口未配置或不可用', session_busy: '当前轮次已变化，本次未投递',
  missing_announcement: '群公告没有会话声明', ambiguous_announcement: '群公告有多个会话声明', unsupported_adapter: '尚未支持该客户端',
  sender_not_allowed: '发送者不在允许名单', duplicate: '重复消息', unsupported_message: '暂不处理此消息类型',
  host_mismatch: '会话位于另一台机器', invalid_content: '消息内容无效', delivery_failed: '投递失败',
};
const sourceNames: Record<string, string> = { host: '服务', sessions: '会话', lark: '飞书', pulls: 'GitHub', agents: 'Agents' };
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
  agents: undefined as AgentsPage | undefined, agentsError: '', pendingAgents: new Set<string>(), openPreviews: new Set<string>(),
  settings: undefined as (SettingsPage & { editable: boolean }) | undefined, github: undefined as GitHubSettings | undefined, loadingGitHub: false,
  settingsNote: undefined as { text: string; error: boolean } | undefined, pendingSettings: new Set<string>(),
  larkEdited: false, confirmClear: false, importing: undefined as { name: string; content: unknown; summary: ImportSummary } | undefined,
  update: undefined as UpdateView | undefined, updateLater: '',
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
  if (entry.status === 'replied' || entry.status === 'thread_message') return 'replied';
  if (entry.status === 'socket_written' || entry.status === 'input_accepted') return 'forwarded';
  if (entry.error || entry.status.includes('failed') || entry.status === 'queue_full') return 'error';
  return 'system';
}
const summary = (entry: LogEntry): string => (entry.reason && reasons[entry.reason]) || descriptions[entry.status] || entry.status;
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
    $('pull-empty-detail').textContent = first ? '数据在后台刷新，完成后自动显示。' : all.length ? '换个筛选条件或搜索词。'
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
    const title: Node[] = pull.isDraft ? [node('span', '草稿', 'tag'), document.createTextNode(pull.title)] : [document.createTextNode(pull.title)];
    const meta = [`${pull.repository}#${pull.number}`, pull.author, `${ago(pull.updatedAt)}更新`];
    if (pull.sessions?.length) {
      const names = pull.sessions.map(session => session.name).join('、');
      meta.push(`会话：${names}`);
    }
    link.append(rowMain(title, meta.join(' · ')), sideBlock(reviews[pull.reviewDecision] ?? { label: '暂无审查结论', tone: 'muted' }, ciSummary(pull)));
    item.append(link); return item;
  }));
}

// ---- Followed repositories ----
function repoMeta(entry: RepositoryEntry): string {
  const parts: string[] = [];
  if (entry.agents.length) parts.push(entry.agents.map(agent => agentNames[agent] ?? agent).join('、'));
  if (entry.sessions) parts.push(`${entry.sessions} 个会话`);
  if (entry.linkedPulls) parts.push(`关联 PR ${entry.linkedPulls} 个`);
  parts.push(entry.allPulls ? '仓库订阅' : '关联 PR 订阅');
  if (entry.lastActive) parts.push(`最近活跃${ago(entry.lastActive)}`);
  if (!parts.length) parts.push('未在本机对话中出现');
  return parts.join(' · ');
}
function repoSide(entry: RepositoryEntry): HTMLElement {
  const total = entry.pulls.internal + entry.pulls.upstream;
  const counts = [entry.pulls.internal ? `我们仓库 ${entry.pulls.internal}` : '', entry.pulls.upstream ? `上游 ${entry.pulls.upstream}` : ''].filter(Boolean).join(' · ');
  const mode = entry.choice === 'follow' ? '手动关注' : entry.choice === 'mute' ? '手动取消' : entry.followed ? '自动关注' : '未关注';
  return sideBlock(total ? { label: `${total} 个 PR`, tone: entry.followed ? 'info' : 'muted' } : { label: '无打开的 PR', tone: 'muted' }, counts ? `${counts} · ${mode}` : mode);
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
  if (!visible.length) {
    $('repo-empty-title').textContent = !state.pulls ? '正在读取仓库' : entries.length ? '没有匹配的仓库' : '还没有发现仓库';
    $('repo-empty-detail').textContent = entries.length ? '换个筛选条件或搜索词。' : '后台刷新会读取本机 Claude、Codex、OpenCode 对话的工作目录和 GitHub PR。';
  }
  if (!changed('repo-rows', [visible, [...state.pendingRepos]])) return;
  replaceRows($('repo-rows'), visible.map(entry => {
    const item = node('div', undefined, 'entry'); item.setAttribute('role', 'listitem');
    const row = node('label', undefined, 'row');
    const box = node('input', undefined, 'check'); box.type = 'checkbox'; box.checked = entry.followed;
    box.disabled = state.pendingRepos.has(entry.repository); box.dataset.key = entry.repository;
    box.setAttribute('aria-label', `关注 ${entry.repository}`);
    box.addEventListener('change', () => { void setFollow(entry, box.checked); });
    row.append(box, rowMain(entry.repository, repoMeta(entry)), repoSide(entry));
    item.append(row);
    if (entry.sources.length) {
      const extra = node('div', undefined, 'agent-extra');
      const details = node('details'); details.open = state.openRepoSources.has(entry.repository);
      details.addEventListener('toggle', () => { if (details.open) state.openRepoSources.add(entry.repository); else state.openRepoSources.delete(entry.repository); });
      const summary = node('summary', `来源会话 · ${entry.sources.length}`); summary.dataset.key = `sources:${entry.repository}`;
      const list = node('div', undefined, 'session-sources');
      for (const source of entry.sources) {
        const item = node('div', undefined, 'session-source');
        item.append(node('strong', source.name), node('span', [adapters[source.adapter], source.fromRepository ? '会话仓库' : '关联 PR', source.branch, source.archived ? '已归档' : ''].filter(Boolean).join(' · '), 'source-meta'), node('span', source.id, 'mono source-id'));
        if (source.pulls.length) {
          const links = node('div', undefined, 'source-links');
          for (const pull of source.pulls) {
            const link = node('a', `#${pull.number}`); link.href = pull.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = pull.url; links.append(link);
          }
          item.append(links);
        }
        list.append(item);
      }
      details.append(summary, list); extra.append(details); item.append(extra);
    }
    return item;
  }));
}

// ---- Agents ----
const home = (path: string): string => path.replace(/^(?:\/Volumes\/[^/]+)?\/(?:Users|home)\/[^/]+(?=\/)/, '~');
function agentDetail(agent: AgentPrompt): string {
  if (agent.status === 'missing') return '尚未创建提示词，勾选后自动创建';
  if (agent.status === 'conflict') return '文件里的 nootify 标记不成对，请先手动修正';
  if (agent.status === 'error') return agent.error ?? '无法读取文件';
  if (agent.status === 'outdated') return '写入内容与当前版本不同';
  return agent.injected ? '新对话会按说明使用飞书' : '勾选后写入飞书说明';
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
function renderAgents(): void {
  const page = state.agents;
  $('agents-count').textContent = page ? String(page.agents.filter(agent => agent.injected).length || '') : '';
  const remote = page && !page.editable;
  const banner = state.agentsError || (remote ? '通过 Tailscale 访问时只能查看；请在这台 Mac 上修改 agent 提示词。' : '');
  $('agents-banner').hidden = !banner; $('agents-banner').textContent = banner;
  const channel = page?.channel;
  $('channel-sub').textContent = !channel ? '飞书模块未启用' : !channel.configured ? '未配置飞书应用凭据，提示词写入后也无法建群：到「设置 · 飞书」配置'
    : channel.recipient ? `接收人 ${channel.recipient.slice(0, 7)}…${channel.recipient.slice(-4)} · 已绑定 ${channel.groups} 个群` : '还没有设置接收人：到「设置 · 飞书」填写';
  $('channel-side').textContent = 'Slack 等渠道之后支持';
  if (state.view !== 'agents' || !page) return;
  if (!changed('agent-rows', [page, [...state.pendingAgents]])) return;
  replaceRows($('agent-rows'), page.agents.map(agent => {
    const item = node('div', undefined, 'entry'); item.setAttribute('role', 'listitem');
    const row = node('label', undefined, 'row');
    const box = node('input', undefined, 'check'); box.type = 'checkbox'; box.checked = agent.injected; box.dataset.key = agent.agent;
    box.disabled = remote || state.pendingAgents.has(agent.agent) || ['conflict', 'error'].includes(agent.status);
    box.setAttribute('aria-label', `向 ${agent.name} 写入飞书说明`);
    box.addEventListener('change', () => { void setAgent(agent, box.checked); });
    row.append(box, rowMain(agent.name, `${home(agent.file)} · ${agentDetail(agent)}`), sideBlock(promptStates[agent.status] ?? promptStates.error));
    const extra = node('div', undefined, 'agent-extra');
    if (agent.status === 'outdated' && !remote) {
      const update = node('button', '更新为当前内容', 'text-button'); update.type = 'button';
      update.disabled = state.pendingAgents.has(agent.agent);
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
const loginActive = (login?: GitHubLogin): boolean => login?.status === 'starting' || login?.status === 'waiting';
/** Skips unchanged text, so polling never clears a selection such as the device code. */
function setText(id: string, text: string): void { if ($(id).textContent !== text) $(id).textContent = text; }
function setTone(id: string, tone: Tone): void { setText(id, tone.label); $(id).className = `tone-${tone.tone}`; }
const field = (id: string): HTMLInputElement => $<HTMLInputElement>(id);
async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'x-nootify-ui': '1', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`);
  return await response.json() as T;
}
function fillLark(): void {
  const lark = state.settings?.lark;
  field('lark-app-id').value = lark?.app_id ?? '';
  field('lark-app-secret').value = '';
  field('lark-recipient').value = lark?.recipient ?? '';
}
async function loadSettings(): Promise<void> {
  try {
    const response = await fetch('/ui/api/settings', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(response.status === 404 ? '设置模块未启用' : `HTTP ${response.status}`);
    state.settings = await response.json() as SettingsPage & { editable: boolean };
    if (!state.larkEdited) fillLark();
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
function loadSettingsView(): void {
  if (!isSettingsView(state.view)) return;
  void loadSettings();
  if (state.view === 'settings-github') void loadGitHub();
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
  if (!account.installed) return { text: '没有找到 GitHub CLI：先安装 gh（brew install gh），或设置绝对路径 GH_BIN', tone: { label: '未安装', tone: 'error' } };
  if (account.signedIn) return { text: `${account.login} · 和终端里的 gh 共用`, tone: { label: '已登录', tone: 'ok' } };
  if (account.error) return { text: `无法确认登录状态：${account.error}`, tone: { label: '未确认', tone: 'warn' } };
  return { text: '登录后才能读取 PR 和订阅', tone: { label: '未登录', tone: 'warn' } };
}
function renderGitHub(remote: boolean): void {
  const github = state.github; const login = github?.login;
  const active = loginActive(login); const waiting = login?.status === 'waiting';
  const status = githubStatus();
  setText('github-status', status.text); setTone('github-state', status.tone);
  const start = $<HTMLButtonElement>('github-login');
  start.hidden = remote || !github || active || github.account?.installed === false;
  start.disabled = state.pendingSettings.has('github');
  setText('github-login', github?.account?.signedIn ? '重新登录' : '登录');
  $('github-flow').hidden = !active || remote;
  setText('github-flow-title', waiting ? '在 GitHub 页面输入这个验证码' : '正在向 GitHub 申请验证码…');
  setText('github-flow-sub', waiting && login?.expiresAt ? `${clock(login.expiresAt)} 前有效，授权后这里会自动更新` : '');
  setText('github-code', login?.code ?? '');
  $('github-copy').hidden = !waiting;
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
function importLines(summary: ImportSummary): string[] {
  const lines: string[] = [];
  if (summary.app_id) lines.push(`飞书应用 ${summary.app_id} 和它的 App Secret`);
  if (summary.recipient) lines.push(`飞书接收人 ${summary.recipient}`);
  if (summary.pulls_config) lines.push('GitHub PR 配置');
  if (summary.follow !== undefined) lines.push(`用文件里的 ${summary.follow} 条选择替换现有的仓库关注选择`);
  if (summary.backends.length) lines.push(`${summary.backends.map(adapter => adapters[adapter] ?? adapter).join('、')} 连接`);
  if (summary.agents.length) lines.push(`启用 ${summary.agents.map(agent => agentNames[agent] ?? agent).join('、')} 的飞书说明`);
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
  const note = state.settingsNote ?? (state.view === 'settings-github' && login?.status === 'failed' ? { text: `GitHub 登录失败：${login.error}`, error: true }
    : remote ? { text: '通过 Tailscale 访问时只能查看；请在这台 Mac 上修改设置。', error: false } : undefined);
  const banner = $('settings-banner');
  banner.hidden = !note; banner.className = note && !note.error ? 'banner note' : 'banner';
  setText('settings-banner', note?.text ?? '');
  renderGitHub(remote); renderLark(remote); renderBackup(remote);
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
function paintProgress(id: string, update: UpdateView): void {
  const bar = $<HTMLProgressElement>(id);
  bar.hidden = update.phase !== 'downloading';
  if (update.phase !== 'downloading') return;
  if (update.total) bar.value = Math.min(1, update.received / update.total); else bar.removeAttribute('value');
}
function renderUpdate(): void {
  const update = state.update;
  const available = update?.phase === 'available';
  const working = !!update && ['downloading', 'installing', 'restarting'].includes(update.phase);
  for (const dot of document.querySelectorAll<HTMLElement>('.update-dot')) dot.hidden = !available;
  const prompted = working || (available && state.updateLater !== update.version);
  $('update-banner').hidden = !prompted || state.view === 'settings-about';
  $('update-banner-install').hidden = !available; $('update-banner-later').hidden = !available;
  if (update && prompted) { setText('update-banner-text', updateStatus(update)); paintProgress('update-banner-progress', update); }
  const service = state.settings?.version;
  setText('about-version', [update ? `应用 ${update.current}` : '', service ? `后台服务 ${service}` : ''].filter(Boolean).join(' · ') || '—');
  setText('update-status', update ? updateStatus(update) : '在 Nootify 桌面应用里检查和安装更新');
  const check = $<HTMLButtonElement>('update-check');
  check.hidden = !update; check.disabled = working || update?.phase === 'checking';
  $('update-install').hidden = !available;
  if (update) { setText('update-install', `安装 ${updateTag(update)}`); paintProgress('update-progress', update); }
}

// ---- Chrome, loading and events ----
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
    state.pullsError = '';
  } catch (error) { state.pullsError = (error as Error).message; }
  finally { state.loadingPulls = false; renderChrome(); renderPulls(); renderRepos(); }
}
async function refreshNow(): Promise<void> {
  if (state.view === 'agents') { await Promise.all([loadSnapshot(), loadAgents()]); return; }
  if (isSettingsView(state.view)) {
    await Promise.all([loadSnapshot(), loadSettings(), ...(state.view === 'settings-github' ? [loadGitHub()] : [])]);
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
  renderAll();
  if (usesPulls(state.view)) void loadPulls();
  if (state.view === 'agents') void loadAgents();
  loadSettingsView();
  $(views[state.view].section).scrollTop = 0;
});
window.addEventListener('nootify-update', event => { state.update = (event as CustomEvent<UpdateView>).detail; renderUpdate(); });
$('update-banner-install').addEventListener('click', () => askNative('install'));
$('update-install').addEventListener('click', () => askNative('install'));
$('update-check').addEventListener('click', () => askNative('check'));
$('update-banner-later').addEventListener('click', () => { state.updateLater = state.update?.version ?? ''; renderUpdate(); });
$('github-login').addEventListener('click', () => {
  void settingsRun('github', '无法开始登录', async () => {
    state.github = { account: state.github?.account, login: await post<GitHubLogin>('/ui/api/settings/github/login', { action: 'start' }) };
  });
});
$('github-cancel').addEventListener('click', () => {
  void settingsRun('github', '无法取消登录', async () => { await post('/ui/api/settings/github/login', { action: 'cancel' }); await loadGitHub(); });
});
$('github-copy').addEventListener('click', () => {
  const code = state.github?.login.code;
  if (!code) return;
  // The clipboard API exists only in secure contexts; gh has usually copied the code already.
  void (navigator.clipboard?.writeText(code) ?? Promise.reject(new Error('Clipboard is unavailable'))).then(() => {
    setText('github-copy', '已复制');
    setTimeout(() => setText('github-copy', '复制'), 2000);
  }, () => setText('github-copy', '请手动复制'));
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
    state.importing = undefined; state.larkEdited = false;
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
void loadSnapshot();
void loadAgents();
if (usesPulls(state.view)) void loadPulls();
loadSettingsView();
setInterval(() => { void loadSnapshot(); if (state.view === 'settings-github' && loginActive(state.github?.login)) void loadGitHub(); }, 2000);
setInterval(() => { if (usesPulls(state.view)) void loadPulls(); }, 10000);
