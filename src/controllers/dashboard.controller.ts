import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import {
  getUserDashboard,
  getAgentDashboard,
  getAdminDashboard,
  parsePeriod,
} from "../services/dashboard.service";

export class DashboardController {
  static get = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
        });
      }

      const period = parsePeriod(req.query.period as string | undefined);
      const role = req.user.role;

      let data;
      if (role === "USER") {
        data = await getUserDashboard(req.user.id, period);
      } else if (role === "AGENT") {
        data = await getAgentDashboard(req.user.id, period);
      } else {
        data = await getAdminDashboard(period);
      }

      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  };
}

export default DashboardController;
