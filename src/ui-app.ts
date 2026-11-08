import { t, locale, number, list as formatList, translateDocument, languagePreference, setLanguage, isPreference, languageStorageKey, type NativeLanguage } from './ui-i18n.js';
import type { LogEntry } from './events.js';
import type { PullRequest, PullSnapshot, RepositoryEntry } from './github.js';
import type { ModuleStatus, PublicSession } from './types.js';
import type { AgentPrompt } from './agents.js';
import type { GitHubLogin } from './github-auth.js';
import type { GitHubSettings, ImportSummary, SettingsPage, LarkRecipientsPage } from './settings.js';
import type { TailscalePage } from './tailscale.js';
import type { LarkPermissionHelp } from './lark-permissions.js';
import type { LarkRegistrationPage, LarkSetup } from './lark-registration.js';
import type { LarkConnectionType } from './state.js';
import { mergeRecipients, recipientDisplayName } from './lark-profile.js';
import { RecipientListRenderer } from './recipient-list.js';

interface PullSummary { internal: number; upstream: number; followed: number; running: boolean; lastSuccessAt?: string; error?: string; signedOut?: boolean }
interface Snapshot {
  time: string; modules: ModuleStatus[]; sessions: PublicSession[]; logs: LogEntry[];
  pulls?: PullSummary; access?: { tailnet_url?: string };
}
type View = 'logs' | 'sessions' | 'agents' | 'pulls-internal' | 'pulls-upstream' | 'repos' | 'settings-general' | 'settings-github' | 'settings-lark' | 'settings-tailscale' | 'settings-backup' | 'settings-about';
interface AgentsPage { agents: AgentPrompt[]; editable: boolean; channel?: { name: 'feishu'; configured: boolean; recipient?: string; groups: number } }
interface Tone { label: string; tone: string }
type TranslatedText = string | (() => string);
const resolveText = (value?: TranslatedText): string => typeof value === 'function' ? value() : value ?? '';
/** Pushed by the desktop shell as a `nootify-update` event; mirrors `UpdateView` in src-tauri/src/update.rs. A plain browser never receives it. */
interface UpdateView {
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'installing' | 'restarting' | 'failed';
  current: string; version: string | null; received: number; total: number | null; error: string | null; checked_at: number | null;
}

function translatedLabels() {
  const views: Record<View, { hash: string; group: string; title: string; section: string }> = {
    logs: { hash: '#/logs', group: t('消息桥接'), title: t('运行日志'), section: 'logs-view' },
    sessions: { hash: '#/sessions', group: t('消息桥接'), title: t('路由会话'), section: 'sessions-view' },
    agents: { hash: '#/agents', group: t('消息桥接'), title: 'Agents', section: 'agents-view' },
    'pulls-internal': { hash: '#/pulls/internal', group: 'GitHub', title: t('我们仓库的 PR'), section: 'pulls-view' },
    'pulls-upstream': { hash: '#/pulls/upstream', group: 'GitHub', title: t('提交上游的 PR'), section: 'pulls-view' },
    repos: { hash: '#/repos', group: 'GitHub', title: t('PR 订阅'), section: 'repos-view' },
    'settings-general': { hash: '#/settings/general', group: t('设置'), title: t('通用'), section: 'settings-view' },
    'settings-github': { hash: '#/settings/github', group: t('设置'), title: 'GitHub', section: 'settings-view' },
    'settings-lark': { hash: '#/settings/lark', group: t('设置'), title: t('飞书'), section: 'settings-view' },
    'settings-tailscale': { hash: '#/settings/tailscale', group: t('设置'), title: 'Tailscale', section: 'settings-view' },
    'settings-backup': { hash: '#/settings/backup', group: t('设置'), title: t('导入导出'), section: 'settings-view' },
    'settings-about': { hash: '#/settings/about', group: t('设置'), title: t('关于'), section: 'settings-view' },
  };
  const descriptions: Record<string, string> = {
    ready: t('服务已启动'), lark_ready: t('飞书消息接收已启动'), lark_failed: t('飞书连接失败'), lark_discovery_failed: t('飞书群聊发现失败'),
    received: t('收到用户消息'), socket_written: t('用户消息已转发'), input_accepted: t('用户消息已转发'),
    inbox_queued: t('用户消息已排队'),
    session_acknowledged: t('会话已接收消息'), replied: t('会话回复已发送'), reply_failed: t('会话回复发送失败'), reaction_failed: t('添加消息表情失败'),
    delivery_unconfirmed: t('用户消息投递未确认'), state_write_failed: t('状态保存失败'),
    delivery_failed: t('用户消息转发失败'), ignored: t('用户消息已忽略'), queue_full: t('用户消息排队失败'), registered: t('本机会话已注册'),
    bound: t('已保存会话绑定'), stopped: t('监听已停止'), connecting: t('正在连接消息服务'), pin_failed: t('绑定消息置顶失败'),
    reconnecting: t('消息服务正在重连'), reconnected: t('消息服务已重新连接'), refresh_completed: t('GitHub PR 已刷新'), refresh_failed: t('GitHub PR 刷新失败'),
    thread_created: t('已为会话创建消息桥接'), thread_reused: t('会话已连接消息桥接'), thread_message: t('进度已发送'), thread_failed: t('进度消息发送失败'),
    prompt_injected: t('已写入 agent 提示词'), prompt_removed: t('已移除 agent 提示词'),
    github_login: t('GitHub 已登录'), github_logout: t('GitHub 已退出登录'), lark_configured: t('飞书应用凭据已更新'), config_exported: t('配置已导出'), config_imported: t('配置已导入'),
    lark_registration_complete: t('应用已保存'), lark_registration_failed: t('扫码配置未完成'),
    tailnet_listening: t('Tailscale 访问已开启'), tailnet_failed: t('Tailscale 监听失败'), tailnet_unavailable: t('Tailscale 未运行，仅本机可访问'),
  };
  const reasons: Record<string, string> = {
    session_not_local: t('本机不存在该会话'), session_archived: t('会话已归档'), session_offline: t('本机会话未运行'),
    archive_unknown: t('无法确认归档状态'), backend_unavailable: t('客户端接口未配置或不可用'), session_busy: t('当前轮次已变化，本次未投递'),
    missing_announcement: t('群公告没有会话声明'), ambiguous_announcement: t('群公告有多个会话声明'), unsupported_adapter: t('尚未支持该客户端'),
    app_mismatch: t('该群属于另一个飞书应用'), sender_not_allowed: t('发送者不在允许名单'), duplicate: t('重复消息'), unsupported_message: t('暂不处理此消息类型'),
    host_mismatch: t('会话位于另一台机器'), invalid_content: t('消息内容无效'), delivery_failed: t('投递失败'), input_rejected: t('客户端拒绝此输入'),
  };
  const sourceNames: Record<string, string> = { host: t('服务'), sessions: t('会话'), lark: t('飞书'), pulls: 'GitHub', agents: 'Agents' };
  const categories: Record<string, Tone> = {
    incoming: { label: t('用户消息'), tone: 'muted' }, progress: { label: t('会话进度'), tone: 'muted' }, reply: { label: t('会话回复'), tone: 'muted' },
    system: { label: t('连接与系统'), tone: 'muted' }, ignored: { label: t('已忽略'), tone: 'muted' }, error: { label: t('异常'), tone: 'error' },
  };
  const outcomeTabs: [string, string][] = [['all', t('全部')], ...['incoming', 'progress', 'reply', 'system', 'ignored', 'error'].map(value => [value, categories[value].label] as [string, string])];
  const pullTabs: [string, string][] = [['all', t('全部')], ['attention', t('需跟进')], ['draft', t('草稿')]];
  const repoTabs: [string, string][] = [['all', t('全部')], ['followed', t('已关注')], ['muted', t('未关注')]];
  const agentNames: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', trae: 'Trae', workbuddy: 'WorkBuddy' };
  const promptStates: Record<string, Tone> = {
    current: { label: t('已注入'), tone: 'ok' }, outdated: { label: t('需要更新'), tone: 'warn' }, absent: { label: t('未注入'), tone: 'muted' },
    missing: { label: t('未配置'), tone: 'muted' }, conflict: { label: t('标记不完整'), tone: 'error' }, error: { label: t('无法读取'), tone: 'error' },
  };
  const adapters: Record<string, string> = { 'claude-desktop': 'Claude Desktop', 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode', trae: 'Trae', workbuddy: 'WorkBuddy' };
  const availability: Record<string, Tone> = {
    active: { label: t('可投递'), tone: 'ok' }, archived: { label: t('已归档'), tone: 'muted' }, offline: { label: t('未运行'), tone: 'warn' },
    unknown: { label: t('未确认'), tone: 'warn' }, missing: { label: t('本机不存在'), tone: 'muted' },
  };
  const reviews: Record<string, Tone> = {
    APPROVED: { label: t('已批准'), tone: 'ok' }, CHANGES_REQUESTED: { label: t('需要修改'), tone: 'error' }, REVIEW_REQUIRED: { label: t('待审查'), tone: 'warn' },
  };
  const moduleNames: Record<string, string> = { sessions: t('会话'), lark: t('飞书'), pulls: 'GitHub' };
  const moduleStates: Record<string, Tone> = {
    ready: { label: t('就绪'), tone: 'ok' }, idle: { label: t('等待刷新'), tone: 'warn' }, refreshing: { label: t('刷新中'), tone: 'warn' },
    stale: { label: t('刷新失败'), tone: 'error' }, error: { label: t('异常'), tone: 'error' }, failed: { label: t('异常'), tone: 'error' },
    connecting: { label: t('连接中'), tone: 'warn' }, reconnecting: { label: t('重连中'), tone: 'warn' }, disabled: { label: t('未启用'), tone: 'muted' }, stopped: { label: t('已停止'), tone: 'muted' },
    signed_out: { label: t('未登录'), tone: 'warn' },
  };
  const credentialSources: Record<string, string> = { environment: t('环境变量'), settings: t('这里保存的凭据'), 'mcp-config': t('MCP 配置文件') };
  const githubErrors: Record<string, string> = {
    access_denied: t('已在 GitHub 上拒绝授权'), expired_token: t('验证码已过期，请重新登录'), device_flow_disabled: t('GitHub OAuth App 没有开启 Device Flow'),
    'Not Found': t('GitHub 找不到这个 OAuth App，请检查 Client ID'), missing_client_id: t('这个版本没有配置 GitHub OAuth Client ID'),
  };
  const tailscaleErrors: Record<string, string> = {
    embedded_client_missing: t('内置 Tailscale 客户端不可用，请重新安装完整的 Nootify 应用。'),
    embedded_client_stopped: t('Nootify 节点已离线，正在自动重连。'),
    embedded_protocol_error: t('内置客户端响应异常，请重新启动 Nootify。'),
    embedded_request_timeout: t('连接超时，请检查网络后重试。'),
    embedded_request_failed: t('无法完成操作，请检查网络后重试。'),
    state_locked: t('这个 Nootify 节点正在被另一个进程使用，请关闭重复运行的 Nootify。'),
    state_unavailable: t('无法读取 Nootify 节点的登录信息，请检查本机存储权限。'),
    listener_failed: t('无法开启 Nootify 节点的访问端口，请重新连接。'),
    startup_failed: t('内置 Tailscale 节点启动失败，请重新连接。'),
    client_unavailable: t('无法连接内置 Tailscale 客户端，请重启 Nootify。'),
    status_failed: t('暂时无法读取节点状态，正在重试。'),
    busy: t('内置客户端忙碌，正在重试。'),
    timeout: t('连接超时，请检查网络后重试。'),
  };
  return { views, descriptions, reasons, sourceNames, categories, outcomeTabs, pullTabs, repoTabs, agentNames, promptStates, adapters, availability, reviews, moduleNames, moduleStates, credentialSources, githubErrors, tailscaleErrors };
}
let { views, descriptions, reasons, sourceNames, categories, outcomeTabs, pullTabs, repoTabs, agentNames, promptStates, adapters, availability, reviews, moduleNames, moduleStates, credentialSources, githubErrors, tailscaleErrors } = translatedLabels();

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
  pullsError: '' as TranslatedText,
  outcome: 'all', pullFilter: 'all', pullSort: 'asc' as 'asc' | 'desc', repoFilter: 'all',
  pendingRepos: new Set<string>(), repoError: '' as TranslatedText, openRepoSources: new Set<string>(),
  agents: undefined as AgentsPage | undefined, agentsError: '' as TranslatedText, pendingAgents: new Set<string>(), openPreviews: new Set<string>(),
  settings: undefined as (SettingsPage & { editable: boolean }) | undefined, github: undefined as GitHubSettings | undefined, loadingGitHub: false,
  tailscale: undefined as (TailscalePage & { editable: boolean }) | undefined, loadingTailscale: false, tailscaleError: '' as TranslatedText,
  settingsNote: undefined as { text: TranslatedText; error: boolean; source?: 'settings-read' } | undefined, pendingSettings: new Set<string>(),
  larkConnectionType: undefined as LarkConnectionType | undefined,
  larkRegistration: undefined as LarkRegistrationPage | undefined, loadingLarkRegistration: false, larkManual: false,
  larkSetup: undefined as LarkSetup | undefined, loadingLarkSetup: false, larkReconcilePending: false,
  larkEdited: false, confirmClear: false, importing: undefined as { name: string; content: unknown; summary: ImportSummary } | undefined,
  recipientDirectory: undefined as LarkRecipientsPage | undefined, recipientPicker: false, loadingRecipients: false, recipientError: undefined as number | undefined,
  recipientRequest: undefined as AbortController | undefined, recipientLoadedAt: 0, recipientDraft: '', recipientActive: '',
  recipientPermission: undefined as LarkPermissionHelp | undefined, recipientPermissionOpen: false, recipientSaveError: '', failedAvatars: new Set<string>(),
  update: undefined as UpdateView | undefined,
  paused: false, loading: false, loadingPulls: false, connected: false, connectionError: undefined as string | undefined,
  expanded: new Set<string>(),
  signatures: new Map<string, string>(),
};

let relative = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
function ago(value?: string): string {
  if (!value) return '—';
  const seconds = (Date.parse(value) - Date.now()) / 1000;
  if (!Number.isFinite(seconds)) return '—';
  if (Math.abs(seconds) < 45) return t('刚刚');
  const units: [Intl.RelativeTimeFormatUnit, number][] = [['minute', 60], ['hour', 3600], ['day', 86400], ['month', 2592000], ['year', 31536000]];
  let [unit, size] = units[0];
  for (const [candidate, length] of units) if (Math.abs(seconds) >= length) [unit, size] = [candidate, length];
  return relative.format(Math.round(seconds / size), unit);
}
const clock = (value: string): string => new Date(value).toLocaleTimeString(locale(), { hour12: false });
const fullTime = (value: string): string => new Date(value).toLocaleString(locale(), { hour12: false });
/** Re-render only when the visible content (or the minute used by relative times) changes. */
function changed(key: string, value: unknown): boolean {
  const signature = JSON.stringify([locale(), value, Math.floor(Date.now() / 30000)]);
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
    button.append(node('span', label), node('span', number(count), 'count'));
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
  if (entry.error || entry.status.includes('failed') || entry.status === 'queue_full' || entry.status === 'delivery_unconfirmed' || entry.reason === 'input_rejected') return 'error';
  if (entry.status === 'ignored') return 'ignored';
  if (['received', 'socket_written', 'input_accepted', 'inbox_queued', 'session_acknowledged'].includes(entry.status)) return 'incoming';
  if (entry.status === 'thread_message') return 'progress';
  if (entry.status === 'replied') return 'reply';
  return 'system';
}
type LogType = 'incoming' | 'progress' | 'reply' | 'system';
function logType(entry: LogEntry): LogType {
  if (entry.status === 'thread_message' || entry.status === 'thread_failed') return 'progress';
  if (entry.status === 'replied' || entry.status === 'reply_failed') return 'reply';
  if (['received', 'socket_written', 'input_accepted', 'inbox_queued', 'session_acknowledged', 'ignored', 'delivery_failed', 'delivery_unconfirmed', 'queue_full'].includes(entry.status) || entry.reason === 'input_rejected') return 'incoming';
  return 'system';
}
function logTypeLabel(entry: LogEntry): string {
  switch (logType(entry)) {
    case 'incoming': return t('用户消息');
    case 'progress': return t('会话进度');
    case 'reply': return t('会话回复');
    case 'system': return t('系统');
  }
}
function logAction(entry: LogEntry): string {
  if (entry.status === 'delivery_unconfirmed') return t('投递未确认');
  if (category(entry) === 'error') return t('失败');
  switch (entry.status) {
    case 'received': return t('已收件');
    case 'socket_written': case 'input_accepted': return t('已转发');
    case 'inbox_queued': return t('已排队');
    case 'session_acknowledged': return t('已确认');
    case 'thread_message': return t('已发送');
    case 'replied': return t('已回复');
    case 'ignored': return t('已忽略');
    case 'thread_created': return t('已创建');
    case 'thread_reused': return t('已复用');
  }
  const status = entry.status.replace(/^lark_/, '');
  if (status === 'ready') return t('已连接');
  return moduleStates[status]?.label ?? t('已记录');
}
function summary(entry: LogEntry): string {
  if (entry.reason === 'input_rejected') return t('用户消息转发失败');
  if (source(entry) === 'lark') {
    if (entry.status === 'thread_created') return t('已为会话创建{p0}', { p0: t('飞书群') });
    if (entry.status === 'thread_reused') return t('会话已连接{p0}', { p0: t('飞书群') });
  }
  return descriptions[entry.status] || entry.status;
}
function sessionLabel(entry: LogEntry): string | undefined {
  return entry.session_name || state.snapshot.sessions.find(session => session.session_id === entry.session_id)?.session_name || entry.session_id;
}
function logRoute(entry: LogEntry): string {
  const provider = sourceNames[source(entry)] ?? source(entry);
  const session = state.snapshot.sessions.find(session => session.session_id === entry.session_id);
  const client = session ? adapters[session.adapter] ?? session.adapter : t('会话客户端');
  if (['thread_message', 'thread_failed', 'replied', 'reply_failed'].includes(entry.status)) return t('{p0} → {p1}', { p0: client, p1: provider });
  if (['received', 'socket_written', 'input_accepted', 'inbox_queued', 'session_acknowledged', 'delivery_failed', 'delivery_unconfirmed', 'queue_full', 'ignored'].includes(entry.status)) return t('{p0} → {p1}', { p0: provider, p1: client });
  return provider;
}
function logSubject(entry: LogEntry): string {
  return entry.preview?.trim() ? entry.preview : sessionLabel(entry) ?? summary(entry);
}
function filteredLogs(outcome = state.outcome): LogEntry[] {
  const query = $<HTMLInputElement>('search').value.trim().toLocaleLowerCase();
  return state.snapshot.logs.filter(entry => (outcome === 'all' || (outcome === 'ignored' || outcome === 'error' ? category(entry) === outcome : logType(entry) === outcome)) &&
    (!query || [JSON.stringify(entry), sessionLabel(entry) ?? '', logSubject(entry), summary(entry), logRoute(entry), logAction(entry), logTypeLabel(entry), categories[category(entry)].label].join(' ').toLocaleLowerCase().includes(query)));
}
function logDetails(entry: LogEntry): HTMLElement {
  const box = node('div', undefined, 'details'); box.id = `log-details-${encodeURIComponent(entry.id)}`;
  const grid = node('dl', undefined, 'detail-grid');
  const fields: [string, string | undefined, boolean][] = [
    [t('事件说明'), summary(entry), false], [t('消息方向'), logRoute(entry), false], [t('投递状态'), logAction(entry), false],
    [t('时间'), fullTime(entry.time), false], [t('事件'), entry.status, true], [t('来源'), entry.source, true], [t('会话'), entry.session_id, true], [t('会话名称'), entry.session_name || state.snapshot.sessions.find(session => session.session_id === entry.session_id)?.session_name, false],
    [t('聊天 ID'), entry.chat_id, true], [t('消息 ID'), entry.message_id, true], [t('发送者 ID'), entry.sender_open_id, true], [t('回复 ID'), entry.reply_id, true],
    [t('原因'), entry.reason && reasons[entry.reason] ? t('{p0}（{p1}）', { p0: reasons[entry.reason], p1: entry.reason }) : entry.reason, false], [t('错误'), entry.error, false], [t('消息内容'), entry.preview, false],
  ];
  for (const [label, value, mono] of fields) if (value) grid.append(node('dt', label), node('dd', value, mono ? 'mono' : undefined));
  box.append(grid); return box;
}
function renderLogs(force = false): void {
  const matching = filteredLogs('all');
  const counts: Record<string, number> = { all: matching.length };
  for (const entry of matching) {
    const type = logType(entry); counts[type] = (counts[type] ?? 0) + 1;
    const action = category(entry);
    if (action === 'ignored' || action === 'error') counts[action] = (counts[action] ?? 0) + 1;
  }
  renderTabs('outcome-tabs', outcomeTabs.map(([value, label]) => [value, label, counts[value] ?? 0]), state.outcome, value => {
    state.outcome = value; renderLogs(true);
  });
  const total = state.snapshot.logs.length;
  $('logs-count').textContent = total ? number(total) : '';
  $('logs-count').title = total ? t('{p0} 条日志', { p0: number(total) }) : '';
  if (state.paused && !force) return;
  const entries = filteredLogs();
  $('empty').hidden = entries.length > 0;
  if (!changed('logs', [entries, state.snapshot.sessions.map(session => [session.session_id, session.session_name]), [...state.expanded]]) && !force) return;
  replaceRows($('logs-table'), entries.map(entry => {
    const item = node('div', undefined, 'entry'); item.setAttribute('role', 'listitem');
    const open = state.expanded.has(entry.id);
    const row = node('button', undefined, 'row log-row'); row.type = 'button'; row.dataset.key = entry.id;
    row.dataset.category = category(entry); row.dataset.status = entry.status;
    row.setAttribute('aria-expanded', String(open)); row.setAttribute('aria-controls', `log-details-${encodeURIComponent(entry.id)}`); row.title = fullTime(entry.time);
    const label = node('span', logTypeLabel(entry), 'log-type'); label.dataset.type = logType(entry);
    const subject = node('span', logSubject(entry), 'row-title log-subject'); subject.title = subject.textContent ?? '';
    row.append(label, subject, node('span', logAction(entry), 'log-action'), chevron());
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
  $('session-count').textContent = sessions.length ? number(sessions.length) : '';
  $('no-sessions').hidden = sessions.length > 0;
  if (!changed('sessions', sessions)) return;
  replaceRows($('sessions-body'), sessions.map(session => {
    const item = node('div', undefined, 'entry'); item.setAttribute('role', 'listitem');
    const row = node('div', undefined, 'row');
    const meta = [adapters[session.adapter] ?? session.adapter, session.session_id, session.last_seen ? t('最近查找 {p0}', { p0: ago(session.last_seen) }) : undefined].filter(Boolean).join(' · ');
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
  if (!pull.ci.total) add(t('无 CI'));
  else {
    add(`✓ ${pull.ci.passed}`, pull.ci.failed ? undefined : 'ok');
    if (pull.ci.failed) add(`✗ ${pull.ci.failed}`, 'error');
    if (pull.ci.pending) add(`◌ ${pull.ci.pending}`, 'warn');
  }
  if (pull.mergeable === 'CONFLICTING') { parts.push(document.createTextNode(' · ')); parts.push(node('span', t('有冲突'), 'tone-error')); }
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
  const sortLabel = state.pullSort === 'asc' ? t('最久未更新在前') : t('最近更新在前');
  $('pull-sort-label').textContent = sortLabel;
  $('pull-sort').title = `${t('切换排序方向')} · ${sortLabel}`;
  $('pull-sort').setAttribute('aria-label', sortLabel);
  $('pull-sort-icon').setAttribute('d', state.pullSort === 'asc' ? 'M8 13V3m-4 4 4-4 4 4' : 'M8 3v10m-4-4 4 4 4-4');
  $('pull-title').textContent = upstream ? t('我们提交给上游的 PR') : t('提交到我们仓库的 PR');
  $('pull-sub').textContent = upstream ? t('会话关联的上游 PR，以及会话仓库中的上游贡献') : t('来自会话关联的 PR 和仓库订阅，所有作者的 Open 与草稿');
  const hidden = data?.hidden?.[upstream ? 'upstream' : 'internal'] ?? 0;
  $('pull-hidden').hidden = !hidden;
  $('pull-hidden').textContent = hidden ? t('另有 {p0} 个 PR 在未关注的仓库', { p0: number(hidden) }) : '';
  const refresh = data?.refresh;
  const side = $('pull-side'); side.replaceChildren();
  side.append(node('div', refresh?.running ? t('正在后台刷新…') : refresh?.lastSuccessAt ? t('{p0}刷新', { p0: ago(refresh.lastSuccessAt) }) : t('尚未刷新')),
    node('div', t('{p0} 个 PR', { p0: number(all.length) })));
  const banner = $('pull-banner');
  const error = resolveText(state.pullsError) || refresh?.error;
  banner.hidden = !error;
  if (error) banner.textContent = t('GitHub 刷新失败：{p0}{p1}', { p0: error, p1: refresh?.lastSuccessAt ? t('。当前显示{p0}的数据。', { p0: ago(refresh.lastSuccessAt) }) : t('。') });
  const query = $<HTMLInputElement>('pull-search').value.trim().toLocaleLowerCase();
  const direction = state.pullSort === 'asc' ? 1 : -1;
  const pulls = all.filter(pull => (state.pullFilter === 'all' || (state.pullFilter === 'draft' ? pull.isDraft : attention(pull))) &&
    (!query || [pull.title, pull.repository, pull.author, pull.headRepository ?? '', `#${pull.number}`, ...(pull.sessions ?? []).map(session => `${session.name} ${session.id}`)].join(' ').toLocaleLowerCase().includes(query)))
    .sort((a, b) => direction * (Date.parse(a.updatedAt) - Date.parse(b.updatedAt)) || a.repository.localeCompare(b.repository) || a.number - b.number);
  const empty = $('pull-empty');
  empty.hidden = pulls.length > 0;
  if (!pulls.length) {
    const first = !refresh?.lastSuccessAt;
    $('pull-empty-title').textContent = !data ? t('正在读取 PR 数据') : first && refresh?.running ? t('正在首次从 GitHub 拉取') : first ? t('还没有 GitHub 数据') : all.length ? t('没有匹配的 PR') : t('没有打开的 PR');
    $('pull-empty-detail').textContent = first ? (refresh?.signedOut ? t('登录 GitHub 后自动显示。') : t('数据在后台刷新，完成后自动显示。')) : all.length ? t('换个筛选条件或搜索词。')
      : hidden ? t('已关注的仓库没有打开的 PR；在「PR 订阅」中勾选更多来源。') : t('刷新完成后，新的 Open PR 会出现在这里。');
  }
  const warnings = $<HTMLDetailsElement>('pull-warnings');
  warnings.hidden = !data?.warnings.length;
  if (changed('pull-warnings', data?.warnings)) {
    warnings.querySelector('summary')!.textContent = t('数据范围与提示 · {p0} 条', { p0: number(data?.warnings.length ?? 0) });
    warnings.querySelector('ul')!.replaceChildren(...(data?.warnings ?? []).map(text => node('li', text)));
  }
  if (!changed('pull-rows', [view, pulls])) return;
  replaceRows($('pull-rows'), pulls.map(pull => {
    const item = node('div', undefined, 'entry'); item.setAttribute('role', 'listitem');
    const link = node('a', undefined, 'row'); link.href = pull.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.dataset.key = pull.url; link.title = t('最后更新 {p0}', { p0: fullTime(pull.updatedAt) });
    const repository = node('span', pull.repository, 'pull-repository'); repository.title = pull.repository;
    const color = repositoryColors.get(pull.repository.toLowerCase()) ?? 0;
    repository.dataset.color = String(color % 8); repository.classList.toggle('repository-deep', color >= 8);
    const title: Node[] = [repository, document.createTextNode(' ')];
    if (pull.isDraft) title.push(node('span', t('草稿'), 'tag'), document.createTextNode(' '));
    title.push(node('span', pull.title, 'pull-title-text'));
    const meta = [`#${pull.number}`, pull.author, t('{p0}更新', { p0: ago(pull.updatedAt) })];
    if (pull.sessions?.length) {
      const names = formatList(pull.sessions.map(session => session.name));
      meta.push(t('会话：{p0}', { p0: names }));
    }
    link.append(rowMain(title, meta.join(' · ')), sideBlock(reviews[pull.reviewDecision] ?? { label: t('暂无审查结论'), tone: 'muted' }, ciSummary(pull)));
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
  } catch (error) { state.repoError = () => t('无法保存 {p0} 的关注设置：{p1}', { p0: entry.repository, p1: (error as Error).message }); }
  state.pendingRepos.delete(entry.repository);
  await loadPulls();
}
function renderRepos(): void {
  const entries = state.pulls?.repositories ?? [];
  const followed = entries.filter(entry => entry.followed).length;
  renderTabs('repo-tabs', repoTabs.map(([value, label]) => [value, label, value === 'all' ? entries.length : value === 'followed' ? followed : entries.length - followed]), state.repoFilter, value => {
    state.repoFilter = value; renderRepos();
  });
  $('repo-banner').hidden = !state.repoError; $('repo-banner').textContent = resolveText(state.repoError);
  if (state.view !== 'repos') return;
  const query = $<HTMLInputElement>('repo-search').value.trim().toLocaleLowerCase();
  const visible = entries.filter(entry => (state.repoFilter === 'all' || (state.repoFilter === 'followed') === entry.followed)
    && (!query || [entry.repository, ...entry.sources.map(source => `${source.name} ${source.id} ${source.branch ?? ''} ${source.pulls.map(pull => `#${pull.number}`).join(' ')}`)].join(' ').toLocaleLowerCase().includes(query)));
  $('repo-empty').hidden = visible.length > 0;
  $('repo-table').hidden = visible.length === 0;
  if (!visible.length) {
    $('repo-empty-title').textContent = !state.pulls ? t('正在读取仓库') : entries.length ? t('没有匹配的仓库') : t('还没有发现仓库');
    $('repo-empty-detail').textContent = entries.length ? t('换个筛选条件或搜索词。') : t('后台刷新会读取本机 Claude、Codex、OpenCode 对话的工作目录和 GitHub PR。');
  }
  if (!changed('repo-rows', [visible, [...state.pendingRepos]])) return;
  replaceRows($('repo-rows'), visible.flatMap(entry => {
    const row = node('tr', undefined, 'repo-row');
    const follow = node('td', undefined, 'repo-follow-cell');
    const label = node('label', undefined, 'repo-follow');
    label.title = entry.choice === 'follow' ? t('手动关注') : entry.choice === 'mute' ? t('手动取消') : entry.followed ? t('自动关注') : t('未关注');
    const box = node('input', undefined, 'check'); box.type = 'checkbox'; box.checked = entry.followed;
    box.disabled = state.pendingRepos.has(entry.repository); box.dataset.key = entry.repository;
    box.setAttribute('aria-label', t('关注 {p0}', { p0: entry.repository }));
    box.addEventListener('change', () => { void setFollow(entry, box.checked); });
    label.append(box); follow.append(label);
    const name = node('th', undefined, 'repo-name-cell'); name.scope = 'row';
    const repository = node('span', entry.repository, 'repo-name'); repository.title = entry.repository;
    const total = entry.pulls.internal + entry.pulls.upstream;
    const open = repoCell(number(total), `repo-open-cell${total && entry.followed ? ' tone-info' : ''}`, 'Open PR');
    open.title = t('我们仓库 {p0} 个，上游 {p1} 个', { p0: entry.pulls.internal, p1: entry.pulls.upstream });
    const scope = repoCell(entry.allPulls ? t('整个仓库') : t('指定 PR'), 'repo-scope-cell', t('范围'));
    scope.title = entry.allPulls ? t('跟踪仓库中的 Open 与草稿 PR') : t('仅跟踪来源会话明确关联的 PR');
    const active = repoCell(ago(entry.lastActive), 'repo-active-cell', t('活跃'));
    if (entry.lastActive) active.title = fullTime(entry.lastActive);
    row.append(follow, name, repoCell(formatList(entry.agents.map(agent => agentNames[agent] ?? agent)) || '—', 'repo-agents-cell', t('来源')), scope,
      repoCell(number(entry.sessions), 'repo-sessions-cell', t('会话')), repoCell(number(entry.linkedPulls), 'repo-linked-cell', t('关联 PR')), open, active);
    if (!entry.sources.length) { name.append(repository); return [row]; }

    const details = node('tr', undefined, 'repo-details'); details.id = `repo-sources-${encodeURIComponent(entry.repository)}`;
    details.hidden = !state.openRepoSources.has(entry.repository);
    const toggle = node('button', undefined, 'repo-toggle'); toggle.type = 'button'; toggle.dataset.key = `sources:${entry.repository}`;
    toggle.setAttribute('aria-expanded', String(!details.hidden)); toggle.setAttribute('aria-controls', details.id);
    toggle.setAttribute('aria-label', t('{p0}，{p1} 个来源会话', { p0: entry.repository, p1: number(entry.sources.length) }));
    toggle.append(chevron(), repository); name.append(toggle);
    toggle.addEventListener('click', () => {
      const open = details.hidden;
      if (open) state.openRepoSources.add(entry.repository); else state.openRepoSources.delete(entry.repository);
      details.hidden = !open; toggle.setAttribute('aria-expanded', String(open));
    });
    const cell = node('td'); cell.colSpan = 8;
    const list = node('div', undefined, 'session-sources'); list.setAttribute('role', 'list'); list.setAttribute('aria-label', t('{p0} 的来源会话', { p0: entry.repository }));
    for (const source of entry.sources) {
      const item = node('div', undefined, 'session-source'); item.setAttribute('role', 'listitem');
      const meta = node('span', [adapters[source.adapter], source.fromRepository ? t('会话仓库') : t('关联 PR'), source.branch, source.archived ? t('已归档') : ''].filter(Boolean).join(' · '), 'source-meta');
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
  if (agent.status === 'missing') return t('尚未创建提示词，勾选后自动创建');
  if (agent.status === 'conflict') return t('文件里的 nootify 标记不成对，请先手动修正');
  if (agent.status === 'error') return agent.error ?? t('无法读取文件');
  if (agent.status === 'outdated') return t('写入内容与当前版本不同');
  return agent.injected ? t('新对话会按说明使用飞书') : t('勾选后写入飞书说明');
}
async function loadAgents(): Promise<void> {
  try {
    const response = await fetch('/ui/api/agents', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(response.status === 404 ? t('Agents 模块未启用') : `HTTP ${response.status}`);
    state.agents = await response.json() as AgentsPage;
  } catch (error) { state.agentsError = () => t('无法读取 agent 状态：{p0}', { p0: (error as Error).message }); }
  renderChrome(); renderAgents();
}
async function setAgent(agent: AgentPrompt, enabled: boolean): Promise<void> {
  if (state.agents?.editable !== true || state.pendingAgents.has(agent.agent)) return;
  state.pendingAgents.add(agent.agent); state.agentsError = ''; renderAgents();
  try {
    const response = await fetch('/ui/api/agents', { method: 'POST', headers: { 'x-nootify-ui': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ agent: agent.agent, enabled }), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`);
    await response.json();
  } catch (error) { state.agentsError = () => t('无法修改 {p0}：{p1}', { p0: agent.name, p1: (error as Error).message }); }
  state.pendingAgents.delete(agent.agent);
  await loadAgents();
}
function renderAgents(): void {
  const page = state.agents;
  $('agents-card').hidden = !page?.agents.length;
  $('agents-count').textContent = page ? (page.agents.some(agent => agent.injected) ? number(page.agents.filter(agent => agent.injected).length) : '') : '';
  const remote = page?.editable !== true;
  const banner = resolveText(state.agentsError) || (page && remote ? t('通过 Tailscale 访问时只能查看；请在这台 Mac 上修改 agent 提示词。') : '');
  $('agents-banner').hidden = !banner; $('agents-banner').textContent = banner;
  const channel = page?.channel;
  setText('channel-title', t('飞书通知'));
  setTone('channel-state', !page ? { label: t('读取中'), tone: 'muted' } : !channel ? { label: t('未启用'), tone: 'muted' }
    : channel.configured ? { label: t('已配置'), tone: 'ok' } : { label: t('未配置'), tone: 'muted' });
  setText('channel-sub', !page ? t('正在读取飞书配置…') : !channel ? t('飞书模块未启用') : !channel.configured ? t('未配置飞书应用凭据，提示词写入后也无法建群：到「设置 · 飞书」配置')
    : channel.recipient ? t('接收人 {p0} · 已绑定 {p1} 个群', { p0: channel.recipient, p1: number(channel.groups) }) : t('还没有设置接收人：到「设置 · 飞书」填写'));
  if (state.view !== 'agents' || !page) return;
  if (!changed('agent-rows', [page, [...state.pendingAgents]])) return;
  replaceRows($('agent-rows'), page.agents.map(agent => {
    const item = node('div', undefined, 'entry'); item.setAttribute('role', 'listitem');
    const row = node('label', undefined, 'row');
    const box = node('input', undefined, 'check'); box.type = 'checkbox'; box.checked = agent.injected; box.dataset.key = agent.agent;
    box.disabled = remote || state.pendingAgents.has(agent.agent) || ['conflict', 'error'].includes(agent.status);
    box.setAttribute('aria-label', t('向 {p0} 写入飞书说明', { p0: agent.name }));
    box.addEventListener('change', () => { void setAgent(agent, box.checked); });
    row.append(box, rowMain(agent.name, `${(agent.files ?? [agent.file]).map(home).join(' · ')} · ${agentDetail(agent)}`), sideBlock(promptStates[agent.status] ?? promptStates.error));
    const extra = node('div', undefined, 'agent-extra');
    if (agent.agent === 'trae' || agent.agent === 'workbuddy') extra.append(node('p', t('回复需由会话主动检查'), 'hint'));
    if (agent.status === 'outdated' && !remote) {
      const update = node('button', t('更新为当前内容'), 'text-button'); update.type = 'button';
      update.disabled = state.pendingAgents.has(agent.agent);
      update.addEventListener('click', () => { void setAgent(agent, true); });
      extra.append(update);
    }
    const details = node('details');
    details.open = state.openPreviews.has(agent.agent);
    details.addEventListener('toggle', () => { if (details.open) state.openPreviews.add(agent.agent); else state.openPreviews.delete(agent.agent); });
    details.append(node('summary', agent.injected ? t('查看写入的内容') : t('查看将写入的内容')), node('pre', agent.block, 'mono'));
    extra.append(details);
    item.append(row, extra); return item;
  }));
}

// ---- Settings ----

const loginActive = (login?: GitHubLogin): boolean => login?.status === 'starting' || login?.status === 'waiting';
/** Skips unchanged text, so polling never clears a selection such as the device code. */
function setText(id: string, text: string): void { if ($(id).textContent !== text) $(id).textContent = text; }
function setTone(id: string, tone: Tone): void { setText(id, tone.label); $(id).className = `tone-${tone.tone}`; }
const field = (id: string): HTMLInputElement => $<HTMLInputElement>(id);
async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'x-nootify-ui': '1', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(path === '/ui/api/settings/import' ? 180000 : 20000) });
  if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`);
  return await response.json() as T;
}
function fillLark(): void {
  const lark = state.settings?.lark;
  field('lark-app-id').value = lark?.app_id ?? '';
  field('lark-app-secret').value = '';
  showLarkSecret(false);
  field('lark-recipient').value = lark?.recipient ?? '';
}
async function loadSettings(): Promise<boolean> {
  let loaded = false;
  try {
    const response = await fetch('/ui/api/settings', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(response.status === 404 ? t('设置模块未启用') : `HTTP ${response.status}`);
    state.settings = await response.json() as SettingsPage & { editable: boolean };
    state.larkConnectionType ??= state.settings.lark.connection_type ?? 'bot';
    if (state.recipientDirectory && state.recipientDirectory.app_id !== state.settings.lark.app_id) invalidateRecipientDirectory();
    if (!state.larkEdited) fillLark();
    loaded = true;
    if (state.settingsNote?.source === 'settings-read') state.settingsNote = undefined;
  } catch (error) { state.settingsNote = { text: () => t('无法读取设置：{p0}', { p0: (error as Error).message }), error: true, source: 'settings-read' }; }
  renderSettings();
  if (state.view === 'settings-lark' && state.settings?.editable === true) {
    if (!state.larkRegistration) void loadLarkRegistration();
    if (state.settings.lark.configured && state.larkSetup?.app_id !== state.settings.lark.app_id) void loadLarkSetup();
  }
  return loaded;
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
  } catch (error) { state.settingsNote = { text: () => t('无法读取 GitHub 状态：{p0}', { p0: (error as Error).message }), error: true }; }
  finally { state.loadingGitHub = false; renderSettings(); }
}

async function loadTailscale(): Promise<void> {
  if (state.loadingTailscale) return;
  state.loadingTailscale = true;
  try {
    const response = await fetch('/ui/api/settings/tailscale', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.tailscale = await response.json() as TailscalePage & { editable: boolean };
    state.tailscaleError = '';
  } catch (error) { state.tailscaleError = () => t('无法读取 Tailscale 状态：{p0}', { p0: (error as Error).message }); }
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
    disabled: { label: t('已关闭'), tone: 'muted' }, 'needs-login': { label: t('待登录'), tone: 'warn' }, starting: { label: t('连接中'), tone: 'warn' },
    'needs-approval': { label: t('等待批准'), tone: 'warn' }, connected: { label: t('已连接'), tone: 'ok' }, unavailable: { label: t('不可用'), tone: 'warn' },
  };
  setTone('tailscale-state', data ? labels[data.status] : { label: '', tone: 'muted' });
  setText('tailscale-status', !data ? t('正在检查连接…') : connected ? [data.deviceName, data.account].filter(Boolean).join(' · ')
    : data.status === 'needs-approval' ? t('请在 Tailscale 管理后台批准 Nootify 这台设备。')
    : data.status === 'unavailable' ? t('Nootify 内置节点暂时不可用。')
    : data.status === 'disabled' ? t('独立的 Tailscale 设备，不使用系统客户端。') : t('登录后，Nootify 会作为独立设备加入你的网络。'));
  setText('tailscale-sharing', !data ? t('正在读取设置…') : !data.enabled ? t('节点已关闭；已有登录信息会保留。')
    : data.error ? tailscaleErrors[data.error] ?? data.error
    : data.sharing === 'ready' ? t('已连接，通过 Nootify 节点的 80 端口访问。')
    : connected ? t('正在开启远程访问…') : t('等待 Nootify 节点连接。'));
  $('tailscale-sharing').classList.toggle('tone-error', !!data?.error);
  const login = $<HTMLButtonElement>('tailscale-login');
  login.hidden = remote || !data || connected || data.login.status === 'starting' || data.status === 'needs-approval';
  login.disabled = busy;
  setText('tailscale-login', data?.login.status === 'waiting' ? t('重新获取链接') : data?.enabled ? t('登录 Tailscale') : t('启用并登录'));
  const logout = $<HTMLButtonElement>('tailscale-logout');
  logout.hidden = remote || !connected; logout.disabled = busy;
  $('tailscale-flow').hidden = remote || !active;
  setText('tailscale-flow-title', data?.login.status === 'waiting' ? t('继续完成 Tailscale 登录') : t('正在准备登录…'));
  $<HTMLButtonElement>('tailscale-cancel').disabled = busy;
  const open = $<HTMLAnchorElement>('tailscale-open');
  open.hidden = remote || !data?.login.url;
  if (!remote && data?.login.url) open.href = data.login.url; else open.removeAttribute('href');
  $('tailscale-address-row').hidden = !data?.url;
  setText('tailscale-address', data?.url ?? '');
  setText('tailscale-dns', data?.url && data.dnsName ? t('MagicDNS：http://{p0}/', { p0: data.dnsName }) : '');
}
function loadSettingsView(): void {
  if (!isSettingsView(state.view) || state.view === 'settings-general') return;
  void loadSettings();
  if (state.view === 'settings-github') void loadGitHub();
  if (state.view === 'settings-lark') void loadLarkRegistration();
  if (state.view === 'settings-tailscale') void loadTailscale();
}
/** Runs one page action: its buttons are disabled meanwhile, and the result replaces the page's note. */
async function settingsRun(key: string, failure: TranslatedText, action: () => Promise<TranslatedText | void>): Promise<void> {
  state.pendingSettings.add(key); state.settingsNote = undefined; renderSettings();
  try {
    const note = await action();
    if (note) state.settingsNote = { text: note, error: false };
  } catch (error) { state.settingsNote = { text: () => t('{p0}：{p1}', { p0: resolveText(failure), p1: (error as Error).message }), error: true }; }
  state.pendingSettings.delete(key); renderSettings();
}
function githubStatus(): { text: string; tone: Tone } {
  const account = state.github?.account;
  if (!account) return { text: loginActive(state.github?.login) ? t('正在登录') : t('正在检查登录状态…'), tone: { label: '', tone: 'muted' } };
  if (account.signedIn) return { text: t('{p0} · 和终端里的 gh 互不影响', { p0: account.login }), tone: { label: t('已登录'), tone: 'ok' } };
  if (account.error) return { text: t('无法确认登录状态：{p0}', { p0: account.error }), tone: { label: t('未确认'), tone: 'warn' } };
  return { text: t('登录后才能读取 PR 和订阅'), tone: { label: t('未登录'), tone: 'warn' } };
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
  setText('github-flow-title', waiting ? t('在 GitHub 页面输入这个验证码') : t('正在向 GitHub 申请验证码…'));
  setText('github-flow-sub', waiting && login?.expiresAt ? t('{p0} 前有效，授权后这里会自动更新', { p0: clock(login.expiresAt) }) : '');
  setText('github-code', login?.code ?? '');
  $('github-copy').hidden = !waiting;
  if (!waiting) setText('github-copy', t('复制'));
  const open = $<HTMLAnchorElement>('github-open');
  open.hidden = !waiting;
  if (login?.url) open.href = login.url;
}
const larkRegistrationActive = (): boolean => ['starting', 'waiting', 'connecting'].includes(state.larkRegistration?.status ?? '');
async function loadLarkRegistration(): Promise<void> {
  if (state.loadingLarkRegistration || state.settings?.editable !== true) return;
  state.loadingLarkRegistration = true;
  try {
    const previousFlow = state.larkRegistration;
    const previous = previousFlow?.status;
    const next = await post<LarkRegistrationPage>('/ui/api/settings/lark/registration', { action: 'status' });
    if (state.larkRegistration !== previousFlow) return; // A type switch or cancellation supersedes this response.
    state.larkRegistration = next;
    if (['starting', 'waiting', 'connecting'].includes(next.status)) state.larkConnectionType = 'personal-app';
    const wasActive = ['starting', 'waiting', 'connecting'].includes(previous ?? '');
    if (next.status === 'complete') {
      if (wasActive || !state.larkSetup || state.larkSetup.app_id !== next.app_id) state.larkSetup = next.setup;
      if (previous !== 'complete' || next.app_id !== state.settings.lark.app_id) state.larkReconcilePending = true;
    } else if (wasActive && (next.status === 'idle' || next.status === 'failed')) {
      // Registration is transient: after a service restart, only saved settings can tell us whether it committed.
      state.larkReconcilePending = true;
    }
    if (state.larkReconcilePending) {
      const before = state.settings.lark;
      state.larkEdited = false; renderSettings();
      if (await loadSettings()) {
        const current = state.settings!.lark;
        if (next.status === 'complete' || current.app_id !== before.app_id || current.connection_type !== before.connection_type) {
          state.larkConnectionType = current.connection_type ?? 'bot';
        }
        state.larkReconcilePending = false;
        await loadSnapshot();
      }
    }
  } catch (error) { state.settingsNote = { text: () => t('{p0}：{p1}', { p0: t('无法读取扫码配置状态'), p1: (error as Error).message }), error: true }; }
  finally { state.loadingLarkRegistration = false; renderSettings(); }
}
async function loadLarkSetup(): Promise<void> {
  const appId = state.settings?.lark.app_id;
  if (!appId || state.settings?.editable !== true || state.loadingLarkSetup) return;
  state.loadingLarkSetup = true; renderSettings();
  try {
    const setup = await post<LarkSetup>('/ui/api/settings/lark/permissions', { app_id: appId });
    if (appId === state.settings?.lark.app_id) state.larkSetup = setup;
  } catch {
    if (appId === state.settings?.lark.app_id) state.larkSetup = { app_id: appId, status: 'unavailable', missing: [], mention_only: false };
  } finally { state.loadingLarkSetup = false; renderSettings(); }
}
function renderLarkQr(id: string, src: string | undefined, alt: string): void {
  const host = $(id); host.hidden = !src;
  if (!src) { if (host.firstChild) host.replaceChildren(); return; }
  let image = host.querySelector('img');
  if (!image || image.getAttribute('src') !== src) { image = node('img'); image.src = src; image.width = image.height = 216; host.replaceChildren(image); }
  image.alt = alt;
}
function selectedLarkType(): LarkConnectionType { return state.larkConnectionType ?? state.settings?.lark.connection_type ?? 'bot'; }
function larkTypeName(type: LarkConnectionType): string { return type === 'personal-app' ? t('飞书个人 App') : t('飞书机器人'); }
function renderLarkRegistration(remote: boolean): void {
  const flow = state.larkRegistration; const active = larkRegistrationActive();
  const personal = selectedLarkType() === 'personal-app';
  const setup = flow?.app_id && state.larkSetup?.app_id === flow.app_id ? state.larkSetup : flow?.setup;
  const busy = state.pendingSettings.has('lark-registration') || state.larkReconcilePending;
  const disabled = remote || !state.settings || state.settings.lark.source === 'environment';
  for (const [id, type] of [['lark-type-bot', 'bot'], ['lark-type-personal', 'personal-app']] as const) {
    $(id).setAttribute('aria-pressed', String(selectedLarkType() === type));
    $<HTMLButtonElement>(id).disabled = remote || !state.settings || flow?.status === 'connecting' || busy || state.pendingSettings.has('lark');
  }
  setText('lark-type-description', personal ? t('通过飞书扫码认证，自动创建个人 App 并连接。') : t('使用已有机器人的 App ID 和 App Secret，沿用原有消息流程。'));
  const current = state.settings?.lark;
  $('lark-type-note').hidden = !current?.configured || selectedLarkType() === current.connection_type;
  $('lark-type-note').firstElementChild!.textContent = current?.configured ? t('当前仍在使用{p0}，保存或完成扫码后切换。', { p0: larkTypeName(current.connection_type ?? 'bot') }) : '';
  $('lark-personal').hidden = !personal;
  $<HTMLButtonElement>('lark-qr-start').disabled = disabled || active || busy || state.pendingSettings.has('lark');
  $<HTMLButtonElement>('lark-use-existing').disabled = remote || flow?.status === 'connecting' || busy;
  $('lark-use-existing').setAttribute('aria-expanded', String(state.larkManual));
  setText('lark-use-existing', state.larkManual ? t('收起应用凭据') : current?.configured && current.connection_type === 'personal-app' ? t('查看个人 App 凭据') : t('使用已有个人 App'));
  const manual = !personal || state.larkManual;
  $('lark-manual').hidden = !manual;
  $('lark-manual-hint').hidden = !manual;
  $('lark-personal-import').hidden = !personal;
  $('lark-reuse-hint').hidden = !personal;
  const visible = personal && !remote && !!flow && flow.status !== 'idle';
  $('lark-registration').hidden = !visible;
  const expired = flow?.status === 'waiting' && !!flow.expires_at && Date.now() >= Date.parse(flow.expires_at);
  const waiting = visible && flow.status === 'waiting' && !expired;
  renderLarkQr('lark-registration-qr', waiting ? flow.qr : undefined, t('飞书个人 App 认证二维码'));
  $('lark-registration').classList.toggle('without-qr', !waiting);
  const errors: Record<string, string> = {
    expired_token: t('二维码已过期，请重新获取。'), access_denied: t('已在飞书取消配置，可重新扫码。'),
    unsupported_brand: t('此入口支持飞书账号，暂不支持 Lark 国际版账号。'), invalid_credentials: t('飞书返回的应用凭据无效，请重新扫码。'),
    save_failed: t('无法验证或保存应用，请检查连接状态后重试。'),
  };
  const failed = expired || flow?.status === 'failed';
  setText('lark-registration-title', failed ? t('扫码配置未完成') : flow?.status === 'waiting' ? t('用飞书扫码认证个人 App')
    : flow?.status === 'connecting' ? t('正在验证并保存应用…') : flow?.status === 'complete' ? t('应用已保存') : t('正在准备个人 App 认证…'));
  setText('lark-registration-detail', failed ? errors[expired ? 'expired_token' : flow?.error ?? ''] ?? t('暂时无法获取应用配置，请检查网络后重试。')
    : flow?.status === 'waiting' ? t('按飞书页面提示确认，应用凭据和接收人会自动保存到这台 Mac。')
    : flow?.status === 'connecting' ? t('正在连接机器人并检查群权限。')
    : flow?.status === 'complete' ? state.settings?.lark.app_id === flow.app_id && !state.settings?.lark.recipient ? t('应用已保存，请选择接收人。')
      : setup?.status === 'ready' ? t('扫码配置完成，所需群权限已开通。')
      : setup?.status === 'permissions-required' ? t('扫码配置完成，群权限仍需处理。') : t('应用已保存，暂时无法确认群权限。')
    : t('正在向飞书申请二维码，请稍候。'));
  $('lark-registration-detail').classList.toggle('tone-error', failed);
  setText('lark-registration-expiry', waiting && flow.expires_at ? t('二维码在 {p0} 前有效，确认后自动连接。', { p0: clock(flow.expires_at) }) : '');
  setText('lark-registration-replace', active && state.settings?.lark.configured ? t('扫码完成后会替换本机的当前应用连接，已有群仍归原应用。') : '');
  const open = $<HTMLAnchorElement>('lark-registration-open'); open.hidden = !waiting;
  if (waiting && flow.url) open.href = flow.url; else open.removeAttribute('href');
  $('lark-qr-refresh').hidden = !waiting && !failed;
  $<HTMLButtonElement>('lark-qr-refresh').disabled = busy;
  $<HTMLButtonElement>('lark-registration-cancel').disabled = busy || flow?.status === 'connecting';
  setText('lark-registration-cancel', flow?.status === 'complete' ? t('完成') : t('取消'));
}
function renderLarkSetup(remote: boolean): void {
  const appId = state.settings?.lark.app_id;
  const setup = state.larkSetup?.app_id === appId ? state.larkSetup : undefined;
  $('lark-setup').hidden = remote || !state.settings?.lark.configured || larkRegistrationActive();
  setTone('lark-setup-state', !setup ? { label: t('暂未确认'), tone: 'muted' } : setup.status === 'ready' ? { label: t('所需权限已开通'), tone: 'ok' }
    : setup.status === 'permissions-required' ? { label: t('需要开通权限'), tone: 'warn' } : { label: t('暂未确认'), tone: 'warn' });
  setText('lark-setup-description', state.loadingLarkSetup ? t('正在检查应用权限…') : !setup ? t('权限检查尚未完成')
    : setup.status === 'ready' ? t('会话群公告和群消息所需权限已开通。') : setup.status === 'unavailable' ? t('无法读取权限列表，请在飞书后台核对所需权限。')
    : t('还需开通群权限，才能按会话收发消息。'));
  $<HTMLButtonElement>('lark-setup-retry').disabled = remote || state.loadingLarkSetup || larkRegistrationActive() || state.larkReconcilePending;
  $('lark-setup-help').hidden = !setup || setup.status === 'ready';
  renderLarkQr('lark-setup-qr', remote ? undefined : setup?.permission?.qr, t('飞书权限配置二维码'));
  $('lark-setup-help').classList.toggle('without-qr', !setup?.permission?.qr);
  setText('lark-setup-mentions', setup?.mention_only ? t('当前仅接收群内 @机器人的消息；普通群消息还需额外权限。') : '');
  const link = $<HTMLAnchorElement>('lark-setup-console');
  if (!remote && appId) link.href = setup?.permission?.url ?? `https://open.feishu.cn/app/${encodeURIComponent(appId)}/auth`; else link.removeAttribute('href');
  const scopes = setup?.missing.length ? setup.missing : setup?.permission?.scopes ?? [];
  if (changed('lark-setup-scopes', scopes)) $('lark-setup-scopes').replaceChildren(...scopes.map(scope => node('li', scope)));
}
function renderLark(remote: boolean): void {
  const lark = state.settings?.lark;
  setText('lark-current-title', lark?.configured ? larkTypeName(lark.connection_type ?? 'bot') : t('飞书连接'));
  const status = !lark?.configured ? 'disabled' : state.snapshot.modules.find(module => module.name === 'lark')?.status ?? lark.status;
  setTone('lark-state', !lark ? { label: t('读取中'), tone: 'muted' } : !lark.configured ? { label: t('未配置'), tone: 'muted' }
    : status === 'ready' ? { label: t('已连接'), tone: 'ok' } : moduleStates[status] ?? { label: status, tone: 'muted' });
  setText('lark-status', !lark ? t('正在读取设置…') : lark.configured ? t('{p0} · 来自{p1}{p2}', { p0: lark.app_id, p1: credentialSources[lark.source ?? 'settings'], p2: lark.recipient ? '' : t(' · 还没有接收人') }) : t('用飞书接收会话进度，并将回复发送回本机会话。'));
  const environment = lark?.source === 'environment';
  const hasSecret = lark?.configured && field('lark-app-id').value.trim() === lark.app_id;
  field('lark-app-secret').placeholder = hasSecret ? '••••••••••••••••' : '';
  const busy = !lark || state.pendingSettings.has('lark') || state.pendingSettings.has('lark-secret') || larkRegistrationActive() || state.larkReconcilePending;
  field('lark-app-id').disabled = remote || environment || busy;
  field('lark-app-secret').disabled = remote || busy;
  field('lark-app-secret').readOnly = environment;
  $<HTMLButtonElement>('lark-secret-toggle').disabled = remote || busy;
  showLarkSecret(field('lark-app-secret').type === 'text');
  setText('lark-secret-hint', remote ? t('App Secret 只能在这台 Mac 上查看。') : hasSecret ? t('已配置 App Secret，留空则保留；点击眼睛可查看。') : t('保存前会先向飞书验证；点击眼睛可查看输入的密钥。'));
  $('lark-recipient-group').hidden = !lark?.configured;
  field('lark-recipient').disabled = remote || !lark?.configured || state.pendingSettings.has('recipient') || state.larkReconcilePending;
  $<HTMLButtonElement>('lark-save').disabled = remote || environment || busy;
  $<HTMLButtonElement>('recipient-save').disabled = remote || state.pendingSettings.has('recipient') || state.larkReconcilePending;
  const clear = $<HTMLButtonElement>('lark-clear');
  clear.hidden = remote || !lark?.saved; clear.disabled = busy;
  setText('lark-clear', state.confirmClear ? t('再点一次确认清除') : t('清除保存的凭据'));
  renderRecipientPicker(remote);
  renderLarkRegistration(remote);
  renderLarkSetup(remote);
}
function recipientUsers(): LarkRecipientsPage['users'] {
  if (state.recipientDirectory?.app_id !== state.settings?.lark.app_id) return [];
  const query = field('recipient-search').value.trim().toLocaleLowerCase(locale());
  const users = state.recipientDirectory?.users.filter(user => `${user.name} ${user.nickname ?? ''} ${user.en_name ?? ''} ${user.open_id}`.toLocaleLowerCase(locale()).includes(query)) ?? [];
  const current = users.findIndex(user => user.open_id === state.settings?.lark.recipient);
  if (!query && current > 0) users.unshift(...users.splice(current, 1));
  return users;
}
let recipientRows: RecipientListRenderer | undefined;
function renderRecipientRows(users: LarkRecipientsPage['users']): void {
  const list = $('recipient-options');
  recipientRows ??= new RecipientListRenderer(list, list.parentElement!, id => {
    state.recipientDraft = state.recipientActive = id; state.recipientSaveError = ''; renderRecipientPicker(false);
  });
  recipientRows.update(users, {
    current: state.settings?.lark.recipient, selected: state.recipientDraft, active: state.recipientActive,
    locale: locale(), currentLabel: t('当前接收人'), unknownLabel: t('飞书用户'), failedAvatars: state.failedAvatars,
    retainIds: new Set(state.recipientDirectory?.users.map(user => user.open_id) ?? []),
  });
}
function renderRecipientPicker(remote: boolean): void {
  const ready = !!state.settings?.lark.configured && !state.larkReconcilePending && field('lark-app-id').value.trim() === state.settings.lark.app_id;
  const saving = state.pendingSettings.has('recipient');
  const choose = $<HTMLButtonElement>('recipient-choose');
  choose.disabled = remote || !ready || saving || state.pendingSettings.has('lark');
  choose.setAttribute('aria-expanded', String(state.recipientPicker));
  const dialog = $<HTMLDialogElement>('recipient-picker');
  const wasPermission = dialog.classList.contains('is-permission');
  if ((!state.recipientPicker || remote || !ready) && dialog.open) { closeRecipientPicker(); return; }
  if (!state.recipientPicker || remote || !ready) return;
  const users = recipientUsers();
  const help = state.recipientPermission ?? state.recipientDirectory?.permission;
  const permissions = !!help && state.recipientPermissionOpen;
  const searching = !!field('recipient-search').value.trim();
  const initialLoading = state.loadingRecipients && !state.recipientDirectory?.users.length;
  const list = $('recipient-options');
  if (!users.some(user => user.open_id === state.recipientActive)) state.recipientActive = users[0]?.open_id ?? '';
  renderRecipientRows(users);
  if (state.recipientActive) list.setAttribute('aria-activedescendant', `recipient-person-${state.recipientActive}`); else list.removeAttribute('aria-activedescendant');
  list.hidden = permissions || initialLoading || !users.length;
  $('recipient-loading').hidden = permissions || !initialLoading;
  $('recipient-search-row').hidden = permissions;
  field('recipient-search').disabled = saving;
  $('recipient-empty').hidden = permissions || initialLoading || !!users.length;
  const error = state.recipientError;
  setText('recipient-empty-title', error ? t('暂时无法读取联系人') : searching ? t('没有找到这位联系人') : t('暂无可见联系人'));
  setText('recipient-empty-detail', error === 409 ? t('应用凭据已变更，请刷新后重试') : error ? t('请检查网络后重试，也可以手动填写 ID。')
    : searching ? t('试试其他姓名，或直接搜索 open_id。') : t('请检查应用的通讯录可见范围，或手动填写 ID。'));
  $('recipient-empty-retry').hidden = !error && searching;
  const note = permissions ? t('开通权限后，可重新读取联系人。') : state.loadingRecipients ? (users.length ? state.recipientDirectory?.cached ? t('正在后台更新，缓存名单可直接选择。') : t('已加载 {p0} 位，正在加载更多…', { p0: number(state.recipientDirectory?.users.length ?? users.length) }) : t('正在连接飞书通讯录…'))
    : error && users.length ? t('加载已中断，已显示的联系人仍可选择。')
    : state.recipientDirectory?.truncated ? t('已显示 {p0} 位联系人', { p0: number(state.recipientDirectory.users.length) })
    : state.recipientDirectory?.cached ? t('本地缓存 · {p0} 位联系人', { p0: number(users.length) }) : t('{p0} 位联系人', { p0: number(users.length) });
  setText('recipient-directory-note', note);
  $('recipient-permission-notice').hidden = !help || permissions || !users.length;
  $('recipient-permission').hidden = !permissions;
  dialog.classList.toggle('is-permission', permissions);
  if (help) {
    let image = document.getElementById('recipient-permission-qr') as HTMLImageElement | null;
    if (!image) { image = node('img'); image.id = 'recipient-permission-qr'; image.width = image.height = 184; image.src = help.qr; $('recipient-permission-qr-host').replaceChildren(image); }
    else if (image.getAttribute('src') !== help.qr) image.src = help.qr;
    image.alt = t('飞书权限配置二维码');
    $<HTMLAnchorElement>('recipient-open-console').href = help.url;
    if (changed('recipient-permission-scopes', help.scopes)) $('recipient-permission-scopes').replaceChildren(...help.scopes.map(scope => node('li', scope)));
  }
  const selected = state.recipientDirectory?.users.find(user => user.open_id === state.recipientDraft);
  setText('recipient-selected-name', !permissions && selected ? t('已选择 {p0}', { p0: recipientDisplayName(selected) }) : '');
  $('recipient-confirm').hidden = permissions;
  $<HTMLButtonElement>('recipient-confirm').disabled = saving || !selected;
  setText('recipient-confirm', saving ? t('保存中…') : t('确认选择'));
  $('recipient-permission-retry').hidden = !permissions;
  $<HTMLButtonElement>('recipient-permission-retry').disabled = saving || state.loadingRecipients;
  $<HTMLButtonElement>('recipient-reload').disabled = saving;
  $('recipient-save-error').hidden = !state.recipientSaveError;
  setText('recipient-save-error', state.recipientSaveError);
  const opening = !dialog.open;
  if (opening) dialog.showModal();
  if (permissions && (opening || !wasPermission)) $('recipient-permission-retry').focus({ preventScroll: true });
  else if (wasPermission && !permissions) field('recipient-search').focus({ preventScroll: true });
}
function invalidateRecipientDirectory(): void {
  state.recipientRequest?.abort(); state.recipientRequest = undefined; state.loadingRecipients = false;
  state.recipientDirectory = undefined; state.recipientPermission = undefined; state.recipientLoadedAt = 0; state.failedAvatars.clear();
  recipientRows?.clear();
}
function closeRecipientPicker(): void {
  state.recipientPicker = false; state.recipientRequest?.abort(); state.recipientRequest = undefined; state.loadingRecipients = false;
  const dialog = $<HTMLDialogElement>('recipient-picker'); if (dialog.open) dialog.close();
  $('recipient-choose').setAttribute('aria-expanded', 'false');
  if (state.view === 'settings-lark') $('recipient-choose').focus();
}
async function confirmRecipient(): Promise<void> {
  const selected = state.recipientDirectory?.users.find(user => user.open_id === state.recipientDraft);
  if (!selected || state.settings?.editable !== true || state.pendingSettings.has('recipient')) return;
  state.pendingSettings.add('recipient'); state.recipientSaveError = ''; renderRecipientPicker(false);
  try {
    await post('/ui/api/settings/recipient', { open_id: selected.open_id, app_id: state.recipientDirectory?.app_id });
    field('lark-recipient').value = selected.open_id;
    await loadSettings();
    state.settingsNote = { text: () => t('接收人已保存'), error: false }; closeRecipientPicker();
  } catch (error) { state.recipientSaveError = (error as Error).message; }
  finally {
    state.pendingSettings.delete('recipient'); renderSettings();
    if (!state.recipientPicker && state.view === 'settings-lark' && document.activeElement === document.body) $('recipient-choose').focus();
  }
}
async function loadRecipients(refresh = false): Promise<void> {
  if (state.settings?.editable !== true) return;
  const appId = state.settings.lark.app_id;
  if (!appId || field('lark-app-id').value.trim() !== appId) return;
  state.recipientRequest?.abort();
  const controller = new AbortController(); state.recipientRequest = controller;
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]);
  state.loadingRecipients = true; state.recipientError = undefined; state.recipientSaveError = ''; state.recipientPermissionOpen = false;
  if (refresh) state.failedAvatars.clear();
  renderRecipientPicker(false);
  let terminal = false;
  const receive = (event: { type: string; directory?: LarkRecipientsPage; status?: number; permission?: LarkPermissionHelp }) => {
    if (controller !== state.recipientRequest || controller.signal.aborted) return;
    if (event.type === 'error') {
      state.recipientError = event.status ?? 502; state.recipientPermission = event.permission; state.loadingRecipients = false; terminal = true;
      if (event.status === 403 || event.status === 409) { state.recipientDirectory = undefined; state.recipientLoadedAt = 0; }
      if (event.permission && !state.recipientDirectory?.users.length) state.recipientPermissionOpen = true;
    } else if (event.directory) {
      const directory = event.directory;
      if (directory.app_id !== state.settings?.lark.app_id || directory.app_id !== field('lark-app-id').value.trim() || !Array.isArray(directory.users)) { state.recipientError = 409; state.recipientDirectory = undefined; controller.abort(); return; }
      const previous = state.recipientDirectory?.app_id === directory.app_id && (!state.recipientDirectory.expires_at || state.recipientDirectory.expires_at > Date.now()) ? state.recipientDirectory : undefined;
      state.recipientDirectory = event.type === 'progress' && previous ? {
        ...directory, users: mergeRecipients(previous.users, directory.users), permission: directory.permission ?? previous.permission,
        cached: directory.cached ?? previous.cached, fetched_at: directory.fetched_at ?? previous.fetched_at, refresh_after: directory.refresh_after ?? previous.refresh_after, expires_at: directory.expires_at ?? previous.expires_at,
      } : directory;
      state.recipientPermission = state.recipientDirectory.permission;
      if (event.type === 'complete') { state.loadingRecipients = false; state.recipientLoadedAt = directory.fetched_at ?? Date.now(); terminal = true; }
    }
    renderRecipientPicker(false);
  };
  try {
    const response = await fetch('/ui/api/settings/lark/recipients/stream', { method: 'POST', headers: { 'x-nootify-ui': '1', 'content-type': 'application/json' }, body: JSON.stringify({ refresh }), signal });
    if (!response.ok) { const failure = await response.json().catch(() => ({})) as { permission?: LarkPermissionHelp }; receive({ type: 'error', status: response.status, permission: failure.permission }); return; }
    if (!response.body) throw new Error('Missing directory stream');
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = '';
    try {
      while (true) {
        const { value, done } = await reader.read(); pending += decoder.decode(value, { stream: !done });
        if (pending.length > 32 * 1024 * 1024) throw new Error('Directory batch is too large');
        let end: number;
        while ((end = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); if (line.trim()) receive(JSON.parse(line)); }
        if (done) { if (pending.trim()) receive(JSON.parse(pending)); break; }
      }
    } finally { reader.releaseLock(); }
    if (!terminal && !controller.signal.aborted) throw new Error('Directory stream ended early');
  } catch { if (controller === state.recipientRequest && !controller.signal.aborted) state.recipientError = signal.aborted ? 504 : 502; }
  finally { if (controller === state.recipientRequest) { state.recipientRequest = undefined; state.loadingRecipients = false; renderRecipientPicker(state.settings?.editable !== true); } }
}
function importLines(summary: ImportSummary): string[] {
  const lines: string[] = [];
  if (summary.app_id) lines.push(t('飞书应用 {p0} 和它的 App Secret', { p0: summary.app_id }));
  if (summary.recipient) lines.push(t('飞书接收人 {p0}', { p0: summary.recipient }));
  if (summary.pulls_config) lines.push(t('GitHub PR 配置'));
  if (summary.follow !== undefined) lines.push(t('用文件里的 {p0} 条选择替换现有的仓库关注选择', { p0: number(summary.follow) }));
  if (summary.backends.length) lines.push(t('{p0} 连接', { p0: formatList(summary.backends.map(adapter => adapters[adapter] ?? adapter)) }));
  if (summary.agents.length) lines.push(t('启用 {p0} 的通知说明', { p0: formatList(summary.agents.map(agent => agentNames[agent] ?? agent)) }));
  return lines.length ? lines : [t('这个文件没有可导入的设置')];
}
function renderBackup(remote: boolean): void {
  const page = state.settings;
  setText('export-path', !page ? '' : page.last_export ? t('最近导出到 {p0}', { p0: home(page.last_export) }) : t('写入 {p0}', { p0: home(page.exports_dir) }));
  $('export-reveal').hidden = remote || !page?.last_export;
  for (const [id, key] of [['export-config', 'export'], ['import-choose', 'import'], ['import-apply', 'import'], ['import-cancel', 'import']] as const) {
    $<HTMLButtonElement>(id).disabled = remote || state.pendingSettings.has(key);
  }
  const importing = state.importing;
  $('import-preview').hidden = !importing;
  if (!importing) return;
  setText('import-name', t('{p0} 将写入：', { p0: importing.name }));
  setText('import-date', importing.summary.exported_at ? t('导出于 {p0}', { p0: fullTime(importing.summary.exported_at) }) : '');
  if (changed('import-lines', importing.summary)) $('import-lines').replaceChildren(...importLines(importing.summary).map(line => node('li', line)));
}
function renderSettings(): void {
  renderUpdate();
  if (!isSettingsView(state.view)) return;
  if (state.view === 'settings-general') { $('settings-banner').hidden = true; return; }
  const remote = state.settings?.editable === false;
  const login = state.github?.login;
  const note = state.settingsNote ?? (state.view === 'settings-github' && login?.status === 'failed' ? { text: t('GitHub 登录失败：{p0}', { p0: githubErrors[login.error ?? ''] ?? login.error }), error: true }
    : state.view === 'settings-tailscale' && state.tailscaleError ? { text: state.tailscaleError, error: true }
    : state.view === 'settings-tailscale' && state.tailscale?.login.status === 'failed' ? { text: t('Tailscale 登录失败：{p0}', { p0: tailscaleErrors[state.tailscale.login.error ?? ''] ?? t('请重试。') }), error: true }
    : remote ? { text: t('通过 Tailscale 访问时只能查看；请在这台 Mac 上修改设置。'), error: false } : undefined);
  const banner = $('settings-banner');
  banner.hidden = !note; banner.className = note && !note.error ? 'banner note' : 'banner';
  setText('settings-banner', resolveText(note?.text));
  renderGitHub(remote); renderLark(remote); renderTailscale(); renderBackup(remote);
}

// ---- Updates ----
const updateTag = (update: UpdateView): string => update.version ? `v${update.version.replace(/^v/, '')}` : '';
const megabytes = (bytes: number): string => `${new Intl.NumberFormat(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / 1048576)} MB`;
/** The native window's policy cancels this navigation and hands the request to its update worker. */
function askNative(action: 'check' | 'install'): void { location.href = `nootify://update/${action}`; }
function updateStatus(update: UpdateView): string {
  const tag = updateTag(update);
  if (update.phase === 'checking') return t('正在检查更新…');
  if (update.phase === 'available') return t('发现新版本 {p0}{p1}', { p0: tag, p1: update.error ? t('；{p0}', { p0: update.error }) : '' });
  if (update.phase === 'downloading') {
    const amount = update.total ? `${megabytes(update.received)} / ${megabytes(update.total)} · ${Math.min(100, Math.floor(update.received * 100 / update.total))}%` : megabytes(update.received);
    return t('正在下载 {p0} · {p1}', { p0: tag, p1: amount });
  }
  if (update.phase === 'installing') return t('正在安装 {p0}…', { p0: tag });
  if (update.phase === 'restarting') return t('已安装 {p0}，正在重启…', { p0: tag });
  if (update.phase === 'failed') return t('检查更新失败：{p0}', { p0: update.error ?? t('未知错误') });
  if (update.phase === 'current') return t('已是最新版本{p0}', { p0: update.checked_at ? t(' · {p0}检查', { p0: ago(new Date(update.checked_at).toISOString()) }) : '' });
  return t('启动后自动检查，之后约每 6 小时检查一次');
}
function compactUpdateStatus(update: UpdateView): string {
  if (update.phase === 'checking') return t('检查中…');
  if (update.phase === 'downloading') return update.total
    ? t('下载中 {p0}%', { p0: Math.min(100, Math.floor(update.received * 100 / update.total)) })
    : t('下载中…');
  if (update.phase === 'installing') return t('安装中…');
  if (update.phase === 'restarting') return t('重启中…');
  if (update.phase === 'available') return update.error ? t('重试更新') : t('更新 {p0}', { p0: updateTag(update) });
  if (update.phase === 'failed') return t('重试检查');
  if (update.phase === 'current') return t('已是最新');
  return t('检查更新');
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
  // Routine background checks stay quiet; only an available update or its installation
  // belongs in the title row. The About page keeps manual checks and full status visible.
  $('titlebar-update').hidden = !update?.version || !['checking', 'available', 'downloading', 'installing', 'restarting'].includes(update.phase);
  $('titlebar-update').classList.toggle('has-error', !!failed);
  const button = $<HTMLButtonElement>('update-action');
  button.classList.toggle('busy', working);
  if (update) {
    const action = updateAction(update);
    const hint = action === 'install' ? t('安装 {p0}，完成后自动重启', { p0: updateTag(update) }) : action === 'details' ? t('查看更新详情') : t('检查软件更新');
    setText('update-action-label', compactUpdateStatus(update));
    button.title = t('{p0}；{p1}', { p0: updateStatus(update), p1: hint });
    button.setAttribute('aria-label', button.title);
    $('update-action-icon').setAttribute('d', working ? 'M13 8a5 5 0 1 1-5-5'
      : update.phase === 'current' ? 'm3.5 8 3 3 6-6'
      : failed ? 'M13.2 8A5.2 5.2 0 1 1 11.7 4.3M13.2 2.6v3.1h-3.1' : 'M8 13V3M4 7l4-4 4 4');
  }
  const aboutButton = $<HTMLButtonElement>('about-update-action');
  aboutButton.hidden = !update;
  aboutButton.disabled = working;
  if (update) setText('about-update-action', updateAction(update) === 'check' ? t('检查更新') : compactUpdateStatus(update));
  const service = state.settings?.version;
  setText('about-version', [update ? t('应用 {p0}', { p0: update.current }) : '', service ? t('后台服务 {p0}', { p0: service }) : ''].filter(Boolean).join(' · ') || '—');
  setText('update-status', update ? updateStatus(update) : t('在 Nootify 桌面应用里检查和安装更新'));
}

// ---- Chrome, loading and events ----
function closeTitlebarSearches(): void {
  for (const group of document.querySelectorAll<HTMLElement>('.titlebar-search')) {
    group.removeAttribute('data-open');
    group.querySelector('.search-toggle')!.setAttribute('aria-expanded', 'false');
  }
}
function focusTitlebarSearch(id: string): void {
  const input = field(id);
  const group = input.closest<HTMLElement>('.titlebar-search')!;
  const toggle = group.querySelector<HTMLButtonElement>('.search-toggle')!;
  closeTitlebarSearches();
  if (getComputedStyle(toggle).display !== 'none') {
    group.setAttribute('data-open', '');
    toggle.setAttribute('aria-expanded', 'true');
  }
  input.focus();
}
function renderSearchToggles(): void {
  for (const group of document.querySelectorAll<HTMLElement>('.titlebar-search')) {
    const input = group.querySelector<HTMLInputElement>('input')!;
    const toggle = group.querySelector<HTMLButtonElement>('.search-toggle')!;
    const query = input.value.trim();
    const label = input.getAttribute('aria-label')!;
    group.classList.toggle('has-query', !!query);
    toggle.title = query ? `${label}: ${query}` : label;
    toggle.setAttribute('aria-label', toggle.title);
  }
}
function revealActiveNavigation(): void {
  if (document.documentElement.hasAttribute('data-nootify-desktop') || !matchMedia('(max-width: 760px)').matches) return;
  const active = document.querySelector<HTMLElement>('.sidebar .nav-item[aria-current="page"]');
  const navigation = active?.closest<HTMLElement>('nav');
  if (!active || !navigation) return;
  const item = active.getBoundingClientRect();
  const track = navigation.getBoundingClientRect();
  navigation.scrollLeft += item.left - track.left - (navigation.clientWidth - item.width) / 2;
}
function renderPauseButton(): void {
  const label = state.paused ? t('继续') : t('暂停');
  $('pause-label').textContent = label;
  $('pause').title = label;
  $('pause').setAttribute('aria-label', label);
  $('pause').setAttribute('aria-pressed', String(state.paused));
  $('pause-icon').setAttribute('d', state.paused ? 'M5 3.5 12 8l-7 4.5z' : 'M5.5 3v10M10.5 3v10');
}
function renderChrome(): void {
  const meta = views[state.view];
  $('logs-actions').hidden = state.view !== 'logs';
  $('pull-actions').hidden = !isPullView(state.view);
  $('repo-actions').hidden = state.view !== 'repos';
  renderPauseButton();
  renderSearchToggles();
  $('connection').textContent = state.connected ? t('实时更新') : state.connectionError ? t('连接中断') : t('正在连接');
  if (state.connectionError) $('error').textContent = t('无法连接本机服务：{p0}。正在自动重试。', { p0: state.connectionError });
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
  $('internal-count').textContent = internal === undefined ? '' : number(internal);
  $('upstream-count').textContent = upstream === undefined ? '' : number(upstream);
  const followedRepos = pullSummary?.followed ?? state.pulls?.repositories.filter(entry => entry.followed).length;
  $('repos-count').textContent = followedRepos === undefined ? '' : number(followedRepos);
  const busy = usesPulls(state.view) && Boolean(pullSummary?.running || state.pulls?.refresh.running);
  $('refresh').classList.toggle('busy', busy);
  const label = usesPulls(state.view) ? t('在后台刷新 GitHub 数据') : t('立即刷新');
  $('refresh').title = label; $('refresh').setAttribute('aria-label', label);
  $('updated').textContent = usesPulls(state.view)
    ? (busy ? t('后台刷新中') : state.pulls?.refresh.lastSuccessAt ? t('{p0}刷新', { p0: ago(state.pulls.refresh.lastSuccessAt) }) : '')
    : state.snapshot.time ? t('更新于 {p0}', { p0: clock(state.snapshot.time) }) : '';
  if (changed('modules', state.snapshot.modules)) {
    $('modules').replaceChildren(...state.snapshot.modules.filter(module => module.name in moduleNames).map(module => {
      const status = moduleStates[module.status] ?? { label: module.status, tone: 'muted' };
      const display = module.name === 'lark' && module.status === 'ready' ? { label: t('已连接'), tone: 'ok' } : status;
      const line = node('div', undefined, 'status-line');
      line.append(node('span', undefined, `dot ${display.tone === 'muted' ? '' : display.tone}`), node('span', moduleNames[module.name] ?? module.name), node('span', display.label, 'value'));
      return line;
    }));
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  $('access-label').textContent = local ? location.host : t('经 Tailscale');
  const tailnet = state.snapshot.access?.tailnet_url;
  $('tailnet-line').hidden = !local || !tailnet;
  $('tailnet-url').textContent = tailnet ? tailnet.replace(/^https?:\/\//, '').replace(/\/$/, '') : '';
  $('tailnet-url').title = tailnet ? t('tailnet 内其他设备的访问地址：{p0}', { p0: tailnet }) : '';
}
function renderAll(): void { renderChrome(); renderLogs(); renderSessions(); renderAgents(); renderPulls(); renderRepos(); renderSettings(); }
async function loadSnapshot(): Promise<void> {
  if (state.loading) return;
  state.loading = true;
  try {
    const response = await fetch('/ui/api/snapshot', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.snapshot = await response.json() as Snapshot;
    state.connected = true; state.connectionError = undefined;
    $('error').hidden = true;
    $('connection').textContent = t('实时更新'); $('connection-dot').className = 'dot ok';
    renderChrome(); renderLogs(); renderSessions(); renderSettings();
    if (usesPulls(state.view) && (state.snapshot.pulls?.running || state.pulls?.refresh.running)) void loadPulls();
  } catch (error) {
    state.connected = false; state.connectionError = (error as Error).message;
    $('error').textContent = t('无法连接本机服务：{p0}。正在自动重试。', { p0: (error as Error).message });
    $('error').hidden = false; $('connection').textContent = t('连接中断'); $('connection-dot').className = 'dot error';
  } finally { state.loading = false; }
}
async function loadPulls(): Promise<void> {
  if (state.loadingPulls) return;
  state.loadingPulls = true;
  try {
    const response = await fetch('/ui/api/pulls', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(response.status === 404 ? t('PR 模块未启用') : `HTTP ${response.status}`);
    state.pulls = await response.json() as PullSnapshot;
    assignRepositoryColors(state.pulls);
    state.pullsError = '';
  } catch (error) { state.pullsError = (error as Error).message; }
  finally { state.loadingPulls = false; renderChrome(); renderPulls(); renderRepos(); }
}
async function refreshNow(): Promise<void> {
  if (state.view === 'agents') {
    state.agentsError = '';
    await Promise.all([loadSnapshot(), loadAgents()]); return;
  }
  if (isSettingsView(state.view)) {
    await Promise.all([loadSnapshot(), loadSettings(), ...(state.view === 'settings-github' ? [loadGitHub()] : []), ...(state.view === 'settings-tailscale' ? [loadTailscale()] : [])]);
    return;
  }
  if (!usesPulls(state.view)) { await loadSnapshot(); return; }
  $('refresh').classList.add('busy');
  try {
    const response = await fetch('/ui/api/pulls/refresh', { method: 'POST', headers: { 'x-nootify-ui': '1' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) { state.pullsError = () => t('无法开始刷新：{p0}', { p0: (error as Error).message }); }
  await loadPulls();
}

window.addEventListener('hashchange', () => {
  closeTitlebarSearches();
  state.view = viewFromHash();
  if (state.view !== 'settings-lark') { showLarkSecret(false); if (state.recipientPicker) closeRecipientPicker(); }
  state.settingsNote = undefined;
  renderAll();
  requestAnimationFrame(revealActiveNavigation);
  if (usesPulls(state.view)) void loadPulls();
  if (state.view === 'agents') void loadAgents();
  loadSettingsView();
  $(views[state.view].section).scrollTop = 0;
});
window.addEventListener('nootify-update', event => { state.update = (event as CustomEvent<UpdateView>).detail; renderUpdate(); });
for (const id of ['update-action', 'about-update-action']) $(id).addEventListener('click', () => {
  if (!state.update) return;
  const action = updateAction(state.update);
  if (action === 'details') location.hash = views['settings-about'].hash;
  else askNative(action);
});
type TailscaleAction = { action: 'enable'; enabled: boolean } | { action: 'login' | 'cancel' | 'logout' };
function runTailscaleAction(body: TailscaleAction, failure: TranslatedText): void {
  void settingsRun('tailscale', failure, async () => {
    await post('/ui/api/settings/tailscale', body);
    await loadTailscale();
  });
}
$('tailscale-enabled').addEventListener('change', () => {
  runTailscaleAction({ action: 'enable', enabled: field('tailscale-enabled').checked }, () => t('无法修改远程访问'));
});
$('tailscale-login').addEventListener('click', () => runTailscaleAction({ action: 'login' }, () => t('无法开始 Tailscale 登录')));
$('tailscale-cancel').addEventListener('click', () => runTailscaleAction({ action: 'cancel' }, () => t('无法取消登录')));
$('tailscale-logout').addEventListener('click', () => runTailscaleAction({ action: 'logout' }, () => t('无法退出 Nootify 节点')));
$('tailscale-copy').addEventListener('click', () => {
  const url = state.tailscale?.url; if (!url) return;
  void (navigator.clipboard?.writeText(url) ?? Promise.reject(new Error('Clipboard is unavailable'))).then(() => {
    setText('tailscale-copy', t('已复制')); setTimeout(() => setText('tailscale-copy', t('复制地址')), 2000);
  }, () => { getSelection()?.selectAllChildren($('tailscale-address')); setText('tailscale-copy', t('已选中，按 ⌘C')); });
});
$('github-login').addEventListener('click', () => {
  void settingsRun('github', () => t('无法开始登录'), async () => {
    state.github = { account: state.github?.account, login: await post<GitHubLogin>('/ui/api/settings/github/login', { action: 'start' }) };
  });
});
$('github-cancel').addEventListener('click', () => {
  void settingsRun('github', () => t('无法取消登录'), async () => { await post('/ui/api/settings/github/login', { action: 'cancel' }); await loadGitHub(); });
});
$('github-logout').addEventListener('click', () => {
  void settingsRun('github', () => t('无法退出登录'), async () => { await post('/ui/api/settings/github/login', { action: 'sign-out' }); await loadGitHub(); return () => t('已退出 GitHub 登录'); });
});
$('github-copy').addEventListener('click', () => {
  const code = state.github?.login.code;
  if (!code) return;
  // The clipboard API can be missing or refused; selecting the code then leaves ⌘C.
  void (navigator.clipboard?.writeText(code) ?? Promise.reject(new Error('Clipboard is unavailable'))).then(() => {
    setText('github-copy', t('已复制'));
    setTimeout(() => setText('github-copy', t('复制')), 2000);
  }, () => { getSelection()?.selectAllChildren($('github-code')); setText('github-copy', t('已选中，按 ⌘C')); });
});
function showLarkSecret(visible: boolean): void {
  field('lark-app-secret').type = visible ? 'text' : 'password';
  const toggle = $('lark-secret-toggle');
  const label = visible ? t('隐藏 App Secret') : t('显示 App Secret');
  toggle.setAttribute('aria-label', label); toggle.title = label;
  toggle.setAttribute('aria-pressed', String(visible));
  $('lark-secret-slash').toggleAttribute('hidden', !visible);
}
$('lark-secret-toggle').addEventListener('click', () => {
  if (state.settings?.editable !== true || state.pendingSettings.has('lark') || state.pendingSettings.has('lark-secret')) return;
  const input = field('lark-app-secret');
  if (input.type === 'text') { showLarkSecret(false); return; }
  const appId = field('lark-app-id').value.trim();
  if (input.value || !state.settings.lark.configured || appId !== state.settings.lark.app_id) { showLarkSecret(true); return; }
  void settingsRun('lark-secret', () => t('无法查看 App Secret'), async () => {
    const secret = await post<{ app_id?: string; app_secret?: string }>('/ui/api/settings/lark/secret');
    if (state.view !== 'settings-lark' || field('lark-app-id').value.trim() !== appId || input.value) return;
    if (secret.app_id !== appId || !secret.app_secret) throw new Error(t('应用凭据已变更，请刷新后重试'));
    input.value = secret.app_secret;
    showLarkSecret(true);
  });
});
/** A scan can commit between the last status poll and a cancel/retry click. Reconcile that saved app before dismissing the flow. */
async function cancelLarkQr(): Promise<boolean> {
  const previous = state.larkRegistration;
  const next = await post<LarkRegistrationPage>('/ui/api/settings/lark/registration', { action: 'cancel' });
  const completed = next.status === 'complete' ? next : previous?.status === 'complete' ? previous : undefined;
  state.larkRegistration = completed ?? next;
  if (!completed) return false;
  state.larkConnectionType = 'personal-app'; state.larkEdited = false;
  state.larkSetup = completed.setup; invalidateRecipientDirectory();
  const [loaded] = await Promise.all([loadSettings(), loadSnapshot()]);
  if (!loaded || state.settings?.lark.app_id !== completed.app_id || state.settings?.lark.connection_type !== 'personal-app') {
    throw new Error(t('应用已保存，请刷新设置查看当前连接。'));
  }
  state.larkRegistration = { status: 'idle' };
  return true;
}
function selectLarkType(type: LarkConnectionType): void {
  if (state.settings?.editable !== true || state.pendingSettings.has('lark-registration') || state.pendingSettings.has('lark') || type === selectedLarkType()) return;
  void settingsRun('lark-registration', () => t('更改接入类型失败'), async () => {
    if (state.larkRegistration && state.larkRegistration.status !== 'idle') await cancelLarkQr();
    state.larkConnectionType = type; state.larkManual = false; state.larkEdited = false; fillLark();
  });
}
$('lark-type-bot').addEventListener('click', () => selectLarkType('bot'));
$('lark-type-personal').addEventListener('click', () => selectLarkType('personal-app'));
function startLarkQr(refresh = false): void {
  if (state.settings?.editable !== true || state.settings.lark.source === 'environment' || state.pendingSettings.has('lark-registration')) return;
  void settingsRun('lark-registration', () => t('无法开始扫码配置'), async () => {
    if (refresh && await cancelLarkQr()) return () => t('应用已保存');
    state.larkConnectionType = 'personal-app'; state.larkManual = false; state.larkEdited = false; fillLark();
    state.larkRegistration = await post<LarkRegistrationPage>('/ui/api/settings/lark/registration', { action: 'start' });
  }).then(() => { if (larkRegistrationActive()) $('lark-registration-cancel').focus(); });
}
$('lark-qr-start').addEventListener('click', () => startLarkQr());
$('lark-qr-refresh').addEventListener('click', () => startLarkQr(true));
$('lark-registration-cancel').addEventListener('click', () => {
  void settingsRun('lark-registration', () => t('无法取消扫码配置'), async () => {
    await cancelLarkQr();
  }).then(() => $('lark-qr-start').focus());
});
$('lark-use-existing').addEventListener('click', () => {
  if (state.settings?.editable !== true || state.pendingSettings.has('lark-registration')) return;
  const open = !state.larkManual;
  void settingsRun('lark-registration', () => t('无法取消扫码配置'), async () => {
    if (larkRegistrationActive()) await cancelLarkQr();
    state.larkManual = open; showLarkSecret(false);
  }).then(() => { if (open) field('lark-app-id').focus(); });
});
$('lark-setup-retry').addEventListener('click', () => { void loadLarkSetup(); });
function saveLark(): void {
  if (state.settings?.editable !== true || state.pendingSettings.has('lark') || state.pendingSettings.has('lark-secret')) return;
  void settingsRun('lark', () => t('无法保存飞书凭据'), async () => {
    await post('/ui/api/settings/lark', { app_id: field('lark-app-id').value.trim(), app_secret: field('lark-app-secret').value, connection_type: selectedLarkType() });
    state.larkConnectionType = undefined;
    state.larkRegistration = { status: 'idle' }; state.larkSetup = undefined;
    state.larkEdited = false; invalidateRecipientDirectory();
    await Promise.all([loadSettings(), loadSnapshot()]);
    return () => {
      const status = state.snapshot.modules.find(module => module.name === 'lark')?.status;
      return status === 'ready' ? t('凭据已保存，飞书已连接') : status === 'failed' ? t('凭据已保存，连接失败，请重试') : t('凭据已保存，正在重新连接飞书…');
    };
  });
}
function saveRecipient(): void {
  void settingsRun('recipient', () => t('无法保存接收人'), async () => {
    await post('/ui/api/settings/recipient', { open_id: field('lark-recipient').value.trim(), app_id: state.settings?.lark.app_id });
    await loadSettings();
    return () => t('接收人已保存');
  });
}
$('lark-save').addEventListener('click', saveLark);
$('recipient-save').addEventListener('click', saveRecipient);
$('recipient-choose').addEventListener('click', () => {
  if (state.settings?.editable !== true) return;
  if (state.recipientDirectory?.expires_at && state.recipientDirectory.expires_at <= Date.now()) invalidateRecipientDirectory();
  state.recipientPicker = true; state.recipientDraft = state.recipientActive = field('lark-recipient').value;
  state.recipientSaveError = ''; state.recipientPermissionOpen = state.recipientError === 403 && !!state.recipientPermission;
  field('recipient-search').value = '';
  if (state.recipientDirectory) state.recipientDirectory.cached = true;
  renderRecipientPicker(false); $('recipient-options').parentElement!.scrollTop = 0;
  if (!state.recipientDirectory || Date.now() >= (state.recipientDirectory.refresh_after ?? state.recipientLoadedAt + 60000)) void loadRecipients();
});
for (const id of ['recipient-close', 'recipient-cancel']) $(id).addEventListener('click', closeRecipientPicker);
for (const id of ['recipient-reload', 'recipient-empty-retry', 'recipient-permission-retry']) $(id).addEventListener('click', () => { void loadRecipients(true); });
$('recipient-confirm').addEventListener('click', () => { void confirmRecipient(); });
$('recipient-show-permission').addEventListener('click', () => { state.recipientPermissionOpen = true; renderRecipientPicker(false); });
$('recipient-manual').addEventListener('click', () => { closeRecipientPicker(); field('lark-recipient').focus(); field('lark-recipient').select(); });
field('recipient-search').addEventListener('input', () => { renderRecipientPicker(state.settings?.editable === false); $('recipient-options').parentElement!.scrollTop = 0; });
field('recipient-search').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') { event.preventDefault(); $('recipient-options').focus(); renderRecipientPicker(false); }
});
$('recipient-options').addEventListener('keydown', event => {
  const users = recipientUsers(); if (!users.length) return;
  const index = Math.max(0, users.findIndex(user => user.open_id === state.recipientActive));
  let next = index;
  if (event.key === 'ArrowDown') next = Math.min(users.length - 1, index + 1);
  else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = users.length - 1;
  else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault(); state.recipientDraft = users[index]!.open_id; renderRecipientPicker(false);
    if (event.key === 'Enter') $('recipient-confirm').focus(); return;
  } else return;
  event.preventDefault(); state.recipientActive = users[next]!.open_id; $('recipient-options').focus(); renderRecipientPicker(false);
  document.getElementById(`recipient-person-${state.recipientActive}`)?.scrollIntoView({ block: 'nearest' });
});
$('recipient-picker').addEventListener('cancel', event => { event.preventDefault(); closeRecipientPicker(); });
$('recipient-picker').addEventListener('click', event => {
  if (event.target !== $('recipient-picker')) return;
  const box = $('recipient-picker').getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeRecipientPicker();
});
for (const id of ['lark-app-id', 'lark-app-secret', 'lark-recipient']) {
  field(id).addEventListener('input', () => { state.larkEdited = true; renderLark(state.settings?.editable === false); });
  field(id).addEventListener('keydown', event => { if (event.key === 'Enter') { if (id === 'lark-recipient') saveRecipient(); else saveLark(); } });
}
$('lark-clear').addEventListener('click', () => {
  if (!state.confirmClear) {
    state.confirmClear = true; renderSettings();
    setTimeout(() => { state.confirmClear = false; renderSettings(); }, 4000);
    return;
  }
  state.confirmClear = false;
  void settingsRun('lark', () => t('无法清除飞书凭据'), async () => {
    await post('/ui/api/settings/lark', { clear: true });
    state.larkConnectionType = undefined; state.larkManual = false;
    state.larkRegistration = { status: 'idle' }; state.larkSetup = undefined;
    state.larkEdited = false; invalidateRecipientDirectory();
    await loadSettings();
    return () => t('已清除保存的凭据');
  });
});
$('export-config').addEventListener('click', () => {
  void settingsRun('export', () => t('无法导出配置'), async () => { await post('/ui/api/settings/export'); await loadSettings(); return () => t('配置已导出'); });
});
$('export-reveal').addEventListener('click', () => { void settingsRun('export', () => t('无法打开访达'), async () => { await post('/ui/api/settings/reveal'); }); });
$('import-choose').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', () => {
  const input = field('import-file'); const file = input.files?.[0];
  input.value = ''; // The same file can be chosen again after a change to it.
  if (!file) return;
  void settingsRun('import', () => t('无法读取 {p0}', { p0: file.name }), async () => {
    if (file.size > 1024 * 1024) throw new Error(t('文件超过 1 MiB'));
    let content: unknown;
    try { content = JSON.parse(await file.text()); } catch { throw new Error(t('不是有效的 JSON 文件')); }
    state.importing = { name: file.name, content, summary: await post<ImportSummary>('/ui/api/settings/import', { document: content }) };
  });
});
$('import-cancel').addEventListener('click', () => { state.importing = undefined; renderSettings(); });
$('import-apply').addEventListener('click', () => {
  const importing = state.importing;
  if (!importing) return;
  void settingsRun('import', () => t('无法导入配置'), async () => {
    const result = await post<ImportSummary>('/ui/api/settings/import', { document: importing.content, apply: true });
    state.importing = undefined; state.larkEdited = false; invalidateRecipientDirectory();
    state.larkConnectionType = undefined; state.larkManual = false;
    state.larkRegistration = undefined; state.larkSetup = undefined;
    await Promise.all([loadSettings(), loadAgents()]);
    return () => t('配置已导入{p0}', { p0: result.warnings.length ? t('；{p0}', { p0: result.warnings.join(t('；')) }) : '' });
  });
});
$('refresh').addEventListener('click', () => { void refreshNow(); });
for (const group of document.querySelectorAll<HTMLElement>('.titlebar-search')) {
  const toggle = group.querySelector<HTMLButtonElement>('.search-toggle')!;
  const input = group.querySelector<HTMLInputElement>('input')!;
  toggle.addEventListener('click', () => {
    if (group.hasAttribute('data-open')) closeTitlebarSearches();
    else focusTitlebarSearch(input.id);
  });
  input.addEventListener('input', renderSearchToggles);
  group.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !group.hasAttribute('data-open')) return;
    event.preventDefault();
    closeTitlebarSearches();
    toggle.focus();
  });
  group.addEventListener('focusout', event => {
    // Safari blurs the input without focusing a clicked button; let that click toggle the current state.
    // Outside pointer interactions are dismissed by the document's pointerdown handler.
    if (!event.relatedTarget || group.contains(event.relatedTarget as Node)) return;
    group.removeAttribute('data-open');
    toggle.setAttribute('aria-expanded', 'false');
  });
}
document.addEventListener('pointerdown', event => {
  if (event.target instanceof Element && !event.target.closest('.titlebar-search')) closeTitlebarSearches();
});
$('search').addEventListener('input', () => renderLogs(true));
$('pull-search').addEventListener('input', () => renderPulls());
$('repo-search').addEventListener('input', () => renderRepos());
$('pull-sort').addEventListener('click', () => { state.pullSort = state.pullSort === 'asc' ? 'desc' : 'asc'; renderPulls(); });
$('pause').addEventListener('click', () => {
  state.paused = !state.paused;
  renderPauseButton();
  if (!state.paused) renderLogs(true);
});
$('export').addEventListener('click', () => {
  const blob = new Blob([filteredLogs().map(entry => JSON.stringify(entry)).join('\n') + '\n'], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const link = node('a'); link.href = url; link.download = `nootify-logs-${new Date().toISOString().slice(0, 10)}.ndjson`; link.click();
  URL.revokeObjectURL(url);
});
document.addEventListener('keydown', event => {
  if (state.recipientPicker && event.key === '/' && !['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement).tagName)) { event.preventDefault(); field('recipient-search').focus(); return; }
  if (event.key !== '/' || ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName)) return;
  event.preventDefault();
  if (isPullView(state.view)) focusTitlebarSearch('pull-search');
  else if (state.view === 'repos') focusTitlebarSearch('repo-search');
  else if (state.view === 'logs') focusTitlebarSearch('search');
  else {
    window.addEventListener('hashchange', () => focusTitlebarSearch('search'), { once: true });
    location.hash = views.logs.hash;
  }
});

function renderLanguage(): void {
  ({ views, descriptions, reasons, sourceNames, categories, outcomeTabs, pullTabs, repoTabs, agentNames, promptStates, adapters, availability, reviews, moduleNames, moduleStates, credentialSources, githubErrors, tailscaleErrors } = translatedLabels());
  relative = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  translateDocument();
  state.signatures.clear();
  $<HTMLSelectElement>('language').value = languagePreference();
  renderAll();
  renderLogs(true); // Paused logs still need their labels refreshed.
  requestAnimationFrame(revealActiveNavigation);
}
$('language').addEventListener('change', () => {
  const value = $<HTMLSelectElement>('language').value;
  if (!isPreference(value)) return;
  setLanguage(value);
  renderLanguage();
  if ((window as Window & { __NOOTIFY_LANGUAGE__?: NativeLanguage }).__NOOTIFY_LANGUAGE__) location.href = `nootify://language/${value}`;
});
window.addEventListener('nootify-language', event => {
  const native = (event as CustomEvent<NativeLanguage>).detail;
  if (!native || !isPreference(native.preference) || !['zh-CN', 'en'].includes(native.locale)) return;
  setLanguage(native.preference, native);
  renderLanguage();
});
window.addEventListener('languagechange', () => { if (languagePreference() === 'system') renderLanguage(); });
window.addEventListener('storage', event => {
  if ((window as Window & { __NOOTIFY_LANGUAGE__?: NativeLanguage }).__NOOTIFY_LANGUAGE__ || event.key !== languageStorageKey) return;
  if (event.newValue !== null && !isPreference(event.newValue)) return;
  setLanguage(event.newValue ?? 'system');
  renderLanguage();
});

renderLanguage();
requestAnimationFrame(revealActiveNavigation);
window.addEventListener('resize', revealActiveNavigation);
void loadSnapshot();
void loadAgents();
if (usesPulls(state.view)) void loadPulls();
loadSettingsView();
setInterval(() => {
  void loadSnapshot();
  if (state.view === 'settings-github' && loginActive(state.github?.login)) void loadGitHub();
  if (state.view === 'settings-lark' && (larkRegistrationActive() || state.larkReconcilePending || !state.larkRegistration)) void loadLarkRegistration();
  if (state.view === 'settings-tailscale') void loadTailscale();
}, 2000);
setInterval(() => { if (usesPulls(state.view)) void loadPulls(); }, 10000);
