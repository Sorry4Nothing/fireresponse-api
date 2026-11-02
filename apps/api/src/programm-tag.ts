const TAG = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Zurich",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// Programmtag als yyyy-mm-dd: ganztägig tag_von, sonst das Schweizer Datum des Beginns
export const programmTag = (zeit: {
  tagVon: string | null;
  beginn: Date | null;
}) => (zeit.beginn ? TAG.format(zeit.beginn) : (zeit.tagVon ?? ""));
