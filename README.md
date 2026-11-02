# LED Timeline

Ein Mini-TouchDesigner mit Zeitleiste für WLED-Matrizen. Effekte, Shader, Videos und Text werden wie in einem Videoschnittprogramm auf Spuren angeordnet und live per **DDP**, **Art-Net** oder **sACN (E1.31)** an WLED geschickt. Eine Musikdatei kann als Uhr dienen: Dann läuft das Licht exakt synchron zur Musik.

## Starten

```bash
npm install
npm start
```

Danach http://localhost:8080 im Browser öffnen. Unter **Ausgabe** die IP des WLED-Controllers und die Matrixgröße eintragen.

### Ohne Hardware testen

```bash
npm run fake-wled -- 32 16
```

Das startet einen simulierten WLED-Empfänger, der die Matrix bunt im Terminal anzeigt. In der Oberfläche als WLED-IP `127.0.0.1` eintragen.

## Aufbau

```
Browser (Editor + Rendering)                    Node-Server                  WLED
┌──────────────────────────────┐   WebSocket   ┌──────────────────┐   UDP   ┌──────┐
│ Zeitleiste → Engine (Canvas, │ ────────────▶ │ Mapping, Gamma,  │ ──────▶ │ ESP  │
│ WebGL) → RGB-Frame W×H       │   Frames      │ DDP/Art-Net/sACN │         └──────┘
└──────────────────────────────┘               └──────────────────┘
```

- Der **Browser** rendert jeden Frame in der Matrixauflösung (Shader auf der GPU).
- Der **Server** sortiert die Pixel nach der Verkabelung um (Zickzack, Spiegeln, Zeilen oder Spalten), wendet Helligkeit und Gamma an und verschickt UDP-Pakete.
- Projekte liegen als JSON in `data/projects/`, Medien in `data/media/`.

| Datei | Inhalt |
|---|---|
| `server.js` | HTTP, Upload, Projekte, WebSocket |
| `lib/output.js` | Protokolle DDP / Art-Net / sACN, Pixel-Mapping |
| `public/js/clips.js` | Alle Clip-Typen. **Hier neue Effekte hinzufügen.** |
| `public/js/engine.js` | Abspielzeit, Audio-Analyse, Video-Sync, Ebenen mischen |
| `public/js/timeline.js` | Zeitleisten-Oberfläche |
| `public/js/shader.js` | WebGL-Renderer für GLSL-Clips |
| `public/js/nodes.js` | Node-Typen und Auswertung der Patch-Graphen. **Hier neue Nodes hinzufügen.** |
| `public/js/nodeeditor.js` | Oberfläche des Node-Editors |

## Bedienung

- Bausteine aus der Bibliothek **anklicken** (landen am Abspielkopf) oder auf eine Spur **ziehen**.
- Clips verschieben, an den Rändern in der Länge ändern und zwischen Spuren ziehen. Sie rasten an anderen Clips, am Abspielkopf und auf Beats ein; mit **Alt** lässt sich das Einrasten aussetzen.
- Die **oberste Spur liegt vorne**. Jede Spur hat einen Mischmodus (Normal, Addieren, Multiplizieren …) und eine Deckkraft.
- Videos, Bilder und Musik einfach ins Fenster ziehen.
- **Leertaste** Play/Pause · **S** teilen · **Entf** löschen · **⌘D** duplizieren · **⌘Z** rückgängig · **⌘S** speichern

### Keyframes (Animation)

Alle Zahlen- und Farbparameter sowie die Deckkraft lassen sich über die Zeit animieren:

1. Abspielkopf über den Clip stellen und im Inspektor auf **◇** neben dem Parameter klicken. Damit wird der erste Keyframe gesetzt.
2. Abspielkopf verschieben und den Wert ändern. An der neuen Stelle entsteht automatisch ein weiterer Keyframe.
3. Unter dem Parameter: **◀ ▶** springt zum vorherigen bzw. nächsten Keyframe, **Kurve** wählt Linear, Weich oder Halten (gilt bis zum nächsten Keyframe), **✕ Animation** entfernt die Animation und behält den aktuellen Wert.
4. In der Zeitleiste stehen die Keyframes als gelbe Rauten auf dem Clip. **Klicken** springt hin, **Ziehen** verschiebt den Keyframe (rastet auf Beats ein).

Die Zeiten sind relativ zum Clip gespeichert. Verschiebst du den ganzen Clip, wandern die Keyframes mit. Kürzt du den Clip vorne oder teilst ihn, bleiben die Keyframes an ihrer Stelle im Song.

Ändert man einen animierten Regler **während des Abspielens**, wird jede Bewegung als Keyframe aufgezeichnet (Live-Aufnahme).

### Nodes (Node-Patch)

Ein **Node-Patch** ist ein Clip wie jeder andere: Er liegt auf der Zeitleiste, hat Start, Länge, Blenden und Deckkraft. Innen steckt aber ein Graph aus Nodes mit Ein- und Ausgängen, ähnlich wie in TouchDesigner. So kombiniert man beides: die Zeitleiste entscheidet, *wann* etwas passiert, die Nodes, *wie* es aussieht.

- **Öffnen:** Node-Patch aus der Bibliothek holen, dann im Inspektor auf **Node-Editor öffnen** klicken oder den Clip doppelt anklicken. Die Zeitleiste bleibt sichtbar, man kann also weiter scrubben und abspielen.
- **Verbinden:** Vom Ausgang (● rechts) auf einen Eingang (links) ziehen. Kabelfarben: blau = Bild, gelb = Zahl, rosa = Farbe. Ein Kabel anklicken trennt es; vom belegten Eingang wegziehen hängt es um.
- **Nodes hinzufügen:** In der linken Liste anklicken oder in die Fläche ziehen. **Entf** löscht den ausgewählten Node, **Esc** schließt den Editor, **⌘Z** funktioniert wie überall.
- **Werte:** Zahlenfelder seitlich ziehen (mit ⇧ fein) oder anklicken und eintippen. Jeder Node zeigt sein Ergebnis live als kleines Bild.

| Gruppe | Nodes |
|---|---|
| Eingänge | **Zeit** (Sekunden, Fortschritt, Beat- und Takt-Phase), **Audio** (Pegel, Bass, Mitten, Höhen), **Clip-Regler**, **Darunter** (das Bild der tieferen Spuren) |
| Generatoren | Alle Clip-Typen (Plasma, Feuer, Text, Video, Shader …), ihre Zahlen- und Farbregler sind Eingänge |
| Bild bearbeiten | Mischen (8 Modi), Maske, Farbe anpassen, Einfärben, Transformieren, Spiegeln/Kaleidoskop, Weichzeichnen, Schwelle, Verpixeln, Nachleuchten (Feedback) |
| Zahlen & Farben | LFO (im Takt oder in Hz), Beat-Impuls, Rauschen, Rechnen, Umrechnen, Farbe aus HSV, Farben mischen |

**Verbindung zur Zeitleiste:** Der Patch-Clip hat im Inspektor die Regler **A–D** und eine **Farbe**. Sie lassen sich mit Keyframes animieren und kommen im Graph über den Node **Clip-Regler** an. Damit kann man z. B. die Geschwindigkeit eines Effekts über den Song hinweg steuern, während ein LFO den Farbton im Takt bewegt.

**Als Effekt für andere Clips:** Der Node **Darunter** liefert, was die tieferen Spuren gerade zeigen. Legt man den Patch auf die oberste Spur, wirkt er wie eine Effektebene (z. B. Darunter → Kaleidoskop → Ausgang).

Alle Nodes außer **Nachleuchten** sind zeitbasiert, das Scrubben bleibt also exakt. Nachleuchten hängt vom vorherigen Frame ab und startet beim Springen in der Zeit neu.

### Eigener GLSL-Shader

Shadertoy-kompatibel (`mainImage`). Zusätzlich gibt es `iAudio` (Pegel, Bass, Mitten, Höhen der Musik), `iParam` (4 Regler im Inspektor) und `iProgress` (0..1 über die Cliplänge). Änderungen am Code werden live übernommen.

### Eigener Effekt in JS

In `public/js/clips.js` einen Eintrag zu `CLIP_TYPES` hinzufügen. Er braucht die Parameter (daraus entsteht der Inspektor automatisch) und eine `render(ctx, c)`-Funktion. `c.t` ist die Zeit im Clip; der Effekt sollte nur davon abhängen, damit das Scrubben funktioniert.

## WLED einrichten

- **LED-Einstellungen:** LED-Anzahl = Breite × Höhe.
- **DDP:** Unter Sync-Schnittstellen „Receive UDP realtime“ aktivieren. Mehr ist nicht nötig.
- **Art-Net / sACN:** DMX-Modus „Multi RGB“, Start-Universe wie in der Oberfläche, 170 Pixel pro Universe.
- Zickzack und Spiegeln erledigt dieses Programm, deshalb in WLED nicht zusätzlich eine 2D-Matrix mit Zickzack einstellen.

## Bekannte Grenzen

- Die Show läuft nur, solange der Browser-Tab offen ist. Im Hintergrund hält ein Worker-Timer die Ausgabe am Laufen, Videos können dann aber ruckeln.
- Nodes rechnen auf der CPU. Bei Matrizen bis einige tausend LEDs ist das kein Problem, bei sehr großen Flächen mit vielen Bild-Nodes kann die Bildrate sinken.
- Nur ein WLED-Ziel pro Projekt; mehrere Controller oder Segmente kommen als nächster Schritt.
- Die Kamera braucht `localhost` oder HTTPS, weil der Browser sonst den Zugriff verweigert.
