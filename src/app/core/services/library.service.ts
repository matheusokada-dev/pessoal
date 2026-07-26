import { Injectable, signal } from '@angular/core';
import { createClient, Session, SupabaseClient } from '@supabase/supabase-js';
import { StudyFile, StudyFolder } from '../models/library.models';
import { environment } from '../../../environments/environment';
import { usernameToEmail } from '../auth-identity';

@Injectable({ providedIn: 'root' })
export class LibraryService {
  private readonly supabase: SupabaseClient = createClient(
    environment.supabase.url,
    environment.supabase.publishableKey
  );
  readonly session = signal<Session | null>(null);
  readonly loading = signal(true);
  readonly files = signal<StudyFile[]>([]);
  readonly folders = signal<StudyFolder[]>([
    { id: 'all', name: 'Todos os arquivos', color: '#407d63', parentId: null }
  ]);

  constructor() {
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    const { data } = await this.supabase.auth.getSession();
    this.session.set(data.session);
    if (data.session) await this.refreshAll();
    this.loading.set(false);
    this.supabase.auth.onAuthStateChange((_event, session) => {
      this.session.set(session);
      if (session) void this.refreshAll();
      else {
        this.files.set([]);
        this.folders.set([{ id: 'all', name: 'Todos os arquivos', color: '#407d63', parentId: null }]);
      }
    });
  }

  async signIn(username: string, password: string): Promise<string | null> {
    const email = username.includes('@') ? username : usernameToEmail(username);
    const { error } = await this.supabase.auth.signInWithPassword({ email, password });
    return error?.message ?? null;
  }

  async signOut(): Promise<void> {
    await this.supabase.auth.signOut();
  }

  async refresh(): Promise<void> {
    const { data, error } = await this.supabase
      .from('study_files')
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    this.files.set((data ?? []).map(row => ({
      id: row.id as string,
      name: row.name as string,
      folderId: row.folder as string,
      size: Number(row.size_bytes),
      updatedAt: row.updated_at as string,
      favorite: row.favorite as boolean,
      storagePath: row.storage_path as string
    })));
  }

  async refreshFolders(): Promise<void> {
    const { data, error } = await this.supabase.from('library_folders')
      .select('*').order('created_at', { ascending: true });
    if (error) throw error;
    if (!data?.length) {
      const existingIds = [...new Set(this.files().map(file => file.folderId).filter(Boolean))];
      const user = this.session()?.user;
      if (user && existingIds.length) {
        const colors = ['#407d63', '#e9914d', '#6c83cb', '#bb6f91'];
        const { error: seedError } = await this.supabase.from('library_folders').insert(
          existingIds.map((id, index) => ({
            id, user_id: user.id,
            name: id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' '),
            color: colors[index % colors.length], parent_id: null
          }))
        );
        if (seedError) throw seedError;
        return this.refreshFolders();
      }
    }
    this.folders.set([
      { id: 'all', name: 'Todos os arquivos', color: '#407d63', parentId: null },
      ...(data ?? []).map(row => ({
        id: row.id as string,
        name: row.name as string,
        color: row.color as string,
        parentId: (row.parent_id as string | null) ?? null
      }))
    ]);
  }

  async refreshAll(): Promise<void> {
    await Promise.all([this.refresh(), this.refreshFolders()]);
  }

  async addFile(file: File, folderId: string): Promise<void> {
    const user = this.session()?.user;
    if (!user) throw new Error('Sessão expirada.');
    const id = crypto.randomUUID();
    const path = `${user.id}/${id}.html`;
    const { error: uploadError } = await this.supabase.storage
      .from('study-html')
      .upload(path, file, { contentType: 'text/html', upsert: false });
    if (uploadError) throw uploadError;
    const { error } = await this.supabase.from('study_files').insert({
      id, user_id: user.id, name: file.name, folder: folderId,
      storage_path: path, size_bytes: file.size, favorite: false
    });
    if (error) {
      await this.supabase.storage.from('study-html').remove([path]);
      throw error;
    }
    await this.refresh();
  }

  async getContent(file: StudyFile): Promise<string> {
    if (file.content) return file.content;
    if (!file.storagePath) throw new Error('Arquivo indisponível.');
    const { data, error } = await this.supabase.storage.from('study-html').download(file.storagePath);
    if (error) throw error;
    return data.text();
  }

  async toggleFavorite(id: string): Promise<void> {
    const file = this.files().find(item => item.id === id);
    if (!file) return;
    const { error } = await this.supabase.from('study_files').update({
      favorite: !file.favorite, updated_at: new Date().toISOString()
    }).eq('id', id);
    if (error) throw error;
    await this.refresh();
  }

  async deleteFile(id: string): Promise<void> {
    const file = this.files().find(item => item.id === id);
    if (!file) return;
    const { error } = await this.supabase.from('study_files').delete().eq('id', id);
    if (error) throw error;
    if (file.storagePath) await this.supabase.storage.from('study-html').remove([file.storagePath]);
    await this.refresh();
  }

  async renameFile(id: string, name: string): Promise<void> {
    const { error } = await this.supabase.from('study_files')
      .update({ name, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    await this.refresh();
  }

  async moveFile(id: string, folder: string): Promise<void> {
    const { error } = await this.supabase.from('study_files')
      .update({ folder, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    await this.refresh();
  }

  async addFolder(name: string, parentId: string | null = null): Promise<string> {
    const user = this.session()?.user;
    if (!user) throw new Error('Sessão expirada.');
    const id = crypto.randomUUID();
    const colors = ['#407d63', '#e9914d', '#6c83cb', '#bb6f91'];
    const color = colors[this.folders().length % colors.length];
    const { error } = await this.supabase.from('library_folders').insert({
      id, user_id: user.id, name, color, parent_id: parentId
    });
    if (error) throw error;
    await this.refreshFolders();
    return id;
  }

  async updateFolder(id: string, name: string, color: string, parentId: string | null): Promise<void> {
    const { error } = await this.supabase.from('library_folders')
      .update({ name, color, parent_id: parentId }).eq('id', id);
    if (error) throw error;
    await this.refreshFolders();
  }

  async deleteFolder(id: string, parentId: string | null): Promise<void> {
    const destination = parentId ?? '';
    const { error: filesError } = await this.supabase.from('study_files')
      .update({ folder: destination, updated_at: new Date().toISOString() }).eq('folder', id);
    if (filesError) throw filesError;
    const { error: childrenError } = await this.supabase.from('library_folders')
      .update({ parent_id: parentId }).eq('parent_id', id);
    if (childrenError) throw childrenError;
    const { error } = await this.supabase.from('library_folders').delete().eq('id', id);
    if (error) throw error;
    await this.refreshAll();
  }

  storageUsed(): number {
    return this.files().reduce((total, file) => total + file.size, 0);
  }
}
