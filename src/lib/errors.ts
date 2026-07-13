import { Request, Response, NextFunction } from "express";
import { logger } from "./logger";
import { v4 as uuidv4 } from "uuid";

export class ApiError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: any;

  constructor(
    code: string,
    message: string,
    statusCode: number = 500,
    details?: any,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.name = "ApiError";
  }
}

export const errorHandler = (
  error: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
) => {
  const requestId = (req.headers["x-request-id"] as string) || uuidv4();

  if (error instanceof ApiError) {
    logger.warn({
      requestId,
      error: error.code,
      message: error.message,
      statusCode: error.statusCode,
      url: req.url,
      method: req.method,
    });

    return res.status(error.statusCode).json({
      success: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
        requestId,
      },
    });
  }

  // Errores de multer: tratarlos como 400 con mensaje legible.
  // Detectamos por nombre de clase para no acoplar el import fuerte.
  if (error.name === "MulterError") {
    const multerCode = (error as Error & { code?: string }).code ?? "MULTER_ERROR";
    let message = "Error procesando el archivo";
    if (multerCode === "LIMIT_FILE_SIZE") {
      message = "El archivo excede el tamaño máximo permitido";
    } else if (multerCode === "LIMIT_FILE_COUNT") {
      message = "Demasiados archivos en una sola subida";
    } else if (multerCode === "LIMIT_UNEXPECTED_FILE") {
      message = "Campo de archivo inesperado";
    }

    logger.warn({
      requestId,
      error: multerCode,
      message,
      url: req.url,
      method: req.method,
    });

    return res.status(400).json({
      success: false,
      error: {
        code: multerCode,
        message,
        requestId,
      },
    });
  }

  if ((error as Error & { type?: string }).type === "entity.too.large") {
    logger.warn({
      requestId,
      error: "PAYLOAD_TOO_LARGE",
      url: req.url,
      method: req.method,
    });
    return res.status(413).json({
      success: false,
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "El cuerpo de la solicitud excede el tamaño permitido",
        requestId,
      },
    });
  }

  // Log unexpected errors.
  logger.error({
    requestId,
    error: error.name,
    message: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
  });

  return res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "Error interno del servidor",
      requestId,
    },
  });
};

export const notFoundHandler = (req: Request, res: Response) => {
  const requestId = (req.headers["x-request-id"] as string) || uuidv4();

  logger.warn({
    requestId,
    error: "NOT_FOUND",
    url: req.url,
    method: req.method,
  });

  res.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: "Endpoint no encontrado",
      requestId,
    },
  });
};
