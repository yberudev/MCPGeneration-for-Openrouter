# Arquitetura

O processo é um servidor MCP `stdio`. `src/index.ts` carrega configuração e inicia `serveStdio`; `src/server.ts` cria os serviços e regista as ferramentas.

## Camadas

- `src/tools/`: esquemas de entrada, validação específica de operação e resposta estruturada.
- `src/providers/openrouter/`: cliente HTTP, erros sanitizados e validação Zod das respostas.
- `src/services/model-registry.ts`: cache de cinco minutos dos catálogos oficiais; o worker força GET atualizado antes da primeira reserva/POST.
- `src/services/asset-manager.ts`: valida caminhos autorizados, tipos e tamanhos, grava por temporário e evita sobrescrita.
- `src/services/metadata-store.ts`: JSON local com escritas atómicas, serialização entre sessões do processo e lockfile entre processos para jobs, recursos, gastos e pedidos pagos.
- `src/services/job-manager.ts`: normaliza estados assíncronos e persiste respostas de vídeo.
- `src/services/cost-guard.ts`: calcula preços por unidade e limites de token publicados, valida autorização e reserva o limite global antes de um POST.
- `src/config/env.ts`: esquema Zod v4 centralizado para configuração.

## Decisões

- Imagens usam apenas `POST /images`; referências entram via `input_references`.
- Vídeos usam POST assíncrono, GET de estado e GET autenticado de conteúdo.
- POSTs pagos não têm retry automático. Uma intenção persistente com hash evita duplicação idêntica quando a resposta do pedido é incerta.
- Preço/limite ausente ou contraditório significa `unknown`. Gemini 3.1 Flash Lite Image só recebe limite superior quando o catálogo publica tarifas e limites de entrada/saída; FLUX 3 seleciona a variante de resolução efetivamente publicada.
- Reserva com o mesmo `request_id`/fingerprint revalida e substitui atomicamente a tarifa conhecida se o worker reiniciar antes do primeiro POST. A reserva anterior continua intacta se a nova exceder os limites.
- Catálogo é autoridade para parâmetros. Quando um parâmetro opcional não consta do catálogo, a ferramenta não o envia.
- O transporte `stdio` não escreve logs na saída padrão.

## Estado local

`jobs.json` armazena IDs remotos e configuração sem conteúdo base64; `assets.json` guarda metadados sem binários; `usage.json` reserva/corrige valores estimados e efetivos; `requests.json` guarda fingerprints e reservas pendentes/incertas. Os ficheiros são privados pelo modo `0600`; a pasta usa `0700` quando é criada. `proper-lockfile` usa `mkdir` atómico no diretório de dados para serializar operações read-modify-write e reservas entre processos; o heartbeat atualiza o lock e permite recuperar locks abandonados após 30 segundos.

`image-jobs.sqlite` guarda `image_job_raw_responses`. O HTTP 200 completo e o respetivo hash são commitados em WAL/FULL antes do parsing. A tabela conserva corpo privado até parsing e outputs terem sido armazenados; o commit de outputs limpa o BLOB e mantém hash/tamanho/metadados seguros. Em falha de interpretação, o corpo fica até recuperação local explícita ou até atingir `MAX_RAW_RESPONSE_STORAGE_BYTES` (512 MiB por omissão). Não há purge por idade. `recover_image_job_response` reprocessa esses bytes ou redelivera outputs duráveis, sem POST.
