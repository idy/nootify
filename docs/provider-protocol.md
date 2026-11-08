# Provider core protocol

This document defines the implementation contract between the Go notification core, the existing Node agent runtime, and the local UI. Agent sessions are the business identity. Platform groups and topics are private provider implementation details.

## Components

- `native/core`: Go executable `nootify-core`; owns providers, notification-session mappings, delivery records, Feishu WebSocket ingestion, and authenticated gRPC remote connections.
- The Node service retains existing agent input transports, CLI compatibility, settings UI, GitHub, and desktop lifecycle. It starts the core as a private stdio child. Production never starts the legacy Feishu history poller.
- Provider types are `feishu` and `remote`. Both can have multiple named instances. A remote instance connects to another Nootify; that remote server broadcasts unhandled incoming events to every independently subscribed downstream.
- `native/tailscale` retains the embedded Tailscale identity. Private RPC tunnels and published listeners let the core use that identity without depending on the operating system Tailscale installation.

## Identity and content

A session is `{node_id, adapter, session_id, name?, metadata?}`. `node_id` is a core-generated stable UUID. The bridge fills a missing local node ID. Existing hostname bindings are adopted during migration without changing the original agent session ID.

A message reference contains `{origin_node_id, provider_id, message_id}`; optional `thread_id` preserves the original Feishu reply thread as return-route context without changing message identity. Provider IDs belong to their originating node. The reference survives every relay and durable replay unchanged. Resolving a legacy message ID or a three-field reference recovers retained thread context, and acknowledgement must not erase it.

Content is `{text?: string, blocks?: ContentBlock[]}`. Blocks use `{type, text?, url?, children?}` and support at least paragraph, text, link, and code. Providers must reject unsupported blocks rather than silently discard them. Plain text uses `{text}`. The normalized incoming event carries both this content and a text representation for existing agent adapters.

## Private stdio RPC

Remote RPCs are bounded to 45 seconds within a 60-second core command deadline. The stdio bridge waits 65 seconds, and the HTTP client waits 75 seconds, so outer transports do not cut off a live inner operation. Unknown submission outcomes keep their durable request identity and are never blindly resubmitted with a new ID.

The process starts with `--state-dir <private directory>`. It emits a ready frame `{id:0,result:{ready:true,node_id}}`. Requests are NDJSON `{id:number,method:string,params:object}`; responses are `{id,result}` or `{id,error:{code,message}}`. Request handling must be concurrent: an operation waiting for an agent delivery or outbound tunnel must not prevent completion RPCs from being read. Stdout is exclusively protocol data. Protocol writes use a bounded queue, and cancellation interrupts owned pipe IO even if the parent stops draining output. EOF cancels the service and closes network connections.

Methods:

- `status` -> `{node_id,providers:ProviderSummary[],default_provider_id?,remote:RemoteSummary}`.
- `provider.save` accepts a provider config, generates an ID if absent, and returns its redacted summary. Config: `{id?,name,type,enabled,app_id?,app_secret?,recipient_open_id?,address?,token?,tls?,server_name?}`. Blank/omitted existing secrets preserve their values. `address` is host:port for remote providers. An omitted enabled flag means true.
- `provider.delete` accepts `{id}`; deletion is persisted and closes that instance. It must not delete agent conversations.
- `provider.default` accepts `{id}`.
- `remote.configure` accepts `{enabled,listen,token?,tls_cert_file?,tls_key_file?}`. Default listen is `127.0.0.1:9418`. A token is generated if needed. Default is disabled. Reject an unsafe public plaintext listener; public listeners require certificate/key TLS. Return a redacted remote summary.
- `remote.secret` -> `{token}`. Only explicitly authorized local UI/control callers may invoke it.
- `session.ensure` accepts `{provider_id?,session}` -> `{provider_id,session,created,chat_id?,thread_id?}`. Reuse an existing provider binding; otherwise use the requested/default provider. Remote requests preserve the originating session identity.
- `session.ensure` additionally accepts `automatic:true` for background enrollment; automatic requests cannot reactivate tombstones, including through remote relays.
- `session.list` returns an array of bindings `{provider_id,session,created,chat_id?,thread_id?,sender_open_id?,deleted?,delete_pending?}`. Tombstones are included; compatibility callers filter them.
- `session.bind` accepts `{provider_id?,session,chat_id,sender_open_id}` to validate and adopt an existing Feishu group without replacing conflicting routing metadata.
- `session.metadata.get` / `session.metadata.set` accept `{provider_id?,session,metadata?}`.
- `session.delete` accepts `{provider_id?,session}`. It is idempotent. Preserve a tombstone so event replay cannot recreate a deleted session. Explicit ensure can reactivate it.
- `message.send` accepts `{provider_id?,session,content,request_id?}` -> `{message:MessageRef,chat_id?,message_id}`. Without an explicit ID, the core retains one durable attempt for the same provider/session/content while its outcome is unresolved or proven retryable; a completed send allows a later identical intentional send. An explicit ID remains idempotent.
- `message.reply` accepts `{message?:MessageRef,message_id?:string,content,request_id?}` -> `{message:MessageRef,message_id}`.
- `message.ack` accepts `{message?:MessageRef,message_id?:string}` -> `{status:"session_acknowledged",message_id,acknowledged_at}`. Feishu uses a reaction. A plain message ID must fail if ambiguous.
- `delivery.complete` accepts `{delivery_id,status,transport_status?,error?}`. Status is `delivered`, `retryable`, `unconfirmed`, or `rejected`.
- `delivery.retry` accepts `{delivery_id}` and permits explicit retry only of a proven-safe retryable delivery.
- `config.export` returns a private credential-inclusive backup `{version:1,providers,default_provider_id?,remote}`. The local bridge writes this only to a private export file.
- `config.import` accepts that backup, validates it before applying it, and never imports node identity, session state, or delivery state.
- `dial.complete` accepts `{request_id,address?,error?}`.
- `transport.configure` accepts `{tailnet_enabled:boolean}`. When enabled, remote dials to Tailscale IPs or `.ts.net` hosts request an embedded tunnel from the Node bridge.
- `migration.import` accepts `{app_id,app_secret,recipient_open_id?,legacy_host,bindings:[{chat_id,app_id?,session_id,adapter?,session_name?}]}`. Import once into provider ID `legacy-feishu`, preserving groups; never overwrite a later provider edit or deletion. No credentials means no import.

Outgoing async events:

- `{event:"delivery",data:{delivery_id,session,message,content,text}}`: only emitted for a target whose node ID equals this node's ID. The core persists pending state before emission; it does not treat bridge receipt as agent acceptance. Node calls existing agent transport and completes the delivery with its actual outcome. A resumed uncertain submission must not be automatically submitted again.
- `{event:"dial",data:{request_id,address}}`: bridge opens a Tailscale tunnel and returns its numeric loopback endpoint using `dial.complete`.
- `{event:"log",data:{status,provider_id?,message_id?,error?}}`: no credentials or auth headers.

## Public summaries and local UI API

`ProviderSummary` contains `{id,name,type,enabled,status,error?,app_id?,recipient_open_id?,address?,tls?,server_name?,secret_set?,token_set?}`. Never include application secrets or tokens.

`RemoteSummary` contains `{enabled,listen,status,tls,token_set,tls_cert_file?,tls_key_file?,peers:[{node_id,name?,connected_at,connected,pending,last_ack?}]}`. TLS file paths are non-secret configuration; omitted paths and tokens are preserved on edit. Never include token or private-key contents.

The Node UI adds:

- `GET /ui/api/providers` -> the `status` object plus `{editable:boolean}`.
- `POST /ui/api/providers` with `{action:"save",provider:ProviderConfig}`, `{action:"delete",id}`, or `{action:"default",id}` -> fresh status plus editable.
- `GET /ui/api/settings/remote` -> remote summary plus `{node_id,editable}`.
- `POST /ui/api/settings/remote` with remote config -> fresh remote summary plus node ID and editable.
- `POST /ui/api/settings/remote/secret` -> `{token}`.

All POSTs require `X-Nootify-UI: 1` and are local-only, including provider mutations. Tailnet read-only data excludes credentials and authorization URLs. UI strings support Simplified Chinese and English.

Navigation adds `Providers` under message bridging. The sidebar's `GitHub` group becomes `Repos`. Settings' Feishu entry is replaced by Remote access (`远程接入`); Feishu configuration lives in each provider editor. Agents remain agent input configuration. Remote access displays listening configuration and the independently subscribed downstream peers.

## Routing and persistence

Only unmatched events are broadcast. Matching uses the full session identity, not just a local agent ID. Locally owned offline/failed sessions are not rerouted as unmatched. Invalid/unauthorized events are rejected at ingress. Every peer has its own bounded delivery window, durable cursor into the shared broadcast ledger, confirmations, and reconnect replay. A full window does not reject other peers' broadcasts; that peer refills its window from the retained backlog independently. Global storage limits remain explicit admission failures. One peer's confirmation cannot consume another peer's event. Keep stable event IDs, origin provider references, hop limits and visited-node information to stop loops and duplicate local execution across multiple routes.

Session operations use per-session synchronization; no node-wide operation lock is held while calling a remote provider. Multiple streams from the same downstream node share that node's durable queue and confirmations without replacing one another. A hop-exhausted or already-visited copy that was not handled does not suppress a later valid route for the same event.

Session operations, message sending, replying, metadata and deletion follow their selected provider binding and return path. They are not broadcast commands. Delete notification resources and mappings only, never an agent's original conversation. Multiple feeds from the same bot must not independently execute the same source message.

A write is persisted before it is acknowledged. Retrying uncertain agent acceptance is forbidden. Upstream ingestion acknowledgement is distinct from downstream acknowledgement and from agent acknowledgement. Queue exhaustion and disconnected downstreams must not silently lose admitted events.

## Embedded Tailscale RPC additions

Requests retain the helper's existing flat `{id,method,...fields}` format:

- `tunnel` with `{address:"tailnet-host:port"}` -> `{id:string,address:"127.0.0.1:ephemeral-port"}`; raw bidirectional TCP forwarding through `tsnet.Server.Dial`. Validate destination and bound active tunnels. `close_tunnel` with `{tunnel_id}` closes the listener and connections.
- `publish` with `{port:number,target:"127.0.0.1:port"}` -> `{port}`; listens on that Tailscale port and forwards raw TCP to the numeric loopback target. It must not inject the existing HTTP PROXY preamble into gRPC. `unpublish` with `{port}` closes it.

All listeners and connections close on EOF/shutdown. Publication and tunnel handles belong to one helper process: intentional disable, enrollment cancellation, logout, and helper failure invalidate those handles. Re-enabling must publish the configured listener and create tunnels in the replacement helper. Changing to a listener that cannot be reached through numeric loopback withdraws the previous Tailnet publication before reporting the new configuration; failed withdrawal retains its handle for retry. IPv4-mapped IPv6 Tailnet addresses are unmapped before transport selection. Existing port-80 browser proxy behavior and peer verification remain intact.

Legacy thread sends and metadata reads may omit the adapter. The Node bridge resolves the full local identity from core notification-session bindings, optionally scoped by provider, and rejects ambiguous IDs instead of assuming a default agent adapter.

## Validation

Exercise at least two downstream clients receiving the same event, independent acknowledgements, local ownership stopping broadcast, multiple hops and loop deduplication, offline-peer reconnect replay, provider-scoped identity, deletion and retry semantics, secret redaction, remote authentication, and actual rich-text conversion. Verify provider CRUD and remote access in the browser at desktop/mobile sizes and both appearances. Existing agent transport regressions must keep passing.
