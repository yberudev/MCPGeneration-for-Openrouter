import { AppError } from '../../utils/errors.js';

export type TransportPhase =
  | 'dns'
  | 'tcp_connect'
  | 'tls_handshake'
  | 'request_or_waiting_for_headers'
  | 'response_body'
  | 'response_parse'
  | 'redirect';

export interface TransportDiagnostic {
  phase: TransportPhase;
  transport_layer: 'dns' | 'tcp' | 'tls' | 'http' | 'unknown';
  outcome: 'network_error' | 'timeout' | 'redirect_blocked' | 'response_read_error' | 'invalid_json';
  duration_ms: number;
  timed_out: boolean;
  timeout_kind?: 'connect' | 'headers' | 'body' | 'request';
  error_codes: string[];
  error_names: string[];
}

const SAFE_CODE = /^(?:E[A-Z0-9_]{1,48}|UND_ERR_[A-Z0-9_]{1,48}|ERR_(?:TLS|SSL|OSSL|CERT)_[A-Z0-9_]{1,48}|CERT_[A-Z0-9_]{1,48}|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ABORT_ERR)$/;
const SAFE_NAME = /^(?:Error|TypeError|RangeError|DOMException|TimeoutError|AbortError|SocketError|ConnectTimeoutError|HeadersTimeoutError|BodyTimeoutError)$/;

function causes(error: unknown): unknown[] {
  const result: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && result.length < 8 && !seen.has(current)) {
    seen.add(current);
    result.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return result;
}

function property(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

function safeCodes(error: unknown): string[] {
  return [...new Set(causes(error).map((item) => property(item, 'code')))]
    .filter((code): code is string => typeof code === 'string' && SAFE_CODE.test(code))
    .slice(0, 8);
}

function safeNames(error: unknown): string[] {
  return [...new Set(causes(error).map((item) => property(item, 'name')))]
    .filter((name): name is string => typeof name === 'string' && SAFE_NAME.test(name))
    .slice(0, 8);
}

function phaseFor(codes: string[], fallback: TransportPhase): TransportPhase {
  if (codes.some((code) => /^(?:ENOTFOUND|EAI_AGAIN|EAI_FAIL|EAI_NONAME)$/.test(code))) return 'dns';
  if (
    codes.some(
      (code) =>
        /^(?:ERR_TLS_|ERR_SSL_|ERR_OSSL_|ERR_CERT_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(
          code,
        ),
    )
  )
    return 'tls_handshake';
  if (codes.some((code) => code === 'UND_ERR_CONNECT_TIMEOUT' || /^(?:ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL)$/.test(code)))
    return 'tcp_connect';
  return fallback;
}

function timeoutKind(codes: string[], names: string[]): TransportDiagnostic['timeout_kind'] | undefined {
  if (codes.includes('UND_ERR_CONNECT_TIMEOUT')) return 'connect';
  if (codes.includes('UND_ERR_HEADERS_TIMEOUT')) return 'headers';
  if (codes.includes('UND_ERR_BODY_TIMEOUT')) return 'body';
  if (codes.includes('ETIMEDOUT')) return 'request';
  if (names.includes('TimeoutError') || names.includes('AbortError') || codes.includes('ABORT_ERR'))
    return 'request';
  return undefined;
}

function transportLayer(codes: string[], phase: TransportPhase): TransportDiagnostic['transport_layer'] {
  if (phase === 'dns') return 'dns';
  if (phase === 'tls_handshake') return 'tls';
  if (
    codes.some(
      (code) =>
        code === 'UND_ERR_CONNECT_TIMEOUT' ||
        /^(?:ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL|EPIPE|ETIMEDOUT)$/.test(code),
    )
  )
    return 'tcp';
  if (phase === 'response_body' || phase === 'response_parse' || phase === 'redirect') return 'http';
  return 'unknown';
}

export function transportDiagnostic(
  error: unknown,
  fallbackPhase: TransportPhase,
  durationMs: number,
  signal?: AbortSignal,
  outcome?: TransportDiagnostic['outcome'],
): TransportDiagnostic {
  const error_codes = safeCodes(error);
  const error_names = safeNames(error);
  const timeout_kind = timeoutKind(error_codes, error_names);
  const timed_out = Boolean(signal?.aborted || timeout_kind);
  const phase = phaseFor(error_codes, fallbackPhase);
  return {
    phase,
    transport_layer: transportLayer(error_codes, phase),
    outcome: outcome ?? (timed_out ? 'timeout' : 'network_error'),
    duration_ms: Math.max(0, Math.round(durationMs)),
    timed_out,
    ...(timeout_kind ? { timeout_kind } : {}),
    error_codes,
    error_names,
  };
}

export class OpenRouterTransportError extends AppError {
  constructor(
    message: string,
    code: string,
    cause: unknown,
    readonly diagnostic: TransportDiagnostic,
  ) {
    super(message, code, { cause });
  }
}

export function getTransportDiagnostic(error: unknown): TransportDiagnostic | undefined {
  for (const value of causes(error)) {
    const diagnostic = property(value, 'diagnostic');
    if (
      diagnostic &&
      typeof diagnostic === 'object' &&
      typeof (diagnostic as TransportDiagnostic).phase === 'string' &&
      typeof (diagnostic as TransportDiagnostic).duration_ms === 'number'
    )
      return diagnostic as TransportDiagnostic;
  }
  return undefined;
}
