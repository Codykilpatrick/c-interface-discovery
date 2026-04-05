FROM node:20-alpine

# Install nginx
RUN apk add --no-cache nginx

WORKDIR /app

# Copy source
COPY . .

# Install dependencies (postinstall copies WASM files to public/) and build
RUN npm ci
RUN npm run build

# Copy build output to nginx root
RUN cp -r dist/* /usr/share/nginx/html/

# Copy nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose both prod (80) and dev (3000) ports
EXPOSE 80 3000

# Start nginx by default (prod mode)
CMD ["nginx", "-g", "daemon off;"]
