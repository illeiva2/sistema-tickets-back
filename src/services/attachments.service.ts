import path from "path";
import fs from "fs/promises";
import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import FileValidationService from "./fileValidation.service";
import FilePreviewService from "./filePreview.service";
import cloudinary from "../lib/cloudinary";
import streamifier from "streamifier";

export class AttachmentsService {
  static async listByTicket(ticketId: string) {
    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket)
      throw new ApiError("TICKET_NOT_FOUND", "Ticket no encontrado", 404);

    const attachments = await prisma.attachment.findMany({
      where: { ticketId },
      orderBy: { createdAt: "desc" },
    });

    // Enriquecer con información de vista previa
    const enrichedAttachments = await Promise.all(
      attachments.map(async (attachment) => {
        try {
          const isCloudinary = attachment.storageUrl.startsWith("http");
          
          let previewInfo;
          if (isCloudinary) {
            // Para Cloudinary, usamos la URL directamente
            previewInfo = await FilePreviewService.getFilePreviewInfo(
              attachment.storageUrl,
              attachment.mimeType,
              attachment.fileName,
              true // remote
            );
          } else {
            const filePath = path.join(
              process.cwd(),
              attachment.storageUrl.replace(/^\/uploads\//, "uploads/"),
            );
            previewInfo = await FilePreviewService.getFilePreviewInfo(
              filePath,
              attachment.mimeType,
              attachment.fileName,
              false // local
            );
          }

          const displayInfo = FilePreviewService.getFileDisplayInfo(
            attachment.fileName,
            attachment.mimeType,
            attachment.sizeBytes,
          );

          return {
            ...attachment,
            previewInfo,
            displayInfo,
          };
        } catch (error) {
          console.error("Error enriching attachment:", error);
          return attachment;
        }
      }),
    );

    return enrichedAttachments;
  }

  static async create(ticketId: string, file: Express.Multer.File) {
    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket)
      throw new ApiError("TICKET_NOT_FOUND", "Ticket no encontrado", 404);

    // Validar archivo antes de procesarlo
    FileValidationService.validateFile(file);

    // Verificar límite de archivos por ticket
    const canAddMore = await FileValidationService.canAddMoreFiles(ticketId);
    if (!canAddMore) {
      const config = FileValidationService.getConfig();
      throw new ApiError(
        "FILE_LIMIT_EXCEEDED",
        `No se pueden agregar más archivos. Límite: ${config.maxFilesPerTicket}`,
        400,
      );
    }

    // Subir a Cloudinary usando un stream
    const uploadToCloudinary = (): Promise<any> => {
      return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: "tickets",
            resource_type: "auto",
            public_id: `${Date.now()}-${this.sanitizeFileName(file.originalname).split(".")[0]}`,
          },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        );
        streamifier.createReadStream(file.buffer).pipe(uploadStream);
      });
    };

    let result;
    try {
      result = await uploadToCloudinary();
    } catch (error) {
      console.error("Cloudinary upload error:", error);
      throw new ApiError("FILE_UPLOAD_ERROR", "Error al subir archivo a la nube", 500);
    }

    const storageUrl = result.secure_url;

    // Crear registro en base de datos
    const created = await prisma.attachment.create({
      data: {
        ticketId,
        fileName: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        storageUrl,
      },
    });

    // Crear entrada de organización de archivo por defecto
    await prisma.fileOrganization.create({
      data: {
        attachmentId: created.id,
        tags: [],
        categoryId: null,
      },
    });

    return created;
  }

  static async delete(id: string) {
    const attachment = await prisma.attachment.findUnique({ where: { id } });
    if (!attachment)
      throw new ApiError("ATTACHMENT_NOT_FOUND", "Adjunto no encontrado", 404);

    // Eliminar archivo
    try {
      if (attachment.storageUrl.startsWith("http")) {
        // Eliminar de Cloudinary
        // La URL tiene formato: https://res.cloudinary.com/cloud_name/image/upload/v12345/folder/public_id.ext
        const publicId = attachment.storageUrl
          .split("/")
          .slice(-2)
          .join("/")
          .split(".")[0];
        
        await cloudinary.uploader.destroy(publicId);
      } else {
        // Eliminar archivo físico local (retrocompatibilidad)
        const filePath = path.join(
          process.cwd(),
          attachment.storageUrl.replace(/^\/uploads\//, "uploads/"),
        );
        await fs.unlink(filePath);
      }
    } catch (error) {
      console.error("Error deleting file:", error);
    }

    // Eliminar registro de la base de datos
    await prisma.attachment.delete({ where: { id } });

    return { message: "Adjunto eliminado correctamente" };
  }

  /**
   * Sanitiza el nombre del archivo para evitar problemas de seguridad
   */
  private static sanitizeFileName(fileName: string): string {
    // Remover caracteres peligrosos
    let sanitized = fileName
      .replace(/[<>:"/\\|?*]/g, "_")
      .replace(/\.+/g, ".")
      .replace(/^\.+|\.+$/g, "");

    // Limitar longitud
    if (sanitized.length > 100) {
      const extension = path.extname(sanitized);
      const nameWithoutExt = path.basename(sanitized, extension);
      sanitized =
        nameWithoutExt.substring(0, 100 - extension.length) + extension;
    }

    // Si quedó vacío, usar nombre por defecto
    if (!sanitized || sanitized.trim().length === 0) {
      sanitized = "archivo";
    }

    return sanitized;
  }

  /**
   * Obtiene información del archivo
   */
  static async getFileInfo(id: string) {
    const attachment = await prisma.attachment.findUnique({
      where: { id },
      include: {
        ticket: {
          select: {
            id: true,
            title: true,
            ticketNumber: true,
          },
        },
      },
    });

    if (!attachment)
      throw new ApiError("ATTACHMENT_NOT_FOUND", "Adjunto no encontrado", 404);

    return attachment;
  }

  /**
   * Verifica si un archivo existe y es accesible
   */
  static async fileExists(id: string): Promise<boolean> {
    try {
      const attachment = await prisma.attachment.findUnique({ where: { id } });
      if (!attachment) return false;

      if (attachment.storageUrl.startsWith("http")) {
        // Para archivos remotos, asumimos que existen si están en la BD
        // Opcional: Podríamos hacer una petición HEAD a Cloudinary
        return true;
      }

      const filePath = path.join(
        process.cwd(),
        attachment.storageUrl.replace(/^\/uploads\//, "uploads/"),
      );

      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Busca un archivo por nombre de archivo
   */
  static async findByFileName(fileName: string) {
    return await prisma.attachment.findFirst({
      where: {
        OR: [
          { fileName: fileName },
          { storageUrl: `/uploads/${fileName}` },
          { storageUrl: fileName },
        ],
      },
      include: {
        ticket: {
          select: {
            id: true,
            requesterId: true,
            assigneeId: true,
          },
        },
      },
    });
  }

  /**
   * Verifica si un usuario tiene acceso a un archivo
   */
  static async verifyUserAccess(
    attachmentId: string,
    userId: string,
    userRole: string,
  ): Promise<boolean> {
    const attachment = await prisma.attachment.findUnique({
      where: { id: attachmentId },
      include: {
        ticket: {
          select: {
            requesterId: true,
            assigneeId: true,
          },
        },
      },
    });

    if (!attachment) return false;

    // Los admins y agentes tienen acceso completo
    if (userRole === "ADMIN" || userRole === "AGENT") {
      return true;
    }

    // Los usuarios solo pueden acceder a archivos de sus propios tickets
    return attachment.ticket?.requesterId === userId;
  }

  /**
   * Busca un archivo por nombre de thumbnail
   */
  static async findByThumbnailName(thumbnailName: string) {
    // Extraer el nombre base del archivo del thumbnail
    // El formato del thumbnail es: thumb-{timestamp}-{randomId}-{originalFileName}.webp
    const thumbnailParts = thumbnailName.split("-");
    if (thumbnailParts.length < 4) return null;

    // Reconstruir el nombre original del archivo
    const originalFileName = thumbnailParts
      .slice(3)
      .join("-")
      .replace(".webp", "");

    return await prisma.attachment.findFirst({
      where: {
        OR: [
          { fileName: originalFileName },
          { fileName: { contains: originalFileName } },
        ],
      },
      include: {
        ticket: {
          select: {
            id: true,
            requesterId: true,
            assigneeId: true,
          },
        },
      },
    });
  }
}

export default AttachmentsService;
