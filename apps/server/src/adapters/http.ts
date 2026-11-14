export class UpstreamError extends Error {
  service: string;
  status: number;
  constructor(service: string, status: number, message: string) {
    super(`${service}: ${message}`);
    this.service = service;
    this.status = status;
  }
}

export async function getJson<T>(
  service: string,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 15_000) });
  } catch (e) {
    throw new UpstreamError(service, 502, `unreachable (${(e as Error).message})`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new UpstreamError(service, res.status, `HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}
