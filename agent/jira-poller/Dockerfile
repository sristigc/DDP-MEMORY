# Build context is /agent (Railway Root Directory) so the shared library is included.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY shared ./shared
COPY jira-poller ./jira-poller
USER node
CMD ["node", "jira-poller/main.mjs"]
