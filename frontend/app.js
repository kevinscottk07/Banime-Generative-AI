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
    if (DEMO) { location.href = "?demo#/create"; return; }
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
    sessionStorage.setItem("bn.pkce", JSON.stringify({ verifier, state, back: location.hash.startsWith("#/") && location.hash !== "#/" ? location.hash : "#/create" }));
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
    history.replaceState(null, "", location.pathname + (saved.back || "#/create"));
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
function renderNav() {
  const h = location.hash;
  if (!auth.signedIn) { $nav.innerHTML = `<a href="#auth" data-go="auth">Sign in</a>`; bindScrollLinks($nav); return; }
  const link = (href, label) => `<a href="${href}" class="${h.startsWith(href) ? "on" : ""}">${label}</a>`;
  $nav.innerHTML = `${DEMO ? '<span class="pill">Demo</span>' : ""}${link("#/create", "Create")}${link("#/characters", "Characters")}${link("#/gallery", "Gallery")}${link("#/manga", "Manga page")}
    <span class="pill">✦ <b>${ME?.credits ?? "–"}</b></span><button class="avatar" title="${esc(ME?.email || "Account")}" id="acct">${esc((ME?.name || "?")[0].toUpperCase())}</button>`;
  document.getElementById("acct").onclick = () => { location.hash = "#/account"; };
}

// ------------------------------------------------------------------ shared data
const STYLES = [["shonen", "Shonen action", "少年"], ["slice", "Slice of life", "日常"], ["retro90", "90s cel", "九十"], ["cyber", "Cyberpunk", "電脳"],
  ["chibi", "Chibi", "ちび"], ["manga", "Manga ink", "漫画"], ["mecha", "Mecha", "機械"], ["fantasy", "Dark fantasy", "幻想"]];
const ART = (CFG.artBase || "/art/");
const styleArt = (k) => `${ART}style-${k}.jpg`;
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
  return `<div class="tile-img" data-id="${it.id}">${media}<span class="tag">${esc(tag)}</span></div>`;
}

// ------------------------------------------------------------------ create studio
const S = { mode: "text", style: "shonen", aspect: "1:1", model: "core", strength: 0.7, characterId: null, photo: null, prompt: "" };
let PAD = null;

async function create() {
  const [{ characters }, { items }] = await Promise.all([api("GET", "/characters"), api("GET", "/gallery")]);
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
      <button class="btn big gen" id="gen">Generate</button>
      <p class="small muted" id="costline" style="text-align:center;margin:8px 0 0"></p>
    </aside>
    <section><div class="row spread"><h2>Your latest</h2><a href="#/gallery" class="small">Open gallery →</a></div>
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
    const body = { mode: S.mode, prompt: $p.value, style: S.style, aspect: S.aspect, model: S.model, strength: S.strength };
    if (S.mode === "character") { if (!S.characterId) throw new Error("Pick or create a character first."); body.characterId = S.characterId; }
    if (S.mode === "sketch") { if (PAD.isEmpty()) throw new Error("Draw something on the pad first."); body.imageBase64 = PAD.toB64(); }
    if (S.mode === "photo") { if (!S.photo) throw new Error("Upload a photo first."); body.imageBase64 = S.photo; }
    const res = document.getElementById("results");
    res.querySelector(".empty")?.remove();
    res.insertAdjacentHTML("afterbegin", '<div class="tile-img pending" id="ph"><span class="small">Painting… <span class="spinner"></span></span></div>');
    try { const r = await api("POST", "/generate", body); document.getElementById("ph").outerHTML = tileHtml(r.item); bindTiles(res); costLine(); }
    catch (err) { document.getElementById("ph")?.remove(); throw err; }
  });
  drawMode(); bindTiles(document.getElementById("results")); watchPending(document.getElementById("results"));
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
async function gallery() {
  const { items } = await api("GET", "/gallery"); GALLERY = items;
  $app.innerHTML = `<div class="row spread"><h2>Gallery</h2><span class="muted small">${items.length} creation${items.length === 1 ? "" : "s"} · private to you</span></div>
    <div class="results" id="results">${items.length ? items.map(tileHtml).join("") : '<div class="empty" style="grid-column:1/-1">Nothing here yet. <a href="#/create">Create your first frame</a>.</div>'}</div>`;
  bindTiles(document.getElementById("results")); watchPending(document.getElementById("results"));
}
function bindTiles(root) {
  root.querySelectorAll(".tile-img[data-id]").forEach((t) => (t.onclick = () => openItem(t.dataset.id)));
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
async function openItem(id) {
  const { item: it } = await api("GET", `/gallery/${id}`);
  const ov = document.createElement("div"); ov.className = "modal";
  const isImg = it.kind === "image";
  ov.innerHTML = `<div class="panel" role="dialog" aria-label="Creation">
    <div class="media">${isImg ? `<img src="${esc(it.url)}" alt=""/>` : it.url ? `<video src="${esc(it.url)}" controls autoplay loop playsinline></video>` : `<img src="${esc(it.posterUrl)}" alt=""/><p class="notice">${it.status === "failed" ? "Animation failed: " + esc(it.error || "") : "Still animating…"}</p>`}</div>
    <div>
      <div class="row spread"><span class="kicker">${esc(it.kind === "video" ? "clip" : it.mode || "image")} · ${esc(it.style || "")}</span><button class="btn ghost small" id="x">Close ✕</button></div>
      <p style="margin:14px 0">${esc(it.prompt || "No prompt")}</p>
      <p class="small muted">${new Date(it.created * 1000).toLocaleString()} · AI-generated</p>
      <div class="grid" style="margin-top:14px">
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
  const close = () => ov.remove();
  ov.onclick = (e) => { if (e.target === ov) close(); };
  ov.querySelector("#x").onclick = close;
  ov.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => busy(b, async () => {
    const act = b.dataset.act;
    if (act === "removebg" || act === "upscale") { await api("POST", `/tools/${act}`, { itemId: it.id }); toast(act === "removebg" ? "Background removed. Saved to gallery." : "Upscaled. Saved to gallery."); close(); route(); }
    if (act === "animate") { await api("POST", "/animate", { itemId: it.id, prompt: ov.querySelector("#motion").value }); toast("Animating. This takes 1 to 3 minutes."); close(); location.hash = "#/gallery"; route(); }
    if (act === "sketch" || act === "photo") { const b64 = await urlToB64(it.url); S.mode = act; if (act === "photo") S.photo = b64; else PAD = null; close(); location.hash = "#/create"; if (act === "sketch") setTimeout(() => loadIntoPad(b64), 400); }
    if (act === "delete") { if (!confirm("Delete this creation?")) return; await api("DELETE", `/gallery/${it.id}`); close(); route(); }
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
const MG = { layout: "grid", title: "", panels: [] };
async function manga() {
  const { items } = await api("GET", "/gallery"); const imgs = items.filter((i) => i.kind === "image");
  const L = LAYOUTS[MG.layout];
  while (MG.panels.length < 4) MG.panels.push({ id: null, url: null, text: "" });
  $app.innerHTML = `<div class="row spread"><h2>Manga page</h2><span class="muted small">Free · everything happens in your browser</span></div>
  <div class="manga"><div class="card">
    <label style="margin-top:0">Layout</label><div class="chips">${Object.entries(LAYOUTS).map(([k, l]) => `<button data-lay="${k}" class="${MG.layout === k ? "on" : ""}">${l.name}</button>`).join("")}</div>
    <label>Page title</label><input id="mt" value="${esc(MG.title)}" placeholder="Chapter 1: The Rooftop"/>
    <label>Panels</label>${L.panels.map((_, i) => `<div class="slot"><div class="thumb" data-slot="${i}" style="${MG.panels[i].url ? `background-image:url('${esc(MG.panels[i].url)}')` : ""}">${MG.panels[i].url ? "" : "+ pick"}</div><input data-text="${i}" value="${esc(MG.panels[i].text)}" placeholder="Speech bubble (optional)"/></div>`).join("")}
    <button class="btn big gen" id="mdl">⬇ Download page (PNG)</button>
    ${imgs.length ? "" : '<p class="small muted">Create some frames first. They will show up here.</p>'}
  </div><div><canvas id="page" width="${L.w}" height="${L.h}"></canvas></div></div>`;
  $app.querySelectorAll("[data-lay]").forEach((b) => (b.onclick = () => { MG.layout = b.dataset.lay; manga(); }));
  document.getElementById("mt").oninput = (e) => { MG.title = e.target.value; paint(); };
  $app.querySelectorAll("[data-text]").forEach((i) => (i.oninput = () => { MG.panels[+i.dataset.text].text = i.value; paint(); }));
  $app.querySelectorAll("[data-slot]").forEach((el) => (el.onclick = () => pickFrame(imgs, (it) => { MG.panels[+el.dataset.slot] = { ...MG.panels[+el.dataset.slot], id: it.id, url: it.url }; manga(); })));
  document.getElementById("mdl").onclick = () => { const c = document.getElementById("page"); try { const a = document.createElement("a"); a.download = (MG.title || "banime-page") + ".png"; a.href = c.toDataURL("image/png"); a.click(); } catch { toast("Couldn't export this page. Try re-picking the frames.", true); } };
  const cache = {};
  const load = (u) => cache[u] || (cache[u] = new Promise((res) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = () => res(null); i.src = u; }));
  async function paint() {
    const c = document.getElementById("page"); if (!c) return; const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#111"; g.font = "64px Anton, Impact, sans-serif"; g.textBaseline = "top"; g.fillText((MG.title || "BANIME").toUpperCase(), 40, 40);
    g.font = "900 26px 'Noto Sans JP', sans-serif"; g.fillStyle = "#ff4d8f"; g.textAlign = "right"; g.fillText("バニメ", c.width - 40, 56); g.textAlign = "left";
    for (const [i, [x, y, w, h]] of L.panels.entries()) {
      const p = MG.panels[i]; const img = p?.url ? await load(p.url) : null;
      g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
      if (img) { const s = Math.max(w / img.width, h / img.height); g.drawImage(img, x + (w - img.width * s) / 2, y + (h - img.height * s) / 2, img.width * s, img.height * s); }
      else { g.fillStyle = "#eee"; g.fillRect(x, y, w, h); g.fillStyle = "#aaa"; g.font = "28px Inter, sans-serif"; g.fillText(`Panel ${i + 1}`, x + 24, y + 24); }
      g.restore(); g.lineWidth = 8; g.strokeStyle = "#111"; g.strokeRect(x, y, w, h);
      if (p?.text) bubble(g, p.text, x + 24, y + 24, Math.min(w * 0.62, 460));
    }
  }
  function bubble(g, text, x, y, maxW) {
    g.font = "600 30px Inter, sans-serif"; const words = text.split(/\s+/); const lines = []; let line = "";
    for (const w of words) { const t = line ? line + " " + w : w; if (g.measureText(t).width > maxW - 40 && line) { lines.push(line); line = w; } else line = t; }
    lines.push(line); const bw = Math.min(maxW, Math.max(...lines.map((l) => g.measureText(l).width)) + 44), bh = lines.length * 38 + 30;
    g.fillStyle = "#fff"; g.strokeStyle = "#111"; g.lineWidth = 4; g.beginPath(); g.roundRect(x, y, bw, bh, 28); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(x + 40, y + bh - 2); g.lineTo(x + 30, y + bh + 30); g.lineTo(x + 70, y + bh - 2); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = "#111"; lines.forEach((l, i) => g.fillText(l, x + 22, y + 16 + i * 38));
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

// ------------------------------------------------------------------ account
async function account() {
  await loadMe(); const { entries } = await api("GET", "/me/ledger");
  $app.innerHTML = `<h2>Account</h2><div class="grid" style="grid-template-columns:minmax(260px,1fr) 2fr">
    <div class="card"><div class="muted small">Signed in as</div><b>${esc(ME.email || ME.name)}</b>
      <div class="muted small" style="margin-top:16px">Credits</div><div style="font:400 3rem var(--mega);color:var(--gold)">${ME.credits}</div>
      <table class="small">${Object.entries({ "Image (fast/detailed)": "text:core", "Image (ultra)": "text:ultra", "Character / sketch / photo": "sketch", "Remove background": "removebg", "Upscale 4×": "upscale", "Animate 5 s": "animate" }).map(([n, k]) => `<tr><td>${n}</td><td>${cost(k)}✦</td></tr>`).join("")}<tr><td>Prompt assist</td><td>free</td></tr></table>
      <button class="btn ghost" style="width:100%;margin-top:16px" id="out">Sign out</button></div>
    <div class="card"><h3>History</h3><table><tr><th>When</th><th>What</th><th>Change</th><th>Balance</th></tr>
      ${entries.map((e) => `<tr><td>${new Date(e.ts * 1000).toLocaleString()}</td><td>${esc(e.reason)}</td><td style="color:${e.delta < 0 ? "var(--red)" : "var(--cyan)"}">${e.delta > 0 ? "+" : ""}${e.delta}</td><td>${e.balance}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">No activity yet.</td></tr>'}</table></div></div>`;
  if (innerWidth < 960) $app.querySelector(".grid").style.gridTemplateColumns = "1fr";
  document.getElementById("out").onclick = () => auth.logout();
}

// ------------------------------------------------------------------ router
async function route() {
  const h = location.hash || "#/";
  try {
    if (!auth.signedIn || h === "#/" || h === "#auth") {
      if (auth.signedIn && h === "#/") { location.hash = "#/create"; return; }
      renderNav(); return landing();
    }
    document.body.classList.remove("is-landing", "scrolled"); heroCleanup?.(); heroCleanup = null;
    if (!ME) await loadMe(); else renderNav();
    $app.innerHTML = '<p class="muted"><span class="spinner"></span> Loading…</p>';
    if (h.startsWith("#/create")) return await create();
    if (h.startsWith("#/gallery")) return await gallery();
    if (h.startsWith("#/characters")) return await characters();
    if (h.startsWith("#/manga")) return await manga();
    if (h.startsWith("#/account")) return await account();
    location.hash = "#/create";
  } catch (e) { $app.innerHTML = `<div class="card"><h2>Something went wrong</h2><p class="muted">${esc(e.message)}</p></div>`; }
}
addEventListener("hashchange", route);
(async () => { try { await auth.handleRedirect(); } catch (e) { toast(e.message, true); } route(); })();
