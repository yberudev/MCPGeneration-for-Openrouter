# MCPGeneration for OpenRouter

Servidor MCP local, em TypeScript, que liga clientes como Claude Desktop/Code à API multimodal do OpenRouter. A geração de imagens é enfileirada numa base SQLite durável e executada por um worker Node independente do transporte MCP; vídeo mantém o fluxo existente.

O servidor usa MCP v2 e transporte `stdio`. Não inclui uma interface web nem executa um agente autónomo. O cliente MCP decide quando chamar as ferramentas e como integrar os recursos no código do projeto.

## Funcionalidades

- Catálogos atuais de modelos e capacidades publicados pelo OpenRouter.
- Geração, edição e variações de imagens pelo endpoint dedicado `/images`, através de jobs duráveis.
- Geração assíncrona de vídeo, animação de primeiro frame, consulta de estado e download autenticado por streaming.
- Limites de custo, autorização `allow_paid`, modo `dry_run` e registo local de uso.
- Fila local SQLite/WAL, deduplicação, recuperação conservadora após reinício e estado de entrega separado do estado financeiro.
- Gravação de imagens e vídeos dentro de raízes autorizadas, sem sobrescrever ficheiros existentes.
- Respostas MCP com conteúdo legível e `structuredContent`.

## Ferramentas MCP

| Ferramenta             | Utilização                                                                     |
| ---------------------- | ------------------------------------------------------------------------------ |
| `list_models`          | Pesquisa capacidades verificadas nos catálogos de imagem e vídeo.              |
| `start_image_job`      | Enfileira uma geração e devolve `job_id` sem esperar pela resposta paga.       |
| `start_image_edit_job` | Enfileira edição com `input_references` e devolve `job_id`.                    |
| `get_image_job_status` | Consulta estado, fases, custo, erro e ficheiros guardados.                     |
| `list_image_jobs`      | Lista jobs e reservas legadas sem as modificar.                                |
| `recover_image_job_response` | Volta a interpretar localmente uma resposta/saída durável; nunca envia POST. |
| `reconcile_image_job`  | Regista decisão financeira manual com evidência; nunca repete o POST.          |
| `generate_image`       | Wrapper compatível: agora enfileira e devolve `job_id`.                        |
| `edit_image`           | Wrapper compatível: agora enfileira e devolve `job_id`.                        |
| `generate_variations`  | Wrapper compatível: enfileira o conjunto como job durável.                     |
| `generate_video`       | Inicia uma tarefa text-to-video e devolve os IDs local e remoto.               |
| `animate_image`        | Envia uma imagem como primeiro frame, quando o modelo declara essa capacidade. |
| `get_video_status`     | Consulta e persiste o estado de um job já submetido.                           |
| `download_video`       | Descarrega uma tarefa concluída para uma raiz autorizada.                      |
| `estimate_cost`        | Calcula preço fixo, limite superior, estimativa fundamentada ou `unknown`.     |
| `list_assets`          | Lista metadados de recursos locais sem enviar conteúdo binário.                |

## Modelos iniciais

Os modelos padrão são `google/gemini-3.1-flash-lite-image` e `heygen/heygen-video-1`. O catálogo é consultado em tempo de execução; os identificadores e capacidades podem mudar. `google/gemini-3.1-flash-image` também está disponível para ser escolhido explicitamente quando existir no catálogo.

O servidor valida proporções, resoluções, durações, áudio, entrada de referência e quantidade de resultados contra os dados que o OpenRouter publica para cada modelo. O campo de áudio é opcional: quando omitido, não é enviado. `list_models` separa áudio configurável, gerido pelo fornecedor e obrigatório. Não tenta um endpoint de chat como fallback.

## Requisitos

- Node.js 24 ou superior (usa `node:sqlite` integrado, sem dependência SQLite nativa externa).
- npm.
- Uma chave OpenRouter para consultar catálogos ou fazer pedidos à API.
- Claude Code ou outro cliente MCP que suporte servidores locais `stdio`.

O SDK MCP instalado é `@modelcontextprotocol/server` v2.3.1. O runtime do MCP e o worker têm de usar o mesmo diretório de dados; o worker corre como serviço `systemd --user` no Linux.

## Instalação e configuração

```bash
git clone git@github.com:yberudev/MCPGeneration-for-Openrouter.git
cd MCPGeneration-for-Openrouter
npm ci
cp .env.example .env
```

Configure a chave OpenRouter num ficheiro fora do repositório, `~/.config/mcp-generation/worker.env`, com permissões `0600`. O MCP e o worker também aceitam variáveis herdadas pelo processo. O carregamento não depende do projeto que Claude abriu; não guarde a chave num `.mcp.json` versionado. `.env` continua disponível para configuração de desenvolvimento e está ignorado pelo Git.

```bash
npm run build
npm run typecheck
npm run lint
npm test
```

No Linux, instale e inicie o worker de imagens depois de colocar a chave no ficheiro externo. O script compila, cria cópias datadas dos JSON financeiros/metadados e instala um serviço `systemd --user`:

```bash
scripts/worker/prepare-env.sh
scripts/worker/install-systemd-user.sh
scripts/worker/verify.sh
```

Para testar gratuitamente a conectividade e a chave sem gerar conteúdo, execute `npm run diagnose:network`. Faz um GET autenticado à chave e um POST inválido sem autenticação; nunca envia um pedido válido de geração.

`prepare-env.sh` move a variável de `.env` para o ficheiro externo, quando necessário, preserva uma cópia com permissões restritas e nunca mostra o valor. Se não existir uma chave local, crie `~/.config/mcp-generation/worker.env` com `OPENROUTER_API_KEY=<a sua chave>` e modo `0600`. Consulte [operação e recuperação do worker](docs/image-jobs-linux.md).

Inicie o servidor localmente com `npm start`. Num terminal, o processo fica à espera de um cliente MCP; a saída padrão é reservada ao protocolo.

## Integração com Claude Code

Claude Code define `CLAUDE_PROJECT_DIR` no processo do servidor MCP. Assim, o projeto ativo passa a ser a raiz autorizada sem depender de `process.cwd()`. Num registo global, a chave pode ficar no `.env` da pasta de instalação deste servidor ou no ambiente que inicia Claude Code. O carregamento do `.env` é ancorado à pasta de instalação, não ao projeto aberto.

1. Exporte a chave no terminal ou no gestor de ambiente usado para iniciar Claude Code:

   ```bash
   export OPENROUTER_API_KEY='sk-or-…'
   ```

2. Registe o servidor no âmbito do utilizador. Para esta cópia do workspace:

   ```bash
   claude mcp add --scope user --transport stdio mcp-generation-openrouter -- node /home/yberudev/Documentos/MCPGeneration/dist/index.js
   ```

   Se mudar a pasta do repositório, substitua esse caminho absoluto pelo caminho de `dist/index.js` na nova localização.

3. Inicie Claude Code no projeto e confirme a ligação:

   ```bash
   claude mcp list
   claude mcp get mcp-generation-openrouter
   ```

   Dentro da sessão, use `/mcp` para ver as ferramentas disponíveis. Um servidor no âmbito de projeto configurado por `.mcp.json` pode pedir aprovação na primeira utilização.

Também pode usar um ficheiro `.mcp.json` de projeto. O exemplo sem credenciais está em [`examples/.mcp.json.example`](examples/.mcp.json.example). Atualize o caminho absoluto para o executável e disponibilize `OPENROUTER_API_KEY` no ambiente do Claude Code.

Depois de ligado, peça ao Claude Code, por exemplo: “Lista os modelos de vídeo, gera uma imagem de teste com `allow_paid=true` e guarda-a no meu projeto.” As chamadas pagas exigem essa autorização explícita. Para acompanhar vídeos, peça `get_video_status` com o ID local que `generate_video` devolveu e, quando o estado for `completed`, peça `download_video`.

## Diretórios e persistência

Por omissão, os recursos ficam em:

```text
<projeto>/public/assets/generated/images/
<projeto>/public/assets/generated/videos/
```

`YBERU_ASSETS_DIR` altera o diretório de saída relativo ao projeto. `YBERU_PROJECT_ROOT` substitui a raiz detetada; `YBERU_ALLOWED_ROOTS` acrescenta outras raízes autorizadas, separadas pelo separador de caminhos do sistema (`:` no Linux/macOS). Um caminho absoluto passado a uma ferramenta só é aceite se estiver dentro de uma dessas raízes. O servidor rejeita directory traversal, symlinks de saída e colisões; nunca substitui ficheiros existentes.

O estado local fica em `~/.local/share/mcp-generation-openrouter/` por omissão. `YBERU_DATA_DIR` define outra pasta absoluta e tem de ser igual para MCP e worker. O diretório guarda os metadados legados `jobs.json`, `assets.json`, `usage.json`, `requests.json` e a nova fila `image-jobs.sqlite` (WAL, diretório `0700`, base/sidecars `0600`). A fila contém payloads locais, prompts e imagens de entrada em base64 até à entrega; não são escritos nos logs. Respostas HTTP 200 completas são preservadas na tabela privada `image_job_raw_responses` antes do parsing JSON/Zod/base64/MIME; a base SQLite fica com modo `0600`. Respostas interpretadas e outputs duráveis têm o corpo HTTP removido, mantendo hash, tamanho e metadados estruturais seguros. Respostas com falha de parsing ficam retidas até recuperação local; a quota total predefinida é 512 MiB e não há remoção por idade. `requests.json` contém hashes e reservas, não imagens.

## Custos e operações pagas

- `allow_paid` começa em `false` em todas as ferramentas que geram conteúdo.
- Os limites padrão são `$5` por operação e `$20` acumulados. Um valor passado em `max_cost_usd` não pode ultrapassar o limite global por operação.
- O servidor consulta preços atuais do catálogo OpenRouter e limites por fornecedor em `GET /api/v1/models/{model}/endpoints`. Catálogos incompletos ou contraditórios resultam em `unknown`; com `ALLOW_UNKNOWN_COST=false`, a geração continua bloqueada.
- `google/gemini-3.1-flash-lite-image` tem estimativa quando o catálogo publica tarifas/limites suficientes: 1K usa 1.120 tokens de imagem de saída; o cálculo soma o máximo publicado de tokens de entrada e de conclusão aos tokens da imagem. Com os dados verificados em 23-10-2026, o limite superior é `$0.138457` por imagem (65536 × `$0.00000025` + 58982 × `$0.0000015` + 1120 × `$0.00003`). Referências ocupam o teto de entrada; `n.max=1`; variações multiplicam o limite por chamada. Se faltar qualquer dado, a estimativa volta a `unknown`.
- `black-forest-labs/flux-3-image` seleciona `variant` da tarifa OpenRouter: 768 `$0.041`, 1K `$0.048`, 1.5K `$0.070`, 2K `$0.100`, 4K `$0.607`. Sem resolução usa o maior preço publicado como limite superior, nunca o primeiro da lista. Os preços coincidem com a tabela BFL.
- `ALLOW_UNKNOWN_COST=true` continua a ser uma exceção explícita e não garante um teto absoluto; esta versão mantém `ALLOW_UNKNOWN_COST=false`.
- `max_cost_usd` compara estimativa/limite superior com limites locais e reserva orçamento; **não limita a cobrança do fornecedor**. O custo real é lido da resposta e pode exceder a estimativa.
- Vídeos usam as `pricing_skus` atuais quando existe uma tarifa compatível com a duração, resolução e referências. A estimativa não garante o custo final.
- `dry_run=true` consulta capacidades e custos, mostra o payload API (com base64 omitido) e não cria job nem inicia geração.
- Antes de cada POST, o servidor reserva a despesa e guarda um hash do pedido. Se o resultado de um POST ficar incerto por timeout ou falha 5xx, não repete o pedido; a reserva permanece para bloquear uma duplicação. Use `reconcile_image_job` apenas com evidência verificada; não remova manualmente reservas incertas.

As fórmulas atuais para Gemini 3.1 Flash Lite Image e FLUX 3 Image, os endpoints oficiais consultados, a distinção entre estimativa e limite superior e a preservação privada de respostas HTTP 200 estão descritos em [custos de imagem e recuperação local](docs/image-costing-and-response-recovery.md).

As ferramentas de imagem agora devolvem rapidamente `job_id` e estado local `queued`; o worker reserva o orçamento antes do POST. Consulte `get_image_job_status` até `completed`, `failed`, `uncertain` ou `reconciliation_required`. `completed` só significa que todos os outputs esperados foram validados, guardados, verificados por hash e ligados aos metadados. Se o Claude fechar/cancelar a chamada MCP, o worker continua. Um estado `uncertain` bloqueia repetição automática. O `HTTP_TIMEOUT_MS` continua a limitar a chamada HTTP do worker, não o tempo de vida do job.

Nenhuma chamada de geração paga é necessária para iniciar o processo ou descobrir ferramentas. As consultas GET públicas dos catálogos de modelos e preços não enviam a chave. Consultar estado de uma tarefa, gerar conteúdo ou descarregar vídeo requer autenticação.

## Text-to-video e image-to-video

`generate_video` envia `model`, `prompt` e parâmetros suportados; recebe um job assíncrono e persiste o ID. `get_video_status` consulta o mesmo ID e não cria outro job. O download usa `/videos/{id}/content`, autenticação OpenRouter e streaming; não usa URLs externos de resultado como links permanentes.

`animate_image` envia a imagem local como `frame_images[0]` com `frame_type: "first_frame"`, desde que o modelo publique essa capacidade. O pedido local usa uma data URL; alguns fornecedores exigem uma imagem HTTPS pública e podem rejeitá-la. Nessa situação, passe `input_image_url` HTTPS de uma imagem publicamente acessível; o MCP não descarrega esse URL e não lhe envia a chave OpenRouter. URLs com IP literal, host local, credenciais ou fragmentos são recusados. O servidor não hospeda automaticamente uma imagem local na Internet.

`generate_audio` distingue campo omitido, `true` e `false`: o campo omitido permanece fora do JSON enviado. HeyGen Video 1 sempre produz áudio; o catálogo publica `generate_audio: false`, mas esse valor não significa saída silenciosa e o endpoint rejeita `generate_audio: false`. O MCP recusa esse pedido localmente com `VIDEO_AUDIO_REQUIRED`. Modelos que anunciam controlo configurável preservam os booleans escolhidos. Para modelos sem esse controlo, o MCP não promete silêncio. O áudio gerado por HeyGen pode ser removido depois com FFmpeg (por exemplo, `ffmpeg -i input.mp4 -c:v copy -an output.mp4`); esse pós-processamento não faz parte da geração do MCP.

`frame_images` fixa uma imagem num ponto específico do vídeo; `input_references` dá imagens para orientar a cena sem fixar o frame. O custo usa SKUs diferentes: para HeyGen Video, a consulta real de 22-10-2026 publica, a 480p, `$0.02/s` em `duration_seconds_480p`, `$0.07/s` em `reference_duration_seconds_480p` e `$0.04` por imagem em `reference_input_images`. Assim, cinco segundos a 480p estimam `$0.10` para texto ou primeiro frame e `$0.39` para uma imagem de referência. O custo real continua a ser o informado pelo OpenRouter após a geração. Este projeto gera ficheiros multimédia; não cria modelos 3D manipuláveis nem animações interativas.

## Exemplos

Os prompts e os padrões para personagem, edição, animação e homepage estão em [`examples/README.md`](examples/README.md). Os testes não geram esses recursos.

## Testes

`npm test` usa respostas HTTP simuladas e um cliente MCP de teste. Abrange descoberta de ferramentas, enqueue rápido com respostas simuladas de 75/150 segundos, encerramento do adaptador, retomada segura, incerteza sem retry, HTTP 400/5xx, ECONNRESET, PNG/JPEG/WebP, JSON/esquema/base64/MIME inválido, preservação antes do parsing, custo após falha, recuperação sem segundo POST, quota/hash de respostas, falha de gravação, reconciliação, variações parciais, vídeo, limites, persistência, caminhos e sanitização dos logs. Fixtures do catálogo OpenRouter guardam as tarifas reais de Gemini e FLUX 3 obtidas por GET. Inclui concorrência entre processos para reservas. Estes testes não fazem gerações reais nem consomem créditos.

`npm run test:catalog` consulta os catálogos e preços reais, verifica Nano Banana 2, Nano Banana 2 Lite e HeyGen Video e executa `dry_run` de geração, edição, vídeo e animação. O teste faz apenas GET e verifica que nenhum POST foi enviado; requer acesso à Internet, mas não uma API key nem créditos.

Existe um teste pago de uma imagem em `tests/paid/`. Só corre se as variáveis estiverem explicitamente configuradas, incluindo `RUN_PAID_TESTS=true`, `OPENROUTER_API_KEY`, `YBERU_PROJECT_ROOT`, `ALLOW_UNKNOWN_COST=true` e `PAID_TEST_MAX_COST_USD`. **Não foi executado durante este desenvolvimento.**

## Limitações conhecidas

- O custo antecipado de modelos por token continua desconhecido quando faltam resolução, tarifas de entrada/saída ou limites máximos publicados. O catálogo pode mudar; a estimativa guardada identifica a observação usada na autorização.
- Alguns fornecedores de vídeo não aceitam data URLs; use um URL HTTPS público quando a API do modelo o exigir.
- O acompanhamento de vídeo continua a ser sob pedido, sem polling em segundo plano nem ferramenta de cancelamento. Jobs de imagem são executados em segundo plano pelo serviço local.
- O worker só funciona enquanto o serviço `systemd --user` está instalado/ativo. O job fica persistido enquanto estiver parado.
- Se o processo morrer após iniciar o POST mas antes de receber/preservar o corpo HTTP completo, o job fica `uncertain`; não há retry automático e não se garante recuperação pelo histórico OpenRouter. Depois de HTTP 200 e preservação local, falhas de interpretação podem ser recuperadas com `recover_image_job_response`, sem segundo POST. A recuperação depende da integridade local e da quota. A reconciliação financeira não reenvia o pedido.
- Só são guardados vídeos cujo tipo MIME e assinatura básica sejam MP4 ou WebM.
- A disponibilidade e os parâmetros de modelos mudam; `list_models` é a fonte atual.

## Segurança

- A API key só vem do ambiente; o repositório ignora `.env` e o servidor limita o host a `openrouter.ai`.
- Prompts não são comandos. O servidor não invoca shell.
- Downloads usam apenas o endpoint autenticado de conteúdo do OpenRouter, recusam redirecionamentos e têm limite de tamanho/MIME/assinatura.
- Os caminhos de leitura e escrita ficam dentro de raízes autorizadas. Symlinks em entradas/saídas são recusados e ficheiros existentes não são substituídos.
- POSTs de geração não têm retry automático. Erros incertos deixam uma reserva persistente para impedir duplicação inadvertida.
- Logs e erros não incluem cabeçalhos Authorization nem base64 de imagens; stdout permanece reservado ao MCP.

## Roadmap

- Presets de estilo, consistência de personagens e geração de spritesheets.
- Otimização/conversão de imagens, thumbnails e pipelines imagem → vídeo.
- Ferramentas de comparação entre modelos e catálogo local pesquisável.
- Integração opcional com FFmpeg, motores de jogo e fornecedores adicionais.

As funcionalidades futuras não fazem parte da implementação atual.

## Desenvolvimento

```bash
npm run dev
npm run build
npm run typecheck
npm run lint
npm test
```

Para adicionar um modelo, consulte o catálogo em vez de inserir capacidades fixas. As rotas e respostas do OpenRouter estão separadas do registo das ferramentas MCP.

## Licença

MIT. Consulte [`LICENSE`](LICENSE).

## Referências oficiais

- [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)
- [OpenRouter Image Generation API guide](https://openrouter.ai/blog/tutorials/image-generation/)
- [OpenRouter Video Generation API](https://openrouter.ai/docs/api/api-reference/video-generation/create-videos)
- [Claude Code: integração MCP](https://code.claude.com/docs/en/mcp)
