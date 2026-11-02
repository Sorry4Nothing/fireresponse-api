import { EINWILLIGUNG_VERSION } from "./einwilligung.js";

export type Abschnitt = { titel: string; text: string };

const ENTITAETEN: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

// Ein Absatz pro Block, Zeilenumbrüche des Quelltexts werden zu Leerzeichen; Listenpunkte beginnen mit «– »
function klartext(html: string) {
  return html
    .replace(/<dt>([\s\S]*?)<\/dt>\s*<dd>/g, "<p>$1: ")
    .replace(/<li>/g, "<p>– ")
    .replace(/<\/(p|li|dd|h3|section|ul|dl)>/g, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTITAETEN[e]!)
    .split(/\n{2,}/)
    .map((absatz) => absatz.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

// Gleiche Quelle wie die Seite GET /datenschutz: Sie bekommt deren fertig gerenderten Text, darum laufen Seite und Text nie auseinander
export function datenschutzText(html: string) {
  const haupt = /<main>([\s\S]*)<\/main>/.exec(html)?.[1] ?? "";
  const abschnitte: Abschnitt[] = haupt
    .split(/(?=<h[12]>)/)
    .map((teil) => {
      const [, titel, rest] = /^<h[12]>([\s\S]*?)<\/h[12]>([\s\S]*)$/.exec(
        teil,
      ) ?? ["", "", ""];
      return { titel: klartext(titel!), text: klartext(rest!) };
    })
    .filter((a) => a.titel !== "");
  return { version: EINWILLIGUNG_VERSION, abschnitte };
}
