export const API_URL =
  typeof window !== "undefined"
    ? (process.env.NEXT_PUBLIC_API_URL !== undefined ? process.env.NEXT_PUBLIC_API_URL : "")
    : (process.env.INTERNAL_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000");
const API_KEY = process.env.NEXT_PUBLIC_API_KEY;

function headers(json = true): HeadersInit {
  const h: Record<string, string> = {};
  if (json) h["Content-Type"] = "application/json";
  if (API_KEY) h["X-API-Key"] = API_KEY;
  return h;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {}
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => fetch(`${API_URL}${path}`, { headers: headers(false), cache: "no-store" }).then(handle<T>),
  post: <T>(path: string, body?: unknown) =>
    fetch(`${API_URL}${path}`, { method: "POST", headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) }).then(handle<T>),
  patch: <T>(path: string, body: unknown) =>
    fetch(`${API_URL}${path}`, { method: "PATCH", headers: headers(), body: JSON.stringify(body) }).then(handle<T>),
  del: <T>(path: string) => fetch(`${API_URL}${path}`, { method: "DELETE", headers: headers(false) }).then(handle<T>),
  upload: <T>(path: string, files: File[]) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    return fetch(`${API_URL}${path}`, { method: "POST", headers: headers(false), body: fd }).then(handle<T>);
  },
  uploadSync: <T>(kbId: string, files: File[]) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    return fetch(`${API_URL}/api/kb/${kbId}/upload?sync=true`, { method: "POST", headers: headers(false), body: fd }).then(handle<T>);
  },
  previewDocument: <T>(kbId: string, docId: string) =>
    fetch(`${API_URL}/api/kb/${kbId}/documents/${docId}/preview`, { headers: headers(false), cache: "no-store" }).then(handle<T>),
  documentFileUrl: (kbId: string, docId: string) => `${API_URL}/api/kb/${kbId}/documents/${docId}/file`,
  /** POST JSON and receive a binary file (e.g. the PDF export). */
  blob: async (path: string, body: unknown) => {
    const res = await fetch(`${API_URL}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
    if (!res.ok) await handle(res);
    return res.blob();
  },
  form: <T>(path: string, fields: Record<string, string>) => {
    const fd = new FormData();
    Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
    return fetch(`${API_URL}${path}`, { method: "POST", headers: headers(false), body: fd }).then(handle<T>);
  },
};

/** POST + Server-Sent Events reader (EventSource cannot POST). */
export async function streamSSE(
  path: string,
  body: unknown,
  onEvent: (event: string, data: any) => void,
  signal?: AbortSignal,
) {
  const res = await fetch(`${API_URL}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) await handle(res);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) {
        try {
          onEvent(event, JSON.parse(data.join("\n")));
        } catch {
          onEvent(event, data.join("\n"));
        }
      }
    }
  }
}
