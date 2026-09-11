import { NextFunction, Request, Response } from "express";
import UiPreferencesService from "../services/uiPreferences.service";

/** El controller solo traduce params/body; la regla vive en el service. */
const handler =
  (fn: (req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await fn(req) });
    } catch (err) {
      next(err);
    }
  };

export class UiPreferencesController {
  // req.user lo garantiza authMiddleware, que corre antes en el router.
  static get = handler((req) => UiPreferencesService.get(req.user!.id));

  static saveView = handler((req) =>
    UiPreferencesService.saveView(req.user!.id, String(req.params.viewKey), req.body.config),
  );

  static deleteView = handler((req) =>
    UiPreferencesService.deleteView(req.user!.id, String(req.params.viewKey)),
  );
}

export default UiPreferencesController;
