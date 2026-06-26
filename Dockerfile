FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY . .
RUN npm run build

FROM node:20-alpine AS production

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

COPY --from=builder /app/build ./build

RUN addgroup -g 1001 -S nodejs && \
    adduser -S xscode -u 1001 && \
    chown -R xscode:nodejs /app

USER xscode

EXPOSE 8888

CMD ["node", "build/app.js"]
