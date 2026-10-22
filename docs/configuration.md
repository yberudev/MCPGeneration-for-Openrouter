# Configuração

O servidor lê variáveis do processo. `dotenv` carrega `.env` a partir do diretório de trabalho para execuções locais; numa configuração do Claude Code, use variáveis do ambiente/interpolação em `.mcp.json`.

| Variável                   | Padrão                                     | Descrição                                                                 |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`       | vazio                                      | Bearer token. Obrigatório para chamadas HTTP; nunca é gravado no projeto. |
| `OPENROUTER_BASE_URL`      | `https://openrouter.ai/api/v1`             | Host oficial fixo; o servidor recusa outros hosts para não expor a chave. |
| `DEFAULT_IMAGE_MODEL`      | `google/gemini-3.1-flash-lite-image`       | Modelo usado quando a ferramenta não recebe `model`.                      |
| `DEFAULT_VIDEO_MODEL`      | `heygen/heygen-video-1`                    | Modelo de vídeo padrão.                                                   |
| `YBERU_PROJECT_ROOT`       | `CLAUDE_PROJECT_DIR`                       | Raiz principal de projeto. Sem raiz, ferramentas que escrevem falham.     |
| `YBERU_ALLOWED_ROOTS`      | vazio                                      | Raízes de ficheiros adicionais, separadas por `:` em Linux/macOS.         |
| `YBERU_ASSETS_DIR`         | `public/assets/generated`                  | Pasta-base de recursos relativa ao projeto.                               |
| `YBERU_DATA_DIR`           | `~/.local/share/mcp-generation-openrouter` | Pasta absoluta de jobs, recursos, gastos e reservas.                      |
| `MAX_COST_PER_REQUEST_USD` | `5`                                        | Limite por geração.                                                       |
| `MAX_TOTAL_SPEND_USD`      | `20`                                       | Limite total conhecido/reservado.                                         |
| `MAX_IMAGE_VARIATIONS`     | `4`                                        | Limite de quantidade nas ferramentas de imagem.                           |
| `MAX_IMAGE_BYTES`          | `25000000`                                 | Tamanho máximo por imagem.                                                |
| `MAX_HTTP_RESPONSE_BYTES`  | `160000000`                                | Limite para respostas JSON, incluindo imagens base64.                     |
| `MAX_VIDEO_BYTES`          | `524288000`                                | Tamanho máximo de vídeo em download.                                      |
| `HTTP_TIMEOUT_MS`          | `120000`                                   | Timeout HTTP.                                                             |
| `VIDEO_POLL_INTERVAL_MS`   | `30000`                                    | Documentação para polling manual; não inicia um loop em fundo.            |
| `ALLOW_UNKNOWN_COST`       | `false`                                    | Permite explicitamente um pedido cujo custo prévio não é verificável.     |
| `LOG_LEVEL`                | `info`                                     | Reservado para logging operacional; não altera a saída MCP.               |

Uma variável em branco usa o padrão. A configuração é validada no arranque. O servidor não precisa de API key para iniciar, mas necessita dela para pedir catálogos e conteúdos.

`RUN_PAID_TESTS` e `PAID_TEST_MAX_COST_USD` só se aplicam ao teste pago opcional; veja o README.
