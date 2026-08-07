import * as express from 'express';
import { paymentCentralProcessorsRouter } from './payment-central/processors.router';
import { paymentCentralReconciliationRouter } from './payment-central/reconciliation.router';
import { paymentCentralDunningRouter } from './payment-central/dunning.router';
import { paymentCentralGlRouter } from './payment-central/gl.router';
import { paymentCentralInvoicesRouter } from './payment-central/invoices.router';

const router = express.Router();
// Processors and invoices both mount at '/'. Processors is declared first so
// its routes win; invoices only sees paths processors doesn't declare. Do not
// add the same path to both files — the collision will be silent.
router.use('/', paymentCentralProcessorsRouter);
router.use('/reconciliation', paymentCentralReconciliationRouter);
router.use('/dunning', paymentCentralDunningRouter);
router.use('/gl', paymentCentralGlRouter);
router.use('/', paymentCentralInvoicesRouter);

export { router as paymentCentralRouter };
