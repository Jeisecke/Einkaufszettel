<?php
/**
 * Einkaufszettel – Beispiel-Konfiguration
 *
 * Kopiere diese Datei nach "config.php" und trage einen eigenen Familien-Code ein.
 * config.php sollte NICHT ins Git-Repository eingecheckt werden.
 */
return [

    // Familien-Code: Wer ihn kennt, kann sich einen eigenen Account anlegen.
    // Der ERSTE Account wird automatisch Admin (kann Mitglieder entfernen und Passwörter zurücksetzen).
    // Leer lassen ('') = Registrierung gesperrt (bestehende Accounts funktionieren weiter).
    // Tipp: Nachdem alle registriert sind, leeren – dann kann sich niemand Neues mehr anmelden.
    'family_code' => 'HIER-EIGENEN-CODE-EINTRAGEN',

    // Pfad zur SQLite-Datei. Der Ordner wird automatisch angelegt.
    // EMPFOHLEN: einen Ordner AUSSERHALB von httpdocs verwenden, z. B.
    //   dirname(__DIR__) . '/einkauf-data/einkauf.sqlite'
    // Standard: Unterordner "data" (per .htaccess gesperrt).
    'db_path' => __DIR__ . '/data/einkauf.sqlite',

    // Brute-Force-Schutz: nach X Fehlversuchen pro IP für Y Minuten sperren.
    'max_attempts'    => 8,
    'lockout_minutes' => 15,

    // Standard-Kategorien. Reihenfolge, Namen und weitere Kategorien können auch
    // direkt in der App unter Einstellungen geändert werden.
    // Die Kategorie "sonstiges" muss existieren (Fallback).
    'categories' => [
        ['id' => 'obst',        'label' => 'Obst & Gemüse',      'emoji' => '🥦'],
        ['id' => 'brot',        'label' => 'Brot & Backwaren',   'emoji' => '🥖'],
        ['id' => 'kuehl',       'label' => 'Kühlregal',          'emoji' => '🧀'],
        ['id' => 'fleisch',     'label' => 'Fleisch & Fisch',    'emoji' => '🥩'],
        ['id' => 'tk',          'label' => 'Tiefkühl',           'emoji' => '🧊'],
        ['id' => 'vorrat',      'label' => 'Vorrat & Konserven', 'emoji' => '🥫'],
        ['id' => 'fruehstueck', 'label' => 'Frühstück',          'emoji' => '🍯'],
        ['id' => 'suess',       'label' => 'Süßes & Snacks',     'emoji' => '🍫'],
        ['id' => 'getraenke',   'label' => 'Getränke',           'emoji' => '🧃'],
        ['id' => 'drogerie',    'label' => 'Drogerie',           'emoji' => '🧴'],
        ['id' => 'haushalt',    'label' => 'Haushalt',           'emoji' => '🧽'],
        ['id' => 'sonstiges',   'label' => 'Sonstiges',          'emoji' => '🛒'],
    ],
];
