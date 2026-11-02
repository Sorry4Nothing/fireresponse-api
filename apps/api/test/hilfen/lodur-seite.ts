// Die Terminliste von Lodur (index.php?modul=13&what=10&year=…), im Aufbau der echten Seite: Kopf und Zeilen stehen in zwei Tabellen, die Zeilen in id="default". Die Zeilen der Fixture sind echte Zeilen der Seite
export type Zeile = [
  tag: string,
  datum: string,
  zeit: string,
  thema: string,
  stoff: string,
  art: string,
];

const KOPF = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">
<html>
<head>
<title>LODUR Jfw-Beispiel</title>
<meta charset="iso-8859-1">
</head>
<body><div id='seite'>
<div id="menu"><table id='menutab' align='left'><tr><td class='menucont'><a href='index.php?modul=13'>Übungen</a></td></tr></table></div>
<div class=tablecontent>
<div id='id_ubungen_parent'><div width="100%">		<div class="_scrollableTab">
			<table class="tabelle " id="default-static_head" rel="default" cellspacing="0" cellpadding="3">
				<thead>
			    <tr class="tabelle-tr-head ">
			        <th valign="top" width="10%">Tag</th>
			        <th valign="top" width="20%">Datum</th>
			        <th valign="top" width="15%">Zeit</th>
			        <th valign="top" width="20%">Thema | Dienst</th>
			        <th valign="top" width="15%">Übungsstoff</th>
			        <th valign="top" width="20%">Art</th>
			    </tr>
				</thead>
			</table>
		</div>
`;

export function lodurSeite(zeilen: Zeile[]) {
  if (zeilen.length === 0) {
    return `${KOPF.slice(0, KOPF.indexOf('		<div class="_scrollableTab">'))}</div></div></div></body></html>`;
  }
  const reihen = zeilen
    .map(
      (z, i) => `<tr class="tabelle-tr-${i % 2 ? "dark" : "light"}">
			        ${z.map((zelle, s) => `<td valign="top" width="${[10, 20, 15, 20, 15, 20][s]}%">${zelle}</td>`).join("\n			        ")}
			    </tr>`,
    )
    .join("");
  return `${KOPF}
		<div id="default_newScroll">
			<table id="default" width="100%" border="0" cellpadding="3" cellspacing="0" class="tabelle ">
			<tbody>
			${reihen}			</tbody>
			</table>
		</div></div></div></div></body></html>`;
}

// Die Lodur-Seite ist iso-8859-1, nicht UTF-8
export const alsLatin1 = (html: string) => Buffer.from(html, "latin1");

export const ECHTE_ZEILEN: Zeile[] = [
  [
    "Fr",
    "16.01.2026",
    "17:30 - 22:00",
    "Kdt. Rapport / 100. DV",
    "FW Küsnacht",
    "Sitzung",
  ],
  [
    "Mi",
    "25.02.2026",
    "19:00 - 21:30",
    "Materialkenntnis ab TLF/Funken",
    "OaS",
    "Übung",
  ],
  [
    "Fr",
    "19.06.2026 - 20.06.2026",
    "19:00 - 22:00",
    "J-NH Nothilfekurs",
    "",
    "Kurs",
  ],
  [
    "Mi",
    "08.07.2026",
    "19:00 - 21:30",
    "Atemschutz (Trocken) / OC",
    "Meilen",
    "Übung",
  ],
  ["Sa", "11.07.2026", "07:30 - 16:30", "GW-JII Jugend 2 ", "", "Kurs"],
  ["Mo", "13.07.2026 - 17.07.2026", "07:15 - 15:30", "G-J Jugend", "", "Kurs"],
  [
    "Fr",
    "18.09.2026 - 19.09.2026",
    "19:00 - 22:00",
    "J-NH Nothilfekurs",
    "",
    "Kurs",
  ],
  [
    "Fr",
    "18.09.2026 - 19.09.2026",
    "19:00 - 22:00",
    "J-NH Nothilfekurs",
    "",
    "Kurs",
  ],
  ["Di", "22.09.2026 - 23.09.2026", "08:00 - 17:30", "", "", "Kurs"],
  [
    "Sa",
    "26.09.2026",
    "11:00 - 19:00",
    "Tag der offenen Türe - Stöckeweid",
    "Meilen",
    "Anlass",
  ],
  [
    "Mi",
    "21.10.2026",
    "19:00 - 21:30",
    "Sanitätsübung",
    "Oetwil am See",
    "Übung",
  ],
];
