FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y poppler-utils imagemagick \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]