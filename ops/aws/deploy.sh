#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="${ARI_REPO_DIR:-/opt/ari}"
compose_file="$repo_dir/ops/aws/compose.yml"

cd "$repo_dir"
test -f .env.production || {
  echo "Missing $repo_dir/.env.production" >&2
  exit 1
}

git fetch origin main
git checkout main
git merge --ff-only origin/main

docker compose --env-file .env.production -f "$compose_file" build
docker compose --env-file .env.production -f "$compose_file" run --rm backend npm run migrate
docker compose --env-file .env.production -f "$compose_file" up -d --remove-orphans
docker compose --env-file .env.production -f "$compose_file" ps
