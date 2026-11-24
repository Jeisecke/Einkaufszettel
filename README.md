# 🛒 Einkaufszettel – PWA mit PHP + SQLite

Gemeinsame Einkaufsliste für die Familie, mit eigenem Account pro Person. Sie läuft auf normalem Webspace (Plesk, PHP 8.x), ohne Node.js, ohne Build-Schritt und ohne externe Abhängigkeiten.

## Dateistruktur

```
einkaufszettel/
├── .htaccess              Apache: sperrt DB/Config, Security-Header, Caching
├── index.html             App-Oberfläche (PWA- und iOS-Meta-Tags)
├── style.css              Mobile-First-Styles, Dark Mode, Safe Areas
├── app.js                 Logik: Liste, Kategorien, Offline-Warteschlange, Sync, Accounts
├── sw.js                  Service Worker (App-Shell-Cache, offlinefähig)
├── manifest.json          Web-App-Manifest (Name, Icons, standalone, theme_color)
├── api.php                REST-API (GET/POST/PUT/DELETE, JSON)
├── config.php             Familien-Code, DB-Pfad, Kategorien  ← anpassen
├── data/                  SQLite-Datei (wird automatisch angelegt)
│   ├── .htaccess          "Require all denied"
│   └── index.html         leer (kein Verzeichnislisting)
└── img/                   (bewusst nicht "icons/": viele Apache-Server, auch unter Plesk,
                            belegen /icons/ global mit einem Alias, dann wären die App-Icons unerreichbar)
    ├── icon.svg
    ├── icon-192.png / icon-512.png                    (purpose: any)
    ├── icon-maskable-192.png / icon-maskable-512.png  (purpose: maskable, Android)
    ├── apple-touch-icon.png                           (180×180, iOS)
    └── favicon-32.png
```

## Funktionen

- **Hinzufügen** über die Eingabeleiste unten im Daumenbereich, mit eigenem **Menge-Feld**. Tippt man hinein, erscheint eine Schnellauswahl (1, 2, 3, 6, 500 g, 1 kg, 1 Pck. …). Alternativ wird die Menge auch aus der Eingabe erkannt: `2 Milch`, `500 g Hack`.
- **Automatische Kategorie** per Stichwortliste (z. B. „Erdbeerjoghurt“ → Kühlregal). Mit dem Emoji-Knopf links lässt sie sich ändern. Korrekturen merkt sich der Server für alle Geräte.
- **Vorschläge**: Häufig gekaufte Artikel erscheinen als Chips über der Eingabe. Ein Tipp fügt sie hinzu.
- **Abhaken**: Tipp auf die Zeile streicht den Artikel durch, er wandert nach unten in deinen Einkaufswagen.
- **Löschen** in zwei Schritten gegen versehentliches Tippen: Papierkorb antippen, dann wird daraus „Löschen?“. Erst ein zweiter Tipp löscht. Tippt man woanders hin oder wartet 3 s, passiert nichts. Danach bleibt 8 s lang „Rückgängig“ verfügbar. „Leeren“ beim Einkaufswagen funktioniert genauso („Wirklich leeren?“).
- **Bearbeiten**: Zeile lange drücken (Name, Menge, Notiz/Hinweis, Liste, Kategorie sowie ▲/▼ zum Umsortieren ohne Ziehen).
- **Verschieben**: Auf dem Handy am Griff ⠿ **kurz halten** (~0,2 s) und dann ziehen – normales Scrollen mit der rechten Hand über den Griff verschiebt nichts mehr versehentlich. Am Desktop startet Ziehen sofort per Maus. Leere Kategorien erscheinen beim Ziehen als Ablagefläche, am Bildschirmrand scrollt die Liste mit.
- **Mehrere Listen / Märkte**: Unter *Einstellungen → Listen & Märkte* lassen sich getrennte Listen anlegen (z. B. Supermarkt, Drogerie, Baumarkt). Sobald es mehr als eine Liste gibt, erscheint oben eine kompakte Auswahlleiste.
- **Vorlagen & Rezepte**: Über das Klemmbrett-Symbol oben rechts lassen sich häufige Kombinationen (z. B. „Pfannkuchen“ oder „Standard-Einkauf“) speichern und mit einem Tipp komplett auf die Liste setzen.
- **Kategorien & Vorschläge pflegen**: Kategorien können direkt in den Einstellungen umbenannt, ergänzt, gelöscht und sortiert werden; Tippfehler in den Artikel-Vorschlägen lassen sich unter *Vorschläge verwalten* entfernen.
- **Eigener Einkaufswagen pro Person**: Was du abhakst, landet in **„Dein Wagen“** (aufgeklappt). Was andere abhaken, liegt in „Wagen von Ben“, „Wagen von Clara“ … (zugeklappt, Tippen klappt auf). So seht ihr beim gemeinsamen Einkaufen sofort, wer was schon hat. Jeder Wagen hat einen eigenen **„Leeren“**-Knopf mit Rückgängig, der nur diesen Wagen leert.
- **Sortierung** nach eurem Weg durch den Markt, innerhalb der Kategorie alphabetisch. Die Reihenfolge lässt sich in der App unter *Einstellungen → Reihenfolge im Laden* ändern und gilt für alle.
- **Offline**: Änderungen ohne Empfang landen in einer Warteschlange und werden automatisch nachgesendet. Oben steht dann „offline“. Der Punkt zeigt sonst den Status: grün = synchron, blau = sendet.
- **Fast live**: Alle Geräte gleichen sich alle 4 s ab. Solange sich nichts ändert, antwortet der Server nur kurz mit „unverändert“. Fügt jemand anderes etwas hinzu, erscheint ein Hinweis („Ben hat hinzugefügt: Schokolade“) mit Vibration.
- **Wer war's?** Jeder Artikel zeigt, wer ihn hinzugefügt hat („von Anna“ / „von dir“). Abgehakte Artikel zeigen zusätzlich „abgehakt von Ben“. Im Bearbeiten-Dialog stehen beide mit Uhrzeit.
- **Bildschirm bleibt an**, solange du einkaufst (Wake Lock). Nach 10 Minuten ohne Bedienung geht er wieder normal aus. Abschaltbar in den Einstellungen.
- **Haptik** über `navigator.vibrate` (Android). iOS Safari unterstützt die Vibrations-API nicht, dort wird sie still ignoriert.

## Accounts & Anmeldung

- **Jedes Familienmitglied hat einen eigenen Account** (Name + Passwort, mind. 6 Zeichen). Ohne Anmeldung ist nichts sichtbar, die API liefert dann nur `401`.
- **Registrieren** kann sich nur, wer den **Familien-Code** aus `config.php` kennt: App öffnen → „Neu hier“.
- **Abmelden / Konto wechseln**: Avatar oben rechts → „Abmelden“. Danach kann sich auf dem Gerät jemand anderes anmelden.
- Der **erste Account wird Admin**. Er kann unter *Einstellungen → Familie* Mitglieder entfernen und vergessene Passwörter zurücksetzen.
- **Dauerhaft angemeldet**: Nach dem Login bekommt das Gerät ein zufälliges Sitzungs-Token als HttpOnly-Cookie, gültig 400 Tage (das Maximum, das Browser zulassen). **Bei jeder Nutzung verlängert sich die Sitzung automatisch** wieder auf 400 Tage. Wer die App mindestens einmal im Jahr öffnet, muss sich nie neu anmelden. Auch wenn iOS den lokalen Speicher der App aufräumt, bleibt die Anmeldung erhalten.
- Neu anmelden muss man sich nur nach „Abmelden“, nach einem Passwort-Reset durch den Admin oder wenn der Admin den Account entfernt. Beim eigenen Passwortwechsel bleibt das aktuelle Gerät angemeldet, alle anderen werden abgemeldet.
- Brute-Force-Schutz: Nach 8 Fehlversuchen (Login oder Familien-Code) ist die IP 15 Minuten gesperrt. Passwörter werden mit `password_hash()` (bcrypt) gespeichert, Sitzungs-Tokens nur als SHA-256-Hash.
- Tipp: Wenn alle registriert sind, `family_code` in `config.php` wieder leeren. Dann kann sich niemand mehr neu registrieren, bestehende Accounts funktionieren weiter.

## REST-API

| Methode  | URL                         | Body (JSON)                                      |
|----------|-----------------------------|--------------------------------------------------|
| `GET`    | `api.php[?since=REV]`       | – → `{ items, categories, known, me, rev }` bzw. `{ unchanged, rev }` |
| `POST`   | `api.php`                   | `{ id?, name, quantity?, category?, checked? }`  |
| `PUT`    | `api.php?id=…`              | `{ name?, quantity?, category?, checked?, position? }` |
| `DELETE` | `api.php?id=…`              | –                                                |
| `DELETE` | `api.php?checked=1`         | – (alle abgehakten löschen)                      |
| `DELETE` | `api.php?checked=1&checked_by=…` | – (nur den Wagen dieser Person leeren)      |
| `GET`    | `api.php?action=status`     | – → `{ user, has_users, registration_open }`     |
| `POST`   | `api.php?action=register`   | `{ family_code, name, password }`                |
| `POST`   | `api.php?action=login`      | `{ name, password }`                             |
| `POST`   | `api.php?action=logout`     | –                                                |
| `GET`    | `api.php?action=members`    | – → `{ members }`                                |
| `POST`   | `api.php?action=password`   | `{ current, new }` bzw. als Admin `{ user_id, new }` |
| `DELETE` | `api.php?action=member&id=…`| – (nur Admin)                                    |
| `PUT`    | `api.php?action=categories` | `{ order: [ids] }` bzw. `{ categories: [...] }`  |
| `POST`   | `api.php?action=lists`      | `{ name, emoji? }`                               |
| `PUT`    | `api.php?action=lists&id=…` | `{ name?, emoji? }`                              |
| `DELETE` | `api.php?action=lists&id=…` | –                                                |
| `POST`   | `api.php?action=templates`  | `{ id?, name, emoji?, items: [...] }`            |
| `DELETE` | `api.php?action=templates&id=…` | –                                            |
| `DELETE` | `api.php?action=known&name=…` | –                                              |
| `PUT`    | `api.php?action=reorder`    | `{ category?, ids: [...] }`                      |

Alle Artikel-Endpunkte und `members`/`password`/`member`/`categories` erfordern eine Anmeldung.

---

## Installation per Plesk

### 1. Vorbereiten (lokal)

1. **`config.php` öffnen** und einen **Familien-Code** setzen, z. B. `'family_code' => 'Sonnenblume-42',`. Den gibst du der Familie weiter. Ohne Code kann niemand einen Account anlegen.
2. Optional: Kategorien und Emojis anpassen. Die Reihenfolge stellt ihr später bequem in der App ein.
3. **Empfohlen:** Die Datenbank außerhalb des Webroots ablegen:
   ```php
   'db_path' => dirname(__DIR__) . '/einkauf-data/einkauf.sqlite',
   ```
   (Liegt die App in einem Unterordner von `httpdocs`, entsprechend `dirname(__DIR__, 2)` verwenden.)

### 2. Domain und PHP in Plesk prüfen

1. **Websites & Domains → Hosting & DNS → Hosting**:
   - **SSL/TLS-Zertifikat** aktiv, z. B. kostenlos über *Let's Encrypt*. **HTTPS ist Pflicht**, sonst gibt es keinen Service Worker und keine PWA.
   - Häkchen bei **„Permanente SEO-sichere 301-Weiterleitung von HTTP zu HTTPS“**.
2. **PHP-Einstellungen**: PHP **8.1 oder neuer**, Handler *FPM application served by Apache*. Die Erweiterungen `pdo_sqlite` und `mbstring` müssen aktiv sein (bei Plesk Standard).

### 3. Hochladen

**Variante A – SFTP** (z. B. FileZilla, Cyberduck, Transmit):
- Host: `sftp://deine-domain.de` (oder Server-IP), Port 22
- Benutzer/Passwort: die **FTP-Zugangsdaten des Abonnements** (Plesk → *Websites & Domains → FTP-Zugang*). Für SFTP muss unter *Hosting → Zugriff auf den Server über SSH* „/bin/bash (chrooted)“ o. ä. eingestellt sein, sonst klassisches FTPS auf Port 21 nutzen.
- Inhalt dieses Ordners nach **`/httpdocs/`** hochladen (oder in einen Unterordner wie `/httpdocs/einkauf/`).
- **Versteckte Dateien mit hochladen!** In FileZilla: *Server → Anzeige versteckter Dateien erzwingen*, damit `.htaccess` und `data/.htaccess` übertragen werden.
- `README.md` muss nicht hoch (wird aber ohnehin per `.htaccess` gesperrt).

**Variante B – Plesk-Dateimanager:**
- Ordnerinhalt lokal als ZIP packen, das ZIP unter *Dateien → httpdocs* hochladen und per Rechtsklick → *Extrahieren*.

### 4. Rechte

Der PHP-Prozess (Plesk: Abonnement-Benutzer) braucht Schreibrechte auf `data/` bzw. den gewählten DB-Ordner. Bei Plesk mit PHP-FPM passt das normalerweise automatisch. Falls nicht, im Dateimanager `data/` → Rechte `750` setzen.

### 5. Nginx zusätzlich absichern (wichtig bei Plesk!)

Plesk stellt Nginx vor Apache und liefert statische Dateien oft direkt aus. Dabei wird `.htaccess` umgangen. Deshalb unter **Websites & Domains → Apache & nginx Einstellungen → Zusätzliche nginx-Anweisungen** eintragen:

```nginx
location ~* \.(sqlite|sqlite3|db|db3|sqlite-journal|sqlite-wal|sqlite-shm)$ { deny all; return 404; }
location ~* ^/(.*/)?data/   { deny all; return 404; }
location ~* /config\.php$   { deny all; return 404; }
location ~* /README\.md$    { deny all; return 404; }
```

> Mit der DB außerhalb von `httpdocs` (Schritt 1.3) bist du hier doppelt abgesichert.

### 6. Testen

1. `https://deine-domain.de/` im Handy-Browser öffnen. Du siehst „Willkommen! Lege den ersten Account an“. Familien-Code, deinen Namen und ein Passwort eingeben: Du bist Admin.
2. Die anderen öffnen die Adresse auf ihren Handys, tippen auf **„Neu hier“** und registrieren sich mit dem Familien-Code.
3. Prüfen, dass die Datenbank **nicht** abrufbar ist. Beide Aufrufe müssen **403 oder 404** liefern:
   ```bash
   curl -I https://deine-domain.de/data/einkauf.sqlite
   curl -I https://deine-domain.de/config.php
   ```
4. `curl https://deine-domain.de/api.php` muss `{"error":"Nicht angemeldet"}` liefern.
5. `curl -I https://deine-domain.de/img/icon-192.png` muss **200** liefern. Sonst sind die App-Icons nicht erreichbar und die App lässt sich nicht installieren.

### 7. Als App installieren

- **iPhone/iPad (Safari):** Teilen-Symbol → **„Zum Home-Bildschirm“**. Hinweis: Die installierte App hat unter iOS einen eigenen Cookie-Speicher. Man meldet sich dort also **einmal** neu an, danach dauerhaft nicht mehr. Am bequemsten: erst installieren, dann in der installierten App anmelden. Den iCloud-Schlüsselbund bietet iOS automatisch zum Speichern an.
- **Android (Chrome):** Menü ⋮ → **„App installieren“** bzw. das Installations-Banner antippen.

---

## Wartung & Anpassung

- **Updates ausrollen:** Nach Änderungen an `index.html`, `app.js`, `style.css` oder den Icons in `sw.js` die Konstante `VERSION` erhöhen (z. B. `ekz-v2.0.1`). Die App zeigt dann „Neue Version verfügbar – Neu laden“.
- **Passwort vergessen:** Der Admin setzt es unter *Einstellungen → Familie → Passwort* zurück.
- **Admin hat sein eigenes Passwort vergessen:** Die SQLite-Datei per SFTP herunterladen und z. B. mit „DB Browser for SQLite“ in der Tabelle `users` bei einem anderen Mitglied `is_admin` auf `1` setzen. Datei wieder hochladen, dann kann dieses Mitglied das Passwort zurücksetzen.
- **Backup:** Die SQLite-Datei per SFTP herunterladen (bzw. in das Plesk-Backup einschließen).
- **Hoster blockiert PUT/DELETE** (Fehler 403/405 beim Abhaken oder Löschen, typisch bei ModSecurity): In `app.js` `USE_METHOD_OVERRIDE = true` setzen. Dann wird `POST` mit dem Header `X-HTTP-Method-Override` gesendet, die API versteht beides.
- **Update von Version 1 (PIN):** Einfach alle Dateien ersetzen. Die Datenbank wird automatisch erweitert, die Artikel bleiben erhalten. In `config.php` steht jetzt `family_code` statt `pin`.
- **Kategorie-Erkennung erweitern:** Stichwörter in `KEYWORDS` in `app.js` ergänzen. Neue Kategorien zusätzlich in `config.php` eintragen (die `id` muss übereinstimmen).
- **Fehlersuche:** PHP-Fehler landen nicht im Browser, sondern im Plesk-Log (*Websites & Domains → Logs*).
