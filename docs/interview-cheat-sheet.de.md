# Venn Fire Watch — Interview-Spickzettel für 15 Minuten

Dies ist die Kurzfassung des [ausführlichen Interview-Leitfadens](interview-guide.de.md). Präge dir den Einstieg, die drei Flächendefinitionen, die Rollen der Datenquellen und die fünf wichtigsten Einschränkungen ein. Alles Weitere lässt sich daraus herleiten.

> Die exakten Live-Werte ändern sich. Die Beispiele unten wurden am 18. August 2026 gegen 12:10 Uhr MESZ geprüft. Kontrolliere deshalb immer den aktuellen Zeitstempel, bevor du Zahlen nennst.

## Der Ein-Minuten-Einstieg

> Venn Fire Watch ist eine in Fünf-Minuten-Schritten rückblickend nutzbare Übersicht für den Brand im Hohen Venn bei Drossart. Sie führt behördliche Meldungen, satellitengestützte Wärme- und Bilddaten, öffentlich empfangene Flugzeugpositionen, Wetter, Niederschlagsradar, Luftqualitätsprognosen, Warnungen und Mitteilungen lokaler Behörden auf einem gemeinsamen, durch PostgreSQL gespeisten Zeitstrahl zusammen.
>
> Entscheidend ist, dass die Anwendung diese Quellen nicht so behandelt, als würden sie alle dasselbe aussagen. Die gemeldete Fläche ist die von Behörden veröffentlichte Zahl. Die „Best estimate“ ist unsere konservative, aus Belegen abgeleitete Rasterunion mit 50-Meter-Zellen. EFFIS ist ein breiteres tägliches algorithmisches Produkt. FIRMS-Punkte sind Wärmedetektionen, und Flugspuren sind Empfängerpositionen — weder eine amtliche Grenze noch ein Nachweis für Wasserabwürfe.
>
> Vercel Functions aktualisieren jede Quelle in einem sinnvollen Rhythmus. PostgreSQL speichert aktuelle und historische Daten sowie die Rohdaten für die Nachvollziehbarkeit. Der Browser liest ausschließlich aus dieser Datenbank. Die Website dient dem Lageverständnis und der Rekonstruktion dessen, was zu einem bestimmten Zeitpunkt bekannt war. Für Sicherheit, Zugang und Evakuierungen bleiben die Behörden maßgeblich.

Wenn du das natürlich formulieren kannst, beherrschst du bereits die Kernaussage.

## Die drei Zahlen, die du kennen musst

1. **Gemeldete Fläche** — eine aus einer Quelle zitierte Zahl. Sie wird bis zur nächsten Meldung fortgeschrieben und kann „betroffen“ bedeuten, nicht vollständig oder gleichmäßig verbrannt.
2. **Best estimate (beste Schätzung)** — die abgeleitete rote Kontur der Website auf einem 50-Meter-Raster. Sie kombiniert strenge Satellitenbelege mit konservativer, lokal auf den Einsatz bezogener Flugzeugunterstützung. Sie ist reproduzierbar, aber nicht amtlich.
3. **EFFIS-Fläche** — eine unabhängige, breite, täglich algorithmisch erzeugte VIIRS-Hülle. Sie dient als Vergleich, nicht als Ground Truth, und verändert die „Best estimate“ niemals.

Geprüftes Beispiel: gemeldet etwa **3.000 ha**, „Best estimate“ **3.057 ha**, EFFIS **6.334 ha**. Die Abweichung ist zu erwarten, weil die drei Werte unterschiedliche Fragen beantworten.

## So entsteht die „Best estimate“

Merksatz: **VIIRS-Kern → neueste MODIS-Unterstützung → wolkenfreie Sentinel-2-Änderung → wiederholte lokale GRZLY-Kurven → eine 50-Meter-Union.**

- **VIIRS-Kern:** Mindestens zwei unabhängige VIIRS-Satelliten stützen ungefähr denselben Ort; mindestens eine Beobachtung besitzt hohe Konfidenz.
- **MODIS:** Nur hochkonfidente Pixel des neuesten Terra-/Aqua-Überflugs dürfen einen bereits gestützten Rand erweitern. Die groben 1-km-Pixel können keinen eigenen Kern bilden, und alte Überflüge werden nicht unbegrenzt aufaddiert.
- **Sentinel-2:** Verglichen werden Nah- und Kurzwelleninfrarotbilder vor und nach dem Brand. Hinzugefügt werden ausschließlich klare, starke, zusammenhängende positive dNBR-Änderungen in der Nähe des thermischen Kerns. Bewölkte oder verworfene Pixel sind unbekannt, nicht unverbrannt.
- **Flugzeuge:** Nur wiederholte scharfe Kurven von `GRZLY##` nahe dem thermischen Rand können kleine, kompakte Ausbuchtungen hinzufügen. Die vollständige Route, An- und Abflug, der Weg zur Wasserquelle und isolierte Ausreißer werden ausgeschlossen. Das ist ein unterstützender Hinweis, niemals der Nachweis eines Abwurfs.
- **Union:** Sämtliche Belege werden auf 50-Meter-Zellen gerastert. Die rote Geometrie und die Hektarangabe stammen exakt aus denselben Zellen. Eine separate „Touched zone“ gibt es nicht.

Die Schätzung kann kleiner werden, wenn ein neuer MODIS-Überflug den vorherigen ersetzt oder flugzeuggestützte Hinweise nach 24 Stunden auslaufen. Die historischen Rohdaten bleiben trotzdem gespeichert.

## Was die wichtigsten Quellen beitragen

| Quelle | Beitrag | Was sie **nicht** beweist |
| --- | --- | --- |
| Gouverneur/BRF/lokale Behörden | Gemeldete Fläche und Ereignischronologie | Exakte operative Feldgrenze |
| FIRMS VIIRS | Unabhängige polare Wärmedetektionen und den bestätigten Kern der Schätzung | Verbrannte Fläche aus einem einzelnen Pixel |
| FIRMS MODIS | Grobe Unterstützung des neuesten Überflugs um einen bestehenden Rand | Eigenständigen Kern |
| FIRMS Meteosat | Häufige, grobe und kurzlebige thermische Einordnung | Hektarangabe oder Schätzgeometrie |
| Sentinel-2 | Hochauflösende positive, wolkenfreie spektrale Änderung | Vollständige Brandnarbe oder lokal kalibrierte Schwere |
| EFFIS | Unabhängige, breite tägliche Brandgeometrie | Operative Ground Truth |
| Sentinel-1/3 | Katalog-, Überflug- und Vorschaubildkontext | Lokale Änderung oder Wärme ohne kalibrierte beziehungsweise koordinatengenaue Daten |
| GIBS | Tägliche visuelle Satellitenbilder | Gemessene Brandgrenze |
| Flugzeugempfänger | Exakte öffentlich gemeldete Positionen und vollständige einsatzbezogene Sitzungen | Auftrag, Nutzlast, Wasserabwurf oder Positionen innerhalb von Datenlücken |
| RMI/DWD/Open-Meteo | Getrennte Stations-, Radar- und Modellinformationen | Eine perfekt zusammengeführte Wetterwahrheit am Brandort |
| CAMS | Grobe Feinstaubprognosen | Lokale Sensormessung oder Rauchfahnengrenze |
| BE-Alert/Kommunen/Medien | Durchsuchbare Chronologie und öffentliche Kommunikation | Vollständiges Archiv aus der Zeit vor Beginn der Erfassung |

## Fünf Fakten, die die meisten falschen Antworten verhindern

1. **Eine aktuelle Abfrage ist nicht dasselbe wie eine aktuelle Beobachtung.** FIRMS kann jetzt erfolgreich abgefragt worden sein, obwohl die neueste lokale Wärmedetektion von gestern stammt.
2. **Fünf-Minuten-Granularität bedeutet nicht, dass jede Quelle alle fünf Minuten misst.** Sie bezeichnet das Raster von Scheduler und Zeitstrahl; Satelliten, Stundenmodelle, Zehn-Minuten-Stationen und Tagesprodukte behalten ihren echten Rhythmus.
3. **Keine Detektion beweist nicht, dass kein Feuer vorhanden ist.** Wolken, Rauch, Vegetationsdecke, Überflugzeit, Blickgeometrie, Empfindlichkeit und Empfängerabdeckung erzeugen Lücken.
4. **Sichtbarkeit auf der Karte ist nicht gleich Mitgliedschaft in der Schätzung.** Ebenenschalter und FIRMS-Konfidenzfilter ändern die Darstellung, nicht den Schätzalgorithmus.
5. **Alle wichtigen Daten bleiben erhalten.** PostgreSQL speichert aktuelle normalisierte Datensätze, unveränderliche Inhaltsversionen, Aktualisierungsläufe, Rohdaten-Artefakte und exakte Flugzeugbeobachtungen. Öffentliche Flugspuren verblassen lediglich und verschwinden nach 24 Stunden aus der Karte.

## Die Architektur in 20 Sekunden

```text
Vercel Queue alle fünf Minuten
  → Aktualisierungsfunktion
  → quellenspezifische Datenbanksperre
  → externer Anbieter
  → PostgreSQL: aktueller Stand + Historie + Rohdaten-Artefakt
  → kompakte API ohne Cache
  → React-/Leaflet-Browseranwendung
```

Es gibt weder einen CDN-Cache noch einen mitgelieferten statischen Ersatzdatensatz für den Vorfall. Die Datenbank ist die dauerhafte, synchronisierte Quelle; Sperren schützen die begrenzten API-Kontingente der Anbieter. Die Seite wird clientseitig gerendert: Zuerst lädt die kleine Kernansicht, anschließend asynchron die umfangreichere Flugzeughistorie.

Das Wetterfeld hält Beobachtungen zum ausgewählten Zeitpunkt von der neuesten Open-Meteo-Prognose getrennt. Letztere zeigt jede Modellstunde der nächsten 48 Stunden mit Regen, Bewölkung, Sichtweite, Temperatur, Wind und Böen.

## Wissenswerte Beispiele zum geprüften Stand

Zum Prüfzeitpunkt galt:

- FIRMS enthielt 3.234 exakt gespeicherte Detektionen; mit den Standardfiltern waren davon 1.724 sichtbar.
- Die neueste Wärmedetektion stammte vom 17. August um 15:06 Uhr MESZ, obwohl FIRMS am 18. August erfolgreich geprüft worden war. Das bedeutet „keine neuere Wärme zurückgeliefert“, nicht „Import defekt“ oder „Brand nachweislich gelöscht“.
- Die „Best estimate“ betrug 3.057 ha.
- Sentinel-2 war nur über 21,9 % des gepaarten Ausschnitts wolkenfrei. Deshalb bedeckte der violette Beleg lediglich einen kleinen Teil.
- Am ausgewählten aktuellen Tag wurde kein Flugzeug gesehen; fünf waren noch im rollierenden 24-Stunden-Fenster sichtbar. Das Fehlen öffentlicher Empfängerpositionen bedeutet nicht, dass kein Flug stattfand.
- RMI Mont Rigi meldete Wind aus WSW bei 246°, in Richtung 66°, mit 17,7 km/h und Böen bis 28,3 km/h.
- Die CAMS-Werte lagen bei 54,6 µg/m³ für den experimentellen, ausschließlich Waldbränden zugeschriebenen PM10-Anteil und 46,6 µg/m³ für PM2,5. Beides sind grobe Modellwerte, keine lokalen Sensormessungen.

Lerne diese Zahlen nicht als dauerhafte Werte auswendig — lerne, ihre Zeitstempel zu erklären.

## Schnelle Interviewantworten

**Ist die rote Kontur amtlich?**  
Nein. Sie ist eine transparente, reproduzierbare Evidenzschätzung. Maßgeblich bleiben die Behörden.

**Warum sind FIRMS-Punkte keine Brandgrenze?**  
Sie sind Sensorfußabdrücke thermischer Anomalien zu bestimmten Zeitpunkten. Auflösung und Unsicherheit unterscheiden sich je nach Produkt.

**Warum ist EFFIS so viel größer?**  
Es ist eine andere, täglich algorithmisch erzeugte Hülle mit einem anderen Zweck und einer anderen Auflösung.

**Warum ist der Sentinel-2-Bereich so klein?**  
Zugelassen werden nur klare, starke und zusammenhängende positive Änderungen. Der Großteil des Bildpaares war verdeckt oder wurde verworfen und gilt deshalb als unbekannt.

**Hat das Flugzeug dort Wasser abgeworfen?**  
Die Route kann wiederholte lokale Manöver nahe einem thermisch gestützten Rand zeigen. Öffentliche Empfängerdaten enthalten aber keinen Nutzlast- oder Abwurfstatus. Wir sagen „flugzeuggestützter Rand“, niemals „bestätigter Abwurf“.

**Warum gibt es heute keine Flugzeuge?**  
Für diesen Tag wurden keine qualifizierenden öffentlichen Empfängerbeobachtungen gespeichert. Empfängerabdeckung, Transpondernutzung, Anbieterhistorie und der tatsächliche Einsatz können das erklären; die Website erfindet fehlende Positionen nicht.

**Warum kann die Schätzung kleiner werden?**  
Die Unterstützung des neuesten MODIS-Überflugs ersetzt die ältere, und flugzeugbasierte Unterstützung läuft nach 24 Stunden aus. Es handelt sich um eine aktuelle Evidenzschätzung, nicht um die Behauptung einer monoton wachsenden kumulativen Brandnarbe.

**Speichert die Website Anbieterdaten zwischen?**  
Sie speichert sie dauerhaft in PostgreSQL. Die öffentliche API verwendet `no-store`; Datenbanksperren verhindern doppelte externe Abfragen.

**Sind die PM-Rechtecke echte Rauchfahnengrenzen?**  
Nein. CAMS ist ein grobes rechteckiges Modellraster. Die Darstellung blendet den Rand des Ausschnitts weich aus, kann aber keine feineren Ortsinformationen erfinden.

**Welche Daten würden die Sicherheit am stärksten erhöhen?**  
Eine zeitgestempelte amtliche operative Grenze, verifizierte Einsatzflugprotokolle, GPS-Feldbeobachtungen, lokal kalibrierte PM-Sensoren und zugängliche koordinatengenaue oder kalibrierte Sentinel-Produkte.

## Fünf Einschränkungen, die du ohne Zögern nennen solltest

- Informationsübersicht, kein Notfalldienst.
- Abgeleitete „Best estimate“, keine amtliche Brandgrenze.
- Thermische Anomalie, nicht automatisch verbrannte Fläche.
- Empfängerposition, nicht automatisch Löscheinsatz oder Wasserabwurf.
- Fehlende oder alte Beobachtungen bedeuten „nicht beobachtet“, nicht „nicht geschehen“ oder „Feuer aus“.

## Ein guter Schlusssatz

> Der Wert der Website besteht nicht darin, perfektes Wissen zu behaupten. Sie bewahrt, was jede Quelle tatsächlich beobachtet oder gemeldet hat, hält diese Belegarten auseinander, macht die abgeleitete Schätzung reproduzierbar und ermöglicht die Rekonstruktion dessen, was zu jedem Zeitpunkt bekannt sein konnte.
