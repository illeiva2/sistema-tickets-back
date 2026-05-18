import type { WorkshopRow } from "./workshopsCsv";

// Slug del sector "Transversales" que recibe los workshops genéricos
// sin clasificación específica.
export const TRANSVERSALES_SLUG = "transversales";

// Estructura mínima de una regla cargada desde DB para el classifier.
// No usamos directamente el tipo Prisma para mantener el classifier puro.
export interface ClassifierRule {
  id: string;
  departmentId: string;
  departmentSlug: string;
  mercadoEquals: string | null;
  keywords: string[];
  whyText: string | null;
  enabled: boolean;
  priority: number;
}

// Normaliza un texto: lowercase + sin acentos + colapsa whitespace.
const normalize = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

// Devuelve true si el row contiene CUPO AGOTADO / EVENTO CERRADO en
// cualquier columna principal.
export const isClosedOrFull = (row: WorkshopRow): boolean => {
  const haystack = [
    row.workshop,
    row.mercado,
    row.fecha,
    row.horario,
    row.detalle,
    row.requisitos,
  ]
    .filter(Boolean)
    .map(normalize)
    .join(" | ");
  return (
    haystack.includes("cupo agotado") || haystack.includes("evento cerrado")
  );
};

// Chequea si la regla matchea el workshop:
// - Si mercadoEquals está seteado, debe coincidir (normalize).
// - Si keywords no está vacío, AL MENOS UNA debe aparecer en
//   (workshop + detalle) normalizados.
// - Si ambas condiciones están definidas, ambas deben dar true.
//   Si solo una está definida, esa decide.
//   Si ambas están vacías, la regla nunca matchea (regla mal cargada).
const ruleMatches = (rule: ClassifierRule, row: WorkshopRow): boolean => {
  const hasMercado = !!rule.mercadoEquals && rule.mercadoEquals.trim() !== "";
  const hasKeywords = rule.keywords.length > 0;
  if (!hasMercado && !hasKeywords) return false;

  if (hasMercado) {
    const expected = normalize(rule.mercadoEquals!);
    const actual = normalize(row.mercado || "");
    if (expected !== actual) return false;
  }

  if (hasKeywords) {
    const hay = normalize(`${row.workshop} ${row.detalle}`);
    const some = rule.keywords.some((kw) => {
      const k = normalize(kw);
      if (!k) return false;
      return hay.includes(k);
    });
    if (!some) return false;
  }

  return true;
};

export interface ClassificationMatch {
  departmentId: string;
  departmentSlug: string;
  // El whyText de la regla que generó este match, si tenía uno.
  whyText: string | null;
}

// Clasifica un workshop contra todas las reglas. Devuelve la lista de
// matches deduplicada por departmentId. Si ninguna regla matchea Y el
// mercado es "TODOS LOS MERCADOS", asigna a Transversales como fallback.
export const classifyWorkshop = (
  row: WorkshopRow,
  rules: ClassifierRule[],
  transversalesDeptId: string | null,
): ClassificationMatch[] => {
  const matched = new Map<string, ClassificationMatch>();
  // Iteramos por prioridad descendente para que la primer regla que
  // matchee un sector gane su whyText.
  const sortedRules = [...rules]
    .filter((r) => r.enabled)
    .sort((a, b) => b.priority - a.priority);

  for (const rule of sortedRules) {
    if (!ruleMatches(rule, row)) continue;
    if (matched.has(rule.departmentId)) continue;
    matched.set(rule.departmentId, {
      departmentId: rule.departmentId,
      departmentSlug: rule.departmentSlug,
      whyText: rule.whyText,
    });
  }

  if (matched.size === 0) {
    const mercado = normalize(row.mercado || "");
    if (mercado === "todos los mercados" && transversalesDeptId) {
      // Buscar el slug en el array de reglas (puede no estar) o devolver
      // el ID con un slug placeholder. El caller setea el slug correcto.
      matched.set(transversalesDeptId, {
        departmentId: transversalesDeptId,
        departmentSlug: TRANSVERSALES_SLUG,
        whyText: null,
      });
    }
  }

  return Array.from(matched.values());
};
