export interface Env {
  // Secrets (from .dev.vars locally, wrangler secret in production)
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET?: string; // HMAC secret for authenticated GitHub App webhooks

  // Variables (from wrangler.toml)
  ENVIRONMENT: string;
  BUILD_SHA?: string; // Optional deployed source identity for health and feedback responses
  ALLOWED_ORIGINS: string; // Comma-separated list of allowed origins, or "*" for dev
  ALLOWED_REPOSITORIES?: string; // Optional comma/newline-separated exact owner/repo allowlist
  GITHUB_APP_NAME: string; // Your GitHub App name for install URL
  MAX_SCREENSHOT_SIZE_MB: string; // Max screenshot size in MB (default: 5)
  CATEGORY_LABELS?: string; // Optional JSON category-label mapping keyed by repo or "*"
  VARIANT_LABELS?: string; // Optional JSON variant-label mapping keyed by repo then variant ID
  ALLOW_CLIENT_CATEGORY_LABELS?: string; // Self-host escape hatch for script-tag mappings
  ROOT_REDIRECT_URL?: string; // Optional landing page for self-hosted deployments
  AUTH_TOKEN_SECRET?: string; // Optional HMAC secret for host-app submission tokens
  AUTH_TOKEN_ADDITIONAL_SECRETS?: string; // Optional comma/newline-separated extra HMAC secrets
  AUTH_TOKEN_AUDIENCE?: string; // Optional expected token audience claim
  AUTH_TOKEN_ISSUER?: string; // Optional expected token issuer claim
  AUTH_TOKEN_REQUIRED_FOR_CHECK?: string; // Optional gate for /check installation lookups
  BUGDROP_BOARD_TOKEN_SECRET?: string; // Optional signer secret for the /board embedded demo
  BUGDROP_BOARD_ID?: string; // Optional override for the demo board id
  BUGDROP_BOARD_TENANT_ID?: string; // Optional hosted beta tenant claim for the demo board token
  BUGDROP_BOARD_APP_ID?: string; // Optional hosted beta app claim for the demo board token
  BUGDROP_BOARD_TOKEN_AUDIENCE?: string; // Optional override for board token audience
  BUGDROP_BOARD_TOKEN_ISSUER?: string; // Optional override for board token issuer
  FEEDBACK_COUNT_BASELINE?: string; // Anonymous external-Issue count before live counting
  FEEDBACK_COUNT_EXCLUDED_OWNERS?: string; // Comma-separated first-party/test owners
  INSTALLATION_USAGE_ENABLED?: string; // Exact "true" enables private per-install successful-Issue counts

  // Bindings
  ASSETS: Fetcher;
  RATE_LIMIT?: KVNamespace; // Optional: for rate limiting (create with wrangler kv:namespace create RATE_LIMIT)
  INSTALLATION_ANALYTICS?: KVNamespace; // Minimal installation identity records
  FEEDBACK_COUNTER?: DurableObjectNamespace; // Anonymous global successful-Issue counter
}

export type FeedbackCategory = 'bug' | 'feature' | 'question';
type CategoryLabelConfig = Partial<Record<FeedbackCategory, string | string[]>>;

export interface FeedbackMetadata {
  url: string;
  userAgent: string;
  viewport: { width: number; height: number };
  timestamp: string;
  appVersion?: string;
  elementSelector?: string;
  fullElementSelector?: string;
  selectedElementHighlightColor?: string;
  browser?: { name: string; version: string };
  os?: { name: string; version: string };
  devicePixelRatio?: number;
  language?: string;
}

export type StructuredFeedbackClassification = FeedbackCategory | 'feedback';
export type StructuredFeedbackSectionFormat = 'text' | 'quote' | 'code';

export interface StructuredFeedbackPayload {
  kind: 'bugdrop.variant-submission';
  schemaVersion: 1;
  repo: string;
  variantId: string;
  submissionId: string;
  issue: {
    title: string;
    classification?: StructuredFeedbackClassification;
    sections: Array<{
      heading: string;
      value: string;
      format?: StructuredFeedbackSectionFormat;
    }>;
  };
  metadata: FeedbackMetadata;
}

export interface FeedbackPayload {
  repo: string; // "owner/repo" format
  title: string;
  description: string;
  category?: FeedbackCategory; // Feedback type (maps to GitHub labels)
  categoryLabels?: CategoryLabelConfig; // Optional self-host category-to-GitHub-label mapping
  screenshot?: string; // base64 data URL
  annotations?: string; // base64 annotated image
  attachments?: FeedbackAttachment[];
  consoleLogs?: ConsoleLogEntry[];
  submitter?: {
    // Optional submitter info (configured per widget)
    name?: string;
    email?: string;
  };
  metadata: FeedbackMetadata;
}

export interface FeedbackAttachment {
  name: string;
  type: string;
  size: number;
  dataUrl: string;
}

export interface ConsoleLogEntry {
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
  sourceUrl?: string;
  lineNumber?: number;
  columnNumber?: number;
}

export interface GitHubIssue {
  number: number;
  html_url: string;
}
