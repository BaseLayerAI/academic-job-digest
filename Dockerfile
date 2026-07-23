FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src

# install tsx + ts to run TS directly (avoids build step)
RUN npm install tsx typescript @types/node @types/pg --no-save

ENV NODE_ENV=production

CMD ["npx", "tsx", "src/index.ts"]
