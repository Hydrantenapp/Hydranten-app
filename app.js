/* ---------- Konstanten ---------- */
const DB_NAME = "hydranten-db";
const DB_VERSION = 3; // v2: settings-Store; v3: zusätzlicher "archive"-Store für die Jahresarchive
const STORE = "hydranten";
const SETTINGS_STORE = "settings";
const ARCHIVE_STORE = "archive";

/* ---------- Einheiten & Rollen ---------- */
const EINHEITEN = [
  "LZ Kleve", "LZ Materborn", "LZ Kellen", "LZ Rindern",
  "LG Reichswalde", "LG Donsbrüggen", "LG Wardhausen-Brienen", "LG Griethausen",
  "LG Düffelward", "LG Keeken", "LG Schenkenschanz", "LG Warbeyen",
];
const SONDERROLLEN = ["Einsatzleitung", "Stadtwerke", "Wehrführung", "App-Admin"];
// Die Stadtwerke und die Wehrführung bearbeiten Daten (Import/Export, Neuanlage, Statistik-
// Übersicht), gehen aber nicht selbst auf Kontrollrunde - daher bekommen sie keinen eigenen
// Hydrantenkontrolle-Tab (dafür aber die entsprechenden Funktionen im Reiter "Daten", siehe
// renderDaten()/renderDatenEingeschraenkt()).
const ERFASSEN_GESPERRT_FUER = ["Einsatzleitung", "Stadtwerke", "Wehrführung"];
// Das Ändern der Stammdaten (Name, Hydrantennummern, Bezirk) und die Neuanlage sind bewusst enger
// als der übrige Vollzugriff - nur diese zwei Rollen dürfen das.
const STAMMDATEN_ERLAUBT_FUER = ["Stadtwerke", "App-Admin"];
// Löschen ist nochmal enger gefasst als Stammdaten-Bearbeitung - nur noch App-Admin.
const LOESCHEN_ERLAUBT_FUER = ["App-Admin"];
function isSonderrolle(role) { return SONDERROLLEN.includes(role); }
function canEditHydrant(h, role) { return isSonderrolle(role) || h.einheit === role; }
function canDeleteHydrant(role) { return LOESCHEN_ERLAUBT_FUER.includes(role); }
function canEditStammdaten(role) { return STAMMDATEN_ERLAUBT_FUER.includes(role); }
function hatErfassenZugriff(role) { return !ERFASSEN_GESPERRT_FUER.includes(role); }
const STATISTIK_ERLAUBT_FUER = ["App-Admin"]; // eigene Kopf-Symbol-Seite bleibt bewusst nur App-Admin
// Der INHALT der Statistik (Kontrollrunde/Gesamtübersicht/Koordinaten-Lücken) ist zusätzlich für
// die Stadtwerke zugänglich, aber eingebettet im Reiter "Daten" statt über ein eigenes Kopf-Symbol.
const STATISTIK_INHALT_ERLAUBT_FUER = ["App-Admin", "Stadtwerke"];
function hatStatistikZugriff(role) { return STATISTIK_ERLAUBT_FUER.includes(role); }
function hatStatistikInhaltZugriff(role) { return STATISTIK_INHALT_ERLAUBT_FUER.includes(role); }

const ZUSTAENDE = [
  { value: "ok", label: "In Ordnung" },
  { value: "defekt", label: "Defekt" },
];
// Defekt-Auswahlliste – Standard-Prüfpunkte
const DEFEKT_OPTIONEN = [
  "0. Zugeparkt",
  "1. Schild fehlt/defekt",
  "2. Bemaßung Hydrant falsch",
  "3. Nummer fehlt/falsch",
  "4. Entwässert nicht",
  "5. Deckel nicht zu öffnen",
  "6. Nicht auffindbar",
  "7. Deckel defekt",
  "8. Kappe versandet",
  "9. Kappendeckel fehlt",
  "10. Kappe defekt/schief",
  "11. Undicht",
  "12. Klaue/Nuss defekt",
];

/* ---------- Straßenkarte (Leaflet + OpenStreetMap) ---------- */
// Bewusst FESTE Subdomain "a" statt Rotation a/b/c: so ist die Kachel-URL beim
// Offline-Vorab-Download exakt identisch mit der URL, die Leaflet später beim
// Kartenrendern anfragt. Nur so findet der Service Worker die gecachte Kachel wieder.
const TILE_URL_TEMPLATE = "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png";
const tileUrl = (z, x, y) => `https://a.tile.openstreetmap.org/${z}/${x}/${y}.png`;
const TILES_CACHE_NAME = "osm-tiles-v1";
const OFFLINE_ZOOM_MIN = 13;
const OFFLINE_ZOOM_MAX = 17;
const MAX_OFFLINE_TILES = 3000;

let leafletMap = null;
let leafletMarkersLayer = null;
let positionPickerMap = null;
let positionPickerMarker = null;

function tileXY(lat, lng, zoom) {
  const latRad = (lat * Math.PI) / 180;
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x: Math.min(Math.max(x, 0), n - 1), y: Math.min(Math.max(y, 0), n - 1) };
}

function computeBounds(list) {
  const pts = list.filter((h) => typeof h.lat === "number" && typeof h.lng === "number");
  if (pts.length === 0) return null;
  const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng);
  return { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLng: Math.min(...lngs), maxLng: Math.max(...lngs) };
}

function zustandColor(z) {
  return { ok: "#2E7D46", defekt: "#C22E2E" }[z] || "#2E7D46";
}

// Kartenfarbe je nach konkret ausgewählter(n) Defekt-Art(en), nicht nur nach grobem Zustand:
// "0. Zugeparkt" -> grau
// 1, 2, 3, 4, 7, 9 -> gelb
// 5, 6, 8, 10, 11, 12 -> rot
// Sind mehrere Kategorien gleichzeitig angekreuzt, hat grau Vorrang vor rot vor gelb.
// Frühere Schreibweisen von Defekt-Texten: werden beim Laden/Import automatisch auf den aktuellen Text umgestellt
const DEFEKT_ALIASE = [["9. Klappendeckel fehlt", "9. Kappendeckel fehlt"], ["0. Hydrant nicht kontrolliert – zugeparkt", "0. Zugeparkt"]];
function normalisiereBesonderheiten(text) {
  let t = text || "";
  for (const [alt, neu] of DEFEKT_ALIASE) if (t.includes(alt)) t = t.split(alt).join(neu);
  return t;
}
function normalisiereHydranten(liste) {
  liste.forEach((h) => { if (h && h.besonderheiten) h.besonderheiten = normalisiereBesonderheiten(h.besonderheiten); });
  return liste;
}
const DEFEKT_GELB_NUMMERN = [1, 2, 3, 4, 7, 9];
const DEFEKT_ROT_NUMMERN = [5, 6, 8, 10, 11, 12];

function ausgewaehlteDefektNummern(h) {
  const lines = (h.besonderheiten || "").split("\n").map((l) => l.trim());
  return DEFEKT_OPTIONEN
    .filter((opt) => lines.includes(opt))
    .map((opt) => parseInt(opt, 10));
}

function kartenFarbeFuerHydrant(h) {
  if (h.zustand !== "defekt") return "#2E7D46"; // In Ordnung -> grün
  const nummern = ausgewaehlteDefektNummern(h);
  if (nummern.some((n) => DEFEKT_ROT_NUMMERN.includes(n))) return "#C22E2E"; // rot
  if (nummern.some((n) => DEFEKT_GELB_NUMMERN.includes(n))) return "#D9A400"; // gelb
  if (nummern.includes(0)) return "#9CA3AF"; // nicht kontrolliert/zugeparkt -> grau
  return "#C22E2E"; // Defekt ohne konkret angekreuzte Art -> weiterhin rot als Fallback
}

// Liefert Textfarbe + Hintergrund für den Status-Pill in Liste/Detailansicht, passend zur
// gleichen Kategorie (grau/gelb/rot), die auch für den Kartenmarker verwendet wird.
function statusPillFarben(h) {
  if (h.zustand !== "defekt") return { color: "#2E7D46", bg: "#EAF6EE" }; // In Ordnung -> grün
  const nummern = ausgewaehlteDefektNummern(h);
  if (nummern.some((n) => DEFEKT_ROT_NUMMERN.includes(n))) return { color: "#C22E2E", bg: "#FBE9E9" };
  if (nummern.some((n) => DEFEKT_GELB_NUMMERN.includes(n))) return { color: "#8A6D00", bg: "#FBF3D9" };
  if (nummern.includes(0)) return { color: "#4B5563", bg: "#F3F4F6" };
  return { color: "#C22E2E", bg: "#FBE9E9" }; // Fallback wie oben
}

// Beschriftung des Status-Pills passend zur Farbkategorie: rot = Defekt, gelb = Bedingt defekt, grau = Zugeparkt.
// Der gespeicherte Zustand bleibt unverändert "defekt" (nur die Anzeige ist feiner).
function statusLabel(h) {
  if (h.zustand !== "defekt") return zustandLabel(h.zustand);
  const nummern = ausgewaehlteDefektNummern(h);
  if (nummern.some((n) => DEFEKT_ROT_NUMMERN.includes(n))) return "Defekt";
  if (nummern.some((n) => DEFEKT_GELB_NUMMERN.includes(n))) return "Bedingt defekt";
  if (nummern.includes(0)) return "Zugeparkt";
  return "Defekt";
}

// Hydranten im (selbst angelegten) Bezirk "Sonder" zählen in keiner Statistik als Hydrant mit.
function istSonderBezirk(h) { return (h.bezirk || "").trim().toLowerCase() === "sonder"; }

/* ---------- IndexedDB Wrapper (rein lokal, funktioniert offline) ---------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(ARCHIVE_STORE)) {
        db.createObjectStore(ARCHIVE_STORE, { keyPath: "jahr" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function getSetting(id, fallback) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(SETTINGS_STORE, "readonly");
    const req = tx.objectStore(SETTINGS_STORE).get(id);
    req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
    req.onerror = () => resolve(fallback);
  });
}
async function setSettingLokal(id, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE, "readwrite");
    tx.objectStore(SETTINGS_STORE).put({ id, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function setSetting(id, value) {
  await setSettingLokal(id, value);
  if (SYNC_SETTING_KEYS.includes(id)) {
    const dirty = await getSetting("_dirtySettings", []);
    if (!dirty.includes(id)) { dirty.push(id); await setSettingLokal("_dirtySettings", dirty); }
    syncAlles();
  }
}
async function saveArchivJahr(jahr, hydranten) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ARCHIVE_STORE, "readwrite");
    // Fotos (Blobs) werden bewusst NICHT mit archiviert, um den Speicher nicht zu sprengen -
    // das Archiv ist als Datenstand (Excel-Grundlage), nicht als vollständiges Backup gedacht.
    const schlankeListe = hydranten.map((h) => { const { foto, lageFoto, ...rest } = h; return rest; });
    tx.objectStore(ARCHIVE_STORE).put({ jahr, erstelltAm: new Date().toISOString(), hydranten: schlankeListe });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function getAlleArchive() {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(ARCHIVE_STORE, "readonly");
    const req = tx.objectStore(ARCHIVE_STORE).getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.jahr - a.jahr));
    req.onerror = () => resolve([]);
  });
}

// Läuft bei jedem App-Start (unabhängig vom Login): sobald das Gerät zum ersten Mal am oder nach
// dem 30.09. eines Jahres geöffnet wird und für dieses Jahr noch kein Archiv existiert, wird
// automatisch ein Datenstand-Snapshot im Archiv der App abgelegt. Ein Browser kann nicht wirklich
// im Hintergrund an einem festen Datum aktiv werden, wenn die App gerade geschlossen ist - das
// Archiv entsteht deshalb beim nächsten tatsächlichen Öffnen der App, nicht exakt am Stichtag.
async function pruefeUndErstelleJahresarchiv() {
  // Das Jahresarchiv entsteht jetzt automatisch auf dem Server (30.09.) und wird per Abgleich geladen.
}
async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbPut(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbPutMany(items) {
  if (items.length === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    items.forEach((item) => store.put(item));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------- Hilfsfunktionen ---------- */
function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : "h-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function fmtDist(m) {
  if (m == null || Number.isNaN(m)) return "–";
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function zustandLabel(v) { return (ZUSTAENDE.find((z) => z.value === v) || ZUSTAENDE[0]).label; }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add("hidden"), 2200);
}

// Eigenes Ja/Nein-Bestätigungs-Popup für alle Löschen-Aktionen (der native Browser-confirm() lässt
// sich nicht mit "Ja"/"Nein" statt "OK"/"Abbrechen" beschriften). Ruft aufJa() nur bei "Ja" auf; bei
// "Nein" oder Klick auf den Hintergrund passiert nichts (Abbruch).
function zeigeJaNeinDialog(frage, aufJa) {
  const overlay = document.createElement("div");
  overlay.className = "janein-overlay";
  overlay.innerHTML = `
    <div class="janein-box">
      <p class="janein-frage">${esc(frage)}</p>
      <div class="janein-btns">
        <button type="button" class="btn btn-outline janein-nein">Nein</button>
        <button type="button" class="btn btn-outline-danger janein-ja">Ja</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector(".janein-nein").addEventListener("click", () => overlay.remove());
  overlay.querySelector(".janein-ja").addEventListener("click", () => { overlay.remove(); aufJa(); });
}

/* ---------- App-Status ---------- */
const state = {
  session: null, // aktuell angemeldete Rolle (Einheit oder Sonderrolle), null = nicht angemeldet
  hydranten: [],
  tab: "karte",
  selectedId: null,
  search: "",
  zustandFilter: "alle",
  bezirkFilter: "alle",
  userLoc: null,
  editingId: undefined, // undefined = kein Formular, null = neu, id = bearbeiten
  hkBezirk: "alle", // Bezirksauswahl im Hydrantenkontrolle-Einstieg
  hkAktiv: false, // false = Einstiegsseite (Bezirkswahl+Karte), true = aktive Kontrollrunde
  hkFilter: "offen", // "offen" | "kontrolliert" - Auswahl auf der aktiven Kontrollrunden-Seite
  formContext: "erfassen", // "erfassen" | "detail-edit" | "hydrantenkontrolle"
  mapView: null, // { lat, lng, zoom } - bleibt über Re-Renders hinweg erhalten
  lageFotoFreigegeben: false, // globaler Schalter, nur durch Vollzugriffs-Rollen änderbar
  infoText: "", // frei bearbeitbares Hinweisfeld
  impressumText: "",
  disclaimerText: "",
  infoDocKind: null, // "impressum" | "disclaimer" - welches Dokument gerade offen ist
  infoEditMode: false,
  karteEinheit: "alle", // wird beim Login auf die eigene Einheit gesetzt (Sonderrollen: "alle")
  kontrollStartdatum: null, // Bezugsdatum für die Statistik-Seite ("fertig" = letzteKontrolle >= dieses Datum)
  kontrollEnddatum1: null, // rein informativ, kein Einfluss auf die Berechnung
  kontrollEnddatum2: null, // rein informativ, kein Einfluss auf die Berechnung
  kontrollGesamtAbschlussdatum: null, // wird automatisch gesetzt, sobald wirklich alle Bezirke fertig sind
  neuesArchivJahr: null, // gesetzt, wenn beim App-Start automatisch ein neues Jahresarchiv erstellt wurde
  archivListe: [], // im Reiter "Daten" angezeigte Liste vorhandener Jahresarchive
  statistikExpandedBezirk: null, // welcher Bezirk in der Statistik gerade aufgeklappt ist
  koordinatenExpandedBezirk: null, // eigener Aufklapp-State für die Koordinaten-Lücken-Übersicht
  statistikAbschnitte: {}, // { <schlüssel>: true/false } - aufklappbare Abschnitte (Statistik UND der neu strukturierte Daten-Tab der Stadtwerke teilen sich diese generische Struktur, eindeutige Schlüssel pro Abschnitt)
  statistikKoordinatenHerkunft: null, // "statistik" oder "daten" - von wo die Koordinaten-Übersicht geöffnet wurde, für die Zurück-Navigation
  einsatzleitungLivePin: null, // { lat, lng } - automatischer Standort-Pin beim Login der Einsatzleitung
  einsatzplanungModus: false, // true = "bitte auf Karte tippen, um Einsatzort zu setzen"
  einsatzplanungPin: null, // { lat, lng } - manuell gesetzter Einsatzort
  einsatzplanungRadius: null, // null = "Alle", sonst Meter (100/200/500/1000/2000)
};

async function loadData() {
  state.hydranten = normalisiereHydranten(await dbGetAll());
}

async function saveHydrant(h) {
  const alt = state.hydranten.find((x) => x.id === h.id);
  h.fotoPfad = alt ? alt.fotoPfad || null : null;
  h.lageFotoPfad = alt ? alt.lageFotoPfad || null : null;
  h._serverTs = alt ? alt._serverTs || null : null;
  h._fotoGeaendert = !!(alt && alt._fotoGeaendert) || (h.foto || null) !== ((alt && alt.foto) || null);
  h._lageFotoGeaendert = !!(alt && alt._lageFotoGeaendert) || (h.lageFoto || null) !== ((alt && alt.lageFoto) || null);
  h._dirty = true;
  h._v = ((alt && alt._v) || 0) + 1;
  delete h.historie; // Änderungshistorie führt jetzt der Server
  await dbPut(h);
  const i = state.hydranten.findIndex((x) => x.id === h.id);
  if (i >= 0) state.hydranten[i] = h; else state.hydranten.push(h);
  syncAlles();
}

async function deleteHydrant(id, ohneSync) {
  const h = state.hydranten.find((x) => x.id === id);
  await dbDelete(id);
  state.hydranten = state.hydranten.filter((x) => x.id !== id);
  if (h && h._serverTs && h._serverTs !== "verworfen") {
    const q = await getSetting("_loeschQueue", []);
    q.push(id);
    await setSettingLokal("_loeschQueue", q);
  }
  if (!ohneSync) syncAlles();
}

/* ---------- Server-Synchronisierung (Supabase) ---------- */
const SYNC_SETTING_KEYS = ["infoText", "impressumText", "disclaimerText", "kontrollStartdatum", "kontrollEnddatum1", "kontrollEnddatum2", "kontrollGesamtAbschlussdatum", "lageFotoFreigegeben"];
const SYNC_DEFAULTS = { infoText: "", impressumText: "", disclaimerText: "", kontrollStartdatum: null, kontrollEnddatum1: null, kontrollEnddatum2: null, kontrollGesamtAbschlussdatum: null, lageFotoFreigegeben: false };
const FOTO_BUCKET = "hydranten-fotos";
let syncLaeuft = false, syncNochmal = false;

function datumFuerServer(v) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || ""));
  return m ? m[1] : null;
}
function hydrantZuZeile(h) {
  return {
    id: h.id, name: h.name, einheit: h.einheit || null,
    nr_neu: String(h.nrNeu ?? ""), nr_alt: String(h.nrAlt ?? ""), nennweite: String(h.durchfluss ?? ""),
    bezirk: String(h.bezirk ?? ""), lat: h.lat ?? null, lng: h.lng ?? null,
    lage: String(h.lage ?? ""), zustand: h.zustand || "ok", besonderheiten: String(h.besonderheiten ?? ""),
    letzte_kontrolle: datumFuerServer(h.letzteKontrolle),
    foto_pfad: h.fotoPfad || null, lage_foto_pfad: h.lageFotoPfad || null,
  };
}
function zeileZuHydrant(r) {
  return {
    id: r.id, name: r.name, einheit: r.einheit || "", nrNeu: r.nr_neu, nrAlt: r.nr_alt, durchfluss: r.nennweite,
    bezirk: r.bezirk, lat: r.lat, lng: r.lng, lage: r.lage, zustand: r.zustand, besonderheiten: normalisiereBesonderheiten(r.besonderheiten),
    letzteKontrolle: r.letzte_kontrolle || "", geaendertVon: r.geaendert_von || "",
    fotoPfad: r.foto_pfad || null, lageFotoPfad: r.lage_foto_pfad || null,
    foto: null, lageFoto: null, _serverTs: r.geaendert_am, _dirty: false, _v: 0,
  };
}
// Dauerhafter Fehler (z.B. keine Berechtigung) = erneutes Versuchen sinnlos; Netzwerkfehler = später nochmal.
function istDauerhafterFehler(err) {
  if (!err) return false;
  if (err.code) return true;
  const st = Number(err.status || err.statusCode);
  return st >= 400 && st < 500;
}
async function holeAlleZeilen(tabelle, spalten, ordnung, filterFn) {
  const alle = [];
  for (let von = 0; ; von += 1000) {
    let q = sb.from(tabelle).select(spalten).order(ordnung).range(von, von + 999);
    if (filterFn) q = filterFn(q);
    const { data, error } = await q;
    if (error) throw error;
    alle.push(...data);
    if (data.length < 1000) break;
  }
  return alle;
}
function syncKannLaufen() {
  return !!(sb && state.session && navigator.onLine);
}
async function ladeEinstellungenInState() {
  state.lageFotoFreigegeben = await getSetting("lageFotoFreigegeben", false);
  state.infoText = await getSetting("infoText", "");
  state.impressumText = await getSetting("impressumText", "");
  state.disclaimerText = await getSetting("disclaimerText", "");
  state.kontrollStartdatum = await getSetting("kontrollStartdatum", null);
  state.kontrollEnddatum1 = await getSetting("kontrollEnddatum1", null);
  state.kontrollEnddatum2 = await getSetting("kontrollEnddatum2", null);
  state.kontrollGesamtAbschlussdatum = await getSetting("kontrollGesamtAbschlussdatum", null);
}

function findeStateHydrant(id) { return state.hydranten.find((x) => x.id === id); }

async function markiereHydrantSynchron(gesendet, serverTs, pfade) {
  const cur = findeStateHydrant(gesendet.id);
  if (!cur) return;
  cur._serverTs = serverTs;
  cur.fotoPfad = pfade.foto; cur.lageFotoPfad = pfade.lage;
  if (cur._v === gesendet._v) { cur._dirty = false; cur._fotoGeaendert = false; cur._lageFotoGeaendert = false; }
  await dbPut(cur);
}
async function verwerfeHydrant(h) {
  // Server hat die Änderung abgelehnt: lokale Version wird beim nächsten Abgleich durch den Serverstand ersetzt.
  const cur = findeStateHydrant(h.id);
  if (!cur) return;
  cur._dirty = false; cur._fotoGeaendert = false; cur._lageFotoGeaendert = false; cur._serverTs = "verworfen";
  await dbPut(cur);
  state.syncVerworfen = (state.syncVerworfen || 0) + 1;
}

async function pushEinHydrant(h) {
  const gesendet = { id: h.id, _v: h._v };
  let serverTs = h._serverTs && h._serverTs !== "verworfen" ? h._serverTs : null;
  const zeile = hydrantZuZeile(h);
  if (!serverTs) {
    const { data, error } = await sb.from("hydranten").insert(zeile).select("geaendert_am");
    if (error) throw error;
    serverTs = data[0].geaendert_am;
  } else {
    const { id, ...ohneId } = zeile;
    const { data, error } = await sb.from("hydranten").update(ohneId).eq("id", h.id).select("geaendert_am");
    if (error) throw error;
    if (!data || data.length === 0) throw { code: "KEIN_ZUGRIFF", message: "Änderung nicht erlaubt" };
    serverTs = data[0].geaendert_am;
  }
  const pfade = { foto: h.fotoPfad || null, lage: h.lageFotoPfad || null };
  let pfadeGeaendert = false;
  for (const art of ["foto", "lage"]) {
    const flag = art === "foto" ? h._fotoGeaendert : h._lageFotoGeaendert;
    if (!flag) continue;
    const blob = art === "foto" ? h.foto : h.lageFoto;
    const objekt = `${h.id}/${art}.jpg`;
    if (blob instanceof Blob) {
      const { error } = await sb.storage.from(FOTO_BUCKET).upload(objekt, blob, { upsert: true, contentType: blob.type || "image/jpeg" });
      if (error) {
        // Der Hydrant selbst ist schon auf dem Server; nur das Foto bleibt zur erneuten Übertragung vorgemerkt.
        const cur = findeStateHydrant(h.id);
        if (cur) { cur._serverTs = serverTs; await dbPut(cur); }
        const fe = new Error("Foto konnte nicht hochgeladen werden: " + (error.message || error));
        fe.fotoFehler = true; fe.istNetz = !istDauerhafterFehler(error);
        throw fe;
      }
      pfade[art] = objekt;
    } else {
      if (pfade[art]) await sb.storage.from(FOTO_BUCKET).remove([objekt]);
      pfade[art] = null;
    }
    pfadeGeaendert = true;
  }
  if (pfadeGeaendert) {
    const { data, error } = await sb.from("hydranten").update({ foto_pfad: pfade.foto, lage_foto_pfad: pfade.lage }).eq("id", h.id).select("geaendert_am");
    if (error) throw error;
    if (data && data[0]) serverTs = data[0].geaendert_am;
  }
  await markiereHydrantSynchron(gesendet, serverTs, pfade);
}

async function pushAlles() {
  // 1) Löschungen
  let q = await getSetting("_loeschQueue", []);
  while (q.length > 0) {
    const teil = q.slice(0, 100);
    const pfade = teil.flatMap((id) => [`${id}/foto.jpg`, `${id}/lage.jpg`]);
    try { await sb.storage.from(FOTO_BUCKET).remove(pfade); } catch (e) {}
    const { error } = await sb.from("hydranten").delete().in("id", teil);
    if (error && !istDauerhafterFehler(error)) throw error;
    q = q.slice(100);
    await setSettingLokal("_loeschQueue", q);
  }
  // 2) Einstellungen
  let dirty = await getSetting("_dirtySettings", []);
  for (const k of dirty.slice()) {
    const wert = await getSetting(k, SYNC_DEFAULTS[k]);
    const { error } = await sb.from("einstellungen").upsert({ schluessel: k, wert: wert === undefined ? null : wert, geaendert_am: new Date().toISOString() });
    if (error && !istDauerhafterFehler(error)) throw error;
    dirty = dirty.filter((x) => x !== k);
    await setSettingLokal("_dirtySettings", dirty);
  }
  // 3) Hydranten (neue ohne Fotos gebündelt, Rest einzeln)
  const offen = state.hydranten.filter((h) => h._dirty);
  const neuOhneFoto = offen.filter((h) => !(h._serverTs && h._serverTs !== "verworfen") && !h._fotoGeaendert && !h._lageFotoGeaendert);
  const rest = offen.filter((h) => !neuOhneFoto.includes(h));
  for (let i = 0; i < neuOhneFoto.length; i += 200) {
    const chunk = neuOhneFoto.slice(i, i + 200);
    const { data, error } = await sb.from("hydranten").insert(chunk.map(hydrantZuZeile)).select("id, geaendert_am");
    if (!error) {
      for (const h of chunk) {
        const r = data.find((x) => x.id === h.id);
        await markiereHydrantSynchron({ id: h.id, _v: h._v }, r ? r.geaendert_am : null, { foto: null, lage: null });
      }
    } else if (!istDauerhafterFehler(error)) {
      throw error;
    } else {
      rest.push(...chunk); // Einzelversuch, damit nur fehlerhafte Zeilen verworfen werden
    }
  }
  for (const h of rest) {
    try { await pushEinHydrant(h); }
    catch (e) {
      if (e && e.fotoFehler) { state.syncFehler = e.message; if (e.istNetz) throw e; }
      else if (istDauerhafterFehler(e)) { state.syncFehler = "Änderung vom Server abgelehnt: " + (e.message || e.code); await verwerfeHydrant(h); }
      else throw e;
    }
  }
}

async function pullAlles() {
  const lastTs = await getSetting("_lastPullTs", null);
  const vollstaendig = !lastTs;

  // 1) Alles vom Server holen (Netzwerk)
  const idZeilen = await holeAlleZeilen("hydranten", "id", "id");
  const serverIds = new Set(idZeilen.map((r) => r.id));
  const geaendert = await holeAlleZeilen("hydranten", "*", "id", vollstaendig ? null : (q) => q.gte("geaendert_am", lastTs));
  const einst = await holeAlleZeilen("einstellungen", "schluessel, wert", "schluessel");

  // 2) Mit frischem lokalen Stand abgleichen (nur noch lokale Zugriffe, damit zwischenzeitliche Eingaben nicht verloren gehen)
  const lokal = new Map((await dbGetAll()).map((h) => [h.id, h]));
  let maxTs = lastTs;
  const neuIds = new Set();
  const zuSchreiben = [];
  for (const r of geaendert) {
    if (!maxTs || r.geaendert_am > maxTs) maxTs = r.geaendert_am;
    const l = lokal.get(r.id);
    if (l && l._dirty) { l._serverTs = r.geaendert_am; zuSchreiben.push(l); continue; }
    if (l && l._serverTs === r.geaendert_am) continue;
    const n = zeileZuHydrant(r);
    if (l) { n.foto = l.foto || null; n.lageFoto = l.lageFoto || null; }
    if (!r.foto_pfad) n.foto = null;
    if (!r.lage_foto_pfad) n.lageFoto = null;
    zuSchreiben.push(n);
    lokal.set(n.id, n);
    neuIds.add(n.id);
  }
  const entfernen = [];
  const altBackup = [];
  for (const l of lokal.values()) {
    if (serverIds.has(l.id) || l._dirty) continue;
    entfernen.push(l.id);
    if (!l._serverTs) altBackup.push(l); // Altbestand aus der Zeit vor dem Server: als lokale Sicherung aufbewahren
  }
  if (altBackup.length > 0) {
    const bisher = await getSetting("altDatenBackup", []);
    await setSettingLokal("altDatenBackup", bisher.concat(altBackup));
  }
  await dbPutMany(zuSchreiben);
  for (const id of entfernen) { await dbDelete(id); lokal.delete(id); }
  if (maxTs) await setSettingLokal("_lastPullTs", maxTs);

  // 3) Einstellungen
  const dirtyKeys = await getSetting("_dirtySettings", []);
  const serverWerte = new Map(einst.map((e) => [e.schluessel, e.wert]));
  let einstellungenGeaendert = false;
  for (const k of SYNC_SETTING_KEYS) {
    if (dirtyKeys.includes(k)) continue;
    const neu = serverWerte.has(k) && serverWerte.get(k) !== null ? serverWerte.get(k) : SYNC_DEFAULTS[k];
    const alt = await getSetting(k, SYNC_DEFAULTS[k]);
    if (JSON.stringify(neu) !== JSON.stringify(alt)) { await setSettingLokal(k, neu); einstellungenGeaendert = true; }
  }
  if (einstellungenGeaendert) await ladeEinstellungenInState();

  state.hydranten = normalisiereHydranten(await dbGetAll());

  // 4) Fotos, die noch geladen werden müssen
  const fotoQueue = [];
  for (const l of state.hydranten) {
    if (l.fotoPfad && (!(l.foto instanceof Blob) || neuIds.has(l.id))) fotoQueue.push({ id: l.id, art: "foto" });
    if (l.lageFotoPfad && (!(l.lageFoto instanceof Blob) || neuIds.has(l.id))) fotoQueue.push({ id: l.id, art: "lage" });
  }
  return { fotoQueue, aenderungen: neuIds.size + entfernen.length > 0 || einstellungenGeaendert };
}

async function ladeFotos(fotoQueue) {
  let geladen = 0;
  const arbeiter = async () => {
    while (fotoQueue.length > 0) {
      const { id, art } = fotoQueue.shift();
      const h = findeStateHydrant(id);
      if (!h || h._dirty) continue;
      const pfad = art === "foto" ? h.fotoPfad : h.lageFotoPfad;
      if (!pfad) continue;
      try {
        const { data, error } = await sb.storage.from(FOTO_BUCKET).download(pfad);
        if (error || !data) continue;
        const cur = findeStateHydrant(id);
        if (!cur || cur._dirty) continue;
        if (art === "foto") cur.foto = data; else cur.lageFoto = data;
        await dbPut(cur);
        geladen++;
      } catch (e) {}
    }
  };
  await Promise.all([arbeiter(), arbeiter(), arbeiter()]);
  return geladen;
}

function renderNachSyncErlaubt() {
  if (document.getElementById("hydrant-form")) return false; // offenes Formular nicht zerstören
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return false;
  if (state.tab === "konten" || state.tab === "daten-loeschen") return false;
  return true;
}

async function syncAlles() {
  if (!syncKannLaufen()) return;
  if (syncLaeuft) { syncNochmal = true; return; }
  state.syncGestartet = Date.now();
  syncLaeuft = true;
  try {
    do {
      syncNochmal = false;
      await pushAlles();
      const { fotoQueue, aenderungen } = await pullAlles();
      if (aenderungen && renderNachSyncErlaubt() && state.session) render();
      try { await syncArchiv(); } catch (e) { console.warn("Archiv-Abgleich fehlgeschlagen", e); }
      const n = await ladeFotos(fotoQueue);
      if (n > 0 && renderNachSyncErlaubt() && state.session) render();
    } while (syncNochmal);
    if (state.syncVerworfen) {
      showToast(`${state.syncVerworfen} Änderung(en) wurden vom Server abgelehnt (keine Berechtigung)`);
      state.syncVerworfen = 0;
      await setSettingLokal("_lastPullTs", null); // vollständiger Abgleich, damit abgelehnte lokale Stände ersetzt werden
      await pullAlles();
      if (renderNachSyncErlaubt() && state.session) render();
    }
    state.letzterSync = Date.now();
    if (!state.hydranten.some((x) => x._dirty)) state.syncFehler = null;
    const ind = document.getElementById("sync-indicator");
    if (ind) ind.classList.add("hidden");
  } catch (e) {
    console.warn("Sync fehlgeschlagen", e);
    state.syncFehler = (e && (e.message || e.code)) ? String(e.message || e.code) : "Unbekannter Fehler";
    const ind = document.getElementById("sync-indicator");
    if (ind) ind.classList.remove("hidden");
  } finally {
    syncLaeuft = false;
    if (syncNochmal && syncKannLaufen()) { syncNochmal = false; setTimeout(syncAlles, 500); }
  }
}

async function syncArchiv() {
  if (!isSonderrolle(state.session)) return;
  const { data, error } = await sb.from("archiv").select("jahr, erstellt_am").order("jahr", { ascending: false });
  if (error) throw error;
  const lokal = await getAlleArchive();
  const lokalJahre = new Map(lokal.map((a) => [a.jahr, a]));
  let neuGeladen = 0;
  for (const z of data) {
    const l = lokalJahre.get(z.jahr);
    if (l && l.erstelltAm === z.erstellt_am) continue;
    const { data: voll, error: e2 } = await sb.from("archiv").select("jahr, erstellt_am, daten").eq("jahr", z.jahr).maybeSingle();
    if (e2 || !voll) continue;
    await archivLokalSpeichern({ jahr: voll.jahr, erstelltAm: voll.erstellt_am, hydranten: voll.daten });
    if (!l) neuGeladen++;
  }
  const serverJahre = new Set(data.map((z) => z.jahr));
  for (const l of lokal) { if (!serverJahre.has(l.jahr)) await archivLokalLoeschen(l.jahr); }
  state.archivListe = await getAlleArchive();
  if (neuGeladen > 0 && lokal.length > 0) showToast("📦 Neues Jahresarchiv verfügbar – im Reiter \"Daten\" herunterladen");
}
async function archivLokalSpeichern(eintrag) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ARCHIVE_STORE, "readwrite");
    tx.objectStore(ARCHIVE_STORE).put(eintrag);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function archivLokalLoeschen(jahr) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(ARCHIVE_STORE, "readwrite");
    tx.objectStore(ARCHIVE_STORE).delete(jahr);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function alleHydrantenLoeschen() {
  const q = await getSetting("_loeschQueue", []);
  for (const h of state.hydranten) {
    if (h._serverTs && h._serverTs !== "verworfen") q.push(h.id);
    await dbDelete(h.id);
  }
  await setSettingLokal("_loeschQueue", q);
  state.hydranten = [];
  syncAlles();
}

function withDistance(list) {
  if (!state.userLoc) return list.map((h) => ({ ...h, dist: null }));
  return list
    .map((h) => ({
      ...h,
      dist: (typeof h.lat === "number" && typeof h.lng === "number")
        ? haversine(state.userLoc.lat, state.userLoc.lng, h.lat, h.lng)
        : null,
    }))
    .sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity));
}

// Trennt "Ackerstraße 63" in Straßenname und Hausnummer, damit nach Straße (alphabetisch)
// und erst danach nach Hausnummer (numerisch) sortiert werden kann.
function splitStrasseHausnummer(name) {
  const match = String(name || "").trim().match(/^(.*?)\s+(\d+\S*)$/);
  if (match) return { strasse: match[1].trim(), hausnr: match[2] };
  return { strasse: String(name || "").trim(), hausnr: "" };
}

function vergleicheStrasseHausnummer(a, b) {
  const pa = splitStrasseHausnummer(a.name);
  const pb = splitStrasseHausnummer(b.name);
  const strCompare = pa.strasse.localeCompare(pb.strasse, "de", { sensitivity: "base" });
  if (strCompare !== 0) return strCompare;
  const na = parseInt(pa.hausnr, 10);
  const nb = parseInt(pb.hausnr, 10);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return pa.hausnr.localeCompare(pb.hausnr, "de", { numeric: true });
}

function filteredList() {
  const q = state.search.trim().toLowerCase();
  let list = state.hydranten;
  if (q) list = list.filter((h) =>
    h.name.toLowerCase().includes(q) ||
    (h.lage || "").toLowerCase().includes(q) ||
    (h.nrAlt || "").toLowerCase().includes(q) ||
    (h.nrNeu || "").toLowerCase().includes(q) ||
    (h.durchfluss || "").toLowerCase().includes(q)
  );
  if (state.zustandFilter !== "alle") list = list.filter((h) => h.zustand === state.zustandFilter);
  if (state.bezirkFilter !== "alle") list = list.filter((h) => (h.bezirk || "") === state.bezirkFilter);
  return withDistance(list);
}

function alleBezirke() {
  const set = new Set(state.hydranten.map((h) => (h.bezirk || "").trim()).filter(Boolean));
  return Array.from(set).sort((a, b) => a.localeCompare(b, "de", { numeric: true }));
}

/* ---------- Statistik (aktuell nur LZ Kleve, siehe Anforderung) ---------- */
const STATISTIK_EINHEIT = "LZ Kleve";
let bereitsBenachrichtigteBezirke = new Set();

function istHydrantFertig(h, startdatum) {
  if (!startdatum || !h.letzteKontrolle) return false;
  return h.letzteKontrolle >= startdatum;
}

// Neutrale Anzeige in der Hydrantenkontrolle: solange eine Kontrollrunde läuft (Startdatum gesetzt)
// und ein Hydrant seitdem noch nicht neu geprüft wurde, wird sein Status dort ausgeblendet/neutral
// angezeigt statt des ggf. veralteten Zustands aus einer vorherigen Runde. Die gespeicherten Daten
// selbst (Excel, Karte, Statistik) bleiben davon unberührt - nur diese eine Anzeige wird maskiert.
function zeigeNeutralInHk(h) {
  return !!state.kontrollStartdatum && !istHydrantFertig(h, state.kontrollStartdatum);
}

function berechneStatistik() {
  const startdatum = state.kontrollStartdatum;
  const hydranten = state.hydranten.filter((h) => h.einheit === STATISTIK_EINHEIT && !istSonderBezirk(h));
  const bezirke = {};
  hydranten.forEach((h) => {
    const b = (h.bezirk || "").trim() || "(ohne Bezirk)";
    if (!bezirke[b]) bezirke[b] = { fertig: 0, offen: 0, hydranten: [] };
    const istFertig = istHydrantFertig(h, startdatum);
    bezirke[b][istFertig ? "fertig" : "offen"]++;
    bezirke[b].hydranten.push({ ...h, istFertig });
  });
  Object.values(bezirke).forEach((b) => b.hydranten.sort(vergleicheStrasseHausnummer));
  const gesamtFertig = hydranten.filter((h) => istHydrantFertig(h, startdatum)).length;
  return {
    startdatum,
    gesamt: hydranten.length,
    gesamtFertig,
    gesamtOffen: hydranten.length - gesamtFertig,
    bezirke,
    bezirkNamen: Object.keys(bezirke).sort((a, b) => a.localeCompare(b, "de", { numeric: true })),
  };
}

// Einheitenübergreifend (nicht auf LZ Kleve beschränkt) - fehlende Koordinaten sind ein
// Datenqualitätsthema für die gesamte Wehr, nicht nur für eine Einheit.
function berechneKoordinatenLuecken() {
  const zaehlbar = state.hydranten.filter((h) => !istSonderBezirk(h));
  const fehlend = zaehlbar.filter((h) => typeof h.lat !== "number" || typeof h.lng !== "number");
  const bezirke = {};
  fehlend.forEach((h) => {
    const b = (h.bezirk || "").trim() || "(ohne Bezirk)";
    if (!bezirke[b]) bezirke[b] = [];
    bezirke[b].push(h);
  });
  Object.values(bezirke).forEach((liste) => liste.sort(vergleicheStrasseHausnummer));
  return {
    gesamt: zaehlbar.length,
    anzahlFehlend: fehlend.length,
    bezirke,
    bezirkNamen: Object.keys(bezirke).sort((a, b) => a.localeCompare(b, "de", { numeric: true })),
  };
}

// Wird nach jedem Speichern aufgerufen: prüft, ob ein Bezirk der Statistik-Einheit gerade
// durch diese Speicherung vollständig abgeschlossen wurde, und zeigt dann eine Benachrichtigung.
// Läuft unabhängig davon, wer gerade angemeldet ist (die Statistik-SEITE selbst bleibt trotzdem
// nur für App-Admin einsehbar) - technisch bedingt kann diese Benachrichtigung nur auf dem Gerät
// erscheinen, auf dem gerade gespeichert wird, nicht auf einem separaten Admin-Gerät.
function pruefeBezirkAbschluss(h) {
  if (h.einheit !== STATISTIK_EINHEIT || !h.bezirk || !state.kontrollStartdatum || istSonderBezirk(h)) return;
  const bezirk = h.bezirk.trim();
  if (!bezirk) return;
  const bezirkHydranten = state.hydranten.filter((x) => x.einheit === STATISTIK_EINHEIT && (x.bezirk || "").trim() === bezirk);
  const alleFertig = bezirkHydranten.length > 0 && bezirkHydranten.every((x) => istHydrantFertig(x, state.kontrollStartdatum));
  if (alleFertig && !bereitsBenachrichtigteBezirke.has(bezirk)) {
    bereitsBenachrichtigteBezirke.add(bezirk);
    zeigeBezirkFertigBenachrichtigung(bezirk);
  } else if (!alleFertig) {
    bereitsBenachrichtigteBezirke.delete(bezirk);
  }
}

function zeigeBezirkFertigBenachrichtigung(bezirk) {
  const el = document.createElement("div");
  el.className = "bezirk-fertig-banner";
  el.innerHTML = `🎉 <strong>Bezirk ${esc(bezirk)}</strong> ist komplett abgearbeitet!`;
  el.addEventListener("click", () => el.remove());
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// Wird nach jedem Speichern zusätzlich zu pruefeBezirkAbschluss() aufgerufen: prüft, ob durch
// diese Speicherung WIRKLICH ALLE Bezirke von LZ Kleve fertig geworden sind, und setzt dann
// automatisch ein Abschlussdatum (einmalig, bleibt bis zum Start einer neuen Runde bestehen).
async function pruefeGesamtAbschluss() {
  if (!state.kontrollStartdatum || state.kontrollGesamtAbschlussdatum) return;
  const stat = berechneStatistik();
  if (stat.gesamt > 0 && stat.gesamtOffen === 0) {
    state.kontrollGesamtAbschlussdatum = todayStr();
    await setSetting("kontrollGesamtAbschlussdatum", state.kontrollGesamtAbschlussdatum);
    zeigeGesamtAbschlussBenachrichtigung();
  }
}

function zeigeGesamtAbschlussBenachrichtigung() {
  const el = document.createElement("div");
  el.className = "bezirk-fertig-banner bezirk-fertig-banner-gross";
  el.innerHTML = `🏆 <strong>Alle Bezirke von ${esc(STATISTIK_EINHEIT)}</strong> sind komplett abgearbeitet!`;
  el.addEventListener("click", () => el.remove());
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

function zeigeHydrantenOhneBezirkBenachrichtigung(anzahl) {
  const el = document.createElement("div");
  el.className = "bezirk-fertig-banner bezirk-fertig-banner-info";
  el.innerHTML = `ℹ️ <strong>${anzahl} Hydrant${anzahl === 1 ? "" : "en"} ohne Bezirk</strong> – bitte im Reiter "Karte" zuordnen.`;
  el.addEventListener("click", () => el.remove());
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

// Hydranten, die für die aktuelle Rolle in der Hydrantenkontrolle grundsätzlich sichtbar/bearbeitbar
// sind: Einheiten sehen nur ihre eigenen, Vollzugriffs-Rollen sehen alle.
function getHkRollenListe() {
  return isSonderrolle(state.session) ? state.hydranten.slice() : state.hydranten.filter((h) => h.einheit === state.session);
}

// Bezirke, die in der Bezirksauswahl der Hydrantenkontrolle zur Auswahl stehen (nur Bezirke mit
// für die Rolle sichtbaren Hydranten).
function alleBezirkeFuerHk() {
  const set = new Set(getHkRollenListe().map((h) => (h.bezirk || "").trim()).filter(Boolean));
  return Array.from(set).sort((a, b) => a.localeCompare(b, "de", { numeric: true }));
}

// Basisliste für die aktive Kontrollrunde: eigene/alle Hydranten, gefiltert auf den gewählten Bezirk.
function getHkBasisListe() {
  let list = getHkRollenListe();
  if (state.hkBezirk !== "alle") list = list.filter((h) => (h.bezirk || "") === state.hkBezirk);
  list.sort(vergleicheStrasseHausnummer);
  return list;
}

// "Kontrolliert" bedeutet hier bewusst: heute schon gespeichert/geprüft - unabhängig vom
// Kontrollrunden-Startdatum der Statistik-Seite (das ist eine längerfristige Admin-Kampagne,
// dies hier ist die tagesaktuelle Abarbeitung einer einzelnen Kontrollrunde).
function istHeuteKontrolliert(h) {
  return h.letzteKontrolle === todayStr();
}

/* ---------- Geolocation ---------- */
function locate(onDone) {
  if (!navigator.geolocation) { onDone && onDone("Standortdienste werden nicht unterstützt."); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => { state.userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude }; onDone && onDone(null); },
    (err) => onDone && onDone("Standort nicht verfügbar: " + err.message),
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

/* ---------- Rendering: Bausteine ---------- */
function hydrantRowHTML(h, opts) {
  opts = opts || {};
  const attrName = opts.directEdit ? "data-hk-edit" : "data-open";
  const locked = !canEditHydrant(h, state.session);
  const keineKoordinaten = !(typeof h.lat === "number" && typeof h.lng === "number");
  // In der Hydrantenkontrolle (directEdit) wird der Status neutral angezeigt, solange der Hydrant
  // seit Beginn der laufenden Kontrollrunde noch nicht neu geprüft wurde - siehe zeigeNeutralInHk().
  const neutral = opts.directEdit && zeigeNeutralInHk(h);
  const pillFarbe = neutral ? { color: "#6b7280", bg: "#F3F4F6" } : statusPillFarben(h);
  const pillLabel = neutral ? "Nicht kontrolliert" : statusLabel(h);
  // Bei "Defekt" (und solange der Status nicht neutral ausgeblendet ist) wird nach dem Bezirk
  // zusätzlich angezeigt, welche konkrete(n) Defekt-Art(en) angekreuzt wurden.
  const defektDetails = (!neutral && h.zustand === "defekt")
    ? ausgewaehlteDefektNummern(h).map((n) => DEFEKT_OPTIONEN.find((opt) => opt.startsWith(n + "."))).filter(Boolean)
    : [];
  // Reihenfolge der Zeilen: Nummer (neu/alt) -> Defekt -> Bezirk · Einheit -> Lage
  const nrLine = [h.nrNeu ? `Nr. ${esc(h.nrNeu)}` : null, h.nrAlt ? `(alt: ${esc(h.nrAlt)})` : null].filter(Boolean).join(" ");
  const defektHTML = defektDetails.length > 0 ? `<div class="hydrant-sub hydrant-sub-wrap" style="color:${pillFarbe.color};font-weight:600;">⚠ ${defektDetails.map(esc).join(", ")}</div>` : "";
  const ortLine = [h.bezirk ? `Bez. ${esc(h.bezirk)}` : null, h.einheit ? esc(h.einheit) : null, h.durchfluss ? esc(h.durchfluss) : null].filter(Boolean).join(" · ");
  return `
  <button class="hydrant-row" ${attrName}="${h.id}">
    <div class="hydrant-icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2s6 6.5 6 11a6 6 0 1 1-12 0c0-4.5 6-11 6-11z"/></svg>
    </div>
    <div class="hydrant-main">
      <div class="hydrant-name">${esc(h.name)} ${locked ? '<span class="lock-icon" title="Nur Ansicht">🔒</span>' : ""}${keineKoordinaten ? '<span class="lock-icon" title="Keine Koordinaten hinterlegt">📍</span>' : ""}</div>
      ${nrLine ? `<div class="hydrant-sub">${nrLine}</div>` : ""}
      ${defektHTML}
      ${ortLine ? `<div class="hydrant-sub">${ortLine}</div>` : ""}
      ${h.lage ? `<div class="hydrant-sub">${esc(h.lage)}</div>` : ""}
    </div>
    <div class="hydrant-meta">
      ${h.dist != null ? `<span class="dist">${fmtDist(h.dist)}</span>` : ""}
      <span class="pill" style="color:${pillFarbe.color};background:${pillFarbe.bg};">${esc(pillLabel)}</span>
    </div>
  </button>`;
}

function ensureLeafletMap(list, containerId, neutralModus) {
  containerId = containerId || "leaflet-map";
  const istHauptkarte = containerId === "leaflet-map";
  const container = document.getElementById(containerId);
  if (!container) return;

  if (typeof L === "undefined") {
    container.innerHTML = `<div class="empty-state" style="padding:36px 12px;">
      Kartenbibliothek konnte nicht geladen werden.<br>Einmalig ist dafür eine Internetverbindung nötig – danach wird sie offline gecacht.
    </div>`;
    return;
  }

  // Container wurde durch innerHTML komplett neu erzeugt -> alte Kartenintanz sauber entfernen
  if (leafletMap) { leafletMap.remove(); leafletMap = null; leafletMarkersLayer = null; }

  const hatteGespeicherteAnsicht = istHauptkarte && !!state.mapView;
  const bounds = computeBounds(list.length ? list : state.hydranten);
  const start = (istHauptkarte && state.mapView) || (bounds
    ? { lat: (bounds.minLat + bounds.maxLat) / 2, lng: (bounds.minLng + bounds.maxLng) / 2, zoom: 14 }
    : { lat: 51.1657, lng: 10.4515, zoom: 6 }); // Fallback: Mitte Deutschlands, falls keine Daten vorhanden

  leafletMap = L.map(container, { attributionControl: true }).setView([start.lat, start.lng], start.zoom);

  L.tileLayer(TILE_URL_TEMPLATE, {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende',
  }).addTo(leafletMap);

  leafletMarkersLayer = L.layerGroup().addTo(leafletMap);

  if (istHauptkarte) {
    leafletMap.on("moveend zoomend", () => {
      const c = leafletMap.getCenter();
      state.mapView = { lat: c.lat, lng: c.lng, zoom: leafletMap.getZoom() };
    });

    leafletMap.on("click", (e) => {
      if (state.session === "Einsatzleitung" && state.einsatzplanungModus) {
        state.einsatzplanungPin = { lat: e.latlng.lat, lng: e.latlng.lng };
        state.einsatzplanungModus = false;
        render();
      }
    });
  }

  updateLeafletMarkers(list, neutralModus);

  // Übersichtskarten der Hydrantenkontrolle merken sich keine Position, sondern passen sich immer
  // auf die aktuell gewählte Auswahl an. Die Hauptkarte tut das nur beim allerersten Aufruf (noch
  // keine gemerkte Position vorhanden) - danach bleibt eine vom Nutzer selbst gewählte Position
  // erhalten, Änderungen der Auswahl lösen die Einpassung gezielt über die jeweiligen
  // Auswahl-Handler aus (siehe attachHandlers).
  if (!istHauptkarte || !hatteGespeicherteAnsicht) fitLeafletToList(list, istHauptkarte);

  // Leaflet berechnet seine Größe beim ersten Init manchmal falsch (Layout noch nicht final) -> nachjustieren
  setTimeout(() => { if (leafletMap) leafletMap.invalidateSize(); }, 80);
}

function updateLeafletMarkers(list, neutralModus) {
  if (!leafletMap || !leafletMarkersLayer) return;
  leafletMarkersLayer.clearLayers();

  list
    .filter((h) => typeof h.lat === "number" && typeof h.lng === "number")
    .forEach((h) => {
      // In der Hydrantenkontrolle (neutralModus) wird die Kartenfarbe ebenfalls maskiert, solange
      // der Hydrant seit Rundenstart noch nicht neu geprüft wurde - siehe zeigeNeutralInHk().
      const neutral = neutralModus && zeigeNeutralInHk(h);
      const marker = L.circleMarker([h.lat, h.lng], {
        radius: 8,
        color: "white",
        weight: 2,
        fillColor: neutral ? "#D1D5DB" : kartenFarbeFuerHydrant(h),
        fillOpacity: 1,
      }).addTo(leafletMarkersLayer);
      marker.on("click", (e) => {
        if (e && e.originalEvent) L.DomEvent.stopPropagation(e); // verhindert, dass der Klick zusätzlich den Karten-Klick-Handler (z.B. Einsatzplanung) auslöst
        navVor();
        state.selectedId = h.id;
        state.tab = "detail";
        render();
      });
    });

  if (state.userLoc) {
    L.circleMarker([state.userLoc.lat, state.userLoc.lng], {
      radius: 7, color: "white", weight: 2, fillColor: "#7C3AED", fillOpacity: 1,
    }).addTo(leafletMarkersLayer);
  }

  if (state.session === "Einsatzleitung" && state.einsatzleitungLivePin) {
    const p = state.einsatzleitungLivePin;
    const m = L.circleMarker([p.lat, p.lng], {
      radius: 9, color: "white", weight: 2, fillColor: "#111827", fillOpacity: 1,
    }).addTo(leafletMarkersLayer);
    m.bindTooltip("Einsatzleitung", { permanent: true, direction: "top", offset: [0, -8], className: "einsatzleitung-tooltip" });
  }

  if (state.session === "Einsatzleitung" && state.einsatzplanungPin) {
    const p = state.einsatzplanungPin;
    const m = L.circleMarker([p.lat, p.lng], {
      radius: 9, color: "white", weight: 2, fillColor: "#111827", fillOpacity: 1,
    }).addTo(leafletMarkersLayer);
    m.bindTooltip("Einsatzort", { permanent: true, direction: "top", offset: [0, -8], className: "einsatzleitung-tooltip" });
    if (state.einsatzplanungRadius) {
      L.circle([p.lat, p.lng], { radius: state.einsatzplanungRadius, color: "#111827", weight: 1.5, fillColor: "#111827", fillOpacity: 0.06, interactive: false }).addTo(leafletMarkersLayer);
    }
  }
}

function fitLeafletToList(list, persistAlsMapView = true) {
  if (!leafletMap || typeof L === "undefined") return;
  const pts = list.filter((h) => typeof h.lat === "number" && typeof h.lng === "number");
  if (pts.length === 0) return;

  if (pts.length === 1) {
    leafletMap.setView([pts[0].lat, pts[0].lng], 17);
  } else {
    const bounds = L.latLngBounds(pts.map((h) => [h.lat, h.lng]));
    leafletMap.fitBounds(bounds, { padding: [32, 32], maxZoom: 17 });
  }

  // state.mapView ist die gemerkte Position speziell der Hauptkarte (Reiter "Karte"). Wird diese
  // Funktion für eine der Nebenkarten (Hydrantenkontrolle-Übersicht/aktive Runde) aufgerufen, darf
  // sie state.mapView NICHT mit überschreiben - sonst "vergisst" die Hauptkarte beim nächsten
  // Öffnen ihre eigentlich korrekte Position und zeigt stattdessen die zuletzt von einer Nebenkarte
  // eingepasste (meist völlig andere) Position an.
  if (persistAlsMapView) {
    const c = leafletMap.getCenter();
    state.mapView = { lat: c.lat, lng: c.lng, zoom: leafletMap.getZoom() };
  }
}

/* ---------- Positions-Karte im Formular (GPS + verschiebbarer Marker) ---------- */
function setupPositionPicker(startLat, startLng) {
  const container = document.getElementById("position-map");
  if (!container) return;

  if (typeof L === "undefined") {
    container.innerHTML = `<div class="empty-state" style="padding:24px 12px;">Kartenbibliothek nicht verfügbar (Internetverbindung nötig, danach offline gecacht). Koordinaten können weiterhin manuell eingegeben werden.</div>`;
    return;
  }

  if (positionPickerMap) { positionPickerMap.remove(); positionPickerMap = null; positionPickerMarker = null; }

  const hatStart = typeof startLat === "number" && typeof startLng === "number";
  const center = hatStart ? [startLat, startLng] : (state.mapView ? [state.mapView.lat, state.mapView.lng] : [51.7869, 6.1387]);
  const zoom = hatStart ? 18 : 14;

  // War beim Öffnen bereits eine Position hinterlegt? Dann ist der Marker zum Schutz vor
  // versehentlichem Verschieben zunächst gesperrt - erst ein bewusster Klick auf "Entsperren"
  // erlaubt das Ziehen bzw. Antippen der Karte zum Neupositionieren.
  let positionLocked = hatStart;

  positionPickerMap = L.map(container).setView(center, zoom);
  L.tileLayer(TILE_URL_TEMPLATE, {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende',
  }).addTo(positionPickerMap);

  positionPickerMarker = L.marker(center, { draggable: !positionLocked }).addTo(positionPickerMap);

  function uebernehmen(latlng) {
    document.getElementById("f-lat").value = latlng.lat.toFixed(6);
    document.getElementById("f-lng").value = latlng.lng.toFixed(6);
  }

  const lockRow = document.getElementById("position-lock-row");
  function renderLockRow() {
    if (!lockRow) return;
    lockRow.innerHTML = positionLocked
      ? `<div class="position-lock-note">🔒 Position gesperrt (bereits gesetzt) <button type="button" id="btn-position-unlock" class="btn btn-ghost" style="padding:4px 10px;font-size:11px;">Entsperren zum Verschieben</button></div>`
      : `<div class="position-lock-note position-lock-note-open">🔓 Position entsperrt – Marker kann gezogen/angetippt werden <button type="button" id="btn-position-lock" class="btn btn-ghost" style="padding:4px 10px;font-size:11px;">Sperren</button></div>`;
    const unlockBtn = document.getElementById("btn-position-unlock");
    if (unlockBtn) unlockBtn.addEventListener("click", () => {
      positionLocked = false;
      if (positionPickerMarker) positionPickerMarker.dragging.enable();
      renderLockRow();
    });
    const lockBtn = document.getElementById("btn-position-lock");
    if (lockBtn) lockBtn.addEventListener("click", () => {
      positionLocked = true;
      if (positionPickerMarker) positionPickerMarker.dragging.disable();
      renderLockRow();
    });
  }
  renderLockRow();

  positionPickerMarker.on("dragend", () => uebernehmen(positionPickerMarker.getLatLng()));
  positionPickerMap.on("click", (e) => {
    if (positionLocked) { showToast("Position ist gesperrt – erst \"Entsperren\" antippen, um sie zu verschieben."); return; }
    positionPickerMarker.setLatLng(e.latlng);
    uebernehmen(e.latlng);
  });

  positionPickerMap.on("locationfound", (e) => {
    positionPickerMarker.setLatLng(e.latlng);
    positionPickerMap.setView(e.latlng, 18);
    uebernehmen(e.latlng);
    showToast(`GPS-Genauigkeit: ±${Math.round(e.accuracy)} m – bei Bedarf Marker nachjustieren`);
  });
  positionPickerMap.on("locationerror", (e) => showToast("Standort nicht verfügbar: " + e.message));

  setTimeout(() => { if (positionPickerMap) positionPickerMap.invalidateSize(); }, 80);
}

/* ---------- Tabs ---------- */
function filterChipsHTML() {
  const options = [
    { value: "alle", label: "Alle" },
    { value: "ok", label: "In Ordnung" },
    { value: "defekt", label: "Defekt" },
  ];
  return `
    <div class="filter-chips">
      ${options.map((o) => `<button class="chip chip-${o.value} filter-chip" data-filter="${o.value}" data-active="${state.zustandFilter === o.value}">${o.label}</button>`).join("")}
    </div>`;
}

function bezirkSelectHTML() {
  const bezirke = alleBezirke();
  if (bezirke.length === 0) return "";
  return `
    <select id="bezirk-select" class="bezirk-select">
      <option value="alle" ${state.bezirkFilter === "alle" ? "selected" : ""}>Alle Bezirke</option>
      ${bezirke.map((b) => `<option value="${esc(b)}" ${state.bezirkFilter === b ? "selected" : ""}>Bezirk ${esc(b)}</option>`).join("")}
    </select>`;
}

function karteEinheitSelectHTML() {
  return `
    <select id="karte-einheit-select" class="bezirk-select" style="font-weight:700;">
      <option value="alle" ${state.karteEinheit === "alle" ? "selected" : ""}>Alle Einheiten</option>
      ${EINHEITEN.map((e) => `<option value="${esc(e)}" ${state.karteEinheit === e ? "selected" : ""}>${esc(e)}${e === state.session ? " (eigene)" : ""}</option>`).join("")}
    </select>`;
}

function karteZeigtBezirksfilter() {
  if (state.session === "App-Admin") return true; // App-Admin sieht den Bezirksfilter immer, unabhängig von der gewählten Einheit
  return state.karteEinheit === state.session; // sonst nur bei der eigenen Einheit, nicht bei "Alle" oder fremden Einheiten
}

function filteredListKarte() {
  let list = filteredList();
  if (state.karteEinheit !== "alle") list = list.filter((h) => h.einheit === state.karteEinheit);
  if (state.session === "Einsatzleitung" && state.einsatzplanungPin && state.einsatzplanungRadius) {
    const pin = state.einsatzplanungPin;
    list = list.filter((h) => {
      if (typeof h.lat !== "number" || typeof h.lng !== "number") return false;
      return haversine(pin.lat, pin.lng, h.lat, h.lng) <= state.einsatzplanungRadius;
    });
  }
  // Bewusst immer alphabetisch nach Straße/Hausnummer sortiert, auch wenn durch die Nähe-Funktion
  // bereits ein Standort bekannt ist (die Entfernung wird pro Zeile trotzdem weiter angezeigt).
  return list.slice().sort(vergleicheStrasseHausnummer);
}

function renderEinsatzplanungBlock() {
  if (state.session !== "Einsatzleitung") return "";
  const radien = [100, 200, 500, 1000, 2000];
  if (state.einsatzplanungModus) {
    return `
      <div class="card einsatzplanung-karte">
        📍 Bitte auf die Karte tippen, um den Einsatzort zu setzen.
        <button type="button" id="btn-einsatzplanung-abbrechen" class="btn btn-ghost btn-full" style="margin-top:8px;">Abbrechen</button>
      </div>`;
  }
  if (state.einsatzplanungPin) {
    return `
      <div class="card">
        <div style="font-weight:600;font-size:14px;margin-bottom:8px;">📍 Einsatzplanung aktiv</div>
        <div class="filter-chips">
          <button type="button" class="chip einsatzplanung-radius-chip" data-radius="alle" data-active="${state.einsatzplanungRadius === null}">Alle</button>
          ${radien.map((r) => `<button type="button" class="chip einsatzplanung-radius-chip" data-radius="${r}" data-active="${state.einsatzplanungRadius === r}">${r >= 1000 ? (r / 1000) + " km" : r + " m"}</button>`).join("")}
        </div>
        <div class="btn-row" style="margin-top:8px;">
          <button type="button" id="btn-einsatzplanung-neu" class="btn btn-outline">Neu setzen</button>
          <button type="button" id="btn-einsatzplanung-beenden" class="btn btn-ghost">Beenden</button>
        </div>
      </div>`;
  }
  return `<button type="button" id="btn-einsatzplanung-start" class="btn btn-primary btn-full" style="margin-bottom:12px;">📍 Einsatzplanung</button>`;
}

function renderKarte() {
  const list = filteredListKarte();
  const showBezirk = karteZeigtBezirksfilter();
  return `
    ${karteEinheitSelectHTML()}
    ${showBezirk ? bezirkSelectHTML() : ""}
    ${renderEinsatzplanungBlock()}
    <div class="search-box">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input id="search-input" placeholder="Straße, Lage oder Hydrantennummer suchen…" value="${esc(state.search)}" />
      ${state.search ? `<button type="button" id="search-clear" class="search-clear-btn" aria-label="Suche löschen">✕</button>` : ""}
    </div>
    ${filterChipsHTML()}
    <div class="card" style="padding:0;overflow:hidden;">
      <div id="leaflet-map"></div>
      <p class="map-note" style="padding:8px 12px 10px;margin:0;">© OpenStreetMap-Mitwirkende · Für den Einsatz ohne Netz: Kacheln vorab im Reiter "Daten" herunterladen.</p>
    </div>
    ${list.length === 0 ? `<div class="empty-state">Keine Treffer.</div>` : list.map(hydrantRowHTML).join("")}
  `;
}

function renderNaehe() {
  const list = filteredList();
  const nearest = list[0];
  let hero;
  if (!state.userLoc) {
    hero = `
      <div class="hero-box">
        <div class="hero-eyebrow">Einsatz-Modus</div>
        <p style="font-size:14px;opacity:0.9;margin-bottom:14px;">Standort abrufen, um nahegelegene Hydranten zu sehen.</p>
        <button id="btn-locate" class="btn" style="background:white;color:#7A1B15;border-radius:999px;padding:11px 22px;">Standort abrufen</button>
        <p id="loc-error" class="error-text" style="color:#FCA5A5;"></p>
      </div>`;
  } else if (nearest) {
    hero = `
      <div class="hero-box">
        <div class="hero-eyebrow">Einsatz-Modus</div>
        <div class="hero-big">${fmtDist(nearest.dist)}</div>
        <div class="hero-sub">nächster Hydrant: ${esc(nearest.name)}</div>
        <button id="btn-locate" class="btn-ghost btn" style="margin-top:10px;background:transparent;border:none;color:white;text-decoration:underline;font-size:12px;padding:0;">Standort aktualisieren</button>
      </div>`;
  } else {
    hero = `<div class="hero-box"><div class="hero-eyebrow">Einsatz-Modus</div><p style="font-size:14px;">Keine Hydranten gefunden.</p></div>`;
  }
  return hero + bezirkSelectHTML() + filterChipsHTML() + (state.userLoc ? (list.length === 0 ? `<div class="empty-state">Keine Treffer für diesen Filter.</div>` : list.map(hydrantRowHTML).join("")) : "");
}

function renderHydrantenkontrolle() {
  return state.hkAktiv ? renderHkAktiv() : renderHkEinstieg();
}

function renderHkEinstieg() {
  const bezirke = alleBezirkeFuerHk();
  const liste = getHkBasisListe();
  const kannNeuAnlegen = canEditStammdaten(state.session);

  return `
    <h2 style="font-weight:600;margin:0 0 4px;">Hydrantenkontrolle</h2>
    <p style="font-size:12px;color:#9CA3AF;margin:0 0 14px;">Bezirk auswählen, dann Kontrollrunde starten.</p>

    <select id="hk-bezirk-select" class="bezirk-select">
      <option value="alle" ${state.hkBezirk === "alle" ? "selected" : ""}>Alle Bezirke</option>
      ${bezirke.map((b) => `<option value="${esc(b)}" ${state.hkBezirk === b ? "selected" : ""}>Bezirk ${esc(b)}</option>`).join("")}
    </select>

    <div class="card" style="padding:0;overflow:hidden;margin-top:2px;">
      <div id="hk-uebersicht-map"></div>
      <p class="map-note" style="padding:8px 12px 10px;margin:0;">
        ${liste.length === 0 ? (isSonderrolle(state.session) ? "Keine Hydranten in dieser Auswahl." : "Keine eigenen Hydranten in dieser Auswahl.") : `${liste.length} Hydrant${liste.length === 1 ? "" : "en"} in dieser Auswahl.`}
      </p>
    </div>

    <button type="button" id="btn-hk-starten" class="btn btn-primary btn-full" style="margin-top:14px;" ${liste.length === 0 ? "disabled" : ""}>Hydrantenkontrolle starten</button>
    ${kannNeuAnlegen ? `<button type="button" id="btn-hk-neu" class="btn btn-outline btn-full" style="margin-top:8px;">+ Neuen Hydranten anlegen</button>` : ""}
  `;
}

function renderHkAktiv() {
  const basis = getHkBasisListe();
  let offenListe = basis.filter((h) => !istHeuteKontrolliert(h));
  const kontrolliertListe = basis.filter((h) => istHeuteKontrolliert(h));

  // Sobald ein Standort vorliegt, werden die noch offenen Hydranten nach Entfernung sortiert -
  // der nächste zuerst. Die Kontrolliert-Liste bleibt bewusst alphabetisch (Straße/Hausnummer).
  if (state.userLoc) offenListe = withDistance(offenListe);

  const liste = state.hkFilter === "kontrolliert" ? kontrolliertListe : offenListe;

  return `
    <button class="back-link" id="btn-hk-zurueck">‹ Bezirksauswahl</button>
    <h2 style="font-weight:600;margin:0 0 4px;">Hydrantenkontrolle${state.hkBezirk !== "alle" ? ` · Bezirk ${esc(state.hkBezirk)}` : ""}</h2>
    <p style="font-size:12px;color:#9CA3AF;margin:0 0 12px;">Hydrant antippen, um ihn direkt zu bearbeiten. Nach dem Speichern geht es automatisch zurück in diese Liste.</p>
    ${state.kontrollStartdatum ? `<p style="font-size:11.5px;color:#9CA3AF;margin:-8px 0 12px;background:#F3F4F6;padding:8px 10px;border-radius:8px;">🔄 Kontrollrunde seit ${esc(state.kontrollStartdatum)} aktiv: Hydranten, die seitdem noch nicht neu geprüft wurden, werden hier neutral ("Nicht kontrolliert") angezeigt statt mit ihrem alten Status.</p>` : ""}

    <div class="filter-chips">
      <button type="button" class="chip hk-filter-chip" data-filter="offen" data-active="${state.hkFilter !== "kontrolliert"}">Offen (${offenListe.length})</button>
      <button type="button" class="chip hk-filter-chip" data-filter="kontrolliert" data-active="${state.hkFilter === "kontrolliert"}">Kontrolliert (${kontrolliertListe.length})</button>
    </div>

    <button type="button" id="btn-hk-standort" class="btn btn-outline btn-full" style="margin-bottom:${state.userLoc ? "4px" : "12px"};">
      ${state.userLoc ? "📍 Standort aktualisieren" : "📍 Meinen Standort verwenden"}
    </button>
    ${state.userLoc ? `<p style="font-size:11px;color:#9CA3AF;margin:0 0 12px;text-align:center;">Offene Hydranten sind nach Entfernung sortiert – der nächste steht oben.</p>` : ""}

    <div class="card" style="padding:0;overflow:hidden;">
      <div id="hk-aktiv-map"></div>
    </div>

    ${liste.length === 0
      ? `<div class="empty-state">${state.hkFilter === "kontrolliert" ? "Noch keine Hydranten in dieser Runde kontrolliert." : "Alle Hydranten dieser Auswahl sind heute schon kontrolliert. 🎉"}</div>`
      : liste.map((h) => hydrantRowHTML(h, { directEdit: true })).join("")
    }
  `;
}

function fieldHTML(id, label, inner) {
  return `<label class="field"><span class="lbl">${label}</span>${inner}</label>`;
}

let formFotoUrl = null; // Object-URL der aktuell im Formular angezeigten Vorschau (wird bei Bedarf freigegeben)
let pendingFotoBlob = undefined; // undefined = unverändert, null = entfernt, Blob = neues Foto
let formLageFotoUrl = null;
let pendingLageFotoBlob = undefined; // undefined = unverändert, null = Löschversuch, Blob = neues/ersetztes Foto
let detailFotoUrl = null; // Object-URL des Fotos in der Detailansicht
let detailLageFotoUrl = null;

function openFotoLightbox(url) {
  const box = document.createElement("div");
  box.className = "foto-lightbox";
  box.innerHTML = `<img src="${url}" alt="Foto Vollansicht" />`;
  box.addEventListener("click", () => box.remove());
  document.body.appendChild(box);
}

function renderForm(h) {
  const isEdit = !!h;
  h = h || { id: uid(), name: "", nrAlt: "", nrNeu: "", bezirk: "", einheit: isSonderrolle(state.session) ? "" : state.session, durchfluss: "", lat: "", lng: "", lage: "", zustand: "ok", besonderheiten: "", letzteKontrolle: todayStr() };
  const einheitLocked = !isSonderrolle(state.session);
  const stammdatenLocked = !canEditStammdaten(state.session);
  const lockedAttr = 'disabled style="background:#F4F5F6;color:#6b7280;"';

  if (formFotoUrl) { URL.revokeObjectURL(formFotoUrl); formFotoUrl = null; }
  if (h.foto instanceof Blob) formFotoUrl = URL.createObjectURL(h.foto);
  pendingFotoBlob = undefined;

  if (formLageFotoUrl) { URL.revokeObjectURL(formLageFotoUrl); formLageFotoUrl = null; }
  if (h.lageFoto instanceof Blob) formLageFotoUrl = URL.createObjectURL(h.lageFoto);
  pendingLageFotoBlob = undefined;

  const lageFotoVorhanden = h.lageFoto instanceof Blob;
  const lageFotoDarfAendern = isSonderrolle(state.session) || state.lageFotoFreigegeben;
  const lageFotoDarfAufnehmen = lageFotoDarfAendern;
  const lageFotoDarfLoeschen = lageFotoVorhanden && lageFotoDarfAendern;

  return `
    <h2 style="font-weight:600;margin:0 0 14px;">${isEdit ? "Hydrant bearbeiten" : "Neuen Hydranten erfassen"}</h2>
    <form id="hydrant-form" data-id="${h.id}">
      ${fieldHTML("f-name", "Bezeichnung / Standortname", `<input id="f-name" value="${esc(h.name)}" placeholder="z. B. Marktplatz" ${stammdatenLocked ? lockedAttr : ""} required />`)}
      ${fieldHTML("f-einheit", "Einheit", einheitLocked
        ? `<input id="f-einheit" value="${esc(h.einheit)}" disabled style="background:#F4F5F6;color:#6b7280;" /><input type="hidden" id="f-einheit-value" value="${esc(h.einheit)}" />`
        : `<select id="f-einheit">${EINHEITEN.map((e) => `<option value="${esc(e)}" ${h.einheit === e ? "selected" : ""}>${esc(e)}</option>`).join("")}</select>`
      )}
      ${fieldHTML("f-durchfluss", "Nennweite", `
        <div class="prefix-input">
          <span class="prefix-tag">H-</span>
          <input id="f-durchfluss" value="${esc((h.durchfluss || "").replace(/^H-?/i, ""))}" inputmode="numeric" placeholder="100" />
        </div>
      `)}
      <div class="row-2">
        ${fieldHTML("f-nrneu", "Hydrantennummer (neu)", `<input id="f-nrneu" value="${esc(h.nrNeu)}" placeholder="z. B. 04-112" ${stammdatenLocked ? lockedAttr : ""} />`)}
        ${fieldHTML("f-nralt", "Hydrantennummer (alt)", `<input id="f-nralt" value="${esc(h.nrAlt)}" placeholder="z. B. 112" ${stammdatenLocked ? lockedAttr : ""} />`)}
      </div>
      ${fieldHTML("f-bezirk", "Bezirk", `<input id="f-bezirk" value="${esc(h.bezirk)}" placeholder="z. B. 34" list="bezirk-vorschlaege" ${stammdatenLocked ? lockedAttr : ""} />`)}
      <datalist id="bezirk-vorschlaege">${alleBezirke().map((b) => `<option value="${esc(b)}"></option>`).join("")}</datalist>
      ${stammdatenLocked ? `<p style="font-size:12px;color:#9CA3AF;margin:-8px 0 14px;">🔒 Bezeichnung, Hydrantennummern und Bezirk können nur von Stadtwerke/App-Admin geändert werden.</p>` : ""}
      <div class="row-2">
        ${fieldHTML("f-lat", "Breitengrad (optional)", `<input id="f-lat" value="${esc(h.lat)}" inputmode="decimal" placeholder="50.1109" />`)}
        ${fieldHTML("f-lng", "Längengrad (optional)", `<input id="f-lng" value="${esc(h.lng)}" inputmode="decimal" placeholder="8.6821" />`)}
      </div>
      <div class="field">
        <span class="lbl">Position auf der Karte</span>
        <div id="position-map"></div>
        <div id="position-lock-row" class="position-lock-row"></div>
        <button type="button" id="btn-gps-locate" class="btn btn-outline btn-full" style="margin-top:8px;">🎯 GPS-Standort ermitteln</button>
        <p style="font-size:11px;color:#9CA3AF;margin-top:6px;">GPS ist bauartbedingt oft 3–10 m ungenau – Marker danach exakt auf den Schachtdeckel/Gehweg ziehen oder antippen.</p>
      </div>
      <input type="hidden" id="f-position-hatte-start" value="${typeof h.lat === "number" && typeof h.lng === "number" ? "1" : "0"}" />
      ${fieldHTML("f-lage", "Lage / Beschreibung", `<textarea id="f-lage" rows="2" placeholder="z. B. Gehweg vor Hausnummer 12, Deckel gelb">${esc(h.lage)}</textarea>`)}
      <div class="field">
        <span class="lbl">Foto zur Lage (bei schwer auffindbaren Hydranten)</span>
        <div class="foto-block foto-block-row">
          <div id="lagefoto-preview" class="foto-preview foto-preview-sm">
            ${formLageFotoUrl ? `<img src="${formLageFotoUrl}" alt="Lage-Foto Vorschau" />` : `<span class="foto-empty">Kein Foto</span>`}
          </div>
          <div class="foto-btns-col">
            <button type="button" id="btn-lagefoto-take" class="btn btn-outline" style="${lageFotoDarfAufnehmen ? "" : "display:none;"}">📷 ${lageFotoVorhanden ? "Ersetzen" : "Aufnehmen"}</button>
            <button type="button" id="btn-lagefoto-remove" class="btn btn-ghost" style="${lageFotoDarfLoeschen ? "" : "display:none;"}">Entfernen</button>
          </div>
          <input type="file" id="f-lagefoto-input" accept="image/*" capture="environment" class="hidden" />
        </div>
        ${!lageFotoDarfAendern ? `<p style="font-size:12px;color:#9CA3AF;margin-top:6px;">🔒 ${lageFotoVorhanden ? "Freigabe wurde zurückgenommen – dieses Foto kann nur noch von Vollzugriffs-Rollen geändert oder gelöscht werden." : "Aufnahme aktuell nicht freigegeben (durch Vollzugriffs-Rolle im Reiter \"Daten\" aktivierbar)."}</p>` : ""}
      </div>
      <div class="field"><span class="lbl">Zustand</span>
        <div class="zustand-picker">
          ${ZUSTAENDE.map((z) => `<button type="button" class="zustand-btn zustand-opt" data-val="${z.value}" data-active="${z.value === h.zustand}">${z.label}</button>`).join("")}
        </div>
        <input type="hidden" id="f-zustand" value="${h.zustand}" />
      </div>
      <div id="defekt-optionen" class="field" style="display:${h.zustand === "defekt" ? "block" : "none"}">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="lbl" style="margin-bottom:0;">Defekt-Art (Mehrfachauswahl möglich)</span>
          <button type="button" id="btn-toggle-defekt" class="btn btn-ghost" style="padding:4px 10px;font-size:11px;">Anzeigen</button>
        </div>
        <div id="defekt-zusammenfassung" style="font-size:12.5px;color:#6b7280;margin-top:4px;">
          ${(() => {
            const ausgewaehlt = DEFEKT_OPTIONEN.filter((opt) => (h.besonderheiten || "").split("\n").map((l) => l.trim()).includes(opt));
            return ausgewaehlt.length > 0 ? `Ausgewählt: ${ausgewaehlt.map(esc).join(", ")}` : "Noch keine Defekt-Art ausgewählt.";
          })()}
        </div>
        <div id="defekt-chips-box" class="defekt-chips" style="display:none;margin-top:8px;">
          ${DEFEKT_OPTIONEN.map((opt) => `
            <label class="defekt-chip">
              <input type="checkbox" class="defekt-checkbox" value="${esc(opt)}" ${(h.besonderheiten || "").split("\n").map((l) => l.trim()).includes(opt) ? "checked" : ""} />
              ${esc(opt)}
            </label>`).join("")}
        </div>
      </div>
      ${fieldHTML("f-bes", "Besonderheiten / Defekte", `<textarea id="f-bes" rows="3" placeholder="z. B. Kappe schwergängig, Zufahrt eingeschränkt…">${esc(h.besonderheiten)}</textarea>`)}
      <div class="field">
        <span class="lbl">Foto zur Beschädigung</span>
        <div class="foto-block foto-block-row">
          <div id="foto-preview" class="foto-preview foto-preview-sm">
            ${formFotoUrl ? `<img src="${formFotoUrl}" alt="Foto Vorschau" />` : `<span class="foto-empty">Kein Foto</span>`}
          </div>
          <div class="foto-btns-col">
            <button type="button" id="btn-foto-take" class="btn btn-outline">📷 Aufnehmen</button>
            <button type="button" id="btn-foto-remove" class="btn btn-ghost" style="${formFotoUrl ? "" : "display:none;"}">Entfernen</button>
          </div>
          <input type="file" id="f-foto-input" accept="image/*" capture="environment" class="hidden" />
        </div>
      </div>
      ${fieldHTML("f-datum", "Letzte Kontrolle", `<input type="date" id="f-datum" value="${esc(todayStr())}" />`)}
      <p style="font-size:11px;color:#9CA3AF;margin:-8px 0 14px;">Wird beim Öffnen automatisch auf heute gesetzt (zählt für die Statistik als "kontrolliert") – bei Bedarf manuell änderbar.</p>
      <p id="form-error" class="error-text"></p>
      <div class="btn-row">
        <button type="button" id="btn-cancel-form" class="btn btn-ghost">Abbrechen</button>
        <button type="submit" class="btn btn-primary">Speichern</button>
      </div>
    </form>
  `;
}

function renderDetail(h) {
  const dist = state.userLoc ? haversine(state.userLoc.lat, state.userLoc.lng, h.lat, h.lng) : null;
  const editable = canEditHydrant(h, state.session);

  if (detailFotoUrl) { URL.revokeObjectURL(detailFotoUrl); detailFotoUrl = null; }
  if (h.foto instanceof Blob) detailFotoUrl = URL.createObjectURL(h.foto);
  if (detailLageFotoUrl) { URL.revokeObjectURL(detailLageFotoUrl); detailLageFotoUrl = null; }
  if (h.lageFoto instanceof Blob) detailLageFotoUrl = URL.createObjectURL(h.lageFoto);

  return `
    <button class="back-link" id="btn-back">‹ Zurück</button>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div>
          <h2 style="margin:0;font-size:17px;font-weight:600;">${esc(h.name)}</h2>
          <p style="margin:2px 0 0;font-size:13px;color:#6b7280;">
            ${h.einheit ? `${esc(h.einheit)} · ` : ""}${h.durchfluss ? `${esc(h.durchfluss)} · ` : ""}${h.nrNeu ? `Nr. ${esc(h.nrNeu)}` : "keine neue Nr."}${h.nrAlt ? ` · alt: ${esc(h.nrAlt)}` : ""}${h.bezirk ? ` · Bezirk ${esc(h.bezirk)}` : ""}
          </p>
        </div>
        <span class="pill" style="color:${statusPillFarben(h).color};background:${statusPillFarben(h).bg};">${esc(statusLabel(h))}</span>
      </div>
      ${dist != null ? `<p style="color:#A72920;font-weight:600;font-size:14px;margin:10px 0 0;">${fmtDist(dist)} von deinem Standort entfernt</p>` : ""}
      <p class="mono" style="margin:8px 0 0;">${typeof h.lat === "number" && typeof h.lng === "number" ? `${h.lat.toFixed(6)}, ${h.lng.toFixed(6)}` : "📍 Keine Koordinaten hinterlegt – über \"Bearbeiten\" → \"Aktuellen Standort verwenden\" ergänzen"}</p>
      ${detailFotoUrl ? `
        <div style="margin-top:12px;">
          <div style="font-size:11px;color:#9CA3AF;margin-bottom:4px;">Foto zur Beschädigung</div>
          <img id="detail-foto-img" src="${detailFotoUrl}" alt="Foto der Beschädigung" class="foto-thumb" />
        </div>` : ""
      }
      <div style="margin-top:12px;">
        <div style="font-size:11px;color:#9CA3AF;">Lage</div>
        <p style="margin:2px 0;font-size:14px;">${esc(h.lage) || "–"}</p>
      </div>
      ${detailLageFotoUrl ? `
        <div style="margin-top:8px;">
          <div style="font-size:11px;color:#9CA3AF;margin-bottom:4px;">Foto zur Lage${!isSonderrolle(state.session) && !state.lageFotoFreigegeben ? ' <span style="color:#9CA3AF;">🔒 nur durch Vollzugriff änderbar</span>' : ""}</div>
          <img id="detail-lagefoto-img" src="${detailLageFotoUrl}" alt="Foto zur Lage" class="foto-thumb" />
        </div>` : ""
      }
      <div style="margin-top:10px;">
        <div style="font-size:11px;color:#9CA3AF;">Besonderheiten / Defekte</div>
        <p style="margin:2px 0;font-size:14px;">${esc(h.besonderheiten) || "Keine Auffälligkeiten"}</p>
      </div>
      <div style="margin-top:10px;">
        <div style="font-size:11px;color:#9CA3AF;">Letzte Kontrolle</div>
        <p style="margin:2px 0;font-size:14px;">
          ${esc(h.letzteKontrolle) || "–"}${h.geaendertVon ? `<span style="color:#A72920;font-weight:600;"> · geändert von: ${esc(h.geaendertVon)}</span>` : ""}
        </p>
      </div>
    </div>
    <div class="btn-row">
      ${editable
        ? `<button id="btn-edit" class="btn btn-outline${canDeleteHydrant(state.session) ? "" : " btn-full"}">Bearbeiten</button>
           ${canDeleteHydrant(state.session) ? `<button id="btn-delete" class="btn btn-outline-danger">Löschen</button>` : ""}`
        : `<div class="readonly-note">🔒 Nur Ansicht – gehört zu ${esc(h.einheit || "einer anderen Einheit")}. Nur Vollzugriffs-Rollen dürfen fremde Hydranten bearbeiten.</div>`
      }
    </div>
  `;
}

function renderDaten() {
  if (state.session === "Stadtwerke" || state.session === "Wehrführung") return renderDatenEingeschraenkt();
  if (state.session === "Einsatzleitung") return renderDatenEinsatzleitung();
  if (state.session === "App-Admin") return renderDatenAppAdmin();
  // Einheiten (kein Vollzugriff)
  return `
    <h2 style="font-weight:600;margin:0 0 4px;">Daten verwalten</h2>
    <p style="font-size:13px;color:#6b7280;margin:0 0 16px;">${state.hydranten.length} Hydranten lokal gespeichert.</p>
    <div class="card">
      <div class="readonly-note">🔒 Excel-Import und -Export sind nur für Vollzugriffs-Rollen (Einsatzleitung, Stadtwerke, Wehrführung, App-Admin) verfügbar.</div>
    </div>
  `;
}

// App-Admin: Reiter "Daten" ebenfalls in zwei aufklappbare Abschnitte gegliedert - "Daten"
// (Export/Import) und "Funktionen" (Lage-Fotos, Fotoexport, Archiv, Offline-Kacheln). "Alle Daten
// löschen" bleibt bewusst außerhalb der Abschnitte sichtbar, da es eine kritische Aktion ist.
function renderDatenAppAdmin() {
  const datenInhalt = `
    <div class="card" style="box-shadow:none;border:1px solid #e5e7eb;">
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;">
        <div class="hydrant-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></div>
        <div>
          <div style="font-weight:600;font-size:14px;">Als Excel exportieren</div>
          <div style="font-size:12px;color:#6b7280;">Alle Hydranten als .xlsx-Datei</div>
        </div>
      </div>
      <button id="btn-export" class="btn btn-primary btn-full">Export starten</button>
    </div>
    <div class="card" style="box-shadow:none;border:1px solid #e5e7eb;">
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;">
        <div class="hydrant-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>
        <div>
          <div style="font-weight:600;font-size:14px;">Aus Excel importieren</div>
          <div style="font-size:12px;color:#6b7280;">Spalten: Name, HydrantennummerNeu, HydrantennummerAlt, Nennweite, Bezirk, Breitengrad, Laengengrad, Lage, Zustand, Besonderheiten, LetzteKontrolle</div>
        </div>
      </div>
      <button id="btn-import" class="btn btn-outline btn-full">Datei auswählen</button>
    </div>
  `;

  const funktionenInhalt = `
    <div class="card" style="box-shadow:none;border:1px solid #e5e7eb;">
      <div style="font-weight:600;font-size:14px;margin-bottom:4px;">Lage-Foto-Funktion</div>
      <div style="font-size:12px;color:#6b7280;margin-bottom:12px;">
        Steuert, ob Einheiten selbst ein Foto zur Lage eines Hydranten aufnehmen dürfen (für schwer
        auffindbare Hydranten). Einmal aufgenommen, kann dieses Foto nur noch von Vollzugriffs-Rollen
        geändert oder gelöscht werden – unabhängig von diesem Schalter.
      </div>
      <label style="display:flex;align-items:center;gap:10px;font-size:14px;font-weight:600;color:#374151;">
        <input type="checkbox" id="chk-lagefoto" ${state.lageFotoFreigegeben ? "checked" : ""} style="width:20px;height:20px;accent-color:var(--brand);flex-shrink:0;" />
        Lage-Foto-Aufnahme für Einheiten freigeben
      </label>
    </div>

    <div class="card" style="box-shadow:none;border:1px solid #e5e7eb;">
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;">
        <div class="hydrant-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></div>
        <div>
          <div style="font-weight:600;font-size:14px;">Fotos exportieren</div>
          <div style="font-size:12px;color:#6b7280;">Alle bisher aufgenommenen Fotos gesammelt als ZIP-Datei, jede Datei benannt nach dem zugehörigen Hydranten. Manuelles Sicherungsnetz, bis ein Server-Upload mit automatischer Zuordnung existiert.</div>
        </div>
      </div>
      <button id="btn-export-fotos" class="btn btn-outline btn-full">Fotos als ZIP herunterladen</button>
    </div>

    <div class="card" style="box-shadow:none;border:1px solid #e5e7eb;">
      <div style="font-weight:600;font-size:14px;margin-bottom:4px;">Jahresarchiv</div>
      <div style="font-size:12px;color:#6b7280;margin-bottom:12px;">
        Am 30.09. eines Jahres legt der Server automatisch einen Datenstand-Snapshot an (ohne Fotos). Von hier aus als Excel-Datei herunterladen und selbst in eurem Archivordner ablegen.
      </div>
      ${state.archivListe.length === 0
        ? `<p style="font-size:13px;color:#9CA3AF;margin:0;">Noch kein Jahresarchiv vorhanden.</p>`
        : state.archivListe.map((a) => `
            <div class="archiv-zeile">
              <div>
                <div style="font-weight:600;font-size:14px;">Jahresarchiv ${a.jahr}</div>
                <div style="font-size:11.5px;color:#9CA3AF;">${a.hydranten.length} Hydranten · erstellt am ${esc(new Date(a.erstelltAm).toLocaleDateString("de-DE"))}</div>
              </div>
              <button type="button" class="btn btn-outline btn-archiv-download" data-jahr="${a.jahr}">Herunterladen</button>
            </div>
          `).join("")
      }
      <button type="button" id="btn-archiv-jetzt" class="btn btn-outline" style="margin-top:10px;">Archiv ${new Date().getFullYear()} jetzt erstellen</button>
    </div>

    <div class="card" style="box-shadow:none;border:1px solid #e5e7eb;">
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;">
        <div class="hydrant-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z"/><path d="M8 2v16"/><path d="M16 6v16"/></svg></div>
        <div>
          <div style="font-weight:600;font-size:14px;">Kartenkacheln für Offline-Nutzung</div>
          <div style="font-size:12px;color:#6b7280;">Lädt Straßenkarten-Kacheln rund um eure Hydranten herunter (Zoomstufen ${OFFLINE_ZOOM_MIN}–${OFFLINE_ZOOM_MAX}), damit die Karte im Einsatz auch ohne Netz funktioniert. Einmalig mit Internetverbindung nötig, kann je nach Gebiet einige Minuten dauern.</div>
        </div>
      </div>
      <button id="btn-download-tiles" class="btn btn-primary btn-full">Kacheln jetzt herunterladen</button>
      <div id="tile-download-status" style="font-size:12px;color:#6b7280;margin-top:8px;"></div>
    </div>
  `;

  return `
    <h2 style="font-weight:600;margin:0 0 4px;">Daten verwalten</h2>
    <p style="font-size:13px;color:#6b7280;margin:0 0 16px;">${state.hydranten.length} Hydranten lokal gespeichert. Abschnitt antippen zum Auf-/Zuklappen.</p>

    ${statistikAbschnittHTML("adminDaten", "📁 Daten", null, datenInhalt)}
    ${statistikAbschnittHTML("adminFunktionen", "⚙️ Funktionen", null, funktionenInhalt)}

    <p style="font-size:11px;color:#9CA3AF;line-height:1.5;margin-top:14px;">
      Alle Daten liegen auf dem Server und werden auf jedem Gerät zwischengespeichert. Ohne Internet
      arbeitest du normal weiter, Änderungen werden später automatisch übertragen.
    </p>

    <button type="button" id="btn-konten-oeffnen" class="info-link-row" style="border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.05);margin-top:14px;">
      <span>👥 Konten &amp; Passwörter</span><span class="info-link-chevron">›</span>
    </button>

    <button type="button" id="btn-daten-loeschen-oeffnen" class="info-link-row" style="border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.05);margin-top:6px;color:#C22E2E;">
      <span>⚠️ Alle Daten löschen</span><span class="info-link-chevron">›</span>
    </button>
  `;
}

/* ---------- Konten (App-Admin) ---------- */
async function kontenAufruf(body) {
  const { data, error } = await sb.functions.invoke("konten-verwalten", { body });
  if (error) {
    let msg = "Server nicht erreichbar";
    try { const j = await error.context.json(); if (j && j.fehler) msg = j.fehler; } catch (e) {}
    throw new Error(msg);
  }
  return data;
}

function renderKonten() {
  const k = state.konten;
  let inhalt;
  if (state.kontenFehler) {
    inhalt = `<p class="error-text">${esc(state.kontenFehler)}</p><button class="btn btn-full" id="btn-konten-neu-laden">Erneut laden</button>`;
  } else if (!k) {
    inhalt = `<p style="color:#6B7280;">Konten werden geladen …</p>`;
  } else {
    const zeilen = k.konten.map((x) => `
      <div class="konto-zeile" style="background:#fff;border-radius:12px;padding:10px 12px;margin-bottom:8px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
        <div style="font-weight:600;">${esc(x.rolle)}</div>
        <div style="font-size:12px;color:#6B7280;margin-bottom:6px;">Benutzername: <code>${esc(x.benutzername)}</code></div>
        <button type="button" class="btn btn-sm konto-pw-btn" data-uid="${esc(x.user_id)}" data-rolle="${esc(x.rolle)}">Passwort ändern</button>
      </div>`).join("");
    const opts = k.ohne_konto.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("");
    const neu = k.ohne_konto.length === 0 ? `<p style="color:#6B7280;">Alle Rollen haben bereits ein Konto.</p>` : `
      <div class="field"><span class="lbl">Rolle / Einheit</span>
        <select id="konto-rolle">${opts}</select></div>
      <div class="field" style="margin-top:8px;"><span class="lbl">Benutzername (Beispiel: lz-kleve)</span>
        <input type="text" id="konto-name" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off" /></div>
      <div class="field" style="margin-top:8px;"><span class="lbl">Passwort (mind. 12 Zeichen)</span>
        <input type="password" id="konto-pass" autocomplete="new-password" /></div>
      <p id="konto-fehler" class="error-text"></p>
      <button class="btn btn-primary btn-full" id="btn-konto-anlegen">Konto anlegen</button>`;
    inhalt = `
      <h3 style="margin:12px 0 8px;">Bestehende Konten</h3>${zeilen || "<p style='color:#6B7280;'>Noch keine Konten.</p>"}
      <h3 style="margin:16px 0 8px;">Neues Konto</h3>${neu}
      <p style="font-size:11px;color:#9CA3AF;line-height:1.5;margin-top:14px;">Passwörter werden nur von dir hier eingegeben und nirgends angezeigt oder gespeichert. Intern lautet die Anmeldeadresse <code>benutzername@${LOGIN_DOMAIN}</code>.</p>`;
  }
  return `
    <button class="back-link" id="btn-konten-back">‹ Zurück</button>
    <h2 style="font-weight:600;margin:0 0 4px;">👥 Konten &amp; Passwörter</h2>
    ${inhalt}`;
}

async function ladeKonten() {
  try {
    state.kontenFehler = null;
    state.konten = await kontenAufruf({ aktion: "liste" });
  } catch (e) { state.kontenFehler = e.message; }
  if (state.tab === "konten") render();
}

function setupKontenHandlers() {
  const back = document.getElementById("btn-konten-back");
  if (back) back.addEventListener("click", navZurueck);
  if (!state.konten && !state.kontenFehler) { ladeKonten(); return; }
  const neuLaden = document.getElementById("btn-konten-neu-laden");
  if (neuLaden) neuLaden.addEventListener("click", () => { state.konten = null; state.kontenFehler = null; render(); });

  const anlegen = document.getElementById("btn-konto-anlegen");
  if (anlegen) anlegen.addEventListener("click", async () => {
    const errEl = document.getElementById("konto-fehler");
    const rolle = document.getElementById("konto-rolle").value;
    const benutzername = document.getElementById("konto-name").value.trim().toLowerCase();
    const passwort = document.getElementById("konto-pass").value;
    if (passwort.length < 12) { errEl.textContent = "Passwort muss mindestens 12 Zeichen haben."; return; }
    anlegen.disabled = true;
    try {
      await kontenAufruf({ aktion: "anlegen", rolle, benutzername, passwort });
      showToast(`Konto für ${rolle} angelegt`);
      state.konten = null;
      render();
    } catch (e) { errEl.textContent = e.message; anlegen.disabled = false; }
  });

  document.querySelectorAll(".konto-pw-btn").forEach((b) => b.addEventListener("click", async () => {
    const pw = prompt(`Neues Passwort für ${b.dataset.rolle} (mind. 12 Zeichen):`);
    if (pw === null) return;
    if (pw.length < 12) { alert("Passwort muss mindestens 12 Zeichen haben."); return; }
    try {
      await kontenAufruf({ aktion: "passwort_setzen", user_id: b.dataset.uid, passwort: pw });
      showToast("Passwort geändert");
    } catch (e) { alert(e.message); }
  }));
}

// Eigene, bewusst separate Unterseite für die kritische Löschfunktion - mit Texteingabe-
// Bestätigung zusätzlich zur normalen Sicherheitsabfrage, damit das nicht versehentlich passiert.
function renderDatenLoeschen() {
  return `
    <button class="back-link" id="btn-loeschen-back">‹ Zurück</button>
    <h2 style="font-weight:600;margin:0 0 4px;color:#C22E2E;">⚠️ Alle Daten löschen</h2>
    <div class="card" style="border:1px solid #FCA5A5;background:#FEF2F2;">
      <p style="font-size:13px;color:#7F1D1D;line-height:1.6;margin:0 0 14px;">
        Dadurch werden <strong>alle ${state.hydranten.length} aktuell gespeicherten Hydranten</strong>
        (inkl. Fotos und Änderungshistorie) unwiderruflich vom Server und von allen Geräten gelöscht. Das kann
        <strong>nicht rückgängig</strong> gemacht werden. Erstellt vorher unbedingt eine Sicherung
        (Excel-Export bzw. Fotoexport im Bereich "Daten"/"Funktionen"), falls ihr diese Daten noch braucht.
      </p>
      <label class="field" style="margin-bottom:12px;">
        <span class="lbl">Zur Bestätigung "LÖSCHEN" eingeben</span>
        <input type="text" id="loeschen-bestaetigung" placeholder="LÖSCHEN" autocomplete="off" autocapitalize="characters" />
      </label>
      <button type="button" id="btn-loeschen-endgueltig" class="btn btn-outline-danger btn-full" disabled>Alle Daten endgültig löschen</button>
    </div>
  `;
}

// Einsatzleitung: im Reiter "Daten" ausschließlich die Kartenkacheln fürs Offline-Arbeiten - kein
// Export/Import, keine Lage-Foto-Freigabe, kein Jahresarchiv, kein "Alle Daten löschen".
function renderDatenEinsatzleitung() {
  return `
    <h2 style="font-weight:600;margin:0 0 4px;">Daten verwalten</h2>
    <p style="font-size:13px;color:#6b7280;margin:0 0 16px;">${state.hydranten.length} Hydranten lokal gespeichert.</p>

    <div class="card">
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;">
        <div class="hydrant-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z"/><path d="M8 2v16"/><path d="M16 6v16"/></svg></div>
        <div>
          <div style="font-weight:600;font-size:14px;">Kartenkacheln für Offline-Nutzung</div>
          <div style="font-size:12px;color:#6b7280;">Lädt Straßenkarten-Kacheln rund um eure Hydranten herunter (Zoomstufen ${OFFLINE_ZOOM_MIN}–${OFFLINE_ZOOM_MAX}), damit die Karte im Einsatz auch ohne Netz funktioniert. Einmalig mit Internetverbindung nötig, kann je nach Gebiet einige Minuten dauern.</div>
        </div>
      </div>
      <button id="btn-download-tiles" class="btn btn-primary btn-full">Kacheln jetzt herunterladen</button>
      <div id="tile-download-status" style="font-size:12px;color:#6b7280;margin-top:8px;"></div>
    </div>
  `;
}

// Eingeschränkte Daten-Ansicht, aktuell für Stadtwerke und Wehrführung: statt der flachen Liste
// drei aufklappbare Abschnitte (Daten/Archiv/Statistik). Kein Lage-Foto-Schalter, kein "Alle Daten
// löschen"-Reset, kein Excel-Import, kein eigener Hydrantenkontrolle-Zugriff auf die Statistik-
// Verwaltung (nur die reine Übersicht) - "Neuen Hydranten anlegen" erscheint nur, wenn die jeweilige
// Rolle das tatsächlich darf (siehe canEditStammdaten()).
function renderDatenEingeschraenkt() {
  const kannNeuAnlegen = canEditStammdaten(state.session);
  const datenInhalt = `
    <div class="card" style="box-shadow:none;border:1px solid #e5e7eb;">
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;">
        <div class="hydrant-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></div>
        <div>
          <div style="font-weight:600;font-size:14px;">Als Excel exportieren</div>
          <div style="font-size:12px;color:#6b7280;">Alle Hydranten als .xlsx-Datei</div>
        </div>
      </div>
      <button id="btn-export" class="btn btn-outline btn-full">Export starten</button>
    </div>
    ${kannNeuAnlegen ? `
    <button type="button" id="btn-daten-neu-hydrant" class="btn btn-primary btn-full">+ Neuen Hydranten anlegen</button>
    <p style="font-size:11px;color:#9CA3AF;margin:8px 0 0;">Neu angelegte Hydranten erscheinen automatisch beim App-Admin, der ihnen dann einen Bezirk zuordnet.</p>
    ` : ""}
  `;

  const archivInhalt = `
    <p style="font-size:12px;color:#6b7280;margin:0 0 12px;">
      Am 30.09. eines Jahres legt der Server automatisch einen Datenstand-Snapshot an (ohne Fotos). Von hier aus als Excel-Datei herunterladen und selbst in eurem Archivordner ablegen.
    </p>
    ${state.archivListe.length === 0
      ? `<p style="font-size:13px;color:#9CA3AF;margin:0;">Noch kein Jahresarchiv vorhanden.</p>`
      : state.archivListe.map((a) => `
          <div class="archiv-zeile">
            <div>
              <div style="font-weight:600;font-size:14px;">Jahresarchiv ${a.jahr}</div>
              <div style="font-size:11.5px;color:#9CA3AF;">${a.hydranten.length} Hydranten · erstellt am ${esc(new Date(a.erstelltAm).toLocaleDateString("de-DE"))}</div>
            </div>
            <button type="button" class="btn btn-outline btn-archiv-download" data-jahr="${a.jahr}">Herunterladen</button>
          </div>
        `).join("")
    }
  `;
  const archivKurzstatus = state.archivListe.length > 0 ? `${state.archivListe.length} Jahr${state.archivListe.length === 1 ? "" : "e"}` : "noch keins";

  return `
    <h2 style="font-weight:600;margin:0 0 4px;">Daten verwalten</h2>
    <p style="font-size:13px;color:#6b7280;margin:0 0 16px;">${state.hydranten.length} Hydranten lokal gespeichert. Abschnitt antippen zum Auf-/Zuklappen.</p>

    ${statistikAbschnittHTML("daten", "📁 Daten", null, datenInhalt)}
    ${statistikAbschnittHTML("archiv", "📦 Archiv", archivKurzstatus, archivInhalt)}
    ${statistikAbschnittHTML("statistik", "📊 Statistik", null, statistikInhaltHTML({ nurUebersicht: true }))}

    <div class="card" style="margin-top:14px;">
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;">
        <div class="hydrant-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z"/><path d="M8 2v16"/><path d="M16 6v16"/></svg></div>
        <div>
          <div style="font-weight:600;font-size:14px;">Kartenkacheln für Offline-Nutzung</div>
          <div style="font-size:12px;color:#6b7280;">Lädt Straßenkarten-Kacheln rund um eure Hydranten herunter, damit die Karte im Einsatz auch ohne Netz funktioniert.</div>
        </div>
      </div>
      <button id="btn-download-tiles" class="btn btn-primary btn-full">Kacheln jetzt herunterladen</button>
      <div id="tile-download-status" style="font-size:12px;color:#6b7280;margin-top:8px;"></div>
    </div>
  `;
}

/* ---------- Browser-/Hardware-Zurück-Taste ---------- */
// Jede "tiefere" Ansicht (Detail, Formular, Info, Statistik, ...) legt beim Öffnen einen
// Verlaufseintrag an. Sowohl die Zurück-Buttons in der App als auch die Hardware-/Gesten-
// Zurück-Taste des Handys rufen einheitlich history.back() auf; die eigentliche Navigation
// passiert zentral im popstate-Handler, damit beide Wege konsistent zum selben Ziel führen.
let unterdrueckeNaechstesPopstate = false;

function navVor() {
  history.pushState({ navTiefe: (history.state && history.state.navTiefe || 0) + 1 }, "");
}

function navZurueck() {
  history.back();
}

// Wird nach erfolgreichem Speichern (nicht Abbrechen) aufgerufen: der beim Öffnen des Formulars
// angelegte Verlaufseintrag wird "verbraucht", ohne dass das dabei ausgelöste popstate-Ereignis
// die Navigation nochmal (und ggf. falsch) selbst bestimmt - der Aufrufer hat den Zielzustand
// (state.tab etc.) bereits selbst gesetzt und gerendert.
function verbraucheVerlaufsEintragNachSpeichern() {
  unterdrueckeNaechstesPopstate = true;
  history.back();
}

function behandleZurueckNavigation() {
  if (unterdrueckeNaechstesPopstate) { unterdrueckeNaechstesPopstate = false; return; }
  const formularOffen = !!document.getElementById("hydrant-form");
  if (formularOffen) {
    if (state.formContext === "erfassen" || state.formContext === "hydrantenkontrolle" || state.formContext === "daten-neuanlage") {
      render(); // verwirft Änderungen, zeigt die vorherige Ansicht (Liste bzw. Formular für neuen Eintrag) erneut
    } else {
      state.tab = state.selectedId ? "detail" : "karte";
      render();
    }
    return;
  }
  if (state.tab === "info-doc") { state.tab = "info"; state.infoEditMode = false; render(); return; }
  if (state.tab === "info") { state.tab = "karte"; render(); return; }
  if (state.tab === "statistik-koordinaten") { state.tab = state.statistikKoordinatenHerkunft || "statistik"; render(); return; }
  if (state.tab === "statistik") { state.tab = "karte"; render(); return; }
  if (state.tab === "daten-loeschen" || state.tab === "konten") { state.tab = "daten"; render(); return; }
  if (state.tab === "detail") { state.tab = "karte"; state.selectedId = null; render(); return; }
  if (state.tab === "hinzufuegen" && state.hkAktiv) { state.hkAktiv = false; render(); return; }
  // Sonst: bereits auf einer "Wurzel"-Ansicht (Karte/Nähe/Daten/Hydrantenkontrolle-Einstieg) -
  // hier übernimmt der Browser die Zurück-Taste normal (z.B. App schließen/vorherige Seite).
}

window.addEventListener("popstate", behandleZurueckNavigation);

/* ---------- Haupt-Render ---------- */
function render() {
  const content = document.getElementById("content");
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab || (state.tab === "detail" && b.dataset.tab === "karte")));

  if (state.tab === "karte") content.innerHTML = renderKarte();
  else if (state.tab === "naehe") content.innerHTML = renderNaehe();
  else if (state.tab === "hinzufuegen") { content.innerHTML = renderHydrantenkontrolle(); }
  else if (state.tab === "detail") {
    const h = state.hydranten.find((x) => x.id === state.selectedId);
    content.innerHTML = h ? renderDetail(h) : `<div class="empty-state">Nicht gefunden.</div>`;
  } else if (state.tab === "daten") content.innerHTML = renderDaten();
  else if (state.tab === "daten-loeschen") content.innerHTML = renderDatenLoeschen();
  else if (state.tab === "konten") content.innerHTML = renderKonten();
  else if (state.tab === "info") content.innerHTML = renderInfo();
  else if (state.tab === "info-doc") content.innerHTML = renderInfoDoc(state.infoDocKind);
  else if (state.tab === "statistik") content.innerHTML = renderStatistik();
  else if (state.tab === "statistik-koordinaten") content.innerHTML = renderKoordinatenUebersicht();

  attachHandlers();
}

/* ---------- Event-Delegation je Tab ---------- */
// Wird sowohl von der App-Admin-Statistikseite als auch von der in "Daten" eingebetteten
// Statistik-Ansicht der Stadtwerke aufgerufen (siehe statistikInhaltHTML()).
function setupStatistikInhaltHandlers() {
  const koordBtn = document.getElementById("btn-koordinaten-oeffnen");
  if (koordBtn) koordBtn.addEventListener("click", () => {
    navVor();
    state.statistikKoordinatenHerkunft = state.tab; // "statistik" (App-Admin) oder "daten" (Stadtwerke)
    state.tab = "statistik-koordinaten";
    render();
  });

  const speichernBtn = document.getElementById("btn-statistik-speichern");
  if (speichernBtn) speichernBtn.addEventListener("click", async () => {
    if (!hatStatistikInhaltZugriff(state.session)) return;
    const startVal = document.getElementById("statistik-startdatum").value || null;
    const end1Val = document.getElementById("statistik-enddatum1").value || null;
    const end2Val = document.getElementById("statistik-enddatum2").value || null;
    const startGeaendert = startVal !== state.kontrollStartdatum;
    state.kontrollStartdatum = startVal;
    state.kontrollEnddatum1 = end1Val;
    state.kontrollEnddatum2 = end2Val;
    await setSetting("kontrollStartdatum", startVal);
    await setSetting("kontrollEnddatum1", end1Val);
    await setSetting("kontrollEnddatum2", end2Val);
    bereitsBenachrichtigteBezirke = new Set();
    if (startGeaendert) { state.kontrollGesamtAbschlussdatum = null; await setSetting("kontrollGesamtAbschlussdatum", null); }
    showToast("Gespeichert");
    render();
  });

  const loeschenBtn = document.getElementById("btn-statistik-startdatum-loeschen");
  if (loeschenBtn) loeschenBtn.addEventListener("click", () => {
    if (!hatStatistikInhaltZugriff(state.session)) return;
    zeigeJaNeinDialog("Startdatum wirklich löschen? Damit gilt kein Hydrant mehr als \"fertig\" (Zählung springt auf 0).", async () => {
      state.kontrollStartdatum = null;
      state.kontrollGesamtAbschlussdatum = null;
      await setSetting("kontrollStartdatum", null);
      await setSetting("kontrollGesamtAbschlussdatum", null);
      bereitsBenachrichtigteBezirke = new Set();
      showToast("Startdatum gelöscht – Kontrollrunde zurückgesetzt");
      render();
    });
  });

  const heuteBtn = document.getElementById("btn-statistik-heute-starten");
  if (heuteBtn) heuteBtn.addEventListener("click", async () => {
    if (!hatStatistikInhaltZugriff(state.session)) return;
    const heute = todayStr();
    state.kontrollStartdatum = heute;
    state.kontrollGesamtAbschlussdatum = null;
    await setSetting("kontrollStartdatum", heute);
    await setSetting("kontrollGesamtAbschlussdatum", null);
    bereitsBenachrichtigteBezirke = new Set();
    showToast("Neue Kontrollrunde ab heute gestartet");
    render();
  });

  document.querySelectorAll(".statistik-bezirk-header").forEach((btn) => {
    btn.addEventListener("click", () => {
      const b = btn.dataset.bezirk;
      state.statistikExpandedBezirk = state.statistikExpandedBezirk === b ? null : b;
      render();
    });
  });

  document.querySelectorAll(".statistik-abschnitt-header").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.abschnitt;
      state.statistikAbschnitte[key] = !state.statistikAbschnitte[key];
      render();
    });
  });

  const druckenBtn = document.getElementById("btn-statistik-drucken");
  if (druckenBtn) druckenBtn.addEventListener("click", () => window.print());
}

function attachHandlers() {
  document.querySelectorAll("[data-open]").forEach((el) => {
    el.addEventListener("click", () => { navVor(); state.selectedId = el.dataset.open; state.tab = "detail"; render(); });
  });

  document.querySelectorAll(".filter-chip").forEach((el) => {
    el.addEventListener("click", () => { state.zustandFilter = el.dataset.filter; render(); });
  });

  const bezirkSel = document.getElementById("bezirk-select");
  if (bezirkSel) bezirkSel.addEventListener("change", (e) => {
    state.bezirkFilter = e.target.value;
    render();
    fitLeafletToList(filteredListKarte());
  });

  const karteEinheitSel = document.getElementById("karte-einheit-select");
  if (karteEinheitSel) karteEinheitSel.addEventListener("change", (e) => {
    state.karteEinheit = e.target.value;
    if (!karteZeigtBezirksfilter()) state.bezirkFilter = "alle"; // Bezirksmenü ist bei fremder Einheit ausgeblendet
    render();
    fitLeafletToList(filteredListKarte());
  });

  if (state.tab === "karte") {
    const s = document.getElementById("search-input");
    if (s) s.addEventListener("input", (e) => {
      state.search = e.target.value;
      clearTimeout(attachHandlers._searchTimer);
      attachHandlers._searchTimer = setTimeout(() => {
        render();
        s2focus();
        if (state.search.trim()) fitLeafletToList(filteredListKarte());
      }, 300);
    });
    const clearBtn = document.getElementById("search-clear");
    if (clearBtn) clearBtn.addEventListener("click", () => {
      state.search = "";
      render();
    });

    const epStart = document.getElementById("btn-einsatzplanung-start");
    if (epStart) epStart.addEventListener("click", () => { state.einsatzplanungModus = true; render(); });
    const epAbbrechen = document.getElementById("btn-einsatzplanung-abbrechen");
    if (epAbbrechen) epAbbrechen.addEventListener("click", () => { state.einsatzplanungModus = false; render(); });
    const epNeu = document.getElementById("btn-einsatzplanung-neu");
    if (epNeu) epNeu.addEventListener("click", () => { state.einsatzplanungModus = true; render(); });
    const epBeenden = document.getElementById("btn-einsatzplanung-beenden");
    if (epBeenden) epBeenden.addEventListener("click", () => {
      state.einsatzplanungPin = null;
      state.einsatzplanungRadius = null;
      state.einsatzplanungModus = false;
      render();
    });
    document.querySelectorAll(".einsatzplanung-radius-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const r = chip.dataset.radius;
        state.einsatzplanungRadius = r === "alle" ? null : parseInt(r, 10);
        render();
      });
    });

    ensureLeafletMap(filteredListKarte());
  }

  if (state.tab === "naehe") {
    const btn = document.getElementById("btn-locate");
    if (btn) btn.addEventListener("click", () => {
      btn.textContent = "Standort wird ermittelt…";
      locate((err) => {
        const errEl = document.getElementById("loc-error");
        if (err && errEl) errEl.textContent = err;
        render();
      });
    });
  }

  if (state.tab === "detail" && state.editingId !== undefined) {
    setupFormHandlers();
  }
  if (state.tab === "hinzufuegen") {
    setupHydrantenkontrolleHandlers();
  }

  if (state.tab === "detail") {
    const back = document.getElementById("btn-back");
    if (back) back.addEventListener("click", navZurueck);
    const fotoImg = document.getElementById("detail-foto-img");
    if (fotoImg) fotoImg.addEventListener("click", () => openFotoLightbox(fotoImg.src));
    const lagefotoImg = document.getElementById("detail-lagefoto-img");
    if (lagefotoImg) lagefotoImg.addEventListener("click", () => openFotoLightbox(lagefotoImg.src));
    const edit = document.getElementById("btn-edit");
    if (edit) edit.addEventListener("click", () => {
      const h = state.hydranten.find((x) => x.id === state.selectedId);
      navVor();
      state.formContext = "detail-edit";
      document.getElementById("content").innerHTML = renderForm(h);
      setupFormHandlers();
    });
    const del = document.getElementById("btn-delete");
    if (del) del.addEventListener("click", () => {
      if (!canDeleteHydrant(state.session)) { showToast("Löschen ist nur für App-Admin möglich"); return; }
      zeigeJaNeinDialog("Diesen Hydranten wirklich löschen?", async () => {
        await deleteHydrant(state.selectedId);
        showToast("Hydrant gelöscht");
        state.tab = "karte";
        render();
        verbraucheVerlaufsEintragNachSpeichern();
      });
    });
  }

  if (state.tab === "daten") {
    const btnExport = document.getElementById("btn-export");
    if (btnExport) btnExport.addEventListener("click", exportExcel);
    const btnExportFotos = document.getElementById("btn-export-fotos");
    if (btnExportFotos) btnExportFotos.addEventListener("click", exportFotosAlsZip);
    const btnImport = document.getElementById("btn-import");
    if (btnImport) btnImport.addEventListener("click", () => document.getElementById("import-file").click());
    const btnTiles = document.getElementById("btn-download-tiles");
    if (btnTiles) btnTiles.addEventListener("click", downloadTiles);
    const btnArchivJetzt = document.getElementById("btn-archiv-jetzt");
    if (btnArchivJetzt) btnArchivJetzt.addEventListener("click", () => {
      if (state.session !== "App-Admin") return;
      const jahr = new Date().getFullYear();
      if (state.archivListe.some((a) => a.jahr === jahr)) { showToast(`Archiv ${jahr} gibt es schon`); return; }
      zeigeJaNeinDialog(`Archiv ${jahr} jetzt mit dem aktuellen Datenstand erstellen?`, async () => {
        if (!navigator.onLine) { showToast("Dafür ist eine Internetverbindung nötig"); return; }
        await syncAlles();
        const daten = state.hydranten.map((h) => ({
          id: h.id, name: h.name, einheit: h.einheit || "", nrNeu: h.nrNeu, nrAlt: h.nrAlt, durchfluss: h.durchfluss, bezirk: h.bezirk,
          lat: h.lat, lng: h.lng, lage: h.lage, zustand: h.zustand, besonderheiten: h.besonderheiten, letzteKontrolle: h.letzteKontrolle, geaendertVon: h.geaendertVon,
        }));
        const { error } = await sb.from("archiv").insert({ jahr, daten });
        if (error) { showToast("Archiv konnte nicht erstellt werden"); return; }
        await syncArchiv();
        showToast(`Archiv ${jahr} erstellt`);
        render();
      });
    });
    document.querySelectorAll(".btn-archiv-download").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!isSonderrolle(state.session)) return;
        const jahr = parseInt(btn.dataset.jahr, 10);
        const archiv = state.archivListe.find((a) => a.jahr === jahr);
        if (!archiv) return;
        exportHydrantenAlsExcel(archiv.hydranten, `hydranten-archiv-${jahr}.xlsx`);
        showToast(`Archiv ${jahr} wird heruntergeladen`);
      });
    });
    const chkLageFoto = document.getElementById("chk-lagefoto");
    if (chkLageFoto) chkLageFoto.addEventListener("change", async (e) => {
      state.lageFotoFreigegeben = e.target.checked;
      await setSetting("lageFotoFreigegeben", state.lageFotoFreigegeben);
      showToast(state.lageFotoFreigegeben ? "Lage-Foto-Aufnahme freigegeben" : "Lage-Foto-Aufnahme gesperrt");
    });
    const btnKonten = document.getElementById("btn-konten-oeffnen");
    if (btnKonten) btnKonten.addEventListener("click", () => {
      if (state.session !== "App-Admin") return;
      navVor();
      state.tab = "konten";
      state.konten = null;
      render();
    });
    const btnLoeschenOeffnen = document.getElementById("btn-daten-loeschen-oeffnen");
    if (btnLoeschenOeffnen) btnLoeschenOeffnen.addEventListener("click", () => {
      if (state.session !== "App-Admin") return;
      navVor();
      state.tab = "daten-loeschen";
      render();
    });

    // Aufklappbare Abschnitte im Reiter "Daten" (App-Admin sowie die eingeschränkte Ansicht von
    // Stadtwerke/Wehrführung teilen sich den generischen Handler mit der Statistikseite); bei
    // Stadtwerke/Wehrführung zusätzlich die Neuanlage direkt aus dem Reiter "Daten" heraus.
    if (state.session === "App-Admin" || state.session === "Stadtwerke" || state.session === "Wehrführung") {
      setupStatistikInhaltHandlers();
      const neuBtn = document.getElementById("btn-daten-neu-hydrant");
      if (neuBtn) neuBtn.addEventListener("click", () => {
        if (!canEditStammdaten(state.session)) return;
        navVor();
        state.formContext = "daten-neuanlage";
        document.getElementById("content").innerHTML = renderForm(null);
        setupFormHandlers();
      });
    }
  }

  if (state.tab === "konten") setupKontenHandlers();

  if (state.tab === "daten-loeschen") {
    const back = document.getElementById("btn-loeschen-back");
    if (back) back.addEventListener("click", navZurueck);

    const input = document.getElementById("loeschen-bestaetigung");
    const btn = document.getElementById("btn-loeschen-endgueltig");
    if (input && btn) {
      input.addEventListener("input", () => {
        btn.disabled = input.value.trim().toUpperCase() !== "LÖSCHEN";
      });
      btn.addEventListener("click", async () => {
        if (state.session !== "App-Admin") return;
        if (input.value.trim().toUpperCase() !== "LÖSCHEN") return; // erste Bestätigung: Text eintippen
        if (!confirm("Letzte Sicherheitsabfrage: Wirklich ALLE Hydranten unwiderruflich löschen? Das kann nicht rückgängig gemacht werden.")) return; // zweite Bestätigung
        await alleHydrantenLoeschen();
        state.zustandFilter = "alle";
        state.bezirkFilter = "alle";
        showToast("Alle Daten gelöscht");
        state.tab = "karte";
        render();
      });
    }
  }

  if (state.tab === "info") {
    const back = document.getElementById("btn-info-back");
    if (back) back.addEventListener("click", navZurueck);
    const syncBtn = document.getElementById("btn-sync-jetzt");
    if (syncBtn) syncBtn.addEventListener("click", async () => {
      syncBtn.disabled = true; syncBtn.textContent = "Gleiche ab …";
      await syncAlles();
      if (state.tab === "info") render();
    });
    const editBtn = document.getElementById("btn-info-edit");
    if (editBtn) editBtn.addEventListener("click", () => {
      if (!isSonderrolle(state.session)) return;
      state.infoEditMode = !state.infoEditMode;
      render();
    });
    const saveBtn = document.getElementById("btn-info-save");
    if (saveBtn) saveBtn.addEventListener("click", async () => {
      if (!isSonderrolle(state.session)) return;
      state.infoText = document.getElementById("info-textarea").value;
      await setSetting("infoText", state.infoText);
      state.infoEditMode = false;
      showToast("Gespeichert");
      render();
    });
    document.querySelectorAll(".info-link-row").forEach((row) => {
      row.addEventListener("click", () => {
        navVor();
        state.infoDocKind = row.dataset.doc;
        state.infoEditMode = false;
        state.tab = "info-doc";
        render();
      });
    });
  }

  if (state.tab === "info-doc") {
    const back = document.getElementById("btn-infodoc-back");
    if (back) back.addEventListener("click", navZurueck);
    const editBtn = document.getElementById("btn-infodoc-edit");
    if (editBtn) editBtn.addEventListener("click", () => {
      if (!isSonderrolle(state.session)) return;
      state.infoEditMode = !state.infoEditMode;
      render();
    });
    const saveBtn = document.getElementById("btn-infodoc-save");
    if (saveBtn) saveBtn.addEventListener("click", async () => {
      if (!isSonderrolle(state.session)) return;
      const val = document.getElementById("infodoc-textarea").value;
      if (state.infoDocKind === "impressum") { state.impressumText = val; await setSetting("impressumText", val); }
      else { state.disclaimerText = val; await setSetting("disclaimerText", val); }
      state.infoEditMode = false;
      showToast("Gespeichert");
      render();
    });
  }

  if (state.tab === "statistik") {
    const back = document.getElementById("btn-statistik-back");
    if (back) back.addEventListener("click", navZurueck);
    setupStatistikInhaltHandlers();
  }

  if (state.tab === "statistik-koordinaten") {
    const back = document.getElementById("btn-koordinaten-back");
    if (back) back.addEventListener("click", navZurueck);

    document.querySelectorAll(".koordinaten-bezirk-header").forEach((btn) => {
      btn.addEventListener("click", () => {
        const b = btn.dataset.bezirk;
        state.koordinatenExpandedBezirk = state.koordinatenExpandedBezirk === b ? null : b;
        render();
      });
    });

    document.querySelectorAll(".koordinaten-hydrant-zeile").forEach((btn) => {
      btn.addEventListener("click", () => {
        navVor();
        state.selectedId = btn.dataset.id;
        state.tab = "detail";
        render();
      });
    });
  }
}

function setupHydrantenkontrolleHandlers() {
  if (!state.hkAktiv) {
    // --- Einstiegsseite: Bezirkswahl + Übersichtskarte ---
    const sel = document.getElementById("hk-bezirk-select");
    if (sel) sel.addEventListener("change", (e) => {
      state.hkBezirk = e.target.value;
      render();
    });

    const startenBtn = document.getElementById("btn-hk-starten");
    if (startenBtn) startenBtn.addEventListener("click", () => {
      if (getHkBasisListe().length === 0) return;
      navVor();
      state.hkAktiv = true;
      state.hkFilter = "offen";
      render();
    });

    const neuBtn = document.getElementById("btn-hk-neu");
    if (neuBtn) neuBtn.addEventListener("click", () => {
      if (!canEditStammdaten(state.session)) return;
      navVor();
      state.formContext = "hydrantenkontrolle";
      document.getElementById("content").innerHTML = renderForm(null);
      setupFormHandlers();
    });

    ensureLeafletMap(getHkBasisListe(), "hk-uebersicht-map", true);
    return;
  }

  // --- Aktive Kontrollrunde: Offen/Kontrolliert + Liste ---
  const zurueckBtn = document.getElementById("btn-hk-zurueck");
  if (zurueckBtn) zurueckBtn.addEventListener("click", navZurueck);

  document.querySelectorAll(".hk-filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => { state.hkFilter = chip.dataset.filter; render(); });
  });

  const standortBtn = document.getElementById("btn-hk-standort");
  if (standortBtn) standortBtn.addEventListener("click", () => {
    standortBtn.textContent = "Ermittle Standort…";
    locate((err) => {
      if (err) showToast(err);
      render();
    });
  });

  document.querySelectorAll("[data-hk-edit]").forEach((el) => {
    el.addEventListener("click", () => {
      const h = state.hydranten.find((x) => x.id === el.dataset.hkEdit);
      if (!h) return;
      navVor();
      state.formContext = "hydrantenkontrolle";
      document.getElementById("content").innerHTML = renderForm(h);
      setupFormHandlers();
    });
  });

  const basis = getHkBasisListe();
  // Karte folgt bewusst der gewählten Auswahl (nur Offen oder nur Kontrolliert), genau wie die
  // Liste darunter - nicht mehr dem kompletten Bezirk.
  const kartenListe = state.hkFilter === "kontrolliert" ? basis.filter(istHeuteKontrolliert) : basis.filter((h) => !istHeuteKontrolliert(h));
  ensureLeafletMap(kartenListe, "hk-aktiv-map", true);
}

function s2focus() {
  const el = document.getElementById("search-input");
  if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; }
}

/* ---------- Foto: Verkleinern & Komprimieren vor dem Speichern ---------- */
const FOTO_MAX_DIM = 1280;
const FOTO_QUALITY = 0.75;
function komprimiereFoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      if (width > FOTO_MAX_DIM || height > FOTO_MAX_DIM) {
        if (width > height) { height = Math.round((height * FOTO_MAX_DIM) / width); width = FOTO_MAX_DIM; }
        else { width = Math.round((width * FOTO_MAX_DIM) / height); height = FOTO_MAX_DIM; }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Komprimierung fehlgeschlagen")), "image/jpeg", FOTO_QUALITY);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Bild konnte nicht gelesen werden")); };
    img.src = url;
  });
}

function setupFormHandlers() {
  const form = document.getElementById("hydrant-form");
  if (!form) return;

  const chipsBox = document.getElementById("defekt-chips-box");
  const zusammenfassungEl = document.getElementById("defekt-zusammenfassung");
  const toggleBtn = document.getElementById("btn-toggle-defekt");

  function aktualisiereDefektZusammenfassung() {
    if (!zusammenfassungEl) return;
    const ausgewaehlt = DEFEKT_OPTIONEN.filter((opt) =>
      form.querySelector(`.defekt-checkbox[value="${CSS.escape(opt)}"]`)?.checked
    );
    zusammenfassungEl.textContent = ausgewaehlt.length > 0
      ? `Ausgewählt: ${ausgewaehlt.join(", ")}`
      : "Noch keine Defekt-Art ausgewählt.";
  }

  function setDefektChipsSichtbar(sichtbar) {
    if (!chipsBox || !toggleBtn) return;
    chipsBox.style.display = sichtbar ? "flex" : "none";
    zusammenfassungEl.style.display = sichtbar ? "none" : "block";
    toggleBtn.textContent = sichtbar ? "Einklappen" : "Anzeigen";
  }

  if (toggleBtn) toggleBtn.addEventListener("click", () => {
    const istSichtbar = chipsBox.style.display !== "none";
    setDefektChipsSichtbar(!istSichtbar);
  });

  form.querySelectorAll(".zustand-opt").forEach((b) => {
    b.addEventListener("click", () => {
      form.querySelectorAll(".zustand-opt").forEach((x) => x.dataset.active = "false");
      b.dataset.active = "true";
      document.getElementById("f-zustand").value = b.dataset.val;
      applyZustandStyles(form);
      const box = document.getElementById("defekt-optionen");
      if (box) box.style.display = b.dataset.val === "defekt" ? "block" : "none";
      // Beim aktiven Umschalten auf "Defekt" direkt zur Auswahl aufklappen
      if (b.dataset.val === "defekt") setDefektChipsSichtbar(true);
    });
  });
  applyZustandStyles(form);

  form.querySelectorAll(".defekt-checkbox").forEach((cb) => {
    cb.addEventListener("change", () => {
      const ta = document.getElementById("f-bes");
      let lines = ta.value.split("\n").map((s) => s.trim()).filter(Boolean);
      if (cb.checked) {
        if (!lines.includes(cb.value)) lines.unshift(cb.value);
      } else {
        lines = lines.filter((l) => l !== cb.value);
      }
      ta.value = lines.join("\n");
      aktualisiereDefektZusammenfassung();
    });
  });

  const fotoInput = document.getElementById("f-foto-input");
  const fotoPreview = document.getElementById("foto-preview");
  const fotoRemoveBtn = document.getElementById("btn-foto-remove");
  document.getElementById("btn-foto-take").addEventListener("click", () => fotoInput.click());
  fotoInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    fotoPreview.innerHTML = `<span class="foto-empty">Läuft…</span>`;
    try {
      const blob = await komprimiereFoto(file);
      pendingFotoBlob = blob;
      if (formFotoUrl) URL.revokeObjectURL(formFotoUrl);
      formFotoUrl = URL.createObjectURL(blob);
      fotoPreview.innerHTML = `<img src="${formFotoUrl}" alt="Foto Vorschau" />`;
      fotoRemoveBtn.style.display = "";
    } catch (err) {
      showToast("Foto konnte nicht verarbeitet werden");
      fotoPreview.innerHTML = `<span class="foto-empty">Kein Foto</span>`;
    } finally {
      e.target.value = "";
    }
  });
  fotoRemoveBtn.addEventListener("click", () => {
    zeigeJaNeinDialog("Foto wirklich entfernen?", () => {
      pendingFotoBlob = null;
      if (formFotoUrl) { URL.revokeObjectURL(formFotoUrl); formFotoUrl = null; }
      fotoPreview.innerHTML = `<span class="foto-empty">Kein Foto</span>`;
      fotoRemoveBtn.style.display = "none";
    });
  });

  const lagefotoInput = document.getElementById("f-lagefoto-input");
  const lagefotoPreview = document.getElementById("lagefoto-preview");
  const lagefotoTakeBtn = document.getElementById("btn-lagefoto-take");
  const lagefotoRemoveBtn = document.getElementById("btn-lagefoto-remove");
  if (lagefotoTakeBtn) lagefotoTakeBtn.addEventListener("click", () => lagefotoInput.click());
  if (lagefotoInput) lagefotoInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    lagefotoPreview.innerHTML = `<span class="foto-empty">Läuft…</span>`;
    try {
      const blob = await komprimiereFoto(file);
      pendingLageFotoBlob = blob;
      if (formLageFotoUrl) URL.revokeObjectURL(formLageFotoUrl);
      formLageFotoUrl = URL.createObjectURL(blob);
      lagefotoPreview.innerHTML = `<img src="${formLageFotoUrl}" alt="Lage-Foto Vorschau" />`;
      if (isSonderrolle(state.session) && lagefotoRemoveBtn) lagefotoRemoveBtn.style.display = "";
      if (lagefotoTakeBtn) lagefotoTakeBtn.textContent = "📷 Foto ersetzen";
    } catch (err) {
      showToast("Foto konnte nicht verarbeitet werden");
      lagefotoPreview.innerHTML = `<span class="foto-empty">Kein Foto</span>`;
    } finally {
      e.target.value = "";
    }
  });
  if (lagefotoRemoveBtn) lagefotoRemoveBtn.addEventListener("click", () => {
    zeigeJaNeinDialog("Lage-Foto wirklich entfernen?", () => {
      pendingLageFotoBlob = null;
      if (formLageFotoUrl) { URL.revokeObjectURL(formLageFotoUrl); formLageFotoUrl = null; }
      lagefotoPreview.innerHTML = `<span class="foto-empty">Kein Foto</span>`;
      lagefotoRemoveBtn.style.display = "none";
      if (lagefotoTakeBtn) lagefotoTakeBtn.textContent = "📷 Foto aufnehmen";
    });
  });

  const startLatVal = parseFloat(document.getElementById("f-lat").value);
  const startLngVal = parseFloat(document.getElementById("f-lng").value);
  setupPositionPicker(Number.isFinite(startLatVal) ? startLatVal : null, Number.isFinite(startLngVal) ? startLngVal : null);

  const gpsBtn = document.getElementById("btn-gps-locate");
  if (gpsBtn) gpsBtn.addEventListener("click", () => {
    if (!positionPickerMap) { showToast("Karte nicht verfügbar"); return; }
    showToast("Ermittle Standort…");
    positionPickerMap.locate({ enableHighAccuracy: true, setView: false, maxZoom: 18, timeout: 10000 });
  });

  document.getElementById("btn-cancel-form").addEventListener("click", navZurueck);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const bestehendVorab = state.hydranten.find((x) => x.id === form.dataset.id);
    const errEl = document.getElementById("form-error");
    if (!bestehendVorab && !canEditStammdaten(state.session)) {
      errEl.textContent = "Neue Hydranten dürfen nur von Stadtwerke/App-Admin angelegt werden.";
      return;
    }
    const latRaw = document.getElementById("f-lat").value.trim();
    const lngRaw = document.getElementById("f-lng").value.trim();
    let name = document.getElementById("f-name").value.trim();
    if (!name) { errEl.textContent = "Bitte einen Namen/Bezeichnung angeben."; return; }
    let lat = null;
    if (latRaw !== "") {
      lat = parseFloat(latRaw);
      if (Number.isNaN(lat)) { errEl.textContent = "Breitengrad ist keine gültige Zahl."; return; }
    }
    let lng = null;
    if (lngRaw !== "") {
      lng = parseFloat(lngRaw);
      if (Number.isNaN(lng)) { errEl.textContent = "Längengrad ist keine gültige Zahl."; return; }
    }
    const durchflussRaw = document.getElementById("f-durchfluss").value.trim().replace(/^H-?/i, "");
    const einheitEl = document.getElementById("f-einheit-value") || document.getElementById("f-einheit");
    const bestehend = bestehendVorab;
    const historie = (bestehend && Array.isArray(bestehend.historie)) ? bestehend.historie.slice() : [];
    historie.push({ ts: new Date().toISOString(), von: state.session });

    // Stammdaten (Name, Hydrantennummern, Bezirk): serverseitig nochmal exakt dieselbe Regel wie
    // im UI durchsetzen, damit ein umgangenes UI keine unerlaubte Änderung durchsetzen kann.
    let nrNeu = document.getElementById("f-nrneu").value.trim();
    let nrAlt = document.getElementById("f-nralt").value.trim();
    let bezirk = document.getElementById("f-bezirk").value.trim();
    if (!canEditStammdaten(state.session) && bestehend) {
      name = bestehend.name;
      nrNeu = bestehend.nrNeu;
      nrAlt = bestehend.nrAlt;
      bezirk = bestehend.bezirk;
    }

    // Lage-Foto: serverseitig (hier im Speichervorgang) nochmal exakt dieselbe Regel prüfen wie im UI,
    // damit ein manipuliertes/übersprungenes UI keine unerlaubte Änderung durchsetzen kann.
    // Solange die Freigabe aktiv ist, darf die Einheit ihr Lage-Foto frei verwalten (aufnehmen,
    // ersetzen, löschen). Erst wenn die Freigabe zurückgenommen wird, bleibt ein vorhandenes Foto
    // eingefroren und ist nur noch für Vollzugriffs-Rollen änderbar.
    const bestehendesLageFoto = bestehend ? bestehend.lageFoto : null;
    const lageFotoDarfAendern = isSonderrolle(state.session) || state.lageFotoFreigegeben;
    let finalLageFoto = bestehendesLageFoto || null;
    if (pendingLageFotoBlob === null) {
      if (lageFotoDarfAendern) finalLageFoto = null;
    } else if (pendingLageFotoBlob instanceof Blob) {
      if (lageFotoDarfAendern) finalLageFoto = pendingLageFotoBlob;
    }

    const h = {
      id: form.dataset.id,
      name, lat, lng,
      einheit: einheitEl ? einheitEl.value : state.session,
      durchfluss: durchflussRaw ? `H-${durchflussRaw}` : "",
      nrNeu, nrAlt, bezirk,
      lage: document.getElementById("f-lage").value.trim(),
      zustand: document.getElementById("f-zustand").value,
      besonderheiten: document.getElementById("f-bes").value.trim(),
      letzteKontrolle: document.getElementById("f-datum").value || todayStr(),
      geaendertVon: state.session,
      historie, // vollständige Änderungshistorie - wird nicht in der App angezeigt, nur exportiert
      foto: pendingFotoBlob !== undefined ? pendingFotoBlob : (bestehend ? bestehend.foto : null),
      lageFoto: finalLageFoto,
    };
    const isNew = !state.hydranten.some((x) => x.id === h.id);
    await saveHydrant(h);
    pruefeBezirkAbschluss(h);
    await pruefeGesamtAbschluss();

    if (state.formContext === "hydrantenkontrolle") {
      // Nach dem Speichern automatisch zurück in die Kontrollrunden-Liste (Screen 2) bzw. in den
      // Einstieg (falls über "+ Neuen Hydranten anlegen" erfasst). Der Hydrant zählt jetzt als
      // "heute kontrolliert" und wandert dadurch von der Offen- in die Kontrolliert-Liste.
      showToast(isNew ? "Hydrant hinzugefügt" : "Gespeichert · kontrolliert");
      render();
      verbraucheVerlaufsEintragNachSpeichern();
    } else if (state.formContext === "daten-neuanlage") {
      // Neuanlage durch die Stadtwerke aus dem Reiter "Daten" - zurück dorthin, der App-Admin
      // sieht den neuen Hydranten automatisch (gleiche lokale Datenbank) und kann den Bezirk setzen.
      showToast("Hydrant hinzugefügt · Bezirk wird vom App-Admin zugeordnet");
      render();
      verbraucheVerlaufsEintragNachSpeichern();
    } else if (state.formContext === "erfassen") {
      showToast(isNew ? "Hydrant hinzugefügt" : "Hydrant aktualisiert");
      render(); // bereit für den nächsten neuen Hydranten
      verbraucheVerlaufsEintragNachSpeichern();
    } else {
      showToast(isNew ? "Hydrant hinzugefügt" : "Hydrant aktualisiert");
      state.selectedId = h.id;
      state.tab = "detail";
      render();
      verbraucheVerlaufsEintragNachSpeichern();
    }
  });
}

function applyZustandStyles(form) {
  const colors = { ok: ["#2E7D46", "#EAF6EE"], defekt: ["#C22E2E", "#FBE9E9"] };
  form.querySelectorAll(".zustand-opt").forEach((b) => {
    const active = b.dataset.active === "true";
    const [c, bg] = colors[b.dataset.val];
    b.style.color = c;
    b.style.background = active ? bg : "white";
    b.style.borderColor = active ? c : "#e5e7eb";
  });
}

/* ---------- Excel Export/Import ---------- */
function exportHydrantenAlsExcel(hydrantenListe, dateiname, historieMap) {
  if (typeof XLSX === "undefined") { showToast("Excel-Bibliothek nicht verfügbar (offline & noch nicht gecacht)"); return; }
  const rows = hydrantenListe.map((h) => ({
    Name: h.name, Einheit: h.einheit, HydrantennummerNeu: h.nrNeu, HydrantennummerAlt: h.nrAlt, Nennweite: h.durchfluss, Bezirk: h.bezirk,
    Breitengrad: h.lat, Laengengrad: h.lng,
    Lage: h.lage, Zustand: zustandLabel(h.zustand), Besonderheiten: h.besonderheiten, LetzteKontrolle: h.letzteKontrolle, GeaendertVon: h.geaendertVon,
    Foto: h.foto instanceof Blob ? "Ja" : "Nein",
    LageFoto: h.lageFoto instanceof Blob ? "Ja" : "Nein",
  }));

  const historieRows = [];
  hydrantenListe.forEach((h) => {
    ((historieMap && historieMap[h.id]) || h.historie || []).forEach((eintrag) => {
      historieRows.push({
        Hydrant: h.name,
        HydrantennummerNeu: h.nrNeu,
        Einheit: h.einheit,
        Zeitstempel: new Date(eintrag.ts).toLocaleString("de-DE"),
        GeaendertVon: eintrag.von,
      });
    });
  });
  historieRows.sort((a, b) => a.Zeitstempel.localeCompare(b.Zeitstempel));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Hydranten");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(historieRows), "Aenderungshistorie");
  XLSX.writeFile(wb, dateiname);
}

async function exportExcel() {
  if (!isSonderrolle(state.session)) { showToast("Export ist nur für Vollzugriffs-Rollen verfügbar"); return; }
  let historieMap = null;
  if (sb && navigator.onLine) {
    try {
      const zeilen = await holeAlleZeilen("hydranten_historie", "hydrant_id, zeitpunkt, von", "id");
      historieMap = {};
      zeilen.forEach((z) => { (historieMap[z.hydrant_id] = historieMap[z.hydrant_id] || []).push({ ts: z.zeitpunkt, von: z.von }); });
    } catch (e) { historieMap = null; }
  }
  exportHydrantenAlsExcel(state.hydranten, `hydranten-export-${todayStr()}.xlsx`, historieMap);
  showToast("Export gestartet");
}

// Entfernt Zeichen, die in Dateinamen auf den gängigen Betriebssystemen Probleme machen.
function dateinameSicher(s) {
  return String(s || "").replace(/[\\/:*?"<>|]/g, "").trim().replace(/\s+/g, "_") || "hydrant";
}

// Sammelt alle bisher aufgenommenen Fotos (Beschädigung + Lage) als ZIP-Datei, jede Datei benannt
// nach dem zugehörigen Hydranten - als manuelles Sicherungsnetz, bis ein echter Server-Upload mit
// automatischer Zuordnung existiert (siehe README). Bewusst nur für App-Admin.
async function exportFotosAlsZip() {
  if (state.session !== "App-Admin") return;
  if (typeof JSZip === "undefined") { showToast("ZIP-Bibliothek nicht verfügbar (offline & noch nicht gecacht)"); return; }

  const mitFoto = state.hydranten.filter((h) => h.foto instanceof Blob || h.lageFoto instanceof Blob);
  if (mitFoto.length === 0) { showToast("Keine Fotos vorhanden"); return; }

  showToast("Fotos werden gesammelt…");
  const zip = new JSZip();
  mitFoto.forEach((h) => {
    const basisname = `${dateinameSicher(h.name)}_${h.id.slice(0, 6)}`;
    if (h.foto instanceof Blob) zip.file(`${basisname}_beschaedigung.jpg`, h.foto);
    if (h.lageFoto instanceof Blob) zip.file(`${basisname}_lage.jpg`, h.lageFoto);
  });

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `hydranten-fotos-${todayStr()}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);

  const anzahlFotos = mitFoto.reduce((n, h) => n + (h.foto instanceof Blob ? 1 : 0) + (h.lageFoto instanceof Blob ? 1 : 0), 0);
  showToast(`${anzahlFotos} Foto(s) aus ${mitFoto.length} Hydrant(en) heruntergeladen`);
}

function handleImportFile(e) {
  if (!isSonderrolle(state.session)) { showToast("Import ist nur für Vollzugriffs-Rollen verfügbar"); e.target.value = ""; return; }
  if (state.session !== "App-Admin") { showToast("Import ist nur für den App-Admin verfügbar"); e.target.value = ""; return; }
  const file = e.target.files[0];
  if (!file || typeof XLSX === "undefined") return;
  const reader = new FileReader();
  reader.onload = async (evt) => {
    try {
      const wb = XLSX.read(evt.target.result, { type: "binary" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet);
      const zustandLookup = Object.fromEntries(ZUSTAENDE.map((z) => [z.label.toLowerCase(), z.value]));
      const importList = [];
      let ohneKoordinaten = 0;
      for (const r of rows) {
        const name = String(r.Name ?? r.name ?? "").trim();
        if (!name) continue; // Koordinaten sind jetzt optional, nur der Name ist zwingend

        const latRaw = r.Breitengrad ?? r.Latitude ?? r.lat;
        const lngRaw = r.Laengengrad ?? r.Longitude ?? r.lng;
        const latParsed = latRaw === undefined || latRaw === null || latRaw === "" ? NaN : parseFloat(latRaw);
        const lngParsed = lngRaw === undefined || lngRaw === null || lngRaw === "" ? NaN : parseFloat(lngRaw);
        const lat = Number.isFinite(latParsed) ? latParsed : null;
        const lng = Number.isFinite(lngParsed) ? lngParsed : null;
        if (lat === null || lng === null) ohneKoordinaten++;

        const zRaw = String(r.Zustand ?? "ok").toLowerCase();
        importList.push({
          id: uid(), name, lat, lng,
          einheit: String(r.Einheit ?? "").trim() || (isSonderrolle(state.session) ? "" : state.session),
          nrNeu: r.HydrantennummerNeu || r.NrNeu || "",
          nrAlt: r.HydrantennummerAlt || r.NrAlt || "",
          durchfluss: (() => { const v = String(r.Nennweite ?? r.Durchflussmenge ?? "").trim().replace(/^H-?/i, ""); return v ? `H-${v}` : ""; })(),
          bezirk: String(r.Bezirk ?? "").trim(),
          lage: r.Lage || "",
          zustand: zustandLookup[zRaw] || (ZUSTAENDE.some((z) => z.value === zRaw) ? zRaw : "ok"),
          besonderheiten: normalisiereBesonderheiten(r.Besonderheiten || ""),
          letzteKontrolle: r.LetzteKontrolle || todayStr(),
          geaendertVon: state.session,
          fotoPfad: null, lageFotoPfad: null, foto: null, lageFoto: null,
          _serverTs: null, _dirty: true, _v: 1,
        });
      }

      if (importList.length === 0) { showToast("Keine gültigen Zeilen gefunden"); return; }

      // Abgleich mit dem Bestand: Zuordnung über die neue Hydrantennummer (sonst Name + alte Nummer).
      // Gefundene Hydranten werden aktualisiert (Fotos bleiben erhalten), neue werden angelegt.
      const schluessel = (h) => {
        const n = String(h.nrNeu || "").trim().toLowerCase();
        return n ? "n:" + n : "t:" + String(h.name).trim().toLowerCase() + "|" + String(h.nrAlt || "").trim().toLowerCase();
      };
      const bestand = new Map();
      state.hydranten.forEach((h) => { const k = schluessel(h); if (!bestand.has(k)) bestand.set(k, h); });
      const treffer = new Set();
      const paare = [], neu = [];
      for (const n of importList) {
        const alt = bestand.get(schluessel(n));
        if (alt && !treffer.has(alt.id)) { treffer.add(alt.id); paare.push({ alt, n }); } else neu.push(n);
      }
      const fehlend = state.hydranten.filter((h) => !treffer.has(h.id));
      const FELDER = ["name", "einheit", "nrNeu", "nrAlt", "durchfluss", "bezirk", "lage", "zustand", "besonderheiten", "letzteKontrolle"];
      const geaendert = [];
      for (const { alt, n } of paare) {
        const u = { ...alt };
        let diff = false;
        for (const f of FELDER) { if (String(u[f] ?? "") !== String(n[f] ?? "")) { u[f] = n[f]; diff = true; } }
        // Koordinaten aus der Datei nur übernehmen, wenn sie vorhanden sind (vorhandene GPS-Position nie mit leer überschreiben)
        if (n.lat !== null && n.lng !== null && (u.lat !== n.lat || u.lng !== n.lng)) { u.lat = n.lat; u.lng = n.lng; diff = true; }
        if (diff) { u.geaendertVon = state.session; u._dirty = true; u._v = (alt._v || 0) + 1; geaendert.push(u); }
      }

      const frage = `Datei einlesen? ${neu.length} neue Hydranten, ${geaendert.length} geänderte, ${paare.length - geaendert.length} unverändert.`;
      zeigeJaNeinDialog(frage, async () => {
        const schreiben = [...geaendert, ...neu];
        await dbPutMany(schreiben);
        const ids = new Map(geaendert.map((u) => [u.id, u]));
        state.hydranten = state.hydranten.map((h) => ids.get(h.id) || h);
        state.hydranten.push(...neu);
        syncAlles();
        showToast(`Import: ${neu.length} neu, ${geaendert.length} aktualisiert${ohneKoordinaten ? ` · ${ohneKoordinaten} ohne Koordinaten` : ""}`);
        render();
        if (fehlend.length > 0) {
          zeigeJaNeinDialog(`${fehlend.length} Hydranten sind NICHT in der Datei. Diese jetzt löschen, damit der Bestand genau der Datei entspricht? (Nein = behalten)`, async () => {
            for (const h of fehlend) await deleteHydrant(h.id, true);
            syncAlles();
            showToast(`${fehlend.length} Hydranten gelöscht`);
            render();
          });
        }
      });
    } catch (err) {
      console.error(err);
      showToast("Import fehlgeschlagen – Format prüfen");
    } finally {
      e.target.value = "";
    }
  };
  reader.readAsBinaryString(file);
}

function renderInfo() {
  const vollzugriff = isSonderrolle(state.session);
  return `
    <button class="back-link" id="btn-info-back">‹ Zurück</button>
    <h2 style="font-weight:600;margin:0 0 14px;">Info</h2>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div style="font-weight:600;font-size:14px;">Hinweise</div>
        ${vollzugriff ? `<button type="button" id="btn-info-edit" class="btn btn-ghost" style="padding:5px 12px;font-size:12px;">${state.infoEditMode ? "Fertig" : "Bearbeiten"}</button>` : ""}
      </div>
      ${state.infoEditMode
        ? `<textarea id="info-textarea" rows="6" class="info-textarea">${esc(state.infoText)}</textarea>
           <button type="button" id="btn-info-save" class="btn btn-primary btn-full" style="margin-top:8px;">Speichern</button>`
        : (state.infoText
            ? `<p style="font-size:14px;white-space:pre-wrap;margin:0;">${esc(state.infoText)}</p>`
            : `<p style="font-size:14px;color:#9CA3AF;margin:0;">Noch keine Hinweise hinterlegt.</p>`)
      }
    </div>

    <div class="card">
      <div style="font-weight:600;font-size:14px;margin-bottom:6px;">Abgleich mit dem Server</div>
      <p style="font-size:13px;margin:0 0 4px;color:#374151;">Angemeldet als: ${esc(state.session)}</p>
      <p style="font-size:13px;margin:0 0 4px;color:#374151;">Letzter erfolgreicher Abgleich: ${state.letzterSync ? new Date(state.letzterSync).toLocaleTimeString("de-DE") : "noch keiner"}</p>
      <p style="font-size:13px;margin:0 0 4px;color:#374151;">Noch nicht übertragen: ${state.hydranten.filter((x) => x._dirty).length} Hydrant(en)</p>
      ${state.syncFehler ? `<p style="font-size:13px;margin:0 0 6px;color:#C22E2E;">Letzter Fehler: ${esc(state.syncFehler)}</p>` : ""}
      <button type="button" id="btn-sync-jetzt" class="btn btn-outline" style="margin-top:6px;">Jetzt abgleichen</button>
    </div>

    <div class="card" style="padding:0;overflow:hidden;">
      <button type="button" class="info-link-row" data-doc="impressum">
        <span>Impressum</span><span class="info-link-chevron">›</span>
      </button>
      <button type="button" class="info-link-row" data-doc="disclaimer" style="border-top:1px solid #e5e7eb;">
        <span>Disclaimer</span><span class="info-link-chevron">›</span>
      </button>
    </div>
  `;
}

function renderInfoDoc(kind) {
  const vollzugriff = isSonderrolle(state.session);
  const title = kind === "impressum" ? "Impressum" : "Disclaimer";
  const text = kind === "impressum" ? state.impressumText : state.disclaimerText;
  return `
    <button class="back-link" id="btn-infodoc-back">‹ Zurück</button>
    <h2 style="font-weight:600;margin:0 0 14px;">${title}</h2>
    <div class="card">
      ${vollzugriff ? `<div style="text-align:right;margin-bottom:8px;"><button type="button" id="btn-infodoc-edit" class="btn btn-ghost" style="padding:5px 12px;font-size:12px;">${state.infoEditMode ? "Fertig" : "Bearbeiten"}</button></div>` : ""}
      ${state.infoEditMode
        ? `<textarea id="infodoc-textarea" rows="14" class="info-textarea">${esc(text)}</textarea>
           <button type="button" id="btn-infodoc-save" class="btn btn-primary btn-full" style="margin-top:8px;">Speichern</button>`
        : (text
            ? `<p style="font-size:14px;white-space:pre-wrap;margin:0;">${esc(text)}</p>`
            : `<p style="font-size:14px;color:#9CA3AF;margin:0;">Noch kein ${title} hinterlegt.</p>`)
      }
    </div>
  `;
}

// Einheitlicher aufklappbarer Abschnitt für die Statistik-Seite - erweiterbar: für jede neue
// Statistik einfach einen weiteren Aufruf mit eigenem Schlüssel/Titel/Kurzstatus/Inhalt ergänzen.
function statistikAbschnittHTML(key, titel, kurzstatus, inhaltHTML) {
  const aufgeklappt = !!state.statistikAbschnitte[key];
  return `
    <div class="card statistik-bezirk-card">
      <button type="button" class="statistik-abschnitt-header" data-abschnitt="${key}">
        <span style="font-weight:600;font-size:14px;">${titel}</span>
        <span style="font-size:12.5px;color:#6b7280;display:flex;align-items:center;gap:6px;">${kurzstatus ? `<span>${kurzstatus}</span>` : ""}<span>${aufgeklappt ? "▴" : "▾"}</span></span>
      </button>
      ${aufgeklappt ? `<div class="statistik-abschnitt-inhalt">${inhaltHTML}</div>` : ""}
    </div>
  `;
}

// Gemeinsamer Inhalt der Statistik (Kontrollrunde + Gesamtübersicht + Koordinaten-Lücken-Link),
// wiederverwendet von der App-Admin-eigenen Statistikseite UND der in "Daten" eingebetteten
// Statistik-Ansicht von Stadtwerke/Wehrführung (siehe renderDatenEingeschraenkt()).
function statistikInhaltHTML(opts) {
  opts = opts || {};
  const nurUebersicht = !!opts.nurUebersicht;
  const stat = berechneStatistik();
  const quote = stat.gesamt > 0 ? Math.round((stat.gesamtFertig / stat.gesamt) * 100) : 0;

  const gesamtKurzstatus = `${stat.gesamtFertig} fertig, ${stat.gesamtOffen} offen`;
  const gesamtInhalt = `
    <div class="hero-box" style="margin-top:0;">
      <div class="hero-eyebrow">Gesamt ${esc(STATISTIK_EINHEIT)}</div>
      <div class="hero-big">${stat.gesamtFertig} <span style="font-size:20px;opacity:0.7;">/ ${stat.gesamt}</span></div>
      <div class="hero-sub">${stat.gesamtFertig} fertig, ${stat.gesamtOffen} offen (${quote}\u00A0%)</div>
    </div>

    <button type="button" id="btn-statistik-drucken" class="btn btn-outline btn-full" style="margin-bottom:14px;">🖨 Bezirks-Übersicht ausdrucken</button>

    ${stat.bezirkNamen.length === 0 ? `<div class="empty-state">Noch keine Hydranten für ${esc(STATISTIK_EINHEIT)} vorhanden.</div>` : stat.bezirkNamen.map((b) => {
      const d = stat.bezirke[b];
      const komplett = d.offen === 0;
      const aufgeklappt = state.statistikExpandedBezirk === b;
      return `
        <div class="card statistik-bezirk-card statistik-unter-card">
          <button type="button" class="statistik-bezirk-header" data-bezirk="${esc(b)}">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="statistik-status-dot ${komplett ? "statistik-status-fertig" : d.fertig > 0 ? "statistik-status-teilweise" : "statistik-status-offen"}"></span>
              <span style="font-weight:600;font-size:14px;">Bezirk ${esc(b)}</span>
              ${komplett ? `<span class="pill ok">Fertig</span>` : ""}
            </div>
            <span style="font-size:12.5px;color:#6b7280;">${d.fertig} fertig, ${d.offen} offen ${aufgeklappt ? "▴" : "▾"}</span>
          </button>
          ${aufgeklappt ? `
            <div class="statistik-hydrant-liste">
              ${d.hydranten.map((h) => `
                <div class="statistik-hydrant-zeile">
                  <span>${h.istFertig ? "✅" : "⭕"}</span>
                  <span class="statistik-hydrant-name">${esc(h.name)}</span>
                  <span class="statistik-hydrant-datum">${esc(h.letzteKontrolle || "–")}</span>
                </div>`).join("")}
            </div>
          ` : ""}
        </div>
      `;
    }).join("")}

    ${renderStatistikDruckansicht(stat, quote)}
  `;

  // "Nur Übersicht" (z.B. Stadtwerke): ausschließlich die Gesamtübersicht direkt anzeigen, ohne
  // eigene Kontrollrunde starten/verwalten zu können und ohne den Koordinaten-Lücken-Link.
  if (nurUebersicht) return gesamtInhalt;

  const kontrollrundeKurzstatus = state.kontrollStartdatum ? `seit ${esc(state.kontrollStartdatum)}` : "nicht gestartet";
  const kontrollrundeInhalt = `
    ${state.kontrollStartdatum ? `
      <p style="font-size:13px;color:#374151;margin:0 0 10px;">Läuft seit <strong>${esc(state.kontrollStartdatum)}</strong> (Hydranten mit Kontrolldatum ab diesem Tag gelten als "fertig").${state.kontrollEnddatum1 ? ` Ziel 1: <strong>${esc(state.kontrollEnddatum1)}</strong>.` : ""}${state.kontrollEnddatum2 ? ` Ziel 2: <strong>${esc(state.kontrollEnddatum2)}</strong>.` : ""}</p>
    ` : `
      <p style="font-size:13px;color:#9CA3AF;margin:0 0 10px;">Noch keine Kontrollrunde gestartet – solange kein Startdatum gesetzt ist, gilt kein Hydrant als "fertig".</p>
    `}
    ${fieldHTML("statistik-startdatum", "Startdatum", `<input type="date" id="statistik-startdatum" value="${esc(state.kontrollStartdatum || "")}" />`)}
    <div class="row-2">
      ${fieldHTML("statistik-enddatum1", "Erstes Enddatum (nur zur Übersicht)", `<input type="date" id="statistik-enddatum1" value="${esc(state.kontrollEnddatum1 || "")}" />`)}
      ${fieldHTML("statistik-enddatum2", "Zweites Enddatum (nur zur Übersicht)", `<input type="date" id="statistik-enddatum2" value="${esc(state.kontrollEnddatum2 || "")}" />`)}
    </div>
    <p style="font-size:11px;color:#9CA3AF;margin:-8px 0 12px;">Die beiden Enddaten dienen nur eurer eigenen Übersicht/Planung und beenden die Kontrollrunde nicht automatisch.</p>
    <button type="button" id="btn-statistik-speichern" class="btn btn-primary btn-full">Speichern</button>
    <div class="btn-row" style="margin-top:8px;">
      <button type="button" id="btn-statistik-heute-starten" class="btn btn-ghost">Neue Runde ab heute starten</button>
      <button type="button" id="btn-statistik-startdatum-loeschen" class="btn btn-outline-danger" style="${state.kontrollStartdatum ? "" : "display:none;"}">Startdatum löschen</button>
    </div>
  `;

  return `
    <button type="button" id="btn-koordinaten-oeffnen" class="info-link-row" style="border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.05);margin-bottom:14px;">
      <span>📍 Hydranten ohne Koordinaten (alle Einheiten)</span><span class="info-link-chevron">›</span>
    </button>

    ${state.kontrollGesamtAbschlussdatum ? `
      <div class="card statistik-abschluss-karte">
        🏆 Alle Bezirke komplett abgeschlossen am <strong>${esc(state.kontrollGesamtAbschlussdatum)}</strong>
      </div>
    ` : ""}

    ${statistikAbschnittHTML("kontrollrunde", "🚦 Kontrollrunde", kontrollrundeKurzstatus, kontrollrundeInhalt)}
    ${statistikAbschnittHTML("gesamt", "📊 Gesamtübersicht", gesamtKurzstatus, gesamtInhalt)}
  `;
}

function renderStatistik() {
  return `
    <button class="back-link" id="btn-statistik-back">‹ Zurück</button>
    <h2 style="font-weight:600;margin:0 0 4px;">Statistik – ${esc(STATISTIK_EINHEIT)}</h2>
    <p style="font-size:12px;color:#9CA3AF;margin:0 0 14px;">Weitere Einheiten folgen später. Abschnitte antippen zum Auf-/Zuklappen.</p>
    ${statistikInhaltHTML()}
  `;
}

// Rein für den Ausdruck gedacht: nur eine Bezirks-Übersicht (Zahlen), keine Einzelhydranten.
// Auf dem Bildschirm unsichtbar, erscheint ausschließlich über die Drucken-Funktion (siehe CSS
// @media print). So bleibt der Ausdruck kompakt und übersichtlich, statt lange Hydranten-Listen
// mit auszudrucken.
function renderKoordinatenUebersicht() {
  const daten = berechneKoordinatenLuecken();
  return `
    <button class="back-link" id="btn-koordinaten-back">‹ Zurück</button>
    <h2 style="font-weight:600;margin:0 0 4px;">Hydranten ohne Koordinaten</h2>
    <p style="font-size:12px;color:#9CA3AF;margin:0 0 14px;">Einheitenübergreifend – nicht auf ${esc(STATISTIK_EINHEIT)} beschränkt.</p>

    <div class="hero-box">
      <div class="hero-eyebrow">Fehlende Koordinaten</div>
      <div class="hero-big">${daten.anzahlFehlend} <span style="font-size:20px;opacity:0.7;">/ ${daten.gesamt}</span></div>
      <div class="hero-sub">${daten.anzahlFehlend === 0 ? "Alle Hydranten haben Koordinaten 🎉" : `${daten.bezirkNamen.length} Bezirk(e) betroffen`}</div>
    </div>

    ${daten.anzahlFehlend === 0
      ? `<div class="empty-state">Keine offenen Koordinaten mehr – alles vollständig.</div>`
      : daten.bezirkNamen.map((b) => {
          const liste = daten.bezirke[b];
          const aufgeklappt = state.koordinatenExpandedBezirk === b;
          return `
            <div class="card statistik-bezirk-card">
              <button type="button" class="koordinaten-bezirk-header" data-bezirk="${esc(b)}">
                <div style="display:flex;align-items:center;gap:8px;">
                  <span class="statistik-status-dot statistik-status-offen"></span>
                  <span style="font-weight:600;font-size:14px;">Bezirk ${esc(b)}</span>
                </div>
                <span style="font-size:12.5px;color:#6b7280;">${liste.length} ohne Koordinaten ${aufgeklappt ? "▴" : "▾"}</span>
              </button>
              ${aufgeklappt ? `
                <div class="statistik-hydrant-liste">
                  ${liste.map((h) => `
                    <button type="button" class="koordinaten-hydrant-zeile" data-id="${h.id}">
                      <span>📍</span>
                      <span class="statistik-hydrant-name">${esc(h.name)}</span>
                      <span class="statistik-hydrant-datum">${esc(h.einheit || "–")}</span>
                    </button>`).join("")}
                </div>
              ` : ""}
            </div>
          `;
        }).join("")
    }
  `;
}

function renderStatistikDruckansicht(stat, quote) {
  return `
    <div id="statistik-druckansicht">
      <h1>Hydranten-Kontrollstatistik – ${esc(STATISTIK_EINHEIT)}</h1>
      <p>Ausgedruckt am ${esc(todayStr())}</p>
      ${state.kontrollStartdatum ? `<p>Kontrollrunde seit: ${esc(state.kontrollStartdatum)}</p>` : `<p>Keine Kontrollrunde gestartet.</p>`}
      ${state.kontrollEnddatum1 ? `<p>Ziel 1: ${esc(state.kontrollEnddatum1)}</p>` : ""}
      ${state.kontrollEnddatum2 ? `<p>Ziel 2: ${esc(state.kontrollEnddatum2)}</p>` : ""}
      ${state.kontrollGesamtAbschlussdatum ? `<p><strong>Komplett abgeschlossen am: ${esc(state.kontrollGesamtAbschlussdatum)}</strong></p>` : ""}
      <table class="druck-tabelle">
        <thead>
          <tr><th>Bezirk</th><th>Fertig</th><th>Offen</th><th>Gesamt</th><th>Status</th></tr>
        </thead>
        <tbody>
          ${stat.bezirkNamen.map((b) => {
            const d = stat.bezirke[b];
            const komplett = d.offen === 0;
            return `<tr><td>Bezirk ${esc(b)}</td><td>${d.fertig}</td><td>${d.offen}</td><td>${d.fertig + d.offen}</td><td>${komplett ? "Fertig" : "Offen"}</td></tr>`;
          }).join("")}
        </tbody>
        <tfoot>
          <tr><td>Gesamt</td><td>${stat.gesamtFertig}</td><td>${stat.gesamtOffen}</td><td>${stat.gesamt}</td><td>${quote}\u00A0% fertig</td></tr>
        </tfoot>
      </table>
    </div>
  `;
}

/* ---------- Offline-Kachel-Download ---------- */
async function downloadTiles() {
  const statusEl = document.getElementById("tile-download-status");
  const btn = document.getElementById("btn-download-tiles");

  const bounds = computeBounds(state.hydranten);
  if (!bounds) { showToast("Keine Hydranten mit Position vorhanden"); return; }
  if (!("caches" in window)) { showToast("Offline-Speicher wird von diesem Browser nicht unterstützt"); return; }

  const pad = 0.01; // ca. 1 km Puffer rund um die äußersten Hydranten
  const b = { minLat: bounds.minLat - pad, maxLat: bounds.maxLat + pad, minLng: bounds.minLng - pad, maxLng: bounds.maxLng + pad };

  let tiles = [];
  for (let z = OFFLINE_ZOOM_MIN; z <= OFFLINE_ZOOM_MAX; z++) {
    const nw = tileXY(b.maxLat, b.minLng, z);
    const se = tileXY(b.minLat, b.maxLng, z);
    for (let x = nw.x; x <= se.x; x++) {
      for (let y = nw.y; y <= se.y; y++) tiles.push({ x, y, z });
    }
  }

  if (tiles.length === 0) { showToast("Keine Kacheln zu laden"); return; }
  if (tiles.length > MAX_OFFLINE_TILES) {
    if (!confirm(`Das wären ${tiles.length} Kacheln – das kann lange dauern und viel Datenvolumen benötigen. Trotzdem fortfahren?`)) return;
  }

  btn.disabled = true;
  btn.textContent = "Lädt…";
  const cache = await caches.open(TILES_CACHE_NAME);
  let done = 0, failed = 0;

  for (const t of tiles) {
    const url = tileUrl(t.z, t.x, t.y);
    try {
      // no-cors: OSM-Tile-Server senden i. d. R. keine CORS-Header. Die dadurch
      // "opaque" Antwort lässt sich trotzdem in der Cache API speichern (Standard-
      // Muster für Drittanbieter-Ressourcen ohne CORS) und später offline ausliefern.
      const res = await fetch(url, { mode: "no-cors" });
      await cache.put(url, res);
      done++;
    } catch (e) {
      failed++;
    }
    if ((done + failed) % 15 === 0 || done + failed === tiles.length) {
      statusEl.textContent = `${done + failed} / ${tiles.length} Kacheln verarbeitet${failed ? ` (${failed} fehlgeschlagen)` : ""}…`;
    }
    await new Promise((r) => setTimeout(r, 30)); // Server nicht überlasten
  }

  statusEl.textContent = `Fertig: ${done} Kacheln gespeichert (Zoomstufen ${OFFLINE_ZOOM_MIN}–${OFFLINE_ZOOM_MAX})${failed ? `, ${failed} fehlgeschlagen` : ""}.`;
  btn.disabled = false;
  btn.textContent = "Kacheln jetzt herunterladen";
  showToast("Kartenkacheln heruntergeladen");
}

/* ---------- Login (Supabase) ---------- */
const SUPABASE_URL = "https://icepfjtifsdbefrgilan.supabase.co";
const SUPABASE_KEY = "sb_publishable_oFDN741MtN1_XwVBj4ku8g_j7gqs29P"; // öffentlicher Schlüssel, darf in der App stehen
const LOGIN_DOMAIN = "lz-kleve.de";
const ROLLE_CACHE_KEY = "hydranten-rolle";
let sb = null;
try { sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } }); } catch (e) { console.error("Supabase nicht geladen", e); }

function benutzernameZuEmail(eingabe) {
  const n = (eingabe || "").trim().toLowerCase();
  return n.includes("@") ? n : `${n}@${LOGIN_DOMAIN}`;
}

async function ladeRolleVonServer(userId) {
  const { data, error } = await sb.from("profile").select("rolle").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data ? data.rolle : null;
}

function renderLoginScreen() {
  const el = document.getElementById("login-screen");
  el.innerHTML = `
    <div class="login-card">
      <img class="login-logo" src="data:image/png;base64,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" alt="Logo" />
      <div class="login-title">Hydranten Feuerwehr Kleve</div>
      <div class="login-sub">Bitte anmelden</div>

      <div class="field" style="margin-top:12px;">
        <span class="lbl">Benutzername</span>
        <input type="text" id="login-user" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="z.B. lz-kleve" />
      </div>
      <div class="field" style="margin-top:8px;">
        <span class="lbl">Passwort</span>
        <input type="password" id="login-pass" autocomplete="current-password" placeholder="Passwort" />
      </div>
      <p id="login-error" class="error-text"></p>
      <button id="btn-login" class="btn btn-primary btn-full" style="margin-top:6px;">Anmelden</button>
      <div class="login-hint">Zugangsdaten bekommst du vom App-Admin. Pro Einheit gibt es einen gemeinsamen Zugang.</div>
    </div>
  `;
  document.getElementById("btn-login").addEventListener("click", handleLogin);
  document.getElementById("login-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") handleLogin(); });
  document.getElementById("login-user").addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("login-pass").focus(); });
}

async function handleLogin() {
  const user = document.getElementById("login-user").value;
  const pass = document.getElementById("login-pass").value;
  const errEl = document.getElementById("login-error");
  const btn = document.getElementById("btn-login");
  if (!user.trim() || !pass) { errEl.textContent = "Bitte Benutzername und Passwort eingeben."; return; }
  if (!sb) { errEl.textContent = "Anmeldung nicht verfügbar (Verbindung prüfen)."; return; }
  errEl.textContent = "";
  btn.disabled = true; btn.textContent = "Anmelden …";
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email: benutzernameZuEmail(user), password: pass });
    if (error) {
      errEl.textContent = /invalid|credentials/i.test(error.message) ? "Benutzername oder Passwort falsch." : "Anmeldung fehlgeschlagen. Bitte Verbindung prüfen.";
      return;
    }
    const rolle = await ladeRolleVonServer(data.user.id);
    if (!rolle) { await sb.auth.signOut(); errEl.textContent = "Diesem Konto ist keine Rolle zugewiesen."; return; }
    try { localStorage.setItem(ROLLE_CACHE_KEY, rolle); } catch (e) {}
    state.session = rolle;
    showApp();
    syncAlles();
  } catch (e) {
    errEl.textContent = "Anmeldung fehlgeschlagen. Bitte Verbindung prüfen.";
  } finally {
    btn.disabled = false; btn.textContent = "Anmelden";
  }
}

async function stelleSitzungWiederHer() {
  if (!sb) return;
  try {
    const { data } = await sb.auth.getSession();
    if (!data || !data.session) return;
    let rolle = null;
    try { rolle = await ladeRolleVonServer(data.session.user.id); } catch (e) {
      try { rolle = localStorage.getItem(ROLLE_CACHE_KEY); } catch (e2) {}  // offline: zuletzt bekannte Rolle
    }
    if (rolle) state.session = rolle;
  } catch (e) {}
}

async function handleLogout() {
  try { await Promise.race([syncAlles(), new Promise((r) => setTimeout(r, 3000))]); } catch (e) {}
  if (sb) sb.auth.signOut().catch(() => {});
  try { localStorage.removeItem(ROLLE_CACHE_KEY); } catch (e) {}
  state.session = null;
  state.tab = "karte";
  state.selectedId = null;
  // Einsatzleitungs-Pin (automatischer Standort) sowie die Einsatzplanung (manueller Pin +
  // Umkreis-Filter) sind an die aktuelle Einsatzleitungs-Sitzung gebunden und werden beim
  // Ausloggen zurückgesetzt, statt veraltet stehen zu bleiben.
  state.einsatzleitungLivePin = null;
  state.einsatzplanungPin = null;
  state.einsatzplanungRadius = null;
  state.einsatzplanungModus = false;
  // Hydrantenkontrolle: nächste Anmeldung startet wieder sauber bei der Bezirksauswahl.
  state.hkAktiv = false;
  state.hkBezirk = "alle";
  state.hkFilter = "offen";
  showLogin();
}

function showApp() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  const badge = document.getElementById("role-badge");
  badge.textContent = isSonderrolle(state.session) ? `🛡 ${state.session} · Vollzugriff` : `${state.session} · eigene Hydranten bearbeitbar`;
  state.karteEinheit = isSonderrolle(state.session) ? "alle" : state.session;

  const erfassenNavBtn = document.querySelector('.nav-item[data-tab="hinzufuegen"]');
  if (erfassenNavBtn) erfassenNavBtn.classList.toggle("hidden", !hatErfassenZugriff(state.session));
  if (!hatErfassenZugriff(state.session) && state.tab === "hinzufuegen") state.tab = "karte";

  const statistikBtn = document.getElementById("btn-statistik");
  if (statistikBtn) statistikBtn.classList.toggle("hidden", !hatStatistikZugriff(state.session));
  if (!hatStatistikZugriff(state.session) && state.tab === "statistik") state.tab = "karte";
  if (!hatStatistikInhaltZugriff(state.session) && state.tab === "statistik-koordinaten") state.tab = "karte";
  if (state.session !== "App-Admin" && (state.tab === "daten-loeschen" || state.tab === "konten")) state.tab = "karte";

  if (state.session === "Einsatzleitung" && !state.einsatzleitungLivePin && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.einsatzleitungLivePin = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        if (state.tab === "karte") render();
      },
      () => showToast("Standort für Einsatzleitungs-Pin nicht verfügbar"),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  if (state.neuesArchivJahr && isSonderrolle(state.session)) {
    showToast(`📦 Jahresarchiv ${state.neuesArchivJahr} wurde automatisch erstellt – im Reiter "Daten" herunterladen`);
    state.neuesArchivJahr = null;
  }

  // Info-Hinweis für den App-Admin: neu angelegte Hydranten (z.B. von den Stadtwerken) ohne
  // zugeordneten Bezirk warten auf Zuordnung.
  if (state.session === "App-Admin") {
    const ohneBezirk = state.hydranten.filter((h) => !((h.bezirk || "").trim()));
    if (ohneBezirk.length > 0) zeigeHydrantenOhneBezirkBenachrichtigung(ohneBezirk.length);
  }

  render();
}

function showLogin() {
  document.getElementById("app").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
  renderLoginScreen();
}

/* ---------- Init ---------- */
async function init() {
  await loadData();
  await ladeEinstellungenInState();

  await pruefeUndErstelleJahresarchiv();
  state.archivListe = await getAlleArchive();

  document.getElementById("btn-logout").addEventListener("click", () => {
    if (confirm("Wirklich abmelden?")) handleLogout();
  });

  document.getElementById("btn-info").addEventListener("click", () => {
    navVor();
    state.tab = "info";
    state.infoEditMode = false;
    render();
  });

  document.getElementById("btn-statistik").addEventListener("click", () => {
    navVor();
    state.tab = "statistik";
    render();
  });

  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.tab === "hinzufuegen" && !hatErfassenZugriff(state.session)) return; // Sicherheitsnetz, Button ist ohnehin ausgeblendet
      // Direkter Wechsel über die untere Navigation gilt als neuer "Wurzel"-Punkt - die
      // Verlaufstiefe wird zurückgesetzt, damit sich beim erneuten Öffnen tieferer Ansichten
      // keine unpassenden Zurück-Sprünge zu vorher verlassenen Zwischenständen ansammeln.
      history.replaceState({ navTiefe: 0 }, "");
      state.tab = btn.dataset.tab;
      state.selectedId = null;
      render();
    });
  });

  document.getElementById("import-file").addEventListener("change", handleImportFile);

  if (!navigator.onLine) {
    document.getElementById("sync-indicator").classList.remove("hidden");
  }
  window.addEventListener("offline", () => document.getElementById("sync-indicator").classList.remove("hidden"));
  window.addEventListener("online", () => { syncAlles(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncAlles(); });
  setInterval(() => { if (document.visibilityState === "visible") syncAlles(); }, 90000);

  await stelleSitzungWiederHer();
  if (state.session) { showApp(); syncAlles(); } else showLogin();
  versteckeSplash();
}

// Start-Bild mindestens kurz zeigen (damit es nicht aufblitzt), dann ausblenden
function versteckeSplash() {
  const el = document.getElementById("splash");
  if (!el) return;
  const rest = Math.max(0, 900 - (performance.now ? performance.now() : 0));
  setTimeout(() => { el.classList.add("weg"); setTimeout(() => el.remove(), 450); }, rest);
}

init();
