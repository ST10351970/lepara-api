import type { Response } from 'express';

/** The success envelope: { success: true, data, meta? } */

export type PageMeta = { page: number; pageSize: number; total: number; totalPages: number };

export function ok<T>(res: Response, data: T, meta?: PageMeta): void {
  res.status(200).json({ success: true, data, ...(meta ? { meta } : {}) });
}

export function created<T>(res: Response, data: T): void {
  res.status(201).json({ success: true, data });
}
