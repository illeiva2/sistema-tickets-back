-- Enlace medicion -> muestra registrada.
--
-- La ingesta lee la accesion (M-0012-4) de lo que el operario tipeo en el
-- equipo (sampleRef) y la resuelve a lab_samples.id. Columna nullable: las
-- mediciones historicas y las que no tipearon una accesion valida quedan con
-- null, y el sampleRef crudo se conserva para re-enlazar despues.
--
-- ON DELETE SET NULL: borrar (logicamente nunca; fisicamente jamas deberia
-- pasar) una muestra no puede arrastrar mediciones.
--
-- Solo ALTER ADD COLUMN, indice y FK. Nada destructivo.

-- AlterTable
ALTER TABLE "lab_measurements" ADD COLUMN     "sampleId" TEXT;

-- CreateIndex
CREATE INDEX "lab_measurements_sampleId_idx" ON "lab_measurements"("sampleId");

-- AddForeignKey
ALTER TABLE "lab_measurements" ADD CONSTRAINT "lab_measurements_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "lab_samples"("id") ON DELETE SET NULL ON UPDATE CASCADE;
