# Claude Code

1. Instale Node.js 20.19+, clone o repositório e corra `npm ci` e `npm run build`.
2. Configure `OPENROUTER_API_KEY` no `.env` da pasta do repositório ou no ambiente que inicia Claude Code. O servidor resolve o `.env` a partir do seu próprio ficheiro instalado, por isso o registo global continua a ler a chave quando abre outro projeto. Não grave o segredo no `.mcp.json` versionado nem nos argumentos de `claude mcp add`.
3. Registe o processo local:

   ```bash
   claude mcp add --scope user --transport stdio mcp-generation-openrouter -- node /absolute/path/to/MCPGeneration-for-Openrouter/dist/index.js
   ```

4. Verifique com `claude mcp list`, `claude mcp get mcp-generation-openrouter` e `/mcp` dentro da sessão.

Para configuração do projeto, copie `examples/.mcp.json.example` para `.mcp.json`, atualize o executável e disponibilize a variável de chave. Claude Code pode interpolar `${OPENROUTER_API_KEY}` no campo `env`; o valor não é incluído no ficheiro.

Claude Code define `CLAUDE_PROJECT_DIR` no processo MCP. `YBERU_PROJECT_ROOT` pode substituir essa raiz. Acrescente outras pastas explicitamente com `YBERU_ALLOWED_ROOTS` antes de as passar às ferramentas. O processo MCP não depende do diretório de trabalho para localizar o `.env` da instalação.

## Pedidos úteis

- “Lista os modelos de imagem e diz quais aceitam `input_references`.”
- “Faz `dry_run` para gerar uma imagem, mostra o custo e os parâmetros.”
- “Quando eu autorizar, gera a imagem com `allow_paid=true` e guarda no projeto.”
- “Inicia um vídeo e guarda o job ID. Consulta-o depois com `get_video_status`.”
- “Quando o estado for `completed`, descarrega com `download_video`.”

O MCP guarda os ficheiros no disco. O Claude Code continua responsável por alterar os componentes do website, jogo ou aplicação que usam esses caminhos.
