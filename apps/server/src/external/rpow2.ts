export interface Rpow2ActivityEntry {
  type: string;
  counterparty_email?: string;
  email?: string;
  amount_base_units: string;
  memo?: string | null;
  at: string;
}

export interface Rpow2SendResponse {
  ok?: boolean;
  transfer_id?: string;
  id?: string;
}

export class Rpow2ClientError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'Rpow2ClientError';
    this.status = status;
  }
}

export class Rpow2Client {
  private baseUrl: string;
  private cookie: string;

  constructor(opts: { baseUrl: string; sessionCookie: string; cfClearance?: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    if (!opts.cfClearance) {
      this.cookie = opts.sessionCookie;
      return;
    }
    // cfClearance can be:
    //   a) just the raw token value: "_JIsH8..."
    //   b) a single pair: "cf_clearance=_JIsH8..."
    //   c) a browser cookie header: "cf_clearance=...; rpow_session=..."
    // In all cases, filter out Set-Cookie HTTP attributes and build a clean
    // Cookie header. If a fresh rpow_session is present, it takes precedence
    // over the sessionCookie arg so we don't send stale credentials.
    const HTTP_ATTR = /^(path|domain|max-age|samesite|expires)=/i;
    const HTTP_FLAG = /^(secure|httponly)$/i;
    const pairs = opts.cfClearance
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !HTTP_ATTR.test(s) && !HTTP_FLAG.test(s));
    const hasFreshSession = pairs.some((p) => p.startsWith('rpow_session='));
    if (hasFreshSession) {
      // Browser cookie string already contains a session — use as-is
      this.cookie = pairs.join('; ');
    } else if (pairs[0]?.startsWith('cf_clearance=')) {
      this.cookie = `${opts.sessionCookie}; ${pairs.join('; ')}`;
    } else {
      // Raw token value — wrap in the cookie name
      this.cookie = `${opts.sessionCookie}; cf_clearance=${opts.cfClearance}`;
    }
  }

  async activitySince(sinceIso: string): Promise<Rpow2ActivityEntry[]> {
    const url = new URL(`${this.baseUrl}/activity`);
    url.searchParams.set('since', sinceIso);
    const body = await this.request<unknown>(url.toString(), { method: 'GET' });
    if (Array.isArray(body)) return body as Rpow2ActivityEntry[];
    if (body && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items)) {
      return (body as { items: Rpow2ActivityEntry[] }).items;
    }
    if (body && typeof body === 'object' && Array.isArray((body as { entries?: unknown }).entries)) {
      return (body as { entries: Rpow2ActivityEntry[] }).entries;
    }
    throw new Rpow2ClientError(502, 'unexpected RPOW2 activity response shape');
  }

  async sendWithdrawal(opts: {
    destinationEmail: string;
    amountBaseUnits: string;
    idempotencyKey: string;
    memo?: string;
  }): Promise<Rpow2SendResponse> {
    return this.request<Rpow2SendResponse>(`${this.baseUrl}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        recipient_email: opts.destinationEmail,
        amount_base_units: opts.amountBaseUnits,
        idempotency_key: opts.idempotencyKey,
        ...(opts.memo ? { memo: opts.memo } : {}),
      }),
    });
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const res = await fetch(url, {
      ...init,
      headers: {
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        cookie: this.cookie,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const body = await res.json() as { message?: string; error?: string };
        msg = body.message ?? body.error ?? msg;
      } catch { /* keep status text */ }
      throw new Rpow2ClientError(res.status, msg);
    }
    return res.json() as Promise<T>;
  }
}
