import path from "path";
import fs from "fs/promises";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";

export interface FileMetadata {
  dimensions?: { width: number; height: number };
  pages?: number;
  size: number;
  lastModified: Date;
  format?: string;
  colorSpace?: string;
  hasAlpha?: boolean;
  orientation?: number;
  dpi?: { x: number; y: number };
  compressedSize?: number; // Agregar esta propiedad
}

export interface ThumbnailInfo {
  path: string;
  size: { width: number; height: number };
  url: string;
}

export class FileProcessingService {
  private static readonly THUMBNAIL_DIR = "thumbnails";
  private static readonly THUMBNAIL_SIZE = 200;

  /**
   * Genera un thumbnail para una imagen
   */
  static async generateImageThumbnail(
    filePath: string,
    fileName: string,
  ): Promise<ThumbnailInfo | null> {
    try {
      // Crear directorio de thumbnails si no existe
      const thumbnailDir = path.join(process.cwd(), this.THUMBNAIL_DIR);
      await fs.mkdir(thumbnailDir, { recursive: true });

      // Generar nombre único para el thumbnail
      const timestamp = Date.now();
      const randomId = Math.random().toString(36).substring(2, 15);
      const thumbnailName = `thumb-${timestamp}-${randomId}-${path.basename(fileName, path.extname(fileName))}.webp`;
      const thumbnailPath = path.join(thumbnailDir, thumbnailName);

      // Procesar imagen con Sharp
      const image = sharp(filePath);

      // Generar thumbnail
      await image
        .resize(this.THUMBNAIL_SIZE, this.THUMBNAIL_SIZE, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 80 })
        .toFile(thumbnailPath);

      // Verificar que se creó correctamente
      const thumbnailStats = await fs.stat(thumbnailPath);
      if (thumbnailStats.size === 0) {
        await fs.unlink(thumbnailPath);
        return null;
      }

      return {
        path: thumbnailPath,
        size: { width: this.THUMBNAIL_SIZE, height: this.THUMBNAIL_SIZE },
        url: `/thumbnails/${thumbnailName}`,
      };
    } catch (error) {
      console.error("Error generating thumbnail:", error);
      return null;
    }
  }

  /**
   * Extrae metadatos de una imagen
   */
  static async extractImageMetadata(filePath: string): Promise<FileMetadata> {
    try {
      const image = sharp(filePath);
      const metadata = await image.metadata();
      const stats = await fs.stat(filePath);

      return {
        dimensions:
          metadata.width && metadata.height
            ? { width: metadata.width, height: metadata.height }
            : undefined,
        size: stats.size,
        lastModified: stats.mtime,
        format: metadata.format,
        colorSpace: metadata.space,
        hasAlpha: metadata.hasAlpha,
        orientation: metadata.orientation,
        dpi:
          metadata.density &&
          typeof metadata.density === "object" &&
          // @ts-expect-error - metadata.density can be null but we check it above
          "x" in metadata.density &&
          // @ts-expect-error - metadata.density can be null but we check it above
          "y" in metadata.density
            ? { x: (metadata.density as any).x, y: (metadata.density as any).y }
            : undefined,
      };
    } catch (error) {
      console.error("Error extracting image metadata:", error);
      const stats = await fs.stat(filePath);
      return {
        size: stats.size,
        lastModified: stats.mtime,
      };
    }
  }

  /**
   * Extrae metadatos de un PDF
   */
  static async extractPDFMetadata(filePath: string): Promise<FileMetadata> {
    try {
      const fileBuffer = await fs.readFile(filePath);
      const pdfDoc = await PDFDocument.load(fileBuffer);
      const stats = await fs.stat(filePath);

      return {
        pages: pdfDoc.getPageCount(),
        size: stats.size,
        lastModified: stats.mtime,
        format: "PDF",
      };
    } catch (error) {
      console.error("Error extracting PDF metadata:", error);
      const stats = await fs.stat(filePath);
      return {
        size: stats.size,
        lastModified: stats.mtime,
        format: "PDF",
      };
    }
  }

  /**
   * Extrae metadatos de un archivo de texto
   */
  static async extractTextMetadata(
    filePath: string,
    mimeType: string,
  ): Promise<FileMetadata> {
    try {
      const stats = await fs.stat(filePath);
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n").length;
      const words = content
        .split(/\s+/)
        .filter((word) => word.length > 0).length;

      return {
        size: stats.size,
        lastModified: stats.mtime,
        format: mimeType,
        pages: Math.ceil(lines / 50), // Estimación de páginas (50 líneas por página)
        dimensions: { width: lines, height: words }, // Usar líneas y palabras como dimensiones
      };
    } catch (error) {
      console.error("Error extracting text metadata:", error);
      const stats = await fs.stat(filePath);
      return {
        size: stats.size,
        lastModified: stats.mtime,
        format: mimeType,
      };
    }
  }

  /**
   * Extrae metadatos de un archivo comprimido
   */
  static async extractArchiveMetadata(filePath: string): Promise<FileMetadata> {
    try {
      const stats = await fs.stat(filePath);

      return {
        size: stats.size,
        lastModified: stats.mtime,
        format: path.extname(filePath).toUpperCase(),
        compressedSize: stats.size,
      };
    } catch (error) {
      console.error("Error extracting archive metadata:", error);
      const stats = await fs.stat(filePath);
      return {
        size: stats.size,
        lastModified: stats.mtime,
        format: path.extname(filePath).toUpperCase(),
      };
    }
  }

  /**
   * Extrae metadatos según el tipo de archivo
   */
  static async extractMetadata(
    filePath: string,
    mimeType: string,
    fileName: string,
  ): Promise<FileMetadata> {
    try {
      if (mimeType.startsWith("image/")) {
        return await this.extractImageMetadata(filePath);
      } else if (mimeType === "application/pdf") {
        return await this.extractPDFMetadata(filePath);
      } else if (mimeType.startsWith("text/")) {
        return await this.extractTextMetadata(filePath, mimeType);
      } else if (
        mimeType.includes("zip") ||
        mimeType.includes("rar") ||
        mimeType.includes("tar")
      ) {
        return await this.extractArchiveMetadata(filePath);
      } else {
        // Metadatos básicos para otros tipos
        const fileStats = await fs.stat(filePath);
        return {
          size: fileStats.size,
          lastModified: fileStats.mtime,
          format: path.extname(fileName).toUpperCase(),
        };
      }
    } catch (error) {
      console.error("Error extracting metadata:", error);
      const fileStats = await fs.stat(filePath);
      return {
        size: fileStats.size,
        lastModified: fileStats.mtime,
      };
    }
  }

  /**
   * Limpia thumbnails antiguos (más de 30 días)
   */
  static async cleanupOldThumbnails(): Promise<void> {
    try {
      const thumbnailDir = path.join(process.cwd(), this.THUMBNAIL_DIR);
      const files = await fs.readdir(thumbnailDir);
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

      for (const file of files) {
        const filePath = path.join(thumbnailDir, file);
        const stats = await fs.stat(filePath);

        if (stats.mtime.getTime() < thirtyDaysAgo) {
          await fs.unlink(filePath);
          console.log(`Deleted old thumbnail: ${file}`);
        }
      }
    } catch (error) {
      console.error("Error cleaning up thumbnails:", error);
    }
  }

  /**
   * Obtiene información de un thumbnail existente
   */
  static async getThumbnailInfo(
    fileName: string,
  ): Promise<ThumbnailInfo | null> {
    try {
      const thumbnailDir = path.join(process.cwd(), this.THUMBNAIL_DIR);
      const files = await fs.readdir(thumbnailDir);

      // Buscar thumbnail que coincida con el nombre del archivo
      const thumbnailFile = files.find((file) =>
        file.includes(path.basename(fileName, path.extname(fileName))),
      );

      if (thumbnailFile) {
        const thumbnailPath = path.join(thumbnailDir, thumbnailFile);

        return {
          path: thumbnailPath,
          size: { width: this.THUMBNAIL_SIZE, height: this.THUMBNAIL_SIZE },
          url: `/thumbnails/${thumbnailFile}`,
        };
      }

      return null;
    } catch (error) {
      console.error("Error getting thumbnail info:", error);
      return null;
    }
  }
}

export default FileProcessingService;
