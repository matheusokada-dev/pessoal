# StudyVault

Biblioteca pessoal para enviar, organizar e visualizar materiais HTML. O frontend usa Angular 19 e está pronto para Vercel. A pasta `backend/` contém a base de uma API Spring Boot para regras de negócio futuras.

## Rodar localmente

Requisitos: Node 20+.

```bash
npm install
npm start
```

Abra `http://localhost:4200`. A aplicação já funciona em modo demonstração, persistindo os arquivos no `localStorage` do navegador.

## Persistência em nuvem com Supabase

1. Crie um projeto gratuito no Supabase.
2. No SQL Editor, execute `supabase/schema.sql`.
3. Ative um provedor em **Authentication** (email/senha é suficiente).
4. Use `SUPABASE_URL` e `SUPABASE_ANON_KEY` somente no frontend. Nunca exponha a service-role key.
5. Troque a implementação de `LibraryService` por um adaptador Supabase que grave metadados nas tabelas e o conteúdo no bucket privado `study-html`.

O schema inclui Row Level Security: cada usuário só acessa seus próprios arquivos.

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
