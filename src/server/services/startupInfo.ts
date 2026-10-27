type StartupSummaryInput = {
  port: number;
  host: string;
  authToken: string;
  proxyToken: string;
};

type StartupEndpoints = {
  baseUrl: string;
  adminDashboardUrl: string;
  adminApiExample: string;
  proxyApiExample: string;
  adminApiCurl: string;
  proxyApiCurl: string;
};

function resolveDisplayHost(host: string): string {
  const trimmed = (host || '').trim();
  if (!trimmed || trimmed === '0.0.0.0' || trimmed === '::') return '127.0.0.1';
  return trimmed;
}

export function buildStartupEndpoints(input: StartupSummaryInput): StartupEndpoints {
  const displayHost = resolveDisplayHost(input.host);
  const baseUrl = `http://${displayHost}:${input.port}`;

  const adminApiExample = `${baseUrl}/api/stats/dashboard`;
  const proxyApiExample = `${baseUrl}/v1/chat/completions`;

  return {
    baseUrl,
    adminDashboardUrl: baseUrl,
    adminApiExample,
    proxyApiExample,
    // Never print the live credential: this summary lands in systemd/journal
    // logs, which are often readable far more widely than the admin console.
    adminApiCurl: `AUTH_TOKEN='your-admin-password' curl '${adminApiExample}' -H "Authorization: Bearer $AUTH_TOKEN"`,
    // The proxy key is a live credential too. Keep the copy-ready command while
    // masking the value that lands in journald.
    proxyApiCurl: `PROXY_TOKEN='your-proxy-key' curl '${proxyApiExample}' -H "Authorization: Bearer $PROXY_TOKEN" -H 'Content-Type: application/json' -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}]}'`,
  };
}

export function buildStartupSummaryLines(input: StartupSummaryInput): string[] {
  const endpoints = buildStartupEndpoints(input);

  return [
    `metapi running on ${input.host}:${input.port}`,
    `Dashboard: ${endpoints.adminDashboardUrl}`,
    `Admin API: ${endpoints.adminApiExample}`,
    `Proxy API: ${endpoints.proxyApiExample}`,
    `Admin curl: ${endpoints.adminApiCurl}`,
    `Proxy curl: ${endpoints.proxyApiCurl}`,
  ];
}
