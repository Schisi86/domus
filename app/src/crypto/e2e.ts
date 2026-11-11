// End-to-end encryption for direct messages.
//
// Every user has an ECDH key pair (P-256) per device. The private key never
// leaves the device (desktop: protected by the Windows account); the server
// only hands out public keys. Two users derive the same AES-256-GCM key from
// their key pair and the other's public key, so the server stores and relays
// ciphertext it cannot read.
//
// Honest limits: the keys are long-lived (no forward secrecy), the server
// could hand out a wrong public key (compare the security number to rule that
// out), attachments and polls are not encrypted, and a message can only be
// read on devices that hold the matching private key.

import { signal } from "@preact/signals";
import { log, secretGet, secretSet } from "../platform";
import type { ServerStore } from "../state/server";

const PREFIX = "nxe1";
const ENVELOPE = /^nxe1\.([0-9a-f]{16})\.([0-9a-f]{16})\.([\w-]{16})\.([\w-]{22,})$/;
const CURVE: EcKeyImportParams = { name: "ECDH", namedCurve: "P-256" };

interface StoredKey {
  kid: string;
  /** Raw public key (65 bytes), base64url. */
  pub: string;
  priv: JsonWebKey;
}

interface KeyRecord {
  v: 1;
  current: string;
  keys: StoredKey[];
}

export type DecryptResult = { text: string } | { fail: "key" | "corrupt" };

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function kidOf(pubRaw: Uint8Array<ArrayBuffer>): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", pubRaw));
  return [...h.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isEnvelope(content: string): boolean {
  return content.startsWith(PREFIX + ".") && ENVELOPE.test(content);
}

/** Longest plaintext (UTF-8 bytes) whose envelope still fits into `max` characters. */
export function maxPlainBytes(max: number): number {
  return Math.floor(((max - 56) * 3) / 4) - 16;
}

export class E2eError extends Error {
  constructor(public reason: "nokey" | "toolong" | "self") {
    super(reason);
  }
}

export class E2e {
  /** My current key id (null = no key on this device yet). */
  myKid = signal<string | null>(null);
  /** Newest published key id per user (null = that person has none). */
  peerKids = signal<Map<number, string | null>>(new Map());

  private record: KeyRecord | null = null;
  private privs = new Map<string, CryptoKey>();
  private pubs = new Map<string, CryptoKey>();
  private aes = new Map<string, CryptoKey>();
  private loading: Promise<void> | null = null;
  private fetching = new Map<number, Promise<void>>();
  private published = false;

  constructor(private server: ServerStore) {}

  /** Bound to the server's identity (its certificate), not to the local entry. */
  private secretName() {
    const fp = this.server.saved.value.fingerprint?.replace(/[^0-9a-f]/gi, "").slice(0, 24);
    return `e2e.${fp || this.server.id}.${this.server.me.value?.id ?? 0}`;
  }

  /** Loads this device's key (if any) and makes sure the server knows its public part. */
  init(): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const raw = await secretGet(this.secretName());
          if (raw) {
            const rec = JSON.parse(raw) as KeyRecord;
            if (rec?.v === 1 && Array.isArray(rec.keys) && rec.keys.length) {
              this.record = rec;
              this.myKid.value = rec.current;
            }
          }
        } catch (e) {
          log("warn", `e2e key could not be loaded: ${e}`);
        }
      })();
    }
    return this.loading.then(() => this.publish());
  }

  /** Called after every (re)connect: every device has a key, so anyone can start an encrypted DM. */
  onReady() {
    this.published = false;
    this.fetching.clear();
    void this.ensureKey().catch((e) => log("warn", `e2e key unavailable: ${e}`));
  }

  private async publish() {
    const cur = this.record?.keys.find((k) => k.kid === this.record!.current);
    if (!cur || this.published || !this.server.conn.ready) return;
    try {
      await this.server.rpc("e2e.publish", { kid: cur.kid, key: cur.pub });
      this.published = true;
    } catch (e) {
      log("warn", `e2e key not published: ${e}`);
    }
  }

  /** Makes sure this device has a key pair; creates one on first use. */
  async ensureKey(): Promise<string> {
    await this.init();
    if (this.record) return this.record.current;
    const pair = await crypto.subtle.generateKey(CURVE, true, ["deriveBits"]);
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const kid = await kidOf(pub);
    const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
    this.record = { v: 1, current: kid, keys: [{ kid, pub: b64(pub), priv }] };
    await secretSet(this.secretName(), JSON.stringify(this.record));
    this.myKid.value = kid;
    this.published = false;
    await this.publish();
    return kid;
  }

  private async priv(kid: string): Promise<CryptoKey | null> {
    let k = this.privs.get(kid);
    if (k) return k;
    const stored = this.record?.keys.find((x) => x.kid === kid);
    if (!stored) return null;
    k = await crypto.subtle.importKey("jwk", stored.priv, CURVE, false, ["deriveBits"]);
    this.privs.set(kid, k);
    return k;
  }

  private async addPub(uid: number, kid: string, key: string) {
    const id = `${uid}:${kid}`;
    if (this.pubs.has(id)) return;
    try {
      const raw = unb64(key);
      // The id must really belong to the key, whatever the server says.
      if ((await kidOf(raw)) !== kid) return;
      this.pubs.set(id, await crypto.subtle.importKey("raw", raw, CURVE, false, []));
    } catch {
      /* not a valid key */
    }
  }

  /** Fetches the public keys of `uid` (once per connection, unless `force`). */
  fetchKeys(uid: number, force = false): Promise<void> {
    let p = force ? undefined : this.fetching.get(uid);
    if (!p) {
      p = (async () => {
        const r = await this.server.rpc<{ keys: { user_id: number; kid: string; key: string }[] }>("e2e.keys", { user_ids: [uid] });
        for (const k of r.keys) await this.addPub(k.user_id, k.kid, k.key);
        const newest = r.keys.find((k) => this.pubs.has(`${k.user_id}:${k.kid}`))?.kid ?? null;
        const m = new Map(this.peerKids.value);
        m.set(uid, newest);
        this.peerKids.value = m;
      })();
      this.fetching.set(uid, p);
      p.catch(() => this.fetching.delete(uid));
    }
    return p;
  }

  /** A key was published somewhere: forget what we knew about that user. */
  onKeyEvent(uid: number) {
    this.fetching.delete(uid);
    if (this.peerKids.value.has(uid)) void this.fetchKeys(uid, true).catch(() => {});
  }

  private async pub(uid: number, kid: string): Promise<CryptoKey | null> {
    const id = `${uid}:${kid}`;
    if (!this.pubs.has(id)) await this.fetchKeys(uid).catch(() => {});
    if (!this.pubs.has(id)) await this.fetchKeys(uid, true).catch(() => {});
    return this.pubs.get(id) ?? null;
  }

  private async sharedKey(myKid: string, uid: number, theirKid: string): Promise<CryptoKey | null> {
    const id = `${myKid}|${uid}:${theirKid}`;
    let k = this.aes.get(id);
    if (k) return k;
    const [priv, pub] = await Promise.all([this.priv(myKid), this.pub(uid, theirKid)]);
    if (!priv || !pub) return null;
    const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256);
    const hk = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    const salt = enc.encode([myKid, theirKid].sort().join("|"));
    k = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode("nexus-dm-v1") }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    this.aes.set(id, k);
    return k;
  }

  /** Encrypts `text` for the DM with `peer` (my own id for the notes-to-self DM). */
  async encrypt(peer: number, text: string, maxLen = 4000): Promise<string> {
    const myKid = await this.ensureKey();
    await this.fetchKeys(peer);
    const theirKid = peer === this.server.me.value?.id ? myKid : this.peerKids.value.get(peer);
    if (!theirKid) throw new E2eError("nokey");
    const key = await this.sharedKey(myKid, peer, theirKid);
    if (!key) throw new E2eError("nokey");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = enc.encode(`${PREFIX}|${myKid}|${theirKid}`);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, enc.encode(text)));
    const out = `${PREFIX}.${myKid}.${theirKid}.${b64(iv)}.${b64(ct)}`;
    if (out.length > maxLen) throw new E2eError("toolong");
    return out;
  }

  /**
   * Decrypts a message of the DM with `peer`. `mine` says whether I wrote it
   * (then my key is the sender key, otherwise the recipient key).
   */
  async decrypt(content: string, peer: number, mine: boolean): Promise<DecryptResult> {
    const m = ENVELOPE.exec(content);
    if (!m) return { fail: "corrupt" };
    await this.init();
    const [, skid, rkid, iv, ct] = m;
    const myKid = mine ? skid : rkid;
    const theirKid = mine ? rkid : skid;
    try {
      const key = await this.sharedKey(myKid, peer, theirKid);
      if (!key) return { fail: "key" };
      const aad = enc.encode(`${PREFIX}|${skid}|${rkid}`);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: aad }, key, unb64(ct));
      return { text: dec.decode(plain) };
    } catch {
      return { fail: "corrupt" };
    }
  }

  /** Short number both sides can compare to make sure nobody swapped a key. */
  safetyNumber(peer: number): string | null {
    const mine = this.myKid.value;
    const theirs = peer === this.server.me.value?.id ? mine : this.peerKids.value.get(peer);
    if (!mine || !theirs) return null;
    const both = [mine, theirs].sort().join("");
    return (both.match(/.{4}/g) ?? []).join(" ").toUpperCase();
  }

  // ------------------------------------------------------------- backup

  /** The key record, encrypted with a passphrase, to move it to another device. */
  async exportKeys(passphrase: string): Promise<string> {
    await this.ensureKey();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await passKey(passphrase, salt);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(this.record))));
    return JSON.stringify({ nexus_e2e_backup: 1, salt: b64(salt), iv: b64(iv), data: b64(ct) });
  }

  /** Restores keys from a backup; the imported current key becomes this device's key. */
  async importKeys(passphrase: string, backup: string): Promise<void> {
    const b = JSON.parse(backup);
    if (b?.nexus_e2e_backup !== 1) throw new Error("format");
    const key = await passKey(passphrase, unb64(b.salt));
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(b.iv) }, key, unb64(b.data));
    const rec = JSON.parse(dec.decode(plain)) as KeyRecord;
    if (rec?.v !== 1 || !Array.isArray(rec.keys) || !rec.keys.some((k) => k.kid === rec.current)) throw new Error("format");
    await this.init();
    // Keep the keys this device already had, so its old messages stay readable.
    const old = (this.record?.keys ?? []).filter((k) => !rec.keys.some((n) => n.kid === k.kid));
    this.record = { v: 1, current: rec.current, keys: [...rec.keys, ...old] };
    await secretSet(this.secretName(), JSON.stringify(this.record));
    this.privs.clear();
    this.aes.clear();
    this.myKid.value = rec.current;
    this.published = false;
    await this.publish();
  }
}

async function passKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 310_000 }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
