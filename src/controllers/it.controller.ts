import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { getItOverview } from "../services/it.service";

export class ItController {
  static overview = async (
    _req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const data = await getItOverview();
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };
}

export default ItController;
