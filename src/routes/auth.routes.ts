import { Router } from "express";
import { AuthController } from "../controllers/auth.controller";
import { OAuthController } from "../controllers/oauth.controller";
import { authMiddleware } from "../middleware/auth";

const router = Router();

// Standard Auth
router.post("/login", AuthController.login);
router.post("/register", AuthController.register);
router.post("/setup-password", AuthController.setupPassword);
router.post("/refresh", AuthController.refreshToken);
router.get("/me", authMiddleware, AuthController.me);

// OAuth
router.get("/google", OAuthController.initiateGoogleAuth);
router.get("/google/callback", OAuthController.googleCallback);
// Note: /refresh is duplicated in original index.ts (one for AuthController, one for OAuthController).
// The OAuthController.refreshToken seems to be mapped to /api/auth/refresh in index.ts
// while AuthController.refreshToken is mapped to /api/auth/refresh inside the router.
// They likely serve a similar purpose but different implementations. 
// However, since express routers match in order, the one defined first takes precedence if paths are identical.
// In the original index.ts:
// 1. app.use("/api/auth", router) -> inside router: .post("/refresh", AuthController.refreshToken)
// 2. app.post("/api/auth/refresh", OAuthController.refreshToken)
// So AuthController.refreshToken would take precedence for POST /api/auth/refresh.
// I will keep AuthController.refreshToken here.
router.post("/logout", OAuthController.logout);

export default router;
