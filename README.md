# Hydranten Feuerwehr Kleve – PWA

Offline-fähige Progressive Web App zur Hydrantenkontrolle und für den Einsatz-Nachschlag.

## Was funktioniert schon
- **Einheitliches Ja/Nein-Bestätigungs-Popup für alle Löschen-Aktionen**: Hydrant löschen, Foto
  entfernen, Lage-Foto entfernen, Kontrollrunden-Startdatum löschen - überall erscheint jetzt ein
  eigenes Popup mit "Ja"/"Nein" (der native Browser-Dialog lässt sich nicht so beschriften). Bei
  Fotos gab es vorher noch gar keine Bestätigung, jetzt schon. Die Gesamt-Datenlöschung beim
  App-Admin bleibt bewusst wie zuvor: erst das Wort "LÖSCHEN" eintippen, danach die zusätzliche
  Sicherheitsabfrage.
- **Kartenzentrierung erneut behoben**: Die Hydrantenkontrolle-Karten (Einstieg/aktive Runde) haben
  versehentlich die gemerkte Position der Haupt-Karte überschrieben, da beide sich eine gemeinsame
  Variable teilten. Dadurch zeigte die Haupt-Karte beim nächsten Öffnen manchmal die falsche
  (von einer Nebenkarte "geerbte") Position, statt sich korrekt auf die aktuelle Auswahl einzupassen.
  Jetzt aktualisiert nur noch die Haupt-Karte selbst ihre gemerkte Position.
- **Keine Demo-Hydranten mehr**: Die App startet bei einer frischen Installation jetzt komplett
  leer, statt automatisch 3 Beispiel-Hydranten (Marktplatz, Bahnhofstraße, Schulzentrum Nord)
  anzulegen. Wichtig für den echten Einsatz/Produktivbetrieb.
- **"Alle Daten löschen" jetzt doppelt abgesichert**: liegt nicht mehr als direkter Button im
  Daten-Tab, sondern in einer eigenen Unterseite ("⚠️ Alle Daten löschen"). Dort muss erst das Wort
  "LÖSCHEN" eingetippt werden, bevor der Button überhaupt aktiv wird - danach folgt zusätzlich noch
  die normale Sicherheitsabfrage.
- **App-Admin – Reiter "Daten" ebenfalls in aufklappbare Abschnitte gegliedert**: "📁 Daten"
  (Excel-Export + -Import) und "⚙️ Funktionen" (Lage-Foto-Freigabe, Fotoexport als ZIP,
  Jahresarchiv, Kartenkacheln für Offline-Nutzung). "Alle Daten löschen" bleibt bewusst außerhalb
  der Abschnitte direkt sichtbar, da es eine kritische, nicht rückgängig machbare Aktion ist.
- **Fotoexport als ZIP (nur App-Admin)**: Im Reiter "Daten" können alle bisher aufgenommenen Fotos
  (Beschädigung + Lage) gesammelt als ZIP-Datei heruntergeladen werden, jede Datei benannt nach dem
  zugehörigen Hydranten. Manuelles Sicherungsnetz, bis ein echter Server-Upload mit automatischer
  Zuordnung existiert - kein automatischer Cross-Device-Sync, siehe Hinweis zum Server-Backend.
- **"Alle Daten löschen" nur noch für App-Admin** (vorher unbeabsichtigt für jede Rolle sichtbar,
  inkl. einzelner Einheiten) und lädt keine Demo-Hydranten mehr nach – die Liste bleibt danach
  wirklich leer, statt automatisch die 3 Demo-Hydranten neu anzulegen.
- **Einsatzleitung – Reiter "Daten" auf das Nötigste reduziert**: ausschließlich die
  Kartenkacheln-Funktion für die Offline-Nutzung, kein Export/Import, keine Lage-Foto-Freigabe,
  kein Jahresarchiv, kein "Alle Daten löschen". Passt zur Rolle der Einsatzleitung, die im Einsatz
  vor allem eine funktionierende Offline-Karte braucht.
- **Eigene Stadtwerke-Ansicht**: kein Hydrantenkontrolle-Tab, kein Löschen (jetzt nur noch
  App-Admin), keine Lage-Foto-Freigabe, kein "Alle Daten löschen", kein Excel-Import (nur Export).
  Der Reiter "Daten" ist stattdessen in drei aufklappbare Abschnitte gegliedert: **Daten** (Export +
  "Neuen Hydranten anlegen"), **Archiv** (Jahresarchiv) und **Statistik** (nur die reine
  Gesamtübersicht - ohne Kontrollrunde starten/verwalten und ohne den Koordinaten-Lücken-Link, die
  bleiben App-Admin vorbehalten). Neu angelegte Hydranten erscheinen automatisch beim App-Admin
  (gleiche lokale Datenbank), der dann per Info-Banner ("ℹ️ X Hydrant(en) ohne Bezirk") daran erinnert
  wird, ihnen einen Bezirk zuzuordnen.
- **Wehrführung erhält denselben Reiter "Daten" wie die Stadtwerke** (dieselben drei aufklappbaren
  Abschnitte, dieselben Einschränkungen) - "Neuen Hydranten anlegen" erscheint dabei nur, sofern die
  jeweilige Rolle das auch tatsächlich darf. Die Wehrführung hat zudem **keinen eigenen
  Hydrantenkontrolle-Tab** mehr (wie Stadtwerke und Einsatzleitung).
- **Hardware-/Gesten-Zurück-Taste unterstützt**: Vorher führte die Zurück-Taste des Handys direkt
  aus der App heraus. Jetzt navigiert sie innerhalb der App eine Ebene zurück (Formular schließen,
  von der Detailansicht zur Liste, von Impressum zu Info, von der Koordinaten-Übersicht zur
  Statistik usw.) - genau wie der jeweilige "Zurück"-Button in der App selbst. Das ist unabhängig
  vom Hosting und funktioniert unabhängig davon, ob die App lokal oder auf einem Server läuft.
- **Neutrale Anzeige bei neuer Kontrollrunde**: Startet der App-Admin auf der Statistikseite eine
  neue Kontrollrunde, zeigt die Hydrantenkontrolle (Liste + Karte) für alle Hydranten, die seitdem
  noch nicht neu geprüft wurden, statt des alten Status "Nicht kontrolliert" (grau) an. Sobald ein
  Hydrant in der neuen Runde kontrolliert und gespeichert wird, erscheint sein echter Status sofort
  wieder normal - überall sonst (Karte, Detailansicht, Excel-Export, Statistik) war der tatsächliche
  Status währenddessen ununterbrochen sichtbar/korrekt, nur diese eine Ansicht wurde maskiert.
- **Automatisches Jahresarchiv**: Wird die App am oder nach dem 30.09. eines Jahres zum ersten Mal
  geöffnet, legt sie automatisch einen Datenstand-Snapshot im Reiter "Daten" ab (ohne Fotos, um
  Speicher zu sparen). Vollzugriffs-Rollen erhalten dann eine Benachrichtigung und können das
  Archiv mit einem Klick als Excel-Datei herunterladen und selbst in ihrem eigenen Archivordner
  ablegen. **Technische Einschränkung, unabhängig von dieser App:** Ein Browser kann nicht wirklich
  "im Hintergrund" an einem festen Datum aktiv werden, wenn die App gerade geschlossen ist, und darf
  aus Sicherheitsgründen nicht eigenständig in einen beliebigen Ordner auf dem Gerät schreiben. Das
  Archiv entsteht deshalb beim nächsten tatsächlichen Öffnen der App nach dem Stichtag, nicht exakt
  am 30.09. selbst, und landet zunächst in der App - der letzte Schritt in einen eigenen Ordner ist
  ein bewusster Klick auf "Herunterladen".
- **Statistikseite als aufklappbare Abschnitte**: "Kontrollrunde" und "Gesamtübersicht" sind jetzt
  eigene, unabhängig auf-/zuklappbare Karten mit sichtbarem Kurzstatus auch im eingeklappten
  Zustand (z. B. "seit 2026-09-01" bzw. "12 fertig, 5 offen"). Neue Statistiken lassen sich über
  dasselbe Muster (`statistikAbschnittHTML(...)`) einfach ergänzen, ohne die Seite unübersichtlich
  zu machen. Der Link "Hydranten ohne Koordinaten" und das "🏆 Alle Bezirke abgeschlossen"-Banner
  bleiben bewusst immer sichtbar, da sie eigenständige Hinweise sind.
- **Hydrantenkontrolle neu aufgebaut** (zweistufig, wie der Reiter "Karte"): Einstiegsseite mit
  Bezirksauswahl + Kartenübersicht + "Hydrantenkontrolle starten"-Button. Danach eine aktive
  Kontrollrunden-Seite mit den Auswahlmöglichkeiten "Offen"/"Kontrolliert" (jeweils mit Zähler).
  Ein Hydrant in der Liste antippen führt direkt ins Bearbeiten-Formular (kein Umweg über die
  Detailansicht); nach dem Speichern geht es automatisch zurück in die Liste, und der Hydrant
  wandert von "Offen" zu "Kontrolliert" (gilt als kontrolliert, sobald sein Kontrolldatum auf
  heute steht – unabhängig vom längerfristigen Kontrollrunden-Startdatum der Statistik-Seite).
- **Koordinaten-Lücken-Übersicht** (über die Statistikseite, "📍 Hydranten ohne Koordinaten"):
  einheitenübergreifende Liste aller Hydranten ohne hinterlegte Position, gruppiert nach Bezirk,
  mit Gesamtzahl. Klick auf einen Hydranten öffnet direkt dessen Detailansicht zum Nachtragen
  der Koordinaten (z. B. über "Bearbeiten" → GPS-Standort ermitteln).
- **Einsatzleitung – Standort-Pin & Einsatzplanung**: Meldet sich die Einsatzleitung an, wird
  automatisch per GPS ein schwarzer Pin mit Beschriftung "Einsatzleitung" auf der Karte gesetzt
  (nur auf dem eigenen Gerät sichtbar – echte geräteübergreifende Anzeige für alle Einheiten
  braucht das noch ausstehende Server-Backend). Über den Button "📍 Einsatzplanung" kann zusätzlich
  ein Einsatzort-Pin frei auf der Karte gesetzt werden; danach lässt sich der Hydranten-Umkreis
  (100 m/200 m/500 m/1 km/2 km oder "Alle") auswählen – die Liste und Karte zeigen dann nur noch
  Hydranten innerhalb dieses Radius.
- **Automatisches Gesamtabschlussdatum**: Sobald wirklich alle Bezirke von LZ Kleve fertig sind,
  wird automatisch ein Datum gesetzt und ein besonderes "🏆"-Banner gezeigt. Bleibt bestehen, bis
  eine neue Kontrollrunde gestartet oder das Startdatum gelöscht wird.
- **Druckbare Bezirks-Übersicht**: Button "🖨 Bezirks-Übersicht ausdrucken" auf der Statistikseite
  öffnet den normalen Browser-Druckdialog mit einer eigens dafür aufbereiteten Ansicht – nur die
  Bezirks-Zahlen (fertig/offen/Status), keine einzelnen Hydranten, damit der Ausdruck kompakt bleibt.
- **Statistikseite** (📊-Symbol im Header, nur für App-Admin sichtbar, aktuell nur für LZ Kleve):
  zeigt pro Bezirk, wie viele Hydranten seit einem einstellbaren Kontrollrunden-Startdatum bereits
  kontrolliert wurden ("X fertig, Y offen"), mit aufklappbarer Liste der einzelnen Hydranten und
  ihrem Kontrolldatum. Sobald ein Bezirk dadurch komplett abgeschlossen wird, erscheint automatisch
  eine Benachrichtigung ("🎉 Bezirk X ist komplett abgearbeitet!") auf dem Gerät, auf dem gerade
  gespeichert wurde. Das Kontrolldatum eines Hydranten wird beim Öffnen zum Bearbeiten automatisch
  auf "heute" vorausgefüllt (bei Bedarf manuell korrigierbar), damit normales Kontrollieren+Speichern
  automatisch für die Statistik zählt.
- **Schutz vor versehentlichem Verschieben**: Hat ein Hydrant beim Öffnen des Formulars bereits eine
  Position, ist der Marker auf der Positions-Karte zunächst gesperrt (nicht ziehbar, Antippen der
  Karte zeigt einen Hinweis statt zu verschieben). Erst ein bewusster Klick auf "Entsperren zum
  Verschieben" gibt ihn frei; danach lässt er sich wieder sperren. Hydranten ohne bisherige Position
  sind direkt frei platzierbar.
- **Positions-Karte im Formular**: statt reiner Texteingabe zeigt das Formular eine kleine Karte mit
  verschiebbarem Marker. "GPS-Standort ermitteln" nutzt `enableHighAccuracy` für den genauesten
  verfügbaren Sensor-Fix; da Smartphone-GPS bauartbedingt oft 3–10 m abweicht, lässt sich der Marker
  per Fingertipp oder Ziehen exakt auf den Schachtdeckel/Gehweg setzen. Koordinaten sind weiterhin
  auch manuell eingebbar und komplett optional.
- **Info-Seite** (über das "ℹ"-Symbol im Header): frei bearbeitbares Hinweisfeld für spontane Texte,
  plus Impressum und Disclaimer als eigene Unterseiten. Ansehen für alle, Bearbeiten nur für
  Vollzugriffs-Rollen (Buttons sind für Einheiten ausgeblendet, zusätzlich beim Speichern nochmal
  serverseitig geprüft).
- **Zwei getrennte Fotofunktionen pro Hydrant**:
  - *Foto zur Beschädigung*: frei nutzbar von jeder Person mit Bearbeitungsrecht am Hydranten,
    jederzeit aufnehm- und löschbar.
  - *Foto zur Lage*: für schwer auffindbare Hydranten. Muss von einer Vollzugriffs-Rolle im Reiter
    "Daten" per Schalter freigegeben werden, bevor Einheiten ein solches Foto aufnehmen dürfen.
    Solange die Freigabe aktiv ist, dürfen Einheiten ihr eigenes Lage-Foto frei verwalten (aufnehmen,
    ersetzen, löschen). Wird die Freigabe zurückgenommen, bleibt ein bereits vorhandenes Foto
    eingefroren und ist nur noch für Vollzugriffs-Rollen änderbar. Die Regel wird sowohl in der
    Oberfläche als auch beim Speichern selbst geprüft (doppelt abgesichert).
- **Foto pro Hydrant**: Im Erfassen-/Bearbeiten-Formular kann direkt über die Gerätekamera ein Foto
  aufgenommen werden (z. B. bei starker Beschädigung oder versteckter Lage). Wird automatisch auf
  max. 1280px verkleinert und komprimiert (JPEG), lokal in der Datenbank gespeichert, in der
  Detailansicht antippbar für die Vollbildanzeige. Im Excel-Export erscheint eine Spalte
  "Foto" (Ja/Nein) – die Bilder selbst werden aus technischen Gründen nicht in die Excel-Datei
  eingebettet, bleiben aber vollständig in der App-Datenbank enthalten.
- **Änderungshistorie**: Jede Speicherung (egal von wem) wird intern mit Zeitstempel und Rolle
  protokolliert. In der App ist immer nur der letzte Stand sichtbar; der Excel-Export enthält
  zusätzlich ein Tabellenblatt "Aenderungshistorie" mit allen Änderungen für Statistikzwecke.
- **Anmeldung**: Auswahl aus 12 Einheiten oder 4 Vollzugriffs-Rollen (Einsatzleitung, Stadtwerke,
  Wehrführung, App-Admin) mit gemeinsamem Demo-Zugangscode. Einheiten dürfen nur eigene Hydranten
  bearbeiten, sehen aber alle (für den Einsatzfall). Vollzugriffs-Rollen dürfen alles bearbeiten –
  dabei wird automatisch ein Vermerk ("geändert von: ...") hinter dem Kontrolldatum ergänzt.
  Einsatzleitung hat keinen Zugriff auf den "Erfassen"-Reiter.
- Karte mit echten Straßenkarten (Leaflet + OpenStreetMap), Liste, Suche, Bezirks- und Zustandsfilter
- Hydranten erfassen/bearbeiten/löschen, inkl. Bezirks-Navigator mit Pfeilen/Wischgeste für Kontrollrunden
- "In der Nähe"-Modus mit Standortabfrage und Entfernungssortierung
- Excel-Import/-Export (.xlsx)
- Alle Daten lokal gespeichert (IndexedDB) – funktioniert komplett ohne Internet
- Installierbar auf dem Homescreen (Manifest + Service Worker)
- **Offline-Kartenkacheln**: Im Reiter "Daten" können die OpenStreetMap-Kacheln rund um alle
  erfassten Hydranten (Zoomstufen 13–17) einmalig heruntergeladen werden. Danach zeigt die Karte
  euer Gebiet auch ohne Internetverbindung an.

## Wichtiger Hinweis: App-Updates nach dem Deployment
Falls die App nach einem Update seltsam reagiert (Buttons ohne Funktion, alte Optik) – das lag an
einer nie erhöhten Service-Worker-Cache-Version (`CACHE_NAME` in `sw.js`). Der Browser aktualisiert
den Cache nur, wenn sich `sw.js` selbst ändert. Das ist jetzt behoben: `app.js`/`index.html`/
`styles.css` werden ab sofort **netzwerk-zuerst** geladen (Cache nur noch als Offline-Rückfallebene),
Kartenkacheln und externe Bibliotheken bleiben weiterhin cache-zuerst für echte Offline-Nutzung.
Damit sollte sich das Problem beim nächsten Deployment selbst beheben – falls doch nicht, hilft ein
harter Reload bzw. "Website-Daten löschen" im Browser.

## Wichtiger Sicherheitshinweis zur Anmeldung
Die aktuelle Anmeldung ist **nur zur Vorstellung/zum Testen** gedacht: Der Zugangscode wird direkt
im Browser geprüft (fest im Code hinterlegt), nicht sicher übertragen oder gehasht. Jede Person mit
Zugriff auf die Browser-Entwicklertools könnte diese Prüfung umgehen und an alle lokal gespeicherten
Daten kommen. Für den produktiven Einsatz mit echtem Datenschutz muss das durch eine serverseitige
Anmeldung (siehe Backend-Planung) ersetzt werden.

## Wichtige Hinweise zur Kartenfunktion
- Die Karte nutzt den öffentlichen OpenStreetMap-Kachelserver. Das ist kostenlos, aber für
  **Produktivbetrieb mit vielen Geräten** empfiehlt sich langfristig ein eigener Tile-Server oder
  ein kommerzieller Anbieter, um die [OSM-Nutzungsrichtlinie](https://operations.osmfoundation.org/policies/tiles/)
  einzuhalten (kein exzessives automatisiertes Herunterladen). Der eingebaute Download-Button lädt
  bewusst mit kleinen Pausen zwischen den Anfragen.
- Gecachte Kacheln werden im Browser gespeichert (Cache Storage) und können, je nach Gebietsgröße,
  mehrere zehn bis über hundert MB belegen.
- Zoomt man im Einsatz ohne Internet über Zoomstufe 17 hinaus, fehlen dort Kacheln (leere/graue
  Flächen), da nur 13–17 vorab geladen werden. Die Zoomstufen lassen sich im Code
  (`OFFLINE_ZOOM_MIN`/`OFFLINE_ZOOM_MAX` in `app.js`) anpassen.

## Was noch fehlt (nächster Schritt)
- Geräteübergreifende Synchronisierung mehrerer Nutzer:innen (braucht ein Backend, z. B. Firebase,
  Supabase oder eigene API + Datenbank)
- Nutzerrechte/Login
- Bessere App-Icons (aktuell nur ein SVG-Platzhalter; für volle Kompatibilität empfehlen sich
  zusätzlich PNG-Icons in 192×192 und 512×512)

## Lokal testen
Ein Service Worker benötigt HTTPS oder `localhost`. Einfachster Weg:

```bash
cd pwa
python3 -m http.server 8000
```

Dann im Browser `http://localhost:8000` öffnen. Über "Zum Startbildschirm hinzufügen"
(Android/Chrome) bzw. "Teilen → Zum Home-Bildschirm" (iOS/Safari) lässt sich die App installieren.

Zum Offline-Test: Seite einmal komplett laden, dann im Browser DevTools → Network → "Offline"
aktivieren (oder Flugmodus) und neu laden – die App sollte weiterhin funktionieren.

## Deployment (Vorschläge, alle kostenlos/einfach)
- **GitHub Pages**: Repository mit diesem Ordnerinhalt anlegen, Pages in den Settings aktivieren
- **Netlify** oder **Vercel**: Ordner per Drag & Drop hochladen
- **Firebase Hosting**: `firebase init hosting` → `firebase deploy`

Wichtig: `start_url` und `scope` in `manifest.json` sind relativ gesetzt (`./`) – das funktioniert
sowohl im Root einer Domain als auch in einem Unterordner.

## Nächste Ausbaustufe: Sync-Backend
Sobald mehrere Personen dieselbe Hydranten-Datenbank pflegen sollen, braucht es einen Server:
1. Jede lokale Änderung bekommt einen Zeitstempel (`updatedAt`)
2. Bei Netzverbindung: geänderte Datensätze an den Server senden, aktuelle Version anderer
   Geräte abholen
3. Konfliktbehandlung definieren (z. B. "letzter Schreibvorgang gewinnt" oder Merge auf Feldebene)

Diese Datei-Struktur ist bewusst so gebaut, dass dieser Schritt später ergänzt werden kann,
ohne die App-Shell neu schreiben zu müssen.

## Etappe 1 (Server): Anmeldung & Konten
- Echte Anmeldung mit **Benutzername + Passwort** über Supabase (intern `benutzername@lz-kleve.de`; Eingabe mit @ gilt als volle E-Mail).
- Die Rolle kommt vom Server (Tabelle `profile`), nicht mehr aus einer Auswahl.
- App-Admin: Daten → **Konten & Passwörter** (Konto je Einheit/Rolle anlegen, Passwort ändern, mind. 12 Zeichen).
- Hydranten liegen noch lokal (IndexedDB) – Umstellung auf die Datenbank folgt in Etappe 2.

## Etappe 2 (Server): Hydranten & Fotos
- Hydranten, Fotos und Einstellungen (Infotext, Kontrolldaten, Lage-Foto-Freigabe) liegen in Supabase und werden auf allen Geräten abgeglichen (beim Start, nach Speichern, alle 90 s, beim Wieder-Online-Gehen).
- Offline: Änderungen werden lokal gemerkt und später automatisch übertragen.
- Rechte werden zusätzlich serverseitig geprüft; abgelehnte Änderungen werden verworfen und gemeldet.
- Änderungshistorie führt der Server; sie ist im Excel-Export enthalten.
- Alte lokale Testdaten (vor dem Server) werden beim ersten Abgleich als lokale Sicherung beiseitegelegt.

## Excel-Import als Abgleich
- Import nur für den App-Admin. Die Datei bestimmt den Stand: Zuordnung über die neue Hydrantennummer (sonst Name + alte Nummer).
- Neue Zeilen werden angelegt, geänderte aktualisiert (Fotos bleiben), unveränderte nicht angefasst. Vorhandene GPS-Positionen werden nie durch leere Koordinaten überschrieben.
- Hydranten, die nicht in der Datei stehen, können nach Rückfrage gelöscht werden.

## Jahresarchiv auf dem Server
- Am 30.09. (22:00 UTC = 00:00 Uhr deutscher Zeit am 01.10.) legt der Server automatisch einen Datenstand-Snapshot an (ohne Fotos).
- Die App lädt vorhandene Archive für Vollzugriffs-Rollen herunter und hält sie offline vor. Excel-Download wie bisher.
- App-Admin: Daten → Funktionen → „Archiv <Jahr> jetzt erstellen“ für eine manuelle Sicherung.

## Startbild
- Beim Öffnen zeigt die App ein Startbild (Logo auf Dunkelblau) und blendet es nach dem Laden aus.
- Manifest: Hintergrundfarbe passend zum Logo, eigene „maskable“-Icons mit Rand, damit nichts abgeschnitten wird.

## Statuswörter und Bezirk „Sonder“
- Gelb markierte Hydranten (Defekt 1, 2, 3, 4, 7, 9) heißen jetzt **„Bedingt defekt“**, graue (Defekt 0) **„Zugeparkt“**, rote bleiben **„Defekt“**. Gespeichert wird weiterhin der Zustand „defekt“; nur die Anzeige ist feiner. Die Auswahl „0. Zugeparkt“ ersetzt den alten Text automatisch.
- Hydranten im Bezirk **„Sonder“** zählen in der Statistik (Gesamtübersicht, Bezirke, Abschluss-Meldungen, Koordinaten-Lücken) nicht als Hydrant mit.

## Hydrantenliste
Jede Zeile zeigt: Name, Nr. neu (alt), Defekt-Art (farbig, mehrzeilig), Bezirk · Einheit, Lage.
