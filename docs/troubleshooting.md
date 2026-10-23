# Resolução de problemas

| Mensagem                                | Causa provável e correção                                                                                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MISSING_API_KEY`                       | Exporte `OPENROUTER_API_KEY` no ambiente do processo MCP. Não inclua o valor em logs nem no Git.                                                                  |
| `MODEL_UNAVAILABLE`                     | Consulte `list_models`; os modelos disponíveis mudam.                                                                                                             |
| `UNSUPPORTED_PARAMETER`                 | Remova o parâmetro ou escolha um modelo que o publique no catálogo.                                                                                               |
| `COST_UNKNOWN`                          | Falta uma tarifa ou teto atual verificável. A política `ALLOW_UNKNOWN_COST=false` bloqueia antes da reserva/POST; atualize o catálogo e repita apenas a consulta gratuita. |
| `REQUEST_COST_LIMIT`                    | A estimativa/limite superior atual excede `max_cost_usd` ou o limite global local. Nenhum POST foi iniciado.                                                     |
| `IMAGE_RESPONSE_DATA_MISSING`           | A resposta HTTP 200 não tem `data`; os bytes ficam preservados e o erro aparece como falha de interpretação.                                                   |
| `IMAGE_RESPONSE_EMPTY`                  | `data` está presente mas vazio; a resposta e o custo são preservados, sem retry pago.                                                                            |
| `INVALID_RESPONSE`                      | JSON ou esquema não corresponde ao contrato; quando o corpo foi recebido e preservado, `recover_image_job_response` pode tentar apenas parsing local.          |
| `INVALID_BASE64` / `INVALID_IMAGE_FORMAT` / `IMAGE_MIME_MISMATCH` | A resposta não passou validação de base64, assinatura ou MIME; verifique `response_capture` no estado do job antes de recuperação local. |
| `RAW_RESPONSE_STORAGE_LIMIT`            | A quota local de corpos HTTP 200 foi atingida; o pedido pode ter sido cobrado e fica incerto sem retry. Liberte espaço só após rever histórico/backups.         |
| `PRESERVED_RESPONSE_CORRUPT`             | Hash/tamanho do corpo local não coincide. Não volte a gerar; preserve a base e faça backup antes de qualquer recuperação.                                     |
| `PAYMENT_NOT_AUTHORIZED`                | Use `allow_paid: true` apenas quando a operação paga foi autorizada. `dry_run` não gera conteúdo.                                                                 |
| `TOTAL_SPEND_LIMIT`                     | O limite acumulado foi atingido ou a reserva conhecida não cabe no saldo restante.                                                                                |
| `UNKNOWN_SPEND_REQUIRES_RECONCILIATION` | Houve um POST com resultado/custo incerto. Preserve a reserva e verifique OpenRouter e os registos locais; reconcilie apenas com evidência verificada.             |
| `DUPLICATE_UNCERTAIN_REQUEST`           | O mesmo pedido está pendente ou teve resposta incerta. Reutilize o job existente ou use `reconcile_image_job` com evidência verificada; não remova o JSON manualmente. |
| `IMAGE_TO_VIDEO_UNSUPPORTED`            | O catálogo não publica `first_frame` para esse modelo. Escolha um modelo que publique o tipo de frame requerido.                                                  |
| `VIDEO_AUDIO_REQUIRED`                  | HeyGen Video 1 sempre gera áudio. Omita `generate_audio`; para remover a faixa, faça pós-processamento separado com FFmpeg.                                       |
| `UNSUPPORTED_VIDEO_AUDIO`               | O modelo não publica controlo configurável de áudio. Omita `generate_audio`; o valor `false` do catálogo não garante vídeo silencioso.                            |
| `UNSAFE_IMAGE_URL`                      | Para `input_image_url`, use HTTPS sem IP literal, hostname local, credenciais ou fragmento.                                                                       |
| `PATH_NOT_ALLOWED`                      | Use um caminho sob `YBERU_PROJECT_ROOT`/`CLAUDE_PROJECT_DIR` ou acrescente a raiz a `YBERU_ALLOWED_ROOTS`.                                                        |
| `SYMLINK_NOT_ALLOWED`                   | O caminho de saída passa por symlink. Escolha um diretório normal dentro de uma raiz autorizada.                                                                  |
| `VIDEO_NOT_READY`                       | Consulte o job mais tarde com `get_video_status`; não inicie outra geração.                                                                                       |
| Falha de conteúdo vídeo                 | O MCP usa `/videos/{id}/content`, valida MIME e assinatura, e rejeita redirecionamentos. Consulte novamente o estado e repita apenas o download, nunca a geração. |
| Claude mostra ligação falhada           | Confirme o caminho absoluto em `claude mcp get`, `OPENROUTER_API_KEY` no ambiente pai, e use `/mcp` para verificar aprovação de um servidor de projeto.           |

Os erros HTTP 400, 401, 402, 403, 404, 429 e 5xx são traduzidos para mensagens curtas. O servidor não repete POSTs de geração automaticamente.

## Diagnóstico de rede do OpenRouter

Depois de compilar, execute `npm run diagnose:network`. O comando faz apenas `GET /api/v1/key` com a chave atual e `POST /api/v1/chat/completions` com `{}` e sem autenticação. O segundo pedido é inválido e não contém um modelo ou mensagens para geração. O comando nunca imprime cabeçalhos, chave, corpos de resposta ou detalhes da conta. Um `GET 200` confirma que a chave foi aceite; qualquer status HTTP no POST inválido confirma que o host respondeu. O status esperado do POST pode ser 400 ou 401.

O cliente HTTP usa `fetch` do Node 24, implementado sobre Undici. Em `NETWORK_ERROR`, o cliente preserva a cadeia `cause`; o worker regista apenas códigos de erro permitidos, camada de transporte e fase identificável: DNS, TCP, TLS, envio/espera dos cabeçalhos ou leitura do corpo. Regista também duração e indica timeout. A camada `fetch` não consegue provar se um reset anterior aos cabeçalhos aconteceu durante o envio ou enquanto aguardava resposta, por isso essa fase aparece combinada. Mensagens textuais da exceção nunca são registadas.

Redirecionamentos são detetados com `redirect: 'manual'` e bloqueados explicitamente. O cliente não segue `Location`, não envia a chave a outro host e mantém o pedido pago em estado incerto quando recebeu um 3xx. O `redirect: 'error'` anterior podia rejeitar o redirect dentro de `fetch` como um erro genérico sem status HTTP.

No incidente `dabf507f-44c6-4ab2-949f-52e15944606e`, o log disponível indicava falha em 641 ms, `post_started` e nenhum status HTTP. A versão anterior guardou o `cause` no `AppError`, mas o worker descartava-o ao criar a mensagem segura. O histórico não contém informação suficiente para determinar se foi reset TCP, DNS, TLS ou redirect; nenhum diagnóstico posterior pode reconstruir essa causa. A verificação gratuita posterior obteve GET 200 e POST inválido 400, o que confirma que a chave e a conectividade funcionavam nessa verificação, não durante o incidente.

O unit `systemd --user` atual executa Node v24.22.0, tem apenas `NODE_ENV=production` no ambiente do unit e não declara proxy. Node 24 usa Undici para `fetch`; o suporte a `HTTP_PROXY`/`HTTPS_PROXY` requer configuração reconhecida no arranque do Node, incluindo `NODE_USE_ENV_PROXY=1`. Um `.env` carregado depois do arranque não ativa por si só o dispatcher de proxy. Não desative a validação TLS (`NODE_TLS_REJECT_UNAUTHORIZED=0`) para contornar erros de certificado.

```bash
cd /home/yberudev/Documentos/MCPGeneration
npm run build
npm run diagnose:network
journalctl --user -u mcp-generation-image-worker.service -n 100 --no-pager -o cat
```

Se um POST de imagem falhar sem resposta conclusiva, o estado permanece `uncertain`, a reserva mantém-se e não existe retry automático. Só reconcilie depois de confirmar a atividade e o custo na conta OpenRouter.
