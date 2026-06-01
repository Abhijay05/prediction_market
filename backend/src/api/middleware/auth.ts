// backend/src/api/middleware/auth.ts
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer "))
    return res.status(401).json({ error: "missing token" });

  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET!) as any;
    (req as any).user = { walletAddress: payload.walletAddress };
    next();
  } catch {
    return res.status(401).json({ error: "invalid token" });
  }
}