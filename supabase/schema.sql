create extension if not exists "pgcrypto";

create table if not exists public.study_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  folder text not null default 'projects',
  storage_path text not null unique,
  size_bytes bigint not null default 0,
  favorite boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.study_files enable row level security;

drop policy if exists "users own files" on public.study_files;
create policy "users own files" on public.study_files
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('study-html', 'study-html', false, 10485760, array['text/html'])
on conflict (id) do update set
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = array['text/html'];

drop policy if exists "users own stored html" on storage.objects;
create policy "users own stored html" on storage.objects
  for all using (
    bucket_id = 'study-html'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'study-html'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
