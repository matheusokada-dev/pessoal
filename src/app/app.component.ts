import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { LibraryService } from './library.service';
import { StudyFile } from './models';

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
  pendingFile: File | null = null;
  uploadFolder = 'frontend';

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

  selectFile(file: StudyFile): void {
    this.selectedFile.set(file);
    const blob = new Blob([file.content], { type: 'text/html;charset=utf-8' });
    this.previewUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(URL.createObjectURL(blob)));
  }

  closePreview(): void {
    this.selectedFile.set(null);
    this.previewUrl.set(null);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    const file = event.dataTransfer?.files.item(0);
    if (file) this.setPending(file);
  }

  onFileInput(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.item(0);
    if (file) this.setPending(file);
  }

  private setPending(file: File): void {
    if (!file.name.toLowerCase().endsWith('.html') && file.type !== 'text/html') {
      this.showToast('Escolha um arquivo HTML válido.');
      return;
    }
    this.pendingFile = file;
  }

  async saveUpload(): Promise<void> {
    if (!this.pendingFile) return;
    const content = await this.pendingFile.text();
    this.library.addFile({
      id: crypto.randomUUID(),
      name: this.pendingFile.name,
      folderId: this.uploadFolder,
      size: this.pendingFile.size,
      updatedAt: new Date().toISOString(),
      favorite: false,
      content
    });
    this.uploadOpen.set(false);
    this.pendingFile = null;
    this.showToast('Arquivo adicionado à sua biblioteca.');
  }

  toggleFavorite(file: StudyFile, event: Event): void {
    event.stopPropagation();
    this.library.toggleFavorite(file.id);
  }

  deleteFile(file: StudyFile): void {
    if (confirm(`Excluir "${file.name}"?`)) {
      this.library.deleteFile(file.id);
      this.closePreview();
      this.showToast('Arquivo excluído.');
    }
  }

  renameFile(file: StudyFile): void {
    const name = prompt('Novo nome do arquivo:', file.name);
    if (name?.trim()) {
      this.library.renameFile(file.id, name.trim().endsWith('.html') ? name.trim() : `${name.trim()}.html`);
      this.selectedFile.set(this.library.files().find(item => item.id === file.id) ?? null);
    }
  }

  createFolder(): void {
    const name = prompt('Nome da nova pasta:');
    if (name?.trim()) {
      const id = this.library.addFolder(name.trim());
      this.chooseFolder(id);
    }
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

  private showToast(message: string): void {
    this.toast.set(message);
    setTimeout(() => this.toast.set(''), 2600);
  }
}
