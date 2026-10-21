-- Análisis manuales: lo que se tipeó en el formulario (textos decimales y cápsulas), tal cual.
-- Aditiva: columna nueva y opcional; las mediciones existentes quedan con NULL.
ALTER TABLE "lab_measurements" ADD COLUMN "manualInput" JSONB;
