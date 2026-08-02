#!/bin/sh
set -eu

psql --set ON_ERROR_STOP=on \
  --set=keycloak_password="$KEYCLOAK_DB_PASSWORD" \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" <<-'SQL'
  CREATE USER keycloak WITH PASSWORD :'keycloak_password';
  CREATE DATABASE keycloak OWNER keycloak;
  REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
SQL
