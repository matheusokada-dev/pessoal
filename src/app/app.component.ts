import { CommonModule } from '@angular/common';
import {
  Component,
  computed,
  effect,
  ElementRef,
  HostListener,
  inject,
  OnDestroy,
  signal,
  ViewChild
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { LibraryService } from './core/services/library.service';
import { StudyFile, StudyFolder } from './core/models/library.models';
import { emailToUsername } from './core/auth-identity';

type ViewMode = 'grid' | 'list';
type ToastTone = 'success' | 'error' | 'info';
type FileActionMode = 'move' | 'rename' | 'delete';

interface FolderTreeEntry {
  folder: StudyFolder;
  depth: number;
  ancestorIds: string[];
  directCount: number;
  totalCount: number;
  hasChildren: boolean;
}

const MAX_HTML_SIZE = 10 * 1024 * 1024;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnDestroy {
  readonly library = inject(LibraryService);
  private readonly sanitizer = inject(DomSanitizer);

  @ViewChild('librarySearch') private librarySearch?: ElementRef<HTMLInputElement>;
  @ViewChild('librarySidebar') private librarySidebar?: ElementRef<HTMLElement>;
  @ViewChild('mobileMenuButton') private mobileMenuButton?: ElementRef<HTMLButtonElement>;
  @ViewChild('sidebarCloseButton') private sidebarCloseButton?: ElementRef<HTMLButtonElement>;

  readonly selectedFolder = signal('all');
  readonly selectedFile = signal<StudyFile | null>(null);
  readonly selectedFileIds = signal<string[]>([]);
  readonly search = signal('');
  readonly folderSearch = signal('');
  readonly sort = signal<'recent' | 'name'>('recent');
  readonly viewMode = signal<ViewMode>('grid');
  readonly uploadOpen = signal(false);
  readonly uploadSaving = signal(false);
  readonly menuOpen = signal(false);
  readonly helpOpen = signal(false);
  readonly toast = signal('');
  readonly toastTone = signal<ToastTone>('success');
  readonly previewUrl = signal<SafeResourceUrl | null>(null);
  readonly draggedFileId = signal<string | null>(null);
  readonly dragOverFolder = signal<string | null>(null);
  readonly externalDrag = signal(false);
  readonly folderModalOpen = signal(false);
  readonly editingFolder = signal<StudyFolder | null>(null);
  readonly folderSaving = signal(false);
  readonly folderDeleteConfirm = signal(false);
  readonly collapsedFolderIds = signal<string[]>([]);
  readonly fileActionMode = signal<FileActionMode | null>(null);
  readonly fileActionBusy = signal(false);
  readonly mobileViewport = signal(typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches);
  readonly folderColors = ['#315f4f', '#c96d46', '#607ca8', '#a55f7a', '#7863a4', '#b45148', '#3f8790', '#718143'];
  readonly authBusy = signal(false);
  readonly authError = signal('');

  pendingFiles: File[] = [];
  uploadFolder = '';
  folderFormName = '';
  folderFormColor = '#315f4f';
  folderFormParentId: string | null = null;
  fileRenameValue = '';
  fileMoveFolder = '';
  username = '';
  password = '';

  private previewObjectUrl: string | null = null;
  private previewRequestId = 0;
  private uploadOperationId = 0;
  private folderOperationId = 0;
  private fileActionOperationId = 0;
  private authOperationId = 0;
  private modalReturnFocus: HTMLElement | null = null;
  private previewReturnFocus: HTMLElement | null = null;
  private fileActionReturnFocus: HTMLElement | null = null;
  private dragDepth = 0;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUserId: string | null | undefined = undefined;

  readonly folderTree = computed<FolderTreeEntry[]>(() => {
    const folders = this.library.folders().filter(folder => folder.id !== 'all');
    const files = this.library.files();
    const byId = new Map(folders.map(folder => [folder.id, folder]));
    const children = new Map<string | null, StudyFolder[]>();
    const directCounts = new Map<string, number>();

    for (const file of files) {
      directCounts.set(file.folderId, (directCounts.get(file.folderId) ?? 0) + 1);
    }

    for (const folder of folders) {
      const parentId = folder.parentId && folder.parentId !== folder.id && byId.has(folder.parentId)
        ? folder.parentId
        : null;
      const siblings = children.get(parentId) ?? [];
      siblings.push(folder);
      children.set(parentId, siblings);
    }

    const totalCountCache = new Map<string, number>();
    const totalCount = (id: string, trail = new Set<string>()): number => {
      const cached = totalCountCache.get(id);
      if (cached !== undefined) return cached;
      if (trail.has(id)) return directCounts.get(id) ?? 0;
      const nextTrail = new Set(trail).add(id);
      const total = (directCounts.get(id) ?? 0)
        + (children.get(id) ?? []).reduce((sum, child) => sum + totalCount(child.id, nextTrail), 0);
      totalCountCache.set(id, total);
      return total;
    };

    const entries: FolderTreeEntry[] = [];
    const visited = new Set<string>();
    const walk = (folder: StudyFolder, depth: number, ancestorIds: string[]): void => {
      if (visited.has(folder.id)) return;
      visited.add(folder.id);
      const childFolders = children.get(folder.id) ?? [];
      entries.push({
        folder,
        depth,
        ancestorIds,
        directCount: directCounts.get(folder.id) ?? 0,
        totalCount: totalCount(folder.id),
        hasChildren: childFolders.length > 0
      });
      for (const child of childFolders) walk(child, depth + 1, [...ancestorIds, folder.id]);
    };

    for (const root of children.get(null) ?? []) walk(root, 0, []);
    for (const folder of folders) {
      if (!visited.has(folder.id)) walk(folder, 0, []);
    }
    return entries;
  });

  readonly folderIndex = computed(() => new Map(this.folderTree().map(entry => [entry.folder.id, entry])));

  readonly visibleFolderEntries = computed(() => {
    const entries = this.folderTree();
    const query = this.normalizeText(this.folderSearch());
    if (query) {
      const visibleIds = new Set<string>();
      for (const entry of entries) {
        if (this.normalizeText(entry.folder.name).includes(query)) {
          visibleIds.add(entry.folder.id);
          entry.ancestorIds.forEach(id => visibleIds.add(id));
        }
      }
      return entries.filter(entry => visibleIds.has(entry.folder.id));
    }

    const collapsed = new Set(this.collapsedFolderIds());
    return entries.filter(entry => !entry.ancestorIds.some(id => collapsed.has(id)));
  });

  readonly unfiledCount = computed(() => {
    const folderIds = new Set(this.folderTree().map(entry => entry.folder.id));
    return this.library.files().filter(file => !file.folderId || !folderIds.has(file.folderId)).length;
  });

  readonly favoriteCount = computed(() => this.library.files().filter(file => file.favorite).length);

  readonly visibleFiles = computed(() => {
    const query = this.normalizeText(this.search());
    const folder = this.selectedFolder();
    const realFolderIds = new Set(this.folderTree().map(entry => entry.folder.id));
    const allowedFolderIds = new Set<string>();

    if (realFolderIds.has(folder)) {
      allowedFolderIds.add(folder);
      for (const entry of this.folderTree()) {
        if (entry.ancestorIds.includes(folder)) allowedFolderIds.add(entry.folder.id);
      }
    }

    return this.library.files()
      .filter(file => {
        const folderMatch = folder === 'all'
          || (folder === 'favorites' && file.favorite)
          || (folder === 'unfiled' && (!file.folderId || !realFolderIds.has(file.folderId)))
          || allowedFolderIds.has(file.folderId);
        const textMatch = !query
          || this.normalizeText(file.name).includes(query)
          || this.normalizeText(this.folderName(file.folderId)).includes(query);
        return folderMatch && textMatch;
      })
      .sort((a, b) => this.sort() === 'name'
        ? a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' })
        : new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  });

  readonly sectionTitle = computed(() => {
    if (this.selectedFolder() === 'favorites') return 'Favoritos';
    if (this.selectedFolder() === 'unfiled') return 'Sem pasta';
    return this.folderIndex().get(this.selectedFolder())?.folder.name ?? 'Toda a biblioteca';
  });

  readonly breadcrumbs = computed(() => {
    const entry = this.folderIndex().get(this.selectedFolder());
    if (!entry) return [];
    return [...entry.ancestorIds, entry.folder.id]
      .map(id => this.folderIndex().get(id)?.folder)
      .filter((folder): folder is StudyFolder => Boolean(folder));
  });

  readonly overlayOpen = computed(() => this.uploadOpen()
    || this.folderModalOpen()
    || this.helpOpen()
    || Boolean(this.selectedFile()));

  constructor() {
    effect(() => {
      const userId = this.library.session()?.user.id ?? null;
      if (userId !== this.lastUserId) {
        this.resetWorkspaceState();
        this.lastUserId = userId;
      }
    });
    effect(() => {
      const existingIds = new Set(this.library.files().map(file => file.id));
      this.selectedFileIds.update(ids => {
        const validIds = ids.filter(id => existingIds.has(id));
        return validIds.length === ids.length ? ids : validIds;
      });
    });

  }

  ngOnDestroy(): void {
    this.previewRequestId++;
    this.revokePreviewUrl();
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  @HostListener('window:resize')
  onResize(): void {
    const isMobile = window.matchMedia('(max-width: 900px)').matches;
    this.mobileViewport.set(isMobile);
    if (!isMobile) this.menuOpen.set(false);
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key === 'Tab' && this.overlayOpen()) this.trapDialogFocus(event);
    else if (event.key === 'Tab' && this.mobileViewport() && this.menuOpen()) {
      this.trapFocusWithin(this.librarySidebar?.nativeElement ?? null, event);
    }

    if (event.key === 'Escape') {
      if (this.fileActionMode()) this.closeFileAction();
      else if (this.selectedFile()) this.closePreview();
      else if (this.helpOpen()) this.closeHelp();
      else if (this.folderModalOpen()) this.closeFolderModal();
      else if (this.uploadOpen()) this.closeUpload();
      else if (this.menuOpen()) this.closeMobileMenu();
      else return;
      event.preventDefault();
      return;
    }

    const target = event.target;
    const isTyping = target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement
      || (target instanceof HTMLElement && target.isContentEditable);
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.focusSearch();
    } else if (event.key === '/' && !isTyping && !this.overlayOpen()) {
      event.preventDefault();
      this.focusSearch();
    }
  }

  openMobileMenu(): void {
    this.menuOpen.set(true);
    setTimeout(() => this.sidebarCloseButton?.nativeElement.focus());
  }

  closeMobileMenu(returnFocus = true): void {
    const wasOpen = this.menuOpen();
    this.menuOpen.set(false);
    if (returnFocus && wasOpen) setTimeout(() => this.mobileMenuButton?.nativeElement.focus());
  }

  focusSearch(): void {
    this.closeMobileMenu(false);
    setTimeout(() => {
      this.librarySearch?.nativeElement.focus();
      this.librarySearch?.nativeElement.select();
    });
  }

  chooseFolder(id: string): void {
    this.selectedFolder.set(id);
    this.selectedFileIds.set([]);
    this.closeMobileMenu(false);
  }

  toggleFolderCollapse(entry: FolderTreeEntry, event: Event): void {
    event.stopPropagation();
    if (!entry.hasChildren) return;
    this.collapsedFolderIds.update(ids => ids.includes(entry.folder.id)
      ? ids.filter(id => id !== entry.folder.id)
      : [...ids, entry.folder.id]);
  }

  isFolderCollapsed(id: string): boolean {
    return this.collapsedFolderIds().includes(id);
  }

  openUpload(folderId?: string): void {
    this.modalReturnFocus = this.dialogReturnTarget();
    this.uploadOperationId++;
    const availableIds = new Set(this.folderTree().map(entry => entry.folder.id));
    const preferred = folderId ?? this.selectedFolder();
    this.uploadFolder = availableIds.has(preferred)
      ? preferred
      : '';
    this.pendingFiles = [];
    this.uploadSaving.set(false);
    this.uploadOpen.set(true);
    this.closeMobileMenu(false);
    setTimeout(() => document.querySelector<HTMLElement>('.upload-modal [data-dialog-initial]')?.focus());
  }

  closeUpload(force = false): void {
    if (this.uploadSaving() && !force) return;
    const wasOpen = this.uploadOpen();
    this.uploadOperationId++;
    this.uploadOpen.set(false);
    this.uploadSaving.set(false);
    this.pendingFiles = [];
    if (wasOpen) {
      this.restoreFocus(this.modalReturnFocus);
      this.modalReturnFocus = null;
    }
  }

  openHelp(): void {
    this.modalReturnFocus = this.dialogReturnTarget();
    this.helpOpen.set(true);
    this.closeMobileMenu(false);
    setTimeout(() => document.querySelector<HTMLElement>('.help-modal [data-dialog-initial]')?.focus());
  }

  closeHelp(): void {
    const wasOpen = this.helpOpen();
    this.helpOpen.set(false);
    if (wasOpen) {
      this.restoreFocus(this.modalReturnFocus);
      this.modalReturnFocus = null;
    }
  }

  async selectFile(file: StudyFile): Promise<void> {
    const requestId = ++this.previewRequestId;
    const userId = this.library.session()?.user.id ?? null;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    try {
      const content = await this.library.getContent(file);
      if (requestId !== this.previewRequestId || userId !== (this.library.session()?.user.id ?? null)) return;
      this.revokePreviewUrl();
      const blob = new Blob([this.prepareHtmlForPreview(content)], { type: 'text/html;charset=utf-8' });
      const objectUrl = URL.createObjectURL(blob);
      if (requestId !== this.previewRequestId || userId !== (this.library.session()?.user.id ?? null)) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      this.previewObjectUrl = objectUrl;
      this.previewReturnFocus = returnFocus;
      this.selectedFile.set(file);
      this.previewUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(this.previewObjectUrl));
      setTimeout(() => document.querySelector<HTMLElement>('.viewer [data-dialog-initial]')?.focus());
    } catch {
      if (requestId === this.previewRequestId) this.showToast('Não foi possível abrir este arquivo.', 'error');
    }
  }

  closePreview(force = false): void {
    if (this.fileActionBusy() && !force) return;
    this.previewRequestId++;
    this.closeFileAction(true);
    this.selectedFile.set(null);
    this.previewUrl.set(null);
    this.revokePreviewUrl();
    this.restoreFocus(this.previewReturnFocus);
    this.previewReturnFocus = null;
  }

  openFileAction(mode: FileActionMode, file: StudyFile): void {
    this.fileActionReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.fileActionOperationId++;
    this.fileActionMode.set(mode);
    this.fileActionBusy.set(false);
    this.fileRenameValue = file.name;
    this.fileMoveFolder = this.folderIndex().has(file.folderId) ? file.folderId : '';
    setTimeout(() => {
      const dialog = document.querySelector<HTMLElement>('.file-action-modal');
      dialog?.querySelector<HTMLElement>('[data-dialog-initial]')?.focus();
    });
  }

  closeFileAction(force = false): void {
    if (this.fileActionBusy() && !force) return;
    this.fileActionOperationId++;
    this.fileActionMode.set(null);
    this.fileActionBusy.set(false);
    this.restoreFocus(this.fileActionReturnFocus);
    this.fileActionReturnFocus = null;
  }

  async saveFileAction(): Promise<void> {
    const file = this.selectedFile();
    const mode = this.fileActionMode();
    if (!file || !mode) return;
    const operationId = ++this.fileActionOperationId;
    this.fileActionBusy.set(true);
    try {
      if (mode === 'rename') {
        const baseName = this.fileRenameValue.trim().replace(/\.html?$/i, '');
        if (!baseName) return;
        const name = `${baseName}.html`;
        await this.library.renameFile(file.id, name);
        if (operationId !== this.fileActionOperationId) return;
        this.selectedFile.set({ ...file, name });
        this.showToast('Arquivo renomeado.');
      } else if (mode === 'move') {
        const destination = this.fileMoveFolder;
        await this.library.moveFile(file.id, destination);
        if (operationId !== this.fileActionOperationId) return;
        this.selectedFile.set({ ...file, folderId: destination });
        this.showToast(`Arquivo movido para ${this.folderName(destination)}.`);
      } else {
        await this.library.deleteFile(file.id);
        if (operationId !== this.fileActionOperationId) return;
        this.selectedFileIds.update(ids => ids.filter(id => id !== file.id));
        this.closePreview(true);
        this.showToast('Arquivo excluído.');
        return;
      }
      this.closeFileAction(true);
    } catch {
      if (operationId === this.fileActionOperationId) {
        this.showToast('A alteração não pôde ser concluída.', 'error');
      }
    } finally {
      if (operationId === this.fileActionOperationId) this.fileActionBusy.set(false);
    }
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.setPendingFiles(Array.from(event.dataTransfer?.files ?? []));
  }

  onLibraryDragEnter(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    this.dragDepth++;
    this.externalDrag.set(true);
  }

  onLibraryDragOver(event: DragEvent): void {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  }

  onLibraryDragLeave(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files')) return;
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (!this.dragDepth) this.externalDrag.set(false);
  }

  onLibraryDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragDepth = 0;
    this.externalDrag.set(false);
    const droppedFiles = Array.from(event.dataTransfer?.files ?? []);
    this.openUpload(this.selectedFolder());
    this.setPendingFiles(droppedFiles);
    if (!this.pendingFiles.length) this.uploadOpen.set(false);
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
    this.dragOverFolder.set(folderId || 'unfiled');
    if (event.dataTransfer) event.dataTransfer.dropEffect = event.dataTransfer.types.includes('Files') ? 'copy' : 'move';
  }

  async dropOnFolder(folderId: string, event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.dragOverFolder.set(null);
    const externalFiles = Array.from(event.dataTransfer?.files ?? []);
    if (externalFiles.length) {
      this.openUpload(folderId);
      this.setPendingFiles(externalFiles);
      return;
    }

    let ids: string[] = [];
    try {
      ids = JSON.parse(event.dataTransfer?.getData('text/study-vault-files') || '[]') as string[];
    } catch {
      ids = [];
    }
    if (!ids.length && this.draggedFileId()) ids = [this.draggedFileId()!];
    if (!ids.length) return;
    try {
      await this.library.moveFiles(ids, folderId);
      this.selectedFileIds.set([]);
      this.showToast(`${ids.length} arquivo(s) movido(s) para ${this.folderName(folderId)}.`);
    } catch {
      this.showToast('Não foi possível mover os arquivos.', 'error');
    } finally {
      this.endFileDrag();
    }
  }

  onFileInput(event: Event): void {
    this.setPendingFiles(Array.from((event.target as HTMLInputElement).files ?? []));
  }

  async saveUpload(): Promise<void> {
    if (!this.pendingFiles.length || this.uploadSaving()) return;
    const files = [...this.pendingFiles];
    const operationId = ++this.uploadOperationId;
    this.uploadSaving.set(true);
    try {
      const result = await this.library.addFiles(files, this.uploadFolder);
      if (operationId !== this.uploadOperationId) return;
      if (result.failed.length) {
        this.pendingFiles = result.failed;
        this.showToast(`${result.uploaded} enviado(s); ${result.failed.length} precisam ser tentados novamente.`, 'error');
      } else {
        this.closeUpload(true);
        this.showToast(`${result.uploaded} arquivo(s) sincronizado(s).`);
      }
    } catch {
      if (operationId === this.uploadOperationId) {
        this.showToast('O upload foi interrompido. Tente novamente.', 'error');
      }
    } finally {
      if (operationId === this.uploadOperationId) this.uploadSaving.set(false);
    }
  }

  async toggleFavorite(file: StudyFile, event: Event): Promise<void> {
    event.stopPropagation();
    try {
      await this.library.toggleFavorite(file.id);
      this.showToast(file.favorite ? 'Removido dos favoritos.' : 'Adicionado aos favoritos.');
    } catch {
      this.showToast('Não foi possível alterar o favorito.', 'error');
    }
  }

  toggleFileSelection(file: StudyFile, event: Event): void {
    event.stopPropagation();
    const current = this.selectedFileIds();
    this.selectedFileIds.set(current.includes(file.id)
      ? current.filter(id => id !== file.id)
      : [...current, file.id]);
  }

  clearSelection(): void {
    this.selectedFileIds.set([]);
  }

  openFolderModal(parentId: string | null = null, folder: StudyFolder | null = null, event?: Event): void {
    event?.stopPropagation();
    this.modalReturnFocus = this.dialogReturnTarget();
    this.folderOperationId++;
    this.editingFolder.set(folder);
    this.folderFormName = folder?.name ?? '';
    this.folderFormColor = folder?.color ?? this.folderColors[this.library.folders().length % this.folderColors.length];
    this.folderFormParentId = folder?.parentId ?? parentId;
    this.folderDeleteConfirm.set(false);
    this.folderSaving.set(false);
    this.folderModalOpen.set(true);
    this.closeMobileMenu(false);
    setTimeout(() => document.querySelector<HTMLInputElement>('.folder-modal input[type="text"]')?.focus());
  }

  closeFolderModal(force = false): void {
    if (this.folderSaving() && !force) return;
    const wasOpen = this.folderModalOpen();
    this.folderOperationId++;
    this.folderModalOpen.set(false);
    this.folderSaving.set(false);
    this.folderDeleteConfirm.set(false);
    if (wasOpen) {
      this.restoreFocus(this.modalReturnFocus);
      this.modalReturnFocus = null;
    }
  }

  async deleteEditingFolder(): Promise<void> {
    const folder = this.editingFolder();
    if (!folder) return;
    const operationId = ++this.folderOperationId;
    this.folderSaving.set(true);
    try {
      await this.library.deleteFolder(folder.id, folder.parentId);
      if (operationId !== this.folderOperationId) return;
      if (this.selectedFolder() === folder.id) this.chooseFolder(folder.parentId ?? 'all');
      this.closeFolderModal(true);
      this.showToast('Pasta excluída. Os arquivos foram preservados.');
    } catch {
      if (operationId === this.folderOperationId) this.showToast('Não foi possível excluir a pasta.', 'error');
    } finally {
      if (operationId === this.folderOperationId) this.folderSaving.set(false);
    }
  }

  async saveFolder(): Promise<void> {
    const name = this.folderFormName.trim();
    if (!name || this.folderSaving()) return;
    const operationId = ++this.folderOperationId;
    this.folderSaving.set(true);
    try {
      const editing = this.editingFolder();
      if (editing) {
        await this.library.updateFolder(editing.id, name, this.folderFormColor, this.folderFormParentId);
        if (operationId !== this.folderOperationId) return;
        this.showToast('Pasta atualizada.');
      } else {
        const id = await this.library.addFolder(name, this.folderFormParentId, this.folderFormColor);
        if (operationId !== this.folderOperationId) return;
        this.chooseFolder(id);
        this.showToast(this.folderFormParentId ? 'Subpasta criada.' : 'Pasta criada.');
      }
      this.closeFolderModal(true);
    } catch {
      if (operationId === this.folderOperationId) this.showToast('Não foi possível salvar a pasta.', 'error');
    } finally {
      if (operationId === this.folderOperationId) this.folderSaving.set(false);
    }
  }

  availableParentFolders(): StudyFolder[] {
    const editingId = this.editingFolder()?.id;
    return this.folderTree()
      .map(entry => entry.folder)
      .filter(folder => folder.id !== editingId && !this.isDescendant(folder.id, editingId));
  }

  folderDepth(folderId: string): number {
    return this.folderIndex().get(folderId)?.depth ?? 0;
  }

  folderName(id: string): string {
    return this.folderIndex().get(id)?.folder.name ?? 'Sem pasta';
  }

  folderColor(id: string): string {
    return this.folderIndex().get(id)?.folder.color ?? '#a4aaa5';
  }

  folderPath(id: string): string {
    const entry = this.folderIndex().get(id);
    if (!entry) return 'Sem pasta';
    return [...entry.ancestorIds, id]
      .map(folderId => this.folderIndex().get(folderId)?.folder.name)
      .filter(Boolean)
      .join(' / ');
  }

  fileCount(folderId: string): number {
    if (folderId === 'all') return this.library.files().length;
    if (folderId === 'favorites') return this.favoriteCount();
    if (folderId === 'unfiled') return this.unfiledCount();
    return this.folderIndex().get(folderId)?.totalCount ?? 0;
  }

  displayFileName(name: string): string {
    return name.replace(/\.html?$/i, '');
  }

  formatSize(bytes: number): string {
    if (!bytes) return '0 KB';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  pendingTotalSize(): number {
    return this.pendingFiles.reduce((sum, file) => sum + file.size, 0);
  }

  async retrySync(): Promise<void> {
    try {
      await this.library.refreshAll();
      this.showToast('Biblioteca sincronizada.');
    } catch {
      this.showToast('A sincronização ainda não respondeu.', 'error');
    }
  }

  async authenticate(): Promise<void> {
    if (this.authBusy()) return;
    this.authError.set('');
    if (!this.username.trim() || !this.password) {
      this.authError.set('Informe seu usuário e senha.');
      return;
    }
    const operationId = ++this.authOperationId;
    this.authBusy.set(true);
    const password = this.password;
    this.password = '';
    try {
      const error = await this.library.signIn(this.username.trim(), password);
      if (operationId !== this.authOperationId) return;
      if (error) this.authError.set('Usuário ou senha inválidos.');
    } catch {
      if (operationId === this.authOperationId) {
        this.authError.set('Não foi possível conectar. Verifique sua internet e tente novamente.');
      }
    } finally {
      if (operationId === this.authOperationId) this.authBusy.set(false);
    }
  }

  currentDisplayName(): string {
    const user = this.library.session()?.user;
    const metadata = user?.user_metadata as Record<string, unknown> | undefined;
    const displayName = metadata?.['display_name'] ?? metadata?.['username'];
    return typeof displayName === 'string' && displayName.trim()
      ? displayName.trim()
      : emailToUsername(user?.email);
  }

  avatarInitials(): string {
    const parts = this.currentDisplayName().trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'SV';
    return `${parts[0][0] ?? ''}${parts.length > 1 ? parts.at(-1)?.[0] ?? '' : parts[0][1] ?? ''}`.toUpperCase();
  }

  async signOut(): Promise<void> {
    try {
      await this.library.signOut();
    } catch {
      this.showToast('Não foi possível sair agora.', 'error');
    }
  }

  private setPendingFiles(files: File[]): void {
    const htmlFiles = files.filter(file => file.name.toLowerCase().endsWith('.html') || file.type === 'text/html');
    const valid = htmlFiles.filter(file => file.size <= MAX_HTML_SIZE);
    this.pendingFiles = valid;
    if (!valid.length) {
      this.showToast(htmlFiles.length ? 'Cada HTML pode ter no máximo 10 MB.' : 'Escolha um arquivo HTML válido.', 'error');
    } else if (valid.length !== files.length) {
      this.showToast('Arquivos incompatíveis ou maiores que 10 MB foram ignorados.', 'info');
    }
  }

  private prepareHtmlForPreview(content: string): string {
    const navigationBridge = `<script>
      document.addEventListener('click', function(event) {
        var origin = event.target;
        if (!(origin instanceof Element)) return;
        var link = origin.closest('a[href^="#"]');
        if (!link) return;
        var id;
        try { id = decodeURIComponent(link.getAttribute('href').slice(1)); } catch (_) { return; }
        var target = document.getElementById(id);
        if (!target) return;
        event.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        document.querySelectorAll('nav a.active').forEach(function(item) {
          item.classList.remove('active');
        });
        link.classList.add('active');
      });
    <\/script>`;
    return content.includes('</body>')
      ? content.replace('</body>', `${navigationBridge}</body>`)
      : `${content}${navigationBridge}`;
  }

  private isDescendant(folderId: string, ancestorId?: string): boolean {
    if (!ancestorId) return false;
    const visited = new Set<string>();
    let current = this.folderIndex().get(folderId)?.folder;
    while (current?.parentId && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.parentId === ancestorId) return true;
      current = this.folderIndex().get(current.parentId)?.folder;
    }
    return false;
  }

  private normalizeText(value: string): string {
    return value.trim().toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  private revokePreviewUrl(): void {
    if (!this.previewObjectUrl) return;
    URL.revokeObjectURL(this.previewObjectUrl);
    this.previewObjectUrl = null;
  }

  private resetWorkspaceState(): void {
    this.authOperationId++;
    this.authBusy.set(false);
    this.authError.set('');
    this.selectedFolder.set('all');
    this.selectedFileIds.set([]);
    this.search.set('');
    this.folderSearch.set('');
    this.collapsedFolderIds.set([]);
    this.pendingFiles = [];
    this.uploadFolder = '';
    this.username = '';
    this.password = '';
    this.menuOpen.set(false);
    this.closeUpload(true);
    this.closeFolderModal(true);
    this.closeHelp();
    this.closePreview(true);
  }

  private trapDialogFocus(event: KeyboardEvent): void {
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
      .filter(dialog => dialog.offsetParent !== null);
    const dialog = dialogs.at(-1);
    this.trapFocusWithin(dialog ?? null, event);
  }

  private trapFocusWithin(container: HTMLElement | null, event: KeyboardEvent): void {
    if (!container) return;
    const focusable = Array.from(container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, a[href], [tabindex]:not([tabindex="-1"])'
    )).filter(element => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (!container.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private dialogReturnTarget(): HTMLElement | null {
    if (this.mobileViewport()) return this.mobileMenuButton?.nativeElement ?? null;
    return document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  private restoreFocus(target: HTMLElement | null): void {
    if (!target) return;
    setTimeout(() => {
      if (document.contains(target) && !target.closest('[inert]')) target.focus();
    });
  }

  private showToast(message: string, tone: ToastTone = 'success'): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTone.set(tone);
    this.toast.set(message);
    this.toastTimer = setTimeout(() => this.toast.set(''), 3400);
  }

}
