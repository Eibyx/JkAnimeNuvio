# JKAnimeNuvio: imagen de producción (Render, Docker). Uso local sin Docker: ver README.
FROM node:22-alpine

# PORT: valor por defecto de Render (10000); la plataforma lo define en tiempo de ejecución y
# este valor solo se usa con un `docker run` sin -e PORT. NODE_OPTIONS: en instancias de
# 512 MB deja margen fuera del heap de V8; se puede cambiar desde la plataforma.
ENV NODE_ENV=production \
    PORT=10000 \
    HOST=0.0.0.0 \
    NODE_OPTIONS=--max-old-space-size=256

WORKDIR /app

# Solo dependencias de producción, reproducibles desde package-lock.json.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js ./
COPY lib ./lib

# Usuario sin privilegios (incluido en la imagen oficial de Node).
USER node

# Solo informativo: el servidor escucha en $PORT.
EXPOSE 10000

# /health responde al instante y nunca llama a servicios externos.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# node directamente (no npm start) para que SIGTERM llegue al proceso y cierre limpio.
CMD ["node", "index.js"]
