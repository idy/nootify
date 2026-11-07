import { hostname } from 'node:os';
import type { AgentPrompts } from './agents.js';
import { conversationSessions, defaultSources, type ConversationSources } from './conversations.js';
import type { ThreadDiscovery } from './lark-thread-sync.js';
import type { State } from './state.js';
import { isPolledAdapter } from './types.js';

/** Notification enrollment applies to old conversations as well as newly injected prompts. */
export function sessionThreadDiscovery(agents: Pick<AgentPrompts, 'list'>, state: State,
  report: (record: Record<string, unknown>) => void, sources: ConversationSources = defaultSources()): ThreadDiscovery {
  return async function* (signal) {
    const enabled = new Set((await agents.list()).filter(agent => agent.injected && !['error', 'conflict'].includes(agent.status)).map(agent => agent.agent));
    signal.throwIfAborted();
    const selected: ConversationSources = {
      ...(enabled.has('claude') ? { claudeDir: sources.claudeDir, desktopRoots: sources.desktopRoots } : {}),
      ...(enabled.has('codex') ? { codexHome: sources.codexHome } : {}),
      ...(enabled.has('opencode') ? { opencodeData: sources.opencodeData } : {}),
    };
    const { sessions, warnings } = await conversationSessions(selected, { includeTranscripts: false });
    for (const error of warnings) report({ source: 'lark', status: 'lark_discovery_failed', error });
    // Recent conversations receive their missing group first, without an arbitrary age cutoff.
    sessions.sort((a, b) => (b.lastActive ?? '').localeCompare(a.lastActive ?? ''));
    for (const session of sessions) {
      signal.throwIfAborted();
      if (session.archived || (['claude-desktop', 'codex'].includes(session.adapter) && session.archived !== false)) continue;
      if (!/^[A-Za-z0-9._-]+$/.test(session.id)) continue;
      yield { adapter: session.adapter, session_id: session.id, session_name: session.title.trim().slice(0, 80) || session.id };
    }
    // Cooperative clients have no native discovery API; their explicitly registered IDs are authoritative.
    for (const session of state.sessions.values()) {
      signal.throwIfAborted();
      if (isPolledAdapter(session.adapter) && enabled.has(session.adapter) && session.host_id === hostname()) {
        yield { adapter: session.adapter, session_id: session.session_id, session_name: session.session_name };
      }
    }
  };
}
