#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
secrets_directory="$repository_root/secrets"

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required" >&2
  exit 1
fi

umask 077
mkdir -p "$secrets_directory"
chmod 700 "$secrets_directory"

for file in token_encryption_key redis_password redis.acl; do
  if [ -e "$secrets_directory/$file" ]; then
    echo "Refusing to overwrite existing secrets/$file" >&2
    exit 1
  fi
done

token_encryption_key=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')
redis_password=$(openssl rand -hex 32)

printf '%s\n' "$token_encryption_key" > "$secrets_directory/token_encryption_key"
printf '%s\n' "$redis_password" > "$secrets_directory/redis_password"
printf 'user default off\nuser mcp on >%s ~mcp2328:* +auth +hello +select +ping +set +incr +expire +eval\n' "$redis_password" > "$secrets_directory/redis.acl"
chmod 600 "$secrets_directory/token_encryption_key" "$secrets_directory/redis_password" "$secrets_directory/redis.acl"

echo "Created production secrets in $secrets_directory"
