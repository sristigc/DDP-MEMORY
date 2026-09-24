// Minimal Jira Cloud client: fetch issues matching a JQL query (paginated).

export class JiraClient {
  constructor({ baseUrl, email, apiToken, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.auth = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
    this.fetch = fetchImpl;
  }

  async search(jql, { maxIssues = 200 } = {}) {
    const issues = [];
    let nextPageToken;
    do {
      const qs = new URLSearchParams({ jql, fields: "summary,status,issuetype", maxResults: "50" });
      if (nextPageToken) qs.set("nextPageToken", nextPageToken);
      const res = await this.fetch(`${this.baseUrl}/rest/api/3/search/jql?${qs}`, {
        headers: { authorization: this.auth, accept: "application/json" },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`Jira search failed: HTTP ${res.status}`);
      const page = await res.json();
      for (const i of page.issues || []) {
        issues.push({ key: i.key, summary: i.fields?.summary || "", status: i.fields?.status?.name || "", url: `${this.baseUrl}/browse/${i.key}` });
      }
      nextPageToken = page.isLast ? undefined : page.nextPageToken;
    } while (nextPageToken && issues.length < maxIssues);
    return issues;
  }
}
