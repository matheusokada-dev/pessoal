import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { LibraryService } from './core/services/library.service';
import { StudyFile, StudyFolder } from './core/models/library.models';
import { emailToUsername } from './core/auth-identity';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent {
  readonly library = inject(LibraryService);
  private readonly sanitizer = inject(DomSanitizer);

  readonly selectedFolder = signal('all');
  readonly selectedFile = signal<StudyFile | null>(null);
  readonly search = signal('');
  readonly sort = signal<'recent' | 'name'>('recent');
  readonly uploadOpen = signal(false);
  readonly menuOpen = signal(false);
  readonly toast = signal('');
  readonly previewUrl = signal<SafeResourceUrl | null>(null);
  readonly draggedFileId = signal<string | null>(null);
  readonly dragOverFolder = signal<string | null>(null);
  readonly externalDrag = signal(false);
  readonly folderModalOpen = signal(false);
  readonly editingFolder = signal<StudyFolder | null>(null);
  readonly folderSaving = signal(false);
  readonly folderDeleteConfirm = signal(false);
  readonly selectedFileIds = signal<string[]>([]);
  readonly folderColors = ['#407d63', '#e9914d', '#6c83cb', '#bb6f91', '#8b6fc0', '#c65f55', '#4b9ca6', '#7d8b48'];
  readonly authBusy = signal(false);
  readonly authError = signal('');
  pendingFiles: File[] = [];
  uploadFolder = 'frontend';
  folderFormName = '';
  folderFormColor = '#407d63';
  folderFormParentId: string | null = null;
  username = '';
  password = '';

  readonly visibleFiles = computed(() => {
    const query = this.search().trim().toLowerCase();
    const folder = this.selectedFolder();
    return this.library.files()
      .filter(file => (folder === 'all' || (folder === 'favorites' ? file.favorite : file.folderId === folder)) && file.name.toLowerCase().includes(query))
      .sort((a, b) => this.sort() === 'name'
        ? a.name.localeCompare(b.name)
        : new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  });

  readonly sectionTitle = computed(() =>
    this.library.folders().find(folder => folder.id === this.selectedFolder())?.name ?? 'Biblioteca'
  );

  chooseFolder(id: string): void {
    this.selectedFolder.set(id);
    this.menuOpen.set(false);
  }

  async selectFile(file: StudyFile): Promise<void> {
    try {
      const signedUrl = await this.library.getPreviewUrl(file);
      this.selectedFile.set(file);
      this.previewUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(signedUrl));
    } catch {
      this.showToast('Não foi possível abrir o arquivo.');
    }
  }

  closePreview(): void {
    this.selectedFile.set(null);
    this.previewUrl.set(null);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.externalDrag.set(false);
    this.setPendingFiles(Array.from(event.dataTransfer?.files ?? []));
  }

  onLibraryDragOver(event: DragEvent): void {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
      this.externalDrag.set(true);
    }
  }

  onLibraryDrop(event: DragEvent): void {
    event.preventDefault();
    this.externalDrag.set(false);
    this.setPendingFiles(Array.from(event.dataTransfer?.files ?? []));
    if (this.pendingFiles.length) this.uploadOpen.set(true);
  }

  startFileDrag(file: StudyFile, event: DragEvent): void {
    this.draggedFileId.set(file.id);
    const ids = this.selectedFileIds().includes(file.id) ? this.selectedFileIds() : [file.id];
    this.selectedFileIds.set(ids);
    event.dataTransfer?.setData('text/study-vault-files', JSON.stringify(ids));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  endFileDrag(): void {
    this.draggedFileId.set(null);
    this.dragOverFolder.set(null);
  }

  allowFolderDrop(folderId: string, event: DragEvent): void {
    event.preventDefault();
    this.dragOverFolder.set(folderId);
    if (event.dataTransfer) event.dataTransfer.dropEffect = event.dataTransfer.types.includes('Files') ? 'copy' : 'move';
  }

  async dropOnFolder(folderId: string, event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.dragOverFolder.set(null);
    const externalFiles = Array.from(event.dataTransfer?.files ?? []);
    if (externalFiles.length) {
      this.uploadFolder = folderId;
      this.setPendingFiles(externalFiles);
      if (this.pendingFiles.length) this.uploadOpen.set(true);
      return;
    }
    let ids: string[] = [];
    try { ids = JSON.parse(event.dataTransfer?.getData('text/study-vault-files') || '[]') as string[]; } catch {}
    if (!ids.length && this.draggedFileId()) ids = [this.draggedFileId()!];
    if (!ids.length) return;
    try {
      await this.library.moveFiles(ids, folderId);
      this.selectedFileIds.set([]);
      this.showToast(`${ids.length} arquivo(s) movido(s) para ${this.folderName(folderId)}.`);
    } catch {
      this.showToast('Não foi possível mover o arquivo.');
    } finally {
      this.endFileDrag();
    }
  }

  onFileInput(event: Event): void {
    this.setPendingFiles(Array.from((event.target as HTMLInputElement).files ?? []));
  }

  private setPendingFiles(files: File[]): void {
    const valid = files.filter(file => file.name.toLowerCase().endsWith('.html') || file.type === 'text/html');
    if (!valid.length) {
      this.showToast('Escolha um arquivo HTML válido.');
      return;
    }
    this.pendingFiles = valid;
  }

  async saveUpload(): Promise<void> {
    if (!this.pendingFiles.length) return;
    const files = [...this.pendingFiles];
    try {
      for (const file of files) await this.library.addFile(file, this.uploadFolder);
      this.uploadOpen.set(false);
      this.pendingFiles = [];
      this.showToast(`${files.length} arquivo(s) sincronizado(s).`);
    } catch (error) {
      this.showToast(error instanceof Error ? error.message : 'Falha no upload.');
    }
  }

  toggleFavorite(file: StudyFile, event: Event): void {
    event.stopPropagation();
    void this.library.toggleFavorite(file.id);
  }

  selectCard(file: StudyFile, event: MouseEvent): void {
    const current = this.selectedFileIds();
    this.selectedFileIds.set(event.ctrlKey || event.metaKey
      ? (current.includes(file.id) ? current.filter(id => id !== file.id) : [...current, file.id])
      : (current.length === 1 && current[0] === file.id ? [] : [file.id]));
  }

  deleteFile(file: StudyFile): void {
    if (confirm(`Excluir "${file.name}"?`)) {
      void this.library.deleteFile(file.id);
      this.closePreview();
      this.showToast('Arquivo excluído.');
    }
  }

  renameFile(file: StudyFile): void {
    const name = prompt('Novo nome do arquivo:', file.name);
    if (name?.trim()) {
      void this.library.renameFile(file.id, name.trim().endsWith('.html') ? name.trim() : `${name.trim()}.html`);
      this.closePreview();
    }
  }

  async moveSelectedFile(file: StudyFile): Promise<void> {
    const folders = this.library.folders().slice(1);
    const options = folders.map((folder, index) => `${index + 1}. ${folder.name}`).join('\n');
    const answer = prompt(`Mover para qual pasta?\n\n${options}`, '1');
    if (!answer) return;
    const selected = folders[Number(answer) - 1]
      ?? folders.find(folder => folder.name.toLowerCase() === answer.trim().toLowerCase());
    if (!selected) {
      this.showToast('Pasta inválida.');
      return;
    }
    try {
      await this.library.moveFile(file.id, selected.id);
      this.selectedFile.set({ ...file, folderId: selected.id });
      this.showToast(`Arquivo movido para ${selected.name}.`);
    } catch {
      this.showToast('Não foi possível mover o arquivo.');
    }
  }

  openFolderModal(parentId: string | null = null, folder: StudyFolder | null = null, event?: Event): void {
    event?.stopPropagation();
    this.editingFolder.set(folder);
    this.folderFormName = folder?.name ?? '';
    this.folderFormColor = folder?.color ?? this.folderColors[this.library.folders().length % this.folderColors.length];
    this.folderFormParentId = folder?.parentId ?? parentId;
    this.folderDeleteConfirm.set(false);
    this.folderModalOpen.set(true);
  }

  async deleteEditingFolder(): Promise<void> {
    const folder = this.editingFolder();
    if (!folder) return;
    this.folderSaving.set(true);
    try {
      await this.library.deleteFolder(folder.id, folder.parentId);
      if (this.selectedFolder() === folder.id) this.chooseFolder(folder.parentId ?? 'all');
      this.folderModalOpen.set(false);
      this.showToast('Pasta excluída. Os arquivos foram preservados.');
    } catch {
      this.showToast('Não foi possível excluir a pasta.');
    } finally {
      this.folderSaving.set(false);
      this.folderDeleteConfirm.set(false);
    }
  }

  async saveFolder(): Promise<void> {
    const name = this.folderFormName.trim();
    if (!name) return;
    this.folderSaving.set(true);
    try {
      const editing = this.editingFolder();
      if (editing) {
        await this.library.updateFolder(editing.id, name, this.folderFormColor, this.folderFormParentId);
        this.showToast('Pasta atualizada.');
      } else {
        const id = await this.library.addFolder(name, this.folderFormParentId);
        this.chooseFolder(id);
        this.showToast(this.folderFormParentId ? 'Subpasta criada.' : 'Pasta criada.');
      }
      this.folderModalOpen.set(false);
    } catch {
      this.showToast('Não foi possível salvar a pasta.');
    } finally {
      this.folderSaving.set(false);
    }
  }

  availableParentFolders(): StudyFolder[] {
    const editingId = this.editingFolder()?.id;
    return this.orderedFolders().filter(folder => folder.id !== editingId && !this.isDescendant(folder.id, editingId));
  }

  private isDescendant(folderId: string, ancestorId?: string): boolean {
    if (!ancestorId) return false;
    let current = this.library.folders().find(folder => folder.id === folderId);
    while (current?.parentId) {
      if (current.parentId === ancestorId) return true;
      current = this.library.folders().find(folder => folder.id === current?.parentId);
    }
    return false;
  }

  orderedFolders(): StudyFolder[] {
    const folders = this.library.folders().slice(1);
    const ordered: StudyFolder[] = [];
    const append = (parentId: string | null): void => {
      for (const folder of folders.filter(item => item.parentId === parentId)) {
        ordered.push(folder);
        append(folder.id);
      }
    };
    append(null);
    return ordered;
  }

  folderDepth(folderId: string): number {
    let depth = 0;
    let current = this.library.folders().find(folder => folder.id === folderId);
    while (current?.parentId && depth < 5) {
      depth++;
      current = this.library.folders().find(folder => folder.id === current?.parentId);
    }
    return depth;
  }

  folderName(id: string): string {
    return this.library.folders().find(folder => folder.id === id)?.name ?? 'Sem pasta';
  }

  folderColor(id: string): string {
    return this.library.folders().find(folder => folder.id === id)?.color ?? '#94a09a';
  }

  fileCount(folderId: string): number {
    return folderId === 'all'
      ? this.library.files().length
      : this.library.files().filter(file => file.folderId === folderId).length;
  }

  formatSize(bytes: number): string {
    return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  pendingTotalSize(): number {
    return this.pendingFiles.reduce((sum, file) => sum + file.size, 0);
  }

  private showToast(message: string): void {
    this.toast.set(message);
    setTimeout(() => this.toast.set(''), 2600);
  }

  async authenticate(): Promise<void> {
    this.authError.set('');
    if (!this.username || !this.password) {
      this.authError.set('Informe seu usuário e senha.');
      return;
    }
    this.authBusy.set(true);
    const error = await this.library.signIn(this.username, this.password);
    this.authBusy.set(false);
    if (error) this.authError.set('Usuário ou senha inválidos.');
  }

  currentUsername(): string {
    return emailToUsername(this.library.session()?.user.email);
  }
}
