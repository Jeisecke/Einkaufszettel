<?php
/**
 * ============================================================================
 *  Einkaufszettel – REST-API (PHP 8.x + SQLite)
 * ============================================================================
 *
 * Was ist das?
 *   Diese eine Datei ist das komplette "Backend" der App. Die App im Browser
 *   (app.js) schickt Anfragen hierher, diese Datei liest/schreibt die
 *   SQLite-Datenbank und antwortet immer mit JSON.
 *
 * Wie wird entschieden, was passiert?
 *   Über zwei Dinge:
 *     1. Die HTTP-Methode (GET = lesen, POST = anlegen, PUT = ändern, DELETE = löschen)
 *     2. Den URL-Parameter "action" (z. B. api.php?action=login)
 *   Ganz unten in der Datei steht das "Routing", das beides auswertet.
 *
 * Übersicht aller Anfragen
 * ------------------------
 * Accounts & Sitzungen
 *   GET    api.php?action=status            -> { user|null, has_users, registration_open }
 *   POST   api.php?action=register          -> { family_code, name, password }
 *   POST   api.php?action=login             -> { name, password }
 *   POST   api.php?action=logout
 *   GET    api.php?action=members           -> Familienmitglieder
 *   POST   api.php?action=password          -> { current, new }  bzw. als Admin { user_id, new }
 *   DELETE api.php?action=member&id=ID      -> Mitglied entfernen (nur Admin)
 *   PUT    api.php?action=categories        -> { order: [ids] }  Reihenfolge im Laden
 *
 * Artikel (nur angemeldet)
 *   GET    api.php[?since=REV]              -> { items, categories, known, me, rev } oder { unchanged, rev }
 *   POST   api.php                          -> { id?, name, quantity?, category?, checked? }  (Upsert per id)
 *   PUT    api.php?id=ID                    -> { name?, quantity?, category?, checked?, position? }
 *   DELETE api.php?id=ID
 *   DELETE api.php?checked=1                -> alle abgehakten löschen
 *   DELETE api.php?checked=1&checked_by=ID  -> nur den Wagen einer Person leeren (0 = ohne Person)
 *
 * Falls der Hoster PUT/DELETE blockiert: POST mit Header "X-HTTP-Method-Override: PUT|DELETE".
 *
 * Aufbau dieser Datei (von oben nach unten)
 * -----------------------------------------
 *   1. Grundeinstellungen & Konstanten
 *   2. Kleine Hilfsfunktionen (Antworten, Texte säubern, JSON lesen, Cookies)
 *   3. Datenbank (öffnen, Tabellen anlegen, alte Versionen migrieren)
 *   4. Änderungszähler ("rev")
 *   5. Brute-Force-Schutz (zu viele falsche Passwörter -> Sperre)
 *   6. Accounts & Sitzungen (Login, Registrierung, Passwort, Mitglieder)
 *   7. Kategorien
 *   8. Artikel (lesen, anlegen, ändern, löschen)
 *   9. Routing (welche Anfrage ruft welche Funktion auf)
 */

// Strenge Typprüfung: PHP wandelt z. B. "5" nicht still in 5 um, wenn eine
// Funktion einen int erwartet. Das deckt Fehler früh auf.
declare(strict_types=1);

// ============================================================================
//  1. Grundeinstellungen & Konstanten
// ============================================================================

// PHP-Fehlermeldungen NIE an den Browser schicken (könnten Pfade o. Ä. verraten).
// Sie landen stattdessen im Fehler-Log des Servers (in Plesk unter "Logs").
ini_set('display_errors', '0');
error_reporting(E_ALL);

// Jede Antwort dieser Datei ist JSON ...
header('Content-Type: application/json; charset=utf-8');
// ... und darf nirgends zwischengespeichert werden (sonst sähe man alte Listen).
header('Cache-Control: no-store, max-age=0');
// Browser soll den Content-Type nicht "erraten", sondern glauben.
header('X-Content-Type-Options: nosniff');

// Einstellungen laden (Familien-Code, Pfad zur Datenbank, Kategorien, ...).
// config.php gibt ein PHP-Array zurück.
$config = require __DIR__ . '/config.php';

const SESSION_COOKIE      = 'ekz_session'; // Name des Login-Cookies im Browser
const SESSION_DAYS        = 400;           // So lange bleibt man angemeldet (mehr akzeptieren Browser nicht)
const SESSION_RENEW_AFTER = 86400;         // Sitzung höchstens 1x pro Tag (86400 s) verlängern
const NAME_MAX            = 120;           // Max. Länge eines Artikelnamens
const QTY_MAX             = 30;            // Max. Länge der Mengenangabe ("500 g")
const NOTE_MAX            = 200;           // Max. Länge einer Artikel-Notiz
const LIST_NAME_MAX       = 40;            // Max. Länge eines Listennamens
const CAT_LABEL_MAX       = 40;            // Max. Länge eines Kategorienamens
const TEMPLATE_NAME_MAX   = 60;            // Max. Länge eines Vorlagennamens
const DEFAULT_LIST_ID     = 'default';     // Standard-Liste
const USER_NAME_MAX       = 32;            // Max. Länge eines Benutzernamens
const PASSWORD_MIN        = 6;             // Mindestlänge für Passwörter
const PASSWORD_MAX_BYTES  = 200;           // Obergrenze, damit niemand riesige Passwörter hashen lässt
const DAY                 = 86400;         // Ein Tag in Sekunden (zum besseren Lesen)


// ============================================================================
//  2. Kleine Hilfsfunktionen
// ============================================================================

/**
 * Schickt eine JSON-Antwort an den Browser und BEENDET das Skript.
 *
 * Wichtig zum Verständnis: Nach respond() läuft kein weiterer Code mehr
 * (wegen "exit"). Deshalb kann man respond()/fail() mitten in einer Funktion
 * aufrufen, ähnlich wie ein "return" für die ganze Anfrage.
 *
 * @param mixed $data   Beliebige Daten, werden zu JSON umgewandelt
 * @param int   $status HTTP-Statuscode (200 = OK, 201 = angelegt, 4xx = Fehler, ...)
 */
function respond(mixed $data, int $status = 200): never
{
    http_response_code($status);
    // JSON_UNESCAPED_UNICODE: Umlaute bleiben lesbar ("Käse" statt "Käse")
    // JSON_UNESCAPED_SLASHES: "/" wird nicht zu "\/"
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/**
 * Antwortet mit einer Fehlermeldung und beendet das Skript.
 * Die App zeigt den Text aus "error" direkt dem Benutzer an.
 *
 * @param string $message Verständliche Fehlermeldung (Deutsch)
 * @param int    $status  HTTP-Statuscode, z. B. 401 (nicht angemeldet), 422 (ungültige Eingabe)
 * @param array  $extra   Optionale weitere Felder in der Antwort
 */
function fail(string $message, int $status, array $extra = []): never
{
    respond(['error' => $message] + $extra, $status);
}

/**
 * Wandelt einen Text in Kleinbuchstaben um – auch Umlaute ("ÄPFEL" -> "äpfel").
 * mb_strtolower kann Umlaute, strtolower nicht. Falls die mbstring-Erweiterung
 * auf dem Server fehlt, nehmen wir notgedrungen die einfache Variante.
 */
function lower(string $s): string
{
    return function_exists('mb_strtolower') ? mb_strtolower($s, 'UTF-8') : strtolower($s);
}

/**
 * Zählt die ZEICHEN eines Textes (nicht Bytes). "Käse" hat 4 Zeichen,
 * aber 5 Bytes, weil "ä" in UTF-8 zwei Bytes braucht.
 */
/** Zählt die ZEICHEN eines Textes (nicht Bytes). */
function str_len(string $s): int
{
    return function_exists('mb_strlen') ? mb_strlen($s, 'UTF-8') : strlen($s);
}

/** Schneidet einen Text sicher auf maximal $max Zeichen zu. */
function str_cut(string $s, int $max): string
{
    return function_exists('mb_substr') ? mb_substr($s, 0, $max, 'UTF-8') : substr($s, 0, $max);
}

/**
 * Säubert eine Benutzereingabe:
 *   - Nicht-Text (Arrays, Objekte, null) wird zu ""
 *   - unsichtbare Steuerzeichen (Zeilenumbruch, Tab, ...) werden entfernt
 *   - mehrere Leerzeichen hintereinander werden zu einem
 *   - Leerzeichen am Anfang/Ende werden abgeschnitten
 *
 * Beispiel: "  2   Liter\tMilch " -> "2 Liter Milch"
 */
function clean_text(mixed $value): string
{
    // is_scalar = string, int, float oder bool. Alles andere ignorieren wir.
    if (!is_scalar($value)) {
        return '';
    }
    $text = (string)$value;

    // Steuerzeichen (ASCII 0–31 und 127) entfernen.
    // "?? ''" fängt den seltenen Fall ab, dass preg_replace bei kaputtem UTF-8 null liefert.
    $text = preg_replace('/[\x00-\x1F\x7F]/u', '', $text) ?? '';

    // Jede Folge von Leerraum durch genau ein Leerzeichen ersetzen.
    $text = preg_replace('/\s+/u', ' ', $text) ?? '';

    return trim($text);
}

/**
 * Liest den Inhalt (Body) der Anfrage als JSON und gibt ihn als PHP-Array zurück.
 *
 * Sicherheit: Wir akzeptieren NUR Anfragen mit "Content-Type: application/json".
 * Ein normales HTML-Formular auf einer fremden Webseite kann diesen Typ nicht
 * senden. Damit kann eine böse Seite nicht heimlich in deinem Namen Artikel
 * löschen (Schutz gegen sogenanntes CSRF).
 */
function read_json_body(): array
{
    // Je nach Server steht der Typ in einer von zwei Variablen.
    $type = $_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? '';
    if (stripos($type, 'application/json') !== 0) {
        fail('Content-Type muss application/json sein', 415);
    }

    // Rohen Text der Anfrage lesen.
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) {
        return []; // Leerer Body ist erlaubt -> leeres Array
    }

    // true = als assoziatives Array statt als Objekt dekodieren.
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        fail('Ungültiges JSON', 400);
    }
    return $data;
}

/**
 * Läuft die Seite gerade über HTTPS?
 * Wird gebraucht, damit das Login-Cookie als "Secure" markiert wird
 * (dann schickt der Browser es nie unverschlüsselt).
 * Drei Prüfungen, weil Server das unterschiedlich melden – z. B. wenn nginx
 * vor Apache sitzt (Plesk), steht es in X-Forwarded-Proto.
 */
function is_https(): bool
{
    $httpsFlag     = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
    $behindProxy   = ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
    $standardPort  = ($_SERVER['SERVER_PORT'] ?? '') === '443';
    return $httpsFlag || $behindProxy || $standardPort;
}

/**
 * Pfad, für den das Cookie gilt: der Ordner, in dem api.php liegt.
 * Beispiel: App liegt unter /einkauf/api.php -> Cookie-Pfad "/einkauf/".
 * So sieht eine andere App auf derselben Domain das Cookie nicht.
 */
function cookie_path(): string
{
    $scriptDir = dirname($_SERVER['SCRIPT_NAME'] ?? '/');  // z. B. "/einkauf"
    $scriptDir = str_replace('\\', '/', $scriptDir);       // Windows-Server: "\" -> "/"
    return rtrim($scriptDir, '/') . '/';                   // genau ein "/" am Ende
}

/**
 * Setzt (oder löscht) das Login-Cookie.
 *
 * @param string $value   Der geheime Sitzungs-Token ("" zum Löschen)
 * @param int    $expires Unix-Zeitstempel, wann das Cookie abläuft
 *                        (ein Zeitpunkt in der Vergangenheit löscht es)
 */
function set_session_cookie(string $value, int $expires): void
{
    setcookie(SESSION_COOKIE, $value, [
        'expires'  => $expires,
        'path'     => cookie_path(),
        'secure'   => is_https(), // nur über HTTPS senden (wenn verfügbar)
        'httponly' => true,       // JavaScript kann das Cookie NICHT lesen -> Schutz vor Diebstahl
        'samesite' => 'Lax',      // fremde Seiten können es bei eigenen Anfragen nicht mitschicken
    ]);
}


// ============================================================================
//  3. Datenbank
// ============================================================================

/**
 * Öffnet die SQLite-Datenbank und sorgt dafür, dass alle Tabellen existieren.
 * Beim allerersten Aufruf wird die Datei automatisch angelegt.
 *
 * Ablauf:
 *   1. Prüfen, ob PHP überhaupt SQLite kann
 *   2. Ordner anlegen und gegen Zugriff von außen schützen
 *   3. Datei öffnen
 *   4. Tabellen anlegen (falls noch nicht vorhanden)
 *   5. Ältere Datenbank-Versionen auf den aktuellen Stand bringen
 */
function db(array $config): PDO
{
    if (!extension_loaded('pdo_sqlite')) {
        fail('PHP-Erweiterung pdo_sqlite fehlt (in Plesk unter PHP-Einstellungen aktivieren)', 500);
    }

    $path = $config['db_path'];
    prepare_data_dir(dirname($path));

    $pdo = open_sqlite($path);

    // Wenn zwei Anfragen gleichzeitig schreiben wollen, wartet die zweite bis
    // zu 5 Sekunden, statt sofort mit "database is locked" abzubrechen.
    $pdo->exec('PRAGMA busy_timeout = 5000');

    create_tables($pdo);
    migrate_items_table($pdo);

    return $pdo;
}

/**
 * Legt den Datenbank-Ordner an (falls nötig) und legt zwei Schutzdateien hinein:
 *   - .htaccess mit "Require all denied" -> Apache liefert nichts aus diesem Ordner aus
 *   - leere index.html -> falls Ordner-Auflistung an ist, sieht man nur eine leere Seite
 * Das "@" unterdrückt Warnungen, falls das Schreiben nicht klappt (dann eben ohne).
 */
function prepare_data_dir(string $dir): void
{
    // 0750 = Besitzer darf alles, Gruppe lesen, alle anderen nichts.
    if (!is_dir($dir) && !@mkdir($dir, 0750, true)) {
        fail('Datenbank-Ordner konnte nicht angelegt werden: Schreibrechte prüfen', 500);
    }
    if (!file_exists($dir . '/.htaccess')) {
        @file_put_contents($dir . '/.htaccess', "Require all denied\n");
    }
    if (!file_exists($dir . '/index.html')) {
        @file_put_contents($dir . '/index.html', '');
    }
}

/**
 * Öffnet die Datenbankdatei über PDO (PHPs einheitliche Datenbank-Schnittstelle).
 * Bei einem Fehler wird der genaue Grund nur ins Server-Log geschrieben, der
 * Benutzer bekommt eine allgemeine Meldung.
 */
function open_sqlite(string $path): PDO
{
    try {
        return new PDO('sqlite:' . $path, null, null, [
            // Bei SQL-Fehlern eine Exception werfen statt still weiterzumachen
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            // Zeilen als ['spalte' => wert] zurückgeben
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
    } catch (PDOException $e) {
        error_log('Einkaufszettel DB: ' . $e->getMessage());
        fail('Datenbank konnte nicht geöffnet werden', 500);
    }
}

/**
 * Legt alle Tabellen an. "IF NOT EXISTS" bedeutet: Gibt es die Tabelle schon,
 * passiert nichts. Deshalb kann das bei jeder Anfrage gefahrlos laufen.
 *
 * Zeitangaben sind überall Unix-Zeitstempel (Sekunden seit 1.1.1970).
 */
function create_tables(PDO $pdo): void
{
    $pdo->exec("
        -- Die eigentliche Einkaufsliste: ein Eintrag pro Artikel
        CREATE TABLE IF NOT EXISTS items (
            id         TEXT PRIMARY KEY,                  -- zufällige ID (erzeugt die App)
            name       TEXT    NOT NULL,                  -- z. B. 'Milch'
            quantity   TEXT    NOT NULL DEFAULT '',       -- z. B. '2' oder '500 g' (freier Text)
            note       TEXT    NOT NULL DEFAULT '',       -- optionaler Hinweis, z. B. 'Bio'
            category   TEXT    NOT NULL DEFAULT 'sonstiges', -- Kategorie-ID
            list_id    TEXT    NOT NULL DEFAULT 'default',   -- Zugehörige Liste / Markt
            checked    INTEGER NOT NULL DEFAULT 0,        -- 1 = abgehakt (liegt im Wagen)
            created_at INTEGER NOT NULL,                  -- wann angelegt
            updated_at INTEGER NOT NULL,                  -- wann zuletzt geändert
            created_by INTEGER,                           -- users.id: wer hat es angelegt
            checked_by INTEGER,                           -- users.id: wer hat es abgehakt
            checked_at INTEGER,                           -- wann abgehakt
            position   REAL                               -- Reihenfolge innerhalb der Kategorie
        );

        -- Einkaufslisten / Märkte (z. B. Supermarkt, Drogerie, Baumarkt)
        CREATE TABLE IF NOT EXISTS lists (
            id       TEXT PRIMARY KEY,
            name     TEXT    NOT NULL,
            emoji    TEXT    NOT NULL DEFAULT '🛒',
            position INTEGER NOT NULL DEFAULT 0
        );

        -- Vorlagen / Rezepte (mehrere Artikel mit einem Tipp hinzufügen)
        CREATE TABLE IF NOT EXISTS templates (
            id         TEXT PRIMARY KEY,
            name       TEXT    NOT NULL,
            emoji      TEXT    NOT NULL DEFAULT '📋',
            items_json TEXT    NOT NULL,
            created_at INTEGER NOT NULL
        );

        -- Gedächtnis: welche Artikel gab es schon mal, in welcher Kategorie?
        -- Daraus entstehen die Vorschläge beim Tippen.
        CREATE TABLE IF NOT EXISTS known_items (
            name_key  TEXT PRIMARY KEY,                   -- Name in Kleinbuchstaben (zum Vergleichen)
            name      TEXT    NOT NULL,                   -- Name in Original-Schreibweise
            category  TEXT    NOT NULL,                   -- zuletzt verwendete Kategorie
            uses      INTEGER NOT NULL DEFAULT 1,         -- wie oft schon eingekauft
            last_used INTEGER NOT NULL                    -- wann zuletzt
        );

        -- Familienmitglieder (Accounts)
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            name          TEXT    NOT NULL,               -- Anzeigename, z. B. 'Anna'
            name_key      TEXT    NOT NULL UNIQUE,        -- 'anna' – verhindert 'Anna' und 'anna' doppelt
            password_hash TEXT    NOT NULL,               -- NIE das Passwort selbst, nur ein Hash
            is_admin      INTEGER NOT NULL DEFAULT 0,     -- 1 = darf andere verwalten
            created_at    INTEGER NOT NULL,
            last_seen     INTEGER NOT NULL
        );

        -- Angemeldete Geräte. Jedes Handy/jeder Browser hat eine eigene Sitzung.
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,                  -- SHA-256 des Cookie-Tokens (nicht der Token selbst!)
            user_id    INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            last_seen  INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,                  -- danach ist die Sitzung ungültig
            user_agent TEXT    NOT NULL DEFAULT ''        -- Browser-Kennung (nur zur Info)
        );
        CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

        -- Fehlgeschlagene Anmeldeversuche pro IP-Adresse (Brute-Force-Schutz)
        CREATE TABLE IF NOT EXISTS login_attempts (
            ip        TEXT PRIMARY KEY,
            fails     INTEGER NOT NULL,                   -- Anzahl Fehlversuche
            last_fail INTEGER NOT NULL                    -- Zeitpunkt des letzten Fehlversuchs
        );

        -- Kleine Schlüssel/Wert-Ablage für Sonstiges
        -- ('rev' = Änderungszähler, 'category_order' = Reihenfolge im Laden)
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    ");
}

/**
 * Bringt Datenbanken aus älteren App-Versionen auf den aktuellen Stand.
 *
 * Früher hatte die Tabelle "items" weniger Spalten. "CREATE TABLE IF NOT EXISTS"
 * ändert eine bestehende Tabelle nicht – also prüfen wir selbst, welche Spalten
 * fehlen, und fügen sie hinzu.
 */
function migrate_items_table(PDO $pdo): void
{
    // PRAGMA table_info liefert eine Zeile pro Spalte; wir brauchen nur die Namen.
    $existingColumns = array_column($pdo->query('PRAGMA table_info(items)')->fetchAll(), 'name');
    $hadPosition     = in_array('position', $existingColumns, true);

    $newColumns = [
        'created_by' => 'INTEGER',
        'checked_by' => 'INTEGER',
        'checked_at' => 'INTEGER',
        'position'   => 'REAL',
        'note'       => "TEXT NOT NULL DEFAULT ''",
        'list_id'    => "TEXT NOT NULL DEFAULT 'default'",
    ];
    foreach ($newColumns as $column => $type) {
        if (!in_array($column, $existingColumns, true)) {
            // Spaltenname und Typ stammen aus der festen Liste oben, nicht vom Benutzer.
            $pdo->exec("ALTER TABLE items ADD COLUMN $column $type");
        }
    }

    // Standard-Liste sicherstellen, falls Tabelle "lists" noch leer ist.
    if ((int)$pdo->query('SELECT COUNT(*) FROM lists')->fetchColumn() === 0) {
        $pdo->prepare('INSERT OR IGNORE INTO lists (id, name, emoji, position) VALUES (?, ?, ?, 0)')
            ->execute([DEFAULT_LIST_ID, 'Einkauf', '🛒']);
    }

    // Wurde die Spalte "position" gerade erst angelegt, ist sie überall leer.
    // Dann übernehmen wir die alte Sortierung (alphabetisch je Kategorie)
    // als Startreihenfolge: 1, 2, 3, ...
    if (!$hadPosition) {
        $update  = $pdo->prepare('UPDATE items SET position = ? WHERE id = ?');
        $counter = 0;
        $rows    = $pdo->query('SELECT id FROM items ORDER BY category, name COLLATE NOCASE')->fetchAll();
        foreach ($rows as $row) {
            $counter++;
            $update->execute([$counter, $row['id']]);
        }
    }
}

/** Liest einen Wert aus der meta-Tabelle (oder null, falls es ihn nicht gibt). */
function meta_get(PDO $pdo, string $key): ?string
{
    $stmt = $pdo->prepare('SELECT value FROM meta WHERE key = ?');
    $stmt->execute([$key]);
    $value = $stmt->fetchColumn();           // false = keine Zeile gefunden
    return $value === false ? null : (string)$value;
}

/** Speichert einen Wert in der meta-Tabelle (überschreibt einen alten Wert). */
function meta_set(PDO $pdo, string $key, string $value): void
{
    $pdo->prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')->execute([$key, $value]);
}


// ============================================================================
//  4. Änderungszähler ("rev" = Revision)
// ============================================================================
//
//  Die App fragt alle paar Sekunden nach, ob sich etwas geändert hat. Damit
//  dafür nicht jedes Mal die ganze Liste übertragen werden muss, gibt es einen
//  Zähler: Bei JEDER Änderung (Artikel angelegt, abgehakt, gelöscht, ...) wird
//  er um 1 erhöht. Die App schickt mit, welchen Stand sie kennt (?since=17).
//  Ist der Zähler immer noch 17, antworten wir nur kurz "unverändert".

/** Aktueller Stand des Änderungszählers. */
function current_rev(PDO $pdo): int
{
    return (int)(meta_get($pdo, 'rev') ?? 0);
}

/** Zähler um 1 erhöhen – nach jeder Änderung aufrufen! */
function bump_rev(PDO $pdo): int
{
    $pdo->exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('rev', '0')");
    $pdo->exec("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'rev'");
    return current_rev($pdo);
}


// ============================================================================
//  5. Brute-Force-Schutz
// ============================================================================
//
//  Damit niemand Passwörter oder den Familien-Code einfach durchprobieren kann:
//  Pro IP-Adresse zählen wir Fehlversuche. Nach "max_attempts" Fehlern (config.php)
//  ist diese IP für "lockout_minutes" gesperrt.

/** IP-Adresse des Besuchers. */
function client_ip(): string
{
    return (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown');
}

/**
 * Prüft, ob die aktuelle IP gerade gesperrt ist. Wenn ja: Fehler 429 und Ende.
 * Ist die Sperrzeit abgelaufen, wird der Zähler für diese IP zurückgesetzt.
 */
function check_lockout(array $config, PDO $pdo): void
{
    $ip             = client_ip();
    $lockoutSeconds = (int)$config['lockout_minutes'] * 60;
    $maxAttempts    = (int)$config['max_attempts'];

    $stmt = $pdo->prepare('SELECT fails, last_fail FROM login_attempts WHERE ip = ?');
    $stmt->execute([$ip]);
    $row = $stmt->fetch();
    if (!$row) {
        return; // keine Fehlversuche bekannt -> alles gut
    }

    $lockedUntil = (int)$row['last_fail'] + $lockoutSeconds;

    // Letzter Fehlversuch ist lange genug her -> Zähler vergessen
    if ($lockedUntil < time()) {
        $pdo->prepare('DELETE FROM login_attempts WHERE ip = ?')->execute([$ip]);
        return;
    }

    // Zu viele Fehlversuche -> gesperrt. Restzeit in Minuten (aufgerundet, mind. 1) nennen.
    if ((int)$row['fails'] >= $maxAttempts) {
        $minutesLeft = max(1, (int)ceil(($lockedUntil - time()) / 60));
        fail("Zu viele Fehlversuche. Bitte in {$minutesLeft} Min. erneut versuchen.", 429);
    }
}

/**
 * Merkt sich einen Fehlversuch für die aktuelle IP.
 *
 * Technik "erst UPDATE, dann INSERT": Gibt es schon eine Zeile für die IP,
 * erhöht das UPDATE den Zähler. Hat das UPDATE nichts getroffen (rowCount = 0),
 * legen wir eine neue Zeile an. (Funktioniert auch mit alten SQLite-Versionen.)
 */
function record_failure(PDO $pdo): void
{
    $ip  = client_ip();
    $upd = $pdo->prepare('UPDATE login_attempts SET fails = fails + 1, last_fail = ? WHERE ip = ?');
    $upd->execute([time(), $ip]);
    if ($upd->rowCount() === 0) {
        $pdo->prepare('INSERT INTO login_attempts (ip, fails, last_fail) VALUES (?, 1, ?)')->execute([$ip, time()]);
    }
    // 0,4 Sekunden warten: macht automatisiertes Durchprobieren zusätzlich langsam.
    usleep(400000);
}

/**
 * Nach erfolgreicher Anmeldung: Fehlversuche dieser IP löschen.
 * Nebenbei räumen wir Einträge auf, die älter als einen Tag sind.
 */
function clear_failures(PDO $pdo): void
{
    $pdo->prepare('DELETE FROM login_attempts WHERE ip = ? OR last_fail < ?')
        ->execute([client_ip(), time() - DAY]);
}


// ============================================================================
//  6. Accounts & Sitzungen
// ============================================================================
//
//  So funktioniert die Anmeldung:
//    1. Beim Login erzeugen wir einen langen Zufallswert (Token).
//    2. Der Token geht als Cookie an den Browser.
//    3. In der Datenbank speichern wir NUR einen Hash (Fingerabdruck) des Tokens.
//       Selbst wer die Datenbank klaut, kann sich damit nicht anmelden.
//    4. Bei jeder Anfrage schickt der Browser das Cookie mit; wir hashen es und
//       suchen die passende Sitzung.
//    5. Gleitendes Ablaufdatum: Wer die App benutzt, dessen Sitzung wird
//       (max. 1x pro Tag) wieder auf 400 Tage verlängert. Man bleibt also
//       praktisch für immer angemeldet, solange man die App ab und zu öffnet.

/** Nur die Benutzerdaten, die die App sehen darf (kein Passwort-Hash!). */
function public_user(array $user): array
{
    return [
        'id'       => (int)$user['id'],
        'name'     => $user['name'],
        'is_admin' => (bool)$user['is_admin'],
    ];
}

/**
 * Liest den Sitzungs-Token aus dem Cookie.
 * Ein gültiger Token besteht aus genau 64 Hex-Zeichen (0-9, a-f).
 * Alles andere wird als "kein Token" behandelt.
 */
function session_token(): ?string
{
    $token = $_COOKIE[SESSION_COOKIE] ?? null;
    if (is_string($token) && preg_match('/^[a-f0-9]{64}$/', $token)) {
        return $token;
    }
    return null;
}

/** Fingerabdruck (SHA-256) eines Tokens – so steht er in der Datenbank. */
function token_hash(string $token): string
{
    return hash('sha256', $token);
}

/**
 * Meldet einen Benutzer an: neue Sitzung anlegen und Cookie setzen.
 */
function start_session(PDO $pdo, int $userId): void
{
    $token     = bin2hex(random_bytes(32)); // 32 Zufallsbytes = 64 Hex-Zeichen
    $now       = time();
    $expires   = $now + SESSION_DAYS * DAY;
    $userAgent = substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255);

    $pdo->prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at, user_agent)
                   VALUES (?, ?, ?, ?, ?, ?)')
        ->execute([token_hash($token), $userId, $now, $now, $expires, $userAgent]);

    $pdo->prepare('UPDATE users SET last_seen = ? WHERE id = ?')->execute([$now, $userId]);

    // Gelegenheit nutzen, abgelaufene Sitzungen aufzuräumen.
    $pdo->prepare('DELETE FROM sessions WHERE expires_at < ?')->execute([$now]);

    set_session_cookie($token, $expires);
}

/**
 * Wer ist gerade angemeldet? Liefert den Benutzer oder null.
 * Verlängert dabei automatisch die Sitzung (siehe Erklärung oben, Punkt 5).
 *
 * "static $cache": Die Variable behält ihren Wert zwischen mehreren Aufrufen
 * innerhalb DERSELBEN Anfrage. So fragen wir die Datenbank nur einmal ab,
 * auch wenn current_user() mehrfach aufgerufen wird.
 * (false = "noch nicht nachgeschaut", null = "niemand angemeldet")
 */
function current_user(PDO $pdo): ?array
{
    static $cache = false;
    if ($cache !== false) {
        return $cache;
    }

    $token = session_token();
    if ($token === null) {
        return $cache = null;
    }

    $hash = token_hash($token);
    $now  = time();

    // Sitzung + zugehörigen Benutzer in einem Rutsch holen. Abgelaufene Sitzungen zählen nicht.
    $stmt = $pdo->prepare('
        SELECT s.last_seen AS session_last_seen, u.*
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?
    ');
    $stmt->execute([$hash, $now]);
    $row = $stmt->fetch();
    if (!$row) {
        return $cache = null;
    }

    // Letzte Verlängerung länger als einen Tag her? Dann jetzt verlängern.
    $needsRenewal = (int)$row['session_last_seen'] < $now - SESSION_RENEW_AFTER;
    if ($needsRenewal) {
        renew_session($pdo, $token, (int)$row['id'], $now);
    }

    return $cache = public_user($row);
}

/**
 * Schiebt das Ablaufdatum einer Sitzung wieder auf "jetzt + 400 Tage" –
 * in der Datenbank UND im Cookie.
 */
function renew_session(PDO $pdo, string $token, int $userId, int $now): void
{
    $expires = $now + SESSION_DAYS * DAY;
    $pdo->prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?')
        ->execute([$now, $expires, token_hash($token)]);
    $pdo->prepare('UPDATE users SET last_seen = ? WHERE id = ?')
        ->execute([$now, $userId]);
    set_session_cookie($token, $expires);
}

/** Wie current_user(), bricht aber mit Fehler 401 ab, wenn niemand angemeldet ist. */
function require_user(PDO $pdo): array
{
    $user = current_user($pdo);
    if (!$user) {
        fail('Nicht angemeldet', 401);
    }
    return $user;
}

/** Wie require_user(), verlangt aber zusätzlich Admin-Rechte (sonst Fehler 403). */
function require_admin(PDO $pdo): array
{
    $user = require_user($pdo);
    if (!$user['is_admin']) {
        fail('Nur für Admins', 403);
    }
    return $user;
}

/** Wie viele Accounts gibt es? (0 = App wird gerade zum ersten Mal eingerichtet) */
function user_count(PDO $pdo): int
{
    return (int)$pdo->query('SELECT COUNT(*) FROM users')->fetchColumn();
}

/** Prüft und säubert einen Benutzernamen. Bricht bei ungültigem Namen ab. */
function clean_user_name(mixed $value): string
{
    $name = clean_text($value);
    if ($name === '') {
        fail('Bitte einen Namen eingeben', 422);
    }
    if (str_len($name) > USER_NAME_MAX) {
        fail('Name ist zu lang (max. ' . USER_NAME_MAX . ' Zeichen)', 422);
    }
    return $name;
}

/**
 * Prüft ein NEUES Passwort auf Mindest- und Höchstlänge.
 * (Passwörter werden bewusst NICHT mit clean_text verändert – Leerzeichen
 * und Sonderzeichen gehören zum Passwort.)
 */
function check_password(mixed $value): string
{
    $password = is_string($value) ? $value : '';
    if (str_len($password) < PASSWORD_MIN) {
        fail('Passwort muss mindestens ' . PASSWORD_MIN . ' Zeichen haben', 422);
    }
    if (strlen($password) > PASSWORD_MAX_BYTES) {
        fail('Passwort ist zu lang', 422);
    }
    return $password;
}

/** Liest ein Feld aus dem Body nur, wenn es ein Text ist – sonst "". */
function body_string(array $body, string $key): string
{
    return is_string($body[$key] ?? null) ? $body[$key] : '';
}

/** Sucht einen Benutzer anhand des Namens (Groß-/Kleinschreibung egal). */
function find_user_by_name(PDO $pdo, string $name): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM users WHERE name_key = ?');
    $stmt->execute([lower($name)]);
    $user = $stmt->fetch();
    return $user ?: null;
}

/**
 * GET ?action=status
 * Wird beim Start der App aufgerufen: Bin ich angemeldet? Gibt es schon Accounts?
 * Ist die Registrierung offen? (Darf jeder aufrufen, auch ohne Login.)
 */
function handle_status(array $config, PDO $pdo): never
{
    respond([
        'user'              => current_user($pdo),          // null, wenn nicht angemeldet
        'has_users'         => user_count($pdo) > 0,        // false = allererster Start
        'registration_open' => (string)$config['family_code'] !== '',
    ]);
}

/**
 * POST ?action=register
 * Neuen Account anlegen. Erfordert den richtigen Familien-Code.
 * Der allererste Account wird automatisch Admin.
 */
function handle_register(array $config, PDO $pdo): never
{
    // Ist in config.php kein Code eingetragen, ist die Registrierung zu.
    $familyCode = (string)$config['family_code'];
    if ($familyCode === '') {
        fail('Registrierung ist gesperrt (family_code in config.php ist leer)', 403);
    }

    check_lockout($config, $pdo);
    $body = read_json_body();

    // hash_equals vergleicht in konstanter Zeit: Die Antwortdauer verrät nicht,
    // wie viele Zeichen des Codes schon richtig waren.
    $enteredCode = trim(body_string($body, 'family_code'));
    if (!hash_equals($familyCode, $enteredCode)) {
        record_failure($pdo);
        fail('Falscher Familien-Code', 403);
    }

    $name     = clean_user_name($body['name'] ?? '');
    $password = check_password($body['password'] ?? '');
    $hash     = password_hash($password, PASSWORD_DEFAULT);
    $now      = time();

    // Transaktion verhindert, dass zwei gleichzeitige Registrierungen denselben
    // Namen anlegen oder beide zum Admin werden.
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        if (find_user_by_name($pdo, $name)) {
            $pdo->exec('ROLLBACK');
            fail('Dieser Name ist schon vergeben – bitte anmelden', 409);
        }

        // Erster Account überhaupt? Dann Admin.
        $isAdmin = user_count($pdo) === 0;

        // password_hash erzeugt einen sicheren, gesalzenen Hash (aktuell bcrypt).
        $pdo->prepare('INSERT INTO users (name, name_key, password_hash, is_admin, created_at, last_seen)
                       VALUES (?, ?, ?, ?, ?, ?)')
            ->execute([$name, lower($name), $hash, $isAdmin ? 1 : 0, $now, $now]);
        $newUserId = (int)$pdo->lastInsertId();
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->exec('ROLLBACK');
        }
        throw $e;
    }

    clear_failures($pdo);
    start_session($pdo, $newUserId); // direkt angemeldet
    respond(['user' => ['id' => $newUserId, 'name' => $name, 'is_admin' => $isAdmin]], 201);
}

// Vorberechneter Dummy-Hash für fehlgeschlagene Logins unbekannter Namen (Timing-Schutz).
const DUMMY_PASSWORD_HASH = '$2y$10$usesomesillystringfore7hnbRJHxXVLeakoG8K30oukPsA.ztMG';

/**
 * POST ?action=login
 * Mit Name + Passwort anmelden.
 */
function handle_login(array $config, PDO $pdo): never
{
    check_lockout($config, $pdo);
    $body     = read_json_body();
    $name     = clean_text($body['name'] ?? '');
    $password = body_string($body, 'password');

    $user = find_user_by_name($pdo, $name);

    // Trick gegen "Benutzernamen erraten": Auch wenn es den Namen gar nicht gibt,
    // prüfen wir ein Passwort gegen einen vorberechneten Dummy-Hash. So dauert die
    // Antwort gleich lang und man kann an der Zeit nicht ablesen, ob der Name existiert.
    $hashToCheck = $user ? $user['password_hash'] : DUMMY_PASSWORD_HASH;
    $passwordOk  = strlen($password) <= PASSWORD_MAX_BYTES && password_verify($password, $hashToCheck);

    if (!$user || !$passwordOk) {
        record_failure($pdo);
        fail('Name oder Passwort falsch', 401); // bewusst nicht verraten, WAS falsch war
    }

    // Wurde der Hash mit einem älteren Verfahren erstellt? Dann jetzt neu hashen.
    // (Das geht nur hier, weil wir nur beim Login das Klartext-Passwort kennen.)
    if (password_needs_rehash($user['password_hash'], PASSWORD_DEFAULT)) {
        $pdo->prepare('UPDATE users SET password_hash = ? WHERE id = ?')
            ->execute([password_hash($password, PASSWORD_DEFAULT), $user['id']]);
    }

    clear_failures($pdo);
    start_session($pdo, (int)$user['id']);
    respond(['user' => public_user($user)]);
}

/**
 * POST ?action=logout
 * Sitzung dieses Geräts löschen und Cookie entfernen.
 * Andere Geräte desselben Benutzers bleiben angemeldet.
 */
function handle_logout(PDO $pdo): never
{
    $token = session_token();
    if ($token !== null) {
        $pdo->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([token_hash($token)]);
    }
    // Cookie löschen = Cookie mit Ablaufdatum in der Vergangenheit setzen.
    set_session_cookie('', time() - 3600);
    respond(['ok' => true]);
}

/**
 * GET ?action=members
 * Liste aller Familienmitglieder (für die Einstellungen).
 */
function handle_members(PDO $pdo): never
{
    require_user($pdo);
    $rows = $pdo->query('SELECT id, name, is_admin, created_at, last_seen FROM users ORDER BY name_key')->fetchAll();

    $members = [];
    foreach ($rows as $row) {
        $members[] = [
            'id'         => (int)$row['id'],
            'name'       => $row['name'],
            'is_admin'   => (bool)$row['is_admin'],
            'created_at' => (int)$row['created_at'],
            'last_seen'  => (int)$row['last_seen'],
        ];
    }
    respond(['members' => $members]);
}

/**
 * POST ?action=password
 * Zwei Fälle:
 *   a) Eigenes Passwort ändern:      { current: "alt", new: "neu" }
 *   b) Admin setzt fremdes zurück:   { user_id: 5, new: "neu" }  (kein altes Passwort nötig)
 * Danach werden alle ANDEREN Geräte des betroffenen Accounts abgemeldet.
 */
function handle_password(PDO $pdo): never
{
    $me          = require_user($pdo);
    $body        = read_json_body();
    $targetId    = isset($body['user_id']) ? (int)$body['user_id'] : $me['id'];
    $newPassword = check_password($body['new'] ?? '');
    $isOwn       = $targetId === $me['id'];

    if ($isOwn) {
        // Eigenes Passwort: altes Passwort muss stimmen
        verify_current_password($pdo, $me['id'], body_string($body, 'current'));
    } elseif (!$me['is_admin']) {
        // Fremdes Passwort: nur Admins
        fail('Nur für Admins', 403);
    }

    $upd = $pdo->prepare('UPDATE users SET password_hash = ? WHERE id = ?');
    $upd->execute([password_hash($newPassword, PASSWORD_DEFAULT), $targetId]);
    if ($upd->rowCount() === 0) {
        fail('Mitglied nicht gefunden', 404);
    }

    // Alle Sitzungen des Accounts löschen – außer der Sitzung, von der diese
    // Anfrage kommt (sonst würde man sich selbst rauswerfen).
    $currentToken = session_token();
    $keepHash     = $currentToken ? token_hash($currentToken) : '';
    $pdo->prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
        ->execute([$targetId, $keepHash]);

    respond(['ok' => true]);
}

/** Bricht mit Fehler ab, wenn das eingegebene aktuelle Passwort nicht stimmt. */
function verify_current_password(PDO $pdo, int $userId, string $entered): void
{
    $stmt = $pdo->prepare('SELECT password_hash FROM users WHERE id = ?');
    $stmt->execute([$userId]);
    $storedHash = (string)$stmt->fetchColumn();
    if (!password_verify($entered, $storedHash)) {
        fail('Aktuelles Passwort ist falsch', 403);
    }
}

/**
 * DELETE ?action=member&id=ID
 * Admin entfernt ein Familienmitglied (und meldet alle seine Geräte ab).
 * Die Artikel, die diese Person angelegt hat, bleiben erhalten.
 */
function handle_member_delete(PDO $pdo): never
{
    $me = require_admin($pdo);
    $id = (int)($_GET['id'] ?? 0);
    if ($id <= 0) {
        fail('Ungültige Mitglieder-ID', 400);
    }
    if ($id === $me['id']) {
        fail('Du kannst dich nicht selbst entfernen', 422);
    }
    $pdo->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$id]);
    $del = $pdo->prepare('DELETE FROM users WHERE id = ?');
    $del->execute([$id]);
    $deleted = $del->rowCount();
    if ($deleted > 0) {
        bump_rev($pdo);
    }
    respond(['deleted' => $deleted]);
}


// ============================================================================
//  7. Kategorien, Listen & Vorlagen
// ============================================================================

/** Basis-Kategorien: aus der Datenbank (in der App angepasst) oder config.php. */
function base_categories(array $config, PDO $pdo): array
{
    $custom = json_decode(meta_get($pdo, 'categories_custom') ?? '', true);
    if (is_array($custom) && count($custom) > 0) {
        $hasFallback = in_array('sonstiges', array_column($custom, 'id'), true);
        if ($hasFallback) {
            return $custom;
        }
    }
    return $config['categories'];
}

/**
 * Alle Kategorien in der gespeicherten Reihenfolge.
 */
function categories(array $config, PDO $pdo): array
{
    $categories = base_categories($config, $pdo);

    $savedOrder = json_decode(meta_get($pdo, 'category_order') ?? '[]', true);
    if (!is_array($savedOrder) || !$savedOrder) {
        return $categories;
    }

    $rankInSaved  = array_flip(array_values(array_filter($savedOrder, 'is_string')));
    $rankInConfig = array_flip(array_column($categories, 'id'));
    $sortKey = fn(array $cat): int => $rankInSaved[$cat['id']] ?? 1000 + $rankInConfig[$cat['id']];

    usort($categories, fn($a, $b) => $sortKey($a) <=> $sortKey($b));
    return $categories;
}

/**
 * PUT ?action=categories
 *   a) Reihenfolge: { order: ["obst", "brot", ...] }
 *   b) Komplett bearbeiten: { categories: [{ id, label, emoji }, ...] }
 */
function handle_category_order(array $config, PDO $pdo): never
{
    require_user($pdo);
    $body = read_json_body();

    if (isset($body['categories']) && is_array($body['categories'])) {
        $cleaned = [];
        $seen    = [];
        foreach ($body['categories'] as $entry) {
            if (!is_array($entry)) {
                continue;
            }
            $label = clean_text($entry['label'] ?? '');
            if ($label === '') {
                continue;
            }
            if (str_len($label) > CAT_LABEL_MAX) {
                fail('Kategoriename ist zu lang (max. ' . CAT_LABEL_MAX . ' Zeichen)', 422);
            }
            $emoji = clean_text($entry['emoji'] ?? '');
            if ($emoji === '' || str_len($emoji) > 12) {
                $emoji = '🏷️';
            }
            $rawId = is_string($entry['id'] ?? null) ? trim($entry['id']) : '';
            if (!preg_match('/^[a-z0-9_-]{1,32}$/', $rawId)) {
                $rawId = 'cat_' . bin2hex(random_bytes(4));
            }
            if (isset($seen[$rawId])) {
                continue;
            }
            $seen[$rawId] = true;
            $cleaned[] = ['id' => $rawId, 'label' => $label, 'emoji' => $emoji];
        }

        if (!isset($seen['sonstiges'])) {
            $cleaned[] = ['id' => 'sonstiges', 'label' => 'Sonstiges', 'emoji' => '🛒'];
        }

        $validIds = array_column($cleaned, 'id');
        meta_set($pdo, 'categories_custom', json_encode($cleaned, JSON_UNESCAPED_UNICODE));
        meta_set($pdo, 'category_order', json_encode($validIds));

        // Artikel gelöschter Kategorien sauber auf "sonstiges" umhängen
        $placeholders = implode(',', array_fill(0, count($validIds), '?'));
        $pdo->prepare("UPDATE items SET category = 'sonstiges' WHERE category NOT IN ($placeholders)")
            ->execute($validIds);
        $pdo->prepare("UPDATE known_items SET category = 'sonstiges' WHERE category NOT IN ($placeholders)")
            ->execute($validIds);

        bump_rev($pdo);
        respond(['categories' => categories($config, $pdo)]);
    }

    if (!isset($body['order']) || !is_array($body['order'])) {
        fail('order oder categories muss eine Liste sein', 422);
    }
    $validIds = array_column(base_categories($config, $pdo), 'id');

    $order = [];
    foreach ($body['order'] as $id) {
        $isValid     = is_string($id) && in_array($id, $validIds, true);
        $isDuplicate = in_array($id, $order, true);
        if ($isValid && !$isDuplicate) {
            $order[] = $id;
        }
    }

    meta_set($pdo, 'category_order', json_encode($order));
    bump_rev($pdo);
    respond(['categories' => categories($config, $pdo)]);
}

/** Gibt die Kategorie-ID zurück, wenn sie gültig ist – sonst "sonstiges". */
function clean_category(array $config, PDO $pdo, mixed $category): string
{
    $validIds = array_column(base_categories($config, $pdo), 'id');
    return (is_string($category) && in_array($category, $validIds, true)) ? $category : 'sonstiges';
}

// --- Listen / Märkte --------------------------------------------------------

function lists_all(PDO $pdo): array
{
    $rows = $pdo->query('SELECT id, name, emoji, position FROM lists ORDER BY position, name COLLATE NOCASE')->fetchAll();
    foreach ($rows as $i => $row) {
        $rows[$i]['position'] = (int)$row['position'];
    }
    return $rows;
}

function valid_list_id(PDO $pdo, mixed $value): string
{
    if (is_string($value) && preg_match('/^[A-Za-z0-9_-]{1,64}$/', $value)) {
        $stmt = $pdo->prepare('SELECT id FROM lists WHERE id = ?');
        $stmt->execute([$value]);
        if ($stmt->fetchColumn() !== false) {
            return $value;
        }
    }
    $first = $pdo->query('SELECT id FROM lists ORDER BY position, name COLLATE NOCASE LIMIT 1')->fetchColumn();
    return $first !== false ? (string)$first : DEFAULT_LIST_ID;
}

function handle_list_create(PDO $pdo): never
{
    require_user($pdo);
    $body  = read_json_body();
    $name  = clean_text($body['name'] ?? '');
    if ($name === '') {
        fail('Listenname darf nicht leer sein', 422);
    }
    if (str_len($name) > LIST_NAME_MAX) {
        fail('Listenname ist zu lang (max. ' . LIST_NAME_MAX . ' Zeichen)', 422);
    }
    $emoji = clean_text($body['emoji'] ?? '');
    if ($emoji === '' || str_len($emoji) > 12) {
        $emoji = '🛒';
    }
    $id  = 'lst_' . bin2hex(random_bytes(6));
    $pos = (int)$pdo->query('SELECT COALESCE(MAX(position), -1) + 1 FROM lists')->fetchColumn();
    $pdo->prepare('INSERT INTO lists (id, name, emoji, position) VALUES (?, ?, ?, ?)')
        ->execute([$id, $name, $emoji, $pos]);
    bump_rev($pdo);
    respond(['list' => ['id' => $id, 'name' => $name, 'emoji' => $emoji, 'position' => $pos], 'lists' => lists_all($pdo)], 201);
}

function handle_list_update(PDO $pdo): never
{
    require_user($pdo);
    $id   = require_id();
    $body = read_json_body();
    $stmt = $pdo->prepare('SELECT * FROM lists WHERE id = ?');
    $stmt->execute([$id]);
    $current = $stmt->fetch();
    if (!$current) {
        fail('Liste nicht gefunden', 404);
    }

    $name  = array_key_exists('name', $body) ? clean_text($body['name']) : $current['name'];
    if ($name === '' || str_len($name) > LIST_NAME_MAX) {
        fail('Ungültiger Listenname', 422);
    }
    $emoji = array_key_exists('emoji', $body) ? clean_text($body['emoji']) : $current['emoji'];
    if ($emoji === '' || str_len($emoji) > 12) {
        $emoji = '🛒';
    }
    $pdo->prepare('UPDATE lists SET name = ?, emoji = ? WHERE id = ?')->execute([$name, $emoji, $id]);
    bump_rev($pdo);
    respond(['lists' => lists_all($pdo)]);
}

function handle_list_delete(PDO $pdo): never
{
    require_user($pdo);
    $id = require_id();
    if ((int)$pdo->query('SELECT COUNT(*) FROM lists')->fetchColumn() <= 1) {
        fail('Die letzte Liste kann nicht gelöscht werden', 422);
    }
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $pdo->prepare('DELETE FROM items WHERE list_id = ?')->execute([$id]);
        $del = $pdo->prepare('DELETE FROM lists WHERE id = ?');
        $del->execute([$id]);
        $deleted = $del->rowCount();
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->exec('ROLLBACK');
        }
        throw $e;
    }
    if ($deleted > 0) {
        bump_rev($pdo);
    }
    respond(['deleted' => $deleted, 'lists' => lists_all($pdo)]);
}

// --- Vorlagen / Rezepte -----------------------------------------------------

function templates_all(PDO $pdo): array
{
    $rows = $pdo->query('SELECT id, name, emoji, items_json, created_at FROM templates ORDER BY name COLLATE NOCASE')->fetchAll();
    $result = [];
    foreach ($rows as $row) {
        $items = json_decode($row['items_json'], true);
        $result[] = [
            'id'         => $row['id'],
            'name'       => $row['name'],
            'emoji'      => $row['emoji'],
            'items'      => is_array($items) ? $items : [],
            'created_at' => (int)$row['created_at'],
        ];
    }
    return $result;
}

function handle_template_save(array $config, PDO $pdo): never
{
    require_user($pdo);
    $body = read_json_body();
    $name = clean_text($body['name'] ?? '');
    if ($name === '') {
        fail('Vorlagenname darf nicht leer sein', 422);
    }
    if (str_len($name) > TEMPLATE_NAME_MAX) {
        fail('Vorlagenname ist zu lang (max. ' . TEMPLATE_NAME_MAX . ' Zeichen)', 422);
    }
    $emoji = clean_text($body['emoji'] ?? '');
    if ($emoji === '' || str_len($emoji) > 12) {
        $emoji = '📋';
    }
    $rawItems = $body['items'] ?? null;
    if (!is_array($rawItems) || count($rawItems) === 0) {
        fail('Vorlage muss mindestens einen Artikel enthalten', 422);
    }

    $items = [];
    foreach (array_slice($rawItems, 0, 100) as $entry) {
        if (!is_array($entry)) {
            continue;
        }
        $itemName = clean_text($entry['name'] ?? '');
        if ($itemName === '') {
            continue;
        }
        $items[] = [
            'name'     => str_cut($itemName, NAME_MAX),
            'quantity' => str_cut(clean_text($entry['quantity'] ?? ''), QTY_MAX),
            'note'     => str_cut(clean_text($entry['note'] ?? ''), NOTE_MAX),
            'category' => clean_category($config, $pdo, $entry['category'] ?? ''),
        ];
    }
    if (!$items) {
        fail('Vorlage muss mindestens einen gültigen Artikel enthalten', 422);
    }

    $id = body_string($body, 'id');
    if (!preg_match('/^[A-Za-z0-9_-]{6,64}$/', $id)) {
        $id = 'tpl_' . bin2hex(random_bytes(8));
    }

    $json = json_encode($items, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $pdo->prepare('INSERT OR REPLACE INTO templates (id, name, emoji, items_json, created_at) VALUES (?, ?, ?, ?, ?)')
        ->execute([$id, $name, $emoji, $json, time()]);

    bump_rev($pdo);
    respond(['templates' => templates_all($pdo)], 201);
}

function handle_template_delete(PDO $pdo): never
{
    require_user($pdo);
    $id  = require_id();
    $del = $pdo->prepare('DELETE FROM templates WHERE id = ?');
    $del->execute([$id]);
    $deleted = $del->rowCount();
    if ($deleted > 0) {
        bump_rev($pdo);
    }
    respond(['deleted' => $deleted, 'templates' => templates_all($pdo)]);
}

// --- Bekannte Artikel pflegen -----------------------------------------------

function handle_known_delete(PDO $pdo): never
{
    require_user($pdo);
    $name = clean_text($_GET['name'] ?? '');
    if ($name === '') {
        fail('Name fehlt', 400);
    }
    $del = $pdo->prepare('DELETE FROM known_items WHERE name_key = ?');
    $del->execute([lower($name)]);
    $deleted = $del->rowCount();
    if ($deleted > 0) {
        bump_rev($pdo);
    }
    respond(['deleted' => $deleted]);
}


// ============================================================================
//  8. Artikel
// ============================================================================

/**
 * Basis-Abfrage für Artikel.
 * Die Tabelle items speichert nur die Benutzer-IDs (created_by, checked_by).
 * Für die Anzeige ("von Anna", "abgehakt von Ben") holen wir per LEFT JOIN
 * die Namen dazu. LEFT JOIN heißt: Artikel ohne (oder mit gelöschtem)
 * Benutzer erscheinen trotzdem, nur eben ohne Namen.
 */
const ITEM_SELECT = 'SELECT i.*, creator.name AS created_by_name, checker.name AS checked_by_name
    FROM items i
    LEFT JOIN users creator ON creator.id = i.created_by
    LEFT JOIN users checker ON checker.id = i.checked_by';

/** Prüft und säubert einen Artikelnamen. Bricht bei leerem/zu langem Namen ab. */
function clean_name(mixed $name): string
{
    $name = clean_text($name);
    if ($name === '') {
        fail('Name darf nicht leer sein', 422);
    }
    if (str_len($name) > NAME_MAX) {
        fail('Name ist zu lang (max. ' . NAME_MAX . ' Zeichen)', 422);
    }
    return $name;
}

/** Prüft und säubert eine Mengenangabe (darf leer sein). */
function clean_quantity(mixed $quantity): string
{
    $quantity = clean_text($quantity);
    if (str_len($quantity) > QTY_MAX) {
        fail('Menge ist zu lang (max. ' . QTY_MAX . ' Zeichen)', 422);
    }
    return $quantity;
}

/** Prüft und säubert eine optionale Notiz (darf leer sein). */
function clean_note(mixed $note): string
{
    $note = clean_text($note);
    if (str_len($note) > NOTE_MAX) {
        fail('Notiz ist zu lang (max. ' . NOTE_MAX . ' Zeichen)', 422);
    }
    return $note;
}

/**
 * Prüft eine Sortier-Position. Erlaubt sind nur echte Zahlen (auch Kommazahlen).
 * Gibt null zurück, wenn der Wert unbrauchbar ist.
 *
 * Warum Kommazahlen? Schiebt man einen Artikel zwischen Position 3 und 4,
 * bekommt er einfach 3.5 – so muss man keine anderen Artikel umnummerieren.
 */
function clean_position(mixed $value): ?float
{
    if (!is_int($value) && !is_float($value)) {
        return null;
    }
    $number = (float)$value;
    // is_finite schließt "unendlich" und "keine Zahl" (NaN) aus.
    return is_finite($number) ? $number : null;
}

/**
 * Gibt die ID zurück, wenn es ein existierendes Familienmitglied mit dieser
 * ID gibt – sonst null.
 * Wird beim "Rückgängig" gebraucht: Dann schickt die App mit, wer den Artikel
 * ursprünglich angelegt/abgehakt hatte, und wir übernehmen das – aber nur,
 * wenn es die Person wirklich gibt.
 */
function existing_user_id(PDO $pdo, mixed $value): ?int
{
    if (!is_int($value) || $value <= 0) {
        return null;
    }
    $stmt = $pdo->prepare('SELECT id FROM users WHERE id = ?');
    $stmt->execute([$value]);
    $id = $stmt->fetchColumn();
    return $id === false ? null : (int)$id;
}

/** Position für einen neuen Artikel: hinter dem letzten Artikel seiner Kategorie. */
function next_position(PDO $pdo, string $category, string $listId = DEFAULT_LIST_ID): float
{
    $stmt = $pdo->prepare('SELECT COALESCE(MAX(position), 0) + 1 FROM items WHERE category = ? AND list_id = ?');
    $stmt->execute([$category, $listId]);
    return (float)$stmt->fetchColumn();
}

/**
 * Wandelt eine Datenbankzeile in das Format um, das die App erwartet.
 * SQLite liefert alles als Text – hier machen wir daraus richtige Typen
 * (Zahl, true/false, null).
 */
function format_item(array $row): array
{
    // Kleine Helfer: Wert in int/float umwandeln, aber null bleibt null.
    $intOrNull   = fn($v) => $v !== null ? (int)$v : null;
    $floatOrNull = fn($v) => $v !== null ? (float)$v : null;

    return [
        'id'              => $row['id'],
        'name'            => $row['name'],
        'quantity'        => $row['quantity'],
        'note'            => $row['note'] ?? '',
        'category'        => $row['category'],
        'list_id'         => $row['list_id'] ?? DEFAULT_LIST_ID,
        'checked'         => (bool)$row['checked'],
        'created_at'      => (int)$row['created_at'],
        'updated_at'      => (int)$row['updated_at'],
        'created_by'      => $intOrNull($row['created_by']),
        'created_by_name' => $row['created_by_name'] ?? null,
        'checked_by'      => $intOrNull($row['checked_by']),
        'checked_by_name' => $row['checked_by_name'] ?? null,
        'checked_at'      => $intOrNull($row['checked_at']),
        'position'        => $floatOrNull($row['position']),
    ];
}

/** Holt einen einzelnen Artikel (fertig formatiert) oder null. */
function find_item(PDO $pdo, string $id): ?array
{
    $stmt = $pdo->prepare(ITEM_SELECT . ' WHERE i.id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ? format_item($row) : null;
}

/**
 * Merkt sich einen Artikel im "Gedächtnis" (Tabelle known_items) für Vorschläge
 * und automatische Kategorie-Erkennung.
 *
 * @param bool $countUse true = als "einmal mehr verwendet" zählen (beim Anlegen),
 *                       false = nur Name/Kategorie aktualisieren (beim Bearbeiten)
 *
 * Bewusst "erst UPDATE, dann INSERT" statt "ON CONFLICT DO UPDATE",
 * damit es auch mit älteren SQLite-Versionen beim Hoster läuft.
 */
function remember_item(PDO $pdo, string $name, string $category, bool $countUse): void
{
    $key = lower($name);
    $upd = $pdo->prepare('UPDATE known_items SET name = ?, category = ?, uses = uses + ?, last_used = ? WHERE name_key = ?');
    $upd->execute([$name, $category, $countUse ? 1 : 0, time(), $key]);
    if ($upd->rowCount() === 0) {
        $pdo->prepare('INSERT OR IGNORE INTO known_items (name_key, name, category, uses, last_used) VALUES (?, ?, ?, 1, ?)')
            ->execute([$key, $name, $category, time()]);
    }
}

/**
 * Liest die Artikel-ID aus der URL (?id=...). Erlaubt sind nur Buchstaben,
 * Ziffern, "_" und "-" (1–64 Zeichen). Sonst Fehler 400.
 */
function require_id(): string
{
    $id = $_GET['id'] ?? '';
    if (!is_string($id) || !preg_match('/^[A-Za-z0-9_-]{1,64}$/', $id)) {
        fail('Ungültige oder fehlende id', 400);
    }
    return $id;
}

// ----------------------------------------------------------------------------
//  Artikel lesen: GET api.php[?since=REV]
// ----------------------------------------------------------------------------

/**
 * Liefert die komplette Liste – oder nur "unverändert", wenn die App schon
 * den aktuellen Stand hat (siehe Abschnitt 4, Änderungszähler).
 */
function list_all(array $config, PDO $pdo, array $me): never
{
    $rev = current_rev($pdo);

    if (client_knows_rev($rev)) {
        respond(['unchanged' => true, 'rev' => $rev, 'me' => $me]);
    }

    $items = array_map('format_item', $pdo->query(ITEM_SELECT . ' ORDER BY i.created_at')->fetchAll());

    respond([
        'items'      => $items,                     // alle Artikel
        'lists'      => lists_all($pdo),            // Einkaufslisten / Märkte
        'categories' => categories($config, $pdo),  // Kategorien in Laden-Reihenfolge
        'templates'  => templates_all($pdo),        // Vorlagen / Rezepte
        'known'      => known_items($pdo),          // fürs Vorschlagen beim Tippen
        'me'         => $me,                        // wer bin ich
        'rev'        => $rev,                       // aktueller Stand
    ]);
}

/** Hat die App mit ?since=... genau den aktuellen Stand angegeben? */
function client_knows_rev(int $rev): bool
{
    $since = $_GET['since'] ?? null;
    // ctype_digit: nur Ziffern (schützt vor Unsinn wie "abc" oder "-1")
    return is_string($since) && ctype_digit($since) && (int)$since === $rev;
}

/** Die 500 meistgenutzten bekannten Artikel (für Vorschläge). */
function known_items(PDO $pdo): array
{
    $rows = $pdo->query('SELECT name, category, uses FROM known_items ORDER BY uses DESC, last_used DESC LIMIT 500')->fetchAll();
    foreach ($rows as $i => $row) {
        $rows[$i]['uses'] = (int)$row['uses'];
    }
    return $rows;
}

// ----------------------------------------------------------------------------
//  Artikel anlegen: POST api.php
// ----------------------------------------------------------------------------

/**
 * Legt einen Artikel an – oder überschreibt ihn, falls es die ID schon gibt
 * ("Upsert" = Update oder Insert).
 *
 * Warum Upsert? Die App erzeugt die ID selbst. Ist man offline, landet das
 * Anlegen in einer Warteschlange und wird später (evtl. mehrfach!) geschickt.
 * Dank Upsert entsteht trotzdem nur EIN Artikel. Außerdem nutzt "Rückgängig"
 * nach dem Löschen denselben Weg, um den Artikel wiederherzustellen.
 */
function create_item(array $config, PDO $pdo, array $me): never
{
    $body = read_json_body();
    $item = item_from_body($config, $pdo, $me, $body);

    upsert_item($pdo, $item);

    remember_item($pdo, $item['name'], $item['category'], true);
    bump_rev($pdo);
    respond(find_item($pdo, $item['id']), 201);
}

/**
 * Baut aus dem Body einer POST-Anfrage einen vollständigen, geprüften Artikel.
 */
function item_from_body(array $config, PDO $pdo, array $me, array $body): array
{
    $now      = time();
    $checked  = !empty($body['checked']);
    $category = clean_category($config, $pdo, $body['category'] ?? '');
    $listId   = valid_list_id($pdo, $body['list_id'] ?? null);

    // Eigene ID der App verwenden, wenn sie gültig aussieht – sonst eine erzeugen.
    $id = body_string($body, 'id');
    if (!preg_match('/^[A-Za-z0-9_-]{8,64}$/', $id)) {
        $id = bin2hex(random_bytes(16));
    }

    return [
        'id'         => $id,
        'name'       => clean_name($body['name'] ?? ''),
        'quantity'   => clean_quantity($body['quantity'] ?? ''),
        'note'       => clean_note($body['note'] ?? ''),
        'category'   => $category,
        'list_id'    => $listId,
        'checked'    => $checked ? 1 : 0,
        // Position mitgeschickt? Sonst ans Ende der Kategorie.
        'position'   => clean_position($body['position'] ?? null) ?? next_position($pdo, $category, $listId),
        // Beim Wiederherstellen die ursprüngliche Person behalten, sonst: ich.
        'created_by' => existing_user_id($pdo, $body['created_by'] ?? null) ?? $me['id'],
        // Abgehakt-Infos gibt es nur, wenn der Artikel abgehakt ist.
        'checked_by' => $checked ? (existing_user_id($pdo, $body['checked_by'] ?? null) ?? $me['id']) : null,
        'checked_at' => $checked ? valid_past_timestamp($body['checked_at'] ?? null, $now) : null,
        'now'        => $now,
    ];
}

/**
 * Gibt den Zeitstempel zurück, wenn er plausibel ist (positiv und nicht in der
 * Zukunft) – sonst "jetzt".
 */
function valid_past_timestamp(mixed $value, int $now): int
{
    if (is_int($value) && $value > 0 && $value <= $now) {
        return $value;
    }
    return $now;
}

/**
 * Schreibt einen Artikel in die Datenbank: Gibt es die ID schon, wird
 * aktualisiert; sonst neu eingefügt.
 * Beim Aktualisieren bleiben created_at und created_by unverändert.
 */
function upsert_item(PDO $pdo, array $item): void
{
    $upd = $pdo->prepare('
        UPDATE items
        SET name = ?, quantity = ?, note = ?, category = ?, list_id = ?, checked = ?, position = ?,
            checked_by = ?, checked_at = ?, updated_at = ?
        WHERE id = ?
    ');
    $upd->execute([
        $item['name'], $item['quantity'], $item['note'], $item['category'], $item['list_id'], $item['checked'], $item['position'],
        $item['checked_by'], $item['checked_at'], $item['now'],
        $item['id'],
    ]);

    if ($upd->rowCount() > 0) {
        return; // gab es schon -> aktualisiert, fertig
    }

    // "OR IGNORE": Falls zeitgleich eine zweite Anfrage denselben Artikel
    // eingefügt hat, gibt es keinen Fehler.
    $pdo->prepare('
        INSERT OR IGNORE INTO items
            (id, name, quantity, note, category, list_id, checked, position, created_at, updated_at, created_by, checked_by, checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ')->execute([
        $item['id'], $item['name'], $item['quantity'], $item['note'], $item['category'], $item['list_id'], $item['checked'], $item['position'],
        $item['now'], $item['now'], $item['created_by'], $item['checked_by'], $item['checked_at'],
    ]);
}

// ----------------------------------------------------------------------------
//  Artikel ändern: PUT api.php?id=ID
// ----------------------------------------------------------------------------

/**
 * Ändert einzelne Felder eines Artikels. Es werden nur die Felder geändert,
 * die im Body vorkommen. Beispiel: { "checked": true } hakt nur ab.
 */
function update_item(array $config, PDO $pdo, array $me): never
{
    $id   = require_id();
    $body = read_json_body();

    $current = find_item($pdo, $id);
    if (!$current) {
        fail('Artikel nicht gefunden', 404);
    }

    // Welche Spalten sollen auf welchen Wert gesetzt werden?
    $changes = collect_item_changes($config, $pdo, $me, $body);
    if (!$changes) {
        fail('Keine Felder zum Aktualisieren', 422);
    }
    $changes['updated_at'] = time();

    // SQL zusammenbauen: "UPDATE items SET name = ?, checked = ?, ... WHERE id = ?"
    // Die Spaltennamen kommen aus collect_item_changes (feste Liste), die Werte
    // gehen sicher als Parameter (?) rein.
    $setClause = implode(', ', array_map(fn($column) => "$column = ?", array_keys($changes)));
    $params    = array_values($changes);
    $params[]  = $id;
    $pdo->prepare("UPDATE items SET $setClause WHERE id = ?")->execute($params);

    // Wurde Name oder Kategorie geändert, merken wir uns das fürs nächste Mal:
    // Wer "Tofu" einmal nach "Kühlregal" verschiebt, bekommt es künftig dort einsortiert.
    if (array_key_exists('name', $changes) || array_key_exists('category', $changes)) {
        $name     = $changes['name']     ?? $current['name'];
        $category = $changes['category'] ?? $current['category'];
        remember_item($pdo, $name, $category, false);
    }

    bump_rev($pdo);
    respond(find_item($pdo, $id));
}

/**
 * Prüft den Body einer Änderung und liefert ['spalte' => neuer Wert, ...].
 * Nur Felder, die im Body vorkommen, landen im Ergebnis.
 */
function collect_item_changes(array $config, PDO $pdo, array $me, array $body): array
{
    $changes = [];

    if (array_key_exists('name', $body)) {
        $changes['name'] = clean_name($body['name']);
    }
    if (array_key_exists('quantity', $body)) {
        $changes['quantity'] = clean_quantity($body['quantity']);
    }
    if (array_key_exists('note', $body)) {
        $changes['note'] = clean_note($body['note']);
    }
    if (array_key_exists('category', $body)) {
        $changes['category'] = clean_category($config, $pdo, $body['category']);
    }
    if (array_key_exists('list_id', $body)) {
        $changes['list_id'] = valid_list_id($pdo, $body['list_id']);
    }
    if (array_key_exists('checked', $body)) {
        $checked = !empty($body['checked']);
        $changes['checked'] = $checked ? 1 : 0;
        // Abhaken: merken, WER und WANN. Zurücknehmen: beides wieder leeren.
        $changes['checked_by'] = $checked ? $me['id'] : null;
        $changes['checked_at'] = $checked ? time() : null;
    }
    if (array_key_exists('position', $body)) {
        $position = clean_position($body['position']);
        if ($position === null) {
            fail('Ungültige Position', 422);
        }
        $changes['position'] = $position;
    }

    return $changes;
}

// ----------------------------------------------------------------------------
//  Artikel löschen: DELETE api.php?id=ID  bzw.  ?checked=1[&checked_by=ID]
// ----------------------------------------------------------------------------

/** Entscheidet, ob ein einzelner Artikel oder ein ganzer Wagen gelöscht wird. */
function delete_items(PDO $pdo): never
{
    if (($_GET['checked'] ?? '') === '1') {
        clear_checked_items($pdo);
    }
    delete_one_item($pdo);
}

/**
 * Löscht abgehakte Artikel ("Wagen leeren").
 *   ?checked=1               -> alle abgehakten Artikel aller Personen
 *   ?checked=1&checked_by=5  -> nur die, die Person 5 abgehakt hat
 *   ?checked=1&checked_by=0  -> nur die ohne bekannte Person (aus alten Versionen)
 */
/**
 * PUT ?action=reorder  Body: { category, ids: [id1, id2, ...] }
 * Nummeriert die Positionen aller übergebenen Artikel sauber neu (1, 2, 3, ...),
 * z. B. wenn Nachbar-Positionen nach parallelen Offline-Änderungen zu nah liegen.
 */
function handle_reorder(array $config, PDO $pdo): never
{
    require_user($pdo);
    $body = read_json_body();
    $ids  = $body['ids'] ?? null;
    if (!is_array($ids) || count($ids) === 0) {
        fail('ids muss eine nicht-leere Liste sein', 422);
    }
    $category = array_key_exists('category', $body) ? clean_category($config, $pdo, $body['category']) : null;
    $now      = time();

    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $pos = 0;
        $stmt = $category !== null
            ? $pdo->prepare('UPDATE items SET category = ?, position = ?, updated_at = ? WHERE id = ?')
            : $pdo->prepare('UPDATE items SET position = ?, updated_at = ? WHERE id = ?');
        foreach ($ids as $id) {
            if (!is_string($id) || !preg_match('/^[A-Za-z0-9_-]{1,64}$/', $id)) {
                continue;
            }
            $pos++;
            if ($category !== null) {
                $stmt->execute([$category, (float)$pos, $now, $id]);
            } else {
                $stmt->execute([(float)$pos, $now, $id]);
            }
        }
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->exec('ROLLBACK');
        }
        throw $e;
    }

    bump_rev($pdo);
    respond(['ok' => true]);
}

function clear_checked_items(PDO $pdo): never
{
    $by     = $_GET['checked_by'] ?? null;
    $listId = is_string($_GET['list_id'] ?? null) && preg_match('/^[A-Za-z0-9_-]{1,64}$/', $_GET['list_id'])
        ? $_GET['list_id']
        : null;

    $where  = ['checked = 1'];
    $params = [];

    if ($listId !== null) {
        $where[]  = 'list_id = ?';
        $params[] = $listId;
    }

    if (is_string($by) && ctype_digit($by)) {
        if ((int)$by === 0) {
            $where[] = 'checked_by IS NULL';
        } else {
            $where[]  = 'checked_by = ?';
            $params[] = (int)$by;
        }
    }

    $stmt = $pdo->prepare('DELETE FROM items WHERE ' . implode(' AND ', $where));
    $stmt->execute($params);
    $deleted = $stmt->rowCount();

    if ($deleted > 0) {
        bump_rev($pdo);
    }
    respond(['deleted' => $deleted]);
}

/**
 * Löscht einen einzelnen Artikel.
 * Idempotent: Einen schon gelöschten Artikel nochmal zu löschen ist KEIN
 * Fehler (wichtig für die Offline-Warteschlange, die doppelt senden kann).
 */
function delete_one_item(PDO $pdo): never
{
    $id   = require_id();
    $stmt = $pdo->prepare('DELETE FROM items WHERE id = ?');
    $stmt->execute([$id]);
    $deleted = $stmt->rowCount();

    if ($deleted > 0) {
        bump_rev($pdo); // nur wenn sich wirklich etwas geändert hat
    }
    respond(['deleted' => $deleted]);
}


// ============================================================================
//  9. Routing – hier beginnt die eigentliche Ausführung
// ============================================================================
//
//  Alles oben waren nur Funktions-DEFINITIONEN. Ab hier wird tatsächlich
//  etwas ausgeführt. Jede Handler-Funktion endet mit respond()/fail(), also
//  mit "exit" – deshalb braucht der switch auch keine "break"s.
//
//  Das try/catch fängt alle unerwarteten Fehler ab (z. B. kaputte Datenbank),
//  schreibt die Details ins Server-Log und schickt der App eine neutrale
//  Meldung – so sieht niemand interne Details.

/**
 * Welche HTTP-Methode ist gemeint?
 * Manche Hoster blockieren PUT/DELETE. Dann kann die App stattdessen POST
 * schicken und die eigentliche Methode im Header "X-HTTP-Method-Override" angeben.
 */
function request_method(): string
{
    $method   = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    $override = strtoupper($_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE'] ?? '');
    if ($method === 'POST' && in_array($override, ['PUT', 'PATCH', 'DELETE'], true)) {
        return $override;
    }
    return $method;
}

/**
 * Anfragen MIT ?action=... (Accounts, Einstellungen).
 * Kehrt nur zurück, wenn keine action angegeben ist.
 */
function route_action(string $method, string $action, array $config, PDO $pdo): void
{
    if ($action === '') {
        return; // keine action -> es geht um Artikel, siehe route_items()
    }

    switch ("$method $action") {
        case 'GET status':       handle_status($config, $pdo);
        case 'POST register':    handle_register($config, $pdo);
        case 'POST login':       handle_login($config, $pdo);
        case 'POST logout':      handle_logout($pdo);
        case 'GET members':      handle_members($pdo);
        case 'POST password':    handle_password($pdo);
        case 'DELETE member':    handle_member_delete($pdo);
        case 'PUT categories':   handle_category_order($config, $pdo);
        case 'POST lists':       handle_list_create($pdo);
        case 'PUT lists':        handle_list_update($pdo);
        case 'DELETE lists':     handle_list_delete($pdo);
        case 'POST templates':   handle_template_save($config, $pdo);
        case 'DELETE templates': handle_template_delete($pdo);
        case 'DELETE known':     handle_known_delete($pdo);
        case 'PUT reorder':      handle_reorder($config, $pdo);
        default:                 fail('Unbekannte Aktion', 404);
    }
}

/**
 * Anfragen OHNE action: alles rund um Artikel. Nur für angemeldete Benutzer.
 */
function route_items(string $method, array $config, PDO $pdo): never
{
    $me = require_user($pdo); // bricht mit 401 ab, wenn nicht angemeldet

    switch ($method) {
        case 'GET':    list_all($config, $pdo, $me);
        case 'POST':   create_item($config, $pdo, $me);
        case 'PUT':
        case 'PATCH':  update_item($config, $pdo, $me);
        case 'DELETE': delete_items($pdo);
        default:
            header('Allow: GET, POST, PUT, PATCH, DELETE');
            fail('Methode nicht erlaubt', 405);
    }
}

try {
    $method = request_method();
    $action = is_string($_GET['action'] ?? null) ? $_GET['action'] : '';
    $pdo    = db($config);

    route_action($method, $action, $config, $pdo); // Accounts & Einstellungen
    route_items($method, $config, $pdo);           // Artikel
} catch (Throwable $e) {
    error_log('Einkaufszettel API: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    fail('Interner Serverfehler', 500);
}
