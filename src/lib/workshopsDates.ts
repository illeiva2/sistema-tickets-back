// Helpers de fechas para la importación de workshops.
// El sheet de IMAS usa formato DD/MM/YYYY o DD/MM (sin año, asume el actual).

// Parsea "DD/MM/YYYY" o "DD/MM" (asume año actual o próximo si la fecha
// ya pasó). Devuelve un Date a las 00:00 hora local, o null si no parsea.
export const parseSheetDate = (raw: string, now: Date = new Date()): Date | null => {
  if (!raw) return null;
  const cleaned = raw.trim();
  // Acepta separador / o -, y con o sin año.
  const m = cleaned.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if (!m) {
    // Como fallback intentamos Date.parse para ISO u otros formatos.
    const d = new Date(cleaned);
    return isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10) - 1;
  let year = m[3] ? parseInt(m[3], 10) : now.getFullYear();
  if (year < 100) year += 2000;
  const date = new Date(year, month, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
};

// Devuelve el último día del mes (a las 23:59:59) de `now`.
export const endOfMonth = (now: Date = new Date()): Date => {
  return new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
};

// Devuelve `now` + 7 días, a las 23:59:59.
export const endOfWeek = (now: Date = new Date()): Date => {
  const d = new Date(now);
  d.setDate(d.getDate() + 7);
  d.setHours(23, 59, 59, 999);
  return d;
};

// Devuelve hoy a las 00:00 (start of today, local).
export const startOfToday = (now: Date = new Date()): Date => {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
};

// Clave de período para idempotencia.
// monthly → "YYYY-MM"
// weekly  → "YYYY-Www" (semana ISO)
// Devuelve la clave "YYYY-MM" de una fecha dada. Usado por el modo
// upcoming para derivar el período del propio contenido del sheet (mes de
// la primera fecha futura) en vez del mes calendario actual.
export const monthKeyOf = (d: Date): string => {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
};

export const getPeriodKey = (
  mode: "weekly" | "monthly" | "upcoming",
  now: Date = new Date(),
): string => {
  if (mode === "monthly" || mode === "upcoming") {
    return monthKeyOf(now);
  }
  // ISO week. Algoritmo estándar.
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
};

// Formato display "DD/MM" o "DD/MM/YYYY si es de otro año".
export const formatDisplayDate = (d: Date, now: Date = new Date()): string => {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  if (d.getFullYear() !== now.getFullYear()) {
    return `${dd}/${mm}/${d.getFullYear()}`;
  }
  return `${dd}/${mm}`;
};
