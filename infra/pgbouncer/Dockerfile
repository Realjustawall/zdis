FROM postgres:16-alpine
RUN apk add --no-cache pgbouncer
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0555 /entrypoint.sh
USER postgres
EXPOSE 5432
ENTRYPOINT ["/entrypoint.sh"]
