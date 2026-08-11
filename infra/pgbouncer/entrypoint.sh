#!/bin/sh
set -eu

install -d -m 0700 /tmp/pgbouncer
cat > /tmp/pgbouncer/userlist.txt <<EOF
"youtbelimo" "${POSTGRES_PASSWORD}"
EOF
chmod 0600 /tmp/pgbouncer/userlist.txt

cat > /tmp/pgbouncer/pgbouncer.ini <<EOF
[databases]
youtbelimo = host=postgres port=5432 dbname=youtbelimo user=youtbelimo password=${POSTGRES_PASSWORD}

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 5432
unix_socket_dir = /tmp/pgbouncer
auth_type = plain
auth_file = /tmp/pgbouncer/userlist.txt
pool_mode = transaction
max_client_conn = 5000
default_pool_size = 50
reserve_pool_size = 10
reserve_pool_timeout = 3
server_idle_timeout = 60
server_lifetime = 3600
query_wait_timeout = 30
ignore_startup_parameters = extra_float_digits
admin_users = youtbelimo
stats_users = youtbelimo
EOF

exec pgbouncer /tmp/pgbouncer/pgbouncer.ini
