# Password-protected proxy in front of the agentmemory viewer.
# Replaces the third-party XavTo/caddy-zero-trust service.
FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY entrypoint.sh /entrypoint.sh
# Strip CRLF in case the file was checked out on Windows without .gitattributes.
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]
