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
const STYLE_BG = { shonen: "linear-gradient(160deg,#ff6a3d,#7c1d6f)", slice: "linear-gradient(160deg,#9be7c4,#3a7bd5)", retro90: "linear-gradient(160deg,#f7b267,#5f0f40)",
  cyber: "linear-gradient(160deg,#ff2a8a,#1b0b3a 70%,#22d3ee)", chibi: "linear-gradient(160deg,#ffd1e2,#b8a1ff)", manga: "linear-gradient(160deg,#f5f5f5,#2b2b2b)",
  mecha: "linear-gradient(160deg,#5c6b7a,#0f1a2b)", fantasy: "linear-gradient(160deg,#4b134f,#0b0614 70%,#c94b4b)" };
const ASPECTS = [["1:1", "Square"], ["2:3", "Portrait"], ["9:16", "Story"], ["16:9", "Wide"], ["3:2", "Landscape"], ["21:9", "Cinema"]];
const cost = (k) => ME?.costs?.[k] ?? 1;

// ------------------------------------------------------------------ landing
let heroCleanup = null;
const MODES = [
  ["Create", "Type an idea. Pick a look: Shonen, 90s cel, Cyberpunk, Chibi and more. Nova polishes your prompt in one tap.", "Stable Image Core · SD 3.5 · Ultra"],
  ["Character lock", "Design a character once. Every new scene matches their face, hair and outfit from the reference sheet.", "Stability Style Guide"],
  ["Sketch → Anime", "Scribble on the pad with your finger or mouse. Banime keeps your composition and inks it.", "Stability Control Sketch"],
  ["Photo → Anime", "Turn a photo, a pet or a place into an anime frame that keeps the original's structure.", "Stability Control Structure"],
  ["Animate", "Bring any frame to life: wind in the hair, drifting petals, a slow camera move.", "Luma Ray2 · 5 s"],
  ["Manga page", "Drop frames into 4-koma or grid layouts, add speech bubbles and export a page.", "In-browser, free"],
  ["Polish", "Cut out backgrounds for stickers or upscale to print size.", "Remove BG · 4× Upscale"],
];

function landing() {
  document.body.classList.add("is-landing");
  $app.innerHTML = `
  <section class="hero">
    <canvas class="hero-gl" aria-hidden="true"></canvas>
    <div class="petals" aria-hidden="true">${Array.from({ length: 22 }, (_, i) => `<i style="left:${(i * 47) % 100 + 4}%;animation-duration:${9 + (i * 7) % 11}s;animation-delay:-${(i * 13) % 17}s;transform:scale(${0.6 + (i % 5) / 6})"></i>`).join("")}</div>
    <div class="kanji" aria-hidden="true">アニメ</div>
    <div class="hero-copy">
      <div class="kicker">✿ Banime · your anime studio</div>
      <h1 class="mega"><span class="line">Draw it.</span><span class="line">Make it <em>anime.</em></span><span class="line outline">Make it move.</span></h1>
      <p class="lead">Ideas, sketches and photos become anime art with characters that stay on-model, manga pages, and short animated clips. Built on AWS.</p>
      <div class="row cta-row">
        <a href="#auth" class="btn big" data-go="auth">Start creating, it's free →</a>
        <a href="?demo#/create" class="btn ghost big">Try the demo</a>
      </div>
      <div class="stickers"><div class="sticker"><b>8</b><span>Styles</span></div><div class="sticker"><b>5s</b><span>Animate</span></div><div class="sticker"><b>4×</b><span>Upscale</span></div><div class="sticker"><b>30</b><span>Free ✦</span></div></div>
    </div>
    <div class="hud" aria-hidden="true">
      <div class="callout c1"><i></i><b>Character lock</b><span>Same face, every scene</span></div>
      <div class="callout c2"><i></i><b>Sketch → anime</b><span>Your lines, inked</span></div>
      <div class="callout c3"><i></i><b>Animate</b><span>Luma Ray2 clips</span></div>
      <div class="callout c4"><i></i><b>Prompt assist</b><span>Amazon Nova</span></div>
    </div>
  </section>
  <div class="marquee" aria-hidden="true"><div class="track">${"CREATE ✿ <span class='jp'>アニメ</span> ✿ CHARACTER LOCK ✿ SKETCH TO ANIME ✿ PHOTO TO ANIME ✿ ANIMATE ✿ MANGA PAGES ✿ ".repeat(4)}</div></div>
  <div class="marquee alt" aria-hidden="true"><div class="track">${"SHONEN ✦ SLICE OF LIFE ✦ 90S CEL ✦ CYBERPUNK ✦ CHIBI ✦ MANGA INK ✦ MECHA ✦ DARK FANTASY ✦ ".repeat(4)}</div></div>

  <section class="modes-scroll">
    <div class="sticky">
      <div class="mode-left">
        <div class="kicker">The studio</div>
        <div class="bignum" id="mnum">01</div>
        <h2 class="mode-title" id="mtitle">${MODES[0][0]}</h2>
        <p class="lead" id="mdesc">${MODES[0][1]}</p>
        <div class="chip" id="mchip">${MODES[0][2]}</div>
      </div>
      <ol class="rail">${MODES.map((m, i) => `<li data-i="${i}" class="${i ? "" : "on"}"><span>${String(i + 1).padStart(2, "0")}</span>${m[0]}</li>`).join("")}</ol>
    </div>
    ${MODES.map((_, i) => `<div class="mode-step" data-i="${i}"></div>`).join("")}
  </section>

  <section class="styles-strip reveal">
    <div class="kicker">Eight looks</div><h2>Pick a style. Change it any time.</h2>
    <div class="style-cards">${STYLES.map(([k, n, jp]) => `<div class="style-card" data-jp="${jp}" style="background:${STYLE_BG[k]}"><span>${k.toUpperCase()}</span><b>${n}</b></div>`).join("")}</div>
  </section>

  <section class="bento reveal">
    <div class="tile t-wide"><div class="kicker">Consistent characters</div><h3>Same hero. Every panel.</h3><p class="muted">Create a character once and Banime keeps their look across scenes, outfits and angles, using the reference sheet as a style guide.</p></div>
    <div class="tile"><div class="kicker">Safe by design</div><h3>Guardrails on</h3><p class="muted">Amazon Bedrock Guardrails and model filters block explicit content, real-person deepfakes and hate.</p></div>
    <div class="tile"><div class="kicker">Your data</div><h3>Private gallery</h3><p class="muted">Everything you make is stored in your private gallery, and only you can open it.</p></div>
    <div class="tile"><div class="kicker">One login</div><h3>Google or email</h3><p class="muted">Sign in with Google in one tap, or use email with a verification code.</p></div>
    <div class="tile"><div class="kicker">Fair credits</div><h3>Pay per frame</h3><p class="muted">Images from 1 credit. Failed generations are refunded automatically.</p></div>
    <div class="tile t-full stat"><div><b>8</b><span>Anime styles</span></div><div><b>4</b><span>Ways to create</span></div><div><b>$0</b><span>Idle cost, fully serverless</span></div><div><b>30</b><span>Free credits to start</span></div></div>
  </section>

  <section class="final-cta reveal" id="auth">
    <div><h2 class="mega" style="font-size:clamp(2.8rem,6vw,5.4rem)">Your first <em>30 frames</em><br/>are on us.</h2>
      <p class="lead">Sign in to get 30 free credits. No card needed.</p></div>
    <div class="card authcard">
      <h3>Join Banime</h3>
      ${CFG.google ? `<button class="btn google big" id="g-login"><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>Continue with Google</button><div class="or">or</div>` : ""}
      <button class="btn ${CFG.google ? "ghost" : ""} big" id="e-login">Continue with email</button>
      <p class="small muted" style="margin-top:12px">By continuing you agree to use Banime for original, non-explicit content.</p>
    </div>
  </section>`;
  document.getElementById("g-login")?.addEventListener("click", () => auth.login("Google"));
  document.getElementById("e-login").onclick = () => auth.login("COGNITO");
  bindScrollLinks($app);
  heroCleanup?.(); heroCleanup = null;
  import("./hero.js").then((m) => { heroCleanup = m.mountHero($app.querySelector(".hero-gl")); }).catch(() => $app.querySelector(".hero-gl")?.classList.add("nogl"));
  const set = (i) => {
    const [t, d, c] = MODES[i]; document.getElementById("mnum").textContent = String(i + 1).padStart(2, "0");
    document.getElementById("mtitle").textContent = t; document.getElementById("mdesc").textContent = d; document.getElementById("mchip").textContent = c;
    $app.querySelectorAll(".rail li").forEach((li) => li.classList.toggle("on", +li.dataset.i === i));
    const left = $app.querySelector(".mode-left"); left.classList.remove("swap"); void left.offsetWidth; left.classList.add("swap");
  };
  let cur = 0;
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting && +e.target.dataset.i !== cur) { cur = +e.target.dataset.i; set(cur); } }), { rootMargin: "-50% 0px -50% 0px" });
  $app.querySelectorAll(".mode-step").forEach((el) => io.observe(el));
  const rv = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add("in")), { threshold: .12 });
  $app.querySelectorAll(".reveal").forEach((el) => rv.observe(el));
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
      <label>Style</label><div class="chips" id="styles">${STYLES.map(([k, n]) => `<button data-style="${k}" class="${S.style === k ? "on" : ""}">${n}</button>`).join("")}</div>
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
