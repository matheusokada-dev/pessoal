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
    { id: 'all', name: 'Todos os arquivos', color: '#407d63' },
    { id: 'frontend', name: 'Frontend', color: '#e9914d' },
    { id: 'backend', name: 'Backend', color: '#6c83cb' },
    { id: 'projects', name: 'Projetos', color: '#bb6f91' }
  ]);

  constructor() {
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    const { data } = await this.supabase.auth.getSession();
    this.session.set(data.session);
    if (data.session) await this.refresh();
    this.loading.set(false);
    this.supabase.auth.onAuthStateChange((_event, session) => {
      this.session.set(session);
      if (session) void this.refresh();
      else this.files.set([]);
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

  addFolder(name: string): string {
    const id = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || crypto.randomUUID();
    const colors = ['#407d63', '#e9914d', '#6c83cb', '#bb6f91'];
    this.folders.update(items => [...items, { id, name, color: colors[items.length % colors.length] }]);
    return id;
  }

  storageUsed(): number {
    return this.files().reduce((total, file) => total + file.size, 0);
  }
}
