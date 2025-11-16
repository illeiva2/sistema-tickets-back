-- Add mustChangePassword field to users table
ALTER TABLE users ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;