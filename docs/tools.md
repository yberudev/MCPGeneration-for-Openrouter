# Contratos das ferramentas

As entradas são validadas por Zod v4. As respostas usam `structuredContent` e texto JSON para clientes que mostram apenas `content`.

| Ferramenta            | Entrada principal                                                                  | Comportamento                                                                            |
| --------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `list_models`         | `type`, `search`, `refresh`                                                        | GET aos catálogos de imagem/vídeo; não gera conteúdo.                                    |
| `generate_image`      | `prompt`, `model`, `n`, `resolution`, `aspect_ratio`, `allow_paid`, `max_cost_usd` | Rejeita parâmetros fora do catálogo e grava todos os resultados válidos.                 |
| `edit_image`          | `input_image_path`, `prompt`, `model`, `allow_paid`                                | Valida imagem dentro da raiz; envia `input_references` e guarda um novo ficheiro.        |
| `generate_variations` | `prompt`, `input_image_path?`, `count`, `allow_paid`                               | Usa `n` quando suportado; caso contrário faz exatamente `count` POSTs autorizados.       |
| `recover_image_job_response` | `job_id`                                                                               | Retoma apenas parsing ou entrega a partir de dados locais; não envia POST pago.          |
| `generate_video`      | `prompt`, `model`, `duration`, `resolution`, `aspect_ratio`, `generate_audio?`     | Campo de áudio omitido por omissão; valida o controlo publicado e persiste o job.        |
| `animate_image`       | `input_image_path`, `input_image_url?`, `prompt`, parâmetros de vídeo              | Usa `frame_images` como primeiro frame; mostra áudio e limites do fornecedor no dry run. |
| `get_video_status`    | `job_id` local ou remoto                                                           | Atualiza o registo existente; falha de consulta não cria outro pedido.                   |
| `download_video`      | `job_id`, `output_dir?`, `filename?`, `index?`                                     | Exige estado concluído, streaming, limite, MIME/assinatura e gravação exclusiva.         |
| `estimate_cost`       | `type`, `model`, `operation`, `frame_image_count`, `reference_image_count`         | Usa SKUs separados para `frame_images` e `input_references`; pode devolver `unknown`.    |
| `list_assets`         | `type`, `limit`, `project_root?`                                                   | Lista metadados, sem conteúdo binário.                                                   |

Todas as operações de geração aceitam `dry_run` quando aplicável e exigem `allow_paid: true` fora do modo de simulação. `max_cost_usd` não remove limites globais nem limita a cobrança efetiva do fornecedor. Consulte sempre o catálogo atual com `list_models` antes de escolher parâmetros. `estimate_cost` devolve `kind`, `source`, `sourceDate`, `assumptions`, `confidence` e `limitations` para distinguir preço fixo, estimativa fundamentada, limite superior defensável e custo desconhecido.

Em `estimate_cost` para vídeo, `operation="animate"` calcula o custo do primeiro frame (`frame_images`). `reference_image_count` calcula uma referência (`input_references`). Não combine os dois modos num único cálculo. Para HeyGen Video, o catálogo consultado publica `$0.02/s` em `duration_seconds_480p`, `$0.07/s` em `reference_duration_seconds_480p` e `$0.04` por imagem em `reference_input_images`.

### Áudio em vídeo

`generate_audio` é opcional e preserva os três estados: omitido, `true` e `false`. Se omitido, o campo não aparece no POST e o OpenRouter/provedor decide o comportamento. `list_models` mostra `audio_policy`: `configurable` quando o catálogo anuncia controlo, `provider_managed` quando não o anuncia e `always_on` para `heygen/heygen-video-1`. O valor `generate_audio: false` do catálogo HeyGen não significa vídeo silencioso: este modelo sempre gera áudio, rejeita `generate_audio: false` e, por isso, o MCP devolve `VIDEO_AUDIO_REQUIRED` antes de reservar custos ou fazer POST. Para outros modelos sem controlo configurável publicado, o MCP recusa booleans explícitos em vez de prometer silêncio. Valores explícitos `true`/`false` são preservados para modelos que anunciam controlo configurável.

HeyGen pode produzir diálogo, ambiente e efeitos sonoros junto do vídeo. Remover a faixa depois é uma etapa de pós-processamento separada que pode ser feita com FFmpeg (por exemplo, `ffmpeg -i input.mp4 -c:v copy -an output.mp4`); o MCP não executa nem inclui FFmpeg na geração.
