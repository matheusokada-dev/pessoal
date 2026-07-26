create extension if not exists "pgcrypto";

create table public.folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  color text not null default '#407d63',
  created_at timestamptz not null default now()
);

create table public.study_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  folder_id uuid references public.folders(id) on delete set null,
  name text not null,
  storage_path text not null,
  size_bytes bigint not null default 0,
  favorite boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.folders enable row level security;
alter table public.study_files enable row level security;

create policy "users own folders" on public.folders
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users own files" on public.study_files
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('study-html', 'study-html', false, 10485760, array['text/html'])
on conflict (id) do nothing;

create policy "users own stored html" on storage.objects
  for all using (bucket_id = 'study-html' and auth.uid()::text = (storage.foldername(name))[1])
  with check (bucket_id = 'study-html' and auth.uid()::text = (storage.foldername(name))[1]);
