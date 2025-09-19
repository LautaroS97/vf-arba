# Usa la imagen oficial de Node.js con la última versión LTS
FROM node:18-slim

# Instala las dependencias necesarias para Puppeteer
RUN apt-get update \
    && apt-get install -y wget --no-install-recommends \
    && apt-get install -y ca-certificates fonts-liberation libappindicator3-1 libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 libnss3 libxcomposite1 libxrandr2 xdg-utils lsb-release libgbm-dev

# Establece el directorio de trabajo
WORKDIR /app

# Copia package.json y package-lock.json
COPY package*.json ./

# Instala las dependencias
RUN npm install

# Copia el resto del código de la aplicación
COPY . .

# Exponer el puerto en el que se ejecuta la aplicación
EXPOSE 80

# Comando para ejecutar la aplicación
CMD ["npm", "start"]