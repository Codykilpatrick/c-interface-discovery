FROM node:20-alpine

# Install nginx
RUN apk add --no-cache nginx

WORKDIR /app

# Copy source
COPY . .

# Install dependencies (postinstall copies WASM files to public/) and build
RUN npm ci
RUN npm run build

# Copy build output to nginx root (create dir — Alpine nginx doesn't pre-create it)
RUN mkdir -p /usr/share/nginx/html && cp -r dist/* /usr/share/nginx/html/

# Copy nginx config (Alpine nginx uses http.d/, not conf.d/)
RUN rm -f /etc/nginx/http.d/default.conf
COPY nginx.conf /etc/nginx/http.d/default.conf

# Expose both prod (80) and dev (3000) ports
EXPOSE 80 3000

# Start nginx by default (prod mode)
CMD ["nginx", "-g", "daemon off;"]
