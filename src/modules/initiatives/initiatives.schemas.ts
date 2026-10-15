import { z } from 'zod';
import {
  description,
  isoDate,
  pagination,
  requiredText,
  searchText,
  shortText,
} from '../../schemas/common';

/** What the event endpoints accept. Messages appear on the website's forms. */

const positiveId = (message: string) =>
  z.number({ error: message }).int(message).positive(message).max(2_147_483_647, message);

/** An optional ?typeId= filter: anything that isn't a valid ID is ignored. */
const optionalTypeId = z.coerce
  .number()
  .int()
  .positive()
  .max(2_147_483_647)
  .optional()
  .catch(undefined);

const timeOfDay = requiredText('Please enter a time.')
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Please enter the time as HH:MM, for example 09:30.');

// --- Lists --------------------------------------------------------------------

/** GET /initiatives?phase=upcoming|completed|all&typeId=&page=&pageSize= */
export const publicListQuery = pagination.extend({
  phase: z.enum(['upcoming', 'completed', 'all']).catch('all'),
  typeId: optionalTypeId,
});
export type PublicListQuery = z.infer<typeof publicListQuery>;

/** GET /admin/initiatives?status=Draft|Published|Closed|all&search=&typeId= */
export const adminListQuery = pagination.extend({
  status: z.enum(['Draft', 'Published', 'Closed', 'all']).catch('all'),
  search: searchText,
  typeId: optionalTypeId,
});
export type AdminListQuery = z.infer<typeof adminListQuery>;

// --- Initiatives ----------------------------------------------------------------

const fields = {
  typeId: positiveId('Please choose the type of event.'),
  title: shortText('Please enter a title.', 3, 200),
  summary: shortText('Please add a short summary (at least 10 characters).', 10, 200).nullable(),
  description: description(20, 5000),
  location: shortText('Please enter where the event takes place.', 3, 200).nullable(),
  startDate: isoDate,
  endDate: isoDate,
  startTime: timeOfDay.nullable(),
  endTime: timeOfDay.nullable(),
  donationNeeds: shortText('Please say what donations are needed.', 2, 255).nullable(),
  volunteersRequired: z.boolean({ error: 'Please say whether volunteers are needed.' }),
};

type DateFields = {
  startDate?: string;
  endDate?: string;
  startTime?: string | null;
  endTime?: string | null;
};

/** End date on or after the start date; on a one-day event, the end time after the start time. */
export function dateProblems(event: DateFields): Array<{ field: string; message: string }> {
  const problems: Array<{ field: string; message: string }> = [];
  const { startDate, endDate, startTime, endTime } = event;
  if (startDate && endDate && endDate < startDate) {
    problems.push({ field: 'endDate', message: "The end date can't be before the start date." });
  }
  if (startDate && startDate === endDate && startTime && endTime && endTime <= startTime) {
    problems.push({ field: 'endTime', message: 'The end time must be after the start time.' });
  }
  return problems;
}

/** A new event starts as a draft. Summary, location and the rest can be added before publishing. */
export const createInitiativeSchema = z
  .object({
    ...fields,
    summary: fields.summary.optional(),
    location: fields.location.optional(),
    startTime: fields.startTime.optional(),
    endTime: fields.endTime.optional(),
    donationNeeds: fields.donationNeeds.optional(),
    volunteersRequired: fields.volunteersRequired.default(false),
  })
  .superRefine((event, ctx) => {
    for (const problem of dateProblems(event)) {
      ctx.addIssue({ code: 'custom', path: [problem.field], message: problem.message });
    }
  });
export type CreateInitiativeInput = z.infer<typeof createInitiativeSchema>;

/** Any field can change; send null to clear an optional one. Dates are checked with the saved values. */
export const updateInitiativeSchema = z
  .object({
    typeId: fields.typeId.optional(),
    title: fields.title.optional(),
    summary: fields.summary.optional(),
    description: fields.description.optional(),
    location: fields.location.optional(),
    startDate: fields.startDate.optional(),
    endDate: fields.endDate.optional(),
    startTime: fields.startTime.optional(),
    endTime: fields.endTime.optional(),
    donationNeeds: fields.donationNeeds.optional(),
    volunteersRequired: fields.volunteersRequired.optional(),
  })
  .refine(
    (changes) => Object.values(changes).some((value) => value !== undefined),
    'Please change at least one detail.',
  );
export type UpdateInitiativeInput = z.infer<typeof updateInitiativeSchema>;

export const statusChangeSchema = z.object({
  status: z.enum(['Draft', 'Published', 'Closed'], {
    error: 'Please choose Draft, Published or Closed.',
  }),
});
export type StatusChangeInput = z.infer<typeof statusChangeSchema>;

// --- Volunteer tasks ----------------------------------------------------------------

const volunteersNeeded = z
  .number({ error: 'Please enter how many volunteers are needed, as a whole number.' })
  .int('Please enter how many volunteers are needed, as a whole number.')
  .min(1, 'At least 1 volunteer, please.')
  .max(10_000, 'Please enter a number up to 10 000.')
  .nullable();

const taskName = shortText('Please enter the task name.', 2, 100);

export const createTaskSchema = z.object({
  name: taskName,
  volunteersNeeded: volunteersNeeded.optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z
  .object({ name: taskName.optional(), volunteersNeeded: volunteersNeeded.optional() })
  .refine(
    (changes) => changes.name !== undefined || changes.volunteersNeeded !== undefined,
    'Please change at least one detail.',
  );
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

/** /admin/initiatives/:id/tasks/:taskId */
const routeId = (message: string) =>
  z.coerce.number({ error: message }).int(message).positive(message).max(2_147_483_647, message);

export const taskParams = z.object({
  id: routeId("We couldn't find that event."),
  taskId: routeId("We couldn't find that task."),
});

// --- Event types --------------------------------------------------------------------

const typeName = shortText('Please enter the name of the event type.', 2, 100);
const typeDescription = shortText('Please add a short description.', 2, 255).nullable();

export const createTypeSchema = z.object({
  name: typeName,
  description: typeDescription.optional(),
});
export type CreateTypeInput = z.infer<typeof createTypeSchema>;

export const updateTypeSchema = z
  .object({ name: typeName.optional(), description: typeDescription.optional() })
  .refine(
    (changes) => changes.name !== undefined || changes.description !== undefined,
    'Please change at least one detail.',
  );
export type UpdateTypeInput = z.infer<typeof updateTypeSchema>;
