import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

const submitKYCSchema = z.object({
  did: z.string().min(1),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dateOfBirth must be YYYY-MM-DD').optional(),
  documents: z.array(
    z.object({
      type: z.enum(['passport', 'national_id', 'drivers_license', 'selfie']),
      fileName: z.string().min(1),
      contentBase64: z.string().min(1).refine(
        s => /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length % 4 === 0,
        { message: 'contentBase64 must be valid base64' },
      ),
    }),
  ).min(1),
}).refine(
  (data) => {
    const types = data.documents.map((d) => d.type);
    return types.includes('passport') && types.includes('selfie');
  },
  { message: 'documents must include at least one passport and one selfie' },
);

const verifyKYCSchema = z.object({
  credDefId: z.string().min(1),
  attributes: z.record(z.string()).optional(),
});

export function validateSubmitKYC(req: Request, res: Response, next: NextFunction): void {
  const result = submitKYCSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: result.error.issues.map(i => i.message).join('; ') });
    return;
  }
  next();
}

const resubmitKYCSchema = z.object({
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dateOfBirth must be YYYY-MM-DD').optional(),
  documents: z.array(
    z.object({
      type: z.enum(['passport', 'national_id', 'drivers_license', 'selfie']),
      fileName: z.string().min(1),
      contentBase64: z.string().min(1).refine(
        s => /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length % 4 === 0,
        { message: 'contentBase64 must be valid base64' },
      ),
    }),
  ).min(1),
}).refine(
  (data) => {
    const types = data.documents.map((d) => d.type);
    return types.includes('passport') && types.includes('selfie');
  },
  { message: 'documents must include at least one passport and one selfie' },
);

export function validateResubmitKYC(req: Request, res: Response, next: NextFunction): void {
  const result = resubmitKYCSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: result.error.issues.map(i => i.message).join('; ') });
    return;
  }
  next();
}

export function validateVerifyKYC(req: Request, res: Response, next: NextFunction): void {
  const result = verifyKYCSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: result.error.issues.map(i => i.message).join('; ') });
    return;
  }
  next();
}
