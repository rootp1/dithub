.PHONY: dev down migrate psql status
dev:
	docker compose -f infra/docker-compose.yml up -d --wait
	$(MAKE) migrate
down:
	docker compose -f infra/docker-compose.yml down
migrate:
	docker compose -f infra/docker-compose.yml exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U $$POSTGRES_USER -d $$POSTGRES_DB' < packages/db/migrations/0001_init.sql
psql:
	docker compose -f infra/docker-compose.yml exec postgres sh -c 'psql -U $$POSTGRES_USER -d $$POSTGRES_DB'
status:
	docker compose -f infra/docker-compose.yml ps
