# Image for the Node inventory app (Express API + dashboard).
#
# Uses the Debian-slim base (glibc) rather than Alpine (musl) so better-sqlite3
# installs its prebuilt native binary instead of compiling from source.
FROM node:22-bookworm-slim
WORKDIR /app

# Install production dependencies in their own cached layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (public/ dashboard, src/, scripts/, sample_inventory.csv, ...).
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Basic healthcheck for orchestration (depends_on: service_healthy).
HEALTHCHECK --interval=10s --timeout=3s --retries=6 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
