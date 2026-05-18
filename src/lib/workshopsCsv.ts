import Papa from "papaparse";
import { ApiError } from "./errors";

// Estructura de una fila del sheet de IMAS. Las columnas reales pueden
// venir con espacios o variaciones de mayúsculas; las normalizamos al
// parsear.
export interface WorkshopRow {
  workshop: string;
  mercado: string;
  fecha: string; // raw del sheet, ej "12/05/2026"
  horario: string;
  detalle: string;
  requisitos: string;
  link: string;
  // Cualquier columna extra que aparezca, por si la queremos en logs.
  raw: Record<string, string>;
}

// Mapa de variantes posibles del header en el sheet → clave canónica.
// Comparamos en minúsculas y sin acentos.
const HEADER_MAP: Record<string, keyof Omit<WorkshopRow, "raw">> = {
  workshop: "workshop",
  mercado: "mercado",
  fecha: "fecha",
  horario: "horario",
  hora: "horario",
  "detalle para el evento": "detalle",
  detalle: "detalle",
  descripcion: "detalle",
  requisitos: "requisitos",
  "link para inscripcion": "link",
  "link de inscripcion": "link",
  link: "link",
  url: "link",
  inscripcion: "link",
};

const normalizeHeader = (h: string): string =>
  h
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

// Convierte un URL de "edit?gid=..." a un URL de export CSV. Si ya es un
// export, lo deja como está.
export const toCsvExportUrl = (sheetUrl: string): string => {
  const idMatch = sheetUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!idMatch) {
    throw new ApiError(
      "INVALID_SHEET_URL",
      "URL de Google Sheet inválida: no se pudo extraer el ID.",
      400,
    );
  }
  const sheetId = idMatch[1];
  // gid puede venir en query ("?gid=123") o hash ("#gid=123").
  const gidMatch =
    sheetUrl.match(/[?&#]gid=([0-9]+)/) ?? sheetUrl.match(/#gid=([0-9]+)/);
  const gid = gidMatch ? gidMatch[1] : "0";
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
};

// Fetcha el CSV. Si el sheet no es público, Google devuelve HTML con un
// formulario de login → detectamos eso y damos un error útil.
export const fetchSheetCsv = async (sheetUrl: string): Promise<string> => {
  const exportUrl = toCsvExportUrl(sheetUrl);
  const resp = await fetch(exportUrl, {
    redirect: "follow",
  });
  if (!resp.ok) {
    throw new ApiError(
      "SHEET_FETCH_FAILED",
      `No se pudo descargar el sheet (HTTP ${resp.status}). Verificá que esté compartido como "Cualquiera con el enlace puede ver".`,
      502,
    );
  }
  const text = await resp.text();
  // Google devuelve HTML si pide login. CSV nunca empieza con '<'.
  if (text.trimStart().startsWith("<")) {
    throw new ApiError(
      "SHEET_NOT_PUBLIC",
      "El sheet no es accesible sin login. Compartilo como \"Cualquiera con el enlace puede ver\" y volvé a intentar.",
      403,
    );
  }
  return text;
};

// Parsea el CSV a filas tipadas. Mapea headers heurísticamente.
export const parseWorkshopsCsv = (csv: string): WorkshopRow[] => {
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  if (parsed.errors.length > 0) {
    // Solo loggeamos: el parser de papaparse suele recuperarse de errores
    // de columnas inconsistentes y aun así devolver data útil.
    // logger.warn(...) — el caller decide qué hacer.
  }

  const rows: WorkshopRow[] = [];
  for (const raw of parsed.data) {
    if (!raw || typeof raw !== "object") continue;
    const row: WorkshopRow = {
      workshop: "",
      mercado: "",
      fecha: "",
      horario: "",
      detalle: "",
      requisitos: "",
      link: "",
      raw,
    };
    for (const [k, v] of Object.entries(raw)) {
      const norm = normalizeHeader(k);
      const target = HEADER_MAP[norm];
      if (target) {
        row[target] = (v ?? "").toString().trim();
      }
    }
    // Solo incluimos filas que al menos tengan workshop o mercado, las
    // filas totalmente vacías o solo con encabezados secundarios se
    // descartan.
    if (row.workshop || row.mercado) {
      rows.push(row);
    }
  }
  return rows;
};
