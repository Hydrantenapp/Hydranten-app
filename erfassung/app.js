/* Hydranten Erfassung – © 2026 Simone Loosen, Feuerwehr Kleve. Alle Rechte vorbehalten. Siehe LICENSE. */
/*
 * Minimal-App: nimmt NUR Position (Breiten-/Längengrad) und Nennweite eines Hydranten auf.
 * Sie hat keine Verbindung zur Datenbank der Hauptapp und teilt keinen Speicher mit ihr
 * (eigene IndexedDB "hydranten-erfassung"). Die Daten wandern nur per Excel-Datei in die Hauptapp.
 */
const DB_NAME = "hydranten-erfassung";
const DB_VER = 2;
const SUPABASE_URL = "https://icepfjtifsdbefrgilan.supabase.co";
const SUPABASE_KEY = "sb_publishable_oFDN741MtN1_XwVBj4ku8g_j7gqs29P"; // öffentlicher Schlüssel
const HELFER_EMAIL = "erfassung@lz-kleve.de"; // gemeinsamer Helfer-Zugang (darf nur Nachträge schreiben)
const EINHEITEN = [
  "LZ Kleve", "LZ Materborn", "LZ Kellen", "LZ Rindern",
  "LG Reichswalde", "LG Donsbrüggen", "LG Wardhausen-Brienen", "LG Griethausen",
  "LG Düffelward", "LG Keeken", "LG Schenkenschanz", "LG Warbeyen",
];
const MAX_ANZEIGE = 150;

let db = null;
const state = {
  liste: [],            // aus der Hauptapp geladene Hydranten (nur Stammdaten, schreibgeschützt)
  nachtrag: new Map(),  // key -> erfasste Werte
  meta: {},
  sb: null,
  remote: new Map(),    // key -> {lat, nw, helfer[]} von allen Helfern (Serverstand)
  sync: { laeuft: false, fehler: null, zuletzt: null },
  fEinheit: "", fBezirk: "",
  mapView: null,
  filter: "offen",
  suche: "",
  view: "home",         // home | erfassen | neu
  cur: null,            // Entwurf beim Erfassen
  geo: { watchId: null, best: null, last: null, fehler: null },
};

/* ---------- Hilfsfunktionen ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(showToast._t); showToast._t = setTimeout(() => t.classList.add("hidden"), 3200);
}
function schluessel(h) {
  const n = String(h.nrNeu || "").trim().toLowerCase();
  return n ? "n:" + n : "t:" + String(h.name || "").trim().toLowerCase() + "|" + String(h.nrAlt || "").trim().toLowerCase();
}
function hatPos(h) { return Number.isFinite(h.lat) && Number.isFinite(h.lng); }
function parseZahl(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v).trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function nennweiteNorm(v) {
  const z = String(v ?? "").trim().replace(/^H-?/i, "").replace(/[^0-9]/g, "");
  return z ? "H-" + z : "";
}
function fmtZeit(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

/* ---------- IndexedDB ---------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("liste")) d.createObjectStore("liste", { keyPath: "key" });
      if (!d.objectStoreNames.contains("nachtrag")) d.createObjectStore("nachtrag", { keyPath: "key" });
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta", { keyPath: "k" });
      if (!d.objectStoreNames.contains("remote")) d.createObjectStore("remote", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idb(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && "onsuccess" in r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const idbAll = (store) => idb(store, "readonly", (s) => s.getAll());
const idbPut = (store, obj) => idb(store, "readwrite", (s) => s.put(obj));
const idbDel = (store, key) => idb(store, "readwrite", (s) => s.delete(key));
async function idbReplaceAll(store, arr) {
  await idb(store, "readwrite", (s) => { s.clear(); arr.forEach((o) => s.put(o)); });
}
async function setMeta(k, v) { state.meta[k] = v; await idbPut("meta", { k, v }); }

async function laden() {
  state.liste = await idbAll("liste");
  state.nachtrag = new Map((await idbAll("nachtrag")).map((n) => [n.key, n]));
  state.meta = Object.fromEntries((await idbAll("meta")).map((m) => [m.k, m.v]));
  baueRemote(await idbAll("remote"));
}
function baueRemote(rows) {
  const m = new Map();
  for (const r of rows) {
    if (r.status === "verworfen") continue;
    const e = m.get(r.key) || { lat: false, nw: false, helfer: [] };
    if (Number.isFinite(r.lat)) e.lat = true;
    if (r.nennweite) e.nw = true;
    if (r.helfer && !e.helfer.includes(r.helfer)) e.helfer.push(r.helfer);
    m.set(r.key, e);
  }
  state.remote = m;
}

/* ---------- Auswertung ---------- */
function offenInfo(h) {
  const n = state.nachtrag.get(h.key);
  const r = state.remote.get(h.key);
  const posOk = hatPos(h) || (n && Number.isFinite(n.lat)) || !!(r && r.lat);
  const nwOk = !!h.nennweite || (n && !!n.nennweite) || !!(r && r.nw);
  return { n, r, posOk, nwOk, offen: !posOk || !nwOk };
}
function sichtbareListe() {
  const q = state.suche.trim().toLowerCase();
  return state.liste.filter((h) => {
    const info = offenInfo(h);
    if (state.filter === "offen" && !info.offen) return false;
    if (state.filter === "erfasst" && !info.n && !info.r) return false;
    if (state.fEinheit && h.einheit !== state.fEinheit) return false;
    if (state.fBezirk && h.bezirk !== state.fBezirk) return false;
    if (!q) return true;
    return [h.name, h.nrNeu, h.nrAlt, h.einheit, h.bezirk].some((x) => String(x || "").toLowerCase().includes(q));
  }).sort((a, b) => String(a.name).localeCompare(String(b.name), "de"));
}
function nichtExportiert() {
  let n = 0;
  state.nachtrag.forEach((e) => { if (!e.exportiert || e.geaendert > e.exportiert) n++; });
  return n;
}
function ungesendet() {
  let n = 0;
  state.nachtrag.forEach((e) => { if (!e.gesendet || e.geaendert > e.gesendet) n++; });
  return n;
}
const angemeldet = () => !!state.meta.angemeldet;
function werte(feld) { return [...new Set(state.liste.map((h) => h[feld]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), "de", { numeric: true })); }

/* ---------- Ansichten ---------- */
function render() {
  const el = document.getElementById("content");
  if (!angemeldet() && !state.meta.lokal) { el.innerHTML = renderLogin(); bindLogin(); return; }
  if (state.view === "erfassen") el.innerHTML = renderErfassen();
  else el.innerHTML = renderHome();
  bindView();
}

function renderHome() {
  const offen = state.liste.filter((h) => offenInfo(h).offen).length;
  const sicht = sichtbareListe();
  const zeigen = sicht.slice(0, MAX_ANZEIGE);
  const geladen = state.meta.listeGeladen ? `${esc(state.meta.listeName || "Datei")} · ${fmtZeit(state.meta.listeGeladen)}` : "noch keine Liste geladen";
  return `
    <div class="stats">
      <div class="stat"><b>${state.liste.length}</b><span>in der Liste</span></div>
      <div class="stat"><b>${offen}</b><span>offen</span></div>
      <div class="stat"><b>${state.nachtrag.size}</b><span>von mir erfasst</span></div>
      <div class="stat"><b>${angemeldet() ? ungesendet() : nichtExportiert()}</b><span>${angemeldet() ? "nicht gesendet" : "nicht exportiert"}</span></div>
    </div>

    ${angemeldet() ? `<div class="card">
      <h3>Helfer: ${esc(state.meta.helfer || "")}</h3>
      <p class="note" id="sync-info">${syncText()}</p>
      <div class="row"><button class="btn" id="btn-sync">Jetzt abgleichen</button><button class="btn btn-ghost" id="btn-abmelden">Abmelden</button></div>
    </div>` : `<div class="warn">Nur lokaler Betrieb: Es wird nichts an den Server gesendet. Bitte regelmäßig als Excel exportieren. <button class="btn" id="btn-zum-login">Anmelden</button></div>`}

    <div class="card">
      <h3>1. Hydrantenliste laden</h3>
      <p class="note">Excel-Export aus der Hauptapp (Daten → Als Excel exportieren). Die Liste wird nur zum Aussuchen verwendet und nie zurückgeschrieben.<br>Stand: ${geladen}</p>
      <button class="btn" id="btn-liste">Liste aus Excel laden</button>
    </div>

    <div class="card">
      <h3>2. Erfassen</h3>
      <div class="chips">
        <button class="chip" data-filter="offen" data-active="${state.filter === "offen"}">Offen</button>
        <button class="chip" data-filter="erfasst" data-active="${state.filter === "erfasst"}">Erfasst</button>
        <button class="chip" data-filter="alle" data-active="${state.filter === "alle"}">Alle</button>
      </div>
      <div class="row">
        <select id="f-einheit"><option value="">Alle Einheiten</option>${werte("einheit").map((v) => `<option ${state.fEinheit === v ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>
        <select id="f-bezirk"><option value="">Alle Bezirke</option>${werte("bezirk").map((v) => `<option ${state.fBezirk === v ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>
      </div>
      <input type="search" id="suche" style="margin-top:8px" placeholder="Name, Nummer, Einheit suchen" value="${esc(state.suche)}" />
      <div style="margin-top:10px;">
        ${zeigen.length === 0 ? `<p class="note">${state.liste.length === 0 ? "Noch keine Hydranten geladen. Bitte oben die Liste aus Excel laden." : "Nichts in dieser Auswahl."}</p>` : zeigen.map(itemHTML).join("")}
        ${sicht.length > MAX_ANZEIGE ? `<p class="note">${sicht.length - MAX_ANZEIGE} weitere – Suche eingrenzen.</p>` : ""}
      </div>
    </div>

    <div class="card">
      <h3>${angemeldet() ? "3. Sicherung (optional)" : "3. Exportieren"}</h3>
      <p class="note">${angemeldet() ? "Die Erfassungen gehen automatisch an den Server und sind in der Hauptapp unter Daten abrufbar. Die Excel-Datei ist nur eine zusätzliche Sicherung." : "Erzeugt eine Excel-Datei mit allen erfassten Werten. Diese Datei in der Hauptapp unter Daten → „Nachtrag importieren“ einlesen (App-Admin)."}${state.meta.letzterExport ? `<br>Letzter Export: ${fmtZeit(state.meta.letzterExport)}` : ""}</p>
      <button class="btn btn-primary" id="btn-export" ${state.nachtrag.size === 0 ? "disabled" : ""}>Export als Excel (${state.nachtrag.size})</button>
    </div>

    <p class="note">${angemeldet()
      ? "Erfassungen werden automatisch an den Server gesendet, sobald Netz da ist, und sind dann in der Hauptapp abrufbar. Bis oben „Alles gesendet“ steht, liegen sie nur auf diesem Gerät. Browser-Daten dieser App bis dahin nicht löschen."
      : "Ohne Anmeldung speichert diese App nur auf diesem Gerät. Browser-Daten erst löschen, wenn alles exportiert ist."}</p>
  `;
}

function itemHTML(h) {
  const { n, r, posOk, nwOk } = offenInfo(h);
  const nr = h.nrNeu ? `Nr. ${esc(h.nrNeu)}` : "keine neue Nr.";
  const alt = h.nrAlt ? ` (alt: ${esc(h.nrAlt)})` : "";
  const ort = [h.einheit, h.bezirk ? "Bez. " + h.bezirk : ""].filter(Boolean).map(esc).join(" · ");
  const fremd = r && r.helfer.length ? ` (${esc(r.helfer.join(", "))})` : "";
  const posTag = hatPos(h) ? `<span class="tag ok">Position vorhanden</span>` : (n && Number.isFinite(n.lat) ? `<span class="tag done">Position erfasst</span>` : (r && r.lat ? `<span class="tag done">Position erfasst${fremd}</span>` : `<span class="tag miss">Position fehlt</span>`));
  const nwTag = h.nennweite ? `<span class="tag ok">${esc(h.nennweite)}</span>` : (n && n.nennweite ? `<span class="tag done">${esc(n.nennweite)} erfasst</span>` : (r && r.nw ? `<span class="tag done">Nennweite erfasst${fremd}</span>` : `<span class="tag miss">Nennweite fehlt</span>`));
  return `<div class="item" data-key="${esc(h.key)}">
    <div class="item-name">${esc(h.name)}</div>
    <div class="item-sub">${nr}${alt}${ort ? " · " + ort : ""}</div>
    <div class="tags">${posTag}${nwTag}</div>
  </div>`;
}

function renderErfassen() {
  const c = state.cur;
  const g = state.geo;
  const nr = c.nrNeu ? `Nr. ${esc(c.nrNeu)}` : "keine neue Nr.";
  const alt = c.nrAlt ? ` (alt: ${esc(c.nrAlt)})` : "";
  const ort = [c.einheit, c.bezirk ? "Bez. " + c.bezirk : ""].filter(Boolean).map(esc).join(" · ");
  const vorhanden = c.vorhandenPos ? `<div class="warn">In der Hauptapp ist bereits eine Position eingetragen (<span class="coord">${c.vorhandenLat.toFixed(6)}, ${c.vorhandenLng.toFixed(6)}</span>). Die Hauptapp überschreibt sie nur nach Rückfrage.</div>` : "";
  const nwVorhanden = c.vorhandenNw ? `<div class="warn">In der Hauptapp steht bereits die Nennweite ${esc(c.vorhandenNw)}.</div>` : "";
  const messung = g.watchId !== null;
  const live = g.last
    ? `Aktuell ±${Math.round(g.last.acc)} m · Beste ±${Math.round(g.best.acc)} m`
    : (g.fehler ? esc(g.fehler) : (messung ? "Warte auf GPS-Signal…" : "Noch keine Messung."));
  return `
    <button class="back" id="btn-zurueck">‹ Zurück</button>
    <h2>${esc(c.name)}</h2>
    <p class="sub">${nr}${alt}${ort ? " · " + ort : ""}</p>
    ${vorhanden}${nwVorhanden}

    <div class="card">
      <h3>Nennweite</h3>
      <div class="nw ${nwPflicht(c) && !c.nennweite ? "nw-leer" : ""}" id="nw-box"><span>H-</span><input type="text" id="e-nw" inputmode="numeric" value="${esc(String(c.nennweite || "").replace(/^H-?/i, ""))}" placeholder="Zahl eintragen" /></div>
      <p class="nw-hinweis" id="nw-hinweis" ${nwPflicht(c) && !c.nennweite ? "" : "hidden"}>Pflichtfeld: Nennweite eintragen, dann kann gespeichert werden.</p>
    </div>

    <div class="card">
      <h3>Karte</h3>
      <p class="note">Während der Messung springt der Pin automatisch auf die beste GPS-Position. Nach „Messung beenden“ kannst du die Karte antippen oder den Pin ziehen, um ihn genau auf den Hydranten zu setzen. Der blaue Kreis zeigt, wo das GPS dich vermutet.</p>
      <div id="karte"></div>
      <div class="row">
        <button class="btn ${messung ? "btn-danger" : "btn-primary"}" id="btn-geo">${messung ? "Messung beenden" : "📍 Messung starten"}</button>
        <button class="btn" id="btn-geo-take" ${g.best ? "" : "disabled"}>Position übernehmen</button>
      </div>
      <div class="geo-live" id="geo-live">${live}</div>
    </div>

    <div class="card">
      <h3>Position</h3>
      <p class="note">Entweder die Karte antippen bzw. den Pin ziehen und „Position übernehmen“ tippen, oder am Hydranten die Messung starten (am besten unter 10 m Genauigkeit). Nach „Messung beenden“ lässt sich der Pin noch verschieben.</p>
      <div class="row">
        <div style="flex:1"><label class="lbl">Breitengrad</label><input type="text" id="e-lat" inputmode="decimal" value="${c.lat ?? ""}" placeholder="51.78…" /></div>
        <div style="flex:1"><label class="lbl">Längengrad</label><input type="text" id="e-lng" inputmode="decimal" value="${c.lng ?? ""}" placeholder="6.13…" /></div>
      </div>
      <p class="note" id="e-pos-info">${c.zeit && Number.isFinite(c.acc) ? `Übernommen ${fmtZeit(c.zeit)}, Genauigkeit ±${Math.round(c.acc)} m.` : (c.zeit ? `Per Pin gesetzt ${fmtZeit(c.zeit)}.` : "")}</p>
    </div>

    <button class="btn btn-primary" id="btn-speichern" ${nwPflicht(c) && !c.nennweite ? "disabled" : ""}>Speichern</button>
    ${c.gespeichert && !c.gesendet ? `<button class="btn btn-danger" id="btn-verwerfen">Erfassung verwerfen</button>` : ""}
    ${c.gesendet ? `<p class="note">Bereits an den Server gesendet. Zum Korrigieren einfach neue Werte eintragen und erneut speichern.</p>` : ""}
  `;
}

/* ---------- Ereignisse ---------- */
function bindView() {
  const $ = (id) => document.getElementById(id);
  if (state.view === "home") {
    $("btn-liste").onclick = () => $("liste-file").click();
    $("btn-export").onclick = exportieren;
    const bs = $("btn-sync"); if (bs) bs.onclick = () => syncen(true);
    const ba = $("btn-abmelden"); if (ba) ba.onclick = abmelden;
    const bl = $("btn-zum-login"); if (bl) bl.onclick = async () => { await setMeta("lokal", false); render(); };
    $("f-einheit").onchange = (e) => { state.fEinheit = e.target.value; render(); };
    $("f-bezirk").onchange = (e) => { state.fBezirk = e.target.value; render(); };
    $("suche").oninput = (e) => { state.suche = e.target.value; const pos = e.target.selectionStart; render(); const s = $("suche"); s.focus(); s.setSelectionRange(pos, pos); };
    document.querySelectorAll("[data-filter]").forEach((b) => (b.onclick = () => { state.filter = b.dataset.filter; render(); }));
    document.querySelectorAll(".item").forEach((it) => (it.onclick = () => oeffne(it.dataset.key)));
  } else if (state.view === "erfassen") {
    $("btn-zurueck").onclick = zurueck;
    $("btn-geo").onclick = () => (state.geo.watchId !== null ? stoppeMessung() : starteMessung());
    $("btn-geo-take").onclick = () => uebernehmenKlick();
    aktualisiereButtons();
    $("btn-speichern").onclick = speichern;
    const v = $("btn-verwerfen"); if (v) v.onclick = verwerfen;
    ["e-lat", "e-lng"].forEach((id) => ($(id).oninput = () => {
      state.cur.zeit = null; state.cur.acc = null; $("e-pos-info").textContent = "";
      const la = parseZahl($("e-lat").value), ln = parseZahl($("e-lng").value);
      if (la !== null && ln !== null && Math.abs(la) <= 90 && Math.abs(ln) <= 180) { state.cur.lat = la; state.cur.lng = ln; setzePin(la, ln, false); }
    }));
    // Eingaben sofort merken, damit sie ein Neuzeichnen (z.B. beim Start der Messung) überstehen
    $("e-nw").oninput = () => { state.cur.nennweite = nennweiteNorm($("e-nw").value); pruefeNw(); };
    baueKarte();
  }
}

/* Nennweite ist Pflicht, außer sie steht in der Hauptapp schon */
const nwPflicht = (c) => !c.vorhandenNw;
function pruefeNw() {
  const c = state.cur, v = nennweiteNorm(document.getElementById("e-nw").value);
  const leer = nwPflicht(c) && !v;
  document.getElementById("nw-box").classList.toggle("nw-leer", leer);
  document.getElementById("nw-hinweis").hidden = !leer;
  document.getElementById("btn-speichern").disabled = leer;
}
function zurueck() { stoppeMessung(); zerstoereKarte(); state.mapView = null; state.view = "home"; state.cur = null; render(); }

function oeffne(key) {
  const h = state.liste.find((x) => x.key === key);
  if (!h) return;
  const n = state.nachtrag.get(key);
  state.mapView = null;
  state.geo = { watchId: null, best: null, last: null, fehler: null };
  state.cur = {
    key, name: h.name, nrNeu: h.nrNeu, nrAlt: h.nrAlt, einheit: h.einheit, bezirk: h.bezirk, neu: false,
    vorhandenPos: hatPos(h), vorhandenLat: h.lat, vorhandenLng: h.lng, vorhandenNw: h.nennweite || "",
    lat: n ? n.lat : null, lng: n ? n.lng : null, acc: n ? n.acc : null, zeit: n ? n.zeit : null,
    nennweite: n ? n.nennweite : "", gespeichert: !!n, gesendet: !!(n && n.gesendet),
  };
  state.view = "erfassen"; render();
}

/* ---------- GPS ---------- */
function starteMessung() {
  if (!navigator.geolocation) { showToast("Dieses Gerät unterstützt keine Standortbestimmung"); return; }
  state.geo = { watchId: null, best: null, last: null, fehler: null };
  state.geo.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const p = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
      state.geo.last = p; state.geo.fehler = null;
      const besser = !state.geo.best || p.acc < state.geo.best.acc;
      if (besser) state.geo.best = p;
      aktualisiereGeo();
      if (besser) uebernehmen(true); // Pin folgt während der Messung automatisch dem besten Wert
    },
    (err) => {
      state.geo.fehler = err.code === 1 ? "Standortfreigabe verweigert. Im Browser erlauben oder Werte von Hand eintragen." : "Kein GPS-Signal. Bitte freien Himmel suchen und erneut versuchen.";
      aktualisiereGeo();
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
  );
  render();
}
function stoppeMessung() {
  if (state.geo.watchId !== null) { navigator.geolocation.clearWatch(state.geo.watchId); state.geo.watchId = null; aktualisiereButtons(); }
}
/* Knöpfe unter der Karte: während der Messung "Messung beenden" + bester GPS-Wert; sonst Pin-Position übernehmen */
function aktualisiereButtons() {
  const messung = state.geo.watchId !== null;
  const bg = document.getElementById("btn-geo"), bt = document.getElementById("btn-geo-take");
  if (bg) { bg.textContent = messung ? "Messung beenden" : "📍 Messung starten"; bg.classList.toggle("btn-danger", messung); bg.classList.toggle("btn-primary", !messung); }
  if (bt) bt.disabled = messung ? !state.geo.best : !pin;
}
/* "Position übernehmen": ohne laufende Messung gilt der gesetzte Pin, während der Messung der beste GPS-Wert */
function uebernehmenKlick() {
  if (state.geo.watchId !== null) { uebernehmen(false); return; }
  if (!pin) { showToast("Erst die Karte antippen, um den Pin zu setzen"); return; }
  const p = pin.getLatLng();
  setzePin(p.lat, p.lng, true);
  showToast("Position des Pins übernommen");
}
function aktualisiereGeo() {
  const g = state.geo;
  const el = document.getElementById("geo-live");
  if (!el) return;
  el.textContent = g.last ? `Aktuell ±${Math.round(g.last.acc)} m · Beste ±${Math.round(g.best.acc)} m` : (g.fehler || "Warte auf GPS-Signal…");
  const take = document.getElementById("btn-geo-take");
  aktualisiereButtons();
  zeigeGpsAufKarte();
}
function uebernehmen(leise) {
  const b = state.geo.best;
  if (!b) return;
  state.cur.lat = +b.lat.toFixed(7); state.cur.lng = +b.lng.toFixed(7); state.cur.acc = b.acc; state.cur.zeit = new Date().toISOString();
  document.getElementById("e-lat").value = state.cur.lat;
  document.getElementById("e-lng").value = state.cur.lng;
  document.getElementById("e-pos-info").textContent = `Übernommen ${fmtZeit(state.cur.zeit)}, Genauigkeit ±${Math.round(b.acc)} m.`;
  setzePin(state.cur.lat, state.cur.lng, false);
  if (karte) karte.setView([state.cur.lat, state.cur.lng], Math.max(karte.getZoom(), 19));
  if (!leise) showToast("Position übernommen");
}

/* ---------- Karte mit verschiebbarem Pin ---------- */
const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
let karte = null, pin = null, gpsPunkt = null, gpsKreis = null;
const PIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40" viewBox="0 0 30 40"><path d="M15 39C15 39 2 24 2 14a13 13 0 0 1 26 0c0 10-13 25-13 25z" fill="#C22E2E" stroke="#fff" stroke-width="2.5"/><circle cx="15" cy="14" r="4.5" fill="#fff"/></svg>';

function zerstoereKarte() {
  if (karte) { karte.remove(); karte = null; }
  pin = null; gpsPunkt = null; gpsKreis = null;
}
function baueKarte() {
  const el = document.getElementById("karte");
  if (!el) return;
  if (typeof L === "undefined") { el.innerHTML = '<p class="note">Karte nicht verfügbar (Internet nötig). Die Koordinaten können auch von Hand eingetragen werden.</p>'; return; }
  zerstoereKarte();
  const c = state.cur, g = state.geo;
  const hatPosition = Number.isFinite(c.lat) && Number.isFinite(c.lng);
  const start = state.mapView
    || (hatPosition ? { c: [c.lat, c.lng], z: 19 }
      : c.vorhandenPos ? { c: [c.vorhandenLat, c.vorhandenLng], z: 18 }
        : g.best ? { c: [g.best.lat, g.best.lng], z: 19 } : { c: [51.7869, 6.1387], z: 14 });
  karte = L.map(el, { maxZoom: 20 }).setView(start.c, start.z);
  L.tileLayer(OSM_URL, { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }).addTo(karte);
  if (c.vorhandenPos && !hatPosition) {
    L.circleMarker([c.vorhandenLat, c.vorhandenLng], { radius: 8, color: "#fff", weight: 2, fillColor: "#6b7280", fillOpacity: 0.9 }).addTo(karte).bindTooltip("Position in der Hauptapp", { permanent: false });
  }
  if (hatPosition) setzePin(c.lat, c.lng, false);
  karte.on("click", (e) => {
    if (state.geo.watchId !== null) { zurueckZumGps("Während der Messung setzt sich der Pin automatisch. Erst „Messung beenden“, dann kannst du ihn verschieben."); return; }
    setzePin(e.latlng.lat, e.latlng.lng, true);
  });
  karte.on("moveend", () => { const m = karte.getCenter(); state.mapView = { c: [m.lat, m.lng], z: karte.getZoom() }; });
  zeigeGpsAufKarte();
  setTimeout(() => { if (karte) karte.invalidateSize(); }, 80);
}
function zurueckZumGps(hinweis) {
  const c = state.cur;
  if (Number.isFinite(c.lat) && Number.isFinite(c.lng)) { setzePin(c.lat, c.lng, false); if (karte) karte.setView([c.lat, c.lng], Math.max(karte.getZoom(), 19)); }
  else if (pin && karte) { karte.removeLayer(pin); pin = null; }
  showToast(hinweis);
}
function setzePin(lat, lng, manuell) {
  if (karte) {
    if (!pin) {
      pin = L.marker([lat, lng], { draggable: true, icon: L.divIcon({ html: PIN_SVG, className: "pin-icon", iconSize: [30, 40], iconAnchor: [15, 39] }) }).addTo(karte);
      pin.on("dragend", () => {
        if (state.geo.watchId !== null) { zurueckZumGps("Während der Messung bleibt der Pin an der GPS-Position. Erst „Messung beenden“, dann kannst du ihn verschieben."); return; }
        const p = pin.getLatLng(); setzePin(p.lat, p.lng, true);
      });
    } else pin.setLatLng([lat, lng]);
  }
  aktualisiereButtons();
  if (manuell) {
    const c = state.cur;
    c.lat = +lat.toFixed(7); c.lng = +lng.toFixed(7); c.acc = null; c.zeit = new Date().toISOString();
    document.getElementById("e-lat").value = c.lat; document.getElementById("e-lng").value = c.lng;
    document.getElementById("e-pos-info").textContent = `Per Pin gesetzt ${fmtZeit(c.zeit)}.`;
  }
}
function zeigeGpsAufKarte() {
  const g = state.geo;
  if (!karte || !g.last) return;
  const ll = [g.last.lat, g.last.lng];
  if (!gpsPunkt) {
    gpsKreis = L.circle(ll, { radius: g.last.acc, color: "#1E6FD9", weight: 1, fillColor: "#1E6FD9", fillOpacity: 0.12 }).addTo(karte);
    gpsPunkt = L.circleMarker(ll, { radius: 7, color: "#fff", weight: 2, fillColor: "#1E6FD9", fillOpacity: 1 }).addTo(karte);
    if (!pin && !state.mapView) karte.setView(ll, 19);
  } else { gpsKreis.setLatLng(ll).setRadius(g.last.acc); gpsPunkt.setLatLng(ll); }
}

/* ---------- Speichern / Verwerfen ---------- */
async function speichern() {
  const c = state.cur;
  const latRaw = document.getElementById("e-lat").value, lngRaw = document.getElementById("e-lng").value;
  const lat = parseZahl(latRaw), lng = parseZahl(lngRaw);
  const nw = nennweiteNorm(document.getElementById("e-nw").value);
  if ((latRaw.trim() !== "" || lngRaw.trim() !== "") && (lat === null || lng === null)) { showToast("Breiten- und Längengrad müssen beide gültige Zahlen sein"); return; }
  if (lat !== null && (lat < -90 || lat > 90 || lng < -180 || lng > 180)) { showToast("Koordinaten außerhalb des gültigen Bereichs"); return; }
  if (nwPflicht(c) && !nw) { showToast("Bitte die Nennweite eintragen"); return; }
  if (lat === null && !nw) { showToast("Bitte Position oder Nennweite erfassen"); return; }
  const eintrag = {
    key: c.key, name: c.name, nrNeu: c.nrNeu || "", nrAlt: c.nrAlt || "", einheit: c.einheit || "", bezirk: c.bezirk || "",
    nennweite: nw, lat, lng, acc: lat !== null && Number.isFinite(c.acc) ? c.acc : null, zeit: lat !== null ? (c.zeit || new Date().toISOString()) : null,
    neu: !!c.neu, geaendert: new Date().toISOString(), exportiert: null, gesendet: null, helfer: state.meta.helfer || "",
  };
  await idbPut("nachtrag", eintrag);
  state.nachtrag.set(c.key, eintrag);
  stoppeMessung(); zerstoereKarte(); state.mapView = null;
  state.view = "home"; state.cur = null; render();
  showToast("Gespeichert");
  syncen(false);
}

async function verwerfen() {
  if (!confirm("Erfasste Werte für diesen Hydranten wirklich verwerfen?")) return;
  await idbDel("nachtrag", state.cur.key);
  state.nachtrag.delete(state.cur.key);
  zurueck();
  showToast("Erfassung verworfen");
}

/* ---------- Liste laden (Excel-Export der Hauptapp) ---------- */
function ladeListe(file) {
  if (typeof XLSX === "undefined") { showToast("Excel-Bibliothek nicht verfügbar (einmal mit Internet öffnen)"); return; }
  const reader = new FileReader();
  reader.onload = async (evt) => {
    try {
      const wb = XLSX.read(evt.target.result, { type: "array" });
      const sheet = wb.Sheets["Hydranten"] || wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet);
      const map = new Map();
      for (const r of rows) {
        const name = String(r.Name ?? "").trim();
        if (!name) continue;
        const h = {
          name, einheit: String(r.Einheit ?? "").trim(),
          nrNeu: String(r.HydrantennummerNeu ?? "").trim(), nrAlt: String(r.HydrantennummerAlt ?? "").trim(),
          nennweite: nennweiteNorm(r.Nennweite ?? r.Durchflussmenge), bezirk: String(r.Bezirk ?? "").trim(),
          lat: parseZahl(r.Breitengrad), lng: parseZahl(r.Laengengrad),
        };
        h.key = schluessel(h);
        if (!map.has(h.key)) map.set(h.key, h);
      }
      if (map.size === 0) { showToast("Keine Hydranten in der Datei gefunden (Spalte „Name“ fehlt?)"); return; }
      const arr = [...map.values()];
      await idbReplaceAll("liste", arr);
      state.liste = arr;
      await setMeta("listeGeladen", new Date().toISOString());
      await setMeta("listeName", file.name);
      render();
      showToast(`${arr.length} Hydranten geladen`);
    } catch (err) {
      console.error(err);
      showToast("Datei konnte nicht gelesen werden");
    }
  };
  reader.readAsArrayBuffer(file);
}

/* ---------- Export ---------- */
async function exportieren() {
  if (typeof XLSX === "undefined") { showToast("Excel-Bibliothek nicht verfügbar (einmal mit Internet öffnen)"); return; }
  const eintraege = [...state.nachtrag.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), "de"));
  if (eintraege.length === 0) return;
  const rows = eintraege.map((e) => ({
    Name: e.name, HydrantennummerNeu: e.nrNeu, HydrantennummerAlt: e.nrAlt, Einheit: e.einheit, Bezirk: e.bezirk,
    Nennweite: e.nennweite, Breitengrad: e.lat, Laengengrad: e.lng, Genauigkeit_m: e.acc === null || e.acc === undefined ? "" : Math.round(e.acc),
    Erfasst_am: e.zeit || e.geaendert, NichtInListe: e.neu ? "ja" : "nein",
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Nachtrag");
  const jetzt = new Date();
  const p = (n) => String(n).padStart(2, "0");
  XLSX.writeFile(wb, `hydranten-nachtrag-${jetzt.getFullYear()}-${p(jetzt.getMonth() + 1)}-${p(jetzt.getDate())}-${p(jetzt.getHours())}${p(jetzt.getMinutes())}.xlsx`);
  const ts = jetzt.toISOString();
  for (const e of eintraege) { e.exportiert = ts; await idbPut("nachtrag", e); }
  await setMeta("letzterExport", ts);
  render();
  showToast(`${eintraege.length} Eintrag/Einträge exportiert`);
}

/* ---------- Anmeldung (gemeinsamer Helfer-Zugang) ---------- */
function renderLogin() {
  return `
    <div class="card">
      <h3>Anmelden</h3>
      <p class="note">Mit dem Helfer-Passwort werden deine Erfassungen automatisch an Simone gesendet. Ohne Netz wird auf dem Handy zwischengespeichert.</p>
      <label class="lbl">Dein Name (damit man sieht, wer erfasst hat)</label>
      <input type="text" id="l-name" value="${esc(state.meta.helfer || "")}" autocomplete="name" />
      <label class="lbl">Helfer-Passwort</label>
      <input type="password" id="l-pass" autocomplete="current-password" />
      <button class="btn btn-primary" id="btn-login">Anmelden</button>
      <button class="btn btn-ghost" id="btn-lokal">Ohne Anmeldung nur lokal arbeiten</button>
      <p class="note" id="l-fehler"></p>
    </div>`;
}
function bindLogin() {
  const $ = (id) => document.getElementById(id);
  $("btn-lokal").onclick = async () => { await setMeta("lokal", true); render(); };
  $("btn-login").onclick = async () => {
    const name = $("l-name").value.trim(), pass = $("l-pass").value;
    if (!name) { $("l-fehler").textContent = "Bitte deinen Namen eintragen."; return; }
    if (!pass) { $("l-fehler").textContent = "Bitte das Passwort eintragen."; return; }
    if (!state.sb) { $("l-fehler").textContent = "Server-Bibliothek nicht geladen (Internet nötig)."; return; }
    if (!navigator.onLine) { $("l-fehler").textContent = "Zum Anmelden wird Internet gebraucht."; return; }
    $("btn-login").disabled = true;
    const { error } = await state.sb.auth.signInWithPassword({ email: HELFER_EMAIL, password: pass });
    if (error) { $("btn-login").disabled = false; $("l-fehler").textContent = /invalid/i.test(error.message) ? "Passwort stimmt nicht." : "Anmeldung nicht möglich: " + error.message; return; }
    await setMeta("helfer", name); await setMeta("angemeldet", true); await setMeta("lokal", false);
    render(); syncen(false);
  };
}
async function abmelden() {
  if (ungesendet() > 0 && !confirm(`${ungesendet()} Erfassung(en) sind noch nicht gesendet und bleiben auf dem Gerät. Trotzdem abmelden?`)) return;
  try { await state.sb.auth.signOut(); } catch (e) {}
  await setMeta("angemeldet", false);
  render();
}

/* ---------- Abgleich mit dem Server ---------- */
function syncText() {
  const s = state.sync;
  if (s.laeuft) return "Abgleich läuft …";
  if (s.fehler) return `⚠ ${esc(s.fehler)}`;
  const n = ungesendet();
  const zeit = s.zuletzt ? ` Letzter Abgleich ${fmtZeit(s.zuletzt)}.` : "";
  return (n === 0 ? "Alles gesendet." : `${n} Erfassung(en) warten auf Netz.`) + zeit;
}
function zeigeSync() { const el = document.getElementById("sync-info"); if (el) el.innerHTML = syncText(); }

async function syncen(meldung) {
  if (!angemeldet() || !state.sb || state.sync.laeuft) return;
  if (!navigator.onLine) { if (meldung) showToast("Kein Netz. Es wird gesendet, sobald wieder Empfang da ist."); return; }
  state.sync.laeuft = true; state.sync.fehler = null; zeigeSync();
  try {
    const { data: ses } = await state.sb.auth.getSession();
    if (!ses.session) { await setMeta("angemeldet", false); state.sync.laeuft = false; render(); showToast("Bitte neu anmelden"); return; }
    for (const e of [...state.nachtrag.values()]) {
      if (e.gesendet && e.geaendert <= e.gesendet) continue;
      const zeile = {
        helfer: e.helfer || state.meta.helfer || "?", key: e.key, name: e.name, nr_neu: e.nrNeu || "", nr_alt: e.nrAlt || "",
        einheit: e.einheit || "", bezirk: e.bezirk || "", nennweite: e.nennweite || "", lat: e.lat, lng: e.lng,
        genauigkeit_m: e.acc ?? null, erfasst_am: e.zeit || e.geaendert, neu: !!e.neu,
      };
      const { error } = await state.sb.from("nachtrag").upsert(zeile, { onConflict: "key,helfer" });
      if (error && error.code !== "42501") throw error;
      // 42501: Eintrag wurde schon von Simone übernommen und ist gesperrt → nicht erneut versuchen
      e.gesendet = new Date().toISOString();
      await idbPut("nachtrag", e);
    }
    const alle = [];
    for (let von = 0; ; von += 1000) {
      const { data, error } = await state.sb.from("nachtrag").select("id,key,helfer,lat,nennweite,status").range(von, von + 999);
      if (error) throw error;
      alle.push(...data);
      if (data.length < 1000) break;
    }
    await idbReplaceAll("remote", alle);
    baueRemote(alle);
    state.sync.zuletzt = new Date().toISOString();
    if (meldung) showToast("Abgleich fertig");
  } catch (err) {
    console.error(err);
    state.sync.fehler = "Senden nicht möglich (" + (err.message || err) + "). Es wird später erneut versucht.";
  }
  state.sync.laeuft = false;
  if (state.view === "home") render(); else zeigeSync();
}

/* ---------- Start ---------- */
(async function start() {
  try {
    db = await openDB();
    await laden();
  } catch (e) {
    document.getElementById("content").innerHTML = `<div class="card"><h3>Speicher nicht verfügbar</h3><p class="note">Der Browser erlaubt keinen lokalen Speicher (privater Modus?). Bitte in einem normalen Browserfenster öffnen.</p></div>`;
    return;
  }
  try { state.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } }); } catch (e) { console.warn("Supabase nicht geladen", e); }
  window.addEventListener("online", () => syncen(false));
  document.getElementById("liste-file").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) ladeListe(f); e.target.value = ""; });
  render();
  syncen(false);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
})();
