import { prisma } from "../lib/database";

export interface SimpleFileInfo {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageUrl: string;
  ticketId: string;
  createdAt: Date;
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
      },
      orderBy: { createdAt: "desc" },
    });

    return attachments;
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
  static async searchFiles(query: string): Promise<SimpleFileInfo[]> {
    const attachments = await prisma.attachment.findMany({
      where: {
        fileName: { contains: query, mode: "insensitive" },
      },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        sizeBytes: true,
        storageUrl: true,
        ticketId: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 50, // Limitar resultados
    });

    return attachments;
  }
}

export default FileOrganizationService;
