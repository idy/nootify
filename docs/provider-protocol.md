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

Content is `{text?: string, blocks?: ContentBlock[]}`. Blocks use `{type, text?, url?, children?}` and support at least paragraph, text, link, and code. Providers must reject unsupported blocks rather than silently discard them. Plain text uses `{text}`. Depth and block shape are validated before serialization or text flattening; flattening uses a single builder so nested blocks do not repeatedly copy accumulated text. The normalized incoming event carries both this content and a text representation for existing agent adapters.

## Private stdio RPC

Remote RPCs are bounded to 45 seconds within a 60-second core command deadline. The stdio bridge waits 65 seconds, and the HTTP client waits 75 seconds, so outer transports do not cut off a live inner operation. Unknown submission outcomes keep their durable request identity and are never blindly resubmitted with a new ID.

The process starts with `--state-dir <private directory>`. It emits a ready frame `{id:0,result:{ready:true,node_id}}`. Requests are NDJSON `{id:number,method:string,params:object}`; responses are `{id,result}` or `{id,error:{code,message}}`. Request handling must be concurrent: an operation waiting for an agent delivery or outbound tunnel must not prevent completion RPCs from being read. Stdout is exclusively protocol data. Protocol writes use a bounded queue, and cancellation interrupts owned pipe IO even if the parent stops draining output. EOF cancels the service and closes network connections.

Methods:

- `status` -> `{node_id,providers:ProviderSummary[],default_provider_id?,remote:RemoteSummary}`.
- `provider.save` accepts a provider config, generates an ID if absent, and returns its redacted summary. Config: `{id?,name,type,enabled,app_id?,app_secret?,recipient_open_id?,address?,token?,tls?,server_name?}`. Blank/omitted existing secrets preserve their values. Existing provider types and Feishu App IDs are immutable, including disabled/unbound instances and configuration imports; create a new provider to use a different app. Same-app secret rotation is supported. `address` is host:port for remote providers. An omitted enabled flag means true.
- `provider.delete` accepts `{id}`; deletion is persisted and closes that instance. It must not delete agent conversations.
- `provider.default` accepts `{id}`.
- `remote.configure` accepts `{enabled,listen,token?,tls_cert_file?,tls_key_file?}`. Default listen is `127.0.0.1:9418`. A token is generated if needed. Default is disabled. Reject an unsafe public plaintext listener; public listeners require certificate/key TLS. Return a redacted remote summary.
- `remote.secret` -> `{token}`. Only explicitly authorized local UI/control callers may invoke it.
- `remote.identity` -> `{node_id,public_key}`. The base64 Ed25519 public key is safe to exchange; the private signing key stays in the core's private state.
- `remote.peer.bind` accepts `{node_id,public_key}` to pin an existing legacy peer through the private local control path. A different already-pinned key is rejected. Neither identity-management method is callable over gRPC.

Listener configuration and imports prepare the candidate socket and TLS certificate before persisting changes. Bind, TLS, and persistence failures retain the previous live listener and configuration. The same address can reload a certificate while preserving authenticated streams; changing its TLS mode requires disabling it first. Token rotation retains the socket but cancels RPCs admitted under the previous token generation.
- `session.ensure` accepts `{provider_id?,session}` -> `{provider_id,session,created,chat_id?,thread_id?}`. Reuse an existing provider binding; otherwise use the requested/default provider. Remote requests preserve the originating session identity.
- `session.ensure` additionally accepts `automatic:true` for background enrollment; automatic requests cannot reactivate tombstones, including through remote relays.
- `session.list` returns an array of bindings `{provider_id,session,created,chat_id?,thread_id?,sender_open_id?,deleted?,delete_pending?}`. Tombstones are included; compatibility callers filter them.
- `session.bind` accepts `{provider_id?,session,chat_id,sender_open_id}` to validate and adopt an existing Feishu group without replacing conflicting routing metadata.
- `session.metadata.get` / `session.metadata.set` accept `{provider_id?,session,metadata?}`.
- `session.delete` accepts `{provider_id?,session}`. It is idempotent. Feishu's documented already-dissolved application code `232009` completes cleanup; invalid IDs, permission errors and uncertain/transient failures do not prove deletion. Preserve a tombstone so event replay cannot recreate a deleted session. Explicit ensure can reactivate it after proven cleanup.
- `message.send` accepts `{provider_id?,session,content,request_id?}` -> `{message:MessageRef,chat_id?,message_id}`. Without an explicit ID, the core retains one durable attempt for the same provider/session/content while its outcome is unresolved or proven retryable; a completed send allows a later identical intentional send. An explicit ID remains idempotent.
- `message.reply` accepts `{message?:MessageRef,message_id?:string,content,request_id?}` -> `{message:MessageRef,message_id}`.
- `message.ack` accepts `{message?:MessageRef,message_id?:string}` -> `{status:"session_acknowledged",message_id,acknowledged_at}`. Feishu uses a reaction. A plain message ID must fail if ambiguous.
- `delivery.complete` accepts `{delivery_id,status,transport_status?,error?}`. Status is `delivered`, `retryable`, `unconfirmed`, or `rejected`.
- `delivery.retry` accepts `{delivery_id}` and permits explicit retry only of a proven-safe retryable delivery.
- `config.export` returns a private credential-inclusive backup `{version:1,providers,default_provider_id?,remote}`. The local bridge writes this only to a private export file.
- `config.import` accepts that backup, validates it before applying it, and never imports node identity, session state, or delivery state. A retained provider ID must keep its existing type; a type change rejects the import before state mutation. Imported compatibility credentials refresh the local legacy API/directory clients without rewriting the imported provider instances.
- `dial.complete` accepts `{request_id,address?,error?}`.
- `transport.configure` accepts `{tailnet_enabled:boolean}`. When enabled, remote dials to Tailscale IPs or `.ts.net` hosts request an embedded tunnel from the Node bridge.
- `migration.import` accepts `{app_id,app_secret,recipient_open_id?,legacy_host,bindings:[{chat_id,app_id?,session_id,adapter?,session_name?}]}`. Import once into provider ID `legacy-feishu`, preserving groups; never overwrite a later provider edit or deletion. No credentials means no import.

Outgoing async events:

- `{event:"delivery",data:{delivery_id,session,message,content,text}}`: only emitted for a target whose node ID equals this node's ID. The core persists pending state before emission; it does not treat bridge receipt as agent acceptance. Node calls existing agent transport and completes the delivery with its actual outcome. A resumed uncertain submission must not be automatically submitted again.
- `{event:"dial",data:{request_id,address}}`: bridge opens a Tailscale tunnel and returns its numeric loopback endpoint using `dial.complete`.

- `{event:"log",data:{status,provider_id?,message_id?,error?}}`: no credentials or auth headers.

Trae and WorkBuddy queue the original input plus the structured provider message reference. Reading their inbox renders callback commands with the current Node/CLI location, state directory and HTTP port, so restarts and relocation do not preserve stale command paths. Thread context and opaque reference fields survive persistence. Legacy Feishu source records remain supported; ordinary source-free inbox text is unchanged.

## Public summaries and local UI API

`ProviderSummary` contains `{id,name,type,enabled,status,error?,app_id?,recipient_open_id?,address?,tls?,server_name?,secret_set?,token_set?}`. Never include application secrets or tokens.

`RemoteSummary` contains `{enabled,listen,status,tls,token_set,tls_cert_file?,tls_key_file?,peers:[{node_id,name?,connected_at,connected,pending,last_ack?,public_key?,identity_status}]}`. Peer identity status is `pinned` or `unbound`. TLS file paths are non-secret configuration; omitted paths and tokens are preserved on edit. Never include token or private-key contents.

The Node UI adds:

- `GET /ui/api/providers` -> the `status` object plus `{editable:boolean}`.
- `POST /ui/api/providers` with `{action:"save",provider:ProviderConfig}`, `{action:"delete",id}`, or `{action:"default",id}` -> fresh status plus editable.
- `GET /ui/api/settings/remote` -> remote summary plus `{node_id,editable}`.
- `POST /ui/api/settings/remote` with remote config -> fresh remote summary plus node ID and editable.
- `POST /ui/api/settings/remote/secret` -> `{token}`.

All POSTs require `X-Nootify-UI: 1`, same-origin checks, the local listener, and owner authorization. A forgeable header or loopback reachability alone never permits configuration changes or secret reads. The native desktop obtains a one-use authorization URL through the bundled `ui-url` CLI. CLI bootstrap verifies an HMAC server challenge before signing a fresh client proof; the root bearer is never transmitted by bootstrap or injected into page code. Grants and proofs expire after 30 seconds, and proof/grant replay is rejected. Redemption redirects to a clean root URL and sets an eight-hour, host/port-bound, HttpOnly, SameSite=Strict cookie. The cookie authorizes UI operations only; `/v1/` still needs the actual bearer. Local unauthenticated and Tailnet summaries are read-only and exclude credentials and authorization URLs. UI strings support Simplified Chinese and English.

Navigation adds `Providers` under message bridging. The sidebar's `GitHub` group becomes `Repos`. Settings' Feishu entry is replaced by Remote access (`远程接入`); Feishu configuration lives in each provider editor. Agents remain agent input configuration. Remote access displays listening configuration and the independently subscribed downstream peers.

## Subscription identity and trust

Each core keeps its existing node UUID and a private Ed25519 signing identity. Subscribe requires the listener bearer plus a Hello containing the node ID, name, and public key. The server sends a fresh 32-byte challenge; the client signs the domain-separated server ID, client ID, name, public key, and challenge. No peer queue, replay, or confirmation is exposed before verification. The first successful subscription of a new node durably pins its public key. Other bearer holders cannot impersonate that pinned node or replay captured proofs. Multiple proven subscriptions for one node still share its queue.

Existing peers without a pin remain `unbound` and cannot consume their retained backlog. On the downstream, run `node-identity`; verify the public identity out of band, then run `peer-bind --peer-node-id <node-id> --public-key <public-key>` locally on the upstream. Both endpoints must be upgraded for the challenge protocol. Existing queues, cursors, pins, and node UUIDs survive restart and token rotation.

The proof protects subscription replay and confirmations. General unary `Call` retains the shared-bearer trust model: a listener token grants session/message operations to trusted peers and does not provide complete per-node authorization. Use distinct listeners/nodes for mutually untrusted callers. TLS remains required for public plaintext-unsafe listeners. Connection setup and subscription proof are bounded to five seconds; inactive HTTP/2 connections expire after 30 seconds. A healthy authenticated subscription can stay idle indefinitely.

## Routing and persistence

Feishu ingress requires a retained, nondeleted binding for the same app and chat, with the binding owner's trusted sender. Description markers alone cannot authorize a new session. Explicit binding rejects conflicting trusted senders; structured session metadata is supported, while legacy pin and string metadata modes fail explicitly. The CLI omits unsupported metadata modes by default.

Only unmatched events are broadcast. Matching uses the full session identity, not just a local agent ID. Locally owned offline/failed sessions are not rerouted as unmatched. Invalid/unauthorized events are rejected at ingress. Every peer has its own bounded delivery window, durable cursor into the shared broadcast ledger, confirmations, and reconnect replay. A full window does not reject other peers' broadcasts; that peer refills its window from the retained backlog independently. Global storage limits remain explicit admission failures. One peer's confirmation cannot consume another peer's event. Keep stable event IDs, origin provider references, hop limits and visited-node information to stop loops and duplicate local execution across multiple routes.

Session operations use per-session synchronization; deletion is serialized with ingress and explicit retry through delivery emission. Acknowledgements for the same full message reference are serialized through provider RPC and persistence, while unrelated messages can proceed independently. Suppressed hop-exhausted/visited copies cannot install return routes or references. No node-wide operation lock is held while calling a remote provider. Multiple streams from the same downstream node share that node's durable queue and confirmations without replacing one another. A hop-exhausted or already-visited copy that was not handled does not suppress a later valid route for the same event.

Session operations, message sending, replying, metadata and deletion follow their selected provider binding and return path. With multiple retained upstreams, return routing prefers a connected provider before submission; it never switches routes automatically after an uncertain reply. They are not broadcast commands. Delete notification resources and mappings only, never an agent's original conversation. Multiple feeds from the same bot must not independently execute the same source message.

A write is persisted before it is acknowledged. Retrying uncertain agent acceptance is forbidden. Upstream ingestion acknowledgement is distinct from downstream acknowledgement and from agent acknowledgement. Queue exhaustion and disconnected downstreams must not silently lose admitted events.

## Embedded Tailscale RPC additions

Requests retain the helper's existing flat `{id,method,...fields}` format:

- `tunnel` with `{address:"tailnet-host:port"}` -> `{id:string,address:"127.0.0.1:ephemeral-port"}`; raw bidirectional TCP forwarding through `tsnet.Server.Dial`. Validate destination and bound active tunnels. `close_tunnel` with `{tunnel_id}` closes the listener and connections.
- `publish` with `{port:number,target:"127.0.0.1:port"}` -> `{port}`; listens on that Tailscale port and forwards raw TCP to the numeric loopback target. It must not inject the existing HTTP PROXY preamble into gRPC. `unpublish` with `{port}` closes it.

All listeners and connections close on EOF/shutdown. Publication and tunnel handles belong to one helper process: intentional disable, enrollment cancellation, logout, and helper failure invalidate those handles. Re-enabling must publish the configured listener and create tunnels in the replacement helper. Disabling downstream access only withdraws its listener publication and preserves outgoing provider tunnels. Provider save/delete/import reconciles tunnels against enabled Remote addresses, retaining shared addresses and retrying failed cleanup; pending dials share one allocation and cannot reintroduce a removed address. Changing to a listener that cannot be reached through numeric loopback withdraws the previous Tailnet publication before reporting the new configuration; failed withdrawal retains its handle for retry. IPv4-mapped IPv6 Tailnet addresses are unmapped before transport selection. Existing port-80 browser proxy behavior and peer verification remain intact.

Raw connections have a shared cap of 128. Each active tunnel/publication reserves two guaranteed slots, shares a 32-slot burst pool, and has a maximum of 16 connections; at most 32 tunnels and 16 publications are admitted. HTTP/PROXY connections retain their independent 128-connection limit. Raw forwarding preserves half-close and healthy idle streams. Unexpected listener Accept failure retains its reservation and retries binding with cancellable exponential backoff from 100 ms to five seconds; existing streams remain intact. Closing or replacing a bridge cancels recovery.

Legacy thread sends and metadata reads may omit the adapter. The Node bridge resolves the full local identity from core notification-session bindings, optionally scoped by provider, and rejects ambiguous IDs instead of assuming a default agent adapter.

## Validation

Exercise at least two downstream clients receiving the same event, independent acknowledgements, local ownership stopping broadcast, multiple hops and loop deduplication, offline-peer reconnect replay, provider-scoped identity, deletion and retry semantics, secret redaction, remote authentication, and actual rich-text conversion. Verify provider CRUD and remote access in the browser at desktop/mobile sizes and both appearances. Existing agent transport regressions must keep passing.
