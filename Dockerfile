FROM node:20-slim AS base

WORKDIR /app
ENV PORT=4000

# ---- deps (cached) ----
FROM base AS deps

# Install dependencies first for better layer caching
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# ---- prod ----
FROM base AS prod

ENV NODE_ENV=production

# Copy dependencies and app source
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Create writable dirs for mounted volumes
RUN mkdir -p /app/data /app/uploads \
  && true
EXPOSE 4000

# Healthcheck without curl (uses Node's fetch)
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=10 \
  CMD node -e "const p=process.env.PORT||4000;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]

# ---- dev ----
FROM base AS dev

ENV NODE_ENV=development

COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 4000
CMD ["npm", "run", "dev"]

