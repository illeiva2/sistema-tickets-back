import type { WorkshopRow } from "./workshopsCsv";
import { formatDisplayDate } from "./workshopsDates";

export interface ClassifiedWorkshop {
  row: WorkshopRow;
  parsedDate: Date;
  whyText: string | null; // del classifier, específico para este sector
}

// Render del contenido markdown del Resource que se genera por sector.
// El título se setea aparte; este renderiza solo el body.
export const renderWorkshopsMarkdown = (
  workshops: ClassifiedWorkshop[],
  rangeEnd: Date,
  now: Date = new Date(),
): string => {
  if (workshops.length === 0) {
    return "_No hay workshops disponibles para tu sector en este período._";
  }

  // Ordenamos por fecha ascendente para que aparezcan en orden cronológico.
  const sorted = [...workshops].sort(
    (a, b) => a.parsedDate.getTime() - b.parsedDate.getTime(),
  );

  const intro = `Workshops IMAS disponibles hasta el **${formatDisplayDate(rangeEnd, now)}**:\n`;

  const items = sorted.map((w) => {
    const dateStr = formatDisplayDate(w.parsedDate, now);
    const time = (w.row.horario || "").trim();
    const heading = time
      ? `### ${w.row.workshop} — ${dateStr}, ${time}`
      : `### ${w.row.workshop} — ${dateStr}`;

    const parts: string[] = [heading];

    const detalle = (w.row.detalle || "").trim();
    if (detalle) {
      parts.push(detalle);
    }

    if (w.whyText && w.whyText.trim()) {
      parts.push(`**Por qué te sirve:** ${w.whyText.trim()}`);
    }

    const reqs = (w.row.requisitos || "").trim();
    if (reqs && reqs.toLowerCase() !== "ninguno") {
      parts.push(`**Requisitos:** ${reqs}`);
    }

    const link = (w.row.link || "").trim();
    if (link) {
      parts.push(`[📋 Inscripción](${link})`);
    }

    return parts.join("\n\n");
  });

  return [intro, ...items].join("\n\n");
};

// Excerpt corto: cuántos workshops + hasta cuándo.
export const renderWorkshopsExcerpt = (
  count: number,
  rangeEnd: Date,
  now: Date = new Date(),
): string => {
  const noun = count === 1 ? "workshop disponible" : "workshops disponibles";
  return `${count} ${noun} hasta el ${formatDisplayDate(rangeEnd, now)}. Tocá para ver detalles e inscripción.`;
};
