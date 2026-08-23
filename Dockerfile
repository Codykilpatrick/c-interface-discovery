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

# nginx config is rendered at container start so the optional LLM proxy can be
# switched on with an env var rather than a rebuild.
RUN apk add --no-cache gettext
RUN rm -f /etc/nginx/http.d/default.conf
COPY nginx.conf.template /etc/nginx/nginx.conf.template
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Expose both prod (80) and dev (3000) ports
EXPOSE 80 3000

# Start nginx by default (prod mode)
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
