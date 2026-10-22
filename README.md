# MCPGeneration for OpenRouter

Servidor MCP local, em TypeScript, que liga clientes como Claude Code à API multimodal do OpenRouter. Expõe ferramentas para descobrir modelos, gerar e editar imagens, criar variações, iniciar tarefas de vídeo, acompanhar o estado e guardar os ficheiros num projeto local.

O servidor usa MCP v2 e transporte `stdio`. Não inclui uma interface web nem executa um agente autónomo. O cliente MCP decide quando chamar as ferramentas e como integrar os recursos no código do projeto.

## Funcionalidades

- Catálogos atuais de modelos e capacidades publicados pelo OpenRouter.
- Geração, edição e variações de imagens pelo endpoint dedicado `/images`.
- Geração assíncrona de vídeo, animação de primeiro frame, consulta de estado e download autenticado por streaming.
- Limites de custo, autorização `allow_paid`, modo `dry_run` e registo local de uso.
- Persistência de jobs após reinício do processo.
- Gravação de imagens e vídeos dentro de raízes autorizadas, sem sobrescrever ficheiros existentes.
- Respostas MCP com conteúdo legível e `structuredContent`.

## Ferramentas MCP

| Ferramenta            | Utilização                                                                     |
| --------------------- | ------------------------------------------------------------------------------ |
| `list_models`         | Pesquisa capacidades verificadas nos catálogos de imagem e vídeo.              |
| `generate_image`      | Gera uma ou mais imagens e guarda os resultados.                               |
| `edit_image`          | Edita uma imagem local através de `input_references`.                          |
| `generate_variations` | Produz um conjunto limitado de variações com nomes numerados.                  |
| `generate_video`      | Inicia uma tarefa text-to-video e devolve os IDs local e remoto.               |
| `animate_image`       | Envia uma imagem como primeiro frame, quando o modelo declara essa capacidade. |
| `get_video_status`    | Consulta e persiste o estado de um job já submetido.                           |
| `download_video`      | Descarrega uma tarefa concluída para uma raiz autorizada.                      |
| `estimate_cost`       | Calcula uma estimativa com os metadados atuais ou devolve `unknown`.           |
| `list_assets`         | Lista metadados de recursos locais sem enviar conteúdo binário.                |

## Modelos iniciais

Os modelos padrão são `google/gemini-3.1-flash-lite-image` e `heygen/heygen-video-1`. O catálogo é consultado em tempo de execução; os identificadores e capacidades podem mudar. `google/gemini-3.1-flash-image` também está disponível para ser escolhido explicitamente quando existir no catálogo.

O servidor valida proporções, resoluções, durações, áudio, entrada de referência e quantidade de resultados contra os dados que o OpenRouter publica para cada modelo. Não tenta um endpoint de chat como fallback.

## Requisitos

- Node.js 20.19 ou superior.
- npm.
- Uma chave OpenRouter para consultar catálogos ou fazer pedidos à API.
- Claude Code ou outro cliente MCP que suporte servidores locais `stdio`.

O SDK MCP instalado é `@modelcontextprotocol/server` v2.3.1. A linha v2 do SDK requer Node.js 20 ou superior e usa `serveStdio` de `@modelcontextprotocol/server/stdio`.

## Instalação e configuração

```bash
git clone git@github.com:yberudev/MCPGeneration-for-Openrouter.git
cd MCPGeneration-for-Openrouter
npm ci
cp .env.example .env
```

Edite `.env` e configure `OPENROUTER_API_KEY`. O ficheiro `.env` está ignorado pelo Git. Para uma execução local a partir desta pasta, o `dotenv` carrega esse ficheiro. Para Claude Code, configure a variável no ambiente que inicia o Claude ou use a interpolação descrita abaixo; uma entrada `.mcp.json` não deve conter uma chave literal.

```bash
npm run build
npm run typecheck
npm run lint
npm test
```

Inicie o servidor localmente com `npm start`. Num terminal, o processo fica à espera de um cliente MCP; a saída padrão é reservada ao protocolo.

## Integração com Claude Code

Claude Code define `CLAUDE_PROJECT_DIR` no processo do servidor MCP. Assim, o projeto ativo passa a ser a raiz autorizada sem depender de `process.cwd()`.

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

O estado local fica em `~/.local/share/mcp-generation-openrouter/` por omissão. `YBERU_DATA_DIR` define outra pasta absoluta. O diretório guarda `jobs.json`, `assets.json`, `usage.json` e `requests.json`; as imagens não são guardadas em base64 nesses registos. `requests.json` contém hashes e reservas, não prompts nem conteúdo de imagem.

## Custos e operações pagas

- `allow_paid` começa em `false` em todas as ferramentas que geram conteúdo.
- Os limites padrão são `$5` por operação e `$20` acumulados. Um valor passado em `max_cost_usd` não pode ultrapassar o limite global por operação.
- O servidor consulta preços do catálogo. Algumas imagens são faturadas por tokens de saída; como o número de tokens do resultado não é conhecido antes da geração, a ferramenta devolve `unknown` e bloqueia a chamada por omissão.
- `ALLOW_UNKNOWN_COST=true` é uma política explícita do operador. Permite uma única operação cuja estimativa não é verificável, mas não torna possível garantir um teto para esse pedido. Se o custo final também não vier na resposta, as próximas chamadas pagas ficam bloqueadas até reconciliação manual.
- Vídeos usam as `pricing_skus` atuais quando existe uma tarifa compatível com a duração, resolução e referências. A estimativa não garante o custo final.
- `dry_run=true` consulta capacidades e custos, mas não inicia uma geração.
- Antes de cada POST, o servidor reserva a despesa e guarda um hash do pedido. Se o resultado de um POST ficar incerto por timeout ou falha 5xx, não repete o pedido; a reserva permanece para bloquear uma duplicação. Depois de confirmar a atividade no OpenRouter, reconcilie a entrada correspondente em `requests.json`/`usage.json` antes de remover uma reserva.

Nenhuma chave ou chamada de geração paga é necessária para iniciar o processo ou descobrir ferramentas. As chamadas aos catálogos são GET e não geram conteúdo.

## Text-to-video e image-to-video

`generate_video` envia `model`, `prompt` e parâmetros suportados; recebe um job assíncrono e persiste o ID. `get_video_status` consulta o mesmo ID e não cria outro job. O download usa `/videos/{id}/content`, autenticação OpenRouter e streaming; não usa URLs externos de resultado como links permanentes.

`animate_image` envia a imagem local como `frame_images[0]` com `frame_type: "first_frame"`, desde que o modelo publique essa capacidade. O pedido local usa uma data URL; alguns fornecedores exigem uma imagem HTTPS pública e podem rejeitá-la. Nessa situação, passe `input_image_url` HTTPS de uma imagem publicamente acessível; o MCP não descarrega esse URL e não lhe envia a chave OpenRouter. URLs com IP literal, host local, credenciais ou fragmentos são recusados. O servidor não hospeda automaticamente uma imagem local na Internet.

`input_references` para imagens orienta uma edição/variação. `frame_images` fixa uma imagem num ponto específico do vídeo. A disponibilidade dos dois modos é diferente por modelo. Este projeto gera ficheiros multimédia; não cria modelos 3D manipuláveis nem animações interativas.

## Exemplos

Os prompts e os padrões para personagem, edição, animação e homepage estão em [`examples/README.md`](examples/README.md). Os testes não geram esses recursos.

## Testes

`npm test` usa respostas HTTP simuladas e um cliente MCP de teste. Abrange descoberta de ferramentas, geração/edição/variações, submissão e recuperação de jobs, download interrompido, limites, persistência, deteção de formato e restrições de caminhos. Os testes não usam uma API key nem consomem créditos.

Existe um teste pago de uma imagem em `tests/paid/`. Só corre se as variáveis estiverem explicitamente configuradas, incluindo `RUN_PAID_TESTS=true`, `OPENROUTER_API_KEY`, `YBERU_PROJECT_ROOT`, `ALLOW_UNKNOWN_COST=true` e `PAID_TEST_MAX_COST_USD`. **Não foi executado durante este desenvolvimento.**

## Limitações conhecidas

- O custo antecipado por imagem pode ser desconhecido quando o OpenRouter publica apenas preço por token.
- Alguns fornecedores de vídeo não aceitam data URLs; use um URL HTTPS público quando a API do modelo o exigir.
- O acompanhamento é sob pedido, sem polling em segundo plano e sem ferramenta de cancelamento.
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
