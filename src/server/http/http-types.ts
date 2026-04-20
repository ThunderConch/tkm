export interface HttpAuthContext {
  playerId?: string;
  operator?: boolean;
}

export interface HttpRequest<TBody = unknown> {
  auth?: HttpAuthContext;
  params?: Record<string, string | undefined>;
  body?: TBody;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

export interface HttpResponse<TBody = unknown> {
  status: number;
  body: TBody;
}
