FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends espeak-ng ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=4317
ENV HOST=0.0.0.0
EXPOSE 4317

CMD ["npx", "tsx", "src/server/index.ts"]
