// Banime — anime studio SPA (no build step). Auth: Cognito managed login (email) + Google, OAuth 2.0 code + PKCE.
import { demoApi } from "./demo.js";

const CFG = window.BANIME_CONFIG || {};
const DEMO = !CFG.apiUrl || new URLSearchParams(location.search).has("demo");
const $app = document.getElementById("app");
const $nav = document.getElementById("nav");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* unavailable */ } },
};
function toast(msg, err = false) {
  const t = document.getElementById("toast"); t.textContent = msg; t.className = "show" + (err ? " err" : "");
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = ""), 4500);
}
async function busy(btn, fn) {
  const html = btn?.innerHTML; if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  try { return await fn(); } catch (e) { toast(e.message, true); throw e; } finally { if (btn) { btn.disabled = false; btn.innerHTML = html; } }
}

// ------------------------------------------------------------------ auth (OAuth code + PKCE against the Cognito domain)
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const redirectUri = () => location.origin + "/";
const auth = {
  get session() { return store.get("bn.session"); },
  async login(provider) {
    if (DEMO) { location.href = "?demo#/home"; return; }
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
    sessionStorage.setItem("bn.pkce", JSON.stringify({ verifier, state, back: location.hash.startsWith("#/") && location.hash !== "#/" && location.hash !== "#auth" ? location.hash : "#/home" }));
    const q = new URLSearchParams({ response_type: "code", client_id: CFG.userPoolClientId, redirect_uri: redirectUri(),
      scope: "openid email profile", code_challenge_method: "S256", code_challenge: challenge, state });
    if (provider) q.set("identity_provider", provider);
    location.href = `${CFG.authDomain}/oauth2/authorize?${q}`;
  },
  async token(params) {
    const r = await fetch(`${CFG.authDomain}/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CFG.userPoolClientId, ...params }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error_description || d.error || "Sign-in failed");
    return d;
  },
  save(d) {
    const prev = this.session || {};
    let claims = {}; try { claims = JSON.parse(atob(d.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { /* ignore */ }
    store.set("bn.session", { idToken: d.id_token, refreshToken: d.refresh_token || prev.refreshToken, expires: Date.now() + (d.expires_in - 60) * 1000,
      email: claims.email, name: claims.name || claims.given_name || (claims.email || "").split("@")[0], picture: claims.picture });
  },
  async handleRedirect() {
    const p = new URLSearchParams(location.search);
    if (!p.get("code") && !p.get("error")) return false;
    const saved = JSON.parse(sessionStorage.getItem("bn.pkce") || "{}"); sessionStorage.removeItem("bn.pkce");
    history.replaceState(null, "", location.pathname + (saved.back || "#/home"));
    if (p.get("error")) { toast(p.get("error_description") || "Sign-in was cancelled.", true); return true; }
    if (p.get("state") !== saved.state) { toast("Sign-in expired. Please try again.", true); return true; }
    this.save(await this.token({ grant_type: "authorization_code", code: p.get("code"), redirect_uri: redirectUri(), code_verifier: saved.verifier }));
    return true;
  },
  async idToken() {
    const s = this.session; if (!s) return null;
    if (Date.now() < s.expires) return s.idToken;
    try { this.save(await this.token({ grant_type: "refresh_token", refresh_token: s.refreshToken })); return this.session.idToken; }
    catch { this.clear(); return null; }
  },
  clear() { store.del("bn.session"); },
  logout() {
    this.clear(); ME = null;
    if (DEMO || !CFG.authDomain) { location.hash = "#/"; return; }
    location.href = `${CFG.authDomain}/logout?${new URLSearchParams({ client_id: CFG.userPoolClientId, logout_uri: redirectUri() })}`;
  },
  get signedIn() { return DEMO || !!this.session; },
};

async function api(method, path, body) {
  if (DEMO) return demoApi(method, path, body);
  const token = await auth.idToken();
  if (!token) { location.hash = "#/"; throw new Error("Please sign in."); }
  const r = await fetch(CFG.apiUrl.replace(/\/$/, "") + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) { auth.clear(); location.hash = "#/"; }
  if (!r.ok) { const e = new Error(d.error || `Request failed (${r.status})`); e.code = d.code; throw e; }
  if (typeof d.credits === "number" && ME) { ME.credits = d.credits; renderNav(); }
  return d;
}

let ME = null;
async function loadMe() { ME = await api("GET", "/me"); renderNav(); return ME; }
const ICON = {
  home: '<path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  create: '<path d="M12 3l2.2 5.6L20 9.5l-4.4 3.9L17 19l-5-3-5 3 1.4-5.6L4 9.5l5.8-.9z"/>',
  characters: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
  projects: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  manga: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h9M12 3v18M12 15h9"/>',
  library: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  credits: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 9.5c0-1.2 1.3-2 3-2s3 .8 3 2-1.3 1.8-3 2.3-3 1-3 2.2 1.3 2 3 2 3-.8 3-2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  admin: '<path d="M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  story: '<path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5M8 7h6M8 11h6"/>',
  explore: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
};
const icon = (k) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
const PORTAL = [["Studio", [["home", "Home"], ["create", "Create"], ["characters", "Characters"], ["story", "Story"], ["projects", "Projects"], ["manga", "Manga"], ["library", "Library"], ["explore", "Explore"]]],
  ["Account", [["credits", "Credits"], ["settings", "Settings"]]]];
const $side = document.getElementById("side");
function renderNav() {
  const h = location.hash;
  if (!auth.signedIn) {
    document.body.classList.remove("portal"); $side.innerHTML = "";
    $nav.innerHTML = `<a href="#/explore" class="${h.startsWith("#/explore") ? "on" : ""}">Explore</a><a href="#/pricing" class="${h.startsWith("#/pricing") ? "on" : ""}">Pricing</a><a href="#/help" class="${h.startsWith("#/help") ? "on" : ""}">Help</a><a href="#auth" data-go="auth">Sign in</a>`;
    bindScrollLinks($nav); return;
  }
  const portal = document.body.classList.contains("portal");
  const on = (k) => h.startsWith(`#/${k}`) || (k === "library" && h.startsWith("#/gallery"));
  $nav.innerHTML = `${DEMO ? '<span class="pill">Demo</span>' : ""}
    ${portal ? "" : '<a href="#/home">Open studio</a>'}
    <a class="pill credit" href="#/credits" title="Credits">✦ <b>${ME?.credits ?? "–"}</b></a>
    ${DEMO ? "" : `<div class="menu"><button class="bell" id="bell" aria-label="Notifications${ME?.unread ? `, ${ME.unread} unread` : ""}" aria-haspopup="true">${icon("bell")}${ME?.unread ? `<i class="dot">${ME.unread > 9 ? "9+" : ME.unread}</i>` : ""}</button><div class="menu-pop notif-pop" id="bell-pop" hidden></div></div>`}
    ${portal ? '<a class="btn small" href="#/create">+ New</a>' : ""}
    <div class="menu"><button class="avatar" title="${esc(ME?.email || "Account")}" id="acct" aria-haspopup="true" aria-expanded="false">${esc((ME?.name || "?")[0].toUpperCase())}</button>
      <div class="menu-pop" id="acct-pop" hidden><div class="small muted" style="padding:8px 12px 4px">${esc(ME?.email || "")}</div>
        <a href="#/settings">Settings</a><a href="#/credits">Credits</a>${ME?.isAdmin ? '<a href="#/admin">Admin</a>' : ""}<a href="#/help">Help</a><button id="acct-out">Sign out</button></div></div>`;
  const pop = document.getElementById("acct-pop"), btn = document.getElementById("acct");
  btn.onclick = (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; btn.setAttribute("aria-expanded", String(!pop.hidden)); };
  document.getElementById("acct-out").onclick = () => auth.logout();
  document.getElementById("bell")?.addEventListener("click", (e) => { e.stopPropagation(); openBell(); });
  document.addEventListener("click", () => { pop.hidden = true; btn.setAttribute("aria-expanded", "false"); }, { once: true });
  $side.innerHTML = PORTAL.map(([g, list]) => `<div class="side-group"><div class="side-h">${g}</div>${list.map(([k, l]) =>
    `<a href="#/${k}" class="${on(k) ? "on" : ""}" data-k="${k}">${icon(k)}<span>${l}</span></a>`).join("")}</div>`).join("")
    + (ME?.isAdmin ? `<div class="side-group"><div class="side-h">Owner</div><a href="#/admin" class="${on("admin") ? "on" : ""}" data-k="admin">${icon("admin")}<span>Admin</span></a></div>` : "")
    + `<div class="side-foot small muted"><a href="#/help">Help</a> · <a href="#/legal/terms">Terms</a> · <a href="#/legal/privacy">Privacy</a></div>`;
}

// ------------------------------------------------------------------ shared data
const STYLES = [["shonen", "Shonen action", "少年"], ["slice", "Slice of life", "日常"], ["retro90", "90s cel", "九十"], ["cyber", "Cyberpunk", "電脳"],
  ["chibi", "Chibi", "ちび"], ["manga", "Manga ink", "漫画"], ["mecha", "Mecha", "機械"], ["fantasy", "Dark fantasy", "幻想"]];
const ART = (CFG.artBase || "/art/");
const styleArt = (k) => `${ART}style-${k}.webp`;
const ASPECTS = [["1:1", "Square"], ["2:3", "Portrait"], ["9:16", "Story"], ["16:9", "Wide"], ["3:2", "Landscape"], ["21:9", "Cinema"]];
const cost = (k) => ME?.costs?.[k] ?? 1;

// ------------------------------------------------------------------ landing
let heroCleanup = null;
const STEPS = [
  ["Describe it, or draw it", "Type a scene, scribble on the sketch pad, or upload a photo. Prompt help rewrites a rough idea into a detailed one for free."],
  ["Pick a look", "Eight anime styles, from 90s cel to dark fantasy. Switch styles on the same idea as often as you like."],
  ["Keep your character", "Save a character once. New scenes keep their face, hair and outfit, so a whole story looks like one series."],
  ["Make it move", "Turn any frame into a five-second clip, or lay frames out as a manga page with speech bubbles."],
];
const TOOLS = [
  ["Manga pages", "Four-panel, grid and splash layouts with speech bubbles. Export the finished page as a PNG."],
  ["Clean cutouts", "Remove the background from any frame for stickers, thumbnails and overlays."],
  ["Print-size upscale", "Enlarge a frame four times for posters and prints."],
  ["Private by default", "Your gallery and characters are visible only to you."],
  ["Safe to share", "Content filters block explicit images, real-person deepfakes and hate."],
  ["Credits back on failure", "Images start at 1 credit. If a generation fails, the credits come straight back."],
];
const googleSvg = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>`;

function landing() {
  document.body.classList.add("is-landing");
  $app.innerHTML = `
  <section class="hero" aria-labelledby="hero-title">
    <div class="stage">
      <div class="layer paint" aria-hidden="true"></div>
      <h1 class="title" id="hero-title"><span>Banime</span></h1>
      <div class="layer paint cut" aria-hidden="true"></div>
    </div>
    <div class="hero-copy">
      <p class="lead">Turn ideas, sketches and photos into anime art. Keep your characters on-model, lay out manga pages and animate any frame.</p>
      <div class="row cta-row">
        <a href="#auth" class="btn big" data-go="auth">Start with 30 free credits</a>
        <a href="?demo#/create" class="btn glass big">Try the demo</a>
      </div>
    </div>
  </section>

  <section class="looks" aria-labelledby="looks-h">
    <div class="looks-head">
      <h2 id="looks-h">One character. Eight looks.</h2>
      <p>Every frame below shows the same character, made in Banime. Pick a look and start from it.</p>
    </div>
    <div class="strip">${STYLES.map(([k, n, jp]) => `<a class="look" href="#/create" data-style="${k}"><img src="${styleArt(k)}" alt="The Banime character in ${n} style" loading="lazy" width="416" height="624"/><span class="cap"><b>${n}</b><i lang="ja">${jp}</i></span></a>`).join("")}</div>
  </section>

  <section class="steps" aria-labelledby="steps-h">
    <h2 id="steps-h">From idea to scene in four steps</h2>
    <ol>${STEPS.map(([t, d]) => `<li><h3>${t}</h3><p>${d}</p></li>`).join("")}</ol>
  </section>

  <section class="tools" aria-labelledby="tools-h">
    <h2 id="tools-h">Also in the studio</h2>
    <dl>${TOOLS.map(([t, d]) => `<div><dt>${t}</dt><dd>${d}</dd></div>`).join("")}</dl>
  </section>

  <section class="join" id="auth" aria-labelledby="join-h">
    <img class="join-art" src="${styleArt("chibi")}" alt="" loading="lazy" width="416" height="624"/>
    <div class="join-copy">
      <h2 id="join-h">Your first 30 frames are free</h2>
      <p>Sign in and get 30 credits. No card needed.</p>
      <div class="authcard">
        ${CFG.google ? `<button class="btn google big" id="g-login">${googleSvg}Continue with Google</button>` : ""}
        <button class="btn ${CFG.google ? "ghost" : ""} big" id="e-login">Continue with email</button>
        <p class="small">By continuing you agree to make original, non-explicit work.</p>
      </div>
    </div>
  </section>`;
  document.getElementById("g-login")?.addEventListener("click", () => auth.login("Google"));
  document.getElementById("e-login").onclick = () => auth.login("COGNITO");
  $app.querySelectorAll(".look").forEach((a) => a.addEventListener("click", () => { S.style = a.dataset.style; }));
  bindScrollLinks($app);
  heroCleanup?.(); heroCleanup = mountHero($app.querySelector(".hero"));
}

// Hero depth: the title sits between the painting and the masked character.
// It drifts with the pointer and settles slower than the page on scroll.
function mountHero(hero) {
  const title = hero.querySelector(".title span");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  hero.classList.add("ready");
  if (reduce) return () => {};
  let px = 0, py = 0, tx = 0, ty = 0, raf = 0, sy = 0;
  const loop = () => {
    tx += (px - tx) * 0.08; ty += (py - ty) * 0.08;
    title.style.setProperty("--dx", `${tx * 14}px`);
    title.style.setProperty("--dy", `${ty * 8 + sy * 0.35}px`);
    raf = requestAnimationFrame(loop);
  };
  const move = (e) => { px = e.clientX / innerWidth - 0.5; py = e.clientY / innerHeight - 0.5; };
  const scr = () => { sy = Math.min(scrollY, innerHeight); };
  addEventListener("pointermove", move, { passive: true });
  addEventListener("scroll", scr, { passive: true });
  raf = requestAnimationFrame(loop);
  return () => { cancelAnimationFrame(raf); removeEventListener("pointermove", move); removeEventListener("scroll", scr); };
}
function bindScrollLinks(root) {
  root.querySelectorAll("[data-go]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    if (!document.body.classList.contains("is-landing")) { location.hash = "#/"; setTimeout(() => document.getElementById(a.dataset.go)?.scrollIntoView({ behavior: "smooth" }), 300); }
    else document.getElementById(a.dataset.go)?.scrollIntoView({ behavior: "smooth" });
  }));
}
addEventListener("scroll", () => document.body.classList.toggle("scrolled", scrollY > 40), { passive: true });

// ------------------------------------------------------------------ helpers for images
async function fileToB64(file, maxSide = 1280) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("That file isn't an image.")); i.src = url; });
    const s = Math.min(1, maxSide / Math.max(img.width, img.height));
    const c = document.createElement("canvas"); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.9);
  } finally { URL.revokeObjectURL(url); }
}
async function urlToB64(url, maxSide = 1280) {
  const blob = await (await fetch(url)).blob();
  return fileToB64(new File([blob], "x", { type: blob.type }), maxSide);
}
function tileHtml(it) {
  if (it.kind === "video" && it.status === "rendering") return `<div class="tile-img pending" data-id="${it.id}" style="background-image:none"><span class="small">Animating… <span class="spinner"></span></span></div>`;
  const media = it.kind === "video" ? (it.url ? `<video src="${esc(it.url)}" muted loop playsinline autoplay></video>` : `<img src="${esc(it.posterUrl)}" alt=""/>`) : `<img loading="lazy" src="${esc(it.url)}" alt="${esc(it.prompt || "")}"/>`;
  const tag = it.kind === "video" ? (it.status === "failed" ? "failed" : "▶ clip") : (it.mode || "image");
  return `<div class="tile-img" data-id="${it.id}" tabindex="0" role="button" aria-label="${esc(it.title || it.prompt || "Creation")}">${media}<span class="tag">${esc(tag)}</span>${it.favorite ? '<span class="heart" aria-label="Favorite">♥</span>' : ""}${it.shareId ? '<span class="tag" style="left:auto;right:8px;top:auto;bottom:8px">🔗 shared</span>' : ""}</div>`;
}

// ------------------------------------------------------------------ create studio
const S = { mode: "text", style: "shonen", aspect: "1:1", model: "core", strength: 0.7, characterId: null, photo: null, prompt: "", projectId: null, autogen: false };
let PAD = null;

async function create() {
  const [{ characters }, { items }, projects] = await Promise.all([api("GET", "/characters"), api("GET", "/gallery"), projectsList()]);
  if (S.projectId && !projects.some((p) => p.id === S.projectId)) S.projectId = null;
  if (!S.characterId && characters[0]) S.characterId = characters[0].id;
  $app.innerHTML = `<div class="studio">
    <aside class="card composer">
      <div class="tabs" role="tablist">${[["text", "Text"], ["character", "Character"], ["sketch", "Sketch"], ["photo", "Photo"]].map(([k, l]) => `<button data-mode="${k}" class="${S.mode === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <div id="modebox"></div>
      <label>Prompt</label>
      <div class="prompt-wrap"><textarea id="prompt" rows="4" placeholder="A swordswoman on a rooftop at dusk, wind in her hair, city lights below">${esc(S.prompt)}</textarea>
        <button class="btn ghost small" id="enh" title="Let Amazon Nova improve your prompt">✨ Enhance</button></div>
      <label>Style</label><div class="chips" id="styles">${STYLES.map(([k, n]) => `<button data-style="${k}" class="${S.style === k ? "on" : ""}" style="background-image:url('${styleArt(k)}')" aria-pressed="${S.style === k}"><span>${n}</span></button>`).join("")}</div>
      <div id="aspectbox"><label>Shape</label><div class="chips" id="aspects">${ASPECTS.map(([k, n]) => `<button data-aspect="${k}" class="${S.aspect === k ? "on" : ""}">${n} <span class="muted">${k}</span></button>`).join("")}</div></div>
      <div id="modelbox"><label>Model</label><div class="chips" id="models">${[["core", `Fast · ${1}✦`], ["sd35", `Detailed · ${1}✦`], ["ultra", `Ultra · ${2}✦`]].map(([k, n]) => `<button data-model="${k}" class="${S.model === k ? "on" : ""}">${n}</button>`).join("")}</div></div>
      <label>Save to project</label><select id="cproj"><option value="">No project</option>${projects.map((p) => `<option value="${p.id}" ${S.projectId === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
      <button class="btn big gen" id="gen">Generate</button>
      <p class="small muted" id="costline" style="text-align:center;margin:8px 0 0"></p>
    </aside>
    <section><div class="row spread"><h2>Your latest</h2><a href="#/library" class="small">Open library →</a></div>
      <div class="results" id="results">${items.length ? items.slice(0, 24).map(tileHtml).join("") : '<div class="empty" style="grid-column:1/-1">Your creations will appear here. Try a prompt on the left.</div>'}</div></section>
  </div>`;
  const drawMode = () => {
    const box = document.getElementById("modebox");
    document.getElementById("modelbox").style.display = S.mode === "text" ? "" : "none";
    document.getElementById("aspectbox").style.display = S.mode === "text" || S.mode === "character" ? "" : "none";
    if (S.mode === "text") box.innerHTML = "";
    if (S.mode === "character") box.innerHTML = characters.length ? `<label>Character</label><div class="charpick">${characters.map((c) => `<button data-char="${c.id}" class="${S.characterId === c.id ? "on" : ""}"><img src="${esc(c.url)}" alt=""/><span>${esc(c.name)}</span></button>`).join("")}</div>
      <label>Likeness <span class="muted" id="sv">${Math.round(S.strength * 100)}%</span></label><input type="range" id="strength" min="0.3" max="0.95" step="0.05" value="${S.strength}"/>`
      : `<div class="empty" style="margin-top:12px">No characters yet. <a href="#/characters">Create one</a> and Banime will keep them on-model.</div>`;
    if (S.mode === "sketch") box.innerHTML = `<label>Draw <span class="muted">(black lines on white work best)</span></label><canvas class="pad" id="pad" width="768" height="768"></canvas>
      <div class="row" style="margin-top:6px"><button class="btn ghost small" data-tool="pen">✏️ Pen</button><button class="btn ghost small" data-tool="eraser">🩹 Eraser</button><button class="btn ghost small" id="undo">↶ Undo</button><button class="btn ghost small" id="clear">Clear</button></div>
      <label>Follow my lines <span class="muted" id="sv">${Math.round(S.strength * 100)}%</span></label><input type="range" id="strength" min="0.3" max="0.95" step="0.05" value="${S.strength}"/>`;
    if (S.mode === "photo") box.innerHTML = `<label>Photo</label><label class="drop" id="drop">${S.photo ? `<img src="${S.photo}" alt=""/>Change photo` : "Tap to upload a photo (JPEG/PNG)"}<input type="file" accept="image/*" id="file" hidden/></label>
      <label>Keep structure <span class="muted" id="sv">${Math.round(S.strength * 100)}%</span></label><input type="range" id="strength" min="0.3" max="0.95" step="0.05" value="${S.strength}"/>`;
    box.querySelectorAll("[data-char]").forEach((b) => (b.onclick = () => { S.characterId = b.dataset.char; drawMode(); }));
    const sr = document.getElementById("strength"); if (sr) sr.oninput = () => { S.strength = +sr.value; document.getElementById("sv").textContent = Math.round(S.strength * 100) + "%"; };
    document.getElementById("file")?.addEventListener("change", async (e) => { if (e.target.files[0]) { S.photo = await fileToB64(e.target.files[0]); drawMode(); } });
    if (S.mode === "sketch") PAD = makePad(document.getElementById("pad"), PAD?.snapshot());
    costLine();
  };
  const costLine = () => {
    const k = S.mode === "text" ? `text:${S.model}` : S.mode;
    document.getElementById("costline").textContent = `${cost(k)} credit${cost(k) > 1 ? "s" : ""} · you have ${ME?.credits ?? 0}`;
  };
  $app.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => { S.mode = b.dataset.mode; S.strength = S.mode === "character" ? 0.65 : 0.7; $app.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x === b)); drawMode(); }));
  const pick = (attr, key) => $app.querySelectorAll(`[data-${attr}]`).forEach((b) => (b.onclick = () => { S[key] = b.dataset[attr]; $app.querySelectorAll(`[data-${attr}]`).forEach((x) => x.classList.toggle("on", x === b)); costLine(); }));
  pick("style", "style"); pick("aspect", "aspect"); pick("model", "model");
  const $p = document.getElementById("prompt"); $p.oninput = () => (S.prompt = $p.value);
  document.getElementById("enh").onclick = (e) => busy(e.currentTarget, async () => {
    if (!$p.value.trim()) throw new Error("Type a short idea first, like “cat samurai in the rain”.");
    const r = await api("POST", "/enhance", { prompt: $p.value, style: S.style }); $p.value = S.prompt = r.prompt; toast(`✨ ${r.title}`);
  });
  document.getElementById("gen").onclick = (e) => busy(e.currentTarget, async () => {
    if (!$p.value.trim()) throw new Error("Describe what you want to see.");
    const body = { mode: S.mode, prompt: $p.value, style: S.style, aspect: S.aspect, model: S.model, strength: S.strength, projectId: S.projectId || undefined };
    if (S.mode === "character") { if (!S.characterId) throw new Error("Pick or create a character first."); body.characterId = S.characterId; }
    if (S.mode === "sketch") { if (PAD.isEmpty()) throw new Error("Draw something on the pad first."); body.imageBase64 = PAD.toB64(); }
    if (S.mode === "photo") { if (!S.photo) throw new Error("Upload a photo first."); body.imageBase64 = S.photo; }
    const res = document.getElementById("results");
    res.querySelector(".empty")?.remove();
    res.insertAdjacentHTML("afterbegin", '<div class="tile-img pending" id="ph"><span class="small">Painting… <span class="spinner"></span></span></div>');
    try { const r = await api("POST", "/generate", body); document.getElementById("ph").outerHTML = tileHtml(r.item); bindTiles(res); costLine(); }
    catch (err) { document.getElementById("ph")?.remove(); throw err; }
  });
  document.getElementById("cproj").onchange = (e) => { S.projectId = e.target.value || null; };
  drawMode(); bindTiles(document.getElementById("results")); watchPending(document.getElementById("results"));
  if (S.autogen) { S.autogen = false; document.getElementById("gen").click(); }
}

function makePad(canvas, restore) {
  const ctx = canvas.getContext("2d"); let tool = "pen", drawing = false, last = null; const hist = [];
  const reset = () => { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); };
  reset(); if (restore) ctx.putImageData(restore, 0, 0);
  let dirty = !!restore;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height]; };
  canvas.onpointerdown = (e) => { canvas.setPointerCapture(e.pointerId); hist.push(ctx.getImageData(0, 0, canvas.width, canvas.height)); if (hist.length > 30) hist.shift(); drawing = true; last = pos(e); dirty = true; };
  canvas.onpointermove = (e) => {
    if (!drawing) return; const p = pos(e);
    ctx.strokeStyle = tool === "pen" ? "#111" : "#fff"; ctx.lineWidth = tool === "pen" ? 5 : 34; ctx.lineCap = ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(...p); ctx.stroke(); last = p;
  };
  canvas.onpointerup = canvas.onpointercancel = () => { drawing = false; };
  document.querySelectorAll("[data-tool]").forEach((b) => (b.onclick = () => { tool = b.dataset.tool; }));
  document.getElementById("undo").onclick = () => { const h = hist.pop(); if (h) ctx.putImageData(h, 0, 0); };
  document.getElementById("clear").onclick = () => { hist.push(ctx.getImageData(0, 0, canvas.width, canvas.height)); reset(); dirty = false; };
  return { toB64: () => canvas.toDataURL("image/png"), isEmpty: () => !dirty, snapshot: () => ctx.getImageData(0, 0, canvas.width, canvas.height) };
}

// ------------------------------------------------------------------ gallery + item modal
let GALLERY = [];
let PROJECTS = null;
async function projectsList(force) { if (!PROJECTS || force) PROJECTS = (await api("GET", "/projects")).projects; return PROJECTS; }
const LIB = { kind: "all", fav: false, project: "", style: "", q: "" };
async function library() {
  const [{ items }, projects] = await Promise.all([api("GET", "/gallery"), projectsList(true)]); GALLERY = items;
  const pname = Object.fromEntries(projects.map((p) => [p.id, p.name]));
  $app.innerHTML = `<div class="page-head"><div><h2>Library</h2><p class="muted small">${items.length} creation${items.length === 1 ? "" : "s"} · private to you unless you share a link</p></div>
    <a class="btn" href="#/create">+ New frame</a></div>
    <div class="filters card">
      <div class="seg" role="tablist">${[["all", "All"], ["image", "Images"], ["video", "Clips"]].map(([k, l]) => `<button data-kind="${k}" class="${LIB.kind === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <button class="btn ghost small ${LIB.fav ? "is-on" : ""}" id="fav" aria-pressed="${LIB.fav}">♥ Favorites</button>
      <select id="fp" aria-label="Project"><option value="">All projects</option><option value="none" ${LIB.project === "none" ? "selected" : ""}>Not in a project</option>${projects.map((p) => `<option value="${p.id}" ${LIB.project === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
      <select id="fs" aria-label="Style"><option value="">All styles</option>${STYLES.map(([k, n]) => `<option value="${k}" ${LIB.style === k ? "selected" : ""}>${n}</option>`).join("")}</select>
      <input id="fq" type="search" placeholder="Search prompts and titles" value="${esc(LIB.q)}"/>
    </div>
    <div class="results" id="results"></div>`;
  const draw = () => {
    const q = LIB.q.trim().toLowerCase();
    const list = items.filter((i) => (LIB.kind === "all" || i.kind === LIB.kind) && (!LIB.fav || i.favorite) && (!LIB.style || i.style === LIB.style)
      && (!LIB.project || (LIB.project === "none" ? !i.projectId : i.projectId === LIB.project))
      && (!q || `${i.prompt || ""} ${i.title || ""} ${pname[i.projectId] || ""}`.toLowerCase().includes(q)));
    const res = document.getElementById("results");
    res.innerHTML = list.length ? list.map(tileHtml).join("") : `<div class="empty" style="grid-column:1/-1">${items.length ? "Nothing matches these filters." : 'Nothing here yet. <a href="#/create">Create your first frame</a>.'}</div>`;
    bindTiles(res); watchPending(res);
  };
  $app.querySelectorAll("[data-kind]").forEach((b) => (b.onclick = () => { LIB.kind = b.dataset.kind; $app.querySelectorAll("[data-kind]").forEach((x) => x.classList.toggle("on", x === b)); draw(); }));
  document.getElementById("fav").onclick = (e) => { LIB.fav = !LIB.fav; e.currentTarget.classList.toggle("is-on", LIB.fav); e.currentTarget.setAttribute("aria-pressed", LIB.fav); draw(); };
  document.getElementById("fp").onchange = (e) => { LIB.project = e.target.value; draw(); };
  document.getElementById("fs").onchange = (e) => { LIB.style = e.target.value; draw(); };
  document.getElementById("fq").oninput = (e) => { LIB.q = e.target.value; draw(); };
  draw();
}
function bindTiles(root) {
  root.querySelectorAll(".tile-img[data-id]").forEach((t) => { t.onclick = () => openItem(t.dataset.id); t.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openItem(t.dataset.id); } }; });
}
let pendTimer = null;
function watchPending(root) {
  clearInterval(pendTimer);
  pendTimer = setInterval(async () => {
    const pend = [...root.querySelectorAll(".tile-img.pending[data-id]")];
    if (!root.isConnected || !pend.length) return clearInterval(pendTimer);
    for (const el of pend) {
      const { item } = await api("GET", `/gallery/${el.dataset.id}`).catch(() => ({}));
      if (item && item.status !== "rendering") { el.outerHTML = tileHtml(item); bindTiles(root); toast(item.status === "ready" ? "Your clip is ready ▶" : "Animation failed. Credits refunded.", item.status !== "ready"); }
    }
  }, 12000);
}
const shareUrl = (sid) => `${location.origin}/#/s/${sid}`;
async function copyText(t) { try { await navigator.clipboard.writeText(t); toast("Link copied."); } catch { prompt("Copy this link:", t); } }
async function openItem(id) {
  const [{ item: it }, projects] = await Promise.all([api("GET", `/gallery/${id}`), projectsList()]);
  const ov = document.createElement("div"); ov.className = "modal";
  const isImg = it.kind === "image";
  ov.innerHTML = `<div class="panel" role="dialog" aria-modal="true" aria-label="Creation">
    <div class="media">${isImg ? `<img src="${esc(it.url)}" alt=""/>` : it.url ? `<video src="${esc(it.url)}" controls autoplay loop playsinline></video>` : `<img src="${esc(it.posterUrl)}" alt=""/><p class="notice">${it.status === "failed" ? "Animation failed: " + esc(it.error || "") : "Still animating…"}</p>`}</div>
    <div>
      <div class="row spread"><span class="kicker">${esc(it.kind === "video" ? "clip" : it.mode || "image")} · ${esc(it.style || "")}</span>
        <div class="row"><button class="btn ghost small fav ${it.favorite ? "is-on" : ""}" data-act="fav" aria-pressed="${!!it.favorite}" title="Favorite">♥</button><button class="btn ghost small" id="x">Close ✕</button></div></div>
      <input id="ttl" class="title-input" maxlength="60" placeholder="Untitled" value="${esc(it.title || "")}" aria-label="Title"/>
      <p style="margin:10px 0">${esc(it.prompt || "No prompt")}</p>
      <p class="small muted">${new Date(it.created * 1000).toLocaleString()} · AI-generated</p>
      <label>Project</label><select id="proj"><option value="">Not in a project</option>${projects.map((p) => `<option value="${p.id}" ${it.projectId === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
      <div class="card share-box"><div class="row spread"><b>Public link</b><label class="switch"><input type="checkbox" id="shr" ${it.shareId ? "checked" : ""} ${!isImg && it.status !== "ready" ? "disabled" : ""}/><span></span></label></div>
        <div id="shl" class="small">${it.shareId ? `<div class="row" style="margin-top:8px"><input readonly value="${esc(shareUrl(it.shareId))}"/><button class="btn ghost small" data-act="copy">Copy</button></div>` : '<p class="muted" style="margin:6px 0 0">Off. Turn on to get a link anyone can open.</p>'}</div>
        <div class="row spread" style="margin-top:12px;border-top:1px solid var(--line);padding-top:12px;flex-wrap:nowrap"><div style="flex:1"><b>Show on Explore</b><p class="small muted" style="margin:2px 0 0">Anyone browsing Banime can see it, with your display name.</p></div><label class="switch"><input type="checkbox" id="exp" ${it.feedSk ? "checked" : ""} ${(!isImg && it.status !== "ready") || it.hidden ? "disabled" : ""}/><span></span></label></div>
        ${it.hidden ? '<p class="small" style="color:var(--red);margin:8px 0 0">A moderator removed this from Explore.</p>' : ""}</div>
      <div class="grid actions" style="margin-top:14px">
        ${it.url ? `<a class="btn ghost" href="${esc(it.url)}" download target="_blank" rel="noopener">⬇ Download</a>` : ""}
        ${isImg ? `<button class="btn ghost" data-act="removebg">✂️ Remove background · ${cost("removebg")}✦</button>
        <button class="btn ghost" data-act="upscale">🔍 Upscale 4× · ${cost("upscale")}✦</button>
        <button class="btn ghost" data-act="sketch">✏️ Use as sketch</button><button class="btn ghost" data-act="photo">🖼 Use as photo input</button>
        <div class="card" style="padding:14px"><label style="margin-top:0">Animate <span class="muted">(${cost("animate")}✦ · 5 s)</span></label>
          <input id="motion" placeholder="hair and scarf blowing in the wind, petals drifting, slow push in"/>
          <button class="btn" data-act="animate" style="width:100%;margin-top:8px" ${ME?.canAnimate ? "" : "disabled"}>▶ Animate</button>
          ${ME?.canAnimate ? "" : '<p class="small muted" style="margin:8px 0 0">Animation is in early access for studio admins.</p>'}</div>` : ""}
        <button class="btn danger" data-act="delete">Delete</button>
      </div>
    </div></div>`;
  document.body.appendChild(ov);
  let dirty = false;
  const close = () => { ov.remove(); removeEventListener("keydown", esc_); if (dirty) route(); };
  const esc_ = (e) => { if (e.key === "Escape") close(); };
  addEventListener("keydown", esc_);
  ov.onclick = (e) => { if (e.target === ov) close(); };
  ov.querySelector("#x").onclick = close;
  const patch = async (body) => { const r = await api("PATCH", `/gallery/${it.id}`, body); Object.assign(it, r.item); dirty = true; };
  ov.querySelector("#ttl").onchange = (e) => patch({ title: e.target.value }).then(() => toast("Title saved.")).catch((er) => toast(er.message, true));
  ov.querySelector("#proj").onchange = (e) => patch({ projectId: e.target.value || null }).then(() => toast(e.target.value ? "Moved to project." : "Removed from project.")).catch((er) => toast(er.message, true));
  ov.querySelector("#shr").onchange = async (e) => {
    try { const r = await api("POST", `/gallery/${it.id}/share`, { on: e.target.checked }); Object.assign(it, r.item); dirty = true;
      ov.querySelector("#shl").innerHTML = it.shareId ? `<div class="row" style="margin-top:8px"><input readonly value="${esc(shareUrl(it.shareId))}"/><button class="btn ghost small" data-act="copy">Copy</button></div>` : '<p class="muted" style="margin:6px 0 0">Link turned off. Anyone who had it now sees "not found".</p>';
      ov.querySelector("[data-act=copy]")?.addEventListener("click", () => copyText(shareUrl(it.shareId)));
      if (it.shareId) copyText(shareUrl(it.shareId)); else ov.querySelector("#exp").checked = false;
    } catch (er) { e.target.checked = !e.target.checked; toast(er.message, true); }
  };
  ov.querySelector("[data-act=copy]")?.addEventListener("click", () => copyText(shareUrl(it.shareId)));
  ov.querySelector("#exp").onchange = async (e) => {
    try { const r = await api("POST", `/gallery/${it.id}/explore`, { on: e.target.checked }); Object.assign(it, r.item); dirty = true;
      ov.querySelector("#shr").checked = !!it.shareId;
      if (it.shareId && !ov.querySelector("#shl input")) ov.querySelector("#shl").innerHTML = `<div class="row" style="margin-top:8px"><input readonly value="${esc(shareUrl(it.shareId))}"/><button class="btn ghost small" data-act="copy">Copy</button></div>`;
      toast(e.target.checked ? "Posted to Explore." : "Taken off Explore.");
    } catch (er) { e.target.checked = !e.target.checked; toast(er.message, true); }
  };
  ov.querySelectorAll("[data-act]:not([data-act=copy])").forEach((b) => (b.onclick = () => busy(b, async () => {
    const act = b.dataset.act;
    if (act === "fav") { await patch({ favorite: !it.favorite }); b.classList.toggle("is-on", !!it.favorite); b.setAttribute("aria-pressed", String(!!it.favorite)); }
    if (act === "removebg" || act === "upscale") { await api("POST", `/tools/${act}`, { itemId: it.id }); toast(act === "removebg" ? "Background removed. Saved to library." : "Upscaled. Saved to library."); dirty = true; close(); }
    if (act === "animate") { await api("POST", "/animate", { itemId: it.id, prompt: ov.querySelector("#motion").value }); toast("Animating. This takes 1 to 3 minutes."); dirty = false; close(); location.hash = "#/library"; }
    if (act === "sketch" || act === "photo") { const b64 = await urlToB64(it.url); S.mode = act; if (act === "photo") S.photo = b64; else PAD = null; dirty = false; close(); location.hash = "#/create"; if (act === "sketch") setTimeout(() => loadIntoPad(b64), 400); }
    if (act === "delete") { if (!confirm("Delete this creation? Its public link stops working too.")) return; await api("DELETE", `/gallery/${it.id}`); dirty = true; close(); }
  })));
}
function loadIntoPad(b64) {
  const c = document.getElementById("pad"); if (!c) return; const img = new Image();
  img.onload = () => { const ctx = c.getContext("2d"); const s = Math.min(c.width / img.width, c.height / img.height);
    ctx.drawImage(img, (c.width - img.width * s) / 2, (c.height - img.height * s) / 2, img.width * s, img.height * s); PAD = makePad(c, ctx.getImageData(0, 0, c.width, c.height)); };
  img.src = b64;
}

// ------------------------------------------------------------------ characters
async function characters() {
  const { characters: list } = await api("GET", "/characters");
  $app.innerHTML = `<div class="row spread"><h2>Characters</h2><span class="muted small">Characters stay on-model in every scene</span></div>
  <div class="grid" style="grid-template-columns:minmax(280px,380px) 1fr;align-items:start" id="cwrap">
    <div class="card"><h3>New character</h3>
      <label>Name</label><input id="cn" maxlength="40" placeholder="Aiko"/>
      <label>Look <span class="muted">(hair, eyes, outfit, colors, accessories)</span></label><textarea id="cl" rows="4" placeholder="Short silver bob, amber eyes, red scarf, navy school blazer, small star hairclip"></textarea>
      <label>Style</label><select id="cs">${STYLES.map(([k, n]) => `<option value="${k}">${n}</option>`).join("")}</select>
      <label>Reference image <span class="muted">(optional: your own art)</span></label><label class="drop" id="cdrop">Upload reference, or leave empty and Banime draws one (${cost("character:create")}✦)<input type="file" accept="image/*" id="cf" hidden/></label>
      <button class="btn big gen" id="cmake">Create character</button></div>
    <div class="chars">${list.length ? list.map((c) => `<div class="card charcard"><img src="${esc(c.url)}" alt="${esc(c.name)}"/><div class="meta"><b>${esc(c.name)}</b><p class="small muted" style="margin:4px 0 10px">${esc(c.look)}</p>
      <div class="row"><button class="btn small" data-use="${c.id}">Use</button><button class="btn danger small" data-del="${c.id}">Delete</button></div></div></div>`).join("") : '<div class="empty">No characters yet. Describe one and Banime will draw a reference sheet.</div>'}</div>
  </div>`;
  if (innerWidth < 960) document.getElementById("cwrap").style.gridTemplateColumns = "1fr";
  let ref = null;
  document.getElementById("cf").onchange = async (e) => { if (e.target.files[0]) { ref = await fileToB64(e.target.files[0], 1024); document.getElementById("cdrop").innerHTML = `<img src="${ref}" alt=""/>Reference added`; } };
  document.getElementById("cmake").onclick = (e) => busy(e.currentTarget, async () => {
    const r = await api("POST", "/characters", { name: document.getElementById("cn").value, look: document.getElementById("cl").value, style: document.getElementById("cs").value, imageBase64: ref || undefined });
    S.characterId = r.character.id; toast(`${r.character.name} is ready.`); characters();
  });
  $app.querySelectorAll("[data-use]").forEach((b) => (b.onclick = () => { S.mode = "character"; S.characterId = b.dataset.use; location.hash = "#/create"; }));
  $app.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => busy(b, async () => { if (!confirm("Delete this character?")) return; await api("DELETE", `/characters/${b.dataset.del}`); characters(); })));
}

// ------------------------------------------------------------------ manga page composer
const LAYOUTS = {
  yonkoma: { name: "4-koma strip", w: 900, h: 2400, panels: [[40, 140, 820, 540], [40, 700, 820, 540], [40, 1260, 820, 540], [40, 1820, 820, 540]] },
  grid: { name: "2 × 2 grid", w: 1200, h: 1700, panels: [[40, 140, 550, 740], [610, 140, 550, 740], [40, 900, 550, 760], [610, 900, 550, 760]] },
  hero: { name: "Splash + 2", w: 1200, h: 1700, panels: [[40, 140, 1120, 860], [40, 1020, 550, 640], [610, 1020, 550, 640]] },
};
const blankPage = (projectId = null) => ({ id: null, layout: "grid", title: "", projectId, panels: [] });
let MG = blankPage();
async function manga() {
  const want = new URLSearchParams(location.hash.split("?")[1] || "");
  const [{ items }, { pages }, projects] = await Promise.all([api("GET", "/gallery"), api("GET", "/pages"), projectsList()]);
  const imgs = items.filter((i) => i.kind === "image");
  if (want.get("page") && MG.id !== want.get("page")) { const g = pages.find((p) => p.id === want.get("page")); if (g) MG = JSON.parse(JSON.stringify(g)); }
  if (want.has("new")) { MG = blankPage(want.get("project") || null); history.replaceState(null, "", "#/manga"); }
  const L = LAYOUTS[MG.layout];
  while (MG.panels.length < L.panels.length) MG.panels.push({ itemId: null, url: null, text: "" });
  $app.innerHTML = `<div class="page-head"><div><h2>Manga page</h2><p class="muted small">Free. Pages save to your account; the PNG is drawn in your browser.</p></div>
    <div class="row"><button class="btn ghost" id="mnew">New page</button><button class="btn" id="msave">${MG.id ? "Save" : "Save page"}</button></div></div>
  <div class="manga3">
    <aside class="card pages-list"><h3>Your pages</h3>${pages.length ? pages.map((g) => `<button class="pg ${g.id === MG.id ? "on" : ""}" data-open="${g.id}"><b>${esc(g.title || "Untitled page")}</b><span class="small muted">${LAYOUTS[g.layout]?.name || ""}${g.projectId && projects.find((p) => p.id === g.projectId) ? " · " + esc(projects.find((p) => p.id === g.projectId).name) : ""}</span></button>`).join("") : '<p class="small muted">No saved pages yet.</p>'}</aside>
    <div class="card">
      <label style="margin-top:0">Layout</label><div class="chips">${Object.entries(LAYOUTS).map(([k, l]) => `<button data-lay="${k}" class="${MG.layout === k ? "on" : ""}">${l.name}</button>`).join("")}</div>
      <label>Page title</label><input id="mt" maxlength="80" value="${esc(MG.title)}" placeholder="Chapter 1: The Rooftop"/>
      <label>Project</label><select id="mp"><option value="">Not in a project</option>${projects.map((p) => `<option value="${p.id}" ${MG.projectId === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
      <label>Panels</label>${L.panels.map((_, i) => `<div class="slot"><div class="thumb" data-slot="${i}" style="${MG.panels[i].url ? `background-image:url('${esc(MG.panels[i].url)}')` : ""}">${MG.panels[i].url ? "" : "+ pick"}</div><input data-text="${i}" maxlength="200" value="${esc(MG.panels[i].text)}" placeholder="Speech bubble (optional)"/></div>`).join("")}
      <button class="btn big gen" id="mdl">⬇ Download page (PNG)</button>
      ${MG.id ? '<button class="btn danger" id="mdel" style="width:100%;margin-top:8px">Delete page</button>' : ""}
      ${imgs.length ? "" : '<p class="small muted">Create some frames first. They will show up here.</p>'}
    </div><div><canvas id="page" width="${L.w}" height="${L.h}"></canvas></div></div>`;
  $app.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => { MG = JSON.parse(JSON.stringify(pages.find((p) => p.id === b.dataset.open))); manga(); }));
  document.getElementById("mnew").onclick = () => { MG = blankPage(); manga(); };
  $app.querySelectorAll("[data-lay]").forEach((b) => (b.onclick = () => { MG.layout = b.dataset.lay; manga(); }));
  document.getElementById("mt").oninput = (e) => { MG.title = e.target.value; paint(); };
  document.getElementById("mp").onchange = (e) => { MG.projectId = e.target.value || null; };
  $app.querySelectorAll("[data-text]").forEach((i) => (i.oninput = () => { MG.panels[+i.dataset.text].text = i.value; paint(); }));
  $app.querySelectorAll("[data-slot]").forEach((el) => (el.onclick = () => pickFrame(imgs, (it) => { MG.panels[+el.dataset.slot] = { ...MG.panels[+el.dataset.slot], itemId: it.id, url: it.url }; manga(); })));
  document.getElementById("msave").onclick = (e) => busy(e.currentTarget, async () => {
    const body = { layout: MG.layout, title: MG.title, projectId: MG.projectId, panels: MG.panels.slice(0, L.panels.length).map((p) => ({ itemId: p.itemId, text: p.text })) };
    const r = MG.id ? await api("PUT", `/pages/${MG.id}`, body) : await api("POST", "/pages", body);
    MG = r.page; toast("Page saved."); manga();
  });
  document.getElementById("mdel")?.addEventListener("click", (e) => busy(e.currentTarget, async () => {
    if (!confirm("Delete this page? The frames stay in your library.")) return; await api("DELETE", `/pages/${MG.id}`); MG = blankPage(); manga();
  }));
  document.getElementById("mdl").onclick = () => { const c = document.getElementById("page"); try { const a = document.createElement("a"); a.download = (MG.title || "banime-page") + ".png"; a.href = c.toDataURL("image/png"); a.click(); } catch { toast("Couldn't export. Try again in a moment.", true); } };
  const cache = {};
  const load = (u) => cache[u] || (cache[u] = new Promise((res) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = () => res(null); i.src = u; }));
  async function paint() {
    const c = document.getElementById("page"); if (!c) return; const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#0c1b4d"; g.font = "64px 'Dela Gothic One', Impact, sans-serif"; g.textBaseline = "top"; g.fillText((MG.title || "BANIME").toUpperCase(), 40, 40);
    g.font = "700 26px 'Zen Kaku Gothic New', sans-serif"; g.fillStyle = "#2b7bf0"; g.textAlign = "right"; g.fillText("バニメ", c.width - 40, 56); g.textAlign = "left";
    for (const [i, [x, y, w, h]] of L.panels.entries()) {
      const p = MG.panels[i]; const img = p?.url ? await load(p.url) : null;
      g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
      if (img) { const s = Math.max(w / img.width, h / img.height); g.drawImage(img, x + (w - img.width * s) / 2, y + (h - img.height * s) / 2, img.width * s, img.height * s); }
      else { g.fillStyle = "#eef2fa"; g.fillRect(x, y, w, h); g.fillStyle = "#8a96bb"; g.font = "28px 'Zen Kaku Gothic New', sans-serif"; g.fillText(`Panel ${i + 1}`, x + 24, y + 24); }
      g.restore(); g.lineWidth = 8; g.strokeStyle = "#0c1b4d"; g.strokeRect(x, y, w, h);
      if (p?.text) bubble(g, p.text, x + 24, y + 24, Math.min(w * 0.62, 460));
    }
  }
  function bubble(g, text, x, y, maxW) {
    g.font = "700 30px 'Zen Kaku Gothic New', sans-serif"; const words = text.split(/\s+/); const lines = []; let line = "";
    for (const w of words) { const t = line ? line + " " + w : w; if (g.measureText(t).width > maxW - 40 && line) { lines.push(line); line = w; } else line = t; }
    lines.push(line); const bw = Math.min(maxW, Math.max(...lines.map((l) => g.measureText(l).width)) + 44), bh = lines.length * 38 + 30;
    g.fillStyle = "#fff"; g.strokeStyle = "#0c1b4d"; g.lineWidth = 4; g.beginPath(); g.roundRect(x, y, bw, bh, 28); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(x + 40, y + bh - 2); g.lineTo(x + 30, y + bh + 30); g.lineTo(x + 70, y + bh - 2); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = "#0c1b4d"; lines.forEach((l, i) => g.fillText(l, x + 22, y + 16 + i * 38));
  }
  paint();
}
function pickFrame(imgs, cb) {
  const ov = document.createElement("div"); ov.className = "modal";
  ov.innerHTML = `<div class="panel" style="grid-template-columns:1fr"><div class="row spread"><h3>Pick a frame</h3><button class="btn ghost small" id="x">Close ✕</button></div>
    <div class="results">${imgs.map((i) => `<div class="tile-img" data-pick="${i.id}"><img src="${esc(i.url)}" alt=""/></div>`).join("") || '<div class="empty">No frames yet.</div>'}</div></div>`;
  document.body.appendChild(ov); ov.querySelector("#x").onclick = () => ov.remove();
  ov.querySelectorAll("[data-pick]").forEach((t) => (t.onclick = () => { ov.remove(); cb(imgs.find((i) => i.id === t.dataset.pick)); }));
}

// ------------------------------------------------------------------ home
async function home() {
  const [{ items }, projects, { characters: chars }] = await Promise.all([api("GET", "/gallery"), projectsList(true), api("GET", "/characters")]);
  const hour = new Date().getHours();
  const hello = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const checks = [["Make your first frame", items.length > 0, "#/create"], ["Save a character", chars.length > 0, "#/characters"],
    ["Start a project", projects.length > 0, "#/projects"], ["Share a link", items.some((i) => i.shareId), "#/library"]];
  const done = checks.filter((c) => c[1]).length;
  $app.innerHTML = `<section class="home-hero">
      <div><p class="kicker">${hello}</p><h1 class="home-title">${esc(ME.name)}</h1>
        <form class="quick" id="quick"><textarea id="qp" rows="2" placeholder="What should Banime paint? Try “a fox spirit reading under paper lanterns”"></textarea>
          <div class="row spread"><div class="chips">${STYLES.slice(0, 4).map(([k, n]) => `<button type="button" data-qs="${k}" class="${S.style === k ? "on" : ""}">${n}</button>`).join("")}<a class="small" href="#/create">More options →</a> <a class="small" href="#/story">Make a story →</a></div>
          <button class="btn" type="submit">Generate · ${cost(`text:${S.model}`)}✦</button></div></form></div>
      <a class="balance" href="#/credits"><span class="small">Credits</span><b>${ME.credits}</b><span class="small">${ME.billingEnabled ? "Buy more →" : "History →"}</span></a>
    </section>
    ${done < checks.length ? `<section class="card checklist"><div class="row spread"><h3 style="margin:0">Get set up</h3><span class="small muted">${done} of ${checks.length}</span></div>
      <div class="bar"><i style="width:${(done / checks.length) * 100}%"></i></div>
      <div class="checks">${checks.map(([t, ok, href]) => `<a href="${href}" class="${ok ? "done" : ""}"><span class="tick">${ok ? "✓" : ""}</span>${t}</a>`).join("")}</div></section>` : ""}
    <section><div class="row spread"><h3>Recent</h3><a class="small" href="#/library">Library →</a></div>
      <div class="results" id="results">${items.length ? items.slice(0, 8).map(tileHtml).join("") : '<div class="empty" style="grid-column:1/-1">Your creations will show up here.</div>'}</div></section>
    <section><div class="row spread"><h3>Projects</h3><a class="small" href="#/projects">All projects →</a></div>
      <div class="proj-grid">${projects.slice(0, 4).map(projCard).join("") || '<a class="empty proj-empty" href="#/projects">Group frames, clips and manga pages into a series. <b>Start a project</b></a>'}</div></section>`;
  bindTiles(document.getElementById("results")); watchPending(document.getElementById("results"));
  $app.querySelectorAll("[data-qs]").forEach((b) => (b.onclick = () => { S.style = b.dataset.qs; $app.querySelectorAll("[data-qs]").forEach((x) => x.classList.toggle("on", x === b)); }));
  document.getElementById("quick").onsubmit = (e) => { e.preventDefault(); const v = document.getElementById("qp").value.trim(); if (!v) return toast("Type an idea first.", true); S.prompt = v; S.mode = "text"; S.autogen = true; location.hash = "#/create"; };
}

// ------------------------------------------------------------------ projects
const projCard = (p) => `<a class="proj" href="#/projects/${p.id}"><div class="cover" style="${p.coverUrl ? `background-image:url('${esc(p.coverUrl)}')` : ""}">${p.coverUrl ? "" : "<span>No frames yet</span>"}</div>
  <div class="meta"><b>${esc(p.name)}</b><span class="small muted">${p.itemCount ?? 0} frame${p.itemCount === 1 ? "" : "s"} · ${p.pageCount ?? 0} page${p.pageCount === 1 ? "" : "s"}</span></div></a>`;
async function projects() {
  const list = await projectsList(true);
  $app.innerHTML = `<div class="page-head"><div><h2>Projects</h2><p class="muted small">A project is a series: its frames, clips and manga pages in one place.</p></div></div>
    <div class="grid proj-layout"><form class="card" id="pnew"><h3>New project</h3><label>Name</label><input id="pn" maxlength="60" placeholder="Rooftop Saga" required/>
      <label>Description <span class="muted">(optional)</span></label><textarea id="pd" rows="3" maxlength="400" placeholder="A courier who can talk to the wind."></textarea>
      <button class="btn big gen" type="submit">Create project</button></form>
      <div class="proj-grid">${list.map(projCard).join("") || '<div class="empty">No projects yet.</div>'}</div></div>`;
  document.getElementById("pnew").onsubmit = (e) => { e.preventDefault(); busy(e.submitter, async () => {
    const r = await api("POST", "/projects", { name: document.getElementById("pn").value, description: document.getElementById("pd").value });
    PROJECTS = null; location.hash = `#/projects/${r.project.id}`; }); };
}
async function projectDetail(pid) {
  const { project: p, items, pages } = await api("GET", `/projects/${pid}`);
  $app.innerHTML = `<p class="small"><a href="#/projects">← Projects</a></p>
    <div class="page-head"><div style="flex:1;min-width:260px"><input id="pname" class="title-input big" maxlength="60" value="${esc(p.name)}" aria-label="Project name"/>
      <textarea id="pdesc" class="desc-input" rows="2" maxlength="400" placeholder="Add a description" aria-label="Description">${esc(p.description || "")}</textarea></div>
      <div class="row"><button class="btn" id="pc">+ Frame in this project</button><a class="btn ghost" href="#/manga?new=1&project=${p.id}">+ Manga page</a><button class="btn danger small" id="pdel">Delete project</button></div></div>
    ${p.story?.scenes?.length ? `<details class="card story-card"><summary><b>Story plan</b> <span class="small muted">${p.story.scenes.length} scenes${p.story.style ? " · " + esc((STYLES.find((x) => x[0] === p.story.style) || [, ""])[1]) : ""}</span></summary><ol>${p.story.scenes.map((x) => `<li><p>${esc(x.prompt)}</p>${x.caption ? `<p class="small muted">“${esc(x.caption)}”</p>` : ""}</li>`).join("")}</ol></details>` : ""}
    <h3>Frames and clips <span class="muted small">${items.length}</span></h3>
    <div class="results" id="results">${items.length ? items.map(tileHtml).join("") : '<div class="empty" style="grid-column:1/-1">No frames yet. Create one here, or open any frame in your Library and pick this project.</div>'}</div>
    <h3 style="margin-top:28px">Manga pages <span class="muted small">${pages.length}</span></h3>
    <div class="row">${pages.map((g) => `<a class="btn ghost" href="#/manga?page=${g.id}">${esc(g.title || "Untitled page")}</a>`).join("") || '<p class="muted small">No pages yet.</p>'}</div>`;
  bindTiles(document.getElementById("results")); watchPending(document.getElementById("results"));
  const save = (body, msg) => api("PATCH", `/projects/${p.id}`, body).then(() => { PROJECTS = null; toast(msg); }).catch((e) => toast(e.message, true));
  document.getElementById("pname").onchange = (e) => save({ name: e.target.value }, "Name saved.");
  document.getElementById("pdesc").onchange = (e) => save({ description: e.target.value }, "Description saved.");
  document.getElementById("pc").onclick = () => { S.projectId = p.id; location.hash = "#/create"; };
  document.getElementById("pdel").onclick = (e) => busy(e.currentTarget, async () => {
    if (!confirm(`Delete “${p.name}”? Its frames and pages stay in your library.`)) return;
    await api("DELETE", `/projects/${p.id}`); PROJECTS = null; location.hash = "#/projects";
  });
}

// ------------------------------------------------------------------ credits + billing
const PRICE_ROWS = { "Image (fast or detailed)": "text:core", "Image (ultra)": "text:ultra", "Character, sketch or photo": "sketch", "Character sheet": "character:create", "Remove background": "removebg", "Upscale 4×": "upscale", "Animate 5 s": "animate", "Prompt help": "enhance" };
const money = (c) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
function packCards(packs, enabled, signedIn) {
  return Object.entries(packs).map(([k, p], i) => `<div class="pack ${i === 1 ? "hot" : ""}">${i === 1 ? '<span class="tag-hot">Most picked</span>' : ""}<h3>${p.name}</h3>
    <div class="amt">${p.credits.toLocaleString()}<small> credits</small></div><div class="price">${money(p.cents)}</div><p class="small muted">${(p.cents / p.credits).toFixed(1)}¢ a credit · about ${Math.floor(p.credits / 1)} fast images</p>
    ${signedIn ? `<button class="btn ${i === 1 ? "" : "ghost"}" data-pack="${k}" ${enabled ? "" : "disabled"}>${enabled ? "Buy" : "Payments open soon"}</button>` : `<a class="btn ${i === 1 ? "" : "ghost"}" href="#auth" data-go="auth">Start free</a>`}</div>`).join("");
}
async function credits() {
  await loadMe(); const { entries } = await api("GET", "/me/ledger");
  if (location.hash.includes("paid=1")) { toast("Payment received. Your credits are in."); history.replaceState(null, "", "#/credits"); }
  $app.innerHTML = `<div class="page-head"><div><h2>Credits</h2><p class="muted small">Credits pay for AI work. Failed jobs refund automatically.</p></div></div>
    <div class="grid credits-top"><div class="card balance-card"><span class="small">Balance</span><b>${ME.credits}</b><span class="small muted">credits</span></div>
      <div class="packs">${packCards(ME.packs || {}, ME.billingEnabled, true)}</div></div>
    ${ME.billingEnabled ? "" : '<p class="notice" style="margin-top:14px">Card payments are being set up. Until then, new accounts get 30 free credits and the studio owner can add more.</p>'}
    <div class="grid two" style="margin-top:20px"><div class="card"><h3>What things cost</h3><table class="small">${Object.entries(PRICE_ROWS).map(([n, k]) => `<tr><td>${n}</td><td class="mono" style="text-align:right">${cost(k) || "Free"}${cost(k) ? "✦" : ""}</td></tr>`).join("")}</table></div>
      <div class="card"><h3>History</h3><div class="scroll"><table><tr><th>When</th><th>What</th><th>Change</th><th>Balance</th></tr>
      ${entries.map((e) => `<tr><td class="small">${new Date(e.ts * 1000).toLocaleString()}</td><td>${esc(e.reason)}</td><td class="mono" style="color:${e.delta < 0 ? "var(--red)" : "var(--sky-deep)"}">${e.delta > 0 ? "+" : ""}${e.delta}</td><td class="mono">${e.balance}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">No activity yet.</td></tr>'}</table></div></div></div>`;
  $app.querySelectorAll("[data-pack]").forEach((b) => (b.onclick = () => busy(b, async () => { const r = await api("POST", "/billing/checkout", { pack: b.dataset.pack }); location.href = r.url; })));
}

// ------------------------------------------------------------------ settings
async function settings() {
  await loadMe(); const p = ME.prefs || {};
  $app.innerHTML = `<div class="page-head"><div><h2>Settings</h2><p class="muted small">Signed in as ${esc(ME.email)}</p></div></div>
    <div class="grid two"><form class="card" id="sp"><h3>Profile</h3><label>Display name</label><input id="sn" maxlength="40" value="${esc(ME.name)}"/>
      <p class="small muted">Shown on links you share.</p>
      <h3 style="margin-top:22px">Studio defaults</h3>
      <label>Style</label><select id="ss">${STYLES.map(([k, n]) => `<option value="${k}" ${(p.style || "shonen") === k ? "selected" : ""}>${n}</option>`).join("")}</select>
      <label>Model</label><select id="sm">${[["core", "Fast"], ["sd35", "Detailed"], ["ultra", "Ultra"]].map(([k, n]) => `<option value="${k}" ${(p.model || "core") === k ? "selected" : ""}>${n}</option>`).join("")}</select>
      <label>Shape</label><select id="sa">${ASPECTS.map(([k, n]) => `<option value="${k}" ${(p.aspect || "1:1") === k ? "selected" : ""}>${n} (${k})</option>`).join("")}</select>
      <button class="btn big gen" type="submit">Save settings</button></form>
    <div class="grid" style="align-content:start">
      <div class="card"><h3>Sign-in</h3><p class="small muted">${esc(ME.email)} · ${DEMO ? "demo" : "Banime account"}</p><button class="btn ghost" id="so">Sign out</button></div>
      <div class="card"><h3>Your data</h3><p class="small muted">Download everything Banime keeps about you: profile, credit history, prompts, projects, pages and links to every file (links work for 6 hours).</p><button class="btn ghost" id="sx">Download my data (JSON)</button></div>
      <div class="card danger-zone"><h3>Delete account</h3><p class="small muted">Deletes your sign-in, every image, clip, character, project and page, and turns off your shared links. Unused credits are lost. This can't be undone.</p>
        <label>Type DELETE to confirm</label><input id="sdc" autocomplete="off"/><button class="btn danger" id="sd" style="margin-top:10px">Delete my account</button></div>
    </div></div>`;
  document.getElementById("sp").onsubmit = (e) => { e.preventDefault(); busy(e.submitter, async () => {
    await api("PATCH", "/me", { name: document.getElementById("sn").value, prefs: { style: document.getElementById("ss").value, model: document.getElementById("sm").value, aspect: document.getElementById("sa").value } });
    Object.assign(S, { style: document.getElementById("ss").value, model: document.getElementById("sm").value, aspect: document.getElementById("sa").value });
    await loadMe(); toast("Settings saved."); }); };
  document.getElementById("so").onclick = () => auth.logout();
  document.getElementById("sx").onclick = (e) => busy(e.currentTarget, async () => {
    const d = await api("GET", "/me/export"); const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" })); a.download = `banime-export-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  });
  document.getElementById("sd").onclick = (e) => busy(e.currentTarget, async () => {
    const v = document.getElementById("sdc").value.trim(); if (v !== "DELETE") throw new Error("Type DELETE in capitals to confirm.");
    if (!confirm("Last check: delete your Banime account and everything in it?")) return;
    await api("DELETE", "/me", { confirm: "DELETE" }); auth.clear(); ME = null; toast("Your account was deleted."); location.hash = "#/";
  });
}

// ------------------------------------------------------------------ admin
async function admin() {
  if (!ME.isAdmin) { location.hash = "#/home"; return; }
  const [o, { users }, { reports }] = await Promise.all([api("GET", "/admin/overview"), api("GET", "/admin/users"), api("GET", "/admin/reports")]);
  const c = o.counts || {};
  const m = `${o.month.slice(0, 4)}-${o.month.slice(4)}`;
  $app.innerHTML = `<div class="page-head"><div><h2>Admin</h2><p class="muted small">Owner view · ${m} (UTC)</p></div></div>
    <div class="stats">${[["Users", o.users], ["Images", c.images || 0], ["Clips", c.clips || 0], ["Cutouts + upscales", (c.removebg || 0) + (c.upscale || 0)],
      ["Story plans", c.storyPlans || 0], ["Clip spend", `$${o.videoSpendUsd.toFixed(2)} <small>/ $${o.videoCapUsd}</small>`], ["Sales", `${c.orders || 0} · ${money(c.revenueCents || 0)}`]].map(([k, v]) => `<div class="card stat"><span class="small muted">${k}</span><b>${v}</b></div>`).join("")}</div>
    <div class="row" style="margin:6px 0 18px"><span class="pill">Animation: ${o.animatePolicy === "all" ? "everyone" : "admins only"}</span><span class="pill">Payments: ${o.billingEnabled ? "on" : "off"}</span></div>
    <div class="grid two"><div class="card"><h3>Users</h3><div class="scroll"><table><tr><th>Email</th><th>Joined</th><th>Status</th><th>Credits</th><th></th></tr>
      ${users.map((u) => `<tr><td>${esc(u.email || u.userId)}</td><td class="small">${u.created ? new Date(u.created * 1000).toLocaleDateString() : ""}</td><td class="small">${esc(u.status || "")}</td><td class="mono">${u.credits ?? "–"}</td>
        <td><button class="btn ghost small" data-grant="${esc(u.userId)}" data-email="${esc(u.email || "")}">Grant</button></td></tr>`).join("")}</table></div></div>
    <div class="grid" style="align-content:start"><div class="card"><h3>Reports <span class="small muted">${reports.length}</span></h3>${reports.length ? `<table>${reports.map((r) => `<tr><td class="small">${new Date(r.created * 1000).toLocaleDateString()}</td><td><a href="#/s/${esc(r.shareId)}" target="_blank" rel="noopener">${esc(r.shareId)}</a></td><td>${esc(r.reason)}</td><td><button class="btn danger small" data-hide="${esc(r.shareId)}">Hide</button></td></tr>`).join("")}</table>` : '<p class="muted small">No reports. Hiding a creation turns off its link and takes it off Explore.</p>'}</div>
    <div class="card"><h3>Recent orders</h3>${o.orders.length ? `<table>${o.orders.map((x) => `<tr><td class="small">${new Date(x.created * 1000).toLocaleString()}</td><td>${esc(x.email || x.userId)}</td><td>${esc(x.pack)}</td><td class="mono">${money(x.amount || 0)}</td></tr>`).join("")}</table>` : '<p class="muted small">No orders yet.</p>'}</div></div></div>`;
  $app.querySelectorAll("[data-hide]").forEach((b) => (b.onclick = () => busy(b, async () => {
    if (!confirm("Hide this creation? Its public link stops working and it leaves Explore. The owner keeps it in their library.")) return;
    await api("POST", `/admin/hide/${b.dataset.hide}`); toast("Hidden."); admin(); })));
  $app.querySelectorAll("[data-grant]").forEach((b) => (b.onclick = () => busy(b, async () => {
    const n = parseInt(prompt(`Credits to add for ${b.dataset.email} (use a minus sign to remove):`, "50"), 10); if (!n) return;
    await api("POST", "/admin/grant", { userId: b.dataset.grant, credits: n }); toast(`${n > 0 ? "Added" : "Removed"} ${Math.abs(n)} credits.`); admin();
  })));
}

// ------------------------------------------------------------------ public pages
async function sharePage(sid) {
  let d;
  try {
    if (DEMO) throw new Error("Shared links open on the live site.");
    const r = await fetch(`${CFG.apiUrl.replace(/\/$/, "")}/public/s/${encodeURIComponent(sid)}`); d = await r.json();
    if (!r.ok) throw new Error(d.error || "Not found.");
  } catch (e) {
    $app.innerHTML = `<div class="public narrow"><div class="card" style="text-align:center;padding:48px"><h2>This link isn't available</h2><p class="muted">${esc(e.message)}</p><a class="btn" href="#/">Make your own anime art</a></div></div>`; return;
  }
  const s = d.share; const sty = STYLES.find((x) => x[0] === s.style);
  document.title = `${s.title || "Anime art"} by ${s.by} · Banime`;
  $app.innerHTML = `<div class="public share">
    <figure class="share-media">${s.kind === "video" ? `<video src="${esc(s.url)}" poster="${esc(s.posterUrl || "")}" controls autoplay loop muted playsinline></video>` : `<img src="${esc(s.url)}" alt="${esc(s.title || s.prompt || "Anime art")}"/>`}</figure>
    <div class="share-copy"><p class="kicker">${sty ? sty[1] : "Anime"} · made with Banime</p><h1>${esc(s.title || "Untitled")}</h1><p class="muted">by ${esc(s.by)} · ${new Date(s.created * 1000).toLocaleDateString()}</p>
      ${s.prompt ? `<blockquote>${esc(s.prompt)}</blockquote>` : ""}<p class="small muted">AI-generated image.</p>
      <div class="row" style="margin-top:20px">${s.prompt ? '<button class="btn big" id="share-remix">Try this prompt</button>' : ""}${auth.signedIn ? "" : '<a class="btn ghost big" href="#auth" id="share-join">Make your own · 30 free credits</a>'}<button class="btn ghost big" id="share-copy">Copy link</button></div>
      ${auth.signedIn ? '<p class="small" style="margin-top:22px"><button class="linkish" id="share-report">Report this</button></p>' : ""}</div></div>`;
  document.getElementById("share-remix")?.addEventListener("click", () => { Object.assign(S, { prompt: s.prompt, mode: "text", ...(s.style ? { style: s.style } : {}) }); if (auth.signedIn) location.hash = "#/create"; else auth.login("COGNITO"); });
  document.getElementById("share-report")?.addEventListener("click", (e) => busy(e.currentTarget, async () => {
    const reason = prompt("What's wrong with it? Type one: sexual, minor, real_person, hate, violence, spam, other", "other"); if (!reason) return;
    await api("POST", "/report", { shareId: sid, reason: reason.trim().toLowerCase() }); toast("Thanks. The studio owner will review it.");
  }));
  document.getElementById("share-copy").onclick = () => copyText(location.href);
  document.getElementById("share-join")?.addEventListener("click", (e) => { e.preventDefault(); auth.login("COGNITO"); });
}
const DEFAULT_PACKS = { starter: { name: "Starter", credits: 100, cents: 1500 }, creator: { name: "Creator", credits: 400, cents: 4900 }, studio: { name: "Studio", credits: 1000, cents: 10900 } };
function pricing() {
  $app.innerHTML = `<div class="public"><div class="page-head"><div><h2>Pricing</h2><p class="muted">Start with 30 free credits. No subscription: buy credits when you need them, and failed jobs refund automatically.</p></div></div>
    <div class="packs wide">${packCards(ME?.packs || DEFAULT_PACKS, false, auth.signedIn && !!ME)}</div>
    <div class="grid two" style="margin-top:24px"><div class="card"><h3>What things cost</h3><table>${Object.entries(PRICE_ROWS).map(([n, k]) => `<tr><td>${n}</td><td class="mono" style="text-align:right">${(({ "text:ultra": 2, animate: 38, enhance: 0 })[k] ?? 1) || "Free"}${k === "enhance" ? "" : "✦"}</td></tr>`).join("")}</table></div>
      <div class="card"><h3>Free with every account</h3><ul class="ticks"><li>30 credits to start</li><li>Manga page composer and PNG export</li><li>Prompt help from Amazon Nova</li><li>Private library, projects and characters</li><li>Share links you can turn off at any time</li></ul></div></div></div>`;
  bindScrollLinks($app);
}
const FAQ = [
  ["What is a credit?", "Credits pay for the AI work. A fast or detailed image is 1 credit, an ultra image 2, a 5-second clip 38. Manga pages and prompt help are free."],
  ["What happens if a generation fails?", "The credits go straight back to your balance, and the refund shows in your history."],
  ["Who can see my work?", "Only you. A creation becomes visible to others only if you turn on its public link, and turning the link off stops it working right away."],
  ["Can I use what I make?", "Yes, for personal and commercial projects, as long as it follows the content policy. Images are labeled as AI-generated."],
  ["Why was my prompt blocked?", "Banime blocks explicit content, anything that sexualizes minors, images of real people by name, and hate. See the content policy."],
  ["Why can't I animate yet?", "Clips are in early access while the studio owner watches costs. Everything else is open to every account."],
  ["How do I keep a character the same in every scene?", "Make the character once on the Characters page, then pick Character in Create. Banime uses its reference sheet so the face, hair and outfit stay on-model."],
  ["What is Explore?", "A public feed of work people chose to post. Open any creation in your Library and turn on Show on Explore. It shows with your display name, and you can take it down at any time."],
  ["How does Story work?", "Describe a short story. Banime plans the scenes with a line of dialogue each, paints them with your saved character, and lays them out as a manga page in a new project. Each scene costs the same as one frame."],
  ["How do I know when a clip is done?", "Clips take 1 to 3 minutes. The bell at the top of the studio lights up when one finishes, even if you closed the tab. Turn on desktop alerts from the bell to get a pop-up too."],
  ["How do I delete my account?", "Settings → Delete account. It removes your sign-in and every file. You can download your data first from the same page."],
];
function help() {
  $app.innerHTML = `<div class="public narrow"><h2>Help</h2><div class="faq">${FAQ.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join("")}</div>
    <p class="muted small" style="margin-top:24px">Still stuck? Email the studio at <a href="mailto:kevin.scottk07@gmail.com">kevin.scottk07@gmail.com</a>.</p></div>`;
}
const LEGAL = {
  terms: ["Terms of service", [
    ["Who we are", "Banime is an AI anime studio run by Kyverin (\"we\"). By creating an account you agree to these terms."],
    ["Your account", "You need a valid email or Google account. You're responsible for activity on your account. You must be 13 or older, or the minimum age in your country."],
    ["Credits", "Credits are a prepaid balance for AI generations. They have no cash value, can't be transferred, and are not refundable except where the law requires. Failed generations are refunded in credits automatically."],
    ["What you make", "You own what you create with Banime, to the extent the law allows for AI-assisted work. You give us permission to store and process it only to run the service for you. Public links show your work to anyone who has the link until you turn the link off. Work you post to Explore is visible to everyone, with your display name, until you take it down."],
    ["Acceptable use", "Follow the content policy. We can block prompts, remove content and suspend accounts that break it."],
    ["The service", "Banime is provided as is. AI results vary and can be wrong or unexpected. We may change features or prices with notice on the site."],
    ["Liability", "To the extent the law allows, our total liability to you is limited to the amount you paid us in the 12 months before the claim."],
    ["Contact", "kevin.scottk07@gmail.com"]]],
  privacy: ["Privacy policy", [
    ["What we collect", "Your email address and display name, the prompts and images you upload or create, your credit history, and basic technical logs (time, request type, errors)."],
    ["How we use it", "To sign you in, run your generations, keep your library, show your balance, prevent abuse, and fix problems. We do not sell your data or use it for advertising."],
    ["Who processes it", "Banime runs on Amazon Web Services in the United States (Oregon): Amazon Cognito for sign-in, Amazon Bedrock for the AI models (Stability AI, Amazon Nova, Luma), Amazon S3 and DynamoDB for storage. Google, if you sign in with Google. Stripe, if you buy credits; we never see your card number."],
    ["Model training", "Your prompts and images are not used to train AI models. Amazon Bedrock does not use customer inputs or outputs to train its models."],
    ["How long we keep it", "Until you delete it or your account. Server logs are kept for 30 days. Database backups roll off after 35 days."],
    ["Your choices", "Download all your data or delete your account at any time from Settings. Email us for any other request."],
    ["Contact", "kevin.scottk07@gmail.com"]]],
  content: ["Content policy", [
    ["Not allowed", "Sexual or nude content of anyone. Any content that sexualizes a character who is or looks like a minor. Images of real, identifiable people by name, including celebrities and politicians. Hate, harassment or threats. Graphic gore. Content that helps someone break the law."],
    ["How we enforce it", "Every prompt is checked by Amazon Bedrock Guardrails and every image by the model's own safety filters. Blocked prompts are not charged."],
    ["Labels", "Everything Banime makes is AI-generated. Don't present it as a photo of a real event or person."],
    ["Report a problem", "Email kevin.scottk07@gmail.com with the share link. We remove content that breaks this policy."]]],
};
function legal(which) {
  const [title, secs] = LEGAL[which] || LEGAL.terms;
  $app.innerHTML = `<div class="public narrow legal"><p class="kicker">Banime by Kyverin · updated November 18, 2026</p><h2>${title}</h2>
    ${secs.map(([h, t]) => `<h3>${h}</h3><p>${esc(t)}</p>`).join("")}
    <p class="small muted" style="margin-top:28px"><a href="#/legal/terms">Terms</a> · <a href="#/legal/privacy">Privacy</a> · <a href="#/legal/content">Content policy</a></p></div>`;
}


// ------------------------------------------------------------------ notifications
const NOTIF_TEXT = { clip_ready: "Your clip is ready", clip_failed: "A clip couldn't be made" };
async function openBell() {
  const pop = document.getElementById("bell-pop"); if (!pop) return;
  if (!pop.hidden) { pop.hidden = true; return; }
  pop.hidden = false; pop.innerHTML = '<p class="small muted" style="padding:10px 12px">Loading…</p>';
  document.addEventListener("click", function off(e) { if (!pop.contains(e.target)) { pop.hidden = true; document.removeEventListener("click", off); } });
  try {
    const { notifications } = await api("GET", "/notifications");
    const canAsk = "Notification" in window && Notification.permission === "default";
    pop.innerHTML = `<div class="row spread" style="padding:8px 12px 4px"><b>Notifications</b>${canAsk ? '<button class="linkish small" id="np">Turn on desktop alerts</button>' : ""}</div>`
      + (notifications.length ? notifications.map((n) => `<a href="#/library" data-item="${esc(n.itemId || "")}" class="notif ${n.read ? "" : "new"}"><b>${esc(NOTIF_TEXT[n.kind] || n.text)}</b><span class="small muted">${esc(n.title || "")}${n.title ? " · " : ""}${timeAgo(n.created)}</span></a>`).join("")
        : '<p class="small muted" style="padding:6px 12px 12px">Nothing yet. You\'ll hear here when a clip finishes.</p>');
    pop.querySelectorAll("[data-item]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); pop.hidden = true; if (a.dataset.item) openItem(a.dataset.item); }));
    pop.querySelector("#np")?.addEventListener("click", async (e) => { e.stopPropagation(); await Notification.requestPermission(); openBell(); openBell(); });
    if (notifications.some((n) => !n.read)) { await api("POST", "/notifications/read", {}); ME.unread = 0; const d = document.querySelector("#bell .dot"); d?.remove(); }
  } catch (e) { pop.innerHTML = `<p class="small" style="padding:10px 12px">${esc(e.message)}</p>`; }
}
function timeAgo(t) { const m = Math.round((Date.now() / 1000 - t) / 60); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(t * 1000).toLocaleDateString(); }
let NOTIF_TIMER = null;
function startNotifPoll() {
  if (NOTIF_TIMER || DEMO) return;
  NOTIF_TIMER = setInterval(async () => {
    if (!auth.signedIn || document.hidden || !ME) return;
    try {
      const { notifications, unread } = await api("GET", "/notifications");
      if (unread > (ME.unread || 0)) {
        const n = notifications.find((x) => !x.read);
        toast(`${NOTIF_TEXT[n?.kind] || "New notification"}${n?.title ? ": " + n.title : ""}`);
        if ("Notification" in window && Notification.permission === "granted" && n) new Notification("Banime", { body: NOTIF_TEXT[n.kind] || n.text });
      }
      if (unread !== ME.unread) { ME.unread = unread; renderNav(); }
    } catch { /* offline: try again next tick */ }
  }, 60000);
}

// ------------------------------------------------------------------ explore (public feed)
const EXP = { items: [], cursor: null, style: "", loaded: false };
async function explorePage() {
  const base = CFG.apiUrl ? CFG.apiUrl.replace(/\/$/, "") : "";
  const load = async (more) => {
    if (DEMO || !base) { EXP.items = []; EXP.cursor = null; EXP.loaded = true; return; }
    const r = await fetch(`${base}/public/explore${more && EXP.cursor ? `?cursor=${encodeURIComponent(EXP.cursor)}` : ""}`); const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Couldn't load Explore.");
    EXP.items = more ? EXP.items.concat(d.items) : d.items; EXP.cursor = d.cursor; EXP.loaded = true;
  };
  await load(false);
  const wrap = auth.signedIn ? "" : "public";
  const draw = () => {
    const list = EXP.items.filter((x) => !EXP.style || x.style === EXP.style);
    $app.innerHTML = `<div class="${wrap}"><div class="page-head"><div><h2>Explore</h2><p class="muted small">Frames and clips people chose to share. Tap one to see its prompt and try it yourself.</p></div>
      ${auth.signedIn ? '<a class="btn ghost" href="#/library">Post from your library</a>' : '<a class="btn" href="#auth" data-go="auth">Start free</a>'}</div>
      <div class="chips" style="margin-bottom:16px"><button data-es="" class="${EXP.style ? "" : "on"}">All</button>${STYLES.map(([k, n]) => `<button data-es="${k}" class="${EXP.style === k ? "on" : ""}">${n}</button>`).join("")}</div>
      ${list.length ? `<div class="masonry">${list.map((x) => `<a class="mcard" href="#/s/${x.shareId}">${x.kind === "video" ? `<video src="${esc(x.url)}" poster="${esc(x.posterUrl || "")}" muted loop playsinline preload="none"></video><span class="tag">clip</span>` : `<img src="${esc(x.url)}" alt="${esc(x.title || x.prompt || "Anime art")}" loading="lazy"/>`}
        <div class="mmeta"><b>${esc(x.title || "Untitled")}</b><span>by ${esc(x.by)}</span></div></a>`).join("")}</div>`
        : `<div class="empty">${DEMO ? "Explore shows real posts on the live site." : "Nothing posted here yet. Open a frame in your Library and turn on Show on Explore."}</div>`}
      ${EXP.cursor ? '<div style="text-align:center;margin-top:20px"><button class="btn ghost" id="emore">Load more</button></div>' : ""}</div>`;
    bindScrollLinks($app);
    $app.querySelectorAll("[data-es]").forEach((b) => (b.onclick = () => { EXP.style = b.dataset.es; draw(); }));
    $app.querySelectorAll(".mcard video").forEach((v) => { v.parentElement.onmouseenter = () => v.play().catch(() => {}); v.parentElement.onmouseleave = () => v.pause(); });
    document.getElementById("emore")?.addEventListener("click", (e) => busy(e.currentTarget, async () => { await load(true); draw(); }));
  };
  draw();
}

// ------------------------------------------------------------------ story mode
const ST = { step: 1, premise: "", characterId: "", style: "", count: 4, aspect: "", title: "", scenes: [] };
async function story() {
  const { characters } = await api("GET", "/characters");
  if (!ST.style) ST.style = S.style; if (!ST.aspect) ST.aspect = S.aspect;
  const each = ST.characterId ? cost("character") : cost(`text:${S.model}`);
  const charOpts = characters.map((c) => `<option value="${c.id}" ${ST.characterId === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  $app.innerHTML = `<div class="page-head"><div><h2>Story</h2><p class="muted small">Describe a short story. Banime plans the scenes, paints each one with the same character, and lays them out as a manga page.</p></div></div>
    <ol class="steps"><li class="${ST.step === 1 ? "on" : "done"}">Idea</li><li class="${ST.step === 2 ? "on" : ST.step > 2 ? "done" : ""}">Scenes</li><li class="${ST.step === 3 ? "on" : ""}">Make it</li></ol>
    <div id="stbody"></div>`;
  const body = document.getElementById("stbody");
  if (ST.step === 1) {
    body.innerHTML = `<div class="grid two"><form class="card" id="st1">
      <label style="margin-top:0">What happens?</label><textarea id="sp" rows="4" maxlength="1500" placeholder="A wind courier races a storm across the rooftops of a floating city to deliver a letter before sunset." required>${esc(ST.premise)}</textarea>
      <label>Main character</label><select id="sc"><option value="">No saved character (looks may vary between scenes)</option>${charOpts}</select>
      ${characters.length ? "" : '<p class="small muted">For the same face in every scene, <a href="#/characters">save a character</a> first.</p>'}
      <div class="grid two" style="gap:12px"><div><label>Style</label><select id="ss">${STYLES.map(([k, n]) => `<option value="${k}" ${ST.style === k ? "selected" : ""}>${n}</option>`).join("")}</select></div>
        <div><label>Scenes</label><select id="sn">${[2, 3, 4, 5, 6].map((n) => `<option ${ST.count === n ? "selected" : ""}>${n}</option>`).join("")}</select></div></div>
      <label>Shape</label><select id="sa">${ASPECTS.map(([k, n]) => `<option value="${k}" ${ST.aspect === k ? "selected" : ""}>${n} (${k})</option>`).join("")}</select>
      <button class="btn big gen" type="submit">Plan the scenes · free</button></form>
      <div class="card story-tip"><h3>How it works</h3><ul class="ticks"><li>Amazon Nova splits your idea into scenes with a line of dialogue each.</li><li>You edit anything before painting.</li><li>Each scene costs ${each}✦, the same as a single frame.</li><li>Everything lands in a new project, with a manga page already laid out.</li></ul></div></div>`;
    document.getElementById("st1").onsubmit = (e) => { e.preventDefault(); busy(e.submitter, async () => {
      Object.assign(ST, { premise: document.getElementById("sp").value.trim(), characterId: document.getElementById("sc").value, style: document.getElementById("ss").value,
        count: +document.getElementById("sn").value, aspect: document.getElementById("sa").value });
      const r = await api("POST", "/stories/plan", { premise: ST.premise, characterId: ST.characterId || undefined, style: ST.style, count: ST.count });
      Object.assign(ST, { title: r.title, scenes: r.scenes, step: 2 }); story();
    }); };
  } else if (ST.step === 2) {
    const total = ST.scenes.length * each;
    body.innerHTML = `<div class="card"><label style="margin-top:0">Title</label><input id="stt" maxlength="60" value="${esc(ST.title)}"/>
      <div class="scenes">${ST.scenes.map((sc, i) => `<div class="scene"><span class="num">${i + 1}</span><div><label>Scene</label><textarea data-sp="${i}" rows="3" maxlength="600">${esc(sc.prompt)}</textarea>
        <label>Speech bubble</label><input data-sc="${i}" maxlength="120" value="${esc(sc.caption)}"/></div>${ST.scenes.length > 2 ? `<button class="btn ghost small" data-rm="${i}" aria-label="Remove scene ${i + 1}">✕</button>` : ""}</div>`).join("")}</div>
      <div class="row spread" style="margin-top:16px"><div class="row"><button class="btn ghost" id="sback">← Back</button>${ST.scenes.length < 6 ? '<button class="btn ghost" id="sadd">+ Scene</button>' : ""}<button class="btn ghost" id="sredo">Re-plan</button></div>
        <button class="btn big" id="smake">Make the story · ${total}✦</button></div>
      <p class="small muted" style="text-align:right;margin:8px 0 0">You have ${ME.credits}✦.</p></div>`;
    const sync = () => { ST.title = document.getElementById("stt").value; body.querySelectorAll("[data-sp]").forEach((t) => (ST.scenes[+t.dataset.sp].prompt = t.value)); body.querySelectorAll("[data-sc]").forEach((t) => (ST.scenes[+t.dataset.sc].caption = t.value)); };
    body.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { sync(); ST.scenes.splice(+b.dataset.rm, 1); story(); }));
    document.getElementById("sadd")?.addEventListener("click", () => { sync(); ST.scenes.push({ prompt: "", caption: "" }); story(); });
    document.getElementById("sback").onclick = () => { sync(); ST.step = 1; story(); };
    document.getElementById("sredo").onclick = () => { sync(); ST.step = 1; story(); setTimeout(() => document.querySelector("#st1 button[type=submit]")?.click(), 50); };
    document.getElementById("smake").onclick = () => { sync();
      if (ST.scenes.some((x) => !x.prompt.trim())) return toast("Every scene needs a description.", true);
      if (ME.credits < total) return toast(`This needs ${total}✦ and you have ${ME.credits}✦.`, true);
      ST.step = 3; story(); };
  } else {
    body.innerHTML = `<div class="card"><h3 style="margin-top:0">${esc(ST.title || "Your story")}</h3><div class="progress" id="sprog">${ST.scenes.map((sc, i) => `<div class="pstep" id="ps${i}"><div class="thumb"></div><div><b>Scene ${i + 1}</b><p class="small muted">${esc(sc.caption || sc.prompt.slice(0, 80))}</p></div><span class="state">Waiting</span></div>`).join("")}</div>
      <p class="small muted" id="sstat">Creating the project…</p></div>`;
    const stat = document.getElementById("sstat");
    try {
      const { project } = await api("POST", "/projects", { name: ST.title || "Untitled story", description: ST.premise, story: { premise: ST.premise, style: ST.style, characterId: ST.characterId || null, scenes: ST.scenes } });
      PROJECTS = null; const made = [];
      for (const [i, sc] of ST.scenes.entries()) {
        const row = document.getElementById(`ps${i}`); row.querySelector(".state").innerHTML = '<span class="spinner"></span> Painting';
        stat.textContent = `Painting scene ${i + 1} of ${ST.scenes.length}. Each takes about 10 seconds.`;
        try {
          const r = await api("POST", "/generate", { mode: ST.characterId ? "character" : "text", characterId: ST.characterId || undefined, prompt: sc.prompt,
            style: ST.style, aspect: ST.aspect, model: S.model, projectId: project.id, title: `${ST.title} · ${i + 1}`.slice(0, 60) });
          made.push({ itemId: r.item.id, text: sc.caption }); ME.credits = r.credits;
          row.querySelector(".thumb").style.backgroundImage = `url('${r.item.url}')`; row.querySelector(".state").textContent = "Done"; row.classList.add("ok");
        } catch (e) { made.push({ itemId: null, text: sc.caption }); row.querySelector(".state").textContent = e.message; row.classList.add("bad"); }
        renderNav();
      }
      stat.textContent = "Laying out the manga page…";
      const pages = []; for (let i = 0; i < made.length; i += 4) pages.push(made.slice(i, i + 4));
      if (pages.length > 1 && pages[pages.length - 1].length === 1) pages[pages.length - 1].unshift(pages[pages.length - 2].pop());
      for (const [i, panels] of pages.entries()) {
        await api("POST", "/pages", { projectId: project.id, layout: panels.length === 3 ? "hero" : panels.length === 4 && ST.aspect === "16:9" ? "yonkoma" : "grid",
          title: pages.length > 1 ? `${ST.title} (${i + 1}/${pages.length})` : ST.title, panels });
      }
      Object.assign(ST, { step: 1, premise: "", title: "", scenes: [] });
      toast("Your story is ready."); location.hash = `#/projects/${project.id}`;
    } catch (e) { stat.textContent = e.message; stat.style.color = "var(--red)"; }
  }
}
// ------------------------------------------------------------------ router
const PUBLIC = [["#/s/", (h) => sharePage(h.slice(4).split("?")[0])], ["#/explore", explorePage], ["#/pricing", pricing], ["#/help", help], ["#/legal/", (h) => legal(h.slice(8))]];
async function route() {
  const h = location.hash || "#/";
  scrollTo(0, 0);
  try {
    const pub = PUBLIC.find(([p]) => h.startsWith(p) && !(auth.signedIn && p === "#/explore"));
    if (pub) {
      document.body.classList.remove("is-landing", "scrolled", "portal"); heroCleanup?.(); heroCleanup = null;
      if (auth.signedIn && !ME) await loadMe().catch(() => {});
      renderNav(); return await pub[1](h);
    }
    if (!auth.signedIn || h === "#/" || h === "#auth") {
      if (auth.signedIn && h === "#/") { location.hash = "#/home"; return; }
      document.body.classList.remove("portal"); renderNav(); return landing();
    }
    document.body.classList.remove("is-landing", "scrolled"); document.body.classList.add("portal"); heroCleanup?.(); heroCleanup = null;
    if (!ME) { await loadMe(); applyPrefs(); startNotifPoll(); } else renderNav();
    $app.innerHTML = '<p class="muted"><span class="spinner"></span> Loading…</p>';
    const pm = h.match(/^#\/projects\/(p[0-9a-f]{12})/);
    if (pm) return await projectDetail(pm[1]);
    const table = { "#/home": home, "#/create": create, "#/characters": characters, "#/projects": projects, "#/story": story, "#/manga": manga, "#/library": library, "#/gallery": library,
      "#/explore": explorePage, "#/credits": credits, "#/settings": settings, "#/account": settings, "#/admin": admin };
    const k = Object.keys(table).find((p) => h === p || h.startsWith(p + "?") || h.startsWith(p + "/"));
    if (k) return await table[k]();
    location.hash = "#/home";
  } catch (e) { $app.innerHTML = `<div class="card"><h2>Something went wrong</h2><p class="muted">${esc(e.message)}</p><a class="btn ghost" href="#/home">Back to Home</a></div>`; }
}
function applyPrefs() { const p = ME?.prefs || {}; if (p.style) S.style = p.style; if (p.model) S.model = p.model; if (p.aspect) S.aspect = p.aspect; }
addEventListener("hashchange", route);
(async () => { try { await auth.handleRedirect(); } catch (e) { toast(e.message, true); } route(); })();
