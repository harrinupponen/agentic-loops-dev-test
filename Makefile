.PHONY: setup dev db-up db-down migrate ci ci-fast test-unit test-integration e2e load clean

setup:
	npm ci
	npx playwright install --with-deps chromium
	cp -n .env.example .env || true

db-up:
	docker compose up -d db

db-down:
	docker compose down

dev: db-up
	npm run db:migrate
	npm run build:web
	npm run dev

migrate:
	npm run db:migrate

# Tier 0 — must stay under ~90s
ci-fast:
	npm run format:check
	npm run lint
	npm run typecheck
	npm run test:unit

# Tier 0 + Tier 1 — exactly what PR CI runs
ci: ci-fast
	npm run test:integration
	npm run openapi:check

test-unit:
	npm run test:unit

test-integration:
	npm run test:integration

e2e:
	npm run build
	npm run test:e2e

load:
	k6 run load/smoke.js

clean:
	rm -rf dist coverage .ci/reports playwright-report test-results
