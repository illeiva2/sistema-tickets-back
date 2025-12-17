import { prisma } from "../lib/database";

export interface SimpleFileInfo {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageUrl: string;
  ticketId: string;
  createdAt: Date;
  organization?: {
    id: string;
    categoryId: string | null;
    tags: string[];
    customPath: string | null;
  } | null;
}

export class FileOrganizationService {
  /**
   * Obtiene información básica de archivos de un ticket
   */
  static async getTicketFiles(ticketId: string): Promise<SimpleFileInfo[]> {
    const attachments = await prisma.attachment.findMany({
      where: { ticketId },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        sizeBytes: true,
        storageUrl: true,
        ticketId: true,
        createdAt: true,
        organizations: {
          select: {
            id: true,
            categoryId: true,
            tags: true,
            customPath: true,
          },
          take: 1
        }
      },
      orderBy: { createdAt: "desc" },
    });

    return attachments.map(att => ({
      ...att,
      organization: att.organizations[0] || null,
      organizations: undefined
    }));
  }

  /**
   * Obtiene estadísticas básicas de archivos
   */
  static async getFileStats(): Promise<{
    totalFiles: number;
    totalSize: number;
    averageFileSize: number;
  }> {
    const stats = await prisma.attachment.aggregate({
      _count: { id: true },
      _sum: { sizeBytes: true },
      _avg: { sizeBytes: true },
    });

    return {
      totalFiles: stats._count.id || 0,
      totalSize: stats._sum.sizeBytes || 0,
      averageFileSize: Math.round((stats._avg.sizeBytes || 0) / 1024), // KB
    };
  }

  /**
   * Busca archivos por nombre
   */
  /**
   * Busca archivos por nombre
   */
  static async searchFiles(query: string, userId: string, role: string): Promise<SimpleFileInfo[]> {
    const whereClause: any = {};

    // Filtro por texto (opcional)
    if (query && query.trim() !== "") {
      whereClause.fileName = { contains: query, mode: "insensitive" };
    }

    // Filtro por permisos
    if (role !== "ADMIN" && role !== "AGENT") {
      whereClause.ticket = {
        requesterId: userId
      };
    }

    const attachments = await prisma.attachment.findMany({
      where: whereClause,
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        sizeBytes: true,
        storageUrl: true,
        ticketId: true,
        createdAt: true,
        organizations: {
          select: {
            id: true,
            categoryId: true,
            tags: true,
            customPath: true,
          },
          take: 1
        }
      },
      orderBy: { createdAt: "desc" },
      take: 50, // Limitar resultados
    });

    return attachments.map(att => ({
      ...att,
      organization: att.organizations[0] || null,
      organizations: undefined
    }));
  }

  /**
   * Obtiene todas las categorías de archivos
   */
  static async getCategories() {
    return prisma.fileCategory.findMany({
      orderBy: { name: "asc" },
      include: {
        _count: {
          select: { organizations: true }
        }
      }
    });
  }

  /**
   * Obtiene todas las etiquetas de archivos
   */
  static async getTags() {
    // Note: Since tags are stored as array of IDs in FileOrganization, 
    // getting usage count is harder. For now just returning tags.
    // If FileTag existed as many-to-many relation properly defined in Prisma schema:
    // organizations FileOrganization[]
    // But schema says: tags String[] // Array de IDs de etiquetas
    // Wait, let's check schema provided in view_file earlier.
    // model FileTag { id, name ... } with no relation back to FileOrganization?
    // Oh, FileOrganization has `tags String[]`.
    // So we can just return all tags.
    return prisma.fileTag.findMany({
      orderBy: { name: "asc" },
    });
  }
}

export default FileOrganizationService;
