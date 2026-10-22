# Arquitetura

O processo é um servidor MCP `stdio`. `src/index.ts` carrega configuração e inicia `serveStdio`; `src/server.ts` cria os serviços e regista as ferramentas.

## Camadas

- `src/tools/`: esquemas de entrada, validação específica de operação e resposta estruturada.
- `src/providers/openrouter/`: cliente HTTP, erros sanitizados e validação Zod das respostas.
- `src/services/model-registry.ts`: cache de cinco minutos dos catálogos oficiais.
- `src/services/asset-manager.ts`: valida caminhos autorizados, tipos e tamanhos, grava por temporário e evita sobrescrita.
- `src/services/metadata-store.ts`: JSON local com escritas atómicas e serializadas para jobs, recursos, gastos e pedidos pagos.
- `src/services/job-manager.ts`: normaliza estados assíncronos e persiste respostas de vídeo.
- `src/services/cost-guard.ts`: calcula estimativas publicadas, valida autorização e reserva o limite global antes de um POST.
- `src/config/env.ts`: esquema Zod v4 centralizado para configuração.

## Decisões

- Imagens usam apenas `POST /images`; referências entram via `input_references`.
- Vídeos usam POST assíncrono, GET de estado e GET autenticado de conteúdo.
- POSTs pagos não têm retry automático. Uma intenção persistente com hash evita duplicação idêntica quando a resposta do pedido é incerta.
- Preço ausente ou variável significa `unknown`. A aplicação não estima um custo fixo a partir de promoções ou exemplos.
- Catálogo é autoridade para parâmetros. Quando um parâmetro opcional não consta do catálogo, a ferramenta não o envia.
- O transporte `stdio` não escreve logs na saída padrão.

## Estado local

`jobs.json` armazena IDs remotos e configuração sem conteúdo base64; `assets.json` guarda metadados sem binários; `usage.json` reserva/corrige valores estimados e efetivos; `requests.json` guarda fingerprints e reservas pendentes/incertas. Os ficheiros são privados pelo modo `0600`; a pasta usa `0700` quando é criada.
