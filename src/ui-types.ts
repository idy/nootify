// Browser API declarations. This file deliberately imports no backend modules.

export interface ProviderSummary {
  id: string; name: string; type: 'feishu' | 'remote'; enabled: boolean; status: string; error?: string;
  connection_type?: LarkConnectionType; app_id?: string; recipient_open_id?: string; address?: string; tls?: boolean; server_name?: string;
  secret_set?: boolean; token_set?: boolean;
}
export interface RemoteSummary {
  enabled: boolean; listen: string; status: string; tls: boolean; token_set: boolean;
  tls_cert_file?: string; tls_key_file?: string;
  peers: { node_id: string; name?: string; connected_at: string; connected?: boolean; pending: number; last_ack?: string }[];
}

export interface LogEntry {
  id: string;
  time: string;
  status: string;
  source?: string;
  session_id?: string;
  session_name?: string;
  chat_id?: string;
  message_id?: string;
  reply_id?: string;
  sender_open_id?: string;
  reason?: string;
  error?: string;
  preview?: string;
}

export type ConversationAgent = 'claude' | 'codex' | 'opencode';

export type Adapter = 'claude-code' | 'claude-desktop' | 'codex' | 'opencode' | PolledAdapter;

export type PolledAdapter = 'trae' | 'workbuddy';

export interface ModuleStatus { name: string; status: string }

export type PublicSession = Pick<SessionRecord, 'session_id' | 'host_id' | 'adapter' | 'session_name'> & {
  availability?: 'active' | 'archived' | 'offline' | 'unknown' | 'missing';
  last_seen?: string;
  last_result?: string;
};

export interface SessionRecord extends SessionRegistration { session_id: string; host_id: string }

export interface SessionRegistration {
  adapter: Adapter;
  session_name: string;
  socket_path?: string;
  socket_token?: string;
}

export interface AgentPrompt { agent: AgentId; name: string; file: string; files?: string[]; status: PromptStatus; injected: boolean; block: string; error?: string }

export type AgentId = 'claude' | 'codex' | 'opencode' | 'trae' | 'workbuddy';

export type PromptStatus = 'missing' | 'absent' | 'current' | 'outdated' | 'conflict' | 'error';

export interface ImportSummary {
  exported_at?: string; app_id?: string; recipient?: string; backends: string[]; agents: AgentId[];
  warnings: string[];
  provider_count?: number;
}

export interface SettingsPage {
  version: string;
  exports_dir: string;
  last_export?: string;
  lark: { status: string; configured: boolean; connection_type: LarkConnectionType; source?: CredentialSource; app_id?: string; saved: boolean; recipient?: string; groups: number; mirror_status?: 'pending' };
}

export type LarkConnectionType = 'bot' | 'personal-app';

export type CredentialSource = 'environment' | 'settings' | 'mcp-config';

export interface LarkRecipientsPage extends Omit<LarkDirectory, 'permission'> { permission?: LarkPermissionHelp; cached?: boolean; fetched_at?: number; refresh_after?: number; expires_at?: number }

export interface LarkDirectory {
  app_id: string; users: LarkRecipient[]; truncated: boolean; permission_limited: boolean;
  permission?: LarkDirectoryPermission;
}

export interface LarkRecipient { open_id: string; name: string; en_name?: string; nickname?: string; avatar_url?: string }

export type LarkDirectoryPermission = LarkPermission;

export interface LarkPermission { url?: string; scopes: string[] }

export interface LarkPermissionHelp extends LarkPermission { url: string; qr: string }

export interface LarkRegistrationPage {
  status: 'idle' | 'starting' | 'waiting' | 'connecting' | 'complete' | 'failed';
  url?: string;
  qr?: string;
  expires_at?: string;
  app_id?: string;
  error?: string;
  setup?: LarkSetup;
}

export interface LarkSetup {
  app_id: string;
  status: 'ready' | 'permissions-required' | 'unavailable';
  missing: string[];
  mention_only: boolean;
  permission?: LarkPermissionHelp;
}
