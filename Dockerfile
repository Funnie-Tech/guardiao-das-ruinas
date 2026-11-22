# The game is static files: nginx serves game/ and nothing else.
FROM nginx:1.29-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY game/ /usr/share/nginx/html/
