import path from "path";
import fs from "fs/promises";
import FileProcessingService, {
  FileMetadata,
  ThumbnailInfo,
} from "./fileProcessing.service";

export interface FilePreviewInfo {
  type: "image" | "document" | "code" | "archive" | "other";
  canPreview: boolean;
  icon: string;
  thumbnail?: ThumbnailInfo;
  metadata?: FileMetadata;
}

export class FilePreviewService {
  // Mapeo de tipos MIME a categorías
  private static mimeTypeMap: Record<string, string> = {
    // Imágenes
    "image/jpeg": "image",
    "image/jpg": "image",
    "image/png": "image",
    "image/gif": "image",
    "image/webp": "image",
    "image/svg+xml": "image",
    "image/bmp": "image",
    "image/tiff": "image",

    // Documentos
    "application/pdf": "document",
    "application/msword": "document",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "document",
    "application/vnd.ms-excel": "document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      "document",
    "application/vnd.ms-powerpoint": "document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      "document",
    "text/plain": "document",
    "text/csv": "document",
    "text/html": "document",
    "text/css": "document",
    "text/javascript": "document",
    "application/json": "document",
    "application/xml": "document",

    // Código
    "application/x-python-code": "code",
    "text/x-python": "code",
    "text/x-java-source": "code",
    "text/x-c": "code",
    "text/x-cpp": "code",
    "text/x-csharp": "code",
    "text/x-php": "code",
    "text/x-ruby": "code",
    "text/x-go": "code",
    "text/x-rust": "code",
    "text/x-swift": "code",
    "text/x-kotlin": "code",

    // Archivos comprimidos
    "application/zip": "archive",
    "application/x-rar-compressed": "archive",
    "application/x-7z-compressed": "archive",
    "application/gzip": "archive",
    "application/x-tar": "archive",
    "application/x-bzip2": "archive",
    "application/x-lzma": "archive",
  };

  // Iconos por tipo de archivo
  private static iconMap: Record<string, string> = {
    image: "🖼️",
    document: "📄",
    code: "💻",
    archive: "📦",
    other: "📎",
  };

  /**
   * Obtiene información de vista previa para un archivo
   */
  static async getFilePreviewInfo(
    filePath: string,
    mimeType: string,
    fileName: string,
  ): Promise<FilePreviewInfo> {
    try {
      const fileType = this.getFileType(mimeType, fileName);
      const icon = this.iconMap[fileType] || this.iconMap.other;

      const baseInfo: FilePreviewInfo = {
        type: fileType as any,
        canPreview: this.canPreviewFile(fileType, mimeType),
        icon,
        metadata: undefined,
      };

      // Extraer metadatos reales usando el servicio de procesamiento
      try {
        const metadata = await FileProcessingService.extractMetadata(
          filePath,
          mimeType,
          fileName,
        );
        baseInfo.metadata = metadata;
      } catch (error) {
        console.error("Error extracting metadata:", error);
        // Fallback a metadatos básicos
        const stats = await fs.stat(filePath);
        baseInfo.metadata = {
          size: stats.size,
          lastModified: stats.mtime,
        };
      }

      // Generar thumbnail para imágenes
      if (fileType === "image" && this.canPreviewFile(fileType, mimeType)) {
        try {
          // Primero verificar si ya existe un thumbnail
          let thumbnail =
            await FileProcessingService.getThumbnailInfo(fileName);

          // Si no existe, generarlo
          if (!thumbnail) {
            thumbnail = await FileProcessingService.generateImageThumbnail(
              filePath,
              fileName,
            );
          }

          if (thumbnail) {
            baseInfo.thumbnail = thumbnail;
          }
        } catch (error) {
          console.error("Error generating thumbnail:", error);
        }
      }

      return baseInfo;
    } catch (error) {
      console.error("Error getting file preview info:", error);
      const stats = await fs.stat(filePath);
      return {
        type: "other",
        canPreview: false,
        icon: this.iconMap.other,
        metadata: {
          size: stats.size,
          lastModified: stats.mtime,
        },
      };
    }
  }

  /**
   * Determina el tipo de archivo basado en MIME type y extensión
   */
  private static getFileType(mimeType: string, fileName: string): string {
    // Primero intentar con MIME type
    if (this.mimeTypeMap[mimeType]) {
      return this.mimeTypeMap[mimeType];
    }

    // Fallback a extensión
    const extension = path.extname(fileName).toLowerCase();
    const extensionMap: Record<string, string> = {
      // Imágenes
      ".jpg": "image",
      ".jpeg": "image",
      ".png": "image",
      ".gif": "image",
      ".webp": "image",
      ".svg": "image",
      ".bmp": "image",
      ".tiff": "image",

      // Documentos
      ".pdf": "document",
      ".doc": "document",
      ".docx": "document",
      ".xls": "document",
      ".xlsx": "document",
      ".ppt": "document",
      ".pptx": "document",
      ".txt": "document",
      ".csv": "document",
      ".html": "document",
      ".css": "document",
      ".js": "document",
      ".json": "document",
      ".xml": "document",

      // Código
      ".py": "code",
      ".java": "code",
      ".c": "code",
      ".cpp": "code",
      ".cs": "code",
      ".php": "code",
      ".rb": "code",
      ".go": "code",
      ".rs": "code",
      ".swift": "code",
      ".kt": "code",
      ".ts": "code",
      ".jsx": "code",
      ".tsx": "code",

      // Archivos comprimidos
      ".zip": "archive",
      ".rar": "archive",
      ".7z": "archive",
      ".gz": "archive",
      ".tar": "archive",
      ".bz2": "archive",
      ".lzma": "archive",
    };

    return extensionMap[extension] || "other";
  }

  /**
   * Verifica si se puede generar vista previa del archivo
   */
  private static canPreviewFile(fileType: string, mimeType: string): boolean {
    if (fileType === "image") {
      return [
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/gif",
        "image/webp",
      ].includes(mimeType);
    }

    if (fileType === "document") {
      return mimeType === "application/pdf" || mimeType.startsWith("text/");
    }

    return false;
  }

  /**
   * Obtiene información del archivo para la UI
   */
  static getFileDisplayInfo(
    fileName: string,
    mimeType: string,
    sizeBytes: number,
  ): {
    displayName: string;
    size: string;
    type: string;
  } {
    const displayName =
      fileName.length > 30 ? fileName.substring(0, 27) + "..." : fileName;

    const size = this.formatFileSize(sizeBytes);
    const type = this.getFileType(mimeType, fileName);

    return { displayName, size, type };
  }

  /**
   * Formatea el tamaño del archivo en formato legible
   */
  private static formatFileSize(bytes: number): string {
    if (bytes === 0) return "0 B";

    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  /**
   * Limpia thumbnails antiguos
   */
  static async cleanupThumbnails(): Promise<void> {
    await FileProcessingService.cleanupOldThumbnails();
  }
}

export default FilePreviewService;
