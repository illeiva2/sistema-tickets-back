import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { MANUAL_PARAMS } from "../lib/labAnalysisColumns";
import { parametrosManual, type ManualInput } from "../lib/labManual";
import type { ManualBody } from "../validations/lab.manual";

/**
 * Análisis hechos con equipos sin conexión (termobalanza, estufa, mufla,
 * colorímetro, balanza para PMG), cargados a mano desde la ficha de la muestra.
 *
 * Se guardan como una medición más, con origen MANUAL: así aparecen en la
 * ficha, en la grilla de Análisis, en el reporte diario y para el asistente
 * sin lógica aparte. La diferencia con las de los equipos es que tienen una
 * persona detrás (`createdById`) y se pueden corregir o dar de baja; las de
 * los instrumentos vienen del origen y no se tocan.
 *
 * Una muestra tiene UN análisis manual: se carga por partes (los pesos de la
 * balanza primero, el final al salir de la estufa o la mufla) y se completa o
 * corrige sobre el mismo. Lo tipeado queda tal cual en `manualInput`; los
 * resultados, calculados acá, en los parámetros (ver labManual.ts).
 */

const UNIDAD = new Map(MANUAL_PARAMS.map((p) => [p.code, p.unit ?? null]));
const MAX_FUTURO_MS = 24 * 60 * 60 * 1000;

const fechaDe = (raw: string | undefined): Date => {
  const d = raw ? new Date(raw) : new Date();
  if (Number.isNaN(d.getTime())) throw new ApiError("VALIDATION_ERROR", "Fecha del análisis inválida", 400);
  if (d.getTime() > Date.now() + MAX_FUTURO_MS) {
    throw new ApiError("VALIDATION_ERROR", "La fecha del análisis está en el futuro", 400);
  }
  return d;
};

/** Solo lo medido o calculado: lo que no se cargó no es un cero. */
const parametros = (input: ManualInput) =>
  parametrosManual(input).map(({ code, value }) => ({ code, value, unit: UNIDAD.get(code) ?? null }));

const INCLUDE = {
  params: { orderBy: { code: "asc" as const } },
  createdBy: { select: { id: true, name: true } },
};

export default class LabManualService {
  static async crear(sampleId: string, userId: string, body: ManualBody) {
    const sample = await prisma.labSample.findFirst({
      where: { id: sampleId, deletedAt: null },
      select: { id: true, accession: true },
    });
    if (!sample) throw new ApiError("NOT_FOUND", "Muestra inexistente", 404);
    // La ficha abre el que ya está; esto cubre a dos personas cargando a la vez.
    const existente = await prisma.labMeasurement.findFirst({
      where: { sampleId: sample.id, source: "MANUAL", deletedAt: null },
      select: { id: true },
    });
    if (existente) {
      throw new ApiError(
        "CONFLICT",
        "La muestra ya tiene un análisis manual: abrí de nuevo “Análisis manual” para completarlo o corregirlo",
        409,
        { id: existente.id },
      );
    }
    return prisma.labMeasurement.create({
      data: {
        source: "MANUAL",
        // No hay un id de origen: el registro nace acá.
        sourceId: randomUUID(),
        sampleId: sample.id,
        sampleRef: sample.accession,
        analyzedAt: fechaDe(body.analyzedAt),
        createdById: userId,
        manualInput: body.input as unknown as Prisma.InputJsonValue,
        params: { create: parametros(body.input) },
      },
      include: INCLUDE,
    });
  }

  /**
   * Completa o corrige el análisis (y la fecha si viene). Reemplaza lo tipeado
   * y los parámetros por los nuevos: es la edición explícita de un registro
   * cargado a mano, no una limpieza masiva.
   */
  static async actualizar(id: string, body: ManualBody) {
    const m = await this.manual(id);
    const analyzedAt = body.analyzedAt ? fechaDe(body.analyzedAt) : undefined;
    const [, actualizada] = await prisma.$transaction([
      prisma.labParameter.deleteMany({ where: { measurementId: m.id } }),
      prisma.labMeasurement.update({
        where: { id: m.id },
        data: {
          analyzedAt,
          manualInput: body.input as unknown as Prisma.InputJsonValue,
          params: { create: parametros(body.input) },
        },
        include: INCLUDE,
      }),
    ]);
    return actualizada;
  }

  /** Baja lógica, como las mediciones de los equipos: queda con `deletedAt`. */
  static async eliminar(id: string) {
    const m = await this.manual(id);
    await prisma.labMeasurement.update({ where: { id: m.id }, data: { deletedAt: new Date() } });
    return { id: m.id };
  }

  private static async manual(id: string) {
    const m = await prisma.labMeasurement.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, source: true },
    });
    if (!m) throw new ApiError("NOT_FOUND", "Análisis inexistente", 404);
    if (m.source !== "MANUAL") {
      throw new ApiError(
        "VALIDATION_ERROR",
        "Solo se editan los análisis cargados a mano; los de los equipos vienen del instrumento",
        400,
      );
    }
    return m;
  }
}
