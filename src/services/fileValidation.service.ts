import { ApiError } from "../lib/errors";

export interface FileValidationConfig {
  maxSizeBytes: number;
  allowedMimeTypes: string[];
  allowedExtensions: string[];
  maxFilesPerTicket: number;
}

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
      // Documentos
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/plain",
      "text/csv",
      // Archivos de texto
      "text/plain",
      "text/html",
      "text/css",
      "text/javascript",
      "application/json",
      "application/xml",
      // Archivos de código
      "application/x-python-code",
      "application/x-java-source",
      "text/x-python",
      "text/x-java-source",
      // Archivos comprimidos
      "application/zip",
      "application/x-rar-compressed",
      "application/x-7z-compressed",
      "application/gzip",
      "application/x-tar",
    ],
    allowedExtensions: [
      // Imágenes
      ".jpg",
      ".jpeg",
      ".png",
      ".gif",
      ".webp",
      ".svg",
      // Documentos
      ".pdf",
      ".doc",
      ".docx",
      ".xls",
      ".xlsx",
      ".txt",
      ".csv",
      // Archivos de texto
      ".html",
      ".css",
      ".js",
      ".json",
      ".xml",
      // Archivos de código
      ".py",
      ".java",
      ".cpp",
      ".c",
      ".js",
      ".ts",
      ".jsx",
      ".tsx",
      // Archivos comprimidos
      ".zip",
      ".rar",
      ".7z",
      ".gz",
      ".tar",
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

    // Validar tipo MIME
    if (!finalConfig.allowedMimeTypes.includes(file.mimetype)) {
      throw new ApiError(
        "INVALID_FILE_TYPE",
        `Tipo de archivo no permitido: ${file.mimetype}`,
        400,
      );
    }

    // Validar extensión
    const fileExtension = this.getFileExtension(file.originalname);
    if (!finalConfig.allowedExtensions.includes(fileExtension.toLowerCase())) {
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
