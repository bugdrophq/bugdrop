.PHONY: dev build build-widget build-all deploy test test-release test-release-workflow test-static-assets release-plan-help test-watch test-e2e test-e2e-ui test-e2e-shard test-radix-e2e test-live-radix test-live-cross-browser lint lint-fix format format-check typecheck knip audit check-actions-node24 check-workflow-permissions check-security-analysis-workflows check-ci-scope check-ci-workflow check-production-heartbeat-workflow check-release-workflow check ci clean install install-playwright help

# Development
dev:
	npm run dev

# Build
build:
	npm run build

build-widget:
	BUGDROP_BUILD_MODE="$${BUGDROP_BUILD_MODE:-development}" BUGDROP_DEVELOPMENT_ID="$${BUGDROP_DEVELOPMENT_ID:-local}" npm run build:widget

build-all: build-widget build

deploy: build-all
	npm run deploy

# Testing
test:
	npm run test

test-release:
	npm run test:release

test-release-workflow:
	npm run test:release-workflow

test-static-assets:
	npm run test:static-assets

release-plan-help:
	npm run release:plan -- --help

test-watch:
	npm run test:watch

test-e2e:
	npx playwright test --project=chromium

test-e2e-ui:
	npm run test:e2e:ui

test-e2e-shard:
	@if [ -z "$(SHARD)" ]; then \
		echo "Usage: make test-e2e-shard SHARD=1/2"; \
		exit 1; \
	fi
	npx playwright test --project=chromium --shard=$(SHARD)

test-radix-e2e:
	@if [ -z "$(BROWSER)" ]; then \
		echo "Usage: make test-radix-e2e BROWSER=chromium|firefox|webkit"; \
		exit 1; \
	fi
	npx playwright test e2e/widget.radix.spec.ts e2e/variant-modal.radix.spec.ts e2e/variant-accessibility.radix.spec.ts --project=$(BROWSER)-radix --workers=1 --retries=0

test-live-radix:
	@if [ -z "$(LIVE_TARGET)" ] || [ -z "$(PLAYWRIGHT_BASE_URL)" ]; then \
		echo "Usage: LIVE_TARGET=preview PLAYWRIGHT_BASE_URL=https://example.com make test-live-radix"; \
		echo "Required: LIVE_TARGET, PLAYWRIGHT_BASE_URL"; \
		echo "Set VERCEL_AUTOMATION_BYPASS_SECRET when the Vercel venue is protected."; \
		exit 1; \
	fi
	npx playwright test e2e/widget.live-radix.spec.ts --project=chromium-live-radix --workers=1 --retries=0

test-live-cross-browser:
	@if [ -z "$(BROWSER)" ] || [ -z "$(LIVE_TARGET)" ] || [ -z "$(PLAYWRIGHT_BASE_URL)" ]; then \
		echo "Usage: LIVE_TARGET=preview PLAYWRIGHT_BASE_URL=https://example.com make test-live-cross-browser BROWSER=chromium|firefox|webkit"; \
		echo "Required: BROWSER, LIVE_TARGET, PLAYWRIGHT_BASE_URL"; \
		echo "Set VERCEL_AUTOMATION_BYPASS_SECRET when the Vercel venue is protected."; \
		exit 1; \
	fi
	npx playwright test e2e/widget.cross-browser-live.spec.ts --project=$(BROWSER)-cross-browser-live --workers=1 --retries=0

# Code Quality
lint:
	npx eslint .

lint-fix:
	npx eslint . --fix

format:
	npm run format

format-check:
	npm run format:check

audit:
	npm audit --audit-level=critical

typecheck:
	npm run typecheck

knip:
	npx knip

check-actions-node24:
	npm run check:actions-node24
	bash test/github-actions-pinning.test.sh

check-workflow-permissions:
	npm run check:workflow-permissions
	bash test/workflow-permissions.test.sh

check-security-analysis-workflows:
	npm run check:security-analysis-workflows
	bash test/security-analysis-workflows.test.sh

check-ci-scope:
	bash test/ci-scope.test.sh
	node test/ci-scope-workflow.test.mjs

check-ci-workflow:
	bash test/ci-workflow-contract.test.sh

check-production-heartbeat-workflow:
	bash test/production-heartbeat-workflow-contract.test.sh

check-release-workflow:
	bash test/release-workflow-contract.test.sh

# Combined Commands
check: check-managed-staging test-release lint format-check typecheck knip audit check-actions-node24 check-workflow-permissions check-security-analysis-workflows check-ci-scope check-ci-workflow check-production-heartbeat-workflow check-release-workflow
	@echo "✓ All checks passed"

ci: check test build-all test-e2e
	@echo "✓ Full CI passed"

# Utilities
clean:
	rm -rf dist node_modules/.cache playwright-report test-results .wrangler/tmp public/widget*.js public/versions.json public/checksums.sha256 public/static-package.json

install:
	npm ci

install-playwright:
	npx playwright install --with-deps chromium

# Help (default target)
help:
	@echo "Available commands:"
	@echo ""
	@echo "  Development:"
	@echo "    make dev              - Start development server"
	@echo "    make build            - Build TypeScript"
	@echo "    make build-widget     - Build widget bundle"
	@echo "    make build-all        - Build widget and TypeScript"
	@echo "    make deploy           - Deploy to Cloudflare"
	@echo ""
	@echo "  Testing:"
	@echo "    make test             - Run unit tests"
	@echo "    make test-release     - Run deterministic release-planning tests"
	@echo "    make test-release-workflow - Run manual workflow engine and contract tests"
	@echo "    make test-static-assets - Run deterministic static-package tests"
	@echo "    make release-plan-help - Show the read-only release planner interface"
	@echo "    make test-watch       - Run unit tests in watch mode"
	@echo "    make test-e2e         - Run E2E tests"
	@echo "    make test-e2e-ui      - Run E2E tests with UI"
	@echo "    make test-e2e-shard SHARD=1/2  - Run E2E test shard"
	@echo "    make test-radix-e2e BROWSER=chromium|firefox|webkit"
	@echo "                          - Run focused Radix compatibility E2E tests"
	@echo "    LIVE_TARGET=preview PLAYWRIGHT_BASE_URL=<url> make test-live-radix"
	@echo "                          - Run live Radix compatibility E2E tests"
	@echo "                          - Set VERCEL_AUTOMATION_BYPASS_SECRET for protected Vercel venues"
	@echo "    LIVE_TARGET=preview PLAYWRIGHT_BASE_URL=<url> make test-live-cross-browser BROWSER=chromium|firefox|webkit"
	@echo "                          - Run live cross-browser E2E tests"
	@echo "                          - Set VERCEL_AUTOMATION_BYPASS_SECRET for protected Vercel venues"
	@echo ""
	@echo "  Code Quality:"
	@echo "    make lint             - Run ESLint"
	@echo "    make lint-fix         - Run ESLint with auto-fix"
	@echo "    make format           - Format code with Prettier"
	@echo "    make format-check     - Check formatting (no write)"
	@echo "    make typecheck        - Run TypeScript type checking"
	@echo "    make knip             - Check for dead code"
	@echo "    make audit            - Run npm security audit"
	@echo "    make check-actions-node24 - Verify GitHub Actions use Node 24-ready entries"
	@echo "    make check-release-workflow - Verify the guarded manual release contract"
	@echo ""
	@echo "  Combined:"
	@echo "    make check            - Run quality, CI scope, and workflow contract checks"
	@echo "    make ci               - Run full CI pipeline locally"
	@echo ""
	@echo "  Utilities:"
	@echo "    make clean            - Clean build artifacts"
	@echo "    make install          - Install dependencies"
	@echo "    make install-playwright - Install Chromium Playwright browser"
	@echo "    npx playwright install --with-deps firefox webkit - Install Firefox/WebKit Playwright browsers"

.PHONY: check-managed-staging
check-managed-staging:
	node managed/staging/check.mjs
