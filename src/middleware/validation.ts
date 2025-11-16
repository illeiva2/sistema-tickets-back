import { Request, Response, NextFunction } from "express";
import { AnyZodObject, ZodError } from "zod";
import { ApiError } from "../lib/errors";

export const validate = (schema: AnyZodObject) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });

      // Asignar los valores parseados/coercionados de vuelta al request
      if (parsed && typeof parsed === "object") {
        if (Object.prototype.hasOwnProperty.call(parsed, "body")) {
          req.body = parsed.body;
        }
        if (Object.prototype.hasOwnProperty.call(parsed, "query")) {
          req.query = parsed.query as any;
        }
        if (Object.prototype.hasOwnProperty.call(parsed, "params")) {
          req.params = parsed.params as any;
        }
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const details = error.errors.map((err) => ({
          field: err.path.join("."),
          message: err.message,
        }));

        next(
          new ApiError(
            "VALIDATION_ERROR",
            "Datos de entrada inválidos",
            400,
            details,
          ),
        );
      } else {
        next(error);
      }
    }
  };
};
