import { z } from 'zod';
import { phoneLast4, requiredText } from '../../schemas/common';
import { REFERENCE_PATTERN, normaliseReference } from '../../utils/referenceNumber';

const REFERENCE_MESSAGE = 'Please enter your reference number, for example REQ-7K3P9X.';

/** POST /track. "req 7k3p9x" and "REQ7K3P9X" are read as REQ-7K3P9X. */
export const trackSchema = z.object({
  referenceNumber: requiredText(REFERENCE_MESSAGE)
    .transform(normaliseReference)
    .pipe(z.string().regex(REFERENCE_PATTERN, REFERENCE_MESSAGE)),
  phoneLast4,
});

export type TrackInput = z.infer<typeof trackSchema>;
