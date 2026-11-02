# API-Image für die Produktion; gebaut aus dem Wurzelverzeichnis: docker build -f apps/api/Dockerfile .
FROM node:26-alpine
# Verknüpft das Paket in der GitHub Container Registry mit dem Repository
LABEL org.opencontainers.image.source="https://github.com/Sorry4Nothing/fireresponse-api"
ENV NODE_ENV=production

WORKDIR /app
# Erst die Paketlisten: Die Schicht mit den Abhängigkeiten bleibt im Cache, bis sie sich ändern
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
# Nie --omit=optional: Es entfernt das Binary von esbuild, das tsx braucht
# --omit=peer: better-auth listet vitest, drizzle-kit u. a. als optionale Peers; ohne das Flag landen sie (mit rolldown, lightningcss) im Image
RUN npm ci --omit=dev --omit=peer -w apps/api && npm cache clean --force
COPY apps/api/ apps/api/

USER node
WORKDIR /app/apps/api
# tsx als Loader statt eines Builds: Node bildet die Importe auf .js nicht auf .ts-Dateien ab. Nie die tsx-CLI, sie startet einen Kindprozess mit IPC-Pipe
CMD ["node", "--import", "tsx", "src/server.ts"]
