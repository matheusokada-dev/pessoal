# StudyVault

Biblioteca pessoal para enviar, organizar, sincronizar e visualizar materiais HTML. O frontend usa Angular 19, Supabase Auth/Database/Storage e está pronto para Vercel.

## Experiência da biblioteca

- Sidebar com cabeçalho e rodapé fixos, área de pastas rolável e drawer acessível no celular.
- Árvore de pastas recolhível, filtro, subpastas, contagem recursiva e recuperação de arquivos órfãos em **Sem pasta**.
- Busca por arquivo ou pasta, favoritos, ordenação, grade/lista e seleção múltipla para movimentação.
- Upload em lote com validação de HTML e tamanho, feedback parcial e proteção contra duplicação após falha de sincronização.
- Preview isolado em `iframe`, cache LRU limitado e descarte seguro de requisições após troca de conta.

## Rodar localmente

Requisitos: Node 20+.

```bash
npm install
npm start
```

Abra `http://localhost:4200` e entre com um usuário previamente cadastrado no Supabase.

## Persistência em nuvem com Supabase

1. No projeto Supabase, abra **SQL Editor → New query**.
2. Cole e execute todo o conteúdo de `supabase/schema.sql`.
3. Em **Authentication → Users**, crie os usuários da aplicação e marque o email como confirmado.
4. Em **Authentication → URL Configuration**, use a URL da Vercel como Site URL após o primeiro deploy.

O cliente já está conectado ao projeto Supabase. O schema usa bucket privado e Row Level Security: cada usuário só acessa seus próprios arquivos.

Em uma instalação existente, aplique os arquivos de `supabase/migrations/` em ordem. A migração de endurecimento adiciona índices, grants explícitos, políticas RLS otimizadas, proteção contra ciclos e exclusão transacional de pastas.

### Usuários sem email na interface

O login aceita um nome de usuário e o converte internamente para
`usuario@studyvault.local`. Para cadastrar `matheusokada`, crie no painel:

- Email: `matheusokada@studyvault.local`
- User metadata: `{"username":"matheusokada","display_name":"Matheus Okada"}`

Senhas existem apenas no Supabase Auth e nunca devem ser gravadas no código-fonte.

## Deploy do Angular na Vercel

1. Importe este repositório na Vercel.
2. Framework: **Angular**.
3. Build command: `npm run build`.
4. Output directory: `dist/study-vault/browser`.
5. Faça o deploy. O `vercel.json` já configura o fallback das rotas.

## Backend Java

A Vercel não oferece runtime Java/Spring Boot persistente. A base Spring Boot está em `backend/` e deve ser publicada em Render, Railway ou Fly.io; configure `FRONTEND_URL` com a URL da Vercel. Para executar localmente:

```bash
cd backend
./mvnw spring-boot:run
```

O frontend pode funcionar inteiramente com Supabase, que é o caminho recomendado para manter o deploy simples e dentro das camadas gratuitas. A API Java permanece opcional para validações, integrações ou regras avançadas.

## Segurança do preview

Os HTMLs são exibidos em um `iframe` com sandbox. Para materiais não confiáveis, remova `allow-scripts` do atributo `sandbox` em `app.component.html`.
