import { Injectable, signal } from '@angular/core';
import { StudyFile, StudyFolder } from './models';

const SAMPLE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>
body{font-family:system-ui;max-width:760px;margin:48px auto;padding:0 24px;color:#25312c}
h1{color:#265c46}code{background:#edf5f0;padding:3px 7px;border-radius:5px}
.note{border-left:4px solid #e89f5d;background:#fff8f0;padding:16px;margin:24px 0}
</style></head><body><h1>Introdução ao JavaScript</h1><p>JavaScript é a linguagem da web.</p>
<div class="note"><strong>Lembrete:</strong> pratique um pouco todos os dias.</div>
<h2>Variáveis</h2><p>Use <code>const</code> por padrão e <code>let</code> quando precisar reatribuir.</p></body></html>`;

@Injectable({ providedIn: 'root' })
export class LibraryService {
  readonly folders = signal<StudyFolder[]>([
    { id: 'all', name: 'Todos os arquivos', color: '#407d63' },
    { id: 'frontend', name: 'Frontend', color: '#e9914d' },
    { id: 'backend', name: 'Backend', color: '#6c83cb' },
    { id: 'projects', name: 'Projetos', color: '#bb6f91' }
  ]);

  readonly files = signal<StudyFile[]>(this.loadFiles());

  private loadFiles(): StudyFile[] {
    const saved = localStorage.getItem('study-vault-files');
    if (saved) {
      try { return JSON.parse(saved) as StudyFile[]; } catch { /* use seed */ }
    }
    return [
      { id: crypto.randomUUID(), name: 'Introdução ao JavaScript.html', folderId: 'frontend', size: 24800, updatedAt: new Date().toISOString(), favorite: true, content: SAMPLE },
      { id: crypto.randomUUID(), name: 'Guia de CSS Grid.html', folderId: 'frontend', size: 18300, updatedAt: new Date(Date.now() - 86400000).toISOString(), favorite: false, content: SAMPLE.replace('JavaScript', 'CSS Grid') },
      { id: crypto.randomUUID(), name: 'Spring Boot — Anotações.html', folderId: 'backend', size: 32100, updatedAt: new Date(Date.now() - 172800000).toISOString(), favorite: false, content: SAMPLE.replace('JavaScript', 'Spring Boot') },
      { id: crypto.randomUUID(), name: 'Checklist do Portfólio.html', folderId: 'projects', size: 12700, updatedAt: new Date(Date.now() - 345600000).toISOString(), favorite: true, content: SAMPLE.replace('JavaScript', 'Portfólio') }
    ];
  }

  addFile(file: StudyFile): void {
    this.files.update(files => [file, ...files]);
    this.persist();
  }

  toggleFavorite(id: string): void {
    this.files.update(files => files.map(f => f.id === id ? { ...f, favorite: !f.favorite } : f));
    this.persist();
  }

  deleteFile(id: string): void {
    this.files.update(files => files.filter(f => f.id !== id));
    this.persist();
  }

  renameFile(id: string, name: string): void {
    this.files.update(files => files.map(f => f.id === id ? { ...f, name, updatedAt: new Date().toISOString() } : f));
    this.persist();
  }

  addFolder(name: string): string {
    const id = crypto.randomUUID();
    const colors = ['#407d63', '#e9914d', '#6c83cb', '#bb6f91'];
    this.folders.update(items => [...items, { id, name, color: colors[items.length % colors.length] }]);
    return id;
  }

  private persist(): void {
    localStorage.setItem('study-vault-files', JSON.stringify(this.files()));
  }
}
