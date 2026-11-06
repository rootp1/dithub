.PHONY: dev down migrate db stamp status
DATABASE_PATH ?= .data/dithub.sqlite
dev:
	docker compose -f infra/docker-compose.yml up -d --wait
	$(MAKE) migrate
down:
	docker compose -f infra/docker-compose.yml down
migrate:
	DATABASE_PATH=$(DATABASE_PATH) bun apps/api/src/migrate.ts
db:
	sqlite3 $(DATABASE_PATH)
# Buys a postage batch on the dev Bee (free in dev mode); put the printed batchID in .env as BEE_POSTAGE_BATCH_ID.
stamp:
	curl -fsS -X POST http://127.0.0.1:1633/stamps/100000000/20
status:
	docker compose -f infra/docker-compose.yml ps
