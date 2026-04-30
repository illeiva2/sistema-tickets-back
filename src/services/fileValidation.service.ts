import { ApiError } from "../lib/errors";

export interface FileValidationConfig {
  maxSizeBytes: number;
  allowedMimeTypes: string[];
  allowedExtensions: string[];
  maxFilesPerTicket: number;
}

// Extensiones que nunca deben aceptarse, incluso si el mime type fuera "valido".
// Bloquea ejecutables, scripts y otros vectores comunes de malware.
const DANGEROUS_EXTENSIONS = new Set([
  ".exe", ".bat", ".cmd", ".com", ".scr", ".msi", ".msp", ".pif",
  ".cpl", ".dll", ".sys", ".reg",
  ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".jar", ".wsf", ".wsh",
  ".sh", ".bash", ".zsh", ".csh", ".ksh",
  ".app", ".deb", ".rpm", ".dmg", ".apk",
  ".lnk", ".inf", ".chm", ".hta",
]);

export class FileValidationService {
  // Configuración por defecto
  private static defaultConfig: FileValidationConfig = {
    maxSizeBytes: 10 * 1024 * 1024, // 10MB
    allowedMimeTypes: [
      // Imágenes
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/svg+xml",
      "image/bmp",
      "image/tiff",
      "image/heic",
      "image/heif",
      // Documentos
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.oasis.opendocument.text",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.oasis.opendocument.presentation",
      "application/rtf",
      // Texto / datos
      "text/plain",
      "text/csv",
      "text/markdown",
      "text/html",
      "text/css",
      "application/json",
      "application/xml",
      "text/xml",
      // Archivos comprimidos
      "application/zip",
      "application/x-zip-compressed",
      "application/x-rar-compressed",
      "application/vnd.rar",
      "application/x-7z-compressed",
      "application/gzip",
      "application/x-tar",
      // Audio y video básico (capturas de pantalla, grabaciones cortas)
      "audio/mpeg",
      "audio/wav",
      "audio/x-wav",
      "audio/webm",
      "video/mp4",
      "video/webm",
      "video/quicktime",
    ],
    allowedExtensions: [
      // Imágenes
      ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".bmp", ".tiff", ".tif",
      ".heic", ".heif",
      // Documentos
      ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
      ".odt", ".ods", ".odp", ".rtf",
      // Texto / datos
      ".txt", ".csv", ".md", ".html", ".htm", ".css",
      ".json", ".xml",
      // Archivos comprimidos
      ".zip", ".rar", ".7z", ".gz", ".tar", ".tgz",
      // Audio y video
      ".mp3", ".wav", ".m4a", ".mp4", ".mov", ".webm",
    ],
    maxFilesPerTicket: 20,
  };

  /**
   * Valida un archivo según la configuración
   */
  static validateFile(
    file: Express.Multer.File,
    config?: Partial<FileValidationConfig>,
  ): void {
    const finalConfig = { ...this.defaultConfig, ...config };

    // Validar tamaño
    if (file.size > finalConfig.maxSizeBytes) {
      const maxSizeMB = Math.round(finalConfig.maxSizeBytes / (1024 * 1024));
      throw new ApiError(
        "FILE_TOO_LARGE",
        `El archivo excede el tamaño máximo permitido (${maxSizeMB}MB)`,
        400,
      );
    }

    const fileExtension = this.getFileExtension(file.originalname).toLowerCase();

    // Blacklist explicita: rechazar ejecutables y scripts antes que cualquier
    // otra cosa, incluso si el mime type viniera "permitido".
    if (DANGEROUS_EXTENSIONS.has(fileExtension)) {
      throw new ApiError(
        "DANGEROUS_FILE_TYPE",
        `Por seguridad no se aceptan archivos ${fileExtension}`,
        400,
      );
    }

    // Validar tipo MIME contra la whitelist.
    if (!finalConfig.allowedMimeTypes.includes(file.mimetype)) {
      throw new ApiError(
        "INVALID_FILE_TYPE",
        `Tipo de archivo no permitido: ${file.mimetype}`,
        400,
      );
    }

    // Validar extensión contra la whitelist.
    if (!finalConfig.allowedExtensions.includes(fileExtension)) {
      throw new ApiError(
        "INVALID_FILE_EXTENSION",
        `Extensión de archivo no permitida: ${fileExtension}`,
        400,
      );
    }

    // Validar nombre de archivo
    this.validateFileName(file.originalname);
  }

  /**
   * Valida el nombre del archivo
   */
  private static validateFileName(fileName: string): void {
    // Verificar que no esté vacío
    if (!fileName || fileName.trim().length === 0) {
      throw new ApiError("INVALID_FILENAME", "Nombre de archivo inválido", 400);
    }

    // Verificar longitud máxima
    if (fileName.length > 255) {
      throw new ApiError(
        "INVALID_FILENAME",
        "Nombre de archivo demasiado largo",
        400,
      );
    }

    // Verificar caracteres peligrosos
    const dangerousChars = /[<>:"/\\|?*]/;
    if (dangerousChars.test(fileName)) {
      throw new ApiError(
        "INVALID_FILENAME",
        "Nombre de archivo contiene caracteres no permitidos",
        400,
      );
    }

    // Verificar que no sea solo puntos
    if (fileName.replace(/\./g, "").length === 0) {
      throw new ApiError("INVALID_FILENAME", "Nombre de archivo inválido", 400);
    }
  }

  /**
   * Obtiene la extensión del archivo
   */
  private static getFileExtension(fileName: string): string {
    const lastDotIndex = fileName.lastIndexOf(".");
    if (lastDotIndex === -1) return "";
    return fileName.substring(lastDotIndex);
  }

  /**
   * Verifica si se puede agregar más archivos a un ticket
   */
  static async canAddMoreFiles(
    ticketId: string,
    maxFiles?: number,
  ): Promise<boolean> {
    const { prisma } = await import("../lib/database");
    const currentCount = await prisma.attachment.count({
      where: { ticketId },
    });

    const limit = maxFiles || this.defaultConfig.maxFilesPerTicket;
    return currentCount < limit;
  }

  /**
   * Obtiene la configuración de validación
   */
  static getConfig(): FileValidationConfig {
    return { ...this.defaultConfig };
  }

  /**
   * Actualiza la configuración de validación
   */
  static updateConfig(newConfig: Partial<FileValidationConfig>): void {
    this.defaultConfig = { ...this.defaultConfig, ...newConfig };
  }
}

export default FileValidationService;
