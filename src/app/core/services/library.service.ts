import { Injectable, signal } from '@angular/core';
import { createClient, Session, SupabaseClient } from '@supabase/supabase-js';
import { StudyFile, StudyFolder } from '../models/library.models';
import { environment } from '../../../environments/environment';
import { usernameToEmail } from '../auth-identity';

const MAX_CACHED_DOCUMENTS = 8;
const MAX_CACHED_CHARACTERS = 12 * 1024 * 1024;
const MAX_PREFETCH_BYTES = 2 * 1024 * 1024;
const MAX_PREFETCH_CONCURRENCY = 2;

@Injectable({ providedIn: 'root' })
export class LibraryService {
  private readonly supabase: SupabaseClient = createClient(
    environment.supabase.url,
    environment.supabase.publishableKey
  );
  private readonly contentCache = new Map<string, string>();
  private readonly contentRequests = new Map<string, Promise<string>>();
  private readonly prefetchQueue: StudyFile[] = [];
  private prefetchActive = 0;
  private authEpoch = 0;
  readonly session = signal<Session | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly files = signal<StudyFile[]>([]);
  readonly folders = signal<StudyFolder[]>([
    { id: 'all', name: 'Todos os arquivos', color: '#407d63', parentId: null }
  ]);

  constructor() {
    this.supabase.auth.onAuthStateChange((_event, session) => this.applySession(session));
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      const { data, error } = await this.withTimeout(this.supabase.auth.getSession(), 8000);
      if (error) throw error;
      this.applySession(data.session);
    } catch {
      this.error.set('Não foi possível sincronizar sua biblioteca. Verifique a conexão e tente novamente.');
    } finally {
      this.loading.set(false);
    }
  }

  async signIn(username: string, password: string): Promise<string | null> {
    const email = username.includes('@') ? username : usernameToEmail(username);
    const { error } = await this.supabase.auth.signInWithPassword({ email, password });
    return error?.message ?? null;
  }

  async signOut(): Promise<void> {
    const { error } = await this.supabase.auth.signOut();
    if (error) throw error;
  }

  async refresh(): Promise<void> {
    const context = this.captureAuthContext();
    const { data, error } = await this.supabase
      .from('study_files')
      .select('id,name,folder,size_bytes,updated_at,favorite,storage_path')
      .order('updated_at', { ascending: false });
    if (!this.isAuthContextCurrent(context)) return;
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
    const context = this.captureAuthContext();
    const { data, error } = await this.supabase.from('library_folders')
      .select('id,name,color,parent_id,created_at').order('created_at', { ascending: true });
    if (!this.isAuthContextCurrent(context)) return;
    if (error) throw error;
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
    const context = this.captureAuthContext();
    this.error.set('');
    try {
      await Promise.all([this.refresh(), this.refreshFolders()]);
    } catch (error) {
      if (this.isAuthContextCurrent(context)) {
        this.error.set('A sincronização foi interrompida. Seus arquivos continuam seguros na nuvem.');
      }
      throw error;
    }
  }

  async addFiles(files: File[], folderId: string): Promise<{ uploaded: number; failed: File[] }> {
    const normalizedFolder = this.normalizeFolderId(folderId);
    let uploaded = 0;
    const failed: File[] = [];
    const uploadedFiles: StudyFile[] = [];

    for (const file of files) {
      try {
        uploadedFiles.push(await this.uploadFile(file, normalizedFolder));
        uploaded++;
      } catch {
        failed.push(file);
      }
    }

    if (uploadedFiles.length) {
      const uploadedIds = new Set(uploadedFiles.map(file => file.id));
      this.files.update(current => [
        ...uploadedFiles,
        ...current.filter(file => !uploadedIds.has(file.id))
      ].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()));
      try {
        await this.refresh();
      } catch {
        this.error.set('Os arquivos foram enviados, mas a atualização completa da biblioteca ficou pendente.');
      }
    }
    return { uploaded, failed };
  }

  private async uploadFile(file: File, folderId: string): Promise<StudyFile> {
    const user = this.session()?.user;
    if (!user) throw new Error('Sessão expirada.');
    const context = this.captureAuthContext();
    const id = crypto.randomUUID();
    const path = `${user.id}/${id}.html`;
    const { error: uploadError } = await this.supabase.storage
      .from('study-html')
      .upload(path, file, { contentType: 'text/html', upsert: false });
    if (uploadError) throw uploadError;
    const { data, error } = await this.supabase.from('study_files').insert({
      id, user_id: user.id, name: file.name, folder: folderId,
      storage_path: path, size_bytes: file.size, favorite: false
    }).select('id,name,folder,size_bytes,updated_at,favorite,storage_path').single();
    if (error) {
      await this.supabase.storage.from('study-html').remove([path]);
      throw error;
    }
    if (!this.isAuthContextCurrent(context)) throw new Error('A conta ativa mudou durante o upload.');
    return {
      id: data.id as string,
      name: data.name as string,
      folderId: data.folder as string,
      size: Number(data.size_bytes),
      updatedAt: data.updated_at as string,
      favorite: data.favorite as boolean,
      storagePath: data.storage_path as string
    };
  }

  async getContent(file: StudyFile): Promise<string> {
    const context = this.captureAuthContext();
    if (file.content) return file.content;
    const cached = this.contentCache.get(file.id);
    if (cached !== undefined) {
      this.contentCache.delete(file.id);
      this.contentCache.set(file.id, cached);
      return cached;
    }
    const pending = this.contentRequests.get(file.id);
    if (pending) return pending;
    if (!file.storagePath) throw new Error('Arquivo indisponível.');

    const request = (async () => {
      const { data, error } = await this.supabase.storage.from('study-html').download(file.storagePath!);
      if (error) throw error;
      const content = await data.text();
      if (!this.isAuthContextCurrent(context)) throw new Error('A conta ativa mudou durante a leitura.');
      this.cacheDocument(file.id, content);
      return content;
    })();

    this.contentRequests.set(file.id, request);
    try {
      return await request;
    } finally {
      if (this.contentRequests.get(file.id) === request) this.contentRequests.delete(file.id);
    }
  }

  prefetchContent(file: StudyFile): void {
    if (file.size > MAX_PREFETCH_BYTES || this.contentCache.has(file.id) || this.contentRequests.has(file.id)) return;
    if (this.prefetchQueue.some(queued => queued.id === file.id)) return;
    this.prefetchQueue.push(file);
    this.drainPrefetchQueue();
  }

  async toggleFavorite(id: string): Promise<void> {
    const context = this.captureAuthContext();
    const file = this.files().find(item => item.id === id);
    if (!file) return;
    const updatedAt = new Date().toISOString();
    const { data, error } = await this.supabase.from('study_files').update({
      favorite: !file.favorite, updated_at: updatedAt
    }).eq('id', id).select('id').maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Arquivo não encontrado.');
    this.assertAuthContextCurrent(context);
    this.files.update(files => files.map(item => item.id === id
      ? { ...item, favorite: !item.favorite, updatedAt }
      : item));
  }

  async deleteFile(id: string): Promise<void> {
    const context = this.captureAuthContext();
    const file = this.files().find(item => item.id === id);
    if (!file) return;
    const { data, error } = await this.supabase.from('study_files').delete().eq('id', id).select('id').maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Arquivo não encontrado.');
    if (file.storagePath) {
      const { error: storageError } = await this.supabase.storage.from('study-html').remove([file.storagePath]);
      if (storageError) console.warn('O registro foi removido, mas o arquivo precisa de reconciliação no Storage.');
    }
    this.assertAuthContextCurrent(context);
    this.contentCache.delete(id);
    this.files.update(files => files.filter(item => item.id !== id));
  }

  async renameFile(id: string, name: string): Promise<void> {
    const context = this.captureAuthContext();
    const updatedAt = new Date().toISOString();
    const { data, error } = await this.supabase.from('study_files')
      .update({ name, updated_at: updatedAt }).eq('id', id).select('id').maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Arquivo não encontrado.');
    this.assertAuthContextCurrent(context);
    this.files.update(files => files.map(item => item.id === id ? { ...item, name, updatedAt } : item));
  }

  async moveFile(id: string, folder: string): Promise<void> {
    const context = this.captureAuthContext();
    const destination = this.normalizeFolderId(folder);
    const updatedAt = new Date().toISOString();
    const { data, error } = await this.supabase.from('study_files')
      .update({ folder: destination, updated_at: updatedAt }).eq('id', id).select('id').maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Arquivo não encontrado.');
    this.assertAuthContextCurrent(context);
    this.files.update(files => files.map(item => item.id === id
      ? { ...item, folderId: destination, updatedAt }
      : item));
  }

  async moveFiles(ids: string[], folder: string): Promise<void> {
    if (!ids.length) return;
    const context = this.captureAuthContext();
    const destination = this.normalizeFolderId(folder);
    const updatedAt = new Date().toISOString();
    const { data, error } = await this.supabase.from('study_files')
      .update({ folder: destination, updated_at: updatedAt }).in('id', ids).select('id');
    if (error) throw error;
    if ((data ?? []).length !== ids.length) throw new Error('Nem todos os arquivos puderam ser movidos.');
    this.assertAuthContextCurrent(context);
    const selected = new Set(ids);
    this.files.update(files => files.map(item => selected.has(item.id)
      ? { ...item, folderId: destination, updatedAt }
      : item));
  }

  async addFolder(name: string, parentId: string | null = null, color = '#407d63'): Promise<string> {
    const user = this.session()?.user;
    if (!user) throw new Error('Sessão expirada.');
    const context = this.captureAuthContext();
    this.assertValidParent(null, parentId);
    const id = crypto.randomUUID();
    const { error } = await this.supabase.from('library_folders').insert({
      id, user_id: user.id, name, color, parent_id: parentId
    });
    if (error) throw error;
    this.assertAuthContextCurrent(context);
    await this.refreshFolders();
    return id;
  }

  async updateFolder(id: string, name: string, color: string, parentId: string | null): Promise<void> {
    const context = this.captureAuthContext();
    this.assertValidParent(id, parentId);
    const { data, error } = await this.supabase.from('library_folders')
      .update({ name, color, parent_id: parentId }).eq('id', id).select('id').maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Pasta não encontrada.');
    this.assertAuthContextCurrent(context);
    await this.refreshFolders();
  }

  async deleteFolder(id: string, parentId: string | null): Promise<void> {
    const context = this.captureAuthContext();
    const { error } = await this.supabase.rpc('delete_library_folder', {
      target_id: id,
      fallback_parent_id: parentId
    });
    if (error?.code === 'PGRST202') {
      await this.deleteFolderLegacy(id, parentId);
    } else if (error) {
      throw error;
    }
    this.assertAuthContextCurrent(context);
    await this.refreshAll();
  }

  storageUsed(): number {
    return this.files().reduce((total, file) => total + file.size, 0);
  }

  private normalizeFolderId(folderId: string): string {
    if (!folderId || folderId === 'all' || folderId === 'favorites' || folderId === 'unfiled') return '';
    return this.folders().some(folder => folder.id === folderId) ? folderId : '';
  }

  private cacheDocument(id: string, content: string): void {
    this.contentCache.delete(id);
    this.contentCache.set(id, content);
    while (this.contentCache.size > MAX_CACHED_DOCUMENTS || this.cachedCharacterCount() > MAX_CACHED_CHARACTERS) {
      const oldest = this.contentCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.contentCache.delete(oldest);
    }
  }

  private clearDocumentCache(): void {
    this.contentCache.clear();
    this.contentRequests.clear();
    this.prefetchQueue.length = 0;
  }

  private drainPrefetchQueue(): void {
    while (this.prefetchActive < MAX_PREFETCH_CONCURRENCY && this.prefetchQueue.length) {
      const file = this.prefetchQueue.shift()!;
      if (this.contentCache.has(file.id) || this.contentRequests.has(file.id)) continue;
      this.prefetchActive++;
      void this.getContent(file)
        .catch(() => undefined)
        .finally(() => {
          this.prefetchActive = Math.max(0, this.prefetchActive - 1);
          this.drainPrefetchQueue();
        });
    }
  }

  private cachedCharacterCount(): number {
    let total = 0;
    for (const content of this.contentCache.values()) total += content.length;
    return total;
  }

  private captureAuthContext(): { epoch: number; userId: string | null } {
    return { epoch: this.authEpoch, userId: this.session()?.user.id ?? null };
  }

  private isAuthContextCurrent(context: { epoch: number; userId: string | null }): boolean {
    return context.epoch === this.authEpoch && context.userId === (this.session()?.user.id ?? null);
  }

  private assertAuthContextCurrent(context: { epoch: number; userId: string | null }): void {
    if (!this.isAuthContextCurrent(context)) throw new Error('A conta ativa mudou durante a operação.');
  }

  private assertValidParent(folderId: string | null, parentId: string | null): void {
    if (!parentId) return;
    const folders = new Map(this.folders().filter(folder => folder.id !== 'all').map(folder => [folder.id, folder]));
    if (!folders.has(parentId)) throw new Error('A pasta de destino não existe.');
    if (folderId && parentId === folderId) throw new Error('Uma pasta não pode ficar dentro dela mesma.');

    const visited = new Set<string>();
    let currentId: string | null = parentId;
    while (currentId) {
      if (currentId === folderId) throw new Error('Esta alteração criaria um ciclo de pastas.');
      if (visited.has(currentId)) throw new Error('A hierarquia de pastas contém um ciclo.');
      visited.add(currentId);
      currentId = folders.get(currentId)?.parentId ?? null;
    }
  }

  private async deleteFolderLegacy(id: string, parentId: string | null): Promise<void> {
    const destination = parentId ?? '';
    const { error: filesError } = await this.supabase.from('study_files')
      .update({ folder: destination, updated_at: new Date().toISOString() }).eq('folder', id);
    if (filesError) throw filesError;
    const { error: childrenError } = await this.supabase.from('library_folders')
      .update({ parent_id: parentId }).eq('parent_id', id);
    if (childrenError) throw childrenError;
    const { error } = await this.supabase.from('library_folders').delete().eq('id', id);
    if (error) throw error;
  }

  private applySession(session: Session | null): void {
    const previousUserId = this.session()?.user.id ?? null;
    const nextUserId = session?.user.id ?? null;
    this.session.set(session);
    if (previousUserId === nextUserId) return;

    this.authEpoch++;
    this.clearDocumentCache();
    if (session) {
      void this.refreshAll().catch(() => undefined);
    } else {
      this.files.set([]);
      this.folders.set([{ id: 'all', name: 'Todos os arquivos', color: '#407d63', parentId: null }]);
      this.error.set('');
    }
  }

  private withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tempo de conexão esgotado.')), milliseconds);
      promise.then(
        value => {
          clearTimeout(timer);
          resolve(value);
        },
        error => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }
}
