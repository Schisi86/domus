//! Role based permissions with per-channel overrides.
//!
//! All checks run on the server; the client only uses the computed values to
//! hide controls. The model is intentionally small:
//!
//! * A user has any number of roles. Base permissions = union of role permissions.
//! * `ADMINISTRATOR` (or being the owner) grants everything.
//! * A channel can carry per-role overrides: `(base & !deny) | allow`, where
//!   `deny`/`allow` are unions over the user's roles.
//! * Roles are ordered by `position`; you may only manage users/roles below
//!   your own highest role. The owner is above every role.

use std::collections::{HashMap, HashSet};

pub type Perms = u64;

pub const VIEW_CHANNEL: Perms = 1 << 0;
pub const SEND_MESSAGES: Perms = 1 << 1;
pub const MANAGE_MESSAGES: Perms = 1 << 2;
pub const ATTACH_FILES: Perms = 1 << 3;
pub const CREATE_CHANNELS: Perms = 1 << 4;
pub const MANAGE_CHANNELS: Perms = 1 << 5;
pub const CONNECT: Perms = 1 << 6;
pub const SPEAK: Perms = 1 << 7;
pub const VIDEO: Perms = 1 << 8;
pub const SCREEN_SHARE: Perms = 1 << 9;
pub const CREATE_INVITES: Perms = 1 << 10;
/// Approve pending registrations, ban and unban users.
pub const BAN_MEMBERS: Perms = 1 << 11;
pub const MANAGE_ROLES: Perms = 1 << 12;
pub const MANAGE_SERVER: Perms = 1 << 13;
pub const VIEW_AUDIT_LOG: Perms = 1 << 14;
/// Remove a member from the server (they need to be re-admitted).
pub const KICK_MEMBERS: Perms = 1 << 15;
/// Time out members: no writing, reacting or speaking for a while.
pub const MODERATE_MEMBERS: Perms = 1 << 16;
/// Mute or deafen others in voice channels (server-side).
pub const MUTE_MEMBERS: Perms = 1 << 17;
/// Move others between voice channels or disconnect them.
pub const MOVE_MEMBERS: Perms = 1 << 18;
pub const ADMINISTRATOR: Perms = 1 << 30;

pub const ALL: Perms = VIEW_CHANNEL
    | SEND_MESSAGES
    | MANAGE_MESSAGES
    | ATTACH_FILES
    | CREATE_CHANNELS
    | MANAGE_CHANNELS
    | CONNECT
    | SPEAK
    | VIDEO
    | SCREEN_SHARE
    | CREATE_INVITES
    | BAN_MEMBERS
    | MANAGE_ROLES
    | MANAGE_SERVER
    | VIEW_AUDIT_LOG
    | KICK_MEMBERS
    | MODERATE_MEMBERS
    | MUTE_MEMBERS
    | MOVE_MEMBERS
    | ADMINISTRATOR;

/// Permissions that only make sense per channel; overrides may only touch these.
pub const CHANNEL_SCOPED: Perms =
    VIEW_CHANNEL | SEND_MESSAGES | MANAGE_MESSAGES | ATTACH_FILES | CONNECT | SPEAK | VIDEO | SCREEN_SHARE;

/// What both members of a direct-message channel may do there.
pub const DM_PERMS: Perms = VIEW_CHANNEL | SEND_MESSAGES | ATTACH_FILES | CONNECT | SPEAK | VIDEO | SCREEN_SHARE;

pub const MEMBER_DEFAULT: Perms =
    VIEW_CHANNEL | SEND_MESSAGES | ATTACH_FILES | CONNECT | SPEAK | VIDEO | SCREEN_SHARE;
pub const GUEST_DEFAULT: Perms = VIEW_CHANNEL | SEND_MESSAGES | CONNECT | SPEAK;
pub const MODERATOR_DEFAULT: Perms = MEMBER_DEFAULT
    | MANAGE_MESSAGES
    | CREATE_INVITES
    | BAN_MEMBERS
    | VIEW_AUDIT_LOG
    | CREATE_CHANNELS
    | KICK_MEMBERS
    | MODERATE_MEMBERS
    | MUTE_MEMBERS
    | MOVE_MEMBERS;

/// What a timed-out member loses in server channels (DMs stay usable).
pub const TIMEOUT_DENY: Perms = SEND_MESSAGES | ATTACH_FILES | SPEAK | VIDEO | SCREEN_SHARE;

/// Default roles created for a fresh server: (name, permissions, position, color, assigned to new users).
pub const DEFAULT_ROLES: &[(&str, Perms, i64, &str, bool)] = &[
    ("Administrator", ADMINISTRATOR, 40, "#e5484d", false),
    ("Moderator", MODERATOR_DEFAULT, 30, "#3e9b4f", false),
    ("Mitglied", MEMBER_DEFAULT, 20, "", true),
    ("Gast", GUEST_DEFAULT, 10, "#8b8d98", false),
];

#[derive(Debug, Clone)]
pub struct RoleInfo {
    pub perms: Perms,
    pub position: i64,
}

#[derive(Debug, Clone, Default)]
pub struct ChannelInfo {
    pub is_dm: bool,
    /// Voice channels and DMs can be joined for calls.
    pub voice: bool,
    pub dm_members: Vec<i64>,
    /// Seconds between two messages of one member (0 = off).
    pub slowmode: i64,
    /// Maximum participants of a voice channel (0 = unlimited).
    pub user_limit: i64,
    /// role id -> (allow, deny)
    pub overrides: HashMap<i64, (Perms, Perms)>,
}

/// In-memory snapshot of everything needed to evaluate permissions without
/// touching the database. Rebuilt whenever roles, overrides, channels or role
/// assignments change (rare events).
#[derive(Debug, Clone, Default)]
pub struct PermCache {
    pub roles: HashMap<i64, RoleInfo>,
    pub user_roles: HashMap<i64, Vec<i64>>,
    pub owners: HashSet<i64>,
    pub channels: HashMap<i64, ChannelInfo>,
    /// user id -> timeout end (ms since epoch)
    pub timeouts: HashMap<i64, i64>,
}

impl PermCache {
    pub fn is_owner(&self, uid: i64) -> bool {
        self.owners.contains(&uid)
    }

    pub fn roles_of(&self, uid: i64) -> &[i64] {
        self.user_roles.get(&uid).map(|v| v.as_slice()).unwrap_or(&[])
    }

    /// Server-wide permissions of a user.
    pub fn base(&self, uid: i64) -> Perms {
        if self.is_owner(uid) {
            return ALL;
        }
        let p = self
            .roles_of(uid)
            .iter()
            .filter_map(|r| self.roles.get(r))
            .fold(0, |acc, r| acc | r.perms);
        if p & ADMINISTRATOR != 0 { ALL } else { p }
    }

    /// End of a running timeout, if any.
    pub fn timeout_until(&self, uid: i64) -> Option<i64> {
        self.timeouts.get(&uid).copied().filter(|t| *t > crate::util::now_ms())
    }

    /// Effective permissions in a channel. Unknown channels yield 0.
    pub fn channel(&self, uid: i64, cid: i64) -> Perms {
        let p = self.channel_raw(uid, cid);
        let dm = self.channels.get(&cid).is_some_and(|c| c.is_dm);
        if !dm && self.timeout_until(uid).is_some() { p & !TIMEOUT_DENY } else { p }
    }

    fn channel_raw(&self, uid: i64, cid: i64) -> Perms {
        let Some(ch) = self.channels.get(&cid) else { return 0 };
        if ch.is_dm {
            return if ch.dm_members.contains(&uid) { DM_PERMS } else { 0 };
        }
        let base = self.base(uid);
        if base & ADMINISTRATOR != 0 {
            return ALL;
        }
        let (mut allow, mut deny) = (0, 0);
        for r in self.roles_of(uid) {
            if let Some((a, d)) = ch.overrides.get(r) {
                allow |= a;
                deny |= d;
            }
        }
        // Overrides may only touch channel-scoped bits.
        let p = (base & !(deny & CHANNEL_SCOPED)) | (allow & CHANNEL_SCOPED);
        // Without VIEW_CHANNEL nothing else in the channel applies.
        if p & VIEW_CHANNEL == 0 { 0 } else { p }
    }

    pub fn has(&self, uid: i64, perm: Perms) -> bool {
        self.base(uid) & perm == perm
    }

    pub fn has_in(&self, uid: i64, cid: i64, perm: Perms) -> bool {
        self.channel(uid, cid) & perm == perm
    }

    /// Highest role position; the owner ranks above everything.
    pub fn rank(&self, uid: i64) -> i64 {
        if self.is_owner(uid) {
            return i64::MAX;
        }
        self.roles_of(uid).iter().filter_map(|r| self.roles.get(r)).map(|r| r.position).max().unwrap_or(0)
    }

    /// `actor` may moderate `target` (ban, change roles) only when ranked strictly higher.
    pub fn outranks(&self, actor: i64, target: i64) -> bool {
        actor != target && self.rank(actor) > self.rank(target)
    }

    /// `actor` may create/edit/assign a role at `position` granting `perms`.
    pub fn can_manage_role(&self, actor: i64, position: i64, perms: Perms) -> bool {
        if !self.has(actor, MANAGE_ROLES) {
            return false;
        }
        if self.is_owner(actor) {
            return true;
        }
        // Nobody can hand out permissions they do not hold themselves.
        position < self.rank(actor) && (perms & !self.base(actor)) == 0
    }

    pub fn visible_channels(&self, uid: i64) -> impl Iterator<Item = i64> + '_ {
        self.channels.keys().copied().filter(move |c| self.has_in(uid, *c, VIEW_CHANNEL))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache() -> PermCache {
        let mut c = PermCache::default();
        c.roles.insert(1, RoleInfo { perms: ADMINISTRATOR, position: 40 });
        c.roles.insert(2, RoleInfo { perms: MODERATOR_DEFAULT, position: 30 });
        c.roles.insert(3, RoleInfo { perms: MEMBER_DEFAULT, position: 20 });
        c.roles.insert(4, RoleInfo { perms: GUEST_DEFAULT, position: 10 });
        c.owners.insert(100);
        c.user_roles.insert(101, vec![1]);
        c.user_roles.insert(102, vec![2, 3]);
        c.user_roles.insert(103, vec![3]);
        c.user_roles.insert(104, vec![4]);
        c.channels.insert(10, ChannelInfo::default());
        let mut staff = ChannelInfo::default();
        staff.overrides.insert(3, (0, VIEW_CHANNEL));
        staff.overrides.insert(4, (0, VIEW_CHANNEL));
        staff.overrides.insert(2, (VIEW_CHANNEL, 0));
        c.channels.insert(11, staff);
        let mut readonly = ChannelInfo::default();
        readonly.overrides.insert(3, (0, SEND_MESSAGES));
        c.channels.insert(12, readonly);
        c.channels.insert(13, ChannelInfo { is_dm: true, dm_members: vec![103, 104], ..Default::default() });
        c
    }

    #[test]
    fn owner_and_admin_have_everything() {
        let c = cache();
        assert_eq!(c.base(100), ALL);
        assert_eq!(c.base(101), ALL);
        assert_eq!(c.channel(101, 11), ALL);
    }

    #[test]
    fn member_basics() {
        let c = cache();
        assert!(c.has_in(103, 10, SEND_MESSAGES));
        assert!(!c.has_in(103, 10, MANAGE_MESSAGES));
        assert!(!c.has(103, MANAGE_SERVER));
        assert!(!c.has(104, ATTACH_FILES));
        assert!(!c.has_in(104, 10, SCREEN_SHARE));
    }

    #[test]
    fn overrides_hide_and_restrict() {
        let c = cache();
        assert_eq!(c.channel(103, 11), 0, "members cannot see staff channel");
        assert!(c.has_in(102, 11, VIEW_CHANNEL), "moderator allow wins over member deny");
        assert!(c.has_in(103, 12, VIEW_CHANNEL));
        assert!(!c.has_in(103, 12, SEND_MESSAGES));
    }

    #[test]
    fn overrides_cannot_grant_server_permissions() {
        let mut c = cache();
        c.channels.get_mut(&10).unwrap().overrides.insert(3, (MANAGE_SERVER | MANAGE_MESSAGES, 0));
        let p = c.channel(103, 10);
        assert_eq!(p & MANAGE_SERVER, 0);
        assert_ne!(p & MANAGE_MESSAGES, 0);
    }

    #[test]
    fn dm_channels_only_for_members() {
        let c = cache();
        assert_eq!(c.channel(103, 13), DM_PERMS);
        assert_eq!(c.channel(101, 13), 0, "even admins cannot read foreign DMs");
        assert_eq!(c.channel(103, 999), 0);
    }

    #[test]
    fn timeout_removes_writing_and_speaking_but_not_dms() {
        let mut c = cache();
        c.timeouts.insert(103, crate::util::now_ms() + 60_000);
        assert!(c.has_in(103, 10, VIEW_CHANNEL));
        assert!(!c.has_in(103, 10, SEND_MESSAGES));
        assert!(!c.has_in(103, 10, SPEAK));
        assert!(c.has_in(103, 13, SEND_MESSAGES), "DMs stay usable");
        c.timeouts.insert(103, crate::util::now_ms() - 1);
        assert!(c.has_in(103, 10, SEND_MESSAGES), "expired timeouts do not apply");
    }

    #[test]
    fn hierarchy() {
        let c = cache();
        assert!(c.outranks(100, 101));
        assert!(c.outranks(101, 102));
        assert!(!c.outranks(102, 101));
        assert!(!c.outranks(103, 103));
        assert!(!c.can_manage_role(103, 5, 0));
        let mut c2 = c.clone();
        c2.roles.get_mut(&2).unwrap().perms |= MANAGE_ROLES;
        assert!(c2.can_manage_role(102, 25, VIEW_CHANNEL));
        assert!(!c2.can_manage_role(102, 35, VIEW_CHANNEL), "cannot create roles above own");
        assert!(!c2.can_manage_role(102, 25, MANAGE_SERVER), "cannot grant what it does not hold");
    }
}
