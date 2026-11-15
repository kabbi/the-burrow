import { Router } from "express";
import { z } from "zod";
import type { Deps } from "../app.ts";
import { SCOPE_INFO, SCOPES } from "../api/tokens.ts";

// Token management for the web app's API page (D-020). Like the rest of /api, this is the
// trusted UI side; the tokens themselves are for /api/v1.

export function tokenRoutes({ tokens }: Deps): Router {
  const r = Router();

  r.get("/tokens", (_req, res) => {
    res.json({ tokens: tokens.list(), scopes: SCOPES.map((id) => ({ id, description: SCOPE_INFO[id] })) });
  });

  /** The secret is in this answer only. */
  r.post("/tokens", (req, res) => {
    const b = z
      .object({ name: z.string().min(1).max(100), actor: z.string(), scopes: z.array(z.enum(SCOPES)).min(1) })
      .parse(req.body);
    res.status(201).json(tokens.create(b));
  });

  r.post("/tokens/:id/revoke", (req, res) => {
    res.json({ token: tokens.revoke(req.params.id) });
  });

  return r;
}
