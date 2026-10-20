# ERP Assistant Status

## Optional provider configuration

The assistant is usable in local-only mode without an AI account. External inference is disabled unless all of the following environment variables are explicitly set:

- `ERP_AI_ENABLED=true`
- `ERP_AI_ENDPOINT` — HTTPS chat-completions-compatible endpoint (HTTP is permitted only for `localhost`/`127.0.0.1` development)
- `ERP_AI_API_KEY` — secret token, never stored in application data or sent to the browser
- `ERP_AI_MODEL` — provider model identifier

The configured endpoint receives the question, the user's role and authorized module names, selected period, and only aggregate metrics available to that user. It does not receive unrestricted records, credentials, SQL access, or application tools. Requests have a 12-second timeout, redirects are rejected, and each signed-in user is limited to 10 requests per minute per server process.

## Available capabilities

- Workflow and navigation help, limited to modules the current user can access.
- Permission-filtered summaries of live sales, purchases, cash, receivables, payables, and inventory dashboard metrics where available.
- Period and source-metric labels, limitations, and explicit indication that no ERP action was performed.
- AI-assistance event audit metadata that excludes question and response text.
- Browser-session message history only; messages are cleared when the user logs out or another user signs in.
- Favorites and recently visited authorized pages, stored in the current browser under a user-specific key.

## Safety and limitations

- The assistant has no transaction tools and cannot execute SQL, code, shell commands, payments, payroll approvals, purchase approvals, stock adjustments, or accounting posts.
- Operational suggestions are not transactions; users must use the module's normal permission-checked workflows and confirmations.
- HR payroll, manufacturing, and transaction-level anomaly data are not sent to the provider. Those areas need separately implemented, permission-scoped aggregate reports before the assistant can summarize them.
- External inference is an explicit administrator choice. Provider terms and privacy suitability must be reviewed before enabling it.
