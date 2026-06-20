/**
 * Convierte un texto en un slug URL-safe.
 * "Cómo configurar el VPN" → "como-configurar-el-vpn"
 */
export const slugify = (text: string): string => {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 80);
};

/**
 * Dado un slug base y una función para verificar si existe, devuelve un
 * slug único agregando "-2", "-3", etc. hasta que no colisione.
 */
export const ensureUniqueSlug = async (
  base: string,
  exists: (slug: string) => Promise<boolean>,
): Promise<string> => {
  let candidate = base || "recurso";
  let n = 2;
  while (await exists(candidate)) {
    candidate = `${base}-${n}`;
    n++;
    if (n > 100) {
      // Failsafe: si por alguna razón hay 100+ colisiones, corta con timestamp.
      candidate = `${base}-${Date.now()}`;
      break;
    }
  }
  return candidate;
};
