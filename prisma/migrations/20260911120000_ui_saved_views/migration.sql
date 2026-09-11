-- Vistas personalizables por usuario (columnas, orden, ordenamiento), indexadas
-- por clave de vista. Aditivo: la tabla ya existía con theme/darkMode/layout.
ALTER TABLE "user_ui_preferences" ADD COLUMN "savedViews" JSONB;
