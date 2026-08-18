# Venn Fire Watch — Interview-Leitfaden

Dieses Dokument erklärt, was die öffentliche Website zeigt, wie jedes Ergebnis zu verstehen ist, woher die Daten stammen und was das System belegen kann beziehungsweise nicht belegen kann. Es dient als ausführliche Vorbereitung auf ein Interview.

Eine Kurzfassung, die sich in ungefähr 15 Minuten lernen lässt, steht im [Interview-Spickzettel](interview-cheat-sheet.de.md).

> Hinweis zum Datenstand: Die Zahlen im Abschnitt „Aktuell geprüfter Stand“ wurden am **18. August 2026 gegen 12:10 Uhr MESZ** geprüft. Sie zeigen einen damaligen Live-Stand und sind keine dauerhaften Werte. Produktionssystem und Datenbank werden fortlaufend aktualisiert.

## Die Erklärung in 30 Sekunden

Venn Fire Watch ist eine in Fünf-Minuten-Schritten rückblickend nutzbare Übersicht für den Brand im Hohen Venn bei Drossart, Baelen und Jalhay. Sie verbindet behördliche Lageberichte, satellitengestützte Wärmedetektionen und Bilder, öffentlich empfangene Flugzeugspuren, Wetterbeobachtungen und -prognosen, Niederschlagsradar, Luftqualitätsprognosen, öffentliche Warnungen und Mitteilungen lokaler Behörden.

Vercel Functions rufen diese Quellen in kontrollierten Zeitabständen ab. Jeder aktuelle Datensatz, jede inhaltlich relevante historische Version, jedes Aktualisierungsergebnis und jedes rohe Audit-Artefakt wird in PostgreSQL gespeichert. Der Browser liest ausschließlich aus der datenbankgestützten API; er kontaktiert niemals direkt einen Anbieter und enthält keinen statischen Ersatzdatensatz des Vorfalls.

Die wichtigste Designentscheidung ist die klare Trennung unterschiedlicher Belegarten:

- **Gemeldete Fläche** ist die von einer Behörde oder zitierten Quelle genannte Zahl.
- **Best estimate (beste Schätzung)** ist die konservative, aus Belegen abgeleitete 50-Meter-Kontur der Website.
- **EFFIS-Fläche** ist ein breiteres tägliches algorithmisches Satellitenprodukt.
- **FIRMS-Detektionen** sind einzelne thermische Anomalien, keine Brandgrenze.
- **Flugzeugspuren** sind durch Empfänger belegte Positionen, kein Nachweis eines Löscheinsatzes oder Wasserabwurfs.
- **Wetter, Radar und Luftqualität** liefern Umweltkontext; sie verändern die Brandkontur nicht.

Die Website dient der Information. Sie ist kein Notfalldienst, keine amtliche operative Brandgrenze, kein Evakuierungswerkzeug und kein Nachweis dafür, dass ein Gebiet sicher oder der Brand gelöscht ist.

## Aktuell geprüfter Stand

Die folgenden Werte veranschaulichen den Stand bei Erstellung dieses Leitfadens. Vor dem Zitieren müssen immer die Live-Zeitstempel geprüft werden.

| Element | Geprüfter Wert | Richtige Interpretation |
| --- | ---: | --- |
| Zuletzt gemeldete betroffene Fläche | Etwa **3.000 ha** | Die neueste veröffentlichte Zahl wird bis zu einer neuen Meldung fortgeschrieben. „Betroffen“ bedeutet nicht zwingend gleichmäßig verbrannt. |
| Best estimate | **3.057 ha** | Fläche der dargestellten 50-Meter-Evidenzunion, keine amtliche Brandgrenze. |
| Belege hinter dieser Schätzung | 1.066 bestätigte VIIRS-Datensätze; 4 qualifizierende hochkonfidente Terra-MODIS-Pixel des neuesten Überflugs; 796 klare Sentinel-2-Unterstützungszellen; 308 flugzeuggestützte Zellen aus wiederholten GRZLY80-Kurven | Für die Eingaben gelten unterschiedliche Zulassungsregeln. Die Anzahlen dürfen nicht als Hektar addiert werden. |
| EFFIS | **6.334 ha** | Breitere tägliche algorithmische VIIRS-Geometrie; sinnvoll als unabhängiger Vergleich, nicht als vermessene Feldgrenze. |
| FIRMS | **1.724 sichtbar** mit den Standardfiltern; **3.234 exakte Detektionen gespeichert** | „Sichtbar“ hängt von gewählter Zeit, Sensor, Konfidenz und den kurzlebigen Meteosat-Regeln ab. Die gespeicherte Historie ist größer. |
| Neueste FIRMS-Wärmebeobachtung | **17. August, 15:06 Uhr MESZ** | NASA wurde später, am 18. August gegen 12:02 Uhr MESZ, erfolgreich geprüft; die Antwort enthielt jedoch keine neuere lokale Wärme. Eine aktuelle Abfrage und eine neue Detektion sind zwei verschiedene Dinge. |
| Flugzeuge | **0 am ausgewählten aktuellen Tag gesehen**, 5 im rollierenden 24-Stunden-Anzeigefenster sichtbar | Die neueste gespeicherte GRZLY80-Beobachtung stammte vom 17. August um 22:41 Uhr MESZ. Keine öffentliche Empfängerbeobachtung ist kein Beweis dafür, dass kein Flug stattfand. |
| Wetterüberschrift | WSW aus 246°, in Richtung 66°; 17,7 km/h, Böen bis 28,3 km/h; 14 °C; 97,2 % relative Luftfeuchtigkeit | Nahezu aktuelle Messung der Station Mont Rigi, als vorläufig gekennzeichnet. Die Richtung bezeichnet, **woher** der Wind kommt; die Website nennt zusätzlich, wohin er **weht**. |
| Neuester Niederschlag am Vorfallort | RMI: im ausgewählten Bild nichts erkannt | Kategorische Radarbeobachtung, kein Nachweis, dass jeder Punkt am Boden trocken war. |
| Sentinel-2-Vergleich | Vor dem Brand: 14. August gegen 12:47 Uhr MESZ; danach: 16. August gegen 12:47 Uhr MESZ; 21,9 % klar; 187,92 ha rohe qualifizierende Änderung; 796 akzeptierte 50-Meter-Zellen, entsprechend 199 ha vor Überlappung mit anderen Belegen | Gezeigt werden nur klare, qualifizierende positive spektrale Änderungen. Der nicht beobachtete Großteil ist unbekannt, nicht unverbrannt. |
| Sentinel-3 | 12 den Vorfall schneidende Überflüge; 0 lokale koordinatengenaue Detektionen | Katalogtreffer und Vorschauen sind vorhanden, aber es standen keine lokal nutzbaren FRP-Zeilen mit Koordinaten zur Verfügung. |
| Sentinel-1 | 30 Aufnahmen; 2 vergleichbare Paare; 0 kalibrierte Änderungsanalysen | Nur Katalog- und Vorschaubildkontext. Das Produkt verändert derzeit die Schätzung nicht. |
| Copernicus EMS | 0 Treffer zum Vorfall | Im synchronisierten Katalog wurde keine passende Aktivierung gefunden. EMSR920 bei Hürtgen war ein separates Ereignis etwa 32 km entfernt. |
| NASA GIBS | 10 gespeicherte Bilder bis einschließlich 18. August | Täglicher visueller Kontext, keine gemessene Brandgrenze. |
| CAMS | 54,6 µg/m³ experimenteller, ausschließlich Waldbränden zugeschriebener PM10-Anteil; 46,6 µg/m³ PM2,5 | Grobe Prognosewerte eines 0,1°-Modellrasters, keine lokalen Luftqualitätssensoren. |
| Gespeicherte Radarhistorie | DWD: 1.019 Fünf-Minuten-Bilder vom 14. August, 11:05 UTC, bis 17. August, 23:55 UTC; RMI: 116 Bilder in der geprüften Antwort | Das quantitative DWD-Archiv erscheint normalerweise nach Abschluss eines UTC-Tages; RMI liefert den rollierenden, nahezu aktuellen kategorischen Kontext. |
| Datenbank | 27 aktuelle Datensätze; 1.548 Datensatzversionen; 9.632 Artefakte; etwa 913 MB originale Quelldaten | Speicherprüfung zu einem bestimmten Zeitpunkt. Die Zahlen wachsen, wenn Quellen sich ändern und Artefakte gespeichert werden. |

## Die drei Flächenangaben, die am häufigsten verwechselt werden

### Gemeldete Fläche

Die gemeldete Fläche ist eine aus einer Veröffentlichung übernommene Zahl, beispielsweise vom Gouverneur der Provinz Lüttich oder von BRF. Die Website bewahrt Einschränkungen wie ungefähr (`~`) oder größer als (`>`) auf. Wurde keine Zahl genannt, erscheint ein Gedankenstrich.

Der Wert ändert sich ausschließlich, wenn eine belegte Meldung ihn ändert. Dazwischen wird der letzte bekannte Wert fortgeschrieben; es findet keine Interpolation statt. Je nach Formulierung des Herausgebers kann „betroffene Fläche“ verbrannte, brennende, bedrohte, unzugängliche oder operativ umschlossene Bereiche umfassen.

### Best estimate

Die „Best estimate“ ist die Fläche einer einzigen durchgezogenen roten Rasterunion mit 50-Meter-Zellen, die von der Website abgeleitet wird. Sie kombiniert ausschließlich qualifizierende Belege aus bestätigten VIIRS-Detektionen, dem neuesten gestützten MODIS-Überflug, positiven wolkenfreien Sentinel-2-Änderungen und streng begrenzten lokalen Kurvenbewegungen von GRZLY-Flugzeugen.

Die Bezeichnung „Schätzung“ ist bewusst gewählt. Sie ist weder amtlich noch im Feld vermessen und wird weder als Ober- noch als Untergrenze ausgegeben. Die dargestellte Zahl und die sichtbare Kontur werden aus demselben Raster berechnet und können deshalb nicht unbemerkt voneinander abweichen.

### EFFIS-Fläche

EFFIS liefert eine täglich algorithmisch erzeugte VIIRS-Geometrie. Die Website wählt das Produkt in der Nähe des Vorfalls und berechnet die Fläche seines lokalen Polygons. Es eignet sich als unabhängige breite Hülle und kann berechtigterweise deutlich größer als die eigene Schätzung ausfallen, weil Zweck, Auflösung, Zusammenstellung und Klassifikationsverfahren anders sind.

EFFIS wird nicht als Ground Truth behandelt und verändert die „Best estimate“ niemals.

## Alles, was auf der Website sichtbar ist

### Kopfzeile und Ladezustand

Die Kopfzeile identifiziert den Vorfall und den Ort, zeigt den aktuellen Beobachtungszeitpunkt und den letzten Synchronisationszustand der Datenbank und öffnet die Erklärung „Data & sources“.

„Aktuell“ beschreibt den Zustand der Datenbank oder des Aktualisierungslaufs. Es bedeutet nicht, dass jedes externe Instrument genau zu diesem Zeitpunkt eine neue Beobachtung erzeugt hat. FIRMS kann beispielsweise mittags erfolgreich abgefragt worden sein, während die neueste lokale Satellitendetektion vom vorherigen Nachmittag stammt.

Die Anwendung zeigt sofort ihren Rahmen, lädt danach asynchron den kompakten Kerndatensatz und anschließend die größere Flugzeugprojektion. In der öffentlichen Oberfläche erscheint kein implementierungsbezogener Bildschirm mit „Loading incident database“.

### Linkes Informationsfeld

Das Hauptfeld enthält:

- Vorfall und Ortsangabe;
- gemeldete Fläche und „Best estimate“ samt Zeitstempeln oder Methodenbeschreibung;
- die Steuerung für die Kontur der „Best estimate“;
- Schalter für Kartenebenen;
- FIRMS-Konfidenzfilter;
- Informationen zu Aktualität und Verfügbarkeit der Quellen; und
- den Hinweis auf behördliche Notfallinformationen.

Ebenenschalter verändern die Kartendarstellung. Sie berechnen die Schätzung nicht rückwirkend neu. Werden beispielsweise MODIS oder Flugspuren ausgeblendet, verschwinden diese visuellen Ebenen; bereits qualifizierte Belege werden dadurch nicht aus der „Best estimate“ entfernt.

### Grundkarten und Kartenwerkzeuge

Die Website bietet:

- OpenStreetMap als normale Kartengrundlage;
- Esri-Satellitenbilder; und
- OpenTopoMap als Geländekontext.

Die Bedienelemente umfassen Zoom, Rückkehr zum Gesamtausschnitt, Rückkehr zum Brand und eine Messung geradliniger Entfernungen. Die angezeigte Vorfallkoordinate ist ein Referenzpunkt für das Ereignis, keine zentimetergenaue Behauptung über den Zündpunkt oder den Standort der Einsatzleitung.

### Entfernungsmesser

Das Lineal misst die Luftlinie zwischen angeklickten Kartenpunkten und kann über mehrere Teilstrecken fortgesetzt werden. Es eignet sich für Fragen wie „Wie weit ist die Kontur von diesem Ort entfernt?“. Mit Escape oder der Löschfunktion wird die Messung zurückgesetzt.

Es ist keine Straßenentfernung, Fahrzeit, Evakuierungszone, geländeabhängige Route oder Sicherheitsdistanz.

### Fünf-Minuten-Zeitstrahl

Der Zeitstrahl beginnt am 14. August um 13:00 Uhr MESZ, kurz vor der gemeldeten Entstehung gegen 13:06 Uhr. Er bietet Fünf-Minuten-Zeitpunkte, auch wenn eine externe Quelle einen gröberen Rhythmus hat.

Die Oberfläche enthält:

- vorheriger und nächster Zeitpunkt;
- Wiedergabe und Pause;
- 1×-, 2×- und 4×-Geschwindigkeit;
- einen verschiebbaren Zeitregler;
- Markierungen für Berichte und Ereignisse;
- ein Stufendiagramm der gemeldeten Fläche; und
- Tastaturbedienung, unter anderem Pfeiltasten und Leertaste.

Alle Belege sind zeitlich begrenzt. Eine Satellitenbeobachtung, Meldung oder Flugzeugposition erscheint erst nach ihrer tatsächlichen Aufnahme beziehungsweise Veröffentlichung; spätere Erkenntnisse werden nicht in frühere Zeitpunkte zurückprojiziert. Eine flache Flächenkurve bedeutet, dass keine neue Fläche veröffentlicht wurde, nicht zwingend, dass sich das Feuer nicht weiter verändert hat.

### Registerkarte „Situation“

Die Registerkarte „Situation“ fasst sechs Hauptsignale zusammen:

- zuletzt gemeldete betroffene Fläche;
- aktuelle „Best estimate“;
- EFFIS-Fläche;
- mit den aktuellen Filtern sichtbare FIRMS-Detektionen;
- am ausgewählten Tag beobachtete Flugzeuge; und
- Hauptwindangabe.

Daneben zeigt sie brandrelevantes Wetter, unabhängige Windquellen und ein chronologisches Ereignisprotokoll mit anklickbaren Quellen. Unabhängig gemessene oder modellierte Winde bleiben getrennt, statt zu einer falschen „Supermessung“ vermischt zu werden.

Eine separate Open-Meteo-Prognose zeigt jede Modellstunde der nächsten 48 Stunden, einschließlich Temperatur, gefühlter Temperatur, Niederschlagswahrscheinlichkeit und -menge, Bewölkung, Sichtweite, Wind und Böen. Sie ist ausdrücklich an die neueste Datenbanksynchronisierung gebunden und bleibt von der ausgewählten historischen Beobachtung getrennt.

### Registerkarte „Aircraft“

Die Flugzeugansicht zeigt Rufzeichen oder Identität, bekannten Flugzeugtyp, Kandidaten- beziehungsweise Bestätigungsstatus, die Anzahl der Positionen am ausgewählten Tag und im rollierenden 24-Stunden-Fenster, Routencluster, verfügbare Referenzfotos und Herkunftsangaben. Die Karte kann auf eine ausgewählte Route oder auf den vollständigen Tag eingepasst werden.

Ein Flugzeug mit öffentlichem Foto, aber ohne passende Empfängerspur, kann weiterhin als reiner Fotokontext erscheinen; G12 ist ein solcher Fall. Eine sichtbare Route besteht immer aus exakt gespeicherten Empfängerpositionen unter den später beschriebenen Lückenregeln.

### Dialog „Data & sources“

Der öffentliche Dialog „Data & sources“ erläutert:

- den aktuellen Abdeckungsstand auf einen Blick;
- die richtige Interpretation von FIRMS, „Best estimate“, Sentinel-Produkten, Radar, Wetter, GIBS, CAMS und Flugzeugbelegen;
- das Quellenverzeichnis mit Links; und
- eine sachliche Einladung, das Projekt zu kontaktieren, falls jemand Zugang zu hilfreichen operativen Daten hat.

Interne Zugangsdaten, Spekulationen über Anbieterverträge, Synchronisationslücken und rein technische Einschränkungen gehören absichtlich nicht auf die öffentliche Website. Sie werden im [internen Quellenlimit-Inventar](known-source-limits.md) gepflegt.

### Lokaler Import einer Flugzeugdatei

Die Website kann eine vom Nutzer ausgewählte GeoJSON-`LineString` oder CSV-Datei mit Breiten- und Längengrad sowie optionalem Rufzeichen anzeigen. Das ist eine lokale Analysehilfe. Importierte Daten gelten als statisch und zeitlos, verbleiben in dieser Browsersitzung, werden nicht in PostgreSQL hochgeladen und nicht mit anderen Besuchern geteilt.

## Kartenebenen und ihr Einfluss auf die „Best estimate“

| Ebene | Standard | Kann die „Best estimate“ beeinflussen? | Zweck |
| --- | --- | --- | --- |
| Kontur der „Best estimate“ | Ein | Sie **ist** die Schätzung | Durchgezogene rote abgeleitete Evidenzunion und zugehörige Fläche. |
| EFFIS | Ein | Nein | Breite unabhängige tägliche algorithmische Hülle. |
| Sentinel-2-Änderung | Ein | Ja, unter den dokumentierten Regeln für klare Pixel | Positive, wolkenfreie, mit Brandwirkung vereinbare spektrale Änderung. |
| Sentinel-3 | Ein | In den aktuellen Daten nein | Katalog- und Vorschaubildkontext; nur koordinatengenaue FRP-Daten könnten zu lokalen Punkten werden. |
| Niederschlagsradar | Ein | Nein | Nahezu aktueller RMI- und quantitativer DWD-Niederschlagskontext. |
| GIBS-Echtfarben | Aus | Nein | Täglicher visueller Satellitenkontext. |
| GIBS-Kurzwelleninfrarot | Aus | Nein | Täglicher visueller Kontext, in dem heiße oder verbrannte Merkmale leichter erkennbar sein können. |
| CAMS Waldbrand-PM10 | Aus | Nein | Experimentelle Modellprognose des Waldbränden zugeschriebenen PM10-Anteils. |
| CAMS PM2,5 | Aus | Nein | Grober Feinstaub-Prognosekontext. |
| VIIRS Suomi-NPP | Ein | Ja, über die Bestätigungsregeln | Thermische Polarsatelliten-Detektionen der 375-m-Klasse. |
| VIIRS NOAA-20 | Ein | Ja, über die Bestätigungsregeln | Unabhängige thermische Polarsatelliten-Detektionen der 375-m-Klasse. |
| VIIRS NOAA-21 | Ein | Ja, über die Bestätigungsregeln | Unabhängige thermische Polarsatelliten-Detektionen der 375-m-Klasse. |
| MODIS Terra/Aqua | Aus | Nur der neueste qualifizierende gestützte Überflug | Thermische Unterstützung der 1-km-Klasse; bildet niemals allein den Kern. |
| Meteosat | Aus | Niemals | Häufiger, aber sehr grober geostationärer Wärmekontext. |
| Flugzeugspuren | Ein | Nur gefilterte, wiederholt gestützte Kurven von `GRZLY##` | Durch Empfänger gestützte Routen und konservative lokale Randbelege. |
| Open-Meteo-Wind | Ein | Nein | Stündliches Wettermodellraster. |
| RMI-Wind Mont Rigi | Ein | Nein | Nahe gelegene Zehn-Minuten-Stationsmessungen. |
| Drei DWD-Winde | Ein | Nein | Unabhängige Zehn-Minuten-Messungen nahe gelegener Stationen. |

Hohe und nominelle FIRMS-Konfidenz sind standardmäßig sichtbar; niedrige Konfidenz ist standardmäßig ausgeblendet. Diese Schalter verändern die sichtbare FIRMS-Anzahl, nicht die gespeicherte Gesamtzahl und nicht die unabhängig festgelegten Zulassungsregeln der „Best estimate“.

## So wird die „Best estimate“ berechnet

### 1. Zeitliche Begrenzung

Jede Berechnung verwendet ausschließlich Belege, deren Aufnahmezeit am oder vor dem ausgewählten Zeitstrahlpunkt liegt. Derselbe Algorithmus kann daher rekonstruieren, was die Website zu jedem Fünf-Minuten-Zeitpunkt vernünftigerweise hätte zeigen können, ohne spätere Erkenntnisse zu verwenden.

### 2. Bestätigter VIIRS-Kern

Der thermische Kern verwendet die drei polaren VIIRS-Produkte Suomi-NPP, NOAA-20 und NOAA-21. Detektionen werden in einem räumlichen Raster von ungefähr 0,005° zusammengefasst, was an diesem Ort etwa 500 m entspricht.

Ein Kernort benötigt:

1. Beobachtungen von mindestens zwei unabhängigen VIIRS-Satelliten; und
2. mindestens eine Detektion mit hoher Konfidenz.

Die Bestätigung ist räumlich und bis zum ausgewählten Zeitpunkt kumulativ; die Satelliten müssen den Ort nicht gleichzeitig überfliegen. Akzeptierte veröffentlichte Sensorfußabdrücke werden auf das gemeinsame 50-Meter-Raster übertragen.

Diese Regel verringert das Risiko, dass ein einzelner verrauschter oder versetzter Satellitenpunkt allein einen großen Rand festlegt. Feuer kann dennoch durch Wolken, Rauch, Abtastlücken oder ungünstige Überflugzeiten fehlen.

### 3. Unterstützung durch den neuesten MODIS-Überflug

MODIS Terra und Aqua haben gröbere thermische Pixel von ungefähr 1 km. MODIS darf die bestehende Schätzung nur erweitern, wenn alle folgenden Bedingungen erfüllt sind:

- Die Detektion besitzt hohe Konfidenz.
- Sie gehört zum neuesten verfügbaren Fünf-Minuten-Terra-/Aqua-Überflug am ausgewählten Zeitpunkt.
- Ihr qualifizierender Fußabdruck liegt höchstens 500 m vom bestätigten VIIRS-Kern oder einem akzeptierten flugzeuggestützten Rand entfernt.

MODIS kann keinen eigenständigen Kern bilden und zählt nicht als zweiter VIIRS-Satellit. Es wird nur der neueste gestützte Überflug verwendet, damit sich aufeinanderfolgende grobe Momentaufnahmen nicht unbegrenzt zu einer aufgeblähten Brandnarbe addieren. Deshalb muss die Schätzung auch nicht monoton wachsen. Am 15. August änderte beispielsweise der Ersatz eines gestützten MODIS-Überflugs durch den nächsten die Schätzung von ungefähr 3.572 ha auf 3.012 ha.

### 4. Positive Sentinel-2-Änderungsbelege

Sentinel-2 steuert höher aufgelöste optische Belege aus einer L2A-Aufnahme vor und nach dem Brand bei. Die Analyse verwendet:

- B8A im nahen Infrarot;
- B12 im Kurzwelleninfrarot; und
- den Scene Classification Layer (SCL) mit 20 m Auflösung.

Der Normalized Burn Ratio wird so berechnet:

```text
NBR = (B8A - B12) / (B8A + B12)
dNBR = NBR vor dem Brand - NBR nach dem Brand
```

Akzeptiert werden ausschließlich SCL-Klasse 4 (Vegetation) oder 5 (unbewachsen) in beiden Aufnahmen. Wolken, Cirrus, Schatten, Wasser, Schnee, unklassifizierte und fehlende Pixel werden verworfen.

Ein 20-Meter-Pixel ist geeignet, wenn sein dNBR mindestens 0,15 beträgt und sein Mittelpunkt höchstens 750 m von einer unabhängig bestätigten VIIRS-Kernbeobachtung entfernt liegt, die zum Zeitpunkt der Aufnahme nach dem Brand bereits vorlag. Das Pixel gelangt nur dann in das gemeinsame 50-Meter-Raster, wenn:

1. mindestens zwei geeignete 20-Meter-Pixel in derselben 50-Meter-Zelle liegen;
2. mindestens eines davon einen dNBR von 0,20 oder mehr aufweist; und
3. die Zelle zu einer über vier Nachbarn verbundenen Komponente mit mindestens vier Zellen gehört.

Sentinel-2 fügt ausschließlich positive Belege hinzu. Es entfernt niemals thermische oder flugzeugbasierte Belege, weil ein verdecktes oder nicht qualifizierendes Pixel nicht beweist, dass der Boden unbeeinträchtigt blieb.

Im geprüften Vergleich wurde die Aufnahme vor dem Brand am 14. August gegen 12:47 Uhr MESZ und die Aufnahme danach am 16. August gegen 12:47 Uhr MESZ erstellt. Nur 21,9 % des Ausschnitts waren in beiden Aufnahmen klar. Die daraus resultierenden kleinen Bereiche sind deshalb zu erwarten: Sie zeigen die Orte, an denen das strenge Verfahren positive, klare Belege hat, nicht die einzigen verbrannten Flächen.

Das vollständige gespeicherte Rasterverfahren ist in der [Sentinel-2-Brandänderungsanalyse](sentinel2-analysis.md) dokumentiert.

### 5. Flugzeuggestützter Rand

Nur einsatzbezogene Rufzeichen im Muster `GRZLY##` können Flugzeugbelege beitragen. Die Schätzung übernimmt nicht die vollständige Route: Wege zur Wasserquelle, An- und Abflüge sowie entfernte Transitabschnitte werden ausgeschlossen.

Der lokale Algorithmus:

1. fasst gespeicherte exakte Positionen in Zehn-Sekunden-Anzeigefenstern zusammen;
2. betrachtet 15 bis 45 Sekunden vor und nach einer möglichen Kurve;
3. verlangt Flugabschnitte von mindestens 100 m;
4. verlangt eine Richtungsänderung von mindestens 70°;
5. verlangt einen Abstand der Kurve zwischen 50 m und 1 km zur bestehenden thermischen Kontur;
6. akzeptiert höchstens einen Evidenzpunkt pro Fünf-Minuten-Zeitfenster; und
7. verlangt eine Stützung aus einem weiteren Fünf-Minuten-Zeitfenster innerhalb von 900 m.

Jedes getrennte lokale Cluster erzeugt nur seine kompakte, kürzeste Ausbuchtung an der thermischen Kontur. Diese Ausbuchtung wird in dieselbe 50-Meter-Union gerastert. Lange Streifen von der Wasserquelle, Routenverbindungen und isolierte dreieckige Ausreißer werden nicht übernommen.

Das ist ein Hinweis auf ein wiederholtes Manövermuster nahe einem thermisch gestützten Rand. Öffentliche Empfängerdaten enthalten weder Nutzlastzustand noch amtliche Einsatzaufzeichnung. Das Ergebnis ist deshalb kein Nachweis eines Wasserabwurfs, einer Feuerfront oder auch nur des konkreten Auftrags des Flugzeugs.

Der Flugzeugbeitrag läuft nach 24 Stunden aus der aktuellen „Best estimate“ aus, entsprechend dem Relevanzfenster der Spurendarstellung. Exakte historische Beobachtungen bleiben in PostgreSQL erhalten.

### 6. Eine aufgelöste 50-Meter-Union

Alle akzeptierten Belege werden auf dasselbe 50-Meter-Raster übertragen und zu einer einzigen Geometrie aufgelöst. Eine volle Rasterzelle entspricht 2.500 m² beziehungsweise 0,25 ha. Überlappungen werden nur einmal gezählt. Die angezeigten Hektar werden aus exakt den Zellen berechnet, welche die rote Kontur bilden.

Eine separate „Touched zone“ gibt es nicht. Sie wurde entfernt, weil ihr äußerer historischer Rand verlässlicher wirkte, als es die Belege rechtfertigten.

### Was die Schätzung trotzdem falsch darstellen kann

Sie kann zu klein sein, weil Satelliten nur begrenzte Überflüge haben, Wolken und Rauch optische Beobachtungen verdecken, öffentliche Flugzeugempfänger Lücken aufweisen und keine operative Feldgrenze verfügbar ist. Sie kann zu groß sein, weil thermische Fußabdrücke größer als die tatsächlich brennende Oberfläche sind, spektrale Veränderungen nicht ausschließlich durch Feuer verursacht werden und konservative Rasterzellen etwas umliegenden Boden einschließen.

Deshalb sollte sie als reproduzierbare Evidenzschätzung bezeichnet werden — nicht als „wahre verbrannte Fläche“, „Feuerfront“ oder amtliche Brandgrenze.

## Thermische Detektionen von NASA FIRMS

FIRMS ist die Hauptquelle für rohe satellitengestützte Wärmebeobachtungen. Die Website synchronisiert fünf Produkte.

| Produkt | Ungefähre native Auflösung/Rhythmus | Standardanzeige | Rolle in der Schätzung |
| --- | --- | --- | --- |
| VIIRS Suomi-NPP | Etwa 375 m; ungefähr zwei polare Überflüge pro Tag | Ein | Kann zum bestätigten Kern beitragen. |
| VIIRS NOAA-20 | Etwa 375 m; ungefähr zwei polare Überflüge pro Tag | Ein | Kann zum bestätigten Kern beitragen. |
| VIIRS NOAA-21 | Etwa 375 m; ungefähr zwei polare Überflüge pro Tag | Ein | Kann zum bestätigten Kern beitragen. |
| MODIS Terra/Aqua | Etwa 1 km; zusammen bis zu ungefähr vier Beobachtungsmöglichkeiten pro Tag | Aus | Nur der neueste hochkonfidente gestützte Überflug darf den Kern erweitern. |
| GOES_NRT Meteosat | Hier je nach Satellit und Blickgeometrie ungefähr 2,1 × 4,1 km bis 3,3 × 9,1 km; gewöhnlich alle 10 bis 15 Minuten | Aus | Nur visueller Kontext; trägt niemals Hektar bei. |

Die Meteosat-Rechtecke sind ausdrücklich angenäherte Fußabdrücke der Blickgeometrie. Die Quellfelder `scan` und `track` werden zur Nachvollziehbarkeit gespeichert, stellen für diese Produkte aber keine physischen Kilometermaße dar.

FIRMS-Konfidenz erscheint abhängig vom produktspezifischen Anbieterfeld als hoch, nominell, niedrig oder unbekannt. Die Fire Radiative Power (FRP) ist ein relatives Maß der abgestrahlten Leistung in Megawatt zum Beobachtungszeitpunkt. Sie ist weder Temperatur noch verbrannte Fläche, Branddauer oder direkter Schweregrad.

Polare Detektionen bleiben auf dem historischen Zeitstrahl verfügbar. Meteosat ist eine momentane, grobe Kontextebene und verschwindet nach seinem 15-Minuten-Abtastfenster. Alle zugrunde liegenden Zeilen bleiben gespeichert.

Der Dienst wird durch den Fünf-Minuten-Scheduler geprüft; eine 15-minütige Datenbanksperre schützt jedoch das begrenzte NASA-API-Kontingent. Jede erfolgreiche Abfrage führt exakte Zeilen mit der Historie zusammen und archiviert die fünf rohen Produktantworten. Die Oberfläche unterscheidet:

- `generatedAt`: Zeitpunkt der Anbieterabfrage; und
- `latestAcquiredAt`: Aufnahmezeit der neuesten zurückgegebenen Satellitenbeobachtung.

Deshalb ist „gerade geprüft, drei Zeilen zurückgegeben, keine neuere Wärme“ ein gültiger und wichtiger Zustand. Er bedeutet weder, dass der Import veraltet ist, noch beweist er, dass der Brand erloschen ist. Ein Satellit kann Restwärme oder verdeckte Wärme verpassen; lokale Detektionen erscheinen nur, wenn das Instrument beobachtet und der Anbieter die Daten veröffentlicht.

## Weitere Satelliten- und Copernicus-Produkte

### EFFIS

Der WFS des Copernicus European Forest Fire Information System wird alle sechs Stunden auf ein tägliches Produkt geprüft. Die Website wählt die dem Vorfall nächstgelegene Geometrie innerhalb des lokalen Suchbereichs und berechnet ihre Polygonfläche. Die orange Kontur wird auf dem Zeitstrahl fortgeschrieben, bis ein neueres Tagesprodukt erscheint. Sie verändert die „Best estimate“ niemals.

### Sentinel-2

Copernicus Data Space liefert die maßgeblichen Katalogeinträge und gespeicherten öffentlichen Vorschaubilder. Element 84 Earth Search und das offene AWS-Archiv der Sentinel-2-L2A-COGs liefern die öffentlichen B8A-, B12- und SCL-Pixel für die gespeicherte dNBR-Analyse.

Der Katalog wird alle fünf Minuten geprüft, große Rasterdaten werden jedoch nur verarbeitet, wenn eine bisher unbekannte Aufnahme nach dem Brand erscheint. Der Quelldatensatz zeigt Aufnahmezeiten, Wolken- beziehungsweise Klaranteil, rohe qualifizierende Fläche, Anzahl akzeptierter Zellen und die resultierende Evidenzgeometrie.

Ein kleiner violetter Bereich ist kein Fehler, wenn der Großteil des Bildpaares verdeckt oder verworfen wurde. Er bedeutet lediglich, dass das strenge Verfahren dort positive, klare Belege besitzt.

### Sentinel-3

Der Sentinel-3-SLSTR-NRT-FRP-Katalog wird alle 30 Minuten geprüft. Überflüge, die den Vorfall schneiden, und öffentliche Vorschaubilder werden gespeichert. Ein Katalogtreffer oder eine Vorschau des Satellitenstreifens wird nicht automatisch zu einem lokalen Wärmepunkt. Nur FRP-Zeilen mit Koordinaten können als lokale Detektionen dargestellt werden.

Zum geprüften Zeitpunkt schnitten 12 Überflüge den Suchbereich des Vorfalls, keiner stellte jedoch nutzbare lokale Koordinaten bereit. Sentinel-3 fügte daher korrekterweise weder Kartenpunkte noch Fläche hinzu.

### Sentinel-1

Sentinel-1-GRD-Katalogeinträge werden stündlich geprüft. Aufnahmen werden nur gepaart, wenn Satellit, relative Umlaufbahn und Flugrichtung übereinstimmen. Öffentliche Vorschauen können visuellen Kontext liefern, sind jedoch keine georeferenzierten, kalibrierten Änderungsraster und beeinflussen die „Best estimate“ deshalb nicht.

Zum geprüften Zeitpunkt enthielt die Datenbank 30 Aufnahmen und zwei vergleichbare Paare, aber keine gültige Analyse auf Pixelebene.

### NASA GIBS

GIBS liefert tägliche VIIRS-Bilder mit korrigierter Reflexion: Echtfarben sowie M11/I2/I1 im Kurzwelleninfrarot. Der Scheduler prüft alle 30 Minuten auf Überarbeitungen desselben Tages und speichert unterschiedliche Versionen. Dabei handelt es sich um visuelle Bilder, nicht um lokale Hotspotmessungen, exakte Aufnahmezeiten jedes einzelnen Tagesbestandteils oder Brandgrenzen.

### Copernicus Emergency Management Service

Der EMS-Rapid-Mapping-Katalog wird stündlich geprüft. Ein Treffer würde Metadaten der Aktivierung und verfügbare Kartierungsprodukte anzeigen. Im geprüften Katalog wurde keine passende Aktivierung für diesen Vorfall gefunden. EMSR920 bei Hürtgen war ein separates Ereignis ungefähr 32 km entfernt und wird nicht diesem Vorfall zugeordnet.

„Kein Treffer“ bedeutet ausschließlich, dass über den synchronisierten öffentlichen Katalog keine passende Aktivierung gefunden wurde. Es beweist nicht, dass eine Behörde keine internen Einsatzkarten erstellt hat.

## Wetter und Wind

Die Wetterüberschrift bevorzugt die nahe gelegene RMI-Messung von Mont Rigi, wenn sie höchstens 20 Minuten alt ist. Andernfalls wird Open-Meteo verwendet. Quelle und Beobachtungszeit werden immer angezeigt.

Die Windrichtung folgt der meteorologischen Konvention: 246° bedeutet Wind **aus** 246°, also ungefähr Westsüdwest. Die Oberfläche übersetzt dies zusätzlich in die Richtung, in die der Wind **weht**, in diesem Beispiel 66°.

Werte werden mit sinnvoller Genauigkeit gerundet: Windrichtung auf ganze Grad, Geschwindigkeit und Temperatur auf angemessene Dezimalstellen und ohne Fließkommaartefakte wie `116.25560000000002°`.

### RMI Mont Rigi

Die RMI-Station 6494 liegt ungefähr 4,2 km vom Referenzpunkt des Vorfalls entfernt. Sie liefert alle zehn Minuten Temperatur, relative Luftfeuchtigkeit, Niederschlag, Wind, Böen und Validierungskennzeichen. Nahezu aktuelle Werte können bis zur Prüfung durch den Anbieter als vorläufig markiert sein.

### Open-Meteo

Open-Meteo liefert stündliche Modellraster für Temperatur, gefühlte Temperatur, Luftfeuchtigkeit, Niederschlagswahrscheinlichkeit und -menge, Wettercode, Bewölkung, Sichtweite, Wind und Böen. Die Anwendung prüft alle fünf Minuten auf aktualisierte Daten und zeigt mindestens die nächsten 48 Stunden als separate Prognose. Es handelt sich um einen Modellwert für eine Rasterzelle, nicht um eine Stationsmessung direkt am Brand.

### DWD-Stationen

Drei Stationen des DWD Climate Data Center liefern unabhängige Zehn-Minuten-Windbeobachtungen:

- Aachen-Orsbach, ungefähr 28,0 km entfernt;
- Kall-Sistig, ungefähr 33,5 km entfernt; und
- Roth bei Prüm, ungefähr 35,7 km entfernt.

Beobachtungen bleiben bis zu 90 Minuten sichtbar. Ihre Qualitätsstufe wird gespeichert; sie werden niemals unbemerkt mit RMI oder Open-Meteo vermischt.

## Niederschlagsradar

Die Niederschlagsebene ist standardmäßig eingeschaltet und verbindet zwei Quellen:

- **Öffentliche RMI-Radaranimation:** nahezu aktuelle kategorische Niederschlagsbilder, alle fünf Minuten geprüft und derzeit mit Zehn-Minuten-Zeitstempeln veröffentlicht.
- **DWD RADOLAN YW:** amtliche quantitative Niederschlagsmengen auf einem 1-km-Raster alle fünf Minuten, wiederhergestellt aus abgeschlossenen Tagesarchiven.

Bei einem exakt überlappenden Zeitpunkt hat RMI Vorrang, weil es den Live-Kontext liefert. DWD stellt die exakten Millimeter pro Fünf-Minuten-Intervall bereit, sobald das entsprechende Tagesarchiv veröffentlicht wurde. Zwischen Radarbildern wird nicht interpoliert.

Das öffentliche DWD-Archiv erscheint normalerweise erst nach Abschluss des UTC-Tages. Der Import prüft alle fünf Minuten, speichert jedes verfügbare Originalarchiv und jedes Bild des Vorfallbereichs und markiert unveröffentlichte Tage ausdrücklich als ausstehend. RMI liefert während dieser Verzögerung aktuellen Kontext, sein öffentliches Bild ist jedoch kategorisch und keine Millimetermessung.

Historischer Niederschlag wird in PostgreSQL gespeichert. Was die Oberfläche derzeit nicht bietet, ist ein Diagramm des aufsummierten Regens; Speicherung und Visualisierung sind zwei verschiedene Dinge.

Radar zeigt über einem Raster erfasste reflektierte Energie oberhalb des Bodens. „An diesem Punkt nichts erkannt“ beweist weder, dass jeder Teil des Vorfalls trocken war, noch dass der Niederschlag den Boden erreichte.

## CAMS-Feinstaubprognosen

CAMS liefert zwei optionale Ebenen:

- experimenteller, ausschließlich Waldbränden zugeschriebener PM10-Anteil; und
- PM2,5.

Es handelt sich um stündliche Copernicus-Ensembleprognosen auf einem groben 0,1°-Raster, hier ungefähr 10 km. Sie sind keine lokalen Sensormessungen und beschreiben nicht die Brandgeometrie. Auch die Zuordnung ausschließlich zu Waldbränden stammt aus einem Modell.

Die Datenbank speichert sowohl den georeferenzierten Prognoseausschnitt als auch exakte Werte der Rasterzelle am Vorfall. Die öffentliche Farbskala sättigt bei 500 µg/m³. Der Bildrand wird weich ausgeblendet, damit die rechteckige Datenauswahl nicht als Grenze einer Rauchfahne missverstanden wird; ein verbleibender rasterartiger Eindruck stammt von den groben Modellzellen.

## Flugzeugdaten

### Erkennung und Qualifizierung

Der Live-Import verwendet je eine geografische Punktabfrage von adsb.fi und ADSB.lol für ungefähr zehn nautische Meilen um den Vorfall. Airplanes.live bleibt, soweit verfügbar, als Quelle für Anbieterstatus und abgeschlossene Spuren eingebunden. Die rohen Antworten werden archiviert.

Ein Flugzeug nahe dem Brand wird nur gespeichert, wenn mindestens eines der folgenden Merkmale den Bezug zum Vorfall stützt:

- seine exakte Mode-S-Identität wurde zuvor für den Vorfall bestätigt;
- es sendet ein ausdrückliches Rufzeichen im Muster `GRZLY##`; oder
- Typ, Beschreibung, Hubschrauberkategorie oder militärische Metadaten stützen die Einordnung als möglicher Einsatzflieger.

Die qualifizierende Beobachtung muss höchstens 10 km vom Vorfall entfernt, maximal 120 Sekunden alt, nicht höher als 8.500 ft und nicht schneller als 250 kt sein. Mehrere Empfänger bestätigen eine Position, nicht den Einsatzauftrag des Flugzeugs.

### Vollständige Routen

Sobald eine qualifizierte Flugzeugsitzung den Vorfallradius erreicht, lädt und speichert das System die vollständige durch Empfänger gestützte Sitzung von den verfügbaren Beobachtungen nach dem Start bis zu denen vor der Landung, unabhängig vom Ort. Getrennte, nicht zusammenhängende Sitzungen desselben Tages an anderen Orten werden nicht angehängt.

Exakte Positionen werden in PostgreSQL gespeichert. Der Browser erhält höchstens eine exakte Position je Flugzeug und Zehn-Sekunden-Fenster, damit die Darstellung flüssig bleibt. Lücken über zwei Minuten oder Verbindungen mit einer rechnerischen Geschwindigkeit über 300 kt bleiben als Lücken sichtbar. Es werden keine Punkte erfunden, nur um eine geschlossene Linie zu erzeugen.

Spuren werden mit zunehmendem Alter linear transparenter und verschwinden nach 24 Stunden vollständig von der öffentlichen Karte. Das ist eine Anzeigeregel, keine Löschung: Historische Positionen bleiben in der Datenbank.

### Bekannte und mögliche Einsatzflugzeuge

Die vom Projekt gespeicherte Identitätsliste umfasst:

- G10, G17 und G12, wobei G12 derzeit nur als Foto erscheint, wenn keine geeignete Spur verfügbar ist;
- `GRZLY81` / D-472;
- `GRZLY80` oder `GRZLY91` / D-604;
- `GRZLY81` / D-479;
- `GRZLY80` / D-606;
- `GRZLY80` / D-483;
- `HUMMEL6` / D-HNWW, möglicher EC145;
- `LNOYP` / LN-OYP, möglicher AS350; und
- `TGT42` / SE-MHN, mögliche AT-802.

Rufzeichen können an unterschiedlichen Tagen und von unterschiedlichen Maschinen erneut verwendet werden. Deshalb sind Mode-S-Identität und Zeitstempel wichtig.

Geprüfte Ausschlüsse umfassen OOVST/OO-VST, den Transitflug der Boeing 777 QTR8098 und nicht zugehörigen MLAT-Verkehr bei Aachen/Walheim. Diese Daten bleiben für die Prüfung in den rohen Quellenartefakten, werden jedoch nicht in die Vorfallansicht übernommen.

### Was eine Spur belegt

Ein Punkt belegt ausschließlich, dass ein Anbieter für diesen Transponder beziehungsweise Empfänger zu diesem Zeitpunkt diese Position gemeldet hat — vorbehaltlich möglicher Empfänger- und Metadatenfehler. Eine Route beweist weder Löscheinsatz noch Wasseraufnahme, Wasserabwurf, Nutzlaststatus oder genaue Feuerfront. Das Fehlen einer Spur beweist nicht das Fehlen eines Flugs: Transponderbetrieb, Empfängerabdeckung, MLAT-Qualität, Anbieterhistorie und Datenveröffentlichung verursachen Lücken.

## Behördliche Meldungen und Ereignischronologie

Gemeldete Hektar werden sowohl mit dem in der Meldung genannten Bezugszeitpunkt als auch mit dem Veröffentlichungszeitpunkt gespeichert. Der Zeitstrahl erzwingt keinen monotonen Verlauf, weil Herausgeber den Umfang korrigieren, unterschiedliche Definitionen verwenden oder Näherungswerte veröffentlichen können.

| Bezugs-/Veröffentlichungszeitpunkt | Gemeldete Fläche | Quellenkontext |
| --- | ---: | --- |
| 14. August, gegen 16:00 Uhr | ~60 ha | Gouverneur der Provinz Lüttich |
| 14. August, gegen 20:00 Uhr | ~100 ha | Gouverneur der Provinz Lüttich |
| 15. August, gegen 07:00 Uhr | ~850 ha | Gouverneur der Provinz Lüttich |
| 15. August, 11:28 Uhr | >900 ha | BRF |
| 15. August, 14:30 Uhr | >1.500 ha | BRF |
| 15. August, Bezugszeit etwa 18:00 Uhr, veröffentlicht gegen 21:00 Uhr | ~2.700 ha | Gouverneur der Provinz Lüttich |
| 15. August, 21:16 Uhr | >2.000 ha | BRF |
| 16. August, gegen 21:00 Uhr | ~3.000 ha | Gouverneur der Provinz Lüttich |

Ein Wert erscheint erst, nachdem seine Veröffentlichung für die Website verfügbar ist, selbst wenn der Artikel einen früheren Bezugszeitpunkt beschreibt. Dadurch wird späteres Wissen nicht rückwirkend in den früheren Zeitstrahl eingetragen.

Das Ereignisprotokoll speichert außerdem behördliche Lageinformationen, Evakuierungsangaben mit Straßennamen, die gemeldete Planung von neun Flugzeugen, Hinweise von Kommunen und Rettungsdiensten, öffentliche BE-Alert-CAP-Datensätze und eindeutig als solche bezeichnete lokale Medienberichte. Ereigniskategorien werden zur Navigation abgeleitet; maßgeblich bleibt die verlinkte Veröffentlichung.

Abgelaufene BE-Alert-Datensätze werden nach ihrem Verschwinden aus dem Live-Feed weiter gespeichert. Ein leeres Suchergebnis bedeutet, dass keine passende Warnung erfasst wurde, nicht dass vor Beginn der Erfassung niemals eine existierte. Allgemeine Relevanzfilter eines Anbieterfeeds können außerdem anders formulierte Hinweise übersehen.

## Die 18 synchronisierten Quellengruppen

Der Scheduler läuft auf einem Fünf-Minuten-Raster, jede Quelle behält jedoch eine sinnvolle eigene Sperrzeit und ihren nativen Messrhythmus.

| Quellengruppe | Prüf-/Sperrrhythmus | Nativer Datenrhythmus oder Aufgabe |
| --- | ---: | --- |
| Geografische Flugzeugerkennung, Wiederherstellung archivierter Antworten und aktuelle Spuren | 5 Min. | Exakte Empfängerbeobachtungen bei Veröffentlichung durch die Anbieter. |
| Open-Meteo | 5 Min. | Stündliche Modellzeilen. |
| Meldungen von Gouverneur und BRF | 5 Min. | Veröffentlichungsabhängig. |
| Lokale Behörden und Rettungsdienste | 5 Min. | Veröffentlichungsabhängig. |
| Lokales Medium Vedia | 5 Min. | Veröffentlichungsabhängig. |
| BE-Alert CAP | 5 Min. | Live-Warnfeed plus gespeicherte abgelaufene Meldungen. |
| RMI-Station Mont Rigi | 10 Min. | Zehn-Minuten-Beobachtungen. |
| RMI-Niederschlagsradar | Prüfung alle 5 Min. | Öffentliche Bilder derzeit alle zehn Minuten. |
| DWD-RADOLAN-Niederschlag | Veröffentlichungsprüfung alle 5 Min. | Fünf-Minuten-Beobachtungen in abgeschlossenen Tagesarchiven. |
| DWD-Windstationen | 10 Min. | Zehn-Minuten-Beobachtungen. |
| NASA FIRMS, fünf Produkte | 15 Min. | Abhängig von Sensor und Überflug. |
| NASA GIBS | Prüfung alle 30 Min. | Tägliche Bilder und Überarbeitungen desselben Tages. |
| Copernicus EFFIS | 6 Std. | Tägliches algorithmisches Produkt. |
| Copernicus EMS | 60 Min. | Aktivierungskatalog. |
| Sentinel-2 | Katalogprüfung alle 5 Min. | Rasterverarbeitung einmal pro neuer Aufnahme nach dem Brand. |
| Sentinel-3 | 30 Min. | Abhängig von NRT-FRP-Katalog und Überflug. |
| Sentinel-1 | 60 Min. | Abhängig von Umlaufbahn und Aufnahme. |
| Copernicus CAMS | 60 Min. | Stündliche Modellprognose. |

Die Gruppe lokaler Behörden umfasst Stavelot, Malmedy, Jalhay, Baelen, Eupen, Waimes, Bütgenbach, die Zone de Secours Vesdre-Hoëgne & Plateau, die Hilfeleistungszone DG und die Eifel-Polizei.

„Fünf-Minuten-Granularität“ bedeutet, dass das System in Fünf-Minuten-Zeitfenstern planen, speichern und wiedergeben kann. Es erzeugt keine Satellitenüberflüge im Fünf-Minuten-Takt, keine neuen Stundenprognosen, täglichen Polygone oder Nachrichtenveröffentlichungen.

## Architektur, Speicherung und Aktualisierungsverhalten

### Browserarchitektur

Das Frontend ist eine Single-Page-Anwendung mit React, Vite und Leaflet, kein serverseitig gerendertes HTML. Es zeigt sofort den Rahmen, ruft `/api/data?scope=core` ab, stellt den Vorfall dar und lädt danach `/api/data?scope=aircraft` asynchron. Beide Lesevorgänge werden alle fünf Minuten mit `cache: 'no-store'` wiederholt.

Es gibt weder einen mitgelieferten statischen Vorfalldatensatz noch Browseraufrufe an Datenanbieter. Grundkartenkacheln bleiben extern; eine vom Nutzer ausgewählte lokale Importdatei verbleibt lokal in dessen Browser.

### Datenfluss

```text
Verzögerter Vercel-Queue-Weckruf
  → private Aktualisierungsfunktion
  → quellenspezifische PostgreSQL-Sperre
  → fest definierter externer Anbieter
  → normalisierter aktueller Datensatz
  → unveränderliche Version bei Inhaltsänderung
  → rohes inhaltsadressiertes Artefakt
  → kompakte öffentliche Datenbankprojektion
  → Browser-API
  → Fünf-Minuten-Zeitstrahl
```

Alle Vorfall-API-Antworten setzen `no-store` für Browser, CDN und Vercel-CDN. Es gibt keinen CDN-Datencache. Datenbankgestützte aktuelle Projektionen halten Lesevorgänge effizient, während Sperren verhindern, dass wiederholte Browseranfragen, Queue-Wiederholungen, GitHub-Notläufe oder überlappende Deployments die Zahl externer API-Aufrufe vervielfachen.

### PostgreSQL-Tabellen

- `app_datasets`: neueste vollständige normalisierte Nutzlast je Datensatz.
- `app_dataset_versions`: unveränderliche historische Versionen bei inhaltlichen Änderungen der Quelle.
- `app_public_datasets`: kompakte Projektionen für eine effiziente öffentliche Browserantwort.
- `source_refresh_runs`: jedes beanspruchte Quellen-/Zeitfenster einschließlich erfolgreicher unveränderter Abfragen, Fehler und Elementzahlen.
- `refresh_scheduler_ticks`: Eigentum an Deployment/Weckruf und Schutz vor doppelten Nachrichten.
- `source_artifacts`: inhaltsadressierte Rohantworten, Satellitenvorschauen, ausgeschnittene Rasterarrays, Radardaten, Bildprodukte und Prognosen.
- `flight_import_runs`: Buchführung für idempotente Wiederherstellung und Importe von Flugverläufen.
- `flight_observations`: exakte, deduplizierte Empfängerpositionen.

Semantische Inhaltshashes schließen flüchtige Abrufzeitstempel aus. Eine erfolgreiche unveränderte Abfrage erzeugt dadurch einen prüfbaren Aktualisierungslauf, ohne unnötig eine neue Datensatzversion anzulegen.

Die geprüfte Datenbank enthielt 27 aktuelle Datensätze, 1.548 Inhaltsversionen, 9.632 Artefakte und ungefähr 913 MB originale Quelldaten. Diese Werte verändern sich fortlaufend.

### Wiederherstellung historischer Daten

Die Datenbank enthält einmalige, per Prüfsumme validierte Wiederherstellungen von Daten aus der Zeit vor der Datenbankumstellung, darunter:

- 51 exakte frühe Flugzeugbeobachtungen aus einer unveränderlichen Repository-Version;
- fünf historische Zeilen der gemeldeten Fläche;
- zwei frühere tägliche EFFIS-Produkte;
- von Anbietern gestützte abgeschlossene Flugzeugrouten;
- die FIRMS-Wiederherstellung des Entstehungstags; und
- verfügbare historische DWD-Niederschlagsarchive.

Abschluss-Fingerabdrücke verhindern, dass das System für dieselbe Wiederherstellung wiederholt Anbieter-Kontingent verbraucht.

### Kontinuierlicher Scheduler

Der primäre Weckruf ist eine Vercel-Queue-Nachricht in den Minuten 02/07/12/... jeder Stunde. Der private Consumer plant die nächste verzögerte Nachricht, bevor er die gesperrten Quellen aktualisiert. Die Queue darf die Zustellung wiederholen, ohne Quellen doppelt abzurufen.

Eine GitHub Action läuft alle 15 Minuten als Ausfallsicherung und Deployment-Start. Sie wartet zuerst, bis der Produktionsalias den vorgesehenen Commit ausliefert, und führt dann genau einen Aktualisierungsaufruf aus. Ein täglicher Vercel Cron bietet einen weiteren Wiederanlaufpfad innerhalb der aktuellen Tarifgrenzen.

Der Scheduler ist an das aktive Deployment gebunden. Sobald eine neue Veröffentlichung übernimmt, stoppt die alte Queue-Kette. Deshalb muss ein Workflow während des Deployment-Wartens den ausgelieferten Git-SHA vergleichen, bevor er die Verantwortung für die Aktualisierung übernimmt.

## Was die Website nicht feststellen kann

Die folgenden Punkte sind Interpretationsgrenzen und kein Grund, die vorhandenen Daten zu ignorieren:

- Sie kann amtliche Sicherheits-, Zugangs-, Evakuierungs- oder Notfallanweisungen nicht ersetzen.
- Ohne eine entsprechende Quelle kann sie keine im Feld vermessene operative Brandgrenze liefern.
- Sie kann nicht beweisen, dass der Brand erloschen ist, nur weil FIRMS keine neue lokale Wärme meldet.
- Sie kann aus ADS-B-/MLAT-Spuren weder Wasseraufnahme noch Wasserabwurf, Nutzlaststatus oder Einsatzauftrag beweisen.
- Sie kann Positionen in Empfängerlücken nicht rekonstruieren, ohne Daten zu erfinden — und tut dies bewusst nicht.
- Sie kann Feuer nicht sehen, das durch Wolken, Rauch, Vegetation, Blickgeometrie, Sensorempfindlichkeit oder Überflugzeit vor dem Satelliten verborgen bleibt.
- Ohne Feldkalibrierung kann sie dNBR nicht in eine lokal validierte Schwereklasse umwandeln.
- Ohne koordinatengenaue beziehungsweise kalibrierte Pixel kann sie Sentinel-1-/Sentinel-3-Katalogtreffer oder Vorschaubilder nicht in lokale Messungen verwandeln.
- Sie kann CAMS nicht als lokalen PM-Sensor behandeln oder aus dem Modellausschnitt eine Rauchfahnengrenze ableiten.
- Aus den öffentlichen kategorischen RMI-Bildern kann sie keine quantitative Niederschlagsmenge gewinnen.
- Sie kann die Veröffentlichungsverzögerung abgeschlossener DWD-Tagesarchive nicht beseitigen.
- Sie kann nicht jedem Bestandteil eines täglichen GIBS-Komposits eine exakte Uhrzeit innerhalb des Tages zuweisen.
- Das Lineal kann weder Straßenroute noch Evakuierungsentfernung oder Sicherheitsabstand bestimmen.
- Ein Diagramm des kumulierten historischen Niederschlags fehlt derzeit, obwohl die einzelnen historischen Bilder gespeichert sind.
- Aus einem fehlenden Treffer im öffentlichen EMS-Katalog kann sie nicht ableiten, dass keine operative Kartierung existiert.
- Sie muss zwischen einer erfolgreichen unveränderten Abfrage, einer fehlgeschlagenen Aktualisierung und einer tatsächlich neuen Beobachtung unterscheiden.

## Interviewfragen mit knappen Antworten

### „Warum gibt es drei unterschiedliche Flächenzahlen?“

Sie beantworten unterschiedliche Fragen. Die gemeldete Fläche wiederholt die von einer Quelle genannte betroffene Fläche. Die „Best estimate“ ist die reproduzierbare 50-Meter-Union der Website aus qualifizierenden Belegen. EFFIS ist ein unabhängiges, breiteres tägliches algorithmisches Satellitenprodukt. Diese Werte getrennt zu zeigen ist ehrlicher, als sie in eine einzige Zahl zu zwingen.

### „Ist die Best estimate amtlich?“

Nein. Sie ist eine transparent abgeleitete Schätzung mit eindeutigen Zulassungsregeln. Sie nutzt ausschließlich Belege, die zum ausgewählten Zeitpunkt verfügbar waren, und hält Geometrie und Hektarangabe konsistent. Für operative Grenzen und Sicherheit bleiben die Behörden maßgeblich.

### „Warum kann FIRMS aktuell sein, obwohl die neueste Detektion alt ist?“

Der Feed kann erfolgreich abgefragt werden, ohne dass ein Satellit eine neue lokale thermische Anomalie liefert. `generatedAt` bezeichnet die Abfragezeit, `latestAcquiredAt` die neueste Beobachtungszeit. Überflugzeit, Wolken, Blickgeometrie, Empfindlichkeit und das tatsächliche Brandverhalten entscheiden darüber, ob eine neue Zeile erscheint.

### „Warum wird nicht einfach um jedes FIRMS-Pixel ein Polygon gezeichnet?“

Jedes Produkt besitzt eine andere Auflösung und ein anderes Risiko für Fehlalarme oder räumliche Verschiebungen. Eine Union aller Punkte würde die Sicherheit übertreiben und wiederholte grobe Beobachtungen als neu verbrannten Boden zählen. Die Schätzung verlangt unabhängige VIIRS-Bestätigung und begrenzt gröbere oder indirekte Unterstützung streng.

### „Warum kann die Schätzung kleiner werden?“

Sie ist eine Evidenzschätzung für den ausgewählten Zeitpunkt und keine Behauptung einer kumulativen verbrannten Fläche. Der Algorithmus verwendet nur den neuesten qualifizierenden MODIS-Überflug; flugzeugbasierte Randbelege laufen nach 24 Stunden aus. Das Ersetzen vorübergehender Unterstützung kann Zellen entfernen, während sämtliche Rohhistorie erhalten bleibt.

### „Warum zeigt Sentinel-2 nur einen kleinen Teil?“

Das Bildpaar war nur über einem Teil des Ausschnitts klar. Das Verfahren übernimmt ausschließlich starke, zusammenhängende positive dNBR-Änderungen nahe unabhängig bestätigten thermischen Belegen. Verdeckte oder nicht qualifizierende Pixel sind unbekannt, nicht unverbrannt, und entfernen niemals andere Belege.

### „Beweisen Flugzeugkurven, wo Wasser abgeworfen wurde?“

Nein. Sie zeigen wiederholte scharfe Manöver nahe einem thermisch gestützten Rand. Öffentliche Empfängerfeeds enthalten weder Nutzlast- noch Abwurfstatus. Der Algorithmus schließt entfernte Routen aus und bezeichnet das Ergebnis als flugzeuggestützten Hinweis, nicht als bestätigte Abwurflinie.

### „Wird wirklich alles alle fünf Minuten aktualisiert?“

Scheduler und Zeitstrahl haben eine Fünf-Minuten-Granularität. Die Anbieter behalten ihren eigenen Rhythmus: RMI- und DWD-Stationen messen alle zehn Minuten, Open-Meteo und CAMS liefern stündliche Daten, FIRMS hängt von Satellitenüberflügen ab und EFFIS sowie GIBS sind Tagesprodukte.

### „Werden die Daten gecacht?“

Für die Vorfall-APIs gibt es keinen Browser- oder CDN-Cache. PostgreSQL ist der dauerhafte Datenspeicher und liefert die Leseprojektion. Quellenspezifische Datenbanksperren verwenden den bereits synchronisierten Stand und verhindern, dass wiederholte Aktualisierungsauslöser begrenzte Anbieteraufrufe verbrauchen.

### „Wird die Seite serverseitig gerendert?“

Nein. Es ist eine schlanke, clientseitig gerenderte React-Anwendung. Zuerst erscheint der Rahmen, danach lädt die Kerndatenbankprojektion sofort und die wesentlich größere Flugzeughistorie asynchron. So bleibt die erste nützliche Ansicht klein, ohne veraltete lokale Snapshots auszuliefern.

### „Warum sehen die PM-Ebenen rechteckig oder blockartig aus?“

CAMS ist ein grobes 0,1°-Modellraster, das über einen rechteckigen regionalen Ausschnitt geliefert wird. Der Rand wird weich ausgeblendet, damit er nicht als Rauchfahnengrenze erscheint; die zugrunde liegenden Rasterzellen bleiben dennoch erkennbar. Es ist keine lokale Sensorkarte.

### „Welche Ergänzung würde die Verlässlichkeit am stärksten verbessern?“

Eine zeitgestempelte amtliche operative Brandgrenze wäre die wichtigste Verbesserung. Ebenfalls nützlich wären verifizierte Einsatz- und Flugprotokolle, GPS-Beobachtungen im Feld, kalibrierte lokale Luftqualitätssensoren und zugängliche koordinatengenaue oder kalibrierte Sentinel-1-/Sentinel-3-Produkte. Die öffentliche Website bittet Personen mit legitimem Zugang um Kontakt, ohne vorzutäuschen, diese Daten seien allgemein verfügbar.

## Quellen und Projektdokumentation

- [Produktionswebsite](https://venn-fire.vercel.app)
- [Projekt-README](../README.md)
- [Methodik der Sentinel-2-Analyse](sentinel2-analysis.md)
- [Internes Inventar synchronisierter Quellenlimits](known-source-limits.md)

In der öffentlichen Darstellung sollten zuerst die Trennung der Belegarten, die Zeitstempel und die Interpretationsgrenzen erklärt werden. Die stärkste Aussage ist nicht, dass die Website alles weiß, sondern dass sie bewahrt, was jede Quelle tatsächlich gemeldet hat, abgeleitete Logik reproduzierbar macht und verhindert, dass eine Belegart als eine andere ausgegeben wird.
