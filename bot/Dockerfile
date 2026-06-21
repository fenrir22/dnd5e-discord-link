FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /app/data

VOLUME /app/data

ENV WS_PORT=4758
ENV LINKS_FILE=/app/data/links.json

EXPOSE 4758

CMD ["node", "index.js"]
