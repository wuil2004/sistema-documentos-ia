# Usamos una versión ligera de Node.js
FROM node:20-alpine

# Creamos el directorio de trabajo dentro del contenedor
WORKDIR /usr/src/app

# Copiamos los archivos de dependencias
COPY package*.json ./

# Instalamos las dependencias
RUN npm install

# Copiamos el resto de tu código (el server.js)
COPY . .

# Exponemos el puerto de tu API
EXPOSE 3000

# Comando para arrancar tu servidor
CMD ["node", "server.js"]