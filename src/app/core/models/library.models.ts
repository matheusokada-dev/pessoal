export interface StudyFolder {
  id: string;
  name: string;
  color: string;
}

export interface StudyFile {
  id: string;
  name: string;
  folderId: string;
  size: number;
  updatedAt: string;
  favorite: boolean;
  content?: string;
  storagePath?: string;
}
