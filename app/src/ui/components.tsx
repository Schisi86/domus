// Reusable UI building blocks of the design system.

import type { ButtonHTMLAttributes, ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { closeDialog, closeModal, contextMenu, dialog, dismissToast, lightbox, openDialog, toasts } from "../state/app";
import type { ServerStore } from "../state/server";
import { transport } from "../net/transport";
import * as Icon from "./icons";
import { t } from "../i18n";

// ------------------------------------------------------------- media cache

const MAX_BLOBS = 250;
const blobCache = new Map<string, Promise<string | null>>();

/** Loads an authenticated resource (avatar, image attachment) as an object URL. */
export function loadBlobUrl(server: ServerStore, path: string): Promise<string | null> {
  const key = `${server.id}|${path}`;
  const hit = blobCache.get(key);
  if (hit) {
    blobCache.delete(key);
    blobCache.set(key, hit);
    return hit;
  }
  const p = transport
    .bytes(server.target(), path, server.token)
    .then((b) => URL.createObjectURL(b))
    .catch(() => null);
  blobCache.set(key, p);
  if (blobCache.size > MAX_BLOBS) {
    const [oldKey, oldP] = blobCache.entries().next().value!;
    blobCache.delete(oldKey);
    oldP.then((u) => u && URL.revokeObjectURL(u));
  }
  return p;
}

export function useBlobUrl(server: ServerStore | null, path: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (server && path) loadBlobUrl(server, path).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [server, path]);
  return url;
}

// ------------------------------------------------------------- avatar

const PALETTE = ["#6e56f8", "#14b8a6", "#e5484d", "#f0a92b", "#3e9b4f", "#2f80ed", "#c2410c", "#a855f7"];

export function Avatar(props: {
  server: ServerStore | null;
  userId?: number;
  name: string;
  size?: number;
  presence?: string | null;
  speaking?: boolean;
  imagePath?: string | null;
}) {
  const size = props.size ?? 32;
  const path = props.imagePath ?? (props.server && props.userId !== undefined ? props.server.avatarPath(props.userId) : null);
  const url = useBlobUrl(props.server, path);
  const color = PALETTE[Math.abs(hashCode(props.name)) % PALETTE.length];
  return (
    <div class={`avatar${props.speaking ? " speaking" : ""}`} style={{ width: `${size}px`, height: `${size}px`, background: url ? "transparent" : color, fontSize: `${size}px` }}>
      {url ? <img src={url} alt="" draggable={false} /> : <span class="initials">{initials(props.name)}</span>}
      {props.presence && <span class={`presence ${props.presence}`} title={props.presence} />}
    </div>
  );
}

export function initials(name: string) {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function hashCode(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// ------------------------------------------------------------- modal

export function Modal(props: { title?: string; sub?: ComponentChildren; children: ComponentChildren; footer?: ComponentChildren; onClose?: () => void; wide?: boolean; layer?: "dialog"; class?: string }) {
  const close = props.onClose ?? (props.layer ? closeDialog : closeModal);
  useEffect(() => {
    // Escape closes only the topmost layer.
    const k = (e: KeyboardEvent) => e.key === "Escape" && (props.layer || !dialog.value) && close();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [close]);
  return (
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class={`modal${props.wide ? " wide" : ""}${props.class ? ` ${props.class}` : ""}`} role="dialog" aria-modal="true" aria-label={props.title}>
        {props.wide ? (
          props.children
        ) : (
          <>
            {props.title && (
              <div class="modal-head">
                <h2>{props.title}</h2>
                {props.sub && <div class="muted small">{props.sub}</div>}
              </div>
            )}
            <div class="modal-body">{props.children}</div>
            {props.footer && <div class="modal-foot">{props.footer}</div>}
          </>
        )}
      </div>
    </div>
  );
}

export function confirmDialog(opts: { title: string; body: ComponentChildren; confirm?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      closeDialog();
      resolve(v);
    };
    openDialog(
      <Modal
        layer="dialog"
        title={opts.title}
        onClose={() => done(false)}
        footer={
          <>
            <button class="btn ghost" onClick={() => done(false)}>{t("common.cancel")}</button>
            <button class={`btn ${opts.danger ? "danger" : "primary"}`} onClick={() => done(true)} autoFocus>
              {opts.confirm ?? t("common.confirm")}
            </button>
          </>
        }
      >
        <div class="muted" style={{ lineHeight: 1.5 }}>{opts.body}</div>
      </Modal>,
    );
  });
}

function PromptBody(props: { label: string; password?: boolean; onValue: (v: string) => void; onSubmit: () => void }) {
  return (
    <Field label={props.label}>
      {props.password ? (
        <input class="input" autoFocus type="password" onInput={(e) => props.onValue((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && props.onSubmit()} />
      ) : (
        <input class="input" autoFocus onInput={(e) => props.onValue((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && props.onSubmit()} />
      )}
    </Field>
  );
}

/** Asks for a single value; resolves to null when cancelled. */
export function promptDialog(opts: { title: string; label: string; body?: ComponentChildren; password?: boolean; confirm?: string; danger?: boolean }): Promise<string | null> {
  return new Promise((resolve) => {
    let value = "";
    const done = (v: string | null) => {
      closeDialog();
      resolve(v);
    };
    openDialog(
      <Modal
        layer="dialog"
        title={opts.title}
        onClose={() => done(null)}
        footer={
          <>
            <button class="btn ghost" onClick={() => done(null)}>{t("common.cancel")}</button>
            <button class={`btn ${opts.danger ? "danger" : "primary"}`} onClick={() => done(value)}>{opts.confirm ?? t("common.ok")}</button>
          </>
        }
      >
        {opts.body && <div class="muted small">{opts.body}</div>}
        <PromptBody label={opts.label} password={opts.password} onValue={(v) => (value = v)} onSubmit={() => done(value)} />
      </Modal>,
    );
  });
}

// ------------------------------------------------------------- form controls

export function Field(props: { label: string; hint?: ComponentChildren; children: ComponentChildren; error?: string | null }) {
  return (
    <div class="field">
      <label>{props.label}</label>
      {props.children}
      {props.error ? <div class="error-text">{props.error}</div> : props.hint && <div class="hint">{props.hint}</div>}
    </div>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: ComponentChildren; desc?: ComponentChildren; disabled?: boolean }) {
  return (
    <label class="row" style={{ justifyContent: "space-between", gap: "16px", cursor: props.disabled ? "default" : "pointer", opacity: props.disabled ? 0.55 : 1 }}>
      <div class="grow">
        <div>{props.label}</div>
        {props.desc && <div class="faint xs" style={{ marginTop: "2px" }}>{props.desc}</div>}
      </div>
      <span class="toggle">
        <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)} />
        <span />
      </span>
    </label>
  );
}

export function IconButton(
  props: { title: string; onClick?: (e: MouseEvent) => void; children: ComponentChildren; class?: string; active?: boolean; disabled?: boolean } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title" | "onClick" | "class">,
) {
  const { title, children, class: cls, active, ...rest } = props;
  return (
    <button {...rest} class={`icon-btn ${cls ?? ""}${active ? " active" : ""}`} title={title} aria-label={title} type="button">
      {children}
    </button>
  );
}

export function Spinner() {
  return <div class="spinner" role="status" aria-label={t("common.loading")} />;
}

export function ProgressBar(props: { value: number }) {
  return (
    <div class="progress">
      <div style={{ width: `${Math.round(props.value * 100)}%` }} />
    </div>
  );
}

// ------------------------------------------------------------- global layers

export function Toasts() {
  return (
    <div class="toasts" aria-live="polite">
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`} onClick={() => dismissToast(t.id)}>
          <b>{t.title}</b>
          {t.body && <div class="muted">{t.body}</div>}
        </div>
      ))}
    </div>
  );
}

export function ContextMenu() {
  const m = contextMenu.value;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!m) return;
    const close = () => (contextMenu.value = null);
    const k = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", k);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", k);
      window.removeEventListener("blur", close);
    };
  }, [m]);
  useEffect(() => {
    if (!m || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(m.x, window.innerWidth - r.width - 8), y: Math.min(m.y, window.innerHeight - r.height - 8) });
  }, [m]);
  if (!m) return null;
  return (
    <div ref={ref} class="menu" style={{ left: `${pos?.x ?? m.x}px`, top: `${pos?.y ?? m.y}px`, visibility: pos ? "visible" : "hidden" }} onMouseDown={(e) => e.stopPropagation()} role="menu">
      {m.items.map((it, i) =>
        it.separator ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            role="menuitem"
            class={it.danger ? "danger" : ""}
            onClick={() => {
              contextMenu.value = null;
              it.onClick?.();
            }}
          >
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

export function Lightbox() {
  const src = lightbox.value;
  useEffect(() => {
    if (!src) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && (lightbox.value = null);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [src]);
  if (!src) return null;
  return (
    <div class="lightbox" onClick={() => (lightbox.value = null)}>
      <img src={src} alt="" />
    </div>
  );
}

export function EmptyState(props: { title: string; children?: ComponentChildren; icon?: ComponentChildren }) {
  return (
    <div class="empty">
      <div class="inner">
        {props.icon ?? <LogoMark />}
        <h2>{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}

/** The 3D app logo. */
export function LogoMark({ size }: { size?: number }) {
  return (
    <div class="logo-mark" style={size ? { width: `${size}px`, height: `${size}px` } : undefined}>
      <img src="/logo.png" alt="NexusTalk" draggable={false} />
    </div>
  );
}

/** Small anchored popover (emoji picker, language picker). Closes on outside click / Esc. */
export function Popover(props: { anchor: DOMRect; onClose: () => void; children: ComponentChildren; align?: "above" | "below" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const a = props.anchor;
    let top = props.align === "below" ? a.bottom + 6 : a.top - r.height - 6;
    if (top < 8) top = a.bottom + 6;
    if (top + r.height > window.innerHeight - 8) top = window.innerHeight - r.height - 8;
    let left = a.left;
    if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [props.anchor]);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && props.onClose();
    const k = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    setTimeout(() => window.addEventListener("mousedown", close), 0);
    window.addEventListener("keydown", k);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", k);
    };
  }, []);
  return (
    <div ref={ref} class="popover" style={{ left: `${pos?.left ?? -9999}px`, top: `${pos?.top ?? -9999}px` }}>
      {props.children}
    </div>
  );
}

export function copyText(text: string) {
  void navigator.clipboard?.writeText(text);
}

export { Icon };
