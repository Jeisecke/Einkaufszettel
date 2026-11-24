/* ============================================================================
 *  Einkaufszettel – Frontend (reines JavaScript, keine Bibliotheken)
 * ============================================================================
 *
 * Was macht diese Datei?
 *   Alles, was man in der App sieht und anfasst: Liste anzeigen, Artikel
 *   hinzufügen, abhaken, verschieben, löschen, anmelden, Einstellungen.
 *   Sie redet mit dem Server (api.php) und merkt sich alles zusätzlich im
 *   Browser (localStorage), damit die App auch offline funktioniert.
 *
 * Das wichtigste Prinzip: "optimistisch" arbeiten
 *   Tippt man z. B. auf "Milch abhaken", passiert Folgendes:
 *     1. Die App ändert SOFORT ihre lokale Kopie und zeichnet die Liste neu.
 *        -> Der Benutzer muss nie auf den Server warten.
 *     2. Die Änderung kommt in eine Warteschlange ("Outbox").
 *     3. Die Outbox wird der Reihe nach an den Server geschickt.
 *        Ohne Netz bleibt sie (im localStorage) liegen und wird später
 *        nachgeholt – praktisch bei schlechtem Empfang im Supermarkt.
 *
 * Wie kommen Änderungen der anderen an?
 *   Alle 4 Sekunden fragt die App: "Hat sich seit Stand X etwas geändert?"
 *   (api.php?since=X). Meist lautet die Antwort nur "nein" – das ist sehr
 *   sparsam. Wenn doch, kommt die komplette neue Liste.
 *
 * Aufbau dieser Datei (von oben nach unten)
 *   1.  Einstellungen & Konstanten
 *   2.  Stichwörter für die automatische Kategorie
 *   3.  Kleine Helfer (Speicher, Text, Zeit, Avatare, Mengen-Erkennung)
 *   4.  Zustand der App (was gerade geladen ist)
 *   5.  Kategorien & Sortierung
 *   6.  Server-Kommunikation & Synchronisation (Outbox, Abfragen)
 *   7.  Aktionen (hinzufügen, abhaken, löschen, Wagen leeren, ...)
 *   8.  Anzeige (Liste zeichnen, Sync-Punkt, Toast-Meldungen)
 *   9.  Eingabeleiste unten (Name, Menge, Vorschläge, Kategorie-Knopf)
 *   10. Liste bedienen (tippen, lange drücken, löschen mit Bestätigung)
 *   11. Ziehen & Ablegen (Artikel verschieben)
 *   12. Bearbeiten-Dialog
 *   13. Einstellungen (Familie, Reihenfolge, Passwort, Abmelden)
 *   14. Anmeldung & Registrierung
 *   15. Bildschirm anlassen (Wake Lock)
 *   16. Layout-Helfer (Bildschirmtastatur, Kopfzeilen-Höhe)
 *   17. Start der App
 */

// Strenger Modus: JavaScript meckert bei typischen Fehlern (z. B. Tippfehler
// in Variablennamen), statt still weiterzumachen.
'use strict';


/* ============================================================================
 *  1. Einstellungen & Konstanten
 * ========================================================================== */

// Auf true setzen, falls der Hoster PUT/DELETE blockiert (z. B. durch ModSecurity).
// Dann schickt die App stattdessen POST + den Header "X-HTTP-Method-Override".
const USE_METHOD_OVERRIDE = false;

const API_URL            = 'api.php';       // Adresse des Servers (relativ zur Seite)
const POLL_ACTIVE_MS     = 4000;            // aktiv: alle 4 s nach Änderungen fragen
const POLL_IDLE_MS       = 12000;           // nach 2 Min. Inaktivität: alle 12 s
const POLL_DEEP_IDLE_MS  = 25000;           // nach 10 Min. Inaktivität: alle 25 s
const IDLE_AFTER_MS      = 2 * 60 * 1000;
const DEEP_IDLE_AFTER_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;           // Anfrage nach 10 s abbrechen
const RETRY_MS           = 8000;            // nach Verbindungsfehler in 8 s erneut versuchen
const MAX_SERVER_RETRIES = 5;               // so oft bei Serverfehler (5xx) wiederholen
const WAKE_IDLE_MS       = 10 * 60 * 1000;  // Bildschirm-anlassen endet nach 10 Min. ohne Bedienung
const LONG_PRESS_MS      = 500;             // so lange drücken = "Bearbeiten" öffnen
const DRAG_HOLD_MS       = 220;             // auf Touch: Griff kurz halten, damit Scrollen nicht verschiebt
const MOVE_TOLERANCE_PX  = 10;              // so weit darf der Finger beim Halten wackeln
const TOAST_UNDO_MS      = 8000;            // so lange steht "Rückgängig" zur Verfügung
const NAME_MAX           = 120;             // Max. Länge eines Artikelnamens (wie api.php)
const QTY_MAX            = 30;              // Max. Länge der Mengenangabe (wie api.php)
const NOTE_MAX           = 200;             // Max. Länge einer Notiz (wie api.php)
const DEFAULT_LIST_ID    = 'default';
const DEFAULT_LISTS      = [{ id: DEFAULT_LIST_ID, name: 'Einkauf', emoji: '🛒', position: 0 }];

// Namen der Einträge im localStorage (Browser-Speicher). Das Präfix "ekz."
// (EinKaufsZettel) verhindert Verwechslungen mit anderen Apps.
const STORAGE_KEYS = {
  items:      'ekz.items',      // die Artikel
  lists:      'ekz.lists',      // Einkaufslisten / Märkte
  activeList: 'ekz.activeList', // aktuell gewählte Liste
  cats:       'ekz.categories', // Kategorien in Laden-Reihenfolge
  templates:  'ekz.templates',  // Vorlagen / Rezepte
  known:      'ekz.known',      // bekannte Artikel (für Vorschläge)
  outbox:     'ekz.outbox',     // noch nicht gesendete Änderungen
  me:         'ekz.me',         // wer bin ich
  wake:       'ekz.wakeLock',   // Einstellung "Bildschirm anlassen"
  hintDone:   'ekz.hintDone',   // Bedienhinweis schon gesehen?
};

// Kategorien, falls der Server (noch) keine geliefert hat – z. B. beim
// allerersten Start ohne Netz. Muss zu config.php passen.
const DEFAULT_CATEGORIES = [
  { id: 'obst',        label: 'Obst & Gemüse',      emoji: '🥦' },
  { id: 'brot',        label: 'Brot & Backwaren',   emoji: '🥖' },
  { id: 'kuehl',       label: 'Kühlregal',          emoji: '🧀' },
  { id: 'fleisch',     label: 'Fleisch & Fisch',    emoji: '🥩' },
  { id: 'tk',          label: 'Tiefkühl',           emoji: '🧊' },
  { id: 'vorrat',      label: 'Vorrat & Konserven', emoji: '🥫' },
  { id: 'fruehstueck', label: 'Frühstück',          emoji: '🍯' },
  { id: 'suess',       label: 'Süßes & Snacks',     emoji: '🍫' },
  { id: 'getraenke',   label: 'Getränke',           emoji: '🧃' },
  { id: 'drogerie',    label: 'Drogerie',           emoji: '🧴' },
  { id: 'haushalt',    label: 'Haushalt',           emoji: '🧽' },
  { id: 'sonstiges',   label: 'Sonstiges',          emoji: '🛒' },
];
// Rückfall, falls eine Kategorie gar nicht gefunden wird
const FALLBACK_CATEGORY = { id: 'sonstiges', label: 'Sonstiges', emoji: '🛒' };


/* ============================================================================
 *  2. Stichwörter für die automatische Kategorie
 * ============================================================================
 *
 * Tippt man "Vollkornbrot", soll die App selbst auf "Brot & Backwaren" kommen.
 * Dafür wird geprüft, welche dieser Stichwörter im Namen vorkommen.
 *
 * Regeln:
 *   - Teilwort-Treffer zählen (deutsche zusammengesetzte Wörter:
 *     "Vollkornbrot" enthält "brot").
 *   - Gibt es mehrere Treffer, gewinnt das Stichwort, das am weitesten HINTEN
 *     im Namen endet. Im Deutschen bestimmt das letzte Wortteil, was etwas ist:
 *     "Erdbeerjoghurt" ist ein Joghurt (Kühlregal), kein Obst.
 *     Bei Gleichstand gewinnt das längere Stichwort.
 *   - Ein "=" vor dem Stichwort heißt: nur als GANZES Wort.
 *     Beispiel: "=eis" trifft "Eis", aber nicht "Reis" oder "Preiselbeeren".
 *
 * Hat man einen Artikel schon einmal benutzt, gilt aber vorrangig die
 * Kategorie vom letzten Mal (siehe guessCategory).
 */
const KEYWORDS = {
  obst: ['obst', 'gemüse', 'apfel', 'äpfel', 'banane', 'birne', 'orange', 'mandarine', 'clementine', 'zitrone',
    'limette', 'traube', 'erdbeer', 'himbeer', 'heidelbeer', 'blaubeer', 'beeren', 'kiwi', 'mango', 'ananas',
    'melone', 'pfirsich', 'nektarine', 'pflaume', 'kirsche', 'avocado', 'tomate', 'gurke', 'paprika', 'zucchini',
    'aubergine', 'karotte', 'möhre', 'kartoffel', 'zwiebel', 'knoblauch', 'salat', 'rucola', 'spinat', 'brokkoli',
    'blumenkohl', 'kohl', 'lauch', 'porree', 'sellerie', 'radieschen', 'pilze', 'champignon', 'ingwer', 'kräuter',
    'petersilie', 'schnittlauch', 'basilikum', 'dill', 'spargel', 'kürbis', 'fenchel', 'rote bete', 'granatapfel',
    'feigen', 'datteln', 'frühlingszwiebel', 'mais'],
  brot: ['brot', 'brötchen', 'semmel', 'toast', 'baguette', 'croissant', 'brezel', 'laugen', 'knäcke', 'ciabatta',
    'kuchen', 'wraps', 'tortilla', 'zwieback', 'muffin', 'berliner', 'bagel'],
  kuehl: ['milch', 'joghurt', 'jogurt', 'quark', 'käse', 'butter', 'sahne', 'schmand', 'crème fraîche',
    'creme fraiche', 'frischkäse', 'mozzarella', 'feta', 'parmesan', 'gouda', 'skyr', 'kefir', 'margarine', 'eier',
    '=ei', 'tofu', 'hummus', 'pudding', 'wurst', 'salami', 'schinken', 'aufschnitt', 'hefe', 'pesto', 'gnocchi',
    'maultaschen', 'tortellini', 'blätterteig', 'pizzateig', 'mascarpone', 'ricotta', 'halloumi'],
  fleisch: ['fleisch', 'hack', 'hähnchen', 'huhn', 'hühner', 'pute', 'rind', 'schwein', 'steak', 'schnitzel',
    'bratwurst', 'würstchen', 'speck', 'lachs', 'fisch', 'garnelen', 'shrimps', 'forelle', 'kotelett', 'gulasch',
    'geschnetzeltes', 'filet', 'lamm', 'ente', 'chicken', 'burger patties'],
  tk: ['tiefkühl', '=tk', 'pizza', '=eis', 'eiscreme', 'speiseeis', 'pommes', 'fischstäbchen', 'rahmspinat',
    'kroketten', 'gefroren', 'eiswürfel'],
  vorrat: ['nudel', 'spaghetti', 'penne', 'fusilli', 'pasta', 'lasagne', 'reis', 'mehl', 'zucker', 'salz',
    'pfeffer', 'gewürz', 'öl', 'essig', 'senf', 'ketchup', 'mayo', 'brühe', 'bouillon', 'dose', 'konserve',
    'passierte', 'tomatenmark', 'linsen', 'kichererbsen', 'couscous', 'bulgur', 'quinoa', 'backpulver',
    'vanillezucker', 'soße', 'sauce', 'thunfisch', 'kokosmilch', 'grieß', 'paniermehl', 'stärke', 'trockenhefe',
    'bohnen', 'erbsen', 'oliven'],
  fruehstueck: ['müsli', 'muesli', 'cornflakes', 'haferflocken', 'marmelade', 'konfitüre', 'honig', 'nutella',
    'nuss-nougat', 'kaffee', 'tee', 'kakao', 'espresso', 'sirup', 'erdnussbutter', 'porridge', 'granola'],
  suess: ['schokolade', 'schoko', 'chips', 'keks', 'gummibär', 'bonbon', 'süßigkeit', 'riegel', 'nüsse',
    'salzstangen', 'popcorn', 'cracker', 'lakritz', 'praline', 'waffel', 'studentenfutter', 'flips', 'kaugummi'],
  getraenke: ['wasser', 'sprudel', 'saft', 'limo', 'cola', 'fanta', 'sprite', 'bier', 'wein', 'sekt',
    'prosecco', 'schorle', 'eistee', 'energy', '=mate', 'smoothie', '=gin', 'wodka', 'whisky', '=rum', 'radler',
    'tonic', 'pfand'],
  drogerie: ['shampoo', 'duschgel', 'seife', 'zahnpasta', 'zahncreme', 'zahnbürste', 'zahnseide', 'deo',
    'sonnencreme', 'handcreme', 'bodylotion', 'lotion', 'rasier', 'klopapier', 'toilettenpapier', 'taschentücher',
    'tampons', 'binden', 'windeln', 'wattepads', 'wattestäbchen', 'pflaster', 'tabletten', 'spülung', 'haargel',
    'haarspray', 'kondome', 'feuchttücher', 'mundspülung', 'abschmink', 'gesichtscreme'],
  haushalt: ['spülmittel', 'spüli', 'spülmaschinen', 'tabs', 'waschmittel', 'weichspüler', 'müllbeutel',
    'mülltüten', 'küchenrolle', 'küchenpapier', 'alufolie', 'frischhaltefolie', 'backpapier', 'schwamm', 'lappen',
    'putzmittel', 'reiniger', 'entkalker', 'batterien', 'glühbirne', 'kerzen', 'teelicht', 'servietten',
    'gefrierbeutel', 'zewa', 'streichhölzer', 'feuerzeug', 'katzenfutter', 'hundefutter', 'katzenstreu',
    'blumenerde'],
};


/* ============================================================================
 *  3. Kleine Helfer
 * ========================================================================== */

/** Kurzform für document.getElementById – wird sehr oft gebraucht. */
const $ = (id) => document.getElementById(id);

/** Das <html>-Element (dort setzen wir CSS-Variablen wie --kb). */
const root = document.documentElement;

/**
 * Bequemer Zugriff auf den Browser-Speicher (localStorage).
 * - Werte werden automatisch als JSON gespeichert/gelesen.
 * - Alle Zugriffe sind in try/catch, weil localStorage z. B. im privaten
 *   Modus oder bei vollem Speicher Fehler wirft. Dann geht es eben ohne.
 */
const store = {
  /** Wert lesen; gibt "fallback" zurück, wenn nichts (Gültiges) da ist. */
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  /** Wert speichern. */
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* voll oder privat – egal */ }
  },
  /** Wert löschen. */
  del(key) {
    try { localStorage.removeItem(key); } catch { /* egal */ }
  },
};

/**
 * Macht Text sicher für HTML ("escapen").
 * Ohne das könnte ein Artikel namens "<script>…" Code in die Seite schmuggeln.
 * Beispiel: 'Tom & Jerry' -> 'Tom &amp; Jerry'
 */
function esc(text) {
  const replacements = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text ?? '').replace(/[&<>"']/g, (char) => replacements[char]);
}

/**
 * Erzeugt eine zufällige, eindeutige ID für neue Artikel.
 * Die App vergibt IDs selbst (nicht der Server), damit sie offline Artikel
 * anlegen und später sicher zuordnen kann.
 */
function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Ältere Browser: 16 Zufallsbytes als Hex-Text
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Aktuelle Zeit in Sekunden (so speichert auch der Server Zeiten). */
const now = () => Math.floor(Date.now() / 1000);

/** Kleinbuchstaben + ohne Rand-Leerzeichen – zum Vergleichen von Namen. */
const lower = (text) => text.toLocaleLowerCase('de').trim();

/** Erster Buchstabe groß: "milch" -> "Milch". */
const capitalize = (text) => text.charAt(0).toLocaleUpperCase('de') + text.slice(1);

/** Macht Sonderzeichen in einem Text für reguläre Ausdrücke harmlos. */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Mehrfache Leerzeichen zu einem zusammenfassen und Rand abschneiden. */
const squish = (text) => text.trim().replace(/\s+/g, ' ');

/**
 * Lässt das Handy kurz vibrieren (haptisches Feedback).
 * Zahl = Dauer in ms, Array = Muster [vibrieren, Pause, vibrieren, ...].
 * iPhones unterstützen das nicht – dann passiert einfach nichts.
 */
function vibrate(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* nicht unterstützt */ }
}

/** Zeitangabe als "vor 5 Min.", "gestern", ... */
function relTime(timestamp) {
  const secondsAgo = now() - timestamp;
  if (secondsAgo < 90)    return 'gerade eben';
  if (secondsAgo < 3600)  return `vor ${Math.round(secondsAgo / 60)} Min.`;
  if (secondsAgo < 86400) return `vor ${Math.round(secondsAgo / 3600)} Std.`;
  const days = Math.round(secondsAgo / 86400);
  return days === 1 ? 'gestern' : `vor ${days} Tagen`;
}

// ---------------------------------------------------------------------------
// Avatare (farbiger Kreis mit Anfangsbuchstaben)
// ---------------------------------------------------------------------------

/**
 * Feste Farbe pro Name: Aus den Buchstaben wird eine Zahl 0–359 berechnet,
 * die als Farbton dient. "Anna" ist dadurch auf jedem Gerät gleich gefärbt.
 */
function avatarColor(name) {
  let hue = 0;
  for (const char of lower(name || '?')) {
    hue = (hue * 31 + char.codePointAt(0)) % 360;
  }
  return `hsl(${hue} 55% 42%)`;
}

/** Erster Buchstabe groß. Array.from, damit auch Emojis als ein Zeichen zählen. */
const initial = (name) => Array.from(name || '?')[0].toLocaleUpperCase('de');

/**
 * HTML für einen Avatar. Die Farbe wird NICHT direkt eingesetzt, sondern
 * später per paintAvatars() – siehe dort, warum.
 */
function avatarHtml(name, extraClass = '') {
  return `<span class="avatar ${extraClass}" data-av="${esc(name)}" aria-hidden="true">${esc(initial(name))}</span>`;
}

/**
 * Färbt alle Avatare in einem Bereich ein.
 * Warum so umständlich? Die Sicherheitsregeln der Seite (Content-Security-Policy
 * in .htaccess) verbieten style="..." im HTML. Über JavaScript gesetzte
 * Styles sind aber erlaubt.
 */
function paintAvatars(container) {
  for (const el of container.querySelectorAll('[data-av]')) {
    el.style.setProperty('--av', avatarColor(el.dataset.av));
  }
}

/** Einen einzelnen, schon vorhandenen Avatar beschriften und färben. */
function setAvatar(el, name) {
  el.textContent = initial(name);
  el.style.setProperty('--av', avatarColor(name));
}

// ---------------------------------------------------------------------------
// Mengen-Erkennung in der Eingabe
// ---------------------------------------------------------------------------

/**
 * Erkannte Einheiten nach einer Zahl. Der senkrechte Strich "|" heißt "oder",
 * "?" heißt "optional" – "pck\.?" trifft also "pck" und "pck.".
 */
const UNIT_PATTERN =
  'x|×|stk\\.?|stück|g|gr|kg|ml|l|liter|pck\\.?|pckg\\.?|packung(?:en)?|dosen?|flaschen?|bund|becher|gläser|glas|netz|tüten?|kisten?|rollen?';

/**
 * Regulärer Ausdruck für "Menge am Anfang, dann Name":
 *   ^                     Anfang des Textes
 *   (\d+(?:[.,]\d+)?      eine Zahl, evtl. mit Komma ("2", "1,5")
 *    \s*(?:EINHEIT)?)     optional eine Einheit ("g", "x", "Pck.")
 *   \s+(.+)$              mind. ein Leerzeichen, dann der Rest = Name
 * "i" am Ende: Groß-/Kleinschreibung egal.
 */
const QUANTITY_RE = new RegExp(`^(\\d+(?:[.,]\\d+)?\\s*(?:${UNIT_PATTERN})?)\\s+(.+)$`, 'i');

/**
 * Trennt Menge und Name: "2 Milch" -> { quantity: "2", name: "Milch" }
 * Weitere Beispiele: "2x Milch", "500 g Hack", "1 Pck. Butter".
 * Ohne Menge: "Milch" -> { quantity: "", name: "Milch" }
 */
function parseInput(text) {
  const cleaned = squish(text);
  const match = cleaned.match(QUANTITY_RE);
  if (!match) return { quantity: '', name: cleaned };
  return { quantity: match[1].replace(/\s+/g, ' '), name: match[2].trim() };
}


/* ============================================================================
 *  4. Zustand der App
 * ============================================================================
 *
 * "state" enthält alles, was die App gerade weiß. Beim Start wird es aus dem
 * Browser-Speicher geladen – so ist die Liste sofort da, auch ohne Netz.
 */
const state = {
  items:        store.get(STORAGE_KEYS.items, []),                  // alle Artikel
  lists:        store.get(STORAGE_KEYS.lists, DEFAULT_LISTS),       // Einkaufslisten / Märkte
  activeList:   store.get(STORAGE_KEYS.activeList, DEFAULT_LIST_ID),// gewählte Liste
  categories:   store.get(STORAGE_KEYS.cats, DEFAULT_CATEGORIES),   // in Laden-Reihenfolge
  templates:    store.get(STORAGE_KEYS.templates, []),              // Vorlagen / Rezepte
  known:        store.get(STORAGE_KEYS.known, []),                  // bekannte Artikel
  outbox:       store.get(STORAGE_KEYS.outbox, []),                 // wartende Änderungen
  me:           store.get(STORAGE_KEYS.me, null),                   // { id, name, is_admin }
  online:       navigator.onLine,  // haben wir gerade Verbindung?
  loginVisible: false,             // wird gerade der Anmeldebildschirm gezeigt?
  rev:          null,              // letzter bekannter Server-Stand (siehe api.php, Abschnitt 4)
  serverIds:    null,              // Artikel-IDs vom letzten Abruf -> erkennt Neues von anderen
};

// Schnelles Nachschlagen bekannter Artikel: "milch" -> { name, category, uses }
let knownMap = new Map();

// Zählt lokale Änderungen. Damit erkennt refresh(), ob während einer
// laufenden Server-Abfrage lokal etwas geändert wurde (siehe dort).
let mutationSeq = 0;

// Kategorie für den nächsten neuen Artikel. "manual" = vom Benutzer gewählt
// (dann nicht mehr automatisch raten).
let composerCat = { id: 'sonstiges', manual: false };

// Zustände für Bedienung (werden in den Abschnitten 8–11 erklärt)
let renderTimer   = null;   // verzögertes Neuzeichnen
let renderPending = false;  // Neuzeichnen wurde während des Ziehens aufgeschoben
let press         = null;   // laufendes "langes Drücken"
let gripHold      = null;   // kurzes Halten auf dem Griff (Touch)
let drag          = null;   // laufendes Ziehen
let lastDragEnd   = 0;      // Zeitpunkt des letzten Ablegens
let armed         = null;   // Lösch-Knopf, der auf den zweiten Tipp wartet
let flushing      = false;  // wird die Outbox gerade gesendet?
let refreshing    = false;  // läuft gerade eine Abfrage?
let retryTimer    = null;   // geplanter neuer Versuch nach Fehler
let toastTimer    = null;   // automatisches Ausblenden der Meldung
let pollTimer     = null;   // adaptiver Abfrage-Timer
let lastActivity  = Date.now(); // letzte Benutzer-Interaktion (für adaptives Polling)

// Welche Wagen der ANDEREN wurden aufgeklappt? (Nur für diese Sitzung.)
const expandedCarts = new Set();

/** Aktive Liste (fällt sicher auf die erste verfügbare Liste zurück). */
function activeListId() {
  if (state.lists.some((l) => l.id === state.activeList)) return state.activeList;
  return state.lists[0]?.id || DEFAULT_LIST_ID;
}

/** Alle Artikel der aktuell gewählten Liste. */
function activeItems() {
  const listId = activeListId();
  return state.items.filter((item) => (item.list_id || DEFAULT_LIST_ID) === listId);
}

/** knownMap aus state.known neu aufbauen (nach dem Laden vom Server). */
function rebuildKnown() {
  knownMap = new Map(state.known.map((entry) => [lower(entry.name), entry]));
}
rebuildKnown();

function saveItems()  { store.set(STORAGE_KEYS.items, state.items); }
function saveOutbox() { store.set(STORAGE_KEYS.outbox, state.outbox); }

/** Artikel anhand der ID finden (oder undefined). */
const findItem = (id) => state.items.find((item) => item.id === id);

/** Bin das ich? (Vergleicht eine Benutzer-ID mit dem angemeldeten Benutzer.) */
const isMe = (userId) => !!state.me && userId === state.me.id;

/** Merkt sich, wer angemeldet ist, und zeigt den Avatar oben rechts. */
function setMe(me) {
  if (!me) return;
  state.me = me;
  store.set(STORAGE_KEYS.me, me);
  setAvatar($('headerAvatar'), me.name);
  $('settingsBtn').setAttribute('aria-label', `Einstellungen (${me.name})`);
}


/* ============================================================================
 *  5. Kategorien & Sortierung
 * ========================================================================== */

/** Platz einer Kategorie in der Laden-Reihenfolge (unbekannt = ganz hinten). */
function catIndex(id) {
  const index = state.categories.findIndex((c) => c.id === id);
  return index < 0 ? state.categories.length : index;
}

/** Kategorie-Objekt zu einer ID. Unbekannte IDs landen bei "Sonstiges". */
function catOf(id) {
  return state.categories.find((c) => c.id === id)
    || state.categories.find((c) => c.id === 'sonstiges')
    || FALLBACK_CATEGORY;
}

/** Sortier-Position eines Artikels. Ohne Position: ganz ans Ende. */
const posOf = (item) => (typeof item.position === 'number' ? item.position : Number.MAX_SAFE_INTEGER);

/**
 * Vergleichsfunktion zum Sortieren der Liste:
 *   1. nach Kategorie (in Laden-Reihenfolge)
 *   2. innerhalb der Kategorie nach Position (vom Verschieben)
 *   3. bei gleicher Position alphabetisch
 * Der "||"-Trick: Ist der erste Vergleich 0 (gleich), wird der nächste genommen.
 */
function sortItems(a, b) {
  return (catIndex(catOf(a.category).id) - catIndex(catOf(b.category).id))
    || (posOf(a) - posOf(b))
    || a.name.localeCompare(b.name, 'de', { sensitivity: 'base' });
}

/** Position am Ende einer Kategorie (für neue oder umsortierte Artikel). */
function nextPosition(category, listId = activeListId()) {
  let max = 0;
  for (const item of state.items) {
    if ((item.list_id || DEFAULT_LIST_ID) === listId && item.category === category && typeof item.position === 'number' && item.position > max) {
      max = item.position;
    }
  }
  return max + 1;
}

/**
 * Rät die Kategorie für einen Artikelnamen.
 *   1. Schon mal benutzt? -> Kategorie vom letzten Mal.
 *   2. Sonst: Stichwörter durchsuchen (Regeln siehe Abschnitt 2).
 *   3. Nichts gefunden? -> "Sonstiges".
 */
function guessCategory(name) {
  const key = lower(name);
  if (!key) return 'sonstiges';

  const known = knownMap.get(key);
  if (known) return catOf(known.category).id;

  let best = null; // bester Treffer bisher: { cat, end, length }
  for (const [cat, words] of Object.entries(KEYWORDS)) {
    for (const word of words) {
      const hit = findKeyword(key, word);
      if (hit && isBetterHit(hit, best)) {
        best = { cat, ...hit };
      }
    }
  }
  return best ? catOf(best.cat).id : 'sonstiges';
}

/**
 * Sucht ein Stichwort im Namen.
 * Gibt { end, length } zurück (wo der Treffer endet, wie lang er ist) oder null.
 */
function findKeyword(name, word) {
  // "=wort": nur als ganzes Wort
  if (word.startsWith('=')) {
    const needle = word.slice(1);
    // Vor dem Wort: Textanfang oder kein Buchstabe. Danach: kein Buchstabe oder Textende.
    // \p{L} = "irgendein Buchstabe" (auch Umlaute), braucht das "u"-Flag.
    const re = new RegExp(`(^|[^\\p{L}])${escapeRegExp(needle)}(?=[^\\p{L}]|$)`, 'u');
    const match = name.match(re);
    if (!match) return null;
    const start = match.index + match[1].length; // match[1] ist das Zeichen davor
    return { end: start + needle.length, length: needle.length };
  }

  // normales Stichwort: auch als Teilwort. lastIndexOf = letztes Vorkommen.
  const start = name.lastIndexOf(word);
  if (start < 0) return null;
  return { end: start + word.length, length: word.length };
}

/** Ist "hit" besser als "best"? Weiter hinten gewinnt, dann länger. */
function isBetterHit(hit, best) {
  if (!best) return true;
  if (hit.end !== best.end) return hit.end > best.end;
  return hit.length > best.length;
}

/**
 * Merkt sich einen Artikel lokal (wie remember_item in api.php), damit
 * Vorschläge und Kategorie-Raten sofort klappen – auch offline.
 * @param countUse true = Nutzungszähler erhöhen (beim Hinzufügen)
 */
function rememberLocal(name, category, countUse) {
  const key = lower(name);
  const entry = knownMap.get(key);
  if (entry) {
    entry.name = name;
    entry.category = category;
    if (countUse) entry.uses += 1;
  } else {
    const newEntry = { name, category, uses: 1 };
    state.known.push(newEntry);
    knownMap.set(key, newEntry);
  }
  store.set(STORAGE_KEYS.known, state.known);
}


/* ============================================================================
 *  6. Server-Kommunikation & Synchronisation
 * ========================================================================== */

/**
 * Schickt eine Anfrage an api.php und liefert die JSON-Antwort.
 *
 * @param method "GET" | "POST" | "PUT" | "DELETE"
 * @param query  z. B. "?id=abc" oder "?action=login"
 * @param body   optional: Daten, die als JSON mitgeschickt werden
 *
 * Fehler werden als Error geworfen, mit zusätzlichem Feld "status":
 *   status 0   = keine Verbindung (offline, Zeitüberschreitung)
 *   status 401 = nicht (mehr) angemeldet
 *   sonst      = HTTP-Status vom Server; die Meldung kommt aus { error: "…" }
 */
async function api(method, query = '', body) {
  const options = buildRequestOptions(method, body);

  // Zeitlimit: Nach REQUEST_TIMEOUT_MS wird die Anfrage abgebrochen.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  options.signal = controller.signal;

  let response;
  try {
    response = await fetch(API_URL + query, options);
  } catch {
    // fetch wirft nur bei Netzwerkproblemen (oder Abbruch), nicht bei 404/500.
    throw httpError('Keine Verbindung zum Server', 0);
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = await response.json(); } catch { /* Antwort war kein JSON */ }

  if (!response.ok) {
    throw httpError((data && data.error) || `Fehler ${response.status}`, response.status, data);
  }
  return data;
}

/** Baut die Einstellungen für fetch() zusammen. */
function buildRequestOptions(method, body) {
  const headers = { Accept: 'application/json' };
  let httpMethod = method;

  // Notlösung für Hoster, die PUT/DELETE blockieren (siehe USE_METHOD_OVERRIDE)
  if (USE_METHOD_OVERRIDE && (method === 'PUT' || method === 'DELETE')) {
    headers['X-HTTP-Method-Override'] = method;
    httpMethod = 'POST';
  }

  const options = {
    method: httpMethod,
    headers,
    credentials: 'same-origin', // Login-Cookie mitschicken
    cache: 'no-store',          // nie aus dem Browser-Cache antworten
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'; // verlangt api.php (CSRF-Schutz)
    options.body = JSON.stringify(body);
  }
  return options;
}

/** Erzeugt einen Fehler mit HTTP-Status (und optional den Antwortdaten). */
function httpError(message, status, data = null) {
  const err = new Error(message);
  err.status = status;
  err.data = data;
  return err;
}

// ---------------------------------------------------------------------------
// Outbox (Warteschlange für Änderungen)
// ---------------------------------------------------------------------------
//
// Jede Änderung ist ein kleines Objekt ("op" = Operation), z. B.
//   { type: 'update', id: 'abc', data: { checked: true } }
// Mögliche Typen: create, update, delete, clear (Wagen leeren), catorder.

/** Neue Änderung in die Warteschlange legen und sofort zu senden versuchen. */
function enqueue(op) {
  mutationSeq++;
  state.outbox.push(op);
  saveOutbox();
  renderSync();
  flush();
}

/** Übersetzt eine Änderung in die passende Server-Anfrage. */
function sendOp(op) {
  const idQuery = op.id ? `?id=${encodeURIComponent(op.id)}` : '';
  switch (op.type) {
    case 'create':   return api('POST', '', op.data);
    case 'update':   return api('PUT', idQuery, op.data);
    case 'delete':   return api('DELETE', idQuery);
    case 'clear':    return api('DELETE', clearQuery(op.by, op.listId));
    case 'catorder': return api('PUT', '?action=categories', op.data);
    case 'reorder':  return api('PUT', '?action=reorder', op.data);
    default:         return Promise.resolve(); // unbekannt -> einfach überspringen
  }
}

/** URL zum Wagen-Leeren: ohne Person = alle abgehakten, sonst nur deren Wagen. */
function clearQuery(by, listId) {
  const params = ['checked=1'];
  if (by !== undefined) params.push(`checked_by=${encodeURIComponent(by)}`);
  if (listId) params.push(`list_id=${encodeURIComponent(listId)}`);
  return `?${params.join('&')}`;
}

/**
 * Sendet die Outbox der Reihe nach an den Server.
 * Reihenfolge ist wichtig (erst "anlegen", dann "abhaken"), deshalb wird
 * immer nur die vorderste Änderung geschickt und erst nach Erfolg entfernt.
 */
async function flush() {
  // Läuft schon, oder Anmeldung offen? Dann nichts tun.
  if (flushing || state.loginVisible) return;
  flushing = true;
  try {
    while (state.outbox.length) {
      const op = state.outbox[0];
      try {
        await sendOp(op);
        setOnline(true);
      } catch (err) {
        const verdict = judgeSendError(op, err);
        if (verdict === 'login') { needLogin(); return; }
        if (verdict === 'retry') {
          if (err.status === 0) setOnline(false);
          saveOutbox();      // erhöhten Versuchszähler merken
          scheduleRetry();
          return;            // Rest bleibt in der Warteschlange
        }
        // verdict === 'drop': Änderung ist nicht zu retten -> verwerfen und Stand neu laden
        console.warn('Änderung verworfen:', op, err.message);
        state.rev = null;
      }
      state.outbox.shift(); // vorderste Änderung ist erledigt
      saveOutbox();
    }
  } finally {
    flushing = false;
    renderSync();
  }
}

/**
 * Was tun, wenn das Senden einer Änderung fehlschlägt?
 *   'login' – nicht angemeldet: Anmeldebildschirm zeigen
 *   'drop'  – sinnlos, es nochmal zu versuchen (z. B. Artikel wurde auf einem
 *             anderen Gerät schon gelöscht) oder Server dauerhaft kaputt
 *   'retry' – vorübergehendes Problem (offline, Server überlastet): später nochmal
 */
function judgeSendError(op, err) {
  if (err.status === 401) return 'login';

  op.tries = (op.tries || 0) + 1;

  // 4xx = "deine Anfrage ist falsch" -> wird auch beim 2. Mal falsch sein.
  // Ausnahmen: 408 (Zeitüberschreitung) und 429 (zu viele Anfragen) sind vorübergehend.
  const isClientError = err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
  // 5xx = Serverfehler -> ein paar Mal wiederholen, dann aufgeben.
  const serverGaveUp = err.status >= 500 && op.tries >= MAX_SERVER_RETRIES;

  return (isClientError || serverGaveUp) ? 'drop' : 'retry';
}

/** Plant einen neuen Versuch in RETRY_MS (aber nie mehrere gleichzeitig). */
function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; refresh(); }, RETRY_MS);
}

// ---------------------------------------------------------------------------
// Abfragen: neue Daten vom Server holen
// ---------------------------------------------------------------------------

/**
 * Holt den aktuellen Stand vom Server (wird alle POLL_MS aufgerufen).
 * Vorher werden eigene wartende Änderungen gesendet – sonst würde die Antwort
 * sie überschreiben und sie wären kurz "verschwunden".
 */
async function refresh() {
  if (state.loginVisible || refreshing) return;

  if (state.outbox.length) {
    await flush();
    if (state.outbox.length) return; // konnte nicht alles senden -> später
  }

  refreshing = true;
  const seqAtStart = mutationSeq;
  try {
    const query = state.rev !== null ? `?since=${state.rev}` : '';
    const data = await api('GET', query);
    setOnline(true);
    setMe(data.me);
    if (data.unchanged) return;

    // Hat der Benutzer WÄHREND der Anfrage etwas geändert, ist die Antwort
    // schon veraltet. Dann verwerfen – beim nächsten Durchlauf kommt eine frische.
    if (seqAtStart !== mutationSeq || state.outbox.length) return;

    applyServerData(data);
  } catch (err) {
    if (err.status === 401) needLogin();
    else if (err.status === 0) setOnline(false);
  } finally {
    refreshing = false;
  }
}

/** Übernimmt eine vollständige Antwort des Servers in den Zustand und zeichnet neu. */
function applyServerData(data) {
  const items = data.items || [];

  // Neue Artikel von anderen Familienmitgliedern? Dann kurz Bescheid geben.
  const fresh = findFreshFromOthers(items);
  if (fresh.length) notifyFresh(fresh);

  state.rev = data.rev;
  state.serverIds = new Set(items.map((item) => item.id));
  state.items = items;
  state.lists = (data.lists && data.lists.length) ? data.lists : DEFAULT_LISTS;
  if (!state.lists.some((l) => l.id === state.activeList)) {
    state.activeList = state.lists[0].id;
    store.set(STORAGE_KEYS.activeList, state.activeList);
  }
  state.categories = (data.categories && data.categories.length) ? data.categories : DEFAULT_CATEGORIES;
  state.templates = data.templates || [];
  state.known = data.known || [];
  rebuildKnown();

  // Alles für den nächsten Start (oder offline) speichern
  saveItems();
  store.set(STORAGE_KEYS.lists, state.lists);
  store.set(STORAGE_KEYS.cats, state.categories);
  store.set(STORAGE_KEYS.templates, state.templates);
  store.set(STORAGE_KEYS.known, state.known);

  render();
  updateComposerCat();
  if ($('settingsSheet').open) {
    renderCatOrder();
    renderListsManage();
    renderKnownList();
  }
  if ($('templatesSheet').open) renderTemplates();
}

/**
 * Welche Artikel sind seit dem letzten Abruf neu UND von jemand anderem?
 * Beim allerersten Abruf (serverIds noch leer) melden wir nichts – sonst
 * käme beim Öffnen der App eine Meldung über die ganze Liste.
 */
function findFreshFromOthers(items) {
  const previousIds = state.serverIds;
  if (!previousIds || !state.me) return [];
  const localIds = new Set(state.items.map((item) => item.id));

  return items.filter((item) =>
    !item.checked                    // noch zu kaufen
    && !previousIds.has(item.id)     // war beim letzten Abruf nicht da
    && !localIds.has(item.id)        // haben wir nicht selbst gerade angelegt
    && item.created_by               // Ersteller bekannt ...
    && item.created_by !== state.me.id); // ... und nicht ich
}

/** Meldung "Ben hat hinzugefügt: Milch, Brot" + Hervorheben. */
function notifyFresh(fresh) {
  const who   = [...new Set(fresh.map((item) => item.created_by_name || 'Jemand'))].join(' & ');
  const names = fresh.slice(0, 3).map((item) => item.name).join(', ');
  const more  = fresh.length > 3 ? ` und ${fresh.length - 3} weitere` : '';
  toast(`${who} hat hinzugefügt: ${names}${more}`, 'Zeigen', () => highlight(fresh[0].id), 6000);
  vibrate([30, 60, 30]);
  // Kurz warten, bis die Liste neu gezeichnet ist, dann die neuen Zeilen aufleuchten lassen
  setTimeout(() => fresh.forEach((item) => highlight(item.id, false)), 50);
}

/** Online-Status merken und den Sync-Punkt oben aktualisieren. */
function setOnline(isOnline) {
  if (state.online === isOnline) return;
  state.online = isOnline;
  renderSync();
}


/* ============================================================================
 *  7. Aktionen
 * ============================================================================
 *
 * Jede Aktion folgt demselben Muster:
 *   1. lokalen Zustand ändern
 *   2. speichern (saveItems)
 *   3. Änderung in die Outbox (enqueue)
 *   4. vibrieren + neu zeichnen
 */

/** Neu zeichnen, aber erst in "ms" Millisekunden (für kleine Animationen). */
function renderSoon(ms) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, ms);
}

/**
 * Artikel hinzufügen. Drei Fälle:
 *   a) Steht schon (offen) auf der Liste -> fragen: überschreiben oder nochmal hinzufügen
 *   b) Steht abgehakt im Wagen          -> wieder auf die Liste holen
 *   c) Ganz neu                          -> anlegen
 */
function addItem(name, quantity, category, note = '', mode = 'ask') {
  name = capitalize(squish(name));
  quantity = squish(quantity || '');
  note = squish(note || '');
  if (!name) return;
  if (name.length > NAME_MAX) {
    toast(`Name ist zu lang (max. ${NAME_MAX} Zeichen)`);
    return;
  }
  if (quantity.length > QTY_MAX) {
    toast(`Menge ist zu lang (max. ${QTY_MAX} Zeichen)`);
    return;
  }
  if (note.length > NOTE_MAX) {
    toast(`Notiz ist zu lang (max. ${NOTE_MAX} Zeichen)`);
    return;
  }

  const listId = activeListId();
  const existing = activeItems().find((item) => !item.checked && lower(item.name) === lower(name));
  if (existing) {
    if (mode === 'merge') {
      mergeExisting(existing, quantity, category, note);
      return;
    }
    if (mode === 'add') {
      createItem(name, quantity, category, note, listId);
      return;
    }
    if (mode === 'overwrite') {
      overwriteExisting(existing, quantity, category, note);
      return;
    }
    if (mode === 'skip') return;
    askDuplicateSingle(existing, { name, quantity, category, note, listId });
    return;
  }

  const inCart = activeItems().find((item) => item.checked && lower(item.name) === lower(name));
  if (inCart) return reactivate(inCart, quantity, category, note);
  createItem(name, quantity, category, note, listId);
}

/** Formatiert eine Zahl deutsch ("7", "1,5") ohne Rundungs-Artefakte. */
function formatNum(n) {
  const rounded = Math.round(n * 1000) / 1000;
  return String(rounded).replace('.', ',');
}

/** Zerlegt eine Mengenangabe ("500 g", "2", "1,5 l") in Zahl + Einheit. */
function parseQty(raw) {
  const text = squish(raw || '');
  if (!text) return { amount: 1, unit: '', implicit: true };
  const m = text.match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (!m) return null;
  const amount = parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(amount)) return null;
  return { amount, unit: m[2].trim(), implicit: false };
}

/**
 * Addiert zwei Mengenangaben intelligent:
 *   "5" + "2"         -> "7"
 *   "" + "2"          -> "3" (ohne Menge zählt als 1)
 *   "500 g" + "500 g" -> "1 kg"
 *   "500 ml" + "1 l"  -> "1,5 l"
 *   "2 Pck." + "1 Pck." -> "3 Pck."
 *   Unterschiedliche Einheiten -> "500 g + 1 Pck."
 */
function addQuantities(curRaw, addRaw) {
  const a = parseQty(curRaw);
  const b = parseQty(addRaw);
  if (!a || !b) {
    const joined = [squish(curRaw || ''), squish(addRaw || '')].filter(Boolean).join(' + ');
    return joined.slice(0, QTY_MAX);
  }

  const norm = (u) => {
    const low = u.toLocaleLowerCase('de').replace(/\.$/, '');
    if (low === '' || low === 'x' || low === '×' || low === 'stk' || low === 'stück') return 'count';
    if (low === 'g' || low === 'gr') return 'g';
    if (low === 'kg') return 'kg';
    if (low === 'ml') return 'ml';
    if (low === 'l' || low === 'liter') return 'l';
    return low;
  };

  const ua = norm(a.unit);
  const ub = norm(b.unit);

  // Gewicht (g / kg)
  if ((ua === 'g' || ua === 'kg') && (ub === 'g' || ub === 'kg')) {
    const grams = (ua === 'kg' ? a.amount * 1000 : a.amount) + (ub === 'kg' ? b.amount * 1000 : b.amount);
    return grams >= 1000 ? `${formatNum(grams / 1000)} kg` : `${formatNum(grams)} g`;
  }

  // Volumen (ml / l)
  if ((ua === 'ml' || ua === 'l') && (ub === 'ml' || ub === 'l')) {
    const ml = (ua === 'l' ? a.amount * 1000 : a.amount) + (ub === 'l' ? b.amount * 1000 : b.amount);
    return ml >= 1000 ? `${formatNum(ml / 1000)} l` : `${formatNum(ml)} ml`;
  }

  // Gleiche Einheit (oder beides Stückzahl)
  if (ua === ub) {
    const sum = a.amount + b.amount;
    if (ua === 'count') {
      const unitLabel = a.unit || b.unit;
      return unitLabel && (unitLabel === 'x' || unitLabel === '×')
        ? `${formatNum(sum)}${unitLabel}`
        : (unitLabel ? `${formatNum(sum)} ${unitLabel}` : formatNum(sum));
    }
    const unitLabel = a.unit || b.unit;
    return `${formatNum(sum)} ${unitLabel}`.trim();
  }

  // Eine Seite war leer (implizit 1) und die andere hat eine Einheit -> Einheit übernehmen
  if (a.implicit && !b.implicit) return `${formatNum(1 + b.amount)} ${b.unit}`.trim();
  if (b.implicit && !a.implicit) return `${formatNum(a.amount + 1)} ${a.unit}`.trim();

  // Unterschiedliche Einheiten -> kombinieren
  return `${squish(curRaw)} + ${squish(addRaw)}`.slice(0, QTY_MAX);
}

/** Addiert Menge (und ggf. Notiz) zu einem bestehenden offenen Artikel. */
function mergeExisting(item, quantity, category, note = '') {
  const newQty = addQuantities(item.quantity, quantity);
  const changes = { quantity: newQty };
  if (note && note !== (item.note || '')) {
    changes.note = item.note ? `${item.note} · ${note}`.slice(0, NOTE_MAX) : note;
  }
  updateItem(item.id, changes);
  vibrate(10);
  highlight(item.id);
}

/** Bestehenden offenen Artikel mit neuen Angaben überschreiben. */
function overwriteExisting(item, quantity, category, note = '') {
  const changes = {};
  if (quantity !== (item.quantity || '')) changes.quantity = quantity;
  if (note !== (item.note || '')) changes.note = note;
  if (category && category !== item.category) {
    changes.category = category;
    changes.position = nextPosition(category, item.list_id || DEFAULT_LIST_ID);
  }
  if (Object.keys(changes).length) {
    updateItem(item.id, changes);
    if (changes.category) rememberLocal(item.name, category, false);
  }
  vibrate(10);
  highlight(item.id);
}

// ---------------------------------------------------------------------------
// Nachfrage-Dialog bei doppelten Artikeln (Eingabe & Vorlagen)
// ---------------------------------------------------------------------------

let dupHandler = null;

/** Öffnet den Nachfrage-Dialog "Schon auf der Liste". */
function openDupDialog({ desc, addLabel = 'Mengen addieren', showSkip = false, onOverwrite, onAddAgain, onSkip }) {
  dupHandler = { onOverwrite, onAddAgain, onSkip };
  $('dupDesc').textContent = desc;
  $('dupAddAgain').textContent = addLabel;
  $('dupSkip').hidden = !showSkip;
  $('dupSheet').showModal();
}

$('dupOverwrite').addEventListener('click', () => {
  const fn = dupHandler?.onOverwrite;
  dupHandler = null;
  $('dupSheet').close();
  if (fn) fn();
});

$('dupAddAgain').addEventListener('click', () => {
  const fn = dupHandler?.onAddAgain;
  dupHandler = null;
  $('dupSheet').close();
  if (fn) fn();
});

$('dupSkip').addEventListener('click', () => {
  const fn = dupHandler?.onSkip;
  dupHandler = null;
  $('dupSheet').close();
  if (fn) fn();
});

/** Nachfrage für einen einzelnen Artikel aus der Eingabeleiste. */
function askDuplicateSingle(existing, incoming) {
  const curInfo = [existing.quantity, existing.note].filter(Boolean).join(' · ');
  const newInfo = [incoming.quantity, incoming.note].filter(Boolean).join(' · ');
  const mergedQty = addQuantities(existing.quantity, incoming.quantity);
  const lines = [
    `„${existing.name}“ steht schon auf der Liste${curInfo ? ` (${curInfo})` : ''}.`,
  ];
  if (newInfo && newInfo !== curInfo) lines.push(`Neue Eingabe: ${newInfo}`);

  openDupDialog({
    desc: lines.join('\n'),
    addLabel: `Addieren (→ ${mergedQty})`,
    showSkip: false,
    onOverwrite: () => {
      overwriteExisting(existing, incoming.quantity, incoming.category, incoming.note);
      toast(`„${existing.name}“ überschrieben`);
    },
    onAddAgain: () => {
      mergeExisting(existing, incoming.quantity, incoming.category, incoming.note);
      toast(`„${existing.name}“ auf ${mergedQty} erhöht`);
    },
  });
}

/** Fall b) Abgehakten Artikel wieder auf die Liste holen (statt Dublette). */
function reactivate(item, quantity, category, note = '') {
  const changes = { checked: false, category };
  // Neue Kategorie? Dann ans Ende dieser Kategorie.
  if (category !== item.category) changes.position = nextPosition(category, item.list_id || DEFAULT_LIST_ID);
  if (quantity) changes.quantity = quantity;
  if (note) changes.note = note;

  // Lokal sofort aus dem Wagen nehmen (der Server macht das beim checked:false selbst)
  item.checked_by = null;
  item.checked_by_name = null;
  item.checked_at = null;

  updateItem(item.id, changes);
  rememberLocal(item.name, category, true);
  vibrate(10);
  highlight(item.id);
}

/** Fall c) Neuen Artikel anlegen. */
function createItem(name, quantity, category, note = '', listId = activeListId()) {
  const timestamp = now();
  const me = state.me || {};
  const item = {
    id: uid(),
    name,
    quantity: quantity || '',
    note: note || '',
    category,
    list_id: listId,
    checked: false,
    position: nextPosition(category, listId),
    created_at: timestamp,
    updated_at: timestamp,
    created_by: me.id ?? null,
    created_by_name: me.name ?? null,
    checked_by: null,
    checked_by_name: null,
    checked_at: null,
  };

  state.items.push(item);
  saveItems();
  rememberLocal(name, category, true);
  enqueue({
    type: 'create',
    id: item.id,
    data: { id: item.id, name, quantity: item.quantity, note: item.note, category, list_id: listId, position: item.position },
  });
  vibrate(10);
  render();
  highlight(item.id);
}

/** Einzelne Felder eines Artikels ändern, z. B. updateItem(id, { quantity: '2' }). */
function updateItem(id, changes) {
  const item = findItem(id);
  if (!item) return;
  Object.assign(item, changes, { updated_at: now() });
  saveItems();
  enqueue({ type: 'update', id, data: changes });
  render();
}

/**
 * Abhaken bzw. Haken zurücknehmen.
 * @param row Die angetippte Zeile – für eine kurze Abhak-Animation, bevor
 *            der Artikel in den Wagen rutscht.
 */
function toggleItem(id, row) {
  const item = findItem(id);
  if (!item) return;

  const nowChecked = !item.checked;
  const me = state.me || {};
  Object.assign(item, {
    checked: nowChecked,
    checked_by: nowChecked ? me.id ?? null : null,
    checked_by_name: nowChecked ? me.name ?? null : null,
    checked_at: nowChecked ? now() : null,
    updated_at: now(),
  });
  saveItems();
  enqueue({ type: 'update', id, data: { checked: nowChecked } });

  vibrate(nowChecked ? 15 : 8);
  if (row) {
    // Erst sichtbar durchstreichen ("is-checking"), kurz danach neu einsortieren
    row.classList.toggle('is-checking', nowChecked);
    row.classList.toggle('is-checked', false);
  }
  renderSoon(nowChecked ? 280 : 120);
}

/** Artikel löschen – mit "Rückgängig" in der Meldung. */
function deleteItem(id) {
  const item = findItem(id);
  if (!item) return;
  state.items = state.items.filter((i) => i.id !== id);
  saveItems();
  enqueue({ type: 'delete', id });
  vibrate([20, 30, 20]);
  render();
  toast(`„${item.name}“ gelöscht`, 'Rückgängig', () => restoreItems([item]), TOAST_UNDO_MS);
}

// ---------------------------------------------------------------------------
// Einkaufswagen (jede Person hat einen eigenen)
// ---------------------------------------------------------------------------

/**
 * Zu welchem Wagen gehört ein abgehakter Artikel?
 * Zur Person, die ihn abgehakt hat. 0 = unbekannt (Einträge aus älteren Versionen).
 */
const cartKey = (item) => item.checked_by ?? 0;

/** Überschrift eines Wagens: "Dein Wagen", "Wagen von Ben" oder "Im Wagen". */
function cartLabel(by, items) {
  if (isMe(by)) return 'Dein Wagen';
  if (!by) return 'Im Wagen';
  return `Wagen von ${items[0].checked_by_name || 'jemand'}`;
}

/** Einen Wagen leeren – nur die Artikel dieser einen Person in der aktuellen Liste. */
function clearCart(by) {
  const listId = activeListId();
  const inThisCart = (item) => item.checked && cartKey(item) === by && (item.list_id || DEFAULT_LIST_ID) === listId;
  const removed = state.items.filter(inThisCart);
  if (!removed.length) return;

  const label = cartLabel(by, removed);
  state.items = state.items.filter((item) => !inThisCart(item));
  saveItems();
  enqueue({ type: 'clear', by, listId });
  vibrate([20, 30, 20]);
  render();
  toast(`${label} geleert (${removed.length})`, 'Rückgängig', () => restoreItems(removed), TOAST_UNDO_MS);
}

/**
 * "Rückgängig": gelöschte Artikel wiederherstellen.
 * Wir schicken sie als "create" mit ihrer alten ID. Der Server legt sie
 * dadurch genau so wieder an (Upsert, siehe api.php create_item).
 */
function restoreItems(items) {
  for (const item of items) {
    if (findItem(item.id)) continue; // ist schon wieder da
    state.items.push(item);
    enqueue({
      type: 'create',
      id: item.id,
      data: {
        id: item.id,
        name: item.name,
        quantity: item.quantity,
        note: item.note || '',
        category: item.category,
        list_id: item.list_id || DEFAULT_LIST_ID,
        checked: item.checked,
        position: item.position,
        // Ursprüngliche Personen mitschicken – sonst landet z. B. Bens Wagen
        // nach "Rückgängig" im eigenen. (undefined = Feld wird weggelassen)
        created_by: item.created_by ?? undefined,
        checked_by: item.checked_by ?? undefined,
        checked_at: item.checked_at ?? undefined,
      },
    });
  }
  saveItems();
  vibrate(10);
  render();
}

/** Kategorien (inkl. Reihenfolge) speichern und senden. */
function saveCategories(full = false) {
  store.set(STORAGE_KEYS.cats, state.categories);

  state.outbox = state.outbox.filter((op, index) =>
    op.type !== 'catorder' || (flushing && index === 0));

  const payload = full
    ? { categories: state.categories }
    : { order: state.categories.map((c) => c.id) };
  enqueue({ type: 'catorder', data: payload });
  render();
}


/* ============================================================================
 *  8. Anzeige
 * ========================================================================== */

// Kleine Symbole als SVG (Vektorgrafik direkt im Code – keine Bilddateien nötig)
const ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
const ICON_UP    = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
const ICON_DOWN  = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const ICON_GRIP  = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>';

/** "dir" für den eigenen Account (liest sich besser: "von dir"), sonst der Name. */
function personName(userId, name) {
  if (!name) return '';
  return isMe(userId) ? 'dir' : name;
}

/**
 * HTML für eine Artikel-Zeile.
 *
 * Aufbau:  [✓ Name  Menge · von Anna]  [⠿ Griff]  [🗑 Löschen?]
 *
 * @param inCart true = Zeile steht in einem Wagen: dann mit Kategorie-Emoji,
 *               aber ohne Griff (abgehakte Artikel verschiebt man nicht).
 */
function itemHtml(item, inCart) {
  const catEmoji = inCart ? `<span class="item__cat" aria-hidden="true">${esc(catOf(item.category).emoji)}</span>` : '';

  // Unterzeile: Menge und Ersteller, getrennt durch " · "
  const subParts = [];
  if (item.quantity) subParts.push(`<span class="item__amount">${esc(item.quantity)}</span>`);
  const creator = personName(item.created_by, item.created_by_name);
  if (creator) subParts.push(`<span>von ${esc(creator)}</span>`);
  // (Wer abgehakt hat, steht in der Wagen-Überschrift und im Bearbeiten-Dialog.)
  const subLine = subParts.length
    ? `<span class="item__qty">${subParts.join('<span class="dot"> · </span>')}</span>`
    : '';
  const noteLine = item.note ? `<span class="item__note">${esc(item.note)}</span>` : '';

  const grip = inCart ? '' : `<button class="item__grip" type="button" aria-label="${esc(item.name)} verschieben">${ICON_GRIP}</button>`;

  // "Löschen?" ist erst sichtbar, wenn der Knopf "scharf" ist (erster Tipp, siehe Abschnitt 10)
  return `<div class="item${item.checked ? ' is-checked' : ''}" data-id="${esc(item.id)}">
    <button class="item__toggle" type="button" aria-pressed="${item.checked}">
      <span class="check">${ICON_CHECK}</span>
      <span class="item__text"><span class="item__name">${esc(item.name)}${catEmoji}</span>${noteLine}${subLine}</span>
    </button>
    ${grip}
    <button class="item__del" type="button" aria-label="${esc(item.name)} löschen">${ICON_TRASH}<span class="del-label">Löschen?</span></button>
  </div>`;
}

/**
 * Zeichnet die komplette Liste neu.
 * Aufbau von oben nach unten:
 *   - Listen-Tabs (falls mehrere Listen existieren)
 *   - eine Gruppe pro Kategorie mit den offenen Artikeln
 *   - darunter ein "Wagen" pro Person mit den abgehakten Artikeln
 */
function render() {
  clearTimeout(renderTimer);

  // Während ein Artikel gezogen wird, NICHT neu zeichnen – sonst verschwindet
  // die Zeile unter dem Finger. Wird nach dem Ablegen nachgeholt.
  if (drag) { renderPending = true; return; }
  renderPending = false;

  renderListTabs();

  const currentItems = activeItems();
  const open = currentItems.filter((item) => !item.checked).sort(sortItems);
  const done = currentItems.filter((item) => item.checked).sort(sortItems);

  $('list').innerHTML = categoryGroupsHtml(open) + cartsHtml(done);
  paintAvatars($('list'));
  applyArmed(); // ein "scharfer" Lösch-Knopf soll nach dem Neuzeichnen scharf bleiben

  $('empty').hidden = currentItems.length > 0;
  $('hint').hidden = currentItems.length === 0 || store.get(STORAGE_KEYS.hintDone, false);
  $('counter').textContent = counterText(open, done);

  renderSync();
  renderSuggestions();
}

/** Zeigt die Listen-Leiste an, sobald es mindestens 2 Listen gibt. */
function renderListTabs() {
  const nav = $('listTabs');
  const currentId = activeListId();
  const currentList = state.lists.find((l) => l.id === currentId);
  $('topbarTitle').textContent = currentList ? currentList.name : 'Einkauf';

  if (state.lists.length <= 1) {
    nav.hidden = true;
    nav.innerHTML = '';
    return;
  }

  nav.hidden = false;
  nav.innerHTML = state.lists.map((l) => {
    const openCount = state.items.filter((i) => !i.checked && (i.list_id || DEFAULT_LIST_ID) === l.id).length;
    const active = l.id === currentId;
    return `<button type="button" class="list-tab${active ? ' is-active' : ''}" data-list="${esc(l.id)}" aria-pressed="${active}">
      <span aria-hidden="true">${esc(l.emoji)}</span><span>${esc(l.name)}</span>${openCount ? `<span class="list-tab__n">${openCount}</span>` : ''}
    </button>`;
  }).join('');
}

$('listTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-list]');
  if (!btn) return;
  const id = btn.dataset.list;
  if (id === activeListId()) return;
  state.activeList = id;
  store.set(STORAGE_KEYS.activeList, id);
  disarm();
  vibrate(8);
  render();
});

/**
 * Eine Gruppe pro Kategorie. Auch LEERE Kategorien werden erzeugt (mit Klasse
 * "group--empty"): Normal sind sie per CSS unsichtbar, aber beim Ziehen werden
 * sie eingeblendet, damit man Artikel auch in leere Kategorien legen kann.
 */
function categoryGroupsHtml(openItems) {
  let html = '';
  for (const cat of state.categories) {
    const items = openItems.filter((item) => catOf(item.category).id === cat.id);
    html += `<section class="group${items.length ? '' : ' group--empty'}" data-cat="${esc(cat.id)}">
      <h2 class="group__head"><span aria-hidden="true">${esc(cat.emoji)}</span>${esc(cat.label)}<span class="n">${items.length || ''}</span></h2>
      <div class="group__items">${items.map((item) => itemHtml(item, false)).join('')}</div>
    </section>`;
  }
  return html;
}

/**
 * Ein Wagen pro Person: der eigene zuerst (immer aufgeklappt), dann die der
 * anderen alphabetisch (zugeklappt, per Tipp aufklappbar), zuletzt "ohne Person".
 */
function cartsHtml(doneItems) {
  const carts = groupByCart(doneItems);
  return sortedCartKeys(carts)
    .map((by) => cartHtml(by, carts.get(by)))
    .join('');
}

/** Sortiert abgehakte Artikel in Wagen: Map { personId => [Artikel, ...] }. */
function groupByCart(doneItems) {
  const carts = new Map();
  for (const item of doneItems) {
    const key = cartKey(item);
    if (!carts.has(key)) carts.set(key, []);
    carts.get(key).push(item);
  }
  return carts;
}

/** Reihenfolge der Wagen: meiner -> andere nach Name -> unbekannte Person. */
function sortedCartKeys(carts) {
  const nameOf = (by) => carts.get(by)[0].checked_by_name || '';
  return [...carts.keys()].sort((a, b) => {
    if (isMe(a)) return -1;
    if (isMe(b)) return 1;
    if (!a) return 1;   // 0 = unbekannt -> nach hinten
    if (!b) return -1;
    return nameOf(a).localeCompare(nameOf(b), 'de');
  });
}

/** HTML für einen einzelnen Wagen. */
function cartHtml(by, items) {
  const mine = isMe(by);
  const isOpen = mine || expandedCarts.has(by);
  const ownerName = items[0].checked_by_name;

  // Symbol: Avatar der Person, beim eigenen oder unbekannten Wagen ein 🛒
  const icon = (by && !mine)
    ? avatarHtml(ownerName || '?', 'avatar--xs')
    : '<span aria-hidden="true">🛒</span>';
  const chevron = mine ? '' : '<span class="chev" aria-hidden="true">▾</span>';

  const classes = ['group', 'group--done', 'group--cart'];
  if (mine) classes.push('group--mine');
  if (!isOpen) classes.push('is-collapsed');

  return `<section class="${classes.join(' ')}" data-by="${by}">
      <h2 class="group__head">
        <button type="button" class="group__toggle" data-act="toggle-cart" data-by="${by}" aria-expanded="${isOpen}">
          ${icon}<span>${esc(cartLabel(by, items))}</span><span class="n">${items.length}</span>${chevron}
        </button>
        <button type="button" class="group__clear" data-act="clear" data-by="${by}"><span class="lbl">Leeren</span><span class="lbl-armed">Wirklich leeren?</span></button>
      </h2>
      <div class="group__items">${items.map((item) => itemHtml(item, true)).join('')}</div>
    </section>`;
}

/** Text oben neben "Einkauf": "5 offen · 2 im Wagen" oder "alles erledigt 🎉". */
function counterText(open, done) {
  const inMyCart = done.filter((item) => isMe(item.checked_by)).length;
  if (open.length) {
    return `${open.length} offen` + (inMyCart ? ` · ${inMyCart} im Wagen` : '');
  }
  return done.length ? 'alles erledigt 🎉' : '';
}

/**
 * Sync-Punkt oben rechts:
 *   grün              = alles synchronisiert
 *   blau (pulsierend) = Änderungen werden gerade gesendet ("is-pending")
 *   gelb + "offline"  = keine Verbindung ("is-offline")
 */
function renderSync() {
  const el = $('sync');
  const waiting = state.outbox.length;

  el.classList.toggle('is-offline', !state.online);
  el.classList.toggle('is-pending', state.online && waiting > 0);

  let label;
  if (!state.online) label = `Offline${waiting ? ` – ${waiting} Änderung(en) warten` : ''}`;
  else if (waiting) label = 'Wird synchronisiert …';
  else label = 'Synchronisiert';

  el.title = label;
  el.textContent = state.online ? '' : 'offline';
  el.setAttribute('aria-label', label);
}

/**
 * Lässt eine Zeile kurz aufleuchten (und scrollt optional dorthin).
 * requestAnimationFrame wartet, bis der Browser die neue Liste gezeichnet hat.
 */
function highlight(id, scroll = true) {
  requestAnimationFrame(() => {
    const row = $('list').querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    // Klasse entfernen und neu setzen, damit die Animation auch ein 2. Mal startet.
    // "offsetWidth" lesen zwingt den Browser, dazwischen neu zu rechnen.
    row.classList.remove('is-highlight');
    void row.offsetWidth;
    row.classList.add('is-highlight');
    if (scroll) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

/**
 * Kurze Meldung unten am Bildschirm ("Toast"), optional mit einem Knopf.
 * @param text        Meldungstext
 * @param actionLabel Text des Knopfes (z. B. "Rückgängig"), oder leer
 * @param onAction    Was beim Tippen auf den Knopf passiert
 * @param duration    Anzeigedauer in ms
 */
function toast(text, actionLabel, onAction, duration = 4500) {
  const button = $('toastAction');
  $('toastText').textContent = text;
  button.hidden = !actionLabel;
  button.textContent = actionLabel || '';
  button.onclick = () => { hideToast(); if (onAction) onAction(); };
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, duration);
}

function hideToast() {
  clearTimeout(toastTimer);
  toastTimer = null;
  $('toast').hidden = true;
  $('toastAction').onclick = null;
}


/* ============================================================================
 *  9. Eingabeleiste unten (Name + Menge)
 * ========================================================================== */

const input    = $('addInput');  // Feld für den Artikelnamen
const qtyInput = $('qtyInput');  // Feld für die Menge

// Schnellauswahl, die beim Tippen ins Menge-Feld erscheint
const QTY_PRESETS = ['1', '2', '3', '4', '6', '10', '100 g', '250 g', '500 g', '1 kg', '1 l', '1 Pck.', '1 Bund'];

/**
 * Aktualisiert den Kategorie-Knopf links neben dem Eingabefeld.
 * Solange der Benutzer nicht selbst gewählt hat, wird bei jedem Tastendruck
 * neu geraten ("Milch" -> 🧀).
 */
function updateComposerCat() {
  if (!composerCat.manual) {
    composerCat.id = guessCategory(parseInput(input.value).name);
  }
  const cat = catOf(composerCat.id);
  $('catEmoji').textContent = cat.emoji;
  $('catButton').setAttribute('aria-label', `Kategorie: ${cat.label} (ändern)`);
  $('catButton').classList.toggle('is-manual', composerCat.manual); // zeigt "selbst gewählt" an
}

/** Eingabeleiste nach dem Hinzufügen leeren. */
function resetComposer() {
  input.value = '';
  qtyInput.value = '';
  composerCat = { id: 'sonstiges', manual: false };
  updateComposerCat();
  renderSuggestions();
}

/**
 * Name und Menge aus der Eingabeleiste.
 * Die Menge kommt aus dem Menge-Feld – ist das leer, aus dem Namen
 * selbst ("2 Milch" -> Menge "2").
 */
function composerValues() {
  const parsed = parseInput(input.value);
  return {
    name: parsed.name,
    quantity: squish(qtyInput.value) || parsed.quantity,
  };
}

/**
 * Zeigt über der Eingabeleiste kleine Knöpfe ("Chips"):
 *   - Im Menge-Feld: Mengen zur Schnellauswahl
 *   - Im Namensfeld: passende bekannte Artikel
 */
function renderSuggestions() {
  const box = $('suggestions');
  if (document.activeElement === qtyInput) {
    box.innerHTML = quantityChipsHtml();
  } else {
    box.innerHTML = nameChipsHtml();
  }
}

/** Mengen-Chips; die aktuell eingetragene Menge ist hervorgehoben. */
function quantityChipsHtml() {
  const current = qtyInput.value.trim();
  return QTY_PRESETS.map((qty) =>
    `<button type="button" class="chip chip--qty${qty === current ? ' is-active' : ''}" data-qty="${esc(qty)}">${esc(qty)}</button>`
  ).join('');
}

/** Bis zu 12 Vorschläge aus den bekannten Artikeln. */
function nameChipsHtml() {
  const focused = document.activeElement === input;
  const query = lower(parseInput(input.value).name);
  if (!focused && !query) return ''; // nichts eingetippt und Feld nicht aktiv -> keine Vorschläge

  return suggestionsFor(query).slice(0, 12).map((entry) =>
    `<button type="button" class="chip" data-name="${esc(entry.name)}" data-cat="${esc(entry.category)}"><span aria-hidden="true">${esc(catOf(entry.category).emoji)}</span>${esc(entry.name)}</button>`
  ).join('');
}

/**
 * Passende bekannte Artikel zu einer Eingabe.
 * - Was schon offen auf der Liste steht, wird nicht vorgeschlagen.
 * - Ohne Eingabe: die meistgekauften Artikel.
 * - Mit Eingabe: Artikel, die den Text enthalten. Treffer am Wortanfang
 *   zuerst, danach nach Häufigkeit. Exakt gleicher Name wird ausgelassen
 *   (den hat man ja schon getippt).
 */
function suggestionsFor(query) {
  const onList = new Set(activeItems().filter((item) => !item.checked).map((item) => lower(item.name)));
  const candidates = state.known.filter((entry) => !onList.has(lower(entry.name)));

  if (!query) {
    return candidates.slice().sort((a, b) => b.uses - a.uses);
  }

  const startsWithQuery = (entry) => Number(lower(entry.name).startsWith(query));
  return candidates
    .filter((entry) => {
      const name = lower(entry.name);
      return name.includes(query) && name !== query;
    })
    .sort((a, b) => (startsWithQuery(b) - startsWithQuery(a)) || (b.uses - a.uses));
}

// "+" gedrückt oder Enter: Artikel hinzufügen
$('addForm').addEventListener('submit', (e) => {
  e.preventDefault(); // Formular nicht "echt" abschicken (würde die Seite neu laden)
  const { name, quantity } = composerValues();
  if (!name) { input.focus(); return; }
  const category = composerCat.manual ? composerCat.id : guessCategory(name);
  addItem(name, quantity, category);
  resetComposer();
  if (!$('dupSheet').open) input.focus(); // Tastatur nur offen lassen, wenn kein Nachfrage-Dialog aufgeht
});

// Beim Tippen: Kategorie neu raten und Vorschläge aktualisieren
input.addEventListener('input', () => {
  // Feld geleert? Dann gilt eine selbst gewählte Kategorie nicht mehr.
  if (!input.value.trim()) composerCat.manual = false;
  updateComposerCat();
  renderSuggestions();
});
qtyInput.addEventListener('input', renderSuggestions);

// Beim Wechsel zwischen Name- und Menge-Feld passende Vorschläge zeigen.
// Beim Verlassen kurz warten, damit ein Tipp auf einen Chip noch ankommt.
for (const field of [input, qtyInput]) {
  field.addEventListener('focus', renderSuggestions);
  field.addEventListener('blur', () => setTimeout(renderSuggestions, 150));
}

// Tippen auf Vorschläge oder "+" soll das Eingabefeld NICHT verlassen
// (sonst klappt die Handy-Tastatur zu). preventDefault bei mousedown verhindert
// den Fokuswechsel.
for (const el of [$('suggestions'), document.querySelector('.add-btn')]) {
  el.addEventListener('mousedown', (e) => e.preventDefault());
}

// Tipp auf einen Chip
$('suggestions').addEventListener('click', (e) => {
  // Mengen-Chip: Menge eintragen
  const qtyChip = e.target.closest('[data-qty]');
  if (qtyChip) {
    qtyInput.value = qtyChip.dataset.qty;
    vibrate(8);
    if (!parseInput(input.value).name) {
      // Noch kein Name eingetippt -> weiter zum Namensfeld
      input.focus();
      renderSuggestions();
    } else {
      // Name schon da -> direkt hinzufügen
      $('addForm').requestSubmit();
    }
    return;
  }

  // Artikel-Chip: diesen Artikel hinzufügen (mit manuell gewählter oder bekannter Kategorie)
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const cat = composerCat.manual ? composerCat.id : catOf(chip.dataset.cat).id;
  addItem(chip.dataset.name, composerValues().quantity, cat);
  resetComposer();
});

// ---------------------------------------------------------------------------
// Kategorie-Auswahl
// ---------------------------------------------------------------------------

/** Raster mit allen Kategorien; die aktive ist markiert. */
function catGridHtml(activeId) {
  return state.categories.map((c) =>
    `<button type="button" class="cat-opt${c.id === activeId ? ' is-active' : ''}" data-cat="${esc(c.id)}">
      <span class="e" aria-hidden="true">${esc(c.emoji)}</span>${esc(c.label)}</button>`
  ).join('');
}

// Kategorie-Knopf links in der Eingabeleiste -> Auswahl öffnen
$('catButton').addEventListener('click', () => {
  $('catGrid').innerHTML = catGridHtml(composerCat.id);
  $('catSheet').showModal();
});

// Kategorie gewählt -> merken (ab jetzt "manuell") und Auswahl schließen
$('catGrid').addEventListener('click', (e) => {
  const button = e.target.closest('.cat-opt');
  if (!button) return;
  composerCat = { id: button.dataset.cat, manual: true };
  updateComposerCat();
  vibrate(8);
  $('catSheet').close();
  if (input.value) input.focus();
});


/* ============================================================================
 *  10. Liste bedienen
 * ============================================================================
 *
 *   Tippen auf Artikel     = abhaken / Haken zurücknehmen
 *   Lange drücken          = Bearbeiten-Dialog
 *   Papierkorb             = löschen (mit zweitem Tipp bestätigen)
 *   Griff ⠿ ziehen         = verschieben (Abschnitt 11)
 *   "Leeren" am Wagen      = Wagen leeren (mit zweitem Tipp bestätigen)
 *   Tippen auf fremden Wagen = auf-/zuklappen
 *
 * Alle Klicks werden an EINER Stelle (der Liste) abgefangen statt an jeder
 * Zeile einzeln ("Event Delegation"). Das ist nötig, weil die Zeilen bei
 * jedem render() neu erzeugt werden.
 */

const list = $('list');

// ---------------------------------------------------------------------------
// Löschen nur mit zweitem Tipp
// ---------------------------------------------------------------------------
//
// Damit man im Gedränge nicht aus Versehen etwas löscht:
//   1. Tipp: Knopf wird "scharf" (rot, zeigt "Löschen?" bzw. "Wirklich leeren?")
//   2. Tipp innerhalb von 3 Sekunden: wirklich löschen
// Tippt man woanders hin oder wartet zu lange, wird der Knopf wieder entschärft.
//
// Gemerkt wird ein CSS-Selektor statt des Elements selbst, weil render() die
// Elemente ersetzt – über den Selektor findet man den neuen Knopf wieder.

const CONFIRM_MS          = 3000; // so lange ist ein Knopf "scharf"
const AFTER_DRAG_GUARD_MS = 500;  // so lange nach dem Ablegen werden Lösch-Tipps ignoriert

/** Das aktuell scharfe Element (oder null). */
function armedEl() {
  return armed ? list.querySelector(armed.selector) : null;
}

/** Markiert das scharfe Element optisch (auch nach einem Neuzeichnen). */
function applyArmed() {
  const el = armedEl();
  if (el) el.classList.add('is-armed');
}

/** Entschärfen. */
function disarm() {
  if (!armed) return;
  clearTimeout(armed.timer);
  const el = armedEl();
  armed = null;
  if (el) el.classList.remove('is-armed');
}

/** Einen Knopf scharf machen (ein evtl. anderer scharfer Knopf wird entschärft). */
function arm(selector) {
  disarm();
  armed = { selector, timer: setTimeout(disarm, CONFIRM_MS) };
  applyArmed();
  vibrate(10);
}

// Tippen irgendwo anders entschärft. "true" = schon in der Capture-Phase
// reagieren, also bevor irgendein anderer Klick-Handler läuft.
document.addEventListener('pointerdown', (e) => {
  const el = armedEl();
  if (el && !el.contains(e.target)) disarm();
}, true);

// Escape entschärft aktive Lösch-Knöpfe am Desktop
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && armed) disarm();
});

/**
 * Wurde gerade erst ein Artikel abgelegt? Dann Lösch-Tipps ignorieren –
 * beim Loslassen rutscht der Finger leicht mal auf den Papierkorb.
 */
const justDragged = () => performance.now() - lastDragEnd < AFTER_DRAG_GUARD_MS;

/** Laufendes kurzes Halten am Griff abbrechen (z. B. wenn der Finger scrollt). */
function cancelGripHold() {
  if (!gripHold) return;
  clearTimeout(gripHold.timer);
  gripHold.grip.classList.remove('is-holding');
  gripHold = null;
}

// ---------------------------------------------------------------------------
// Langes Drücken = bearbeiten · Griff halten/ziehen = verschieben
// ---------------------------------------------------------------------------

// Finger runter:
//   - Maus auf Griff -> sofort ziehen
//   - Touch auf Griff -> kurz halten (DRAG_HOLD_MS), damit Scrollen mit der
//     rechten Hand nie versehentlich Artikel verschiebt
//   - sonst -> Timer für "langes Drücken" (Bearbeiten)
list.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return; // Rechts-/Mittelklick ignorieren
  if (press) clearTimeout(press.timer);
  press = null;
  cancelGripHold();

  const grip = e.target.closest('.item__grip');
  if (grip) {
    if (e.pointerType === 'mouse') {
      startDrag(e, grip);
      return;
    }
    const row = grip.closest('.item');
    if (!row || drag) return;
    grip.classList.add('is-holding');
    const hold = {
      grip,
      row,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      timer: 0,
    };
    hold.timer = setTimeout(() => {
      if (gripHold !== hold) return;
      grip.classList.remove('is-holding');
      gripHold = null;
      startDrag({ clientX: hold.x, clientY: hold.y, pointerId: hold.pointerId }, grip);
    }, DRAG_HOLD_MS);
    gripHold = hold;
    return;
  }

  const row = e.target.closest('.item');
  if (!row || e.target.closest('.item__del')) return; // Papierkorb hat kein langes Drücken

  const p = { id: row.dataset.id, x: e.clientX, y: e.clientY, fired: false, timer: 0 };
  p.timer = setTimeout(() => {
    p.fired = true; // merken, damit der folgende "click" nicht zusätzlich abhakt
    vibrate(30);
    openEdit(p.id);
  }, LONG_PRESS_MS);
  press = p;
});

// Finger bewegt sich deutlich -> das ist Scrollen, kein langes Drücken / kein Griff-Halten
list.addEventListener('pointermove', (e) => {
  if (gripHold && e.pointerId === gripHold.pointerId) {
    if (Math.hypot(e.clientX - gripHold.x, e.clientY - gripHold.y) > MOVE_TOLERANCE_PX) {
      cancelGripHold();
    }
  }
  if (!press) return;
  const distance = Math.hypot(e.clientX - press.x, e.clientY - press.y);
  if (distance > MOVE_TOLERANCE_PX) clearTimeout(press.timer);
});

// Finger hoch / abgebrochen -> Timer stoppen
for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
  list.addEventListener(type, () => {
    if (press) clearTimeout(press.timer);
    cancelGripHold();
  });
}
window.addEventListener('scroll', cancelGripHold, { passive: true });

// Kontextmenü (Rechtsklick am PC, langes Drücken auf manchen Handys):
// statt Browser-Menü den Bearbeiten-Dialog öffnen
list.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const row = e.target.closest('.item');
  if (!row || drag || e.target.closest('.item__grip')) return;
  if (press && press.fired) return; // Timer hat den Dialog schon geöffnet
  if (press) { clearTimeout(press.timer); press.fired = true; }
  openEdit(row.dataset.id);
});

// ---------------------------------------------------------------------------
// Klicks in der Liste
// ---------------------------------------------------------------------------

list.addEventListener('click', (e) => {
  if (handleCartClearClick(e)) return;
  if (handleCartToggleClick(e)) return;

  const row = e.target.closest('.item');
  if (!row) return;

  // Nach langem Drücken kommt beim Loslassen noch ein "click" – den ignorieren.
  if (press && press.fired && press.id === row.dataset.id) { press = null; return; }
  press = null;

  if (e.target.closest('.item__del')) { handleDeleteClick(row); return; }
  if (e.target.closest('.item__toggle')) toggleItem(row.dataset.id, row);
});

/** "Leeren" am Wagen: 1. Tipp scharf machen, 2. Tipp leeren. */
function handleCartClearClick(e) {
  const button = e.target.closest('[data-act="clear"]');
  if (!button) return false;
  if (justDragged()) return true;

  const by = Number(button.dataset.by);
  if (button.classList.contains('is-armed')) {
    disarm();
    clearCart(by);
  } else {
    arm(`.group__clear[data-by="${by}"]`);
  }
  return true;
}

/** Überschrift eines fremden Wagens: auf-/zuklappen. Der eigene ist immer offen. */
function handleCartToggleClick(e) {
  const button = e.target.closest('[data-act="toggle-cart"]');
  if (!button) return false;

  const by = Number(button.dataset.by);
  if (isMe(by)) return true;
  if (expandedCarts.has(by)) expandedCarts.delete(by);
  else expandedCarts.add(by);
  vibrate(8);
  render();
  return true;
}

/** Papierkorb: 1. Tipp scharf machen, 2. Tipp löschen. */
function handleDeleteClick(row) {
  if (justDragged()) return; // Finger beim Ablegen abgerutscht
  const del = row.querySelector('.item__del');
  if (del.classList.contains('is-armed')) {
    disarm();
    deleteItem(row.dataset.id);
  } else {
    arm(`.item[data-id="${CSS.escape(row.dataset.id)}"] .item__del`);
  }
}


/* ============================================================================
 *  11. Ziehen & Ablegen
 * ============================================================================
 *
 * Ablauf:
 *   1. Finger auf den Griff ⠿ (startDrag)
 *        - leere Kategorien werden als Ablageflächen eingeblendet
 *        - eine Kopie der Zeile ("Ghost") folgt dem Finger
 *        - die echte Zeile bleibt als blasser Platzhalter in der Liste
 *   2. Finger bewegen (onDragMove)
 *        - Ghost folgt dem Finger
 *        - der Platzhalter wird an die Stelle unter dem Finger verschoben (reorderAt)
 *        - am oberen/unteren Rand wird automatisch gescrollt (autoScroll)
 *   3. Finger hoch (endDrag)
 *        - neue Kategorie und Position berechnen und speichern
 *        - Scrollposition so korrigieren, dass nichts springt
 */

/** Ziehen beginnen. */
function startDrag(e, grip) {
  const row = grip.closest('.item');
  if (!row || drag) return;
  if (e.preventDefault) e.preventDefault(); // verhindert, dass der Browser stattdessen scrollt

  showDropZones(row);

  const rect = row.getBoundingClientRect();
  const ghost = createGhost(row, rect);
  row.classList.add('is-drag-source');

  drag = {
    id: row.dataset.id,
    row,                                 // die echte Zeile (Platzhalter)
    ghost,                               // die schwebende Kopie
    grip,
    offsetY: e.clientY - rect.top,       // wo innerhalb der Zeile der Finger liegt
    y: e.clientY,                        // aktuelle Fingerposition
    pointerId: e.pointerId,              // welcher Finger (bei mehreren)
    raf: 0,                              // ID der Auto-Scroll-Schleife
    edgeSince: 0,                        // seit wann der Finger am Rand verweilt
    lastCat: null,                       // zuletzt überfahrene Kategorie (für Vibration)
    // Ausgangslage – um am Ende zu erkennen, ob sich überhaupt etwas geändert hat
    start: {
      cat: row.closest('.group').dataset.cat,
      prevId: row.previousElementSibling?.dataset.id ?? null,
      nextId: row.nextElementSibling?.dataset.id ?? null,
    },
  };

  // Pointer Capture: alle weiteren Fingerbewegungen gehen an den Griff,
  // selbst wenn der Finger das Element verlässt.
  try { grip.setPointerCapture(e.pointerId); } catch { /* egal */ }
  vibrate(20);
  drag.raf = requestAnimationFrame(autoScroll);
}

/**
 * Leere Kategorien einblenden (CSS-Klasse "is-dragging" an der Liste).
 * Dadurch wird die Seite länger und die gegriffene Zeile würde verrutschen –
 * deshalb messen wir vorher/nachher und scrollen den Unterschied weg.
 */
function showDropZones(row) {
  const topBefore = row.getBoundingClientRect().top;
  list.classList.add('is-dragging');
  window.scrollBy(0, row.getBoundingClientRect().top - topBefore);
}

/** Schwebende Kopie der Zeile erzeugen, genau über dem Original. */
function createGhost(row, rect) {
  const ghost = row.cloneNode(true);
  ghost.classList.add('item--ghost');
  ghost.removeAttribute('data-id'); // damit Suchen nach data-id nur das Original findet
  ghost.style.width = `${rect.width}px`;
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  document.body.appendChild(ghost);
  return ghost;
}

/** Finger bewegt sich: Ghost mitführen und Platzhalter einsortieren. */
function onDragMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  e.preventDefault();
  drag.y = e.clientY;
  drag.ghost.style.top = `${drag.y - drag.offsetY}px`;
  reorderAt(drag.y);
}

/** Verschiebt den Platzhalter an die Stelle, die der Bildschirmhöhe y entspricht. */
function reorderAt(y) {
  const group = closestCategoryGroup(y);
  if (!group) return;

  const container = group.querySelector('.group__items');
  const beforeRow = rowBelow(container, y);

  // Steht der Platzhalter schon genau dort? Dann nichts tun.
  if (drag.row.parentNode === container && drag.row.nextElementSibling === beforeRow) return;

  // insertBefore(x, null) hängt ans Ende an – passt also auch für "ganz unten".
  container.insertBefore(drag.row, beforeRow);

  // Kurzes Vibrieren, wenn man in eine andere Kategorie wechselt
  if (group.dataset.cat !== drag.lastCat) {
    drag.lastCat = group.dataset.cat;
    vibrate(8);
  }
}

/**
 * Die Kategorie-Gruppe, die der Höhe y am nächsten liegt (Wagen zählen nicht).
 * Liegt y innerhalb einer Gruppe, ist der Abstand 0.
 */
function closestCategoryGroup(y) {
  let closest = null;
  let bestDistance = Infinity;
  for (const group of list.querySelectorAll('.group:not(.group--done)')) {
    const rect = group.getBoundingClientRect();
    if (!rect.height) continue; // unsichtbare Gruppe überspringen

    let distance = 0;
    if (y < rect.top) distance = rect.top - y;            // Finger über der Gruppe
    else if (y > rect.bottom) distance = y - rect.bottom; // Finger unter der Gruppe

    if (distance < bestDistance) {
      bestDistance = distance;
      closest = group;
    }
  }
  return closest;
}

/**
 * Erste Zeile im Container, deren Mitte unterhalb von y liegt – davor gehört
 * der Platzhalter hin. null = ans Ende.
 */
function rowBelow(container, y) {
  for (const row of container.querySelectorAll('.item:not(.is-drag-source)')) {
    const rect = row.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) return row;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Automatisch scrollen am Bildschirmrand
// ---------------------------------------------------------------------------
//
// Hält man den Finger beim Ziehen nah an den oberen oder unteren Rand, scrollt
// die Liste. Damit das nicht versehentlich passiert:
//   - erst nach EDGE_DELAY_MS Verweilen am Rand
//   - sanft anlaufend (Geschwindigkeit steigt über 0,6 s an)
//   - nach unten nur, bis die letzte Kategorie ganz zu sehen ist
//     (sonst landet man unten bei den Wagen)

const EDGE_PX       = 56;  // Breite der Randzone in Pixeln
const EDGE_DELAY_MS = 350; // Verweilzeit, bevor gescrollt wird
const RAMP_MS       = 600; // Anlaufzeit bis zur vollen Geschwindigkeit
const MAX_SPEED_PX  = 10;  // max. Pixel pro Bild (ca. 60 Bilder pro Sekunde)

/**
 * Wird ca. 60x pro Sekunde aufgerufen, solange gezogen wird.
 * @param t Zeitstempel vom Browser (ms)
 */
function autoScroll(t) {
  if (!drag) return;

  const zone = edgeZone();
  const direction = edgeDirection(zone); // -1 = hoch, 1 = runter, 0 = nicht am Rand

  if (!direction) {
    drag.edgeSince = 0;
  } else {
    if (!drag.edgeSince) drag.edgeSince = t; // gerade erst am Rand angekommen
    const dwell = t - drag.edgeSince;

    const mayScroll = dwell > EDGE_DELAY_MS && (direction < 0 || canScrollDown(zone.bottom));
    if (mayScroll) {
      const speed = scrollSpeed(zone, direction, dwell);
      const scrollBefore = window.scrollY;
      window.scrollBy(0, direction * speed);
      // Liste hat sich unter dem Finger bewegt -> Platzhalter neu einsortieren
      if (window.scrollY !== scrollBefore) reorderAt(drag.y);
    }
  }
  drag.raf = requestAnimationFrame(autoScroll); // nächstes Bild
}

/** Grenzen der Randzonen: oberhalb von "top" und unterhalb von "bottom" wird gescrollt. */
function edgeZone() {
  return {
    top: topbar.offsetHeight + EDGE_PX,                              // unter der Kopfzeile
    bottom: $('composer').getBoundingClientRect().top - EDGE_PX,     // über der Eingabeleiste
  };
}

/** In welcher Randzone ist der Finger? */
function edgeDirection(zone) {
  if (drag.y < zone.top) return -1;
  if (drag.y > zone.bottom) return 1;
  return 0;
}

/** Darf noch nach unten gescrollt werden? Nur solange die letzte Kategorie unten noch abgeschnitten ist. */
function canScrollDown(zoneBottom) {
  let lastBottom = 0;
  for (const group of list.querySelectorAll('.group:not(.group--done)')) {
    const rect = group.getBoundingClientRect();
    if (rect.height) lastBottom = rect.bottom;
  }
  return lastBottom > zoneBottom - 8;
}

/**
 * Scroll-Geschwindigkeit in Pixel pro Bild:
 *   - je tiefer der Finger in der Randzone, desto schneller (bis MAX_SPEED_PX)
 *   - in den ersten RAMP_MS nach der Wartezeit langsam ansteigend
 *   - mindestens 1 Pixel
 */
function scrollSpeed(zone, direction, dwell) {
  const depth = direction < 0 ? zone.top - drag.y : drag.y - zone.bottom;
  const ramp = Math.min(1, (dwell - EDGE_DELAY_MS) / RAMP_MS); // 0 … 1
  return Math.max(1, Math.min(MAX_SPEED_PX, depth / 6) * ramp);
}

// ---------------------------------------------------------------------------
// Ablegen
// ---------------------------------------------------------------------------

/**
 * Korrigiert die Scrollposition so, dass ein Artikel wieder an derselben
 * Bildschirmstelle steht wie vorher (verhindert Springen nach dem Neuzeichnen).
 */
function keepRowAt(id, screenTop) {
  const row = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!row) return;
  const diff = row.getBoundingClientRect().top - screenTop;
  if (Math.abs(diff) > 1) window.scrollBy(0, diff);
}

/** Finger losgelassen: Ziehen beenden und Ergebnis speichern. */
function endDrag(e) {
  if (!drag || (e && e.pointerId !== drag.pointerId)) return;
  const { id, row, ghost, start } = drag;

  cancelAnimationFrame(drag.raf);
  // Bildschirmposition merken, BEVOR die leeren Kategorien wieder verschwinden
  const screenTop = row.getBoundingClientRect().top;

  // Aufräumen
  ghost.remove();
  row.classList.remove('is-drag-source');
  list.classList.remove('is-dragging');
  drag = null;
  lastDragEnd = performance.now();

  const group = row.closest('.group');
  const item = findItem(id);
  if (!group || !item) {
    // Artikel wurde währenddessen (z. B. auf anderem Gerät) gelöscht
    render();
    keepRowAt(id, screenTop);
    return;
  }

  // Wo ist die Zeile gelandet?
  const cat = group.dataset.cat;
  const prevId = row.previousElementSibling?.dataset.id ?? null;
  const nextId = row.nextElementSibling?.dataset.id ?? null;

  const unchanged = cat === start.cat && prevId === start.prevId && nextId === start.nextId;
  if (unchanged) {
    if (renderPending) render(); // aufgeschobenes Neuzeichnen nachholen
    keepRowAt(id, screenTop);
    return;
  }

  const prevItem = findItem(prevId);
  const nextItem = findItem(nextId);
  const needsRebalance = prevItem && nextItem
    && Math.abs((typeof prevItem.position === 'number' ? prevItem.position : 0)
              - (typeof nextItem.position === 'number' ? nextItem.position : 0)) < 1e-6;

  if (cat !== item.category) {
    rememberLocal(item.name, cat, false); // künftig in dieser Kategorie vorschlagen
    toast(`„${item.name}“ → ${catOf(cat).label}`);
  }
  vibrate(12);

  if (needsRebalance) {
    const orderedIds = Array.from(group.querySelectorAll('.item')).map((el) => el.dataset.id);
    rebalanceCategory(cat, orderedIds);
  } else {
    const changes = { position: positionBetween(prevItem, nextItem) };
    if (cat !== item.category) changes.category = cat;
    updateItem(id, changes); // zeichnet auch neu
  }
  keepRowAt(id, screenTop);
}

/** Nummeriert alle Artikel einer Kategorie sauber neu (1, 2, 3, ...). */
function rebalanceCategory(cat, orderedIds) {
  const ts = now();
  orderedIds.forEach((itemId, idx) => {
    const it = findItem(itemId);
    if (it) {
      it.category = cat;
      it.position = idx + 1;
      it.updated_at = ts;
    }
  });
  saveItems();
  enqueue({ type: 'reorder', data: { category: cat, ids: orderedIds } });
  render();
}

/**
 * Neue Position zwischen zwei Nachbarn. Kommazahlen machen's einfach:
 *   zwischen 3 und 4  -> 3.5
 *   nur Vorgänger 3   -> 4
 *   nur Nachfolger 3  -> 2
 *   allein            -> 1
 */
function positionBetween(prev, next) {
  const pos = (item) => (typeof item.position === 'number' ? item.position : 0);
  if (prev && next) return (pos(prev) + pos(next)) / 2;
  if (prev) return pos(prev) + 1;
  if (next) return pos(next) - 1;
  return 1;
}

// Bewegungen auf dem ganzen Fenster beobachten (der Finger verlässt die Liste ja evtl.).
// passive: false ist nötig, damit preventDefault() das Scrollen verhindern darf.
window.addEventListener('pointermove', onDragMove, { passive: false });
window.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', () => { cancelGripHold(); if (drag) endDrag(); });


/* ============================================================================
 *  12. Bearbeiten-Dialog
 * ========================================================================== */

let editId  = null; // welcher Artikel wird bearbeitet
let editCat = null; // im Dialog gewählte Kategorie

/** Dialog für einen Artikel öffnen und mit seinen Daten füllen. */
function openEdit(id) {
  const item = findItem(id);
  if (!item) return;

  // Wer einmal lange gedrückt hat, kennt die Bedienung -> Hinweis ausblenden
  if (!store.get(STORAGE_KEYS.hintDone, false)) {
    store.set(STORAGE_KEYS.hintDone, true);
    $('hint').hidden = true;
  }

  editId = id;
  editCat = catOf(item.category).id;
  $('editName').value = item.name;
  $('editQty').value = item.quantity || '';
  $('editNote').value = item.note || '';
  $('editCatGrid').innerHTML = catGridHtml(editCat);
  $('editMeta').textContent = editMetaText(item);

  // Listen-Auswahl nur zeigen, wenn es mindestens 2 Listen gibt
  const listField = $('editListField');
  if (state.lists.length > 1) {
    listField.hidden = false;
    $('editList').innerHTML = state.lists
      .map((l) => `<option value="${esc(l.id)}">${esc(l.emoji)} ${esc(l.name)}</option>`)
      .join('');
    $('editList').value = item.list_id || activeListId();
  } else {
    listField.hidden = true;
  }

  updateEditMoveButtons(item);

  if (!$('editSheet').open) $('editSheet').showModal();
}

/** Aktiviert/deaktiviert ▲/▼ im Bearbeiten-Dialog je nach Position in der Kategorie. */
function updateEditMoveButtons(item) {
  const field = $('editMoveField');
  if (!item || item.checked) {
    field.hidden = true;
    return;
  }
  const siblings = activeItems()
    .filter((i) => !i.checked && catOf(i.category).id === catOf(item.category).id)
    .sort(sortItems);
  const idx = siblings.findIndex((i) => i.id === item.id);
  field.hidden = siblings.length <= 1;
  $('editMoveUp').disabled = idx <= 0;
  $('editMoveDown').disabled = idx < 0 || idx >= siblings.length - 1;
}

/** Artikel im Bearbeiten-Dialog um einen Platz nach oben (-1) oder unten (+1) schieben. */
function moveEditItem(dir) {
  const item = findItem(editId);
  if (!item || item.checked) return;
  const cat = catOf(item.category).id;
  const siblings = activeItems()
    .filter((i) => !i.checked && catOf(i.category).id === cat)
    .sort(sortItems);
  const from = siblings.findIndex((i) => i.id === item.id);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= siblings.length) return;

  const ids = siblings.map((i) => i.id);
  [ids[from], ids[to]] = [ids[to], ids[from]];
  vibrate(8);
  rebalanceCategory(cat, ids);
  updateEditMoveButtons(item);
}
$('editMoveUp').addEventListener('click', () => moveEditItem(-1));
$('editMoveDown').addEventListener('click', () => moveEditItem(1));

/** Infozeilen im Dialog: wer hat hinzugefügt/abgehakt und wann. */
function editMetaText(item) {
  const lines = [];

  const creator = personName(item.created_by, item.created_by_name);
  lines.push(creator
    ? `Hinzugefügt von ${creator} · ${relTime(item.created_at)}`
    : `Hinzugefügt ${relTime(item.created_at)}`);

  if (item.checked) {
    const checker = personName(item.checked_by, item.checked_by_name);
    const byWhom = checker ? ` von ${checker}` : '';
    const when = item.checked_at ? ` · ${relTime(item.checked_at)}` : '';
    lines.push(`Abgehakt${byWhom}${when}`);
  }
  return lines.join('\n'); // CSS "white-space: pre-line" zeigt den Umbruch an
}

// Kategorie im Dialog antippen -> markieren (gespeichert wird erst bei "Speichern")
$('editCatGrid').addEventListener('click', (e) => {
  const button = e.target.closest('.cat-opt');
  if (!button) return;
  editCat = button.dataset.cat;
  for (const b of $('editCatGrid').querySelectorAll('.cat-opt')) {
    b.classList.toggle('is-active', b === button);
  }
  vibrate(8);
});

// "Speichern": nur geänderte Felder senden
$('editForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const item = findItem(editId);
  if (!item) { $('editSheet').close(); return; }

  const name = capitalize(squish($('editName').value));
  const quantity = squish($('editQty').value);
  const note = squish($('editNote').value);
  if (!name) { $('editName').focus(); return; }

  const changes = {};
  if (name !== item.name) changes.name = name;
  if (quantity !== (item.quantity || '')) changes.quantity = quantity;
  if (note !== (item.note || '')) changes.note = note;

  const newListId = state.lists.length > 1 ? $('editList').value : (item.list_id || DEFAULT_LIST_ID);
  const listChanged = newListId !== (item.list_id || DEFAULT_LIST_ID);
  if (listChanged) changes.list_id = newListId;

  if (editCat !== item.category || listChanged) {
    if (editCat !== item.category) changes.category = editCat;
    changes.position = nextPosition(editCat, newListId); // ans Ende der Ziel-Kategorie
  }

  if (Object.keys(changes).length) {
    updateItem(editId, changes);
    if (changes.name || changes.category) rememberLocal(name, editCat, false);
  }
  $('editSheet').close();
});

// "Löschen" im Dialog (hier ohne zweiten Tipp – der Dialog ist schon Bestätigung genug)
$('editDelete').addEventListener('click', () => {
  const id = editId;
  $('editSheet').close();
  deleteItem(id);
});

// Alle Dialoge: Schließen-Knöpfe (data-close) und Tipp auf den dunklen Hintergrund.
// Ein Tipp auf den Hintergrund trifft das <dialog>-Element selbst (e.target === dialog).
for (const dialog of document.querySelectorAll('dialog.sheet')) {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
  });
}

/** Alle offenen Dialoge schließen. */
function closeDialogs() {
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
}


/* ============================================================================
 *  12b. Vorlagen & Rezepte
 * ========================================================================== */

function renderTemplates() {
  const ul = $('templateList');
  if (!state.templates.length) {
    ul.innerHTML = '<li class="muted">Noch keine Vorlagen gespeichert.</li>';
    return;
  }
  ul.innerHTML = state.templates.map((tpl) => `<li data-id="${esc(tpl.id)}">
      <button type="button" class="tpl-row" data-act="apply-tpl">
        <span class="e" aria-hidden="true">${esc(tpl.emoji || '📋')}</span>
        <span class="grow">${esc(tpl.name)}<span class="sub">${tpl.items.length} Artikel</span></span>
      </button>
      <button type="button" class="row-btn row-btn--danger" data-act="del-tpl" aria-label="${esc(tpl.name)} löschen">${ICON_TRASH}</button>
    </li>`).join('');
}

$('templatesBtn').addEventListener('click', () => {
  renderTemplates();
  $('templatesSheet').showModal();
});

$('templateList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('li').dataset.id;
  const tpl = state.templates.find((t) => t.id === id);
  if (!tpl) return;

  if (btn.dataset.act === 'apply-tpl') {
    applyTemplate(tpl);
    return;
  }

  if (btn.dataset.act === 'del-tpl') {
    if (!confirm(`Vorlage „${tpl.name}“ wirklich löschen?`)) return;
    try {
      const res = await api('DELETE', `?action=templates&id=${encodeURIComponent(id)}`);
      state.templates = res.templates || [];
      store.set(STORAGE_KEYS.templates, state.templates);
      renderTemplates();
      toast(`Vorlage „${tpl.name}“ gelöscht`);
    } catch (err) {
      if (err.status === 401) { needLogin(); return; }
      toast(err.message);
    }
  }
});

/** Vorlage anwenden – bei bereits offenen Artikeln vorher nachfragen. */
function applyTemplate(tpl) {
  const openNames = new Set(activeItems().filter((i) => !i.checked).map((i) => lower(i.name)));
  const duplicates = tpl.items.filter((it) => openNames.has(lower(it.name)));
  const missingCount = tpl.items.length - duplicates.length;

  const run = (mode, label) => {
    for (const it of tpl.items) {
      addItem(it.name, it.quantity || '', it.category || guessCategory(it.name), it.note || '', mode);
    }
    $('templatesSheet').close();
    toast(label);
  };

  if (!duplicates.length) {
    run('add', `„${tpl.name}“ hinzugefügt (${tpl.items.length})`);
    return;
  }

  const preview = duplicates.slice(0, 4).map((d) => d.name).join(', ');
  const more = duplicates.length > 4 ? ` und ${duplicates.length - 4} weitere` : '';
  const desc = duplicates.length === 1
    ? `Aus „${tpl.name}“ steht „${duplicates[0].name}“ schon auf der Liste.`
    : `Aus „${tpl.name}“ stehen ${duplicates.length} von ${tpl.items.length} Artikeln schon auf der Liste:\n${preview}${more}.`;

  openDupDialog({
    desc,
    addLabel: 'Mengen addieren',
    showSkip: missingCount > 0,
    onOverwrite: () => run('overwrite', `„${tpl.name}“ übernommen (${duplicates.length} überschrieben)`),
    onAddAgain: () => run('merge', `„${tpl.name}“ addiert (${duplicates.length} erhöht)`),
    onSkip: () => run('skip', `${missingCount} fehlende Artikel aus „${tpl.name}“ hinzugefügt`),
  });
}

$('tplFromList').addEventListener('click', () => {
  const open = activeItems().filter((i) => !i.checked).sort(sortItems);
  if (!open.length) { toast('Aktuelle Liste ist leer'); return; }
  $('tplItems').value = open.map((i) => (i.quantity ? `${i.quantity} ${i.name}` : i.name)).join('\n');
});

$('tplForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = squish($('tplName').value);
  const emoji = squish($('tplEmoji').value) || '📋';
  const lines = $('tplItems').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!name || !lines.length) return;

  const items = lines.map((line) => {
    const parsed = parseInput(line);
    const itemName = capitalize(parsed.name);
    return { name: itemName, quantity: parsed.quantity, category: guessCategory(itemName), note: '' };
  });

  try {
    const res = await api('POST', '?action=templates', { name, emoji, items });
    state.templates = res.templates || [];
    store.set(STORAGE_KEYS.templates, state.templates);
    $('tplForm').reset();
    $('tplEmoji').value = '📋';
    $('tplDetails').open = false;
    renderTemplates();
    toast(`Vorlage „${name}“ gespeichert`);
  } catch (err) {
    if (err.status === 401) { needLogin(); return; }
    toast(err.message);
  }
});


/* ============================================================================
 *  13. Einstellungen
 * ========================================================================== */

/** Liste "Kategorien & Reihenfolge im Laden" mit ▲/▼, Bearbeiten und Löschen. */
function renderCatOrder() {
  const lastIndex = state.categories.length - 1;
  $('catOrder').innerHTML = state.categories.map((c, i) => `<li data-cat="${esc(c.id)}">
      <span class="e" aria-hidden="true">${esc(c.emoji)}</span>
      <span class="grow">${esc(c.label)}</span>
      <button type="button" class="row-btn" data-act="cat-edit" aria-label="${esc(c.label)} umbenennen">✏️</button>
      ${c.id === 'sonstiges' ? '' : `<button type="button" class="row-btn row-btn--danger" data-act="cat-del" aria-label="${esc(c.label)} löschen">${ICON_TRASH}</button>`}
      <button type="button" class="row-btn" data-dir="-1" aria-label="${esc(c.label)} nach oben"${i === 0 ? ' disabled' : ''}>${ICON_UP}</button>
      <button type="button" class="row-btn" data-dir="1" aria-label="${esc(c.label)} nach unten"${i === lastIndex ? ' disabled' : ''}>${ICON_DOWN}</button>
    </li>`).join('');
}

// ▲/▼, Bearbeiten oder Löschen in der Kategorieliste
$('catOrder').addEventListener('click', (e) => {
  const button = e.target.closest('.row-btn');
  if (!button) return;

  const id = button.closest('li').dataset.cat;
  const idx = state.categories.findIndex((c) => c.id === id);
  if (idx < 0) return;

  if (button.dataset.act === 'cat-edit') {
    const cat = state.categories[idx];
    const label = prompt('Neuer Name der Kategorie:', cat.label);
    if (label === null) return;
    const cleanLabel = squish(label);
    if (!cleanLabel) return;
    const emoji = prompt('Emoji für die Kategorie:', cat.emoji);
    const updated = state.categories.slice();
    updated[idx] = { ...cat, label: cleanLabel, emoji: squish(emoji ?? cat.emoji) || cat.emoji };
    state.categories = updated;
    renderCatOrder();
    saveCategories(true);
    return;
  }

  if (button.dataset.act === 'cat-del') {
    const cat = state.categories[idx];
    if (cat.id === 'sonstiges') return;
    if (!confirm(`Kategorie „${cat.label}“ löschen? Artikel daraus landen unter „Sonstiges“.`)) return;
    state.categories = state.categories.filter((c) => c.id !== id);
    for (const item of state.items) {
      if (item.category === id) item.category = 'sonstiges';
    }
    saveItems();
    renderCatOrder();
    saveCategories(true);
    return;
  }

  const to = idx + Number(button.dataset.dir); // -1 = hoch, +1 = runter
  if (to < 0 || to >= state.categories.length) return;

  const reordered = state.categories.slice();
  [reordered[idx], reordered[to]] = [reordered[to], reordered[idx]];
  state.categories = reordered;

  vibrate(8);
  renderCatOrder();
  saveCategories(false);

  const sameButton = $('catOrder').querySelector(`li[data-cat="${CSS.escape(id)}"] .row-btn[data-dir="${button.dataset.dir}"]`);
  if (sameButton && !sameButton.disabled) sameButton.focus();
});

$('catAddForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const label = squish($('catAddName').value);
  const emoji = squish($('catAddEmoji').value) || '🏷️';
  if (!label) return;
  const id = 'cat_' + uid().replace(/-/g, '').slice(0, 8);
  const next = state.categories.slice();
  const fallbackIdx = next.findIndex((c) => c.id === 'sonstiges');
  if (fallbackIdx >= 0) next.splice(fallbackIdx, 0, { id, label, emoji });
  else next.push({ id, label, emoji });
  state.categories = next;
  $('catAddName').value = '';
  $('catAddEmoji').value = '🏷️';
  renderCatOrder();
  saveCategories(true);
  toast(`Kategorie „${label}“ angelegt`);
});

/** Listen / Märkte in den Einstellungen verwalten. */
function renderListsManage() {
  const ul = $('listsManage');
  const canDelete = state.lists.length > 1;
  ul.innerHTML = state.lists.map((l) => `<li data-id="${esc(l.id)}">
      <span class="e" aria-hidden="true">${esc(l.emoji)}</span>
      <span class="grow">${esc(l.name)}</span>
      <button type="button" class="row-btn" data-act="list-edit" aria-label="${esc(l.name)} umbenennen">✏️</button>
      ${canDelete ? `<button type="button" class="row-btn row-btn--danger" data-act="list-del" aria-label="${esc(l.name)} löschen">${ICON_TRASH}</button>` : ''}
    </li>`).join('');
}

$('listsManage').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('li').dataset.id;
  const listObj = state.lists.find((l) => l.id === id);
  if (!listObj) return;

  try {
    if (btn.dataset.act === 'list-edit') {
      const name = prompt('Neuer Name der Liste:', listObj.name);
      if (name === null || !squish(name)) return;
      const emoji = prompt('Emoji für die Liste:', listObj.emoji);
      const res = await api('PUT', `?action=lists&id=${encodeURIComponent(id)}`, {
        name: squish(name),
        emoji: squish(emoji ?? listObj.emoji) || listObj.emoji,
      });
      state.lists = res.lists;
      store.set(STORAGE_KEYS.lists, state.lists);
      renderListsManage();
      render();
    } else if (btn.dataset.act === 'list-del') {
      if (!confirm(`Liste „${listObj.name}“ und alle darin enthaltenen Artikel wirklich löschen?`)) return;
      const res = await api('DELETE', `?action=lists&id=${encodeURIComponent(id)}`);
      state.lists = res.lists;
      state.items = state.items.filter((i) => (i.list_id || DEFAULT_LIST_ID) !== id);
      if (state.activeList === id) state.activeList = state.lists[0]?.id || DEFAULT_LIST_ID;
      saveItems();
      store.set(STORAGE_KEYS.lists, state.lists);
      store.set(STORAGE_KEYS.activeList, state.activeList);
      renderListsManage();
      render();
      toast(`Liste „${listObj.name}“ gelöscht`);
    }
  } catch (err) {
    if (err.status === 401) { needLogin(); return; }
    toast(err.message);
  }
});

$('listAddForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = squish($('listAddName').value);
  const emoji = squish($('listAddEmoji').value) || '🏪';
  if (!name) return;
  try {
    const res = await api('POST', '?action=lists', { name, emoji });
    state.lists = res.lists;
    state.activeList = res.list.id;
    store.set(STORAGE_KEYS.lists, state.lists);
    store.set(STORAGE_KEYS.activeList, state.activeList);
    $('listAddName').value = '';
    $('listAddEmoji').value = '🏪';
    renderListsManage();
    render();
    toast(`Liste „${name}“ angelegt`);
  } catch (err) {
    if (err.status === 401) { needLogin(); return; }
    toast(err.message);
  }
});

/** Bekannte Artikel (Vorschläge) anzeigen & einzelne entfernen. */
function renderKnownList() {
  const ul = $('knownList');
  const q = lower($('knownFilter').value || '');
  const filtered = state.known
    .filter((k) => !q || lower(k.name).includes(q))
    .slice(0, 80);

  if (!filtered.length) {
    ul.innerHTML = '<li class="muted">Keine passenden Vorschläge.</li>';
    return;
  }
  ul.innerHTML = filtered.map((k) => `<li data-name="${esc(k.name)}">
      <span class="e" aria-hidden="true">${esc(catOf(k.category).emoji)}</span>
      <span class="grow">${esc(k.name)}<span class="sub">${k.uses}× genutzt</span></span>
      <button type="button" class="row-btn row-btn--danger" data-act="del-known" aria-label="${esc(k.name)} entfernen">${ICON_TRASH}</button>
    </li>`).join('');
}

$('knownFilter').addEventListener('input', renderKnownList);
$('knownList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act="del-known"]');
  if (!btn) return;
  const name = btn.closest('li').dataset.name;
  try {
    await api('DELETE', `?action=known&name=${encodeURIComponent(name)}`);
    state.known = state.known.filter((k) => lower(k.name) !== lower(name));
    rebuildKnown();
    store.set(STORAGE_KEYS.known, state.known);
    renderKnownList();
    renderSuggestions();
    toast(`Vorschlag „${name}“ entfernt`);
  } catch (err) {
    if (err.status === 401) { needLogin(); return; }
    toast(err.message);
  }
});

/** Familienmitglieder vom Server laden und anzeigen. */
async function loadMembers() {
  const ul = $('memberList');
  try {
    const { members } = await api('GET', '?action=members');
    ul.innerHTML = members.map(memberHtml).join('');
    paintAvatars(ul);
  } catch (err) {
    if (err.status === 401) { needLogin(); return; }
    const message = err.status === 0 ? 'Offline – Liste nicht verfügbar' : esc(err.message);
    ul.innerHTML = `<li class="muted">${message}</li>`;
  }
}

/** Eine Zeile der Mitgliederliste. Admins sehen bei anderen "Passwort" und 🗑. */
function memberHtml(member) {
  const me = state.me || {};
  const isSelf = member.id === me.id;

  const actions = (me.is_admin && !isSelf)
    ? `<button type="button" class="row-btn" data-act="reset">Passwort</button>
       <button type="button" class="row-btn row-btn--danger" data-act="remove" aria-label="${esc(member.name)} entfernen">${ICON_TRASH}</button>`
    : '';

  return `<li data-id="${member.id}" data-name="${esc(member.name)}">
        ${avatarHtml(member.name, 'avatar--sm')}
        <span class="grow">${esc(member.name)}${isSelf ? ' (du)' : ''}${member.is_admin ? '<span class="badge">Admin</span>' : ''}
          <span class="sub">zuletzt aktiv ${esc(relTime(member.last_seen))}</span></span>
        ${actions}
      </li>`;
}

// Admin-Knöpfe in der Mitgliederliste
$('memberList').addEventListener('click', async (e) => {
  const button = e.target.closest('[data-act]');
  if (!button) return;
  const li = button.closest('li');
  const id = Number(li.dataset.id);
  const name = li.dataset.name;

  try {
    if (button.dataset.act === 'reset') {
      await resetMemberPassword(id, name);
    } else if (button.dataset.act === 'remove') {
      await removeMember(id, name);
    }
  } catch (err) {
    if (err.status === 401) { needLogin(); return; }
    toast(err.message);
  }
});

let pwResetTarget = null;

/** Admin: Dialog zum Zurücksetzen eines Passworts öffnen (ohne Klartext-prompt). */
function resetMemberPassword(id, name) {
  pwResetTarget = { id, name };
  $('pwResetDesc').textContent = `Neues Passwort für ${name} festlegen. Alle anderen Geräte werden abgemeldet.`;
  $('pwResetInput').value = '';
  $('pwResetSheet').showModal();
  $('pwResetInput').focus();
}

$('pwResetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pwResetTarget) return;
  const password = $('pwResetInput').value;
  if (!password) return;
  try {
    await api('POST', '?action=password', { user_id: pwResetTarget.id, new: password });
    const name = pwResetTarget.name;
    pwResetTarget = null;
    $('pwResetForm').reset();
    $('pwResetSheet').close();
    toast(`Passwort von ${name} geändert`);
  } catch (err) {
    if (err.status === 401) { needLogin(); return; }
    toast(err.message);
  }
});

/** Admin: Mitglied entfernen. */
async function removeMember(id, name) {
  if (!confirm(`${name} wirklich aus der Familie entfernen? ${name} wird auf allen Geräten abgemeldet.`)) return;
  await api('DELETE', `?action=member&id=${id}`);
  toast(`${name} entfernt`);
  loadMembers();
}

/** Einstellungen öffnen (Tipp auf den Avatar oben rechts). */
function openSettings() {
  const me = state.me || { name: '?' };
  setAvatar($('meAvatar'), me.name);
  $('meName').textContent = me.name;
  $('meRole').textContent = me.is_admin ? 'Admin · kann Mitglieder verwalten' : 'Familienmitglied';
  $('pwUser').value = me.name; // verstecktes Feld – hilft Passwort-Managern
  $('memberList').innerHTML = '<li class="muted">Lade …</li>';
  $('wakeSec').hidden = !wake.supported;
  $('wakeToggle').checked = wake.enabled;
  renderListsManage();
  renderCatOrder();
  $('knownFilter').value = '';
  renderKnownList();
  $('settingsSheet').showModal();
  loadMembers();
}
$('settingsBtn').addEventListener('click', openSettings);

// Schalter "Bildschirm anlassen"
$('wakeToggle').addEventListener('change', (e) => {
  wake.enabled = e.target.checked;
  store.set(STORAGE_KEYS.wake, wake.enabled);
  if (wake.enabled) wakeOn(); else wakeOff();
});

// Eigenes Passwort ändern
$('pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '?action=password', { current: $('pwCurrent').value, new: $('pwNew').value });
    $('pwForm').reset();
    $('pwForm').closest('details').open = false; // Bereich wieder zuklappen
    toast('Passwort geändert – andere Geräte wurden abgemeldet');
  } catch (err) {
    if (err.status === 401) { needLogin(); return; }
    toast(err.message);
  }
});

/**
 * Abmelden.
 * Vorher werden wartende Änderungen noch gesendet. Danach wird die lokale
 * Kopie der Liste gelöscht, damit niemand sie auf diesem Gerät mehr sieht.
 */
async function logout() {
  const question = `${state.me ? state.me.name + ', wirklich' : 'Wirklich'} abmelden? Danach kann sich hier jemand anderes anmelden.`;
  if (!confirm(question)) return;

  await flush();
  try { await api('POST', '?action=logout'); } catch { /* offline – Cookie verfällt trotzdem nicht, ist aber egal */ }

  for (const key of [STORAGE_KEYS.items, STORAGE_KEYS.lists, STORAGE_KEYS.activeList, STORAGE_KEYS.templates, STORAGE_KEYS.known, STORAGE_KEYS.outbox, STORAGE_KEYS.me]) {
    store.del(key);
  }
  Object.assign(state, { items: [], lists: DEFAULT_LISTS, activeList: DEFAULT_LIST_ID, templates: [], known: [], outbox: [], me: null, rev: null, serverIds: null });
  expandedCarts.clear();
  disarm();
  resetComposer();
  $('headerAvatar').textContent = '';
  $('headerAvatar').style.removeProperty('--av');
  rebuildKnown();
  render();
  closeDialogs();

  $('loginName').value = '';
  setAuthMode('login');
  hideToast();
  needLogin();
}
$('logoutTop').addEventListener('click', logout);


/* ============================================================================
 *  14. Anmeldung & Registrierung
 * ========================================================================== */

let authMode   = 'login'; // 'login' (Anmelden) oder 'register' (Neu hier)
let authStatus = null;    // letzte Antwort von ?action=status

/** Schaltet den Anmeldebildschirm zwischen "Anmelden" und "Neu hier" um. */
function setAuthMode(mode) {
  authMode = mode;
  const isRegister = mode === 'register';

  // Reiter oben markieren
  for (const tab of $('modeSwitch').querySelectorAll('button')) {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  }

  // Familien-Code nur bei Registrierung
  $('codeField').hidden = !isRegister;
  $('regCode').required = isRegister;
  // Passwort-Manager: bei Registrierung ein neues Passwort vorschlagen
  $('loginPass').autocomplete = isRegister ? 'new-password' : 'current-password';
  $('loginPass').minLength = isRegister ? 6 : 0;
  $('loginSubmit').textContent = isRegister ? 'Account erstellen' : 'Anmelden';
  $('loginError').textContent = '';
  $('loginIntro').textContent = authIntroText(isRegister);
}

/** Erklärtext über dem Formular. */
function authIntroText(isRegister) {
  // Sonderfall: Es gibt noch gar keinen Account
  if (authStatus && !authStatus.has_users) {
    return authStatus.registration_open
      ? 'Willkommen! Lege den ersten Account an – er wird Admin.'
      : 'Noch kein Account vorhanden. Zuerst in config.php einen family_code eintragen.';
  }
  return isRegister
    ? 'Lege deinen eigenen Account an. Den Familien-Code bekommst du von dem, der die App eingerichtet hat.'
    : 'Melde dich mit deinem Familien-Account an.';
}

// Reiter "Anmelden" / "Neu hier"
$('modeSwitch').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-mode]');
  if (tab) setAuthMode(tab.dataset.mode);
});

/**
 * Anmeldebildschirm zeigen. Fragt vorher beim Server nach – vielleicht ist das
 * Cookie ja doch noch gültig (z. B. wenn nur der Browser-Speicher gelöscht wurde).
 */
async function needLogin() {
  if (state.loginVisible) return;
  state.loginVisible = true;
  closeDialogs();
  wakeOff();
  $('login').hidden = false;
  setAuthMode(authMode);

  try {
    authStatus = await api('GET', '?action=status');

    if (authStatus.user) {
      // Doch angemeldet -> direkt weiter
      setMe(authStatus.user);
      hideLogin();
      refresh();
      return;
    }

    // Reiter "Neu hier" nur zeigen, wenn Registrierung offen ist und es schon Accounts gibt
    // (beim allerersten Account gibt es nur "Registrieren").
    const canRegister = authStatus.registration_open;
    $('modeSwitch').hidden = !canRegister || !authStatus.has_users;

    let mode = authMode;
    if (!authStatus.has_users) mode = 'register';
    else if (!canRegister) mode = 'login';
    setAuthMode(mode);
  } catch {
    $('loginError').textContent = 'Server nicht erreichbar – bitte Verbindung prüfen.';
  }
}

/** Anmeldebildschirm ausblenden und Passwortfelder leeren. */
function hideLogin() {
  state.loginVisible = false;
  $('login').hidden = true;
  $('loginPass').value = '';
  $('regCode').value = '';
}

// Formular abgeschickt: anmelden bzw. registrieren
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('loginName').value.trim();
  const password = $('loginPass').value;
  if (!name || !password) return;

  const button = $('loginSubmit');
  button.disabled = true; // Doppelklick verhindern
  try {
    const result = authMode === 'register'
      ? await api('POST', '?action=register', { family_code: $('regCode').value.trim(), name, password })
      : await api('POST', '?action=login', { name, password });

    setMe(result.user);
    hideLogin();
    vibrate(15);
    if (authMode === 'register') toast(`Willkommen, ${result.user.name}!`);

    // Neuer Benutzer -> Server-Stand komplett neu laden
    state.rev = null;
    state.serverIds = null;
    await refresh();
    wakeOn();
  } catch (err) {
    showLoginError(err.message);
  } finally {
    button.disabled = false;
  }
});

/** Fehlermeldung zeigen und das Formular kurz "schütteln". */
function showLoginError(message) {
  $('loginError').textContent = message;
  const box = $('login');
  box.classList.remove('is-shake');
  void box.offsetWidth; // Animation neu starten (siehe highlight)
  box.classList.add('is-shake');
  vibrate([40, 60, 40]);
}


/* ============================================================================
 *  15. Bildschirm anlassen (Screen Wake Lock)
 * ============================================================================
 *
 * Beim Einkaufen nervt es, wenn das Handy ständig dunkel wird. Die Wake-Lock-
 * Schnittstelle hält den Bildschirm an – aber nur, solange die App sichtbar
 * ist, und hier zusätzlich nur bis 10 Minuten nach der letzten Berührung
 * (Akku sparen). Jede Berührung startet die 10 Minuten neu.
 */

const wake = {
  supported: 'wakeLock' in navigator,                 // kann der Browser das?
  enabled: store.get(STORAGE_KEYS.wake, true),         // Einstellung (Standard: an)
  lock: null,                                          // aktive Sperre
  pending: false,                                      // Anfrage läuft gerade
  timer: null,                                         // 10-Minuten-Timer
};

/** Bildschirm anlassen (bzw. die 10 Minuten neu starten). */
async function wakeOn() {
  if (!wake.supported || !wake.enabled || state.loginVisible || document.visibilityState !== 'visible') return;

  clearTimeout(wake.timer);
  wake.timer = setTimeout(wakeOff, WAKE_IDLE_MS);

  if (wake.lock || wake.pending) return; // schon aktiv
  wake.pending = true;
  try {
    wake.lock = await navigator.wakeLock.request('screen');
    // Der Browser hebt die Sperre selbst auf, z. B. beim App-Wechsel
    wake.lock.addEventListener('release', () => { wake.lock = null; });
  } catch {
    /* z. B. im Energiesparmodus verweigert – dann eben nicht */
  } finally {
    wake.pending = false;
  }
}

/** Bildschirm darf wieder ausgehen. */
function wakeOff() {
  clearTimeout(wake.timer);
  if (wake.lock) {
    wake.lock.release().catch(() => {});
    wake.lock = null;
  }
}

// Jede Berührung zählt als "Benutzer ist aktiv"
document.addEventListener('pointerdown', wakeOn, { passive: true });


/* ============================================================================
 *  16. Layout-Helfer
 * ========================================================================== */

// Bildschirmtastatur (vor allem iOS): Wie hoch ist sie? Das Ergebnis landet in
// der CSS-Variable --kb, damit die Eingabeleiste über der Tastatur bleibt.
if (window.visualViewport) {
  const viewport = window.visualViewport;
  const onViewportChange = () => {
    // Sichtbarer Bereich ist kleiner als das Fenster -> der Rest ist Tastatur
    const keyboard = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    // Unter 80 px ist es eher eine Browserleiste als eine Tastatur
    root.style.setProperty('--kb', keyboard > 80 ? `${Math.round(keyboard)}px` : '0px');
  };
  viewport.addEventListener('resize', onViewportChange);
  viewport.addEventListener('scroll', onViewportChange);
}

// Höhe der Kopfzeile als CSS-Variable --topbar-h (für klebende Überschriften)
const topbar = document.querySelector('.topbar');
if ('ResizeObserver' in window) {
  new ResizeObserver(() => root.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`)).observe(topbar);
}


/* ============================================================================
 *  17. Start der App
 * ========================================================================== */

// Sofort die gespeicherte Liste zeigen (auch offline) ...
if (state.me) setMe(state.me);
render();
updateComposerCat();

// ... und dann mit dem Server abgleichen bzw. zur Anmeldung.
if (state.me) refresh();
else needLogin();

// Adaptives Polling: aktiv alle 4 s, bei längerer Ruhepause sparsamer (12 s / 25 s).
function pollDelay() {
  const idle = Date.now() - lastActivity;
  if (idle > DEEP_IDLE_AFTER_MS) return POLL_DEEP_IDLE_MS;
  if (idle > IDLE_AFTER_MS) return POLL_IDLE_MS;
  return POLL_ACTIVE_MS;
}

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (document.visibilityState === 'visible') await refresh();
    schedulePoll();
  }, pollDelay());
}

function markActivity() {
  const wasSlow = Date.now() - lastActivity > IDLE_AFTER_MS;
  lastActivity = Date.now();
  if (wasSlow) schedulePoll();
}
document.addEventListener('pointerdown', markActivity, { passive: true });
document.addEventListener('keydown', markActivity, { passive: true });
schedulePoll();

// App wieder geöffnet / in den Vordergrund geholt -> sofort abgleichen
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    markActivity();
    refresh();
    wakeOn();
  }
});

// Netz kommt zurück / geht weg
window.addEventListener('online', () => { markActivity(); setOnline(true); refresh(); });
window.addEventListener('offline', () => setOnline(false));

// Start über die Verknüpfung "Artikel hinzufügen" (index.html?add=1): Eingabefeld fokussieren
if (new URLSearchParams(location.search).get('add') === '1') {
  setTimeout(() => { if (!state.loginVisible) input.focus(); }, 300);
}

// Service Worker registrieren (macht die App offline-fähig, siehe sw.js).
// Kommt eine neue Version, übernimmt der neue Service Worker die Kontrolle
// ("controllerchange") – dann bieten wir an, neu zu laden.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Beim allerersten Besuch gibt es noch keinen Service Worker. Dessen
    // erstmalige Übernahme ist kein "Update" -> dann keine Meldung.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service Worker:', err));
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('Neue Version verfügbar', 'Neu laden', () => location.reload(), 15000);
    });
  });
}
