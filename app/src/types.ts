// Protocol types mirroring the server (crates/nexus-server/src/store.rs, ws.rs).

export const P = {
  VIEW_CHANNEL: 1 << 0,
  SEND_MESSAGES: 1 << 1,
  MANAGE_MESSAGES: 1 << 2,
  ATTACH_FILES: 1 << 3,
  CREATE_CHANNELS: 1 << 4,
  MANAGE_CHANNELS: 1 << 5,
  CONNECT: 1 << 6,
  SPEAK: 1 << 7,
  VIDEO: 1 << 8,
  SCREEN_SHARE: 1 << 9,
  CREATE_INVITES: 1 << 10,
  BAN_MEMBERS: 1 << 11,
  MANAGE_ROLES: 1 << 12,
  MANAGE_SERVER: 1 << 13,
  VIEW_AUDIT_LOG: 1 << 14,
  KICK_MEMBERS: 1 << 15,
  MODERATE_MEMBERS: 1 << 16,
  MUTE_MEMBERS: 1 << 17,
  MOVE_MEMBERS: 1 << 18,
  ADMINISTRATOR: 1 << 30,
} as const;

export const has = (perms: number, p: number) => (perms & p) === p;

export type Presence = "online" | "idle" | "dnd" | "offline" | "invisible";

export interface User {
  id: number;
  username: string;
  display_name: string;
  avatar: string | null;
  status_text: string;
  is_owner: boolean;
  status: string;
  presence?: Presence;
  created_at: number;
  bio?: string;
  banner?: string;
}

export interface Member {
  id: number;
  username: string;
  display_name: string;
  avatar: string | null;
  status_text: string;
  is_owner: boolean;
  roles: number[];
  presence: Presence;
  status: string;
  /** End of a running timeout (ms), if any. */
  timeout_until?: number | null;
  /** "Über mich" text. */
  bio?: string;
  /** Profile banner: "" or "#rrggbb[,#rrggbb]". */
  banner?: string;
}

export interface Role {
  id: number;
  name: string;
  permissions: number;
  position: number;
  color: string;
  is_default: boolean;
}

export interface Category {
  id: number;
  name: string;
  position: number;
}

export interface Channel {
  id: number;
  kind: "text" | "voice";
  name: string;
  topic: string;
  category_id: number | null;
  position: number;
  last_message_id: number | null;
  perms: number;
  /** Seconds between two messages (0 = off). */
  slowmode?: number;
  /** Voice channels: maximum participants (0 = unlimited). */
  user_limit?: number;
}

export interface Attachment {
  id: string;
  filename: string;
  size: number;
  mime: string;
}

export interface Message {
  id: number;
  channel_id: number;
  author_id: number;
  content: string;
  reply_to: number | null;
  reply_preview?: { id: number; author_id: number; content: string } | null;
  created_at: number;
  edited_at: number | null;
  mentions: number[];
  attachments: Attachment[];
  reactions: { emoji: string; users: number[] }[];
  pinned_at: number | null;
  /** Original author of a forwarded message. */
  forwarded_from?: number | null;
  poll?: Poll;
  // client-side only
  nonce?: string;
  pending?: boolean;
  failed?: boolean;
}

export interface Poll {
  question: string;
  options: { text: string; voters: number[] }[];
  multi: boolean;
  ends_at: number | null;
}

export interface Dm {
  channel_id: number;
  user_id: number;
  last_message_id: number | null;
}

export interface VoiceMember {
  user_id: number;
  channel_id: number;
  muted: boolean;
  deafened: boolean;
  video: boolean;
  screen: boolean;
  suppressed: boolean;
  /** Muted / deafened by a moderator. */
  server_muted?: boolean;
  server_deafened?: boolean;
  /** Raised hand: time it was raised (ms). */
  hand?: number | null;
  joined_at: number;
}

export interface ServerInfo {
  name: string;
  description: string;
  icon: string | null;
  registration_mode: "closed" | "invite" | "approval" | "open";
  uploads_enabled: boolean;
  max_upload_mb: number;
  max_message_len: number;
  version: string;
  protocol: number;
  max_voice_participants: number;
}

export interface IceConfig {
  stun_port: number | null;
  /** `tcp`: also reachable via TCP on the same port; `public`: TURN-over-TCP address through the internet tunnel. */
  turn: { port: number; tcp?: boolean; public?: string | null; username: string; credential: string } | null;
  servers: { urls: string[]; username?: string; credential?: string }[];
}

export interface Guild {
  roles: Role[];
  categories: Category[];
  channels: Channel[];
  perms: number;
  is_owner: boolean;
}

export interface Ready {
  protocol: number;
  me: User;
  server: ServerInfo;
  guild: Guild;
  members: Member[];
  dms: Dm[];
  read_states: Record<string, number>;
  mention_counts: Record<string, number>;
  relationships: { user_id: number; kind: RelKind }[];
  voice: VoiceMember[];
  ice: IceConfig;
}

export type RelKind = "friend" | "outgoing" | "incoming" | "blocked";

export interface SavedServer {
  id: string;
  address: string;
  fingerprint?: string | null;
  name: string;
  username: string;
  token?: string | null;
  hosted?: boolean;
  /** Id of the hosted server (desktop app) this entry belongs to. */
  host_id?: string | null;
}

export interface ApiErr {
  code: string;
  msg: string;
}

export interface Invite {
  code: string;
  created_by: number | null;
  created_at: number;
  expires_at: number | null;
  max_uses: number | null;
  uses: number;
  role_id: number | null;
}

export interface InviteLinkInfo {
  host: string;
  port: number;
  tls: boolean;
  fingerprint: string | null;
}
