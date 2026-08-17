#!/usr/bin/env bash
set -euo pipefail

# Configuration
CONTAINER_NAME="${POSTGRES_CONTAINER_NAME:-brokkr-postgres}"
POSTGRES_USER="${POSTGRES_USER:-brokkr}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-password}"
POSTGRES_DB="${POSTGRES_DB:-brokkr}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_VERSION="${POSTGRES_VERSION:-16}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
  log_error "Docker is not running. Please start Docker and try again."
  exit 1
fi

# Check if container already exists
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    log_info "PostgreSQL container '${CONTAINER_NAME}' is already running."
  else
    log_info "Starting existing PostgreSQL container '${CONTAINER_NAME}'..."
    docker start "${CONTAINER_NAME}"
  fi
else
  log_info "Creating new PostgreSQL container '${CONTAINER_NAME}'..."
  docker run -d \
    --name "${CONTAINER_NAME}" \
    -e POSTGRES_USER="${POSTGRES_USER}" \
    -e POSTGRES_PASSWORD="${POSTGRES_PASSWORD}" \
    -e POSTGRES_DB="${POSTGRES_DB}" \
    -p "${POSTGRES_PORT}:5432" \
    "postgres:${POSTGRES_VERSION}-alpine"
fi

# Wait for PostgreSQL to be ready
log_info "Waiting for PostgreSQL to be ready..."
MAX_RETRIES=30
RETRY_COUNT=0

until docker exec "${CONTAINER_NAME}" pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" >/dev/null 2>&1; do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
    log_error "PostgreSQL did not become ready in time. Exiting."
    exit 1
  fi
  echo -n "."
  sleep 1
done
echo ""
log_info "PostgreSQL is ready!"

# Set DATABASE_URL for Prisma
export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/${POSTGRES_DB}"
log_info "DATABASE_URL: ${DATABASE_URL}"

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "${SCRIPT_DIR}")"

# Change to package directory for Prisma commands
cd "${PACKAGE_DIR}"

# Run Prisma migrations
log_info "Running Prisma migrations..."
pnpm prisma migrate deploy

log_info "Database initialization complete!"
echo ""
echo "Connection details:"
echo "  Host:     localhost"
echo "  Port:     ${POSTGRES_PORT}"
echo "  Database: ${POSTGRES_DB}"
echo "  User:     ${POSTGRES_USER}"
echo "  Password: ${POSTGRES_PASSWORD}"
echo ""
echo "DATABASE_URL=${DATABASE_URL}"
