import { readConfig } from '../src/config.js';

// One attempt only. Never print a raw response, URL, secret, email, or account identifier.
try {
  const { baseUrl, managementKey } = readConfig();
  if (!baseUrl || !managementKey) throw new Error('Missing management configuration.');
  const response = await fetch(`${baseUrl}/auth-files`, {
    headers: { Authorization: `Bearer ${managementKey}` }, signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  const report = { status: response.status, checkedAt: new Date().toISOString() };
  if (response.ok) {
    const payload = await response.json();
    const accounts = Array.isArray(payload) ? payload : payload.files;
    report.accountListRecognized = Array.isArray(accounts);
    report.providers = {};
    for (const account of Array.isArray(accounts) ? accounts : []) {
      const provider = String(account.provider || account.type || '').toLowerCase();
      if (!['antigravity', 'claude', 'codex', 'xai', 'x-ai'].includes(provider)) continue;
      report.providers[provider] = (report.providers[provider] || 0) + 1;
    }
    report.identifierFields = ['id', 'name', 'auth_index', 'account_id'].filter(key => accounts?.some(a => a[key] != null));
  }
  if ([401, 403].includes(response.status)) report.action = 'Authentication rejected; stopped after one attempt. No quota calls made.';
  console.log(JSON.stringify(report, null, 2));
  if (!response.ok) process.exitCode = 1;
} catch {
  console.error('Management probe unavailable. Check backend configuration and connectivity; no retries were made.');
  process.exitCode = 1;
}
