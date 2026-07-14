import { NextFunction, Response } from "express";
import { z } from "zod";
import { ApiError } from "../lib/errors";
import { AuthenticatedRequest } from "../middleware/auth";
import { validate } from "../middleware/validation";
import NetworkService from "../services/network.service";
import {
  createDeviceSchema,
  createLinkSchema,
  createSiteSchema,
  createTopologyViewSchema,
  deleteLinkSchema,
  deviceFiltersSchema,
  deviceIdParamsSchema,
  linkFiltersSchema,
  linkIdParamsSchema,
  siteFiltersSchema,
  siteIdParamsSchema,
  topologyLayoutSchema,
  topologyViewFiltersSchema,
  topologyViewIdParamsSchema,
  updateDeviceSchema,
  updateLinkSchema,
  updateSiteSchema,
  updateTopologyViewSchema,
} from "../validations/network";

const authenticated = (req: AuthenticatedRequest) => {
  if (!req.user) throw new ApiError("UNAUTHORIZED", "Usuario no autenticado", 401);
  return req.user;
};

const handler = (
  work: (req: AuthenticatedRequest) => Promise<unknown>,
  key?: "site" | "device" | "link" | "view",
  status = 200,
) => async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    authenticated(req);
    const result = await work(req);
    res.status(status).json({ success: true, data: key ? { [key]: result } : result });
  } catch (error) {
    next(error);
  }
};

export class NetworkController {
  static lookups = [
    handler(async () => NetworkService.lookups()),
  ];

  static listSites = [
    validate(z.object({ query: siteFiltersSchema })),
    handler(async (req) => NetworkService.listSites(req.query as any)),
  ];

  static getSite = [
    validate(z.object({ params: siteIdParamsSchema })),
    handler(async (req) => NetworkService.getSite(req.params.id), "site"),
  ];

  static createSite = [
    validate(z.object({ body: createSiteSchema })),
    handler(
      async (req) => NetworkService.createSite(req.body, authenticated(req).id),
      "site",
      201,
    ),
  ];

  static updateSite = [
    validate(z.object({ params: siteIdParamsSchema, body: updateSiteSchema })),
    handler(
      async (req) => NetworkService.updateSite(req.params.id, req.body, authenticated(req).id),
      "site",
    ),
  ];

  static listDevices = [
    validate(z.object({ query: deviceFiltersSchema })),
    handler(async (req) => NetworkService.listDevices(req.query as any)),
  ];

  static getDevice = [
    validate(z.object({ params: deviceIdParamsSchema })),
    handler(async (req) => NetworkService.getDevice(req.params.id), "device"),
  ];

  static createDevice = [
    validate(z.object({ body: createDeviceSchema })),
    handler(
      async (req) => NetworkService.createDevice(req.body, authenticated(req).id),
      "device",
      201,
    ),
  ];

  static updateDevice = [
    validate(z.object({ params: deviceIdParamsSchema, body: updateDeviceSchema })),
    handler(
      async (req) => NetworkService.updateDevice(req.params.id, req.body, authenticated(req).id),
      "device",
    ),
  ];

  static listLinks = [
    validate(z.object({ query: linkFiltersSchema })),
    handler(async (req) => NetworkService.listLinks(req.query as any)),
  ];

  static getLink = [
    validate(z.object({ params: linkIdParamsSchema })),
    handler(async (req) => NetworkService.getLink(req.params.id), "link"),
  ];

  static createLink = [
    validate(z.object({ body: createLinkSchema })),
    handler(
      async (req) => NetworkService.createLink(req.body, authenticated(req).id),
      "link",
      201,
    ),
  ];

  static updateLink = [
    validate(z.object({ params: linkIdParamsSchema, body: updateLinkSchema })),
    handler(
      async (req) => NetworkService.updateLink(req.params.id, req.body, authenticated(req).id),
      "link",
    ),
  ];

  static deleteLink = [
    validate(z.object({ params: linkIdParamsSchema, body: deleteLinkSchema })),
    handler(async (req) =>
      NetworkService.deleteLink(req.params.id, req.body, authenticated(req).id)),
  ];

  static listTopologyViews = [
    validate(z.object({ query: topologyViewFiltersSchema })),
    handler(async (req) => NetworkService.listTopologyViews(req.query as any)),
  ];

  static getTopologyView = [
    validate(z.object({ params: topologyViewIdParamsSchema })),
    handler(async (req) => NetworkService.getTopologyView(req.params.id), "view"),
  ];

  static createTopologyView = [
    validate(z.object({ body: createTopologyViewSchema })),
    handler(
      async (req) =>
        NetworkService.createTopologyView(req.body, authenticated(req).id),
      "view",
      201,
    ),
  ];

  static updateTopologyView = [
    validate(
      z.object({ params: topologyViewIdParamsSchema, body: updateTopologyViewSchema }),
    ),
    handler(
      async (req) =>
        NetworkService.updateTopologyView(req.params.id, req.body, authenticated(req).id),
      "view",
    ),
  ];

  static updateTopologyLayout = [
    validate(z.object({ params: topologyViewIdParamsSchema, body: topologyLayoutSchema })),
    handler(
      async (req) =>
        NetworkService.updateTopologyLayout(req.params.id, req.body, authenticated(req).id),
      "view",
    ),
  ];
}

export default NetworkController;
