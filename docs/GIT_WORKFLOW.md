# Git-Workflow

## Branches

- `develop` ist der Integrationsbranch und der Default-Branch des Repos. Jede Änderung kommt per PR hierher.
- `main` ist die Produktion. Ausgerollt wird nur von `main`.
- Beide Branches sind geschützt: Änderungen nur per PR, auch für Admins; kein Force-Push, kein Löschen.
- Die CI muss grün sein, bevor ein PR gemergt wird.

## Pro Issue

1. Den Branch mit der GitHub CLI aus dem Issue erzeugen, damit er im Issue unter «Development» steht: `gh issue develop <nr> --name feature/<nr>-<kurzname> --base develop --checkout`. Für Fehler heisst er `fix/<nr>-<kurzname>`.
2. Ein Branch und ein PR pro Issue.
3. Der PR geht nach `develop`, im Text steht `Closes #<nr>`. Weil `develop` der Default-Branch ist, schliesst GitHub das Issue beim Merge.
4. Der PR übernimmt Labels und Milestone des Issues.
5. Der PR-Text hat die Überschriften der Vorlage: Summary, Evidence, Merge Danger, Barrierefreiheit. Sie gelten auch, wenn `gh pr create --body` die Vorlage übergeht. Bei UI-Änderungen nennt Evidence die geprüften Punkte der [Checkliste Barrierefreiheit](barrierefreiheit.md).
6. Gemergt wird auf GitHub.

## Commits

Conventional Commits mit deutschem Betreff in Schweizer Schreibweise und der Nummer des Issues am Schluss, z. B.:

```text
chore: Monorepo-Gerüst mit npm workspaces und CI (#2)
```

## Release

Ein Release ist ein PR von `develop` nach `main`, gemergt mit «Create a merge commit». Nur so kommen die Commits von `develop` unverändert nach `main`. Squash und Rebase schreiben Kopien davon; der nächste Release-PR listet dann alte Commits noch einmal und kann Konflikte haben.

Ein Release läuft so:

1. Release-PR von `develop` nach `main`, gemergt mit «Create a merge commit».
2. Der Merge nach `main` startet den Workflow «Release» von selbst mit Stufe `minor` und Ausrollen; von Hand geht es unter Actions → Release → Run workflow, Branch `main`, etwa für `major` oder eine Version. Er setzt den annotierten Tag auf den Commit, der den Lauf auslöst (beim Merge der Merge-Commit, von Hand der Kopf von `main`), baut das Image und rollt es nach der Freigabe der Umgebung `production` aus (Haken «ausrollen»). Die Stufe `minor` erhöht z (`v0.9.9` → `v0.9.10`), `major` erhöht y und setzt z auf 0 (`v0.9.9` → `v0.10.0`). x steigt nie von selbst: Nur das Feld «version» (z. B. `1.0.0`) erhöht es, und die Nummer muss grösser als der letzte Tag sein. Jede Stelle ist eine ganze Zahl ohne Obergrenze; die Rechnung steht in `deploy/naechste-version.sh`. Von Hand geht es weiter: `git fetch origin`, `git tag -a vX.Y.Z -m "Release X.Y.Z" origin/main`, `git push origin vX.Y.Z`.

Das gilt für die API. Die iOS- und die Android-App liegen in eigenen Repos und haben dort ihren eigenen Ablauf. Image und Deploy der API stehen in [betrieb.md](betrieb.md) unter «Release».

## Was nie ins Repo kommt

Das Repo ist öffentlich, und FireResponse verwaltet Daten von Kindern. Darum kommt nichts davon ins Repo, in Issues, in PRs oder auf Screenshots:

- echte Namen
- CSV-Dateien und andere Exporte
- Demo-Zugangsdaten
- Server-Zugänge (IP-Adressen, SSH)
- `.env`-Dateien und ihre Werte

Screenshots stammen nur aus der Demo-Abteilung.
