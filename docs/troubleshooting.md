# Resolução de problemas

| Mensagem                                | Causa provável e correção                                                                                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MISSING_API_KEY`                       | Exporte `OPENROUTER_API_KEY` no ambiente do processo MCP. Não inclua o valor em logs nem no Git.                                                                  |
| `MODEL_UNAVAILABLE`                     | Consulte `list_models`; os modelos disponíveis mudam.                                                                                                             |
| `UNSUPPORTED_PARAMETER`                 | Remova o parâmetro ou escolha um modelo que o publique no catálogo.                                                                                               |
| `COST_UNKNOWN`                          | O catálogo não permite estimar antes da geração. A política segura bloqueia; reveja `ALLOW_UNKNOWN_COST` e o limite global antes de ativá-la.                     |
| `PAYMENT_NOT_AUTHORIZED`                | Use `allow_paid: true` apenas quando a operação paga foi autorizada. `dry_run` não gera conteúdo.                                                                 |
| `TOTAL_SPEND_LIMIT`                     | O limite acumulado foi atingido ou a reserva conhecida não cabe no saldo restante.                                                                                |
| `UNKNOWN_SPEND_REQUIRES_RECONCILIATION` | Houve um POST com resultado/custo incerto. Verifique OpenRouter e os registos locais antes de remover a reserva.                                                  |
| `DUPLICATE_UNCERTAIN_REQUEST`           | O mesmo pedido está pendente ou teve resposta incerta. Reutilize o job existente ou reconcilie `requests.json`; não repita cegamente.                             |
| `IMAGE_TO_VIDEO_UNSUPPORTED`            | O catálogo não publica `first_frame` para esse modelo. Escolha um modelo que publique o tipo de frame requerido.                                                  |
| `UNSAFE_IMAGE_URL`                      | Para `input_image_url`, use HTTPS sem IP literal, hostname local, credenciais ou fragmento.                                                                       |
| `PATH_NOT_ALLOWED`                      | Use um caminho sob `YBERU_PROJECT_ROOT`/`CLAUDE_PROJECT_DIR` ou acrescente a raiz a `YBERU_ALLOWED_ROOTS`.                                                        |
| `SYMLINK_NOT_ALLOWED`                   | O caminho de saída passa por symlink. Escolha um diretório normal dentro de uma raiz autorizada.                                                                  |
| `VIDEO_NOT_READY`                       | Consulte o job mais tarde com `get_video_status`; não inicie outra geração.                                                                                       |
| Falha de conteúdo vídeo                 | O MCP usa `/videos/{id}/content`, valida MIME e assinatura, e rejeita redirecionamentos. Consulte novamente o estado e repita apenas o download, nunca a geração. |
| Claude mostra ligação falhada           | Confirme o caminho absoluto em `claude mcp get`, `OPENROUTER_API_KEY` no ambiente pai, e use `/mcp` para verificar aprovação de um servidor de projeto.           |

Os erros HTTP 400, 401, 402, 403, 404, 429 e 5xx são traduzidos para mensagens curtas. O servidor não repete POSTs de geração automaticamente.
