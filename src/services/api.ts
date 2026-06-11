// API服务层 - 与后端通信

const API_BASE_URL = "http://localhost:8000/api";

export interface FileInfo {
  id: string;
  name: string;
  type: "pdf" | "markdown";
  path: string;
  meta: {
    pages?: number;
    words?: number;
    readTime?: number;
    size?: string;
  };
}

export interface PDFPageResponse {
  image: string;
  width: number;
  height: number;
}

export interface MarkdownContentResponse {
  content: string;
  wordCount: number;
  readTime: number;
}

export interface PDFImageInfo {
  xref: number;
  pageNumber: number;
  width: number;
  height: number;
  extension: string;
  bbox?: number[]; // [x0, y0, x1, y1]
}

export interface ExtractedImage {
  page: number;
  index: number;
  path: string;
  size: string;
  width: number;
  height: number;
}

export interface ExtractImagesResponse {
  images: ExtractedImage[];
  outputDir: string;
  total: number;
}

// 文件管理
export async function openFile(path: string): Promise<FileInfo> {
  const response = await fetch(`${API_BASE_URL}/files/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });

  if (!response.ok) {
    throw new Error(`Failed to open file: ${response.statusText}`);
  }

  return response.json();
}

export async function uploadFile(file: File): Promise<FileInfo> {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${API_BASE_URL}/files/upload`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload file: ${response.statusText}`);
  }

  return response.json();
}

export async function listFiles(): Promise<{ files: FileInfo[] }> {
  const response = await fetch(`${API_BASE_URL}/files`);

  if (!response.ok) {
    throw new Error(`Failed to list files: ${response.statusText}`);
  }

  return response.json();
}

export async function closeFile(fileId: string): Promise<{ success: boolean }> {
  const response = await fetch(`${API_BASE_URL}/files/${fileId}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(`Failed to close file: ${response.statusText}`);
  }

  return response.json();
}

// PDF操作
export async function renderPDFPage(
  fileId: string,
  pageNum: number,
  zoom: number = 1.0
): Promise<PDFPageResponse> {
  const response = await fetch(
    `${API_BASE_URL}/pdf/${fileId}/page/${pageNum}?zoom=${zoom}`
  );

  if (!response.ok) {
    throw new Error(`Failed to render PDF page: ${response.statusText}`);
  }

  return response.json();
}

export async function getPDFInfo(fileId: string): Promise<{
  pages: number;
  title: string;
  author: string;
  size: string;
}> {
  const response = await fetch(`${API_BASE_URL}/pdf/${fileId}/info`);

  if (!response.ok) {
    throw new Error(`Failed to get PDF info: ${response.statusText}`);
  }

  return response.json();
}

// Markdown操作
export async function getMarkdownContent(
  fileId: string
): Promise<MarkdownContentResponse> {
  const response = await fetch(`${API_BASE_URL}/markdown/${fileId}/content`);

  if (!response.ok) {
    throw new Error(`Failed to get markdown content: ${response.statusText}`);
  }

  return response.json();
}

export async function saveMarkdown(
  fileId: string,
  content: string
): Promise<{ success: boolean }> {
  const response = await fetch(`${API_BASE_URL}/markdown/${fileId}/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    throw new Error(`Failed to save markdown: ${response.statusText}`);
  }

  return response.json();
}

export async function previewMarkdown(content: string): Promise<{ html: string }> {
  const response = await fetch(`${API_BASE_URL}/markdown/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    throw new Error(`Failed to preview markdown: ${response.statusText}`);
  }

  return response.json();
}

// PDF图片提取
export async function getPDFImages(fileId: string): Promise<{ images: PDFImageInfo[] }> {
  const response = await fetch(`${API_BASE_URL}/pdf/${fileId}/images`);

  if (!response.ok) {
    throw new Error(`Failed to get PDF images: ${response.statusText}`);
  }

  return response.json();
}

export async function getPDFImage(fileId: string, xref: number): Promise<Blob> {
  const response = await fetch(`${API_BASE_URL}/pdf/${fileId}/image/${xref}`);

  if (!response.ok) {
    throw new Error(`Failed to get PDF image: ${response.statusText}`);
  }

  return response.blob();
}

export async function getPDFImageSVG(fileId: string, pageNumber: number, xref: number): Promise<Blob> {
  const response = await fetch(`${API_BASE_URL}/pdf/${fileId}/page/${pageNumber}/image/${xref}/svg`);

  if (!response.ok) {
    throw new Error(`Failed to get PDF SVG: ${response.statusText}`);
  }

  return response.blob();
}

export async function extractPDFImages(
  fileId: string,
  pages?: number[],
  deduplicate: boolean = true
): Promise<ExtractImagesResponse> {
  const response = await fetch(`${API_BASE_URL}/pdf/${fileId}/extract-images`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pages, deduplicate }),
  });

  if (!response.ok) {
    throw new Error(`Failed to extract images: ${response.statusText}`);
  }

  return response.json();
}

export async function extractPDFSvgCrop(
  fileId: string,
  pageNumber: number,
  rect: { x: number; y: number; width: number; height: number }
): Promise<Blob> {
  const response = await fetch(
    `${API_BASE_URL}/pdf/${fileId}/page/${pageNumber}/svg-crop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rect),
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to extract SVG crop: ${response.statusText}`);
  }

  return response.blob();
}

export async function getPDFPageSVG(fileId: string, pageNumber: number): Promise<Blob> {
  const response = await fetch(`${API_BASE_URL}/pdf/${fileId}/page/${pageNumber}/svg`);

  if (!response.ok) {
    throw new Error(`Failed to get page SVG: ${response.statusText}`);
  }

  return response.blob();
}
