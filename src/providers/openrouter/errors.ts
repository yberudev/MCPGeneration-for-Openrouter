import { AppError, sanitizeErrorMessage } from '../../utils/errors.js';

export function apiError(status: number, body: string): AppError {
  const detail = sanitizeErrorMessage(body || 'Sem detalhes fornecidos.');
  const known: Record<number, string> = {
    400: 'Parâmetros rejeitados pelo OpenRouter.',
    401: 'A chave OpenRouter é inválida ou expirou.',
    402: 'Saldo ou créditos insuficientes no OpenRouter.',
    403: 'A conta não tem permissão para esta operação.',
    404: 'Modelo ou tarefa não encontrado no OpenRouter.',
    429: 'Limite de requisições do OpenRouter atingido.',
  };
  const summary =
    known[status] ??
    (status >= 500 ? 'Falha temporária do OpenRouter.' : 'Pedido rejeitado pelo OpenRouter.');
  return new AppError(`${summary} HTTP ${status}: ${detail}`, `OPENROUTER_HTTP_${status}`);
}
