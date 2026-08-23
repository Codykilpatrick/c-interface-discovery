#!/bin/sh
# Render nginx.conf from its template and start nginx.
#
# LLM_UPSTREAM is optional. When it is unset the /llm/ proxy block is removed
# rather than left pointing at nothing — a location with an unresolvable
# upstream stops nginx from starting at all, which would take the whole app
# down over an optional feature.
set -e

TEMPLATE=/etc/nginx/nginx.conf.template
TARGET=/etc/nginx/http.d/default.conf

if [ -n "$LLM_UPSTREAM" ]; then
    echo "LLM proxy enabled: /llm/ -> $LLM_UPSTREAM"
    # Substitute only LLM_UPSTREAM; nginx's own $host, $uri etc. must survive.
    envsubst '${LLM_UPSTREAM}' < "$TEMPLATE" > "$TARGET"
else
    echo "LLM proxy disabled (LLM_UPSTREAM not set); /llm/ will return 404"
    # Replace, don't just delete: after a delete, /llm/ falls through to
    # try_files and returns 200 index.html.
    sed '/# LLM_BLOCK_START/,/# LLM_BLOCK_END/c\
    location /llm/ { return 404; }
' "$TEMPLATE" > "$TARGET"
fi

nginx -t
exec "$@"
