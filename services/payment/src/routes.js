import { HEADERS, idempotent, parse, requireUser } from '@showtime/common';
import { Router } from 'express';
import { z } from 'zod';

export function paymentRoutes(payments, pool) {
  const r = Router();

  // Provider → us. Authenticated by HMAC signature, not by user session.
  r.post('/webhooks/:provider', async (req, res) => {
    res.json(await payments.handleWebhook(req.params.provider, req.rawBody, req.body, req.headers));
  });

  // Idempotency-Key is REQUIRED: a double-clicked "Pay" button must never create two charges.
  r.post('/intents', idempotent(pool, { required: true }), async (req, res) => {
    const user = requireUser(req);
    const { bookingId } = parse(z.object({ bookingId: z.string().uuid() }), req.body);
    res.status(201).json(await payments.createIntent(user, bookingId, req.header(HEADERS.requestId)));
  });

  r.get('/:id', async (req, res) => {
    res.json(await payments.get(requireUser(req), req.params.id));
  });

  r.post('/:id/mock/complete', async (req, res) => {
    const { outcome } = parse(z.object({ outcome: z.enum(['success', 'failure']) }), req.body);
    res.json(await payments.completeMock(requireUser(req), req.params.id, outcome));
  });

  r.post('/:id/razorpay/verify', async (req, res) => {
    const body = parse(
      z.object({ razorpay_order_id: z.string(), razorpay_payment_id: z.string(), razorpay_signature: z.string() }),
      req.body,
    );
    res.json(await payments.verifyRazorpayCheckout(requireUser(req), req.params.id, body));
  });

  return r;
}
