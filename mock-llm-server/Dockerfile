FROM node:lts-trixie-slim

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY src ./src

RUN npm run build

EXPOSE 9999

CMD ["npm", "start"]