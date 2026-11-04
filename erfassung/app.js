/* Hydranten Erfassung – © 2026 Simone Loosen, Feuerwehr Kleve. Alle Rechte vorbehalten. Siehe LICENSE. */
/*
 * Minimal-App: nimmt NUR Position (Breiten-/Längengrad) und Nennweite eines Hydranten auf.
 * Sie hat keine Verbindung zur Datenbank der Hauptapp und teilt keinen Speicher mit ihr
 * (eigene IndexedDB "hydranten-erfassung"). Die Daten wandern nur per Excel-Datei in die Hauptapp.
 */
const DB_NAME = "hydranten-erfassung";
const DB_VER = 1;
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
}

/* ---------- Auswertung ---------- */
function offenInfo(h) {
  const n = state.nachtrag.get(h.key);
  const posOk = hatPos(h) || (n && Number.isFinite(n.lat));
  const nwOk = !!h.nennweite || (n && !!n.nennweite);
  return { n, posOk, nwOk, offen: !posOk || !nwOk };
}
function sichtbareListe() {
  const q = state.suche.trim().toLowerCase();
  return state.liste.filter((h) => {
    const info = offenInfo(h);
    if (state.filter === "offen" && !info.offen) return false;
    if (state.filter === "erfasst" && !info.n) return false;
    if (!q) return true;
    return [h.name, h.nrNeu, h.nrAlt, h.einheit, h.bezirk].some((x) => String(x || "").toLowerCase().includes(q));
  }).sort((a, b) => String(a.name).localeCompare(String(b.name), "de"));
}
function nichtExportiert() {
  let n = 0;
  state.nachtrag.forEach((e) => { if (!e.exportiert || e.geaendert > e.exportiert) n++; });
  return n;
}

/* ---------- Ansichten ---------- */
function render() {
  const el = document.getElementById("content");
  if (state.view === "erfassen") el.innerHTML = renderErfassen();
  else if (state.view === "neu") el.innerHTML = renderNeu();
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
      <div class="stat"><b>${state.nachtrag.size}</b><span>erfasst</span></div>
      <div class="stat"><b>${nichtExportiert()}</b><span>nicht exportiert</span></div>
    </div>

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
      <input type="search" id="suche" placeholder="Name, Nummer, Einheit suchen" value="${esc(state.suche)}" />
      <div style="margin-top:10px;">
        ${zeigen.length === 0 ? `<p class="note">${state.liste.length === 0 ? "Noch keine Hydranten geladen. Du kannst trotzdem einen neuen Hydranten anlegen." : "Nichts in dieser Auswahl."}</p>` : zeigen.map(itemHTML).join("")}
        ${sicht.length > MAX_ANZEIGE ? `<p class="note">${sicht.length - MAX_ANZEIGE} weitere – Suche eingrenzen.</p>` : ""}
      </div>
      <button class="btn" id="btn-neu">+ Neuer Hydrant (nicht in der Liste)</button>
    </div>

    <div class="card">
      <h3>3. Exportieren</h3>
      <p class="note">Erzeugt eine Excel-Datei mit allen erfassten Werten. Diese Datei in der Hauptapp unter Daten → „Nachtrag importieren“ einlesen (App-Admin).${state.meta.letzterExport ? `<br>Letzter Export: ${fmtZeit(state.meta.letzterExport)}` : ""}</p>
      <button class="btn btn-primary" id="btn-export" ${state.nachtrag.size === 0 ? "disabled" : ""}>Export als Excel (${state.nachtrag.size})</button>
    </div>

    <p class="note">Diese App speichert nur auf diesem Gerät und ist unabhängig von der Hauptapp. Browser-Daten dieser App erst löschen, wenn alles exportiert ist.</p>
  `;
}

function itemHTML(h) {
  const { n, posOk, nwOk } = offenInfo(h);
  const nr = h.nrNeu ? `Nr. ${esc(h.nrNeu)}` : "keine neue Nr.";
  const alt = h.nrAlt ? ` (alt: ${esc(h.nrAlt)})` : "";
  const ort = [h.einheit, h.bezirk ? "Bez. " + h.bezirk : ""].filter(Boolean).map(esc).join(" · ");
  const posTag = hatPos(h) ? `<span class="tag ok">Position vorhanden</span>` : (n && Number.isFinite(n.lat) ? `<span class="tag done">Position erfasst</span>` : `<span class="tag miss">Position fehlt</span>`);
  const nwTag = h.nennweite ? `<span class="tag ok">${esc(h.nennweite)}</span>` : (n && n.nennweite ? `<span class="tag done">${esc(n.nennweite)} erfasst</span>` : `<span class="tag miss">Nennweite fehlt</span>`);
  return `<div class="item" data-key="${esc(h.key)}">
    <div class="item-name">${esc(h.name)}</div>
    <div class="item-sub">${nr}${alt}${ort ? " · " + ort : ""}</div>
    <div class="tags">${posTag}${nwTag}</div>
  </div>`;
}

function renderNeu() {
  const c = state.cur || {};
  return `
    <button class="back" id="btn-zurueck">‹ Zurück</button>
    <h2>Neuer Hydrant</h2>
    <p class="sub">Für Hydranten, die noch nicht in der Hauptapp stehen. Sie werden dort nicht automatisch angelegt, sondern im Nachtrag-Import nur gemeldet.</p>
    <div class="card">
      <label class="lbl">Bezeichnung / Standortname *</label>
      <input type="text" id="n-name" value="${esc(c.name || "")}" placeholder="z. B. Hauptstraße 12" />
      <label class="lbl">Hydrantennummer (neu)</label>
      <input type="text" id="n-nrneu" value="${esc(c.nrNeu || "")}" />
      <label class="lbl">Hydrantennummer (alt)</label>
      <input type="text" id="n-nralt" value="${esc(c.nrAlt || "")}" />
      <label class="lbl">Einheit</label>
      <select id="n-einheit"><option value="">–</option>${EINHEITEN.map((e) => `<option ${c.einheit === e ? "selected" : ""}>${esc(e)}</option>`).join("")}</select>
      <label class="lbl">Bezirk</label>
      <input type="text" id="n-bezirk" value="${esc(c.bezirk || "")}" />
      <button class="btn btn-primary" id="btn-neu-weiter">Weiter zur Erfassung</button>
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
    <p class="sub">${nr}${alt}${ort ? " · " + ort : ""}${c.neu ? " · neu (nicht in der Liste)" : ""}</p>
    ${vorhanden}${nwVorhanden}

    <div class="card">
      <h3>Position</h3>
      <p class="note">Direkt am Hydranten stehen, Messung starten und warten, bis die Genauigkeit gut ist (am besten unter 10 m). Es wird immer der beste Wert gemerkt.</p>
      <button class="btn ${messung ? "btn-danger" : "btn-primary"}" id="btn-geo">${messung ? "Messung beenden" : "📍 Messung starten"}</button>
      <div class="geo-live" id="geo-live">${live}</div>
      <button class="btn" id="btn-geo-take" ${g.best ? "" : "disabled"}>Beste Position übernehmen</button>
      <div class="row">
        <div style="flex:1"><label class="lbl">Breitengrad</label><input type="text" id="e-lat" inputmode="decimal" value="${c.lat ?? ""}" placeholder="51.78…" /></div>
        <div style="flex:1"><label class="lbl">Längengrad</label><input type="text" id="e-lng" inputmode="decimal" value="${c.lng ?? ""}" placeholder="6.13…" /></div>
      </div>
      <p class="note" id="e-pos-info">${c.zeit && Number.isFinite(c.acc) ? `Übernommen ${fmtZeit(c.zeit)}, Genauigkeit ±${Math.round(c.acc)} m.` : ""}</p>
    </div>

    <div class="card">
      <h3>Nennweite</h3>
      <div class="nw"><span>H-</span><input type="text" id="e-nw" inputmode="numeric" value="${esc(String(c.nennweite || "").replace(/^H-?/i, ""))}" placeholder="100" /></div>
    </div>

    <button class="btn btn-primary" id="btn-speichern">Speichern</button>
    ${c.gespeichert ? `<button class="btn btn-danger" id="btn-verwerfen">Erfassung verwerfen</button>` : ""}
  `;
}

/* ---------- Ereignisse ---------- */
function bindView() {
  const $ = (id) => document.getElementById(id);
  if (state.view === "home") {
    $("btn-liste").onclick = () => $("liste-file").click();
    $("btn-neu").onclick = () => { state.cur = {}; state.view = "neu"; render(); };
    $("btn-export").onclick = exportieren;
    $("suche").oninput = (e) => { state.suche = e.target.value; const pos = e.target.selectionStart; render(); const s = $("suche"); s.focus(); s.setSelectionRange(pos, pos); };
    document.querySelectorAll("[data-filter]").forEach((b) => (b.onclick = () => { state.filter = b.dataset.filter; render(); }));
    document.querySelectorAll(".item").forEach((it) => (it.onclick = () => oeffne(it.dataset.key)));
  } else if (state.view === "neu") {
    $("btn-zurueck").onclick = () => { state.view = "home"; render(); };
    $("btn-neu-weiter").onclick = neuWeiter;
  } else if (state.view === "erfassen") {
    $("btn-zurueck").onclick = zurueck;
    $("btn-geo").onclick = () => (state.geo.watchId !== null ? stoppeMessung() : starteMessung());
    $("btn-geo-take").onclick = uebernehmen;
    $("btn-speichern").onclick = speichern;
    const v = $("btn-verwerfen"); if (v) v.onclick = verwerfen;
    ["e-lat", "e-lng"].forEach((id) => ($(id).oninput = () => { state.cur.zeit = null; state.cur.acc = null; $("e-pos-info").textContent = ""; }));
  }
}

function zurueck() { stoppeMessung(); state.view = "home"; state.cur = null; render(); }

function oeffne(key) {
  const h = state.liste.find((x) => x.key === key);
  if (!h) return;
  const n = state.nachtrag.get(key);
  state.geo = { watchId: null, best: null, last: null, fehler: null };
  state.cur = {
    key, name: h.name, nrNeu: h.nrNeu, nrAlt: h.nrAlt, einheit: h.einheit, bezirk: h.bezirk, neu: false,
    vorhandenPos: hatPos(h), vorhandenLat: h.lat, vorhandenLng: h.lng, vorhandenNw: h.nennweite || "",
    lat: n ? n.lat : null, lng: n ? n.lng : null, acc: n ? n.acc : null, zeit: n ? n.zeit : null,
    nennweite: n ? n.nennweite : "", gespeichert: !!n,
  };
  state.view = "erfassen"; render();
}

function neuWeiter() {
  const v = (id) => document.getElementById(id).value.trim();
  const c = { name: v("n-name"), nrNeu: v("n-nrneu"), nrAlt: v("n-nralt"), einheit: v("n-einheit"), bezirk: v("n-bezirk") };
  if (!c.name) { showToast("Bitte eine Bezeichnung eingeben"); return; }
  const key = schluessel(c);
  if (state.liste.some((h) => h.key === key)) { showToast("Diesen Hydranten gibt es schon in der Liste"); oeffne(key); return; }
  const n = state.nachtrag.get(key);
  state.geo = { watchId: null, best: null, last: null, fehler: null };
  state.cur = { ...c, key, neu: true, vorhandenPos: false, lat: n ? n.lat : null, lng: n ? n.lng : null, acc: n ? n.acc : null, zeit: n ? n.zeit : null, nennweite: n ? n.nennweite : "", gespeichert: !!n };
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
      if (!state.geo.best || p.acc < state.geo.best.acc) state.geo.best = p;
      aktualisiereGeo();
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
  if (state.geo.watchId !== null) { navigator.geolocation.clearWatch(state.geo.watchId); state.geo.watchId = null; }
}
function aktualisiereGeo() {
  const g = state.geo;
  const el = document.getElementById("geo-live");
  if (!el) return;
  el.textContent = g.last ? `Aktuell ±${Math.round(g.last.acc)} m · Beste ±${Math.round(g.best.acc)} m` : (g.fehler || "Warte auf GPS-Signal…");
  const take = document.getElementById("btn-geo-take");
  if (take) take.disabled = !g.best;
}
function uebernehmen() {
  const b = state.geo.best;
  if (!b) return;
  state.cur.lat = +b.lat.toFixed(7); state.cur.lng = +b.lng.toFixed(7); state.cur.acc = b.acc; state.cur.zeit = new Date().toISOString();
  document.getElementById("e-lat").value = state.cur.lat;
  document.getElementById("e-lng").value = state.cur.lng;
  document.getElementById("e-pos-info").textContent = `Übernommen ${fmtZeit(state.cur.zeit)}, Genauigkeit ±${Math.round(b.acc)} m.`;
  showToast("Position übernommen");
}

/* ---------- Speichern / Verwerfen ---------- */
async function speichern() {
  const c = state.cur;
  const latRaw = document.getElementById("e-lat").value, lngRaw = document.getElementById("e-lng").value;
  const lat = parseZahl(latRaw), lng = parseZahl(lngRaw);
  const nw = nennweiteNorm(document.getElementById("e-nw").value);
  if ((latRaw.trim() !== "" || lngRaw.trim() !== "") && (lat === null || lng === null)) { showToast("Breiten- und Längengrad müssen beide gültige Zahlen sein"); return; }
  if (lat !== null && (lat < -90 || lat > 90 || lng < -180 || lng > 180)) { showToast("Koordinaten außerhalb des gültigen Bereichs"); return; }
  if (lat === null && !nw) { showToast("Bitte Position oder Nennweite erfassen"); return; }
  const eintrag = {
    key: c.key, name: c.name, nrNeu: c.nrNeu || "", nrAlt: c.nrAlt || "", einheit: c.einheit || "", bezirk: c.bezirk || "",
    nennweite: nw, lat, lng, acc: lat !== null && Number.isFinite(c.acc) ? c.acc : null, zeit: lat !== null ? (c.zeit || new Date().toISOString()) : null,
    neu: !!c.neu, geaendert: new Date().toISOString(), exportiert: null,
  };
  await idbPut("nachtrag", eintrag);
  state.nachtrag.set(c.key, eintrag);
  stoppeMessung();
  state.view = "home"; state.cur = null; render();
  showToast("Gespeichert");
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

/* ---------- Start ---------- */
(async function start() {
  try {
    db = await openDB();
    await laden();
  } catch (e) {
    document.getElementById("content").innerHTML = `<div class="card"><h3>Speicher nicht verfügbar</h3><p class="note">Der Browser erlaubt keinen lokalen Speicher (privater Modus?). Bitte in einem normalen Browserfenster öffnen.</p></div>`;
    return;
  }
  document.getElementById("liste-file").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) ladeListe(f); e.target.value = ""; });
  render();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
})();
