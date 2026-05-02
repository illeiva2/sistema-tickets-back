// Setup global de vitest. Setea env vars de test antes de que la app
// importe el config, así no leemos secretos reales y no necesitamos
// .env de test.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-do-not-use-in-prod";
process.env.JWT_EXPIRES_IN = "1h";
process.env.JWT_REFRESH_EXPIRES_IN = "7d";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.EMAIL_FROM = "noreply@test.local";
process.env.EMAIL_USER = "test";
process.env.EMAIL_PASSWORD = "test";
process.env.CLOUDINARY_CLOUD_NAME = "test";
process.env.CLOUDINARY_API_KEY = "test";
process.env.CLOUDINARY_API_SECRET = "test";
process.env.GOOGLE_CLIENT_ID = "test";
process.env.GOOGLE_CLIENT_SECRET = "test";
process.env.GOOGLE_CALLBACK_URL = "http://localhost:3001/api/auth/google/callback";
process.env.FRONTEND_URL = "http://localhost:5173";
