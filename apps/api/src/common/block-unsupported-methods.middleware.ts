import { NextFunction, Request, Response } from 'express';

export function blockUnsupportedMethods(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'TRACE' || req.method === 'TRACK') {
    res.status(405).end();
    return;
  }
  next();
}
