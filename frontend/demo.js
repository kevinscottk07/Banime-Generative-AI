// Offline demo backend: same routes as the real API, in-memory, never bills anything.
const BG = { shonen: ["#ff6a3d", "#7c1d6f"], slice: ["#9be7c4", "#3a7bd5"], retro90: ["#f7b267", "#5f0f40"], cyber: ["#ff2a8a", "#1b0b3a"],
  chibi: ["#ffd1e2", "#b8a1ff"], manga: ["#f5f5f5", "#2b2b2b"], mecha: ["#5c6b7a", "#0f1a2b"], fantasy: ["#4b134f", "#0b0614"] };
const DIM = { "1:1": [1024, 1024], "2:3": [832, 1248], "9:16": [720, 1280], "16:9": [1280, 720], "3:2": [1248, 832], "21:9": [1536, 658] };
let n = 0;
// Demo frames reuse the sample art made with Banime (one per style).
function art(prompt, style = "shonen") {
  n++;
  return `${(window.BANIME_CONFIG || {}).artBase || "/art/"}style-${BG[style] ? style : "shonen"}.jpg`;
}
const S = { credits: 120, ledger: [], items: [], chars: [], projects: [], pages: [], name: "Demo", prefs: {} };
const PACKS = { starter: { name: "Starter", credits: 100, cents: 1500 }, creator: { name: "Creator", credits: 400, cents: 4900 }, studio: { name: "Studio", credits: 1000, cents: 10900 } };
const now = () => Math.floor(Date.now() / 1000);
const id = (p) => p + Date.now().toString(16) + Math.random().toString(16).slice(2, 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COST = { "text:core": 1, "text:sd35": 1, "text:ultra": 2, character: 1, sketch: 1, photo: 1, "character:create": 1, removebg: 1, upscale: 1, animate: 38, enhance: 0 };
function spend(k, why) { const c = COST[k]; if (S.credits < c) { const e = new Error("Not enough credits for this."); e.code = "credits"; throw e; } S.credits -= c; S.ledger.unshift({ ts: now(), delta: -c, reason: why + " (demo)", balance: S.credits }); return c; }
const ok = (x) => JSON.parse(JSON.stringify({ ...x, credits: S.credits }));

export async function demoApi(method, path, body = {}) {
  await sleep(300);
  if (path === "/me" && method === "PATCH") { if (body.name) S.name = body.name; Object.assign(S.prefs, body.prefs || {}); return { profile: { name: S.name, prefs: S.prefs } }; }
  if (path === "/me" && method === "DELETE") { throw new Error("Demo accounts can't be deleted. Sign in to use this."); }
  if (path === "/me") return { userId: "demo", email: "demo@banime.app", name: S.name, prefs: S.prefs, isAdmin: false, canAnimate: true, credits: S.credits, costs: COST, creditUsd: 0.1, packs: PACKS, billingEnabled: false };
  if (path === "/me/export") return { demo: true, items: S.items, characters: S.chars, projects: S.projects, pages: S.pages, ledger: S.ledger };
  if (path === "/billing/checkout") { const e = new Error("Payments open soon."); throw e; }
  const urlOf = (iid) => S.items.find((i) => i.id === iid)?.url || null;
  const pview = (g) => ({ ...g, panels: g.panels.map((p) => ({ ...p, url: urlOf(p.itemId) })) });
  if (path === "/projects" && method === "GET") return { projects: S.projects.map((p) => { const mine = S.items.filter((i) => i.projectId === p.id); return { ...p, itemCount: mine.length, pageCount: S.pages.filter((g) => g.projectId === p.id).length, coverUrl: mine.find((i) => i.kind === "image")?.url || null }; }) };
  if (path === "/projects" && method === "POST") { if (!body.name?.trim()) throw new Error("Give the project a name."); const p = { id: "p" + Math.random().toString(16).slice(2, 14).padEnd(12, "0"), name: body.name.trim(), description: body.description || "", created: now() }; S.projects.unshift(p); return { project: p }; }
  if (path.startsWith("/projects/")) {
    const p = S.projects.find((x) => x.id === path.split("/")[2]); if (!p) throw new Error("Project not found.");
    if (method === "PATCH") { Object.assign(p, body); return { project: p }; }
    if (method === "DELETE") { S.projects = S.projects.filter((x) => x !== p); S.items.forEach((i) => { if (i.projectId === p.id) i.projectId = null; }); S.pages.forEach((g) => { if (g.projectId === p.id) g.projectId = null; }); return { deleted: p.id }; }
    return { project: p, items: S.items.filter((i) => i.projectId === p.id), pages: S.pages.filter((g) => g.projectId === p.id) };
  }
  if (path === "/pages" && method === "GET") return { pages: S.pages.map(pview) };
  if (path === "/pages" && method === "POST") { const g = { ...body, id: "g" + Math.random().toString(16).slice(2, 14).padEnd(12, "0"), created: now() }; S.pages.unshift(g); return { page: pview(g) }; }
  if (path.startsWith("/pages/")) { const g = S.pages.find((x) => x.id === path.split("/")[2]); if (!g) throw new Error("Page not found."); if (method === "DELETE") { S.pages = S.pages.filter((x) => x !== g); return { deleted: g.id }; } Object.assign(g, body); return { page: pview(g) }; }
  if (path === "/me/ledger") return { entries: S.ledger };
  if (path === "/enhance") { await sleep(700); return { prompt: `${body.prompt.trim()}, standing on a windswept rooftop at golden hour, cherry petals swirling, determined expression, dramatic low angle, city skyline glowing behind`, title: "Rooftop Resolve" }; }
  if (path === "/generate") {
    const k = body.mode === "text" ? `text:${body.model}` : body.mode; spend(k, body.mode); await sleep(1100);
    const char = S.chars.find((c) => c.id === body.characterId);
    const it = { id: id("i"), kind: "image", mode: body.mode, style: body.style, projectId: body.projectId || null, aspect: body.mode === "text" || body.mode === "character" ? body.aspect : "1:1", prompt: body.prompt, created: now() };
    it.url = art(body.prompt, body.style, it.aspect, char ? `${char.name}: ${body.prompt}` : ""); S.items.unshift(it); return ok({ item: it });
  }
  if (path === "/gallery" && method === "GET") return { items: S.items };
  if (path.startsWith("/gallery/")) {
    const it = S.items.find((i) => i.id === path.split("/")[2]); if (!it) throw new Error("Not found.");
    if (method === "DELETE") { S.items = S.items.filter((i) => i !== it); return { deleted: it.id }; }
    if (method === "PATCH") { Object.assign(it, body); return { item: it }; }
    if (path.endsWith("/share")) { it.shareId = body.on ? "s" + Math.random().toString(16).slice(2, 14) : null; return { item: it }; }
    if (it.kind === "video" && it.status === "rendering" && Date.now() - it.t0 > 9000) { it.status = "failed"; it.error = "Demo mode doesn't render real video. Sign in to animate with Luma Ray2."; S.credits += 38; }
    return ok({ item: it });
  }
  if (path.startsWith("/tools/")) {
    const t = path.split("/")[2]; const src = S.items.find((i) => i.id === body.itemId); spend(t, t); await sleep(900);
    const it = { ...src, id: id("i"), mode: t, parentId: src.id, created: now() }; S.items.unshift(it); return ok({ item: it });
  }
  if (path === "/animate") {
    const src = S.items.find((i) => i.id === body.itemId); spend("animate", "animate");
    const it = { id: id("i"), kind: "video", status: "rendering", posterUrl: src.url, prompt: body.prompt, created: now(), t0: Date.now() }; S.items.unshift(it); return ok({ item: it });
  }
  if (path === "/characters" && method === "GET") return { characters: S.chars };
  if (path === "/characters" && method === "POST") {
    if (!body.name || !body.look) throw new Error("Give your character a name and a description.");
    if (!body.imageBase64) spend("character:create", "character"); await sleep(900);
    const c = { id: id("c"), name: body.name, look: body.look, style: body.style, url: body.imageBase64 || art(body.look, body.style, "2:3", body.name), created: now() };
    S.chars.unshift(c); return ok({ character: c });
  }
  if (path.startsWith("/characters/") && method === "DELETE") { S.chars = S.chars.filter((c) => c.id !== path.split("/")[2]); return { deleted: true }; }
  throw new Error("Not found.");
}
