// Lightweight Markdown for messages: **bold**, *italic*, __underline__,
// ~~strike~~, ||spoiler||, `code`, ```blocks```, > quotes, # headings,
// links and @mentions. Produces VNodes only (no HTML injection possible).

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { ServerStore } from "../state/server";
import { openExternal } from "./links";

const INLINE =
  /(`[^`\n]+`)|(\|\|[\s\S]+?\|\|)|(\*\*[\s\S]+?\*\*)|(__[\s\S]+?__)|(~~[\s\S]+?~~)|(\*[^*\n]+\*)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(@[A-Za-z0-9_.-]{2,32})/g;

function Spoiler({ children }: { children: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  return (
    <span class={`spoiler${open ? " revealed" : ""}`} onClick={() => setOpen(true)} role="button" tabIndex={0}>
      {children}
    </span>
  );
}

function inline(text: string, server: ServerStore, key: string, depth = 0): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  const re = new RegExp(INLINE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  const nest = (s: string) => (depth > 4 ? [s] : inline(s, server, `${key}.${i}`, depth + 1));
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    const [all] = m;
    if (m[1]) out.push(<code key={k}>{all.slice(1, -1)}</code>);
    else if (m[2]) out.push(<Spoiler key={k}>{nest(all.slice(2, -2))}</Spoiler>);
    else if (m[3]) out.push(<strong key={k}>{nest(all.slice(2, -2))}</strong>);
    else if (m[4]) out.push(<u key={k}>{nest(all.slice(2, -2))}</u>);
    else if (m[5]) out.push(<s key={k}>{nest(all.slice(2, -2))}</s>);
    else if (m[6]) out.push(<em key={k}>{nest(all.slice(1, -1))}</em>);
    else if (m[7]) {
      const url = all;
      out.push(
        <a key={k} href={url} onClick={(e) => { e.preventDefault(); void openExternal(url); }}>
          {url}
        </a>,
      );
    } else if (m[8]) {
      const name = all.slice(1).replace(/[.-]+$/, "").toLowerCase();
      const known = [...server.members.value.values()].some((u) => u.username.toLowerCase() === name);
      out.push(known ? <span key={k} class="mention">{all}</span> : all);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function blocks(text: string, server: ServerStore, key: string): ComponentChildren[] {
  const lines = text.split("\n");
  const out: ComponentChildren[] = [];
  let quote: string[] = [];
  const flushQuote = (k: string) => {
    if (quote.length) {
      out.push(<blockquote key={`q${k}`}>{inline(quote.join("\n"), server, `q${k}`)}</blockquote>);
      quote = [];
    }
  };
  lines.forEach((line, i) => {
    const k = `${key}.${i}`;
    if (line.startsWith("> ") || line === ">") {
      quote.push(line.slice(2));
      return;
    }
    flushQuote(k);
    const h = /^#{1,3} (.+)$/.exec(line);
    if (h) out.push(<h3 key={k}>{inline(h[1], server, k)}</h3>);
    else {
      out.push(<span key={k}>{inline(line, server, k)}</span>);
      if (i < lines.length - 1) out.push("\n");
    }
  });
  flushQuote("end");
  return out;
}

export function Markdown({ text, server }: { text: string; server: ServerStore }) {
  const parts = text.split("```");
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 && i < parts.length - 1 ? <pre key={i}>{p.replace(/^\w*\n/, "")}</pre> : <span key={i}>{blocks(i % 2 === 1 ? "```" + p : p, server, String(i))}</span>,
      )}
    </>
  );
}

/** Wraps the selection of a textarea with a Markdown marker (Ctrl+B / I / U). */
export function wrapSelection(el: HTMLTextAreaElement, marker: string, set: (v: string) => void) {
  const { selectionStart: a, selectionEnd: b, value } = el;
  const next = value.slice(0, a) + marker + value.slice(a, b) + marker + value.slice(b);
  set(next);
  requestAnimationFrame(() => el.setSelectionRange(a + marker.length, b + marker.length));
}
