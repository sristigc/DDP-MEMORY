# Build context is /agent (Railway Root Directory) so the shared library is included.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY shared ./shared
COPY agent-runner ./agent-runner
USER node
CMD ["node", "agent-runner/main.mjs"]
