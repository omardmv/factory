FROM node:24-alpine
WORKDIR /app
COPY bot.mjs .
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "bot.mjs"]
