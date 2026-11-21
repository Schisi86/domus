// Domus – Projektseite: Effekte und kleine Helfer. Ohne Abhängigkeiten.
(() => {
  "use strict";
  const doc = document.documentElement;
  doc.classList.add("js");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ---------- one rAF loop for all scroll-linked effects ----------
  const scrollFx = [];
  let ticking = false;
  // every effect measures first and returns a function that writes – no layout thrashing
  const runScroll = () => { ticking = false; const writes = scrollFx.map((f) => f()); for (const w of writes) if (w) w(); };
  const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(runScroll); } };
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll, { passive: true });

  // ---------- header: glass on scroll, progress bar, active link ----------
  const nav = $("#nav");
  const bar = $("#progress");
  scrollFx.push(() => {
    const y = scrollY, max = doc.scrollHeight - innerHeight;
    return () => {
      nav.classList.toggle("scrolled", y > 12);
      bar.style.setProperty("--p", max > 0 ? (y / max).toFixed(4) : 0);
    };
  });

  const links = $$(".nav-links a");
  const byId = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
  const secIO = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      links.forEach((a) => a.classList.remove("active"));
      const a = byId.get(e.target.id);
      if (a) a.classList.add("active");
    });
  }, { rootMargin: "-45% 0px -50% 0px" });
  byId.forEach((_, id) => { const s = document.getElementById(id); if (s) secIO.observe(s); });

  // mobile menu
  const menuBtn = $(".menu-btn");
  const menu = $("#nav-links");
  const setMenu = (open) => {
    menu.classList.toggle("open", open);
    menuBtn.setAttribute("aria-expanded", open);
    menuBtn.setAttribute("aria-label", open ? "Menü schließen" : "Menü öffnen");
    menuBtn.querySelector("use").setAttribute("href", open ? "#i-x" : "#i-menu");
  };
  menuBtn.addEventListener("click", () => setMenu(!menu.classList.contains("open")));
  menu.addEventListener("click", (e) => { if (e.target.closest("a")) setMenu(false); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && menu.classList.contains("open")) { setMenu(false); menuBtn.focus(); } });

  // ---------- hero headline: word by word ----------
  $$(".split").forEach((el) => {
    let i = 0;
    const walk = (node) => {
      [...node.childNodes].forEach((n) => {
        if (n.nodeType === 3) {
          const parts = n.textContent.split(/(\s+)/);
          const frag = document.createDocumentFragment();
          parts.forEach((p) => {
            if (!p) return;
            if (/^\s+$/.test(p)) { frag.appendChild(document.createTextNode(p)); return; }
            const w = document.createElement("span");
            w.className = "w";
            w.style.setProperty("--i", i++);
            w.textContent = p;
            frag.appendChild(w);
          });
          n.replaceWith(frag);
        } else if (n.nodeType === 1) walk(n);
      });
    };
    walk(el);
    // gradient words: keep the gradient continuous across the line
    $$(".grad-text .w", el).forEach((w) => { w.classList.add("grad-text"); });
    $$(".grad-text", el).forEach((g) => { if (!g.classList.contains("w")) g.classList.remove("grad-text"); });
  });
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $$(".split, .hero .fade-up, .hero .rise").forEach((el) => el.classList.add("in"));
  }));

  // ---------- reveal on scroll ----------
  const revIO = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); revIO.unobserve(e.target); } });
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.01 });
  $$(".reveal").forEach((el) => revIO.observe(el));

  // ---------- hero: pointer spotlight, device tilt, parallax chips ----------
  const hero = $(".hero");
  const spot = $(".hero-spot");
  const device = $("#device");
  const chips = $$(".chip");
  if (!reduce) {
    const stage = $("#stage");
    scrollFx.push(() => {
      const r = stage.getBoundingClientRect();
      if (r.top > innerHeight * 1.2 || r.bottom < 0) return null;
      const p = clamp(1 - (r.top - innerHeight * 0.16) / (innerHeight * 0.62), 0, 1);
      const e = 1 - Math.pow(1 - p, 3);
      return () => {
        device.style.setProperty("--rx", (24 * (1 - e)).toFixed(2) + "deg");
        device.style.setProperty("--sc", (0.92 + 0.08 * e).toFixed(4));
      };
    });
    if (finePointer) {
      hero.addEventListener("pointermove", (ev) => {
        const r = hero.getBoundingClientRect();
        const x = ev.clientX - r.left, y = ev.clientY - r.top;
        spot.style.setProperty("--sx", x + "px");
        spot.style.setProperty("--sy", y + "px");
        const nx = x / r.width - 0.5, ny = y / r.height - 0.5;
        chips.forEach((c) => {
          const d = +c.dataset.depth || 10;
          c.style.setProperty("--px", (nx * d).toFixed(1) + "px");
          c.style.setProperty("--py", (ny * d).toFixed(1) + "px");
        });
      });
    }
  }

  // ---------- magnetic buttons ----------
  if (finePointer && !reduce) {
    $$(".magnetic").forEach((b) => {
      b.addEventListener("pointermove", (e) => {
        const r = b.getBoundingClientRect();
        const x = (e.clientX - r.left - r.width / 2) * 0.18, y = (e.clientY - r.top - r.height / 2) * 0.28;
        b.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      });
      b.addEventListener("pointerleave", () => { b.style.transform = ""; });
    });
  }

  // ---------- spotlight cards ----------
  if (finePointer) {
    $$(".card, .dl-card").forEach((c) => c.addEventListener("pointermove", (e) => {
      const r = c.getBoundingClientRect();
      c.style.setProperty("--mx", e.clientX - r.left + "px");
      c.style.setProperty("--my", e.clientY - r.top + "px");
    }));
  }

  // ---------- count-up stats ----------
  const fmt = (v, dec) => v.toLocaleString("de-DE", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const cntIO = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      cntIO.unobserve(e.target);
      const el = e.target, to = parseFloat(el.dataset.count), dec = +(el.dataset.dec || 0);
      if (reduce || to === 0) { el.textContent = fmt(to, dec); return; }
      const t0 = performance.now(), dur = 1400;
      const step = (t) => {
        const p = clamp((t - t0) / dur, 0, 1), k = 1 - Math.pow(1 - p, 4);
        el.textContent = fmt(to * k, dec);
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }, { threshold: 0.6 });
  $$("[data-count]").forEach((el) => cntIO.observe(el));

  // ---------- scrollytelling ----------
  const steps = $$(".step-card");
  const shots = $$("#story-screen img");
  const dots = $$(".story-dots i");
  const screen = $("#story-screen");
  const setStep = (i) => {
    steps.forEach((s, k) => s.classList.toggle("active", k === i));
    shots.forEach((s, k) => s.classList.toggle("on", k === i));
    dots.forEach((d, k) => d.classList.toggle("on", k === i));
    if (screen && steps[i]) screen.style.setProperty("--glow", steps[i].dataset.glow);
  };
  if (steps.length) {
    setStep(0);
    const stIO = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) setStep(+e.target.dataset.i); });
    }, { rootMargin: "-45% 0px -45% 0px" });
    steps.forEach((s) => stIO.observe(s));
    // preload the big pictures once the section comes close
    const pre = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { shots.forEach((img) => { img.loading = "eager"; }); pre.disconnect(); }
    }, { rootMargin: "600px 0px" });
    pre.observe($("#story"));
  }

  // ---------- phones parallax ----------
  const phones = $("#phones");
  if (phones && !reduce) {
    scrollFx.push(() => {
      const r = phones.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) return null;
      const p = (r.top + r.height / 2 - innerHeight / 2) / innerHeight; // -1 … 1
      return () => {
        phones.style.setProperty("--py1", (p * 50).toFixed(1) + "px");
        phones.style.setProperty("--py2", (p * -30).toFixed(1) + "px");
        phones.style.setProperty("--py3", (p * 70).toFixed(1) + "px");
      };
    });
  }

  // ---------- hosting steps line ----------
  const stepsWrap = $("#steps");
  const line = $("#steps-line");
  if (stepsWrap) {
    const items = $$("li", stepsWrap);
    scrollFx.push(() => {
      const r = stepsWrap.getBoundingClientRect();
      if (r.top > innerHeight * 1.5 || r.bottom < -innerHeight) return null;
      const mark = innerHeight * 0.62;
      const p = clamp((mark - r.top) / r.height, 0, 1);
      const lit = items.map((li) => reduce || li.getBoundingClientRect().top + 24 < mark);
      return () => {
        line.style.setProperty("--lp", (reduce ? 1 : p).toFixed(4));
        items.forEach((li, k) => li.classList.toggle("lit", lit[k]));
      };
    });
  }

  // ---------- design gallery ----------
  const THEMES = [
    ["cyber", "Cyberpunk", "dunkel", ["#07060f", "#0b0918", "#100d20", "#fcee0a", "#ff2a6d"]],
    ["emerald", "Smaragd", "Standard", ["#07140f", "#0b1a15", "#0f221b", "#2ee59d", "#8ff5cf"]],
    ["graphite", "Graphit", "ruhig", ["#101114", "#15161a", "#1a1b20", "#7c8cff", "#aab4ff"]],
    ["fjord", "Fjord", "ruhig", ["#1c222c", "#222a36", "#2a3340", "#88c0d0", "#a3d9c9"]],
    ["mono", "Mono", "ruhig", ["#0b0b0c", "#111112", "#171718", "#f2f2f3", "#c9c9ce"]],
    ["mocha", "Mokka", "warm", ["#17120f", "#1e1713", "#261d17", "#d9a066", "#edc79b"]],
    ["bordeaux", "Bordeaux", "warm", ["#160d11", "#1e1017", "#27131d", "#e58a9b", "#f2c4a8"]],
    ["paper", "Papier", "hell", ["#e4e7ec", "#f0f2f5", "#fbfbfc", "#3b5bdb", "#5c7cfa"]],
    ["midnight", "Mitternacht", "dunkel", ["#070b18", "#0b1122", "#0f172c", "#6b97ff", "#a9c2ff"]],
    ["aurora", "Aurora", "dunkel", ["#0b0a1a", "#110f24", "#15132c", "#a78bfa", "#2dd4bf"]],
    ["obsidian", "Obsidian", "OLED-schwarz", ["#000000", "#070707", "#0b0b0b", "#b6f23d", "#dcff8f"]],
    ["ocean", "Tiefsee", "dunkel", ["#031520", "#04192a", "#062033", "#38bdf8", "#2dd4bf"]],
    ["nebula", "Galaxie", "dunkel", ["#07040f", "#0a0618", "#100a22", "#c084fc", "#f472b6"]],
    ["gold", "Royal Gold", "dunkel", ["#0a0806", "#0f0c08", "#16110b", "#e8b54a", "#f5d68a"]],
    ["sunset", "Sonnenuntergang", "dunkel", ["#130b0d", "#1a0f13", "#201418", "#ff7a45", "#ff4d8d"]],
    ["synthwave", "Synthwave", "animiert", ["#140a24", "#1b0d33", "#241152", "#ff2e97", "#00e5ff"]],
    ["jade", "Jade", "hell", ["#d8ece2", "#eaf6f0", "#fbfefc", "#0e9f68", "#34d399"]],
    ["arctic", "Arktis", "hell", ["#dce8f2", "#edf4fa", "#fbfdff", "#1683e0", "#00b8d4"]],
    ["sakura", "Sakura", "hell", ["#f6dfe8", "#fcf0f5", "#fffbfd", "#e0558a", "#f78fb3"]],
    ["sandstone", "Sandstein", "hell", ["#e6dccc", "#f4ede2", "#fdfaf5", "#c0623b", "#d99b4a"]],
  ];
  const themesEl = $("#themes");
  const tShot = $("#theme-shot");
  const tLink = $("#theme-link");
  const designs = $("#designs");
  const whenNear = (el, fn) => {
    if (!el) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); fn(); } }, { rootMargin: "900px 0px" });
    io.observe(el);
  };
  whenNear(themesEl, () => {
    const btns = THEMES.map(([id, name, kind, sw], i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "theme";
      b.setAttribute("aria-pressed", i === 0 ? "true" : "false");
      b.style.setProperty("--a", sw[3]);
      b.style.setProperty("--b", sw[4]);
      b.innerHTML = `<span class="swatch" aria-hidden="true"><i style="background:${sw[0]}"></i><i style="background:${sw[1]}"></i><i style="background:${sw[2]}"></i></span><span>${name}<small>${kind}</small></span>`;
      b.addEventListener("click", () => {
        btns.forEach((x) => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
        const s = `assets/img/${id}-de-chat-s.webp`, l = `assets/img/${id}-de-chat-l.webp`;
        designs.style.setProperty("--theme", sw[3]);
        tShot.classList.remove("on");
        const img = new Image();
        img.srcset = `${s} 1024w, ${l} 2040w`;
        img.sizes = tShot.sizes;
        img.src = l;
        const swap = () => {
          tShot.srcset = img.srcset; tShot.src = l; tShot.alt = `Domus-Chatansicht im Design ${name}`;
          tLink.href = l;
          requestAnimationFrame(() => tShot.classList.add("on"));
        };
        img.decode ? img.decode().then(swap, swap) : (img.onload = swap);
      });
      themesEl.appendChild(b);
      return b;
    });
  });
  if (designs) designs.style.setProperty("--theme", THEMES[0][3][3]);

  // ---------- languages marquee ----------
  const star = (cx, cy, r, rot = -90) => {
    const p = [];
    for (let i = 0; i < 10; i++) {
      const a = ((rot + i * 36) * Math.PI) / 180, rr = i % 2 ? r * 0.4 : r;
      p.push((cx + rr * Math.cos(a)).toFixed(2) + "," + (cy + rr * Math.sin(a)).toFixed(2));
    }
    return p.join(" ");
  };
  const tri = (a, b, c) => `<rect width="30" height="6.67" fill="${a}"/><rect y="6.67" width="30" height="6.67" fill="${b}"/><rect y="13.33" width="30" height="6.67" fill="${c}"/>`;
  const vtri = (a, b, c) => `<rect width="10" height="20" fill="${a}"/><rect x="10" width="10" height="20" fill="${b}"/><rect x="20" width="10" height="20" fill="${c}"/>`;
  const F = {
    de: tri("#000", "#dd0000", "#ffce00"),
    gb: `<rect width="30" height="20" fill="#012169"/><path d="M0 0 30 20M30 0 0 20" stroke="#fff" stroke-width="4"/><path d="M0 0 30 20M30 0 0 20" stroke="#c8102e" stroke-width="1.6"/><path d="M15 0v20M0 10h30" stroke="#fff" stroke-width="6"/><path d="M15 0v20M0 10h30" stroke="#c8102e" stroke-width="3.4"/>`,
    es: `<rect width="30" height="20" fill="#aa151b"/><rect y="5" width="30" height="10" fill="#f1bf00"/>`,
    fr: vtri("#002395", "#fff", "#ed2939"),
    it: vtri("#009246", "#fff", "#ce2b37"),
    pt: `<rect width="30" height="20" fill="#da291c"/><rect width="12" height="20" fill="#046a38"/><circle cx="12" cy="10" r="4.4" fill="#ffe900"/><rect x="10.2" y="7.6" width="3.6" height="4.6" rx="1.2" fill="#da291c" stroke="#fff" stroke-width=".6"/>`,
    nl: tri("#ae1c28", "#fff", "#21468b"),
    pl: `<rect width="30" height="10" fill="#fff"/><rect y="10" width="30" height="10" fill="#dc143c"/>`,
    tr: `<rect width="30" height="20" fill="#e30a17"/><circle cx="11" cy="10" r="5" fill="#fff"/><circle cx="12.3" cy="10" r="4" fill="#e30a17"/><polygon points="${star(17.6, 10, 2.4, 180)}" fill="#fff"/>`,
    ru: tri("#fff", "#0039a6", "#d52b1e"),
    sa: `<rect width="30" height="20" fill="#006c35"/><path d="M7 8.2c1.2-1.2 2 .8 3.2-.4s1.6.9 2.9-.3 1.7.8 3-.4 1.6.9 3-.3 1.5.8 3.9-.4" fill="none" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/><path d="M8 13.4h13.5l1.6-.9" fill="none" stroke="#fff" stroke-width=".9" stroke-linecap="round"/>`,
    in: tri("#ff9933", "#fff", "#138808") + `<circle cx="15" cy="10" r="2.6" fill="none" stroke="#000080" stroke-width=".6"/><circle cx="15" cy="10" r=".6" fill="#000080"/>`,
    cn: `<rect width="30" height="20" fill="#ee1c25"/><polygon points="${star(5, 5, 3)}" fill="#ff0"/><polygon points="${star(10, 2, 1, -60)}" fill="#ff0"/><polygon points="${star(12, 4, 1, -80)}" fill="#ff0"/><polygon points="${star(12, 7, 1, -100)}" fill="#ff0"/><polygon points="${star(10, 9, 1, -120)}" fill="#ff0"/>`,
    jp: `<rect width="30" height="20" fill="#fff"/><circle cx="15" cy="10" r="6" fill="#bc002d"/>`,
    kr: `<rect width="30" height="20" fill="#fff"/><g transform="rotate(-33.7 15 10)"><path d="M10 10a5 5 0 0 1 10 0z" fill="#cd2e3a"/><path d="M10 10a5 5 0 0 0 10 0z" fill="#0047a0"/><circle cx="12.5" cy="10" r="2.5" fill="#cd2e3a"/><circle cx="17.5" cy="10" r="2.5" fill="#0047a0"/></g>`,
  };
  const LANGS = [["de", "Deutsch", "Standard"], ["gb", "English", "Englisch"], ["es", "Español", "Spanisch"], ["fr", "Français", "Französisch"], ["it", "Italiano", "Italienisch"],
    ["pt", "Português", "Portugiesisch"], ["nl", "Nederlands", "Niederländisch"], ["pl", "Polski", "Polnisch"], ["tr", "Türkçe", "Türkisch"], ["ru", "Русский", "Russisch"],
    ["sa", "العربية", "Arabisch"], ["in", "हिन्दी", "Hindi"], ["cn", "中文", "Chinesisch"], ["jp", "日本語", "Japanisch"], ["kr", "한국어", "Koreanisch"]];
  const langsEl = $("#langs");
  whenNear(langsEl, () => {
    const pill = ([f, name, de], dup) => `<span class="lang${dup ? " dup" : ""}"><svg viewBox="0 0 30 20" preserveAspectRatio="none" aria-hidden="true">${F[f]}</svg><b>${name}</b><small>${de}</small></span>`;
    const row = (list, rev) => `<div class="mq-row${rev ? " rev" : ""}">${list.map((l) => pill(l)).join("")}${list.map((l) => pill(l, true)).join("")}</div>`;
    langsEl.innerHTML = row(LANGS.slice(0, 8)) + row(LANGS.slice(8), true);
  });

  // ---------- recommend the download for this device ----------
  const ua = navigator.userAgent;
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const os = /Android/i.test(ua) ? "android" : /iPhone|iPad|iPod/.test(ua) || touchMac ? "ios" : /Mac OS X|Macintosh/.test(ua) ? "mac" : /Windows/.test(ua) ? "windows" : null;
  if (os) {
    const card = $(`.dl-card[data-os="${os}"]`);
    if (card) {
      card.classList.add("rec");
      const b = $(".btn", card);
      if (os !== "windows") { b.classList.add("btn-primary"); $('.dl-card[data-os="windows"] .btn').classList.remove("btn-primary"); }
    }
    const cta = $("#hero-dl");
    const CTA = {
      mac: ["download/Domus_1.0.2_universal.dmg", "#i-apple", "Für macOS herunterladen", true],
      android: ["download/Domus_1.0.2_android.apk", "#i-android", "Android-App herunterladen", true],
      ios: ["#download-ios", "#i-apple", "Für iPhone & iPad", false],
    }[os];
    if (cta && CTA) {
      cta.href = CTA[0];
      cta.querySelector("use").setAttribute("href", CTA[1]);
      cta.querySelector("span").textContent = CTA[2];
      if (!CTA[3]) cta.removeAttribute("download");
    }
  }

  // ---------- copy + toast ----------
  const toastEl = $("#toast");
  let tt;
  const toast = (msg) => { toastEl.textContent = msg; toastEl.classList.add("show"); clearTimeout(tt); tt = setTimeout(() => toastEl.classList.remove("show"), 2200); };
  $$("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    const v = b.dataset.copy;
    try { await navigator.clipboard.writeText(v); toast(v.includes("@") ? "E-Mail-Adresse kopiert" : "Prüfsumme kopiert"); } catch { toast(v); }
  }));

  // ---------- lightbox ----------
  const lb = $("#lightbox");
  const lbImg = $("img", lb);
  let lastFocus = null;
  const closeLb = () => { lb.classList.remove("show"); if (lastFocus) lastFocus.focus(); };
  $$("a.frame").forEach((a) => a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    lastFocus = a;
    const inner = a.querySelector("img");
    lbImg.src = a.getAttribute("href");
    lbImg.alt = inner ? inner.alt : "";
    lb.classList.add("show");
    $("button", lb).focus();
  }));
  lb.addEventListener("click", closeLb);
  addEventListener("keydown", (e) => { if (e.key === "Escape" && lb.classList.contains("show")) closeLb(); });

  // ---------- smooth FAQ / install accordions ----------
  if (!reduce) {
    $$(".faq details, .install details").forEach((d) => {
      const sum = $("summary", d);
      const body = sum.nextElementSibling;
      sum.addEventListener("click", (e) => {
        e.preventDefault();
        if (d.dataset.anim) return;
        d.dataset.anim = "1";
        if (!d.open) {
          d.open = true;
          const h = body.scrollHeight;
          body.animate([{ height: "0px", opacity: 0 }, { height: h + "px", opacity: 1 }], { duration: 380, easing: "cubic-bezier(.22,1,.36,1)" }).onfinish = () => delete d.dataset.anim;
        } else {
          const h = body.scrollHeight;
          body.style.overflow = "hidden";
          body.animate([{ height: h + "px", opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 300, easing: "cubic-bezier(.4,0,.2,1)" }).onfinish = () => { d.open = false; body.style.overflow = ""; delete d.dataset.anim; };
        }
      });
      body.style.overflow = "hidden";
    });
  }

  onScroll();
})();
