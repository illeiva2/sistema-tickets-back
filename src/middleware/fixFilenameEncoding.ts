import { Request, Response, NextFunction } from "express";

// busboy (detrás de multer) entrega `file.originalname` decodificado como
// latin1, pero los browsers modernos mandan los bytes del nombre en UTF-8
// crudo. Resultado: caracteres como ñ, á, é llegan corruptos. Esta función
// reinterpreta los bytes como UTF-8 antes de que el controller toque el
// nombre, dejando los ASCII puros sin cambios.
const reinterpretAsUtf8 = (name: string): string => {
  try {
    return Buffer.from(name, "latin1").toString("utf8");
  } catch {
    return name;
  }
};

export const fixFilenameEncoding = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (file?.originalname) {
    file.originalname = reinterpretAsUtf8(file.originalname);
  }

  const files = (req as Request & { files?: Express.Multer.File[] }).files;
  if (Array.isArray(files)) {
    for (const f of files) {
      if (f?.originalname) {
        f.originalname = reinterpretAsUtf8(f.originalname);
      }
    }
  }

  next();
};
