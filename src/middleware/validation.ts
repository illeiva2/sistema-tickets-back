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

      // Asignar los valores parseados/coercionados (zod hace coerce de
      // strings a numbers, etc.) de vuelta al request. Usamos `as any`
      // porque Express tipa req.query y req.params como objetos rígidos
      // (ParsedQs y ParamsDictionary respectivamente) y rechaza el shape
      // generico que devuelve zod. Es seguro: validation runtime ya pasó.
      if (parsed && typeof parsed === "object") {
        if (Object.prototype.hasOwnProperty.call(parsed, "body")) {
          req.body = parsed.body;
        }
        if (Object.prototype.hasOwnProperty.call(parsed, "query")) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          req.query = parsed.query as any;
        }
        if (Object.prototype.hasOwnProperty.call(parsed, "params")) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
