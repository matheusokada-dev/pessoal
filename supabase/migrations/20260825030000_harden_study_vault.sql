alter table public.study_files alter column folder set default '';

create index if not exists study_files_user_updated_idx
  on public.study_files (user_id, updated_at desc);
create index if not exists library_folders_user_parent_idx
  on public.library_folders (user_id, parent_id);

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'library_folders_id_not_reserved'
      and conrelid = 'public.library_folders'::regclass
  ) then
    alter table public.library_folders
      add constraint library_folders_id_not_reserved
      check (id <> all (array['all', 'favorites', 'unfiled']));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'library_folders_not_self_parent'
      and conrelid = 'public.library_folders'::regclass
  ) then
    alter table public.library_folders
      add constraint library_folders_not_self_parent
      check (parent_id is null or parent_id <> id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'library_folders_parent_fk'
      and conrelid = 'public.library_folders'::regclass
  ) then
    alter table public.library_folders
      add constraint library_folders_parent_fk
      foreign key (user_id, parent_id)
      references public.library_folders (user_id, id);
  end if;
end;
$migration$;

create or replace function public.validate_library_folder_hierarchy()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  current_id text;
  visited text[] := array[]::text[];
begin
  if new.id = any (array['all', 'favorites', 'unfiled']) then
    raise exception 'reserved folder id';
  end if;
  if new.parent_id is null then return new; end if;
  if new.parent_id = new.id then raise exception 'folder cannot contain itself'; end if;

  current_id := new.parent_id;
  while current_id is not null loop
    if current_id = new.id then raise exception 'folder hierarchy cycle'; end if;
    if current_id = any (visited) then raise exception 'existing folder hierarchy cycle'; end if;
    visited := array_append(visited, current_id);

    select folder.parent_id into current_id
    from public.library_folders as folder
    where folder.user_id = new.user_id and folder.id = current_id;
    if not found then raise exception 'parent folder does not exist'; end if;
  end loop;
  return new;
end;
$function$;

drop trigger if exists validate_library_folder_hierarchy on public.library_folders;
create trigger validate_library_folder_hierarchy
  before insert or update of id, user_id, parent_id on public.library_folders
  for each row execute function public.validate_library_folder_hierarchy();

drop policy if exists "users own folders" on public.library_folders;
create policy "users own folders" on public.library_folders
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "users own files" on public.study_files;
create policy "users own files" on public.study_files
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on table public.library_folders from anon;
revoke all on table public.study_files from anon;
grant select, insert, update, delete on table public.library_folders to authenticated;
grant select, insert, update, delete on table public.study_files to authenticated;

drop policy if exists "users own stored html" on storage.objects;
create policy "users own stored html" on storage.objects
  for all
  to authenticated
  using (
    bucket_id = 'study-html'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'study-html'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

create or replace function public.delete_library_folder(target_id text, fallback_parent_id text default null)
returns void
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  actor_id uuid := (select auth.uid());
  actual_parent_id text;
begin
  if actor_id is null then raise exception 'authentication required'; end if;

  select folder.parent_id into actual_parent_id
  from public.library_folders as folder
  where folder.user_id = actor_id and folder.id = target_id;
  if not found then raise exception 'folder not found'; end if;
  if actual_parent_id is distinct from fallback_parent_id then
    raise exception 'folder hierarchy changed; refresh and retry';
  end if;

  update public.study_files
    set folder = coalesce(fallback_parent_id, ''), updated_at = now()
    where user_id = actor_id and folder = target_id;
  update public.library_folders
    set parent_id = fallback_parent_id
    where user_id = actor_id and parent_id = target_id;
  delete from public.library_folders
    where user_id = actor_id and id = target_id;
end;
$function$;

revoke all on function public.delete_library_folder(text, text) from public, anon;
grant execute on function public.delete_library_folder(text, text) to authenticated;
