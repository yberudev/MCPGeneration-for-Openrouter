# Exemplos de pedidos para Claude Code

Estes exemplos descrevem como o Claude Code pode combinar as ferramentas MCP com as alterações de código no projeto. Não executam gerações por conta própria.

## A — Personagem

“Cria uma personagem 3D estilizada de um pequeno dragão verde, com olhos grandes, materiais suaves e iluminação de estúdio. Usa `generate_image` com `allow_paid=true`, confirma o modelo e o custo primeiro e guarda o ficheiro no meu projeto.”

## B — Edição

“Utiliza a imagem `public/assets/dragon.png`, mantém a personagem e altera o fundo para uma floresta mágica. Usa `edit_image`, preserva o original e guarda o resultado na pasta de imagens geradas.”

## C — Animação

“Utiliza a imagem do dragão para criar um vídeo de cinco segundos. Confirma que o modelo aceita `first_frame`, pede autorização antes da geração paga, acompanha com `get_video_status` e descarrega o vídeo concluído.”

Se o fornecedor não aceitar a data URL local, o cliente pode disponibilizar a imagem num HTTPS público e passar `input_image_url`. O MCP não publica ficheiros locais.

## D — Homepage

“Lista os modelos de imagem disponíveis e estima os custos. Depois de eu confirmar as chamadas pagas, cria os recursos visuais para uma homepage moderna, guarda-os em `public/assets/generated` e utiliza os caminhos devolvidos para atualizar os componentes existentes.”
